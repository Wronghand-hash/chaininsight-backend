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
        logger.info('No items found in token_metrics to poll');
        return;
      }

      logger.info(`Polling Dexscreener for ${items.length} contracts from token_metrics`);

      const uniqueContracts = Array.from(new Set(items.map(i => i.contract)));
      const batches = this.chunk(uniqueContracts, 30);

      for (const batch of batches) {
        const batchUrl = `${config.baseUrls.dexscreener}${batch.join(',')}`;
        try {
          logger.info(`[Dexscreener][batch:url] (${batch.length}) -> ${batchUrl}`);
          const resp = await fetch(batchUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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

          let changesDetected = 0;
          let totalAbsoluteChange = 0;
          for (const item of items) {
            if (batch.includes(item.contract)) {
              const key = `${item.contract}:${item.chain}`;
              const relevantPairs = pairsByContractChain.get(key) || [];
              if (relevantPairs.length === 0) {
                logger.warn(`[Dexscreener] No pairs found for ${item.contract} on ${item.chain}`);
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
                logger.warn(`[Dexscreener] Invalid marketCap for ${item.contract} on ${item.chain}`);
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
                  let mcMsg = `MC ${ratio >= 2 ? '2x+' : 'halved-'} ${newMarketCap.toLocaleString()} (from ${oldMarketCap.toLocaleString()}, ${perc.toFixed(1)}%)`;
                  if (ratio >= 3) mcMsg += ' (3x+)';
                  changes.push(mcMsg);
                  hasSignificantChange = true;
                  totalAbsoluteChange += Math.abs(newMarketCap - oldMarketCap);
                }
              }

              // FDV large change (2x+, 3x+, or halved)
              if (oldFdv > 0 && newFdv && newFdv > 0) {
                const ratio = newFdv / oldFdv;
                if (ratio >= 2 || ratio <= 0.5) {
                  const perc = (ratio - 1) * 100;
                  let fdvMsg = `FDV ${ratio >= 2 ? '2x+' : 'halved-'} ${newFdv.toLocaleString()} (from ${oldFdv.toLocaleString()}, ${perc.toFixed(1)}%)`;
                  if (ratio >= 3) fdvMsg += ' (3x+)';
                  changes.push(fdvMsg);
                  hasSignificantChange = true;
                }
              }

              // Volume 5m large change (2x+ or halved, or new activity)
              if (oldVolume5m > 0 && newVolume5m && newVolume5m > 0) {
                const ratio = newVolume5m / oldVolume5m;
                if (ratio >= 2 || ratio <= 0.5) {
                  const perc = (ratio - 1) * 100;
                  let v5Msg = `Vol5m ${ratio >= 2 ? '2x+' : 'halved-'} ${newVolume5m.toLocaleString()} (from ${oldVolume5m.toLocaleString()}, ${perc.toFixed(1)}%)`;
                  changes.push(v5Msg);
                  hasSignificantChange = true;
                }
              } else if (oldVolume5m === 0 && newVolume5m && newVolume5m > 1000) {
                changes.push(`Vol5m: New activity ${newVolume5m.toLocaleString()}`);
                hasSignificantChange = true;
              }

              // Volume 24h large change (2x+ or halved, or new activity)
              if (oldVolume24h > 0 && newVolume24h && newVolume24h > 0) {
                const ratio = newVolume24h / oldVolume24h;
                if (ratio >= 2 || ratio <= 0.5) {
                  const perc = (ratio - 1) * 100;
                  let v24Msg = `Vol24h ${ratio >= 2 ? '2x+' : 'halved-'} ${newVolume24h.toLocaleString()} (from ${oldVolume24h.toLocaleString()}, ${perc.toFixed(1)}%)`;
                  changes.push(v24Msg);
                  hasSignificantChange = true;
                }
              } else if (oldVolume24h === 0 && newVolume24h && newVolume24h > 10000) {
                changes.push(`Vol24h: New activity ${newVolume24h.toLocaleString()}`);
                hasSignificantChange = true;
              }

              // CTO info change
              if (JSON.stringify(oldCtoInfo) !== JSON.stringify(filteredCtoInfo)) {
                changes.push('CTO Info Updated');
                hasSignificantChange = true;
                ctoChanged = true;
              }

              if (hasSignificantChange) {
                const changeDirection = changes.some(c => c.includes('2x+') || c.includes('New activity')) ? '🚀 UP/BREAKOUT' : '⚠️ DOWN/UPDATE';
                logger.info(`${changeDirection} [Dexscreener][SIGNIFICANT_CHANGE] 
  ├─ Contract: ${item.contract} (${item.chain})
  ${changes.map(c => `  ├─ ${c}`).join('\n')}
  ├─ Price USD: ${newPriceUsd?.toFixed(4) || 'N/A'}
  └─ Timestamp: ${new Date().toISOString()}`);

                if (ctoChanged) {
                  logger.info(`[Dexscreener][CTO_UPDATE] for ${item.contract} (${item.chain})
  ├─ Image URL: ${filteredCtoInfo.imageUrl || 'N/A'}
  ├─ Websites: ${JSON.stringify(filteredCtoInfo.websites) || '[]'}
  └─ Socials: ${JSON.stringify(filteredCtoInfo.socials) || '[]'}`);
                }

                // Post to Twitter
                const tweetChanges = changes.slice(0, 3).join(' | '); // Limit to 3 changes for brevity
                const tweetText = `🚨 Token Alert: ${changeDirection} for ${item.contract} on ${item.chain}! ${tweetChanges} Price: $${newPriceUsd?.toFixed(6) || 'N/A'} #Crypto #DeFi #Tokens`;
                await twitterService.postTweet(tweetText);

                changesDetected++;
              } else {
                logger.debug(`[Dexscreener] No significant change for ${item.contract} on ${item.chain} (MC: ${newMarketCap.toLocaleString()})`);
              }

              // Create filtered pair for storage
              const filteredPair = { ...selectedPair, info: filteredCtoInfo };

              // Always update the DB with latest metrics (includes filtered dexscreener_info)
              await questdbService.saveTokenMetrics(item.contract, item.chain as any, {} as TokenInfoResponse, { pairs: [filteredPair] });
            }
          }

          if (changesDetected > 0) {
            logger.info(`[Dexscreener][batch:summary] size=${batch.length}, changes_detected=${changesDetected}, total_abs_change=${totalAbsoluteChange.toLocaleString()} USD`);
          } else {
            logger.debug(`[Dexscreener][batch:summary] size=${batch.length}, no_changes`);
          }
        } catch (err) {
          logger.warn(`[Dexscreener][batch:failed] size=${batch.length}`, err as any);
        }
      }
    } catch (e) {
      logger.warn('TokenMetricsDexscreenerPoller fetchTokenDexInfo failed', e as any);
    }
  }
}

export const tokenMetricsDexscreenerPoller = new TokenMetricsDexscreenerPoller();