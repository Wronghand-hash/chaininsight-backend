import { questdbService } from './questDbService';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { CronJob } from 'cron';
import { TokenInfoResponse } from '../models/token.types';

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
      '*/1 * * * *', // Every 5 minutes
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

    logger.info('TokenMetricsDexscreenerPoller started as cron job (every 5 minutes)');
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
                `SELECT market_cap, price_usd, fdv, volume_5m, volume_24h FROM token_metrics WHERE contract = '${item.contract}' AND chain = '${item.chain}';`
              );
              const currentRow = currentRes.rows[0];
              const oldMarketCap = currentRow ? Number(currentRow[0]) : null;

              // Detect change (with tolerance for floating point)
              const tolerance = 0.01; // 1 cent USD
              const hasChange = oldMarketCap == null || Math.abs(newMarketCap - oldMarketCap) > tolerance;

              if (hasChange) {
                const absoluteChange = newMarketCap - (oldMarketCap || 0);
                const percentageChange = oldMarketCap ? ((newMarketCap - oldMarketCap) / oldMarketCap * 100) : null;
                const changeDirection = absoluteChange > 0 ? 'UP' : (absoluteChange < 0 ? 'DOWN' : 'STABLE');
                const changeEmoji = absoluteChange > 0 ? '📈' : (absoluteChange < 0 ? '📉' : '➡️');
                const absChangeFormatted = Math.abs(absoluteChange).toLocaleString();
                const percChangeFormatted = percentageChange ? percentageChange.toFixed(2) + '%' : 'N/A';

                logger.info(`${changeEmoji} [Dexscreener][MARKET_CAP_CHANGE] ${changeDirection} 
  ├─ Contract: ${item.contract} (${item.chain})
  ├─ Old MC: ${oldMarketCap?.toLocaleString() || 'N/A'} USD
  ├─ New MC: ${newMarketCap.toLocaleString()} USD
  ├─ Absolute Change: ${changeDirection === 'UP' ? '+' : '-'}${absChangeFormatted} USD
  ├─ Percentage Change: ${percChangeFormatted} 
  ├─ Price USD: ${newPriceUsd?.toFixed(4) || 'N/A'}
  ├─ FDV: ${newFdv?.toLocaleString() || 'N/A'} USD
  ├─ Vol 5m: ${newVolume5m?.toLocaleString() || 'N/A'} USD
  ├─ Vol 24h: ${newVolume24h?.toLocaleString() || 'N/A'} USD
  └─ Timestamp: ${new Date().toISOString()}`);

                // Log CTO info details
                if (ctoInfo && Object.keys(ctoInfo).length > 0) {
                  logger.info(`[Dexscreener][CTO_INFO] for ${item.contract} (${item.chain})
  ├─ Image URL: ${imageUrl || 'N/A'}
  ├─ Websites: ${websites || '[]'}
  └─ Socials: ${socials || '[]'}`);
                }

                changesDetected++;
                totalAbsoluteChange += Math.abs(absoluteChange);
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