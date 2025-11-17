import { questdbService } from './questDbService';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { CronJob } from 'cron';
import { TokenInfoResponse } from '../models/token.types';
import { TwitterApi } from 'twitter-api-v2';

class TokenMetricsDexscreenerPoller {
  private cronJob: CronJob<() => Promise<void>, () => void> | null = null;
  private running = false;

  private chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  async start() {
    if (this.running) return;
    await questdbService.init();
    this.running = true;

    this.cronJob = new CronJob(
      '*/1 * * * *',
      async () => {
        await this.fetchTokenDexInfo();
      },
      () => {
        this.running = false;
        logger.info('TokenMetricsDexscreenerPoller cron job completed (stopped)');
      },
      true, // Start immediately
      'UTC' // timeZone
    );

    logger.info('TokenMetricsDexscreenerPoller started as cron job (every 1 minute)');
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    this.running = false;
    logger.info('TokenMetricsDexscreenerPoller stopped');
  }

  private async getTwitterClient() {
    try {
      logger.debug('getTwitterClient: Attempting to fetch valid Twitter access token from database');
      
      // Get the most recent valid access token from the database
      const query = `
        SELECT 
          access_token, 
          refresh_token, 
          expires_at,
          username,
          id
        FROM twitter_auth 
        WHERE access_token IS NOT NULL 
          AND expires_at > now() 
        ORDER BY updated_at DESC 
        LIMIT 1`;
      
      logger.debug('getTwitterClient: Executing query:', { query });
      const result = await questdbService.query(query);
      logger.debug('getTwitterClient: Query result:', { 
        rowsReturned: result.rows.length,
        columns: result.columns,
        firstRow: result.rows[0] ? '***REDACTED***' : 'No rows returned'
      });

      if (result.rows.length === 0) {
        logger.error('No valid Twitter access token found in database - no rows returned');
        return null;
      }

      const accessToken = result.rows[0][0]; // access_token is the first column in the SELECT
      const username = result.rows[0][3] || 'unknown';
      const userId = result.rows[0][4] || 'unknown';
      const expiresAt = result.rows[0][2];
      
      logger.debug('getTwitterClient: Found access token', { 
        username,
        userId,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : 'unknown',
        tokenPrefix: accessToken ? `${accessToken.substring(0, 10)}...` : 'empty'
      });

      if (!accessToken) {
        logger.error('Found row but access token is empty or undefined');
        return null;
      }

      // Create a new Twitter client with the access token
      logger.debug('getTwitterClient: Creating Twitter client with access token');
      const client = new TwitterApi(accessToken);
      
      // Verify the token is valid by making a simple API call
      try {
        logger.debug('getTwitterClient: Verifying token with Twitter API');
        const user = await client.v2.me();
        logger.debug('getTwitterClient: Successfully verified token for user:', { 
          username: user.data.username,
          id: user.data.id
        });
      } catch (error: any) {
        const verifyError = error as {
          message: string;
          code?: string | number;
          status?: number;
        };
        logger.error('getTwitterClient: Failed to verify token with Twitter API:', {
          error: verifyError.message,
          code: verifyError.code,
          status: verifyError.status
        });
        return null;
      }
      
      return client;
    } catch (error: any) {
      const err = error as {
        message: string;
        stack?: string;
        code?: string | number;
        status?: number;
      };
      logger.error('Error in getTwitterClient:', {
        error: err.message,
        stack: err.stack,
        code: err.code,
        status: err.status
      });
      return null;
    }
  }

  private async postToTwitter(message: string): Promise<boolean> {
    try {
      const client = await this.getTwitterClient();
      if (!client) {
        logger.error('Could not create Twitter client - no valid access token found');
        return false;
      }

      const truncatedMessage = message.length > 280 ? message.substring(0, 277) + '...' : message;
      const tweet = await client.v2.tweet(truncatedMessage);
      
      if (tweet) {
        logger.info(`Posted to Twitter: ${truncatedMessage}`);
        return true;
      } else {
        logger.error('Failed to post to Twitter: No response from API');
        return false;
      }
    } catch (error) {
      logger.error('Error posting to Twitter:', error);
      return false;
    }
  }

  private async fetchTokenDexInfo() {
    if (!this.running) return;
    try {
      const res = await questdbService.query(
        "SELECT contract, chain, max(updated_at) AS updated_at FROM token_metrics GROUP BY contract, chain ORDER BY updated_at DESC LIMIT 200;"
      );
      const contractIdx = res.columns.indexOf('contract');
      const chainIdx = res.columns.indexOf('chain');
      const items = res.rows.map(r => ({
        contract: String(r[contractIdx] || '').toLowerCase(),
        chain: String(r[chainIdx] || '').toUpperCase()
      })).filter(x => x.contract);

      if (items.length === 0) {
        logger.info('No items found in token_metrics to poll - skipping this cycle');
        return;
      }

      logger.info(`Starting Dexscreener poll cycle: Fetching data for ${items.length} unique tokens across chains`);

      const uniqueContracts = Array.from(new Set(items.map(i => i.contract)));
      const batches = this.chunk(uniqueContracts, 30);

      let totalChangesDetected = 0;
      let totalAbsoluteChange = 0;

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const batchUrl = `${config.baseUrls.dexscreener}${batch.join(',')}`;
        try {
          logger.info(`[Dexscreener][batch:${batchIndex + 1}/${batches.length}] Fetching ${batch.length} contracts -> ${batchUrl}`);
          const resp = await fetch(batchUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}: Failed to fetch batch from Dexscreener`);
          const json = await resp.json();

          // Process the response: group pairs by (contract, chain) and detect changes
          const pairsByContractChain: Map<string, any[]> = new Map();
          for (const pair of (json as any).pairs || []) {
            const baseContract = (pair.baseToken?.address || '').toLowerCase();
            const pairChain = (pair.chainId || '').toUpperCase();
            const key = `${baseContract}:${pairChain}`;
            if (!pairsByContractChain.has(key)) {
              pairsByContractChain.set(key, []);
            }
            pairsByContractChain.get(key)!.push(pair);
          }

          let batchChangesDetected = 0;
          let batchAbsoluteChange = 0;

          for (const item of items) {
            if (batch.includes(item.contract)) {
              const key = `${item.contract}:${item.chain}`;
              const relevantPairs = pairsByContractChain.get(key) || [];
              if (relevantPairs.length === 0) {
                logger.warn(`[Dexscreener] No trading pairs found for contract ${item.contract} on chain ${item.chain} - skipping update`);
                continue;
              }

              // Select the pair with the highest liquidity (common practice for primary pair)
              const selectedPair = relevantPairs.reduce((prev, curr) =>
                (curr.liquidity?.usd || 0) > (prev.liquidity?.usd || 0) ? curr : prev
              );

              const newMarketCap = selectedPair.marketCap != null ? Number(selectedPair.marketCap) : null;
              const newPriceUsd = selectedPair.priceUsd != null ? Number(selectedPair.priceUsd) : null;
              const newFdv = selectedPair.fdv != null ? Number(selectedPair.fdv) : null;
              const newVolume5m = selectedPair.volume?.m5 != null ? Number(selectedPair.volume.m5) : null;
              const newVolume24h = selectedPair.volume?.h24 != null ? Number(selectedPair.volume.h24) : null;

              // Extract CTO info from selectedPair
              const ctoInfo = selectedPair.info || {};
              const imageUrl = ctoInfo.imageUrl || null;
              const websites = ctoInfo.websites ? JSON.stringify(ctoInfo.websites) : null;
              const socials = ctoInfo.socials ? JSON.stringify(ctoInfo.socials) : null;

              // Create filtered CTO info without header and openGraph
              const filteredCtoInfo = {
                imageUrl: ctoInfo.imageUrl || null,
                websites: ctoInfo.websites || [],
                socials: ctoInfo.socials || []
              };

              if (newMarketCap == null) {
                logger.warn(`[Dexscreener] Invalid or missing marketCap for ${item.contract} on ${item.chain} - skipping update`);
                continue;
              }

              // Query current values from DB
              const currentRes = await questdbService.query(
                `SELECT market_cap, price_usd, fdv, volume_5m, volume_24h, CTO FROM token_metrics WHERE contract = '${item.contract}' AND chain = '${item.chain}';`
              );
              const currentRow = currentRes.rows[0];
              const oldMarketCap = currentRow ? Number(currentRow[0]) || 0 : 0;
              const oldFdv = currentRow ? Number(currentRow[2]) || 0 : 0;
              const oldVolume5m = currentRow ? Number(currentRow[3]) || 0 : 0;
              const oldVolume24h = currentRow ? Number(currentRow[4]) || 0 : 0;
              const oldCtoInfoStr = currentRow ? currentRow[5] : '{}';
              const oldCtoInfo = oldCtoInfoStr ? JSON.parse(oldCtoInfoStr) : {};

              // Detect significant changes
              let hasSignificantChange = false;
              const changes: string[] = [];
              let ctoChanged = false;
              let ctoDetails: string[] = [];

              // Market Cap large change (2x+, 3x+, or halved)
              if (oldMarketCap > 0 && newMarketCap > 0) {
                const ratio = newMarketCap / oldMarketCap;
                if (ratio >= 2 || ratio <= 0.5) {
                  const perc = (ratio - 1) * 100;
                  const absChange = newMarketCap - oldMarketCap;
                  let mcMsg = `Market Cap ${ratio >= 2 ? 'surged' : 'dropped'} to $${newMarketCap.toLocaleString()} (from $${oldMarketCap.toLocaleString()}, ${absChange >= 0 ? '+' : ''}${absChange.toLocaleString()} USD, ${perc.toFixed(1)}% change)`;
                  if (ratio >= 3) mcMsg += ' - Massive 3x+ pump!';
                  changes.push(mcMsg);
                  hasSignificantChange = true;
                  batchAbsoluteChange += Math.abs(absChange);
                }
              }

              // FDV large change (2x+, 3x+, or halved)
              if (oldFdv > 0 && newFdv && newFdv > 0) {
                const ratio = newFdv / oldFdv;
                if (ratio >= 2 || ratio <= 0.5) {
                  const perc = (ratio - 1) * 100;
                  const absChange = newFdv - oldFdv;
                  let fdvMsg = `FDV ${ratio >= 2 ? 'surged' : 'dropped'} to $${newFdv.toLocaleString()} (from $${oldFdv.toLocaleString()}, ${absChange >= 0 ? '+' : ''}${absChange.toLocaleString()} USD, ${perc.toFixed(1)}% change)`;
                  if (ratio >= 3) fdvMsg += ' - Massive 3x+ pump!';
                  changes.push(fdvMsg);
                  hasSignificantChange = true;
                }
              }

              // Volume 5m large change (2x+ or halved, or new activity)
              if (oldVolume5m > 0 && newVolume5m && newVolume5m > 0) {
                const ratio = newVolume5m / oldVolume5m;
                if (ratio >= 2 || ratio <= 0.5) {
                  const perc = (ratio - 1) * 100;
                  const absChange = newVolume5m - oldVolume5m;
                  let v5Msg = `5m Volume ${ratio >= 2 ? 'spiked' : 'dropped'} to $${newVolume5m.toLocaleString()} (from $${oldVolume5m.toLocaleString()}, ${absChange >= 0 ? '+' : ''}${absChange.toLocaleString()} USD, ${perc.toFixed(1)}% change)`;
                  changes.push(v5Msg);
                  hasSignificantChange = true;
                }
              } else if (oldVolume5m === 0 && newVolume5m && newVolume5m > 1000) {
                changes.push(`5m Volume: New high activity detected at $${newVolume5m.toLocaleString()} USD - Potential breakout!`);
                hasSignificantChange = true;
              }

              // Volume 24h large change (2x+ or halved, or new activity)
              if (oldVolume24h > 0 && newVolume24h && newVolume24h > 0) {
                const ratio = newVolume24h / oldVolume24h;
                if (ratio >= 2 || ratio <= 0.5) {
                  const perc = (ratio - 1) * 100;
                  const absChange = newVolume24h - oldVolume24h;
                  let v24Msg = `24h Volume ${ratio >= 2 ? 'spiked' : 'dropped'} to $${newVolume24h.toLocaleString()} (from $${oldVolume24h.toLocaleString()}, ${absChange >= 0 ? '+' : ''}${absChange.toLocaleString()} USD, ${perc.toFixed(1)}% change)`;
                  changes.push(v24Msg);
                  hasSignificantChange = true;
                }
              } else if (oldVolume24h === 0 && newVolume24h && newVolume24h > 10000) {
                changes.push(`24h Volume: New high activity detected at $${newVolume24h.toLocaleString()} USD - Gaining traction!`);
                hasSignificantChange = true;
              }

              // CTO info change - Detailed diff
              if (JSON.stringify(oldCtoInfo) !== JSON.stringify(filteredCtoInfo)) {
                ctoChanged = true;
                hasSignificantChange = true;

                // Image change
                if (oldCtoInfo.imageUrl !== filteredCtoInfo.imageUrl) {
                  ctoDetails.push(`New logo: ${filteredCtoInfo.imageUrl || 'added'}`);
                }

                // Websites diff
                const oldWebsites = oldCtoInfo.websites || [];
                const newWebsites = filteredCtoInfo.websites || [];
                if (newWebsites.length > oldWebsites.length || JSON.stringify(newWebsites) !== JSON.stringify(oldWebsites)) {
                  const addedWebsites = newWebsites.filter((w: any) => !oldWebsites.some((ow: any) => ow.url === w.url));
                  if (addedWebsites.length > 0) {
                    const siteLinks = addedWebsites.map((w: any) => `${w.label || 'Site'}: ${w.url}`).join(', ');
                    ctoDetails.push(`New sites: ${siteLinks}`);
                  }
                }

                // Socials diff
                const oldSocials = oldCtoInfo.socials || [];
                const newSocials = filteredCtoInfo.socials || [];
                if (newSocials.length > oldSocials.length || JSON.stringify(newSocials) !== JSON.stringify(oldSocials)) {
                  const addedSocials = newSocials.filter((s: any) => !oldSocials.some((os: any) => os.url === s.url));
                  if (addedSocials.length > 0) {
                    const socialLinks = addedSocials.map((s: any) => `${s.type}: ${s.url}`).join(', ');
                    ctoDetails.push(`New socials: ${socialLinks}`);
                  }
                }

                if (ctoDetails.length > 0) {
                  changes.push(`CTO Updated: ${ctoDetails.join(' | ')}`);
                } else {
                  changes.push('CTO Info Updated: Metadata refreshed');
                }
              }

              if (hasSignificantChange) {
                const isPositiveChange = changes.some(c => c.includes('surged') || c.includes('spiked') || c.includes('New high activity') || c.includes('3x+'));
                const changeDirection = isPositiveChange ? '🚀 UP/BREAKOUT' : '⚠️ DOWN/UPDATE';
                const totalPercChanges = changes.filter(c => c.includes('%')).map(c => parseFloat(c.match(/(-?\d+\.?\d*)%/)?.[1] || '0'));
                const avgPercChange = totalPercChanges.length > 0 ? totalPercChanges.reduce((a, b) => a + b, 0) / totalPercChanges.length : 0;

                logger.info(`${changeDirection} [Dexscreener][SIGNIFICANT_CHANGE] Detected ${changes.length} major updates for ${item.contract} on ${item.chain}:
  📊 Summary: Average change ${avgPercChange.toFixed(1)}% across metrics
  ├─ Current Price: $${newPriceUsd?.toFixed(4) || 'N/A'}
  ${changes.map((c, idx) => `  ├─ Change ${idx + 1}: ${c}`).join('\n')}
  └─ Timestamp: ${new Date().toISOString()}`);

                if (ctoChanged) {
                  logger.info(`[Dexscreener][CTO_UPDATE] Detailed CTO changes for ${item.contract} (${item.chain}):
  ├─ New Image URL: ${filteredCtoInfo.imageUrl || 'No change'}
  ├─ Websites (${filteredCtoInfo.websites?.length || 0}): ${JSON.stringify(filteredCtoInfo.websites) || 'None'}
  └─ Socials (${filteredCtoInfo.socials?.length || 0}): ${JSON.stringify(filteredCtoInfo.socials) || 'None'}`);
                }

                // Post to Twitter - Enhanced with full address, link, and specific changes including old/new values
                const dexLink = `https://dexscreener.com/${item.chain.toLowerCase()}/${item.contract}`;
                const tweetBody = changes.slice(0, 2).map(c => {
                  // Extract key parts for brevity with old → new: e.g., "5m Vol $4.5k → $355 (-92.1%)"
                  if (c.includes('Volume') && c.includes('spiked')) {
                    const match = c.match(/to \$([\d,]+\.?\d*) \(from \$([\d,]+\.?\d*), \+?([\d+\.?\d]*)% change\)/);
                    if (match) return `5m Vol $${match[2]} → $${match[1]} (+${match[3]}%)`;
                  } else if (c.includes('Volume') && c.includes('dropped')) {
                    const match = c.match(/to \$([\d,]+\.?\d*) \(from \$([\d,]+\.?\d*), -([\d+\.?\d]*)% change\)/);
                    if (match) return `5m Vol $${match[2]} → $${match[1]} (-${match[3]}%)`;
                  } else if (c.includes('CTO Updated')) {
                    return ctoDetails.slice(0, 1).join(' | ').substring(0, 50) + '...';
                  } else if (c.includes('Market Cap') || c.includes('FDV')) {
                    const match = c.match(/to \$([\d,]+\.?\d*) \(from \$([\d,]+\.?\d*), ([-+]\d+\.?\d*)% change\)/);
                    if (match) return `${c.includes('Cap') ? 'MC' : 'FDV'} $${match[2]} → $${match[1]} ${match[3]}%`;
                  }
                  return c.split(' to ')[0].substring(0, 40) + '...';
                }).join(' | ');
                const tweetText = `🚨 ${changeDirection} Alert on ${item.chain}! 

${tweetBody}

Price: $${newPriceUsd?.toFixed(6)} | MC: $${newMarketCap.toLocaleString()}
${item.contract} 👉 ${dexLink}

#Crypto #DeFi #Tokens`;
                logger.info(`[Twitter] Preparing alert tweet: "${tweetText}"`);
                const tweetSuccess = await this.postToTwitter(tweetText);
                if (tweetSuccess) {
                  logger.info(`[Twitter] ✅ Alert tweet posted successfully for ${item.contract}`);
                } else {
                  logger.warn(`[Twitter] ❌ Failed to post alert tweet for ${item.contract} - Check credentials/limits`);
                }

                batchChangesDetected++;
              } else {
                logger.debug(`[Dexscreener] No significant changes detected for ${item.contract} on ${item.chain} - Metrics stable (MC: $${newMarketCap.toLocaleString()})`);
              }

              // Create filtered pair for storage
              const filteredPair = { ...selectedPair, info: filteredCtoInfo };

              // Always update the DB with latest metrics (includes filtered dexscreener_info)
              await questdbService.saveTokenMetrics(item.contract, item.chain as any, {} as TokenInfoResponse, { pairs: [filteredPair] });
              logger.debug(`[DB] Updated metrics for ${item.contract} (${item.chain}): MC=$${newMarketCap.toLocaleString()}, Vol5m=$${newVolume5m?.toLocaleString() || '0'} USD`);
            }
          }

          totalChangesDetected += batchChangesDetected;
          totalAbsoluteChange += batchAbsoluteChange;

          if (batchChangesDetected > 0) {
            logger.info(`[Dexscreener][batch:${batchIndex + 1} summary] Processed ${batch.length} contracts: ${batchChangesDetected} significant changes detected, total absolute change $${batchAbsoluteChange.toLocaleString()} USD`);
          } else {
            logger.debug(`[Dexscreener][batch:${batchIndex + 1} summary] Processed ${batch.length} contracts: No significant changes`);
          }
        } catch (err: any) {
          logger.error(`[Dexscreener][batch:${batchIndex + 1} failed] Error processing ${batch.length} contracts: ${err.message}`, { error: err });
        }
      }

      // Overall cycle summary
      if (totalChangesDetected > 0) {
        logger.info(`[Dexscreener][cycle:complete] Poll cycle finished: ${totalChangesDetected} total significant changes across ${batches.length} batches, total absolute market change $${totalAbsoluteChange.toLocaleString()} USD - Alerts sent!`);
      } else {
        logger.info(`[Dexscreener][cycle:complete] Poll cycle finished: No significant changes detected across ${uniqueContracts.length} contracts - Market steady`);
      }
    } catch (e) {
      logger.error('TokenMetricsDexscreenerPoller fetchTokenDexInfo failed - Full cycle error', { error: e });
    }
  }
}

export const tokenMetricsDexscreenerPoller = new TokenMetricsDexscreenerPoller();