import { questdbService } from './questDbService';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { CronJob } from 'cron';
import { TokenInfoResponse } from '../models/token.types';
import { TwitterApi } from 'twitter-api-v2';

class TokenMetricsDexscreenerPoller {
  private fiveMinJob: CronJob | null = null;
  private oneHourJob: CronJob | null = null;
  private oneHourBuyerJob: CronJob | null = null;
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

    // 5-minute alert job (runs every 6 minutes at :00, :06, :12, etc.)
    this.fiveMinJob = new CronJob(
      '0 */6 * * * *',  // Every 6 minutes at :00 seconds
      async () => {
        logger.info('[Scheduler] Starting 5-minute alert cycle');
        await this.fetchTokenDexInfo('5min');
      },
      null,
      true,
      'UTC'
    );

    // 1-hour volume alert job (runs at :00 every hour)
    this.oneHourJob = new CronJob(
      '0 0 * * * *',  // At :00 of every hour
      async () => {
        logger.info('[Scheduler] Starting 1-hour volume alert cycle');
        await this.fetchTokenDexInfo('1h');
      },
      null,
      true,
      'UTC'
    );

    // 1-hour buyer alert job (runs at :30 every hour)
    this.oneHourBuyerJob = new CronJob(
      '0 30 * * * *',  // At :30 of every hour
      async () => {
        logger.info('[Scheduler] Starting 1-hour buyer alert cycle');
        await this.fetchTokenDexInfo('1h_buyer');
      },
      null,
      true,
      'UTC'
    );

    logger.info('TokenMetricsDexscreenerPoller started with separate cron jobs for each alert type');
  }

  stop() {
    if (this.fiveMinJob) {
      this.fiveMinJob.stop();
      this.fiveMinJob = null;
    }
    if (this.oneHourJob) {
      this.oneHourJob.stop();
      this.oneHourJob = null;
    }
    if (this.oneHourBuyerJob) {
      this.oneHourBuyerJob.stop();
      this.oneHourBuyerJob = null;
    }
    this.running = false;
    logger.info('TokenMetricsDexscreenerPoller and all jobs stopped');
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
      const refreshToken = result.rows[0][1]; // refresh_token
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

      let currentAccessToken = accessToken;
      let currentRefreshToken = refreshToken;
      let currentExpiresAt = expiresAt;

      // Auto-refresh if token expires soon (within 5 minutes)
      if (expiresAt && new Date(expiresAt) < new Date(Date.now() + 5 * 60 * 1000)) {
        logger.info('getTwitterClient: Access token nearing expiry - attempting auto-refresh');

        if (!refreshToken) {
          logger.error('getTwitterClient: No refresh token available for auto-refresh');
          return null;
        }

        try {
          // Create app client for refresh (requires client_id and client_secret in config)
          const appClient = new TwitterApi({
            clientId: config.twitter.clientId,
            clientSecret: config.twitter.clientSecret,
          });

          const refreshed = await appClient.refreshOAuth2Token(refreshToken);

          currentAccessToken = refreshed.accessToken;
          currentRefreshToken = refreshed.refreshToken;
          currentExpiresAt = new Date(Date.now() + (refreshed.expiresIn || 7200) * 1000).toISOString();

          // Update DB with new tokens
          const updateQuery = `
            UPDATE twitter_auth 
            SET 
              access_token = '${currentAccessToken}', 
              refresh_token = '${currentRefreshToken}', 
              expires_at = '${currentExpiresAt}',
              updated_at = now()
            WHERE id = '${userId}';
          `;
          await questdbService.query(updateQuery);

          logger.info('getTwitterClient: Successfully refreshed tokens and updated DB', {
            username,
            newExpiresAt: currentExpiresAt,
            newTokenPrefix: `${currentAccessToken.substring(0, 10)}...`
          });
        } catch (refreshError: any) {
          logger.error('getTwitterClient: Auto-refresh failed', {
            error: refreshError.message,
            code: refreshError.code,
            status: refreshError.status
          });
          // Fall back to original token (might fail verification next)
        }
      }

      // Create a new Twitter client with the (potentially refreshed) access token
      logger.debug('getTwitterClient: Creating Twitter client with access token');
      const client = new TwitterApi(currentAccessToken);

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


  private async fetchTokenDexInfo(alertType: '5min' | '1h' | '1h_buyer') {
    if (!this.running) return;
    
    const run5MinAlert = alertType === '5min';
    const run1HrAlert = alertType === '1h';
    const run1HrBuyerAlert = alertType === '1h_buyer';

    try {
      // Fetch active user plans with non-empty token addresses
      const res = await questdbService.query(
        `SELECT DISTINCT token AS contract, 'SOLANA' as chain, created_at 
         FROM user_posts_plans 
         WHERE token IS NOT NULL AND token != '' 
         AND expire_at > now() 
         ORDER BY created_at DESC;`
      );
      
      const contractIdx = res.columns.indexOf('contract');
      const chainIdx = res.columns.indexOf('chain');
      const items = res.rows.map(r => ({
        contract: String(r[contractIdx] || '').toLowerCase(),
        chain: String(r[chainIdx] || '').toUpperCase()
      })).filter(x => x.contract);

      if (items.length === 0) {
        logger.info('No active user plans with valid token addresses found - skipping this cycle');
        return;
      }

      logger.info(`[${alertType}] Fetching data for ${items.length} unique tokens`);

      const uniqueContracts = Array.from(new Set(items.map(i => i.contract)));
      const batches = this.chunk(uniqueContracts, 30);

      let alertsPosted = 0;

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
              
              logger.debug(`[Dexscreener] Processing token ${item.contract} on chain ${item.chain} - Found ${relevantPairs.length} trading pairs`);
              
              if (relevantPairs.length === 0) {
                logger.warn(`[Dexscreener] No trading pairs found for contract ${item.contract} on chain ${item.chain} - skipping update`);
                // Log the actual API response for debugging
                const allPairs = Array.from(pairsByContractChain.entries())
                  .filter(([k]) => k.startsWith(`${item.contract}:`));
                logger.debug(`[Dexscreener] Available pairs for token ${item.contract} across all chains:`, 
                  allPairs.map(([k, v]) => ({ chain: k.split(':')[1], pairs: v.length })));
                continue;
              }

              // Select the pair with the highest liquidity
              const selectedPair = relevantPairs.reduce((prev, curr) => {
                const prevLiquidity = prev.liquidity?.usd || 0;
                const currLiquidity = curr.liquidity?.usd || 0;
                logger.debug(`[Dexscreener] Comparing pairs - Current: ${curr.baseToken?.symbol || 'unknown'} ($${currLiquidity}) vs Previous: ${prev.baseToken?.symbol || 'unknown'} ($${prevLiquidity})`);
                return currLiquidity > prevLiquidity ? curr : prev;
              });
              
              logger.info(`[Dexscreener] Selected pair for ${item.contract}: ${selectedPair.baseToken?.symbol || 'unknown'} with $${selectedPair.liquidity?.usd || 0} liquidity`);

              const baseTokenSymbol = selectedPair.baseToken?.symbol || 'UNKNOWN';
              const priceUsd = selectedPair.priceUsd != null ? Number(selectedPair.priceUsd) : 0;
              const volume5m = selectedPair.volume?.m5 != null ? Number(selectedPair.volume.m5) : 0;
              const volume1h = selectedPair.volume?.h1 != null ? Number(selectedPair.volume.h1) : 0;
              const priceChange5m = selectedPair.priceChange?.m5 != null ? Number(selectedPair.priceChange.m5) : 0;
              const priceChange1h = selectedPair.priceChange?.h1 != null ? Number(selectedPair.priceChange.h1) : 0;

              // Prepare alert messages based on alert types
              const dexLink = `https://dexscreener.com/solana/${item.contract}`;
              
              // 5-minute volume alert
              if (run5MinAlert && volume5m > 0) {
                const tweetText = `📈 5-Min Volume Alert! ${baseTokenSymbol}

` +
                `💵 Price: $${priceUsd.toFixed(6)}
` +
                `📊 5m Volume: $${volume5m.toLocaleString()}
` +
                `📈 5m Price Change: ${priceChange5m > 0 ? '🟢' : '🔴'} ${priceChange5m.toFixed(2)}%

` +
                `${dexLink}
` +
                `#Solana #${baseTokenSymbol} #Crypto`;
                
                logger.info(`[5min Alert] Posting for ${baseTokenSymbol}: ${tweetText}`);
                await this.postToTwitter(tweetText);
                alertsPosted++;
              }
              
              // 1-hour volume alert
              if (run1HrAlert && volume1h > 0) {
                const tweetText = `🚀 1-Hour Volume Alert! ${baseTokenSymbol}

` +
                `💵 Price: $${priceUsd.toFixed(6)}
` +
                `📊 1h Volume: $${volume1h.toLocaleString()}
` +
                `📈 1h Price Change: ${priceChange1h > 0 ? '🟢' : '🔴'} ${priceChange1h.toFixed(2)}%

` +
                `${dexLink}
` +
                `#Solana #${baseTokenSymbol} #Crypto`;
                
                logger.info(`[1h Alert] Posting for ${baseTokenSymbol}: ${tweetText}`);
                await this.postToTwitter(tweetText);
                alertsPosted++;
              }
              
              // 1-hour buyer alert (example implementation - adjust based on your criteria)
              if (run1HrBuyerAlert && priceChange1h > 0) {
                const tweetText = `🛍️ 1-Hour Buyer Alert! ${baseTokenSymbol}

` +
                `💰 Price: $${priceUsd.toFixed(6)}
` +
                `📈 1h Price Change: 🟢 +${priceChange1h.toFixed(2)}%
` +
                `💹 24h Volume: $${volume1h.toLocaleString()}

` +
                `${dexLink}
` +
                `#Solana #${baseTokenSymbol} #Crypto #BuyingPressure`;
                
                logger.info(`[1h Buyer Alert] Posting for ${baseTokenSymbol}: ${tweetText}`);
                await this.postToTwitter(tweetText);
                alertsPosted++;
              }

              // Log the data for this token
              logger.info(`[${baseTokenSymbol}] Price: $${priceUsd.toFixed(6)} | ` +
                `5m Vol: $${volume5m.toLocaleString()} (${priceChange5m > 0 ? '+' : ''}${priceChange5m.toFixed(2)}%) | ` +
                `1h Vol: $${volume1h.toLocaleString()} (${priceChange1h > 0 ? '+' : ''}${priceChange1h.toFixed(2)}%)`);

              // Update token_metrics with the latest data
              try {
                await questdbService.query(`
                  INSERT INTO token_metrics 
                  (contract, chain, price_usd, volume_5m, volume_1h, price_change_5m, price_change_1h, updated_at)
                  VALUES (
                    '${item.contract}', 
                    '${item.chain}', 
                    ${priceUsd}, 
                    ${volume5m}, 
                    ${volume1h}, 
                    ${priceChange5m}, 
                    ${priceChange1h}, 
                    now()
                  )
                  ON CONFLICT(contract, chain) DO UPDATE SET 
                    price_usd = EXCLUDED.price_usd,
                    volume_5m = EXCLUDED.volume_5m,
                    volume_1h = EXCLUDED.volume_1h,
                    price_change_5m = EXCLUDED.price_change_5m,
                    price_change_1h = EXCLUDED.price_change_1h,
                    updated_at = EXCLUDED.updated_at;
                `);
                logger.debug(`[DB] Updated token_metrics for ${item.contract} (${item.chain})`);
              } catch (error) {
                logger.error(`[DB] Failed to update token_metrics for ${item.contract} (${item.chain}):`, error);
              }
            }
          }

          if (alertsPosted > 0) {
            logger.info(`[${alertType}][batch:${batchIndex + 1}] Processed ${batch.length} contracts: Posted ${alertsPosted} alerts`);
          } else {
            logger.debug(`[${alertType}][batch:${batchIndex + 1}] Processed ${batch.length} contracts: No alerts posted`);
          }
        } catch (err: any) {
          logger.error(`[Dexscreener][batch:${batchIndex + 1} failed] Error processing ${batch.length} contracts: ${err.message}`, { error: err });
        }
      }

      // Overall cycle summary
      if (alertsPosted > 0) {
        logger.info(`[${alertType}] Cycle complete: Posted ${alertsPosted} alerts for ${uniqueContracts.length} tokens`);
      } else {
        logger.info(`[${alertType}] Cycle complete: No alerts posted for ${uniqueContracts.length} tokens`);
      }
    } catch (e) {
      logger.error('TokenMetricsDexscreenerPoller fetchTokenDexInfo failed - Full cycle error', { error: e });
    }
  }
}

export const tokenMetricsDexscreenerPoller = new TokenMetricsDexscreenerPoller();