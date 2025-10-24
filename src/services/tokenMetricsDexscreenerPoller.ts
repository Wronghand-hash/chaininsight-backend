import { questdbService } from './questDbService';
import { logger } from '../utils/logger';
import { config } from '../utils/config';

class TokenMetricsDexscreenerPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private intervalMs = 60_000;

  private chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  async start(intervalMs?: number) {
    if (this.running) return;
    if (intervalMs && intervalMs > 0) this.intervalMs = intervalMs;
    await questdbService.init();
    this.running = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    logger.info(`TokenMetricsDexscreenerPoller started, interval=${this.intervalMs}ms`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('TokenMetricsDexscreenerPoller stopped');
  }

  private async tick() {
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
      const batches = this.chunk(uniqueContracts, 20); // Dexscreener supports comma-separated addresses; keep batches modest

      for (const batch of batches) {
        const batchUrl = `${config.baseUrls.dexscreener}${batch.join(',')}`;
        try {
          logger.info(`[Dexscreener][batch:url] (${batch.length}) -> ${batchUrl}`);
          const resp = await fetch(batchUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const json = await resp.json();
          logger.info(`[Dexscreener][batch:log-only] size=${batch.length} payload=${JSON.stringify(json)}`);
        } catch (err) {
          logger.warn(`[Dexscreener][batch:failed] size=${batch.length}`, err as any);
        }
      }
    } catch (e) {
      logger.warn('TokenMetricsDexscreenerPoller tick failed', e as any);
    }
  }
}

export const tokenMetricsDexscreenerPoller = new TokenMetricsDexscreenerPoller();
