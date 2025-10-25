import { questdbService } from './questDbService';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { CronJob } from 'cron';
import { TokenInfoResponse } from '../models/token.types';
import { twitterService } from './twitterService';

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
    await twitterService.init();
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

              // CTO info change
              if (JSON.stringify(oldCtoInfo) !== JSON.stringify(filteredCtoInfo)) {
                changes.push('CTO Info Updated: New websites/socials or image detected');
                hasSignificantChange = true;
                ctoChanged = true;
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

                // Post to Twitter
                const tweetChanges = changes.slice(0, 3).map(c => c.split(' (')[0]).join(' | '); // Shorten for tweet
                const tweetText = `🚨 Token Alert: ${changeDirection} on ${item.chain}! ${item.contract.slice(0, 10)}... ${tweetChanges} | Price: $${newPriceUsd?.toFixed(6) || 'N/A'} | Avg Change: ${avgPercChange.toFixed(1)}% #Crypto #DeFi #Tokens`;
                logger.info(`[Twitter] Preparing alert tweet: "${tweetText}"`);
                const tweetSuccess = await twitterService.postTweet(tweetText);
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