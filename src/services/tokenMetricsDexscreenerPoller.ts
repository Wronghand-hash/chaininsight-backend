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
      '0 */1 * * * *',  // Every 6 minutes at :00 seconds
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
    // 1-hour buyer alert job (runs at :00 every hour)
    this.oneHourBuyerJob = new CronJob(
      '0 0 * * * *',  // At the start of every hour
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

  private async getTwitterClient(username?: string): Promise<TwitterApi | null> {
    try {
      let targetUsername: string;
      let query: string;
      if (username) {
        targetUsername = username;
        query = `
          SELECT
            access_token,
            refresh_token,
            expires_at,
            username,
            id
          FROM twitter_auth
          WHERE username = '${username.replace(/'/g, "''")}'
          AND access_token IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1`;
      } else {
        logger.debug('getTwitterClient: Attempting to fetch valid Twitter access token from database');
        // First, get the username from user_posts_plans table
        const userQuery = `
          SELECT DISTINCT twitter_id
          FROM user_posts_plans
          WHERE twitter_id IS NOT NULL
          LIMIT 1`;
        logger.debug('getTwitterClient: Fetching username from user_posts_plans');
        const userResult = await questdbService.query(userQuery);
        if (userResult.rows.length === 0) {
          logger.error('No username found in user_posts_plans table');
          return null;
        }
        targetUsername = userResult.rows[0][0]?.trim();
        if (!targetUsername) {
          logger.error('Found empty username in user_posts_plans table');
          return null;
        }
        logger.debug('getTwitterClient: Found username in user_posts_plans:', { username: targetUsername });
        query = `
          SELECT
            access_token,
            refresh_token,
            expires_at,
            username,
            id
          FROM twitter_auth
          WHERE username = '${targetUsername.replace(/'/g, "''")}'
          AND access_token IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1`;
      }
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
      const usernameFromDb = result.rows[0][3] || 'unknown';
      const userId = result.rows[0][4] || 'unknown';
      const expiresAt = result.rows[0][2];
      logger.debug('getTwitterClient: Found access token', {
        username: usernameFromDb,
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
      // Refresh token if it's expired or about to expire (within 5 minutes)
      const now = new Date();
      const tokenExpiry = expiresAt ? (typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt) : null;
      const shouldRefresh = !tokenExpiry || tokenExpiry < new Date(now.getTime() + 5 * 60 * 1000);
      if (shouldRefresh) {
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
          // Update DB with new tokens using parameterized query
          const updateQuery = `
            UPDATE twitter_auth
            SET
              access_token = '${currentAccessToken.replace(/'/g, "''")}',
              refresh_token = '${currentRefreshToken.replace(/'/g, "''")}',
              expires_at = to_timestamp('${currentExpiresAt}', 'yyyy-MM-ddTHH:mm:ss.SSSZ'),
              updated_at = now()
            WHERE id = '${userId.replace(/'/g, "''")}';
          `;
          await questdbService.query(updateQuery);
          logger.info('getTwitterClient: Successfully refreshed tokens and updated DB', {
            username: usernameFromDb,
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

  private extractCommunityId(communityLink: string): string | null {
    try {
      // Handle different community link formats
      // Format 1: https://twitter.com/i/communities/1234567890123456789
      // Format 2: https://x.com/i/communities/1234567890123456789
      // Format 3: https://twitter.com/i/communities/1234567890123456789/settings
      const match = communityLink.match(/[\/](?:communities|i\/communities)[\/](\d+)/);
      if (match && match[1]) {
        return match[1];
      }
      // If the link is just a community ID
      if (/^\d+$/.test(communityLink)) {
        return communityLink;
      }
      logger.warn('Could not extract community ID from link:', communityLink);
      return null;
    } catch (error) {
      logger.error('Error extracting community ID:', error);
      return null;
    }
  }

  async postToCommunity(tweetText: string, communityLinkOrId: string, username?: string): Promise<boolean> {
    const client = await this.getTwitterClient(username);
    if (!client) {
      logger.error('Failed to get Twitter client');
      return false;
    }
    // Extract community ID from the provided link or ID
    const communityId = this.extractCommunityId(communityLinkOrId);
    if (!communityId) {
      logger.error('Invalid community link or ID:', communityLinkOrId);
      return false;
    }
    try {
      // Truncate if necessary
      const truncatedText = tweetText.length > 280 ? tweetText.substring(0, 277) + '...' : tweetText;
      // Post the tweet directly to the community
      const tweet = await client.v2.tweet({
        text: truncatedText,
        community_id: communityId
      });
      logger.info('Successfully posted to community', {
        tweetId: tweet.data.id,
        communityId
      });
      return true;
    } catch (error: any) {
      logger.error('Failed to post to community:', {
        error: error.message,
        code: error.code,
        status: error.status,
        communityId
      });
      return false;
    }
  }


  private async postAlert(message: string, contract: string, chain: string): Promise<boolean> {
    try {
      // First, check if we've reached the post limit for this contract and get twitter_community
      const checkQuery = `
        SELECT twitter_id, total_posts_count, total_posts_allowed, twitter_community
        FROM user_posts_plans
        WHERE LOWER(token) = LOWER('${contract.replace(/'/g, "''")}')
        AND expire_at > now()
        ORDER BY created_at DESC
        LIMIT 1`;
      const result = await questdbService.query(checkQuery);
      if (result.rows.length === 0) {
        logger.info(`No active plan found for ${contract} (${chain}) - skipping post`);
        return false;
      }
      const [twitter_id, currentCount, allowedCount, community_link_raw] = result.rows[0];
      const community_link = String(community_link_raw || '');
      const username = twitter_id; // twitter_id is the username
      if (Number(currentCount) >= Number(allowedCount)) {
        logger.info(`Post limit reached for ${contract} (${currentCount}/${allowedCount} posts)`);
        return false;
      }
      // Get Twitter client for this username
      const client = await this.getTwitterClient(username);
      if (!client) {
        logger.error('Could not create Twitter client - no valid access token found for username:', username);
        return false;
      }
      // Truncate message
      const truncatedMessage = message.length > 280 ? message.substring(0, 277) + '...' : message;
      let postSuccess = false;
      if (community_link.trim()) {
        postSuccess = await this.postToCommunity(truncatedMessage, community_link, username);
      } else {
        // Fallback to regular Twitter post
        const tweet = await client.v2.tweet(truncatedMessage);
        postSuccess = !!tweet;
        if (postSuccess) {
          logger.info(`Posted to Twitter (${contract}): ${truncatedMessage}`);
        } else {
          logger.error('Failed to post to Twitter: No response from API');
        }
      }
      if (postSuccess) {
        // Update the post count in user_posts_plans
        const updateQuery = `
          UPDATE user_posts_plans
          SET total_posts_count = COALESCE(total_posts_count, 0) + 1,
              updated_at = now()
          WHERE twitter_id = '${username.replace(/'/g, "''")}' 
          AND LOWER(token) = LOWER('${contract.replace(/'/g, "''")}')`;
        await questdbService.query(updateQuery).catch(err =>
          logger.error(`Failed to update post count for ${contract}:`, err)
        );
        return true;
      } else {
        logger.error('Failed to post alert for ${contract}');
        return false;
      }
    } catch (error) {
      logger.error('Error posting alert:', error);
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
                return currLiquidity > prevLiquidity ? curr : prev;
              });
              logger.info(`[Dexscreener] Selected pair for ${item.contract}: ${selectedPair.baseToken?.symbol || 'unknown'} with $${selectedPair.liquidity?.usd || 0} liquidity`);
              const baseTokenSymbol = selectedPair.baseToken?.symbol || 'UNKNOWN';
              const priceUsd = selectedPair.priceUsd != null ? Number(selectedPair.priceUsd) : 0;
              const volume5m = selectedPair.volume?.m5 != null ? Number(selectedPair.volume.m5) : 0;
              const volume1h = selectedPair.volume?.h1 != null ? Number(selectedPair.volume.h1) : 0;
              const volume24h = selectedPair.volume?.h24 != null ? Number(selectedPair.volume.h24) : 0;
              const priceChange5m = selectedPair.priceChange?.m5 != null ? Number(selectedPair.priceChange.m5) : 0;
              const priceChange1h = selectedPair.priceChange?.h1 != null ? Number(selectedPair.priceChange.h1) : 0;
              const fdv = selectedPair.fdv != null ? Number(selectedPair.fdv) : 0;
              const marketCap = selectedPair.marketCap != null ? Number(selectedPair.marketCap) : 0;
              // Prepare alert messages based on alert types
              const dexLink = `https://dexscreener.com/solana/${item.contract}`;
              // 5-minute volume alert
              if (run5MinAlert && volume5m > 0) {
                const tweetText = `🎉 5MIN VOLUME ALERT! �
💸 5-min buy VOL: $${(volume5m / 1000).toFixed(0)}k on $${baseTokenSymbol} 🔥
� CA: ${item.contract}
� [Live Chart](${dexLink})
Auto-posted by @DEXAlerts | NFA | DYOR | Community-run`;
                logger.info(`[5min Alert] Attempting to post for ${baseTokenSymbol}`);
                const posted = await this.postAlert(tweetText, item.contract, item.chain);
                if (posted) {
                  logger.info(`[5min Alert] Successfully posted for ${baseTokenSymbol}`);
                  alertsPosted++;
                } else {
                  logger.warn(`[5min Alert] Failed to post for ${baseTokenSymbol}`);
                }
              }
              // 1-hour volume alert
              if (run1HrAlert && volume1h > 0) {
                const formattedVolume = volume1h >= 1000000
                  ? `$${(volume1h / 1000000).toFixed(1)}M`
                  : `$${(volume1h / 1000).toFixed(0)}k`;
                const tweetText = `🎉 1H VOLUME ALERT! 🚀
` +
                  `� 1-hour VOL: ${formattedVolume} on $${baseTokenSymbol} 🔥
` +
                  `� CA: ${item.contract}
` +
                  `📊 [Live Chart](${dexLink})
` +
                  `Auto-posted by @DEXAlerts | NFA | DYOR | Community-run`;
                logger.info(`[1h Alert] Attempting to post for ${baseTokenSymbol}`);
                const posted = await this.postAlert(tweetText, item.contract, item.chain);
                if (posted) {
                  logger.info(`[1h Alert] Successfully posted for ${baseTokenSymbol}`);
                  alertsPosted++;
                } else {
                  logger.warn(`[1h Alert] Failed to post for ${baseTokenSymbol}`);
                }
              }
              // 1-hour buyer alert
              if (run1HrBuyerAlert) {
                // Extract transaction data with null checks
                const txns = selectedPair.txns || {};
                const h1 = (txns as any)?.h1 || {};
                const m5 = (txns as any)?.m5 || {};
                const buyerCount = h1.buys || 0;
                const sellerCount = h1.sells || 0;
                logger.info(`[${baseTokenSymbol}] Transaction data - 1h: ${JSON.stringify(h1)}, 5m: ${JSON.stringify(m5)}`);
                // Minimum number of buyers required to trigger an alert
                const minBuyersThreshold = 1;
                if (buyerCount >= minBuyersThreshold) {
                  const priceChangeText = priceChange1h > 0 ? `+${priceChange1h.toFixed(2)}% 📈` :
                    priceChange1h < 0 ? `${priceChange1h.toFixed(2)}% 📉` : '0% ➖';
                  logger.info(`[${baseTokenSymbol}] Buyers: ${buyerCount}, Sellers: ${sellerCount} in the last hour`);
                  const tweetText = `🎉 HOURLY BUYER ALERT! 🚀
💸 1H: ${buyerCount} Unique Buyers Bought $${baseTokenSymbol} 🔥
🔗 CA: ${item.contract}
📊 [Live Chart](${dexLink})
Auto-posted by @DEXAlerts_io | NFA | DYOR | Community-run`;
                  logger.info(`[1h Buyer Alert] Attempting to post for ${baseTokenSymbol}`);
                  const posted = await this.postAlert(tweetText, item.contract, item.chain);
                  if (posted) {
                    logger.info(`[1h Buyer Alert] Successfully posted for ${baseTokenSymbol}`);
                    alertsPosted++;
                  } else {
                    logger.warn(`[1h Buyer Alert] Failed to post for ${baseTokenSymbol}`);
                  }
                }
              }
              // Log the data for this token
              logger.info(`[${baseTokenSymbol}] Price: $${priceUsd.toFixed(6)} | ` +
                `5m Vol: $${volume5m.toLocaleString()} (${priceChange5m > 0 ? '+' : ''}${priceChange5m.toFixed(2)}%) | ` +
                `1h Vol: $${volume1h.toLocaleString()} (${priceChange1h > 0 ? '+' : ''}${priceChange1h.toFixed(2)}%)`);
              // Update token_metrics with the latest data
              try {
                // Ensure baseTokenSymbol is a string and properly escaped
                const safeSymbol = String(baseTokenSymbol || 'UNKNOWN').replace(/'/g, "''");
                const safeContract = String(item.contract).replace(/'/g, "''");
                const safeChain = String(item.chain).replace(/'/g, "''");
                // First, attempt to update existing record (without updating timestamp)
                const updateQuery = `
  UPDATE token_metrics
  SET
    chain = '${safeChain}',
    price_usd = ${priceUsd || 0},
    volume_5m = ${volume5m || 0},
    volume_1h = ${volume1h || 0},
    volume_24h = ${volume24h || 0},
    fdv = ${fdv || 0},
    market_cap = ${marketCap || 0}
  WHERE contract = '${safeContract}';`;
                // Then, insert if no rows were updated
                const insertQuery = `
  INSERT INTO token_metrics
  (contract, chain, price_usd, volume_5m, volume_1h, volume_24h, fdv, market_cap, timestamp)
  VALUES (
    '${safeContract}',
    '${safeChain}',
    ${priceUsd || 0},
    ${volume5m || 0},
    ${volume1h || 0},
    ${volume24h || 0},
    ${fdv || 0},
    ${marketCap || 0},
    now()
  );`;
                // First, check if record exists
                const checkQuery = `SELECT 1 FROM token_metrics WHERE contract = '${safeContract}' AND chain = '${safeChain}' LIMIT 1;`;
                try {
                  // Check if record exists
                  const exists = (await questdbService.query(checkQuery)).rows.length > 0;
                  if (exists) {
                    // Update existing record
                    await questdbService.query(updateQuery);
                    logger.debug(`[DB] Updated record for ${item.contract} (${item.chain})`);
                  } else {
                    // Insert new record
                    await questdbService.query(insertQuery);
                    logger.debug(`[DB] Inserted new record for ${item.contract} (${item.chain})`);
                  }
                } catch (error: any) {
                  // Fallback to insert if update fails
                  await questdbService.query(insertQuery).catch(err =>
                    logger.error(`[DB] Failed to insert record for ${item.contract}:`, err)
                  );
                  logger.debug(`[DB] Inserted new record after error for ${item.contract}`);
                }
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