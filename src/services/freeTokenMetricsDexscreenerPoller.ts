import { questdbService } from './questDbService';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { CronJob } from 'cron';
import { TokenInfoResponse } from '../models/token.types';
import { TwitterApi } from 'twitter-api-v2';

class FreeTokenMetricsDexscreenerPoller {
    private fiveMinJob: CronJob | null = null;
    private running = false;
    private readonly MAX_POSTS = 10; // Limit to 10 posts

    private chunk<T>(arr: T[], size: number): T[][] {
        const out: T[][] = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    }

    async start() {
        if (this.running) return;
        await questdbService.init();
        this.running = true;

        // 5-minute alert job (runs every 5 minutes)
        this.fiveMinJob = new CronJob(
            '0 */1 * * * *',  // Every 5 minutes at :00 seconds
            async () => {
                logger.info('[Free Scheduler] Starting 5-minute alert cycle');
                await this.fetchTokenDexInfo();
            },
            null,
            true,
            'UTC'
        );

        logger.info('FreeTokenMetricsDexscreenerPoller started with 5-minute alerts only');
    }

    stop() {
        if (this.fiveMinJob) {
            this.fiveMinJob.stop();
            this.fiveMinJob = null;
        }
        this.running = false;
        logger.info('FreeTokenMetricsDexscreenerPoller stopped');
    }

    private async getTwitterClient() {
        try {
            logger.debug('getTwitterClient: Attempting to fetch valid Twitter access token from database');

            const userQuery = `
        SELECT DISTINCT twitter_id 
        FROM user_posts_plans 
        WHERE username IS NOT NULL 
        AND service_type = 'freeTrial'
        LIMIT 1`;

            logger.debug('getTwitterClient: Fetching username from user_posts_plans');
            const userResult = await questdbService.query(userQuery);

            if (userResult.rows.length === 0) {
                logger.error('No username found in user_posts_plans table');
                return null;
            }

            const twitterUsername = userResult.rows[0][0]?.trim();

            if (!twitterUsername) {
                logger.error('Found empty username in user_posts_plans table');
                return null;
            }

            const query = `
    SELECT 
      access_token, 
      refresh_token, 
      expires_at,
      username
    FROM twitter_auth 
    WHERE username = '${twitterUsername.replace(/'/g, "''")}'
      AND access_token IS NOT NULL 
    ORDER BY updated_at DESC 
    LIMIT 1`;

            const result = await questdbService.query(query);

            if (result.rows.length === 0) {
                logger.error('No valid Twitter access token found in database');
                return null;
            }

            const accessToken = result.rows[0][0];
            const refreshToken = result.rows[0][1];
            const username = result.rows[0][3] || 'unknown';
            const userId = result.rows[0][4] || 'unknown';
            const expiresAt = result.rows[0][2];

            if (!accessToken) {
                logger.error('Found row but access token is empty or undefined');
                return null;
            }

            let currentAccessToken = accessToken;
            let currentRefreshToken = refreshToken;
            let currentExpiresAt = expiresAt;

            // Refresh token if needed
            const now = new Date();
            const tokenExpiry = expiresAt ? (typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt) : null;
            const shouldRefresh = !tokenExpiry || tokenExpiry < new Date(now.getTime() + 5 * 60 * 1000);

            if (shouldRefresh && refreshToken) {
                try {
                    const appClient = new TwitterApi({
                        clientId: config.twitter.clientId,
                        clientSecret: config.twitter.clientSecret,
                    });

                    const refreshed = await appClient.refreshOAuth2Token(refreshToken);
                    currentAccessToken = refreshed.accessToken;
                    currentRefreshToken = refreshed.refreshToken;
                    currentExpiresAt = new Date(Date.now() + (refreshed.expiresIn || 7200) * 1000).toISOString();

                    const updateQuery = `
            UPDATE twitter_auth 
            SET 
              access_token = '${currentAccessToken.replace(/'/g, "''")}', 
              refresh_token = '${currentRefreshToken.replace(/'/g, "''")}', 
              expires_at = to_timestamp('${currentExpiresAt}', 'yyyy-MM-ddTHH:mm:ss.SSSZ'),
              updated_at = now()
            WHERE username = '${username.replace(/'/g, "''")}';
          `;
                    await questdbService.query(updateQuery);
                } catch (refreshError: any) {
                    logger.error('getTwitterClient: Auto-refresh failed', {
                        error: refreshError.message,
                        code: refreshError.code,
                        status: refreshError.status
                    });
                }
            }

            const client = new TwitterApi(currentAccessToken);
            return client;
        } catch (error: any) {
            logger.error('Error in getTwitterClient:', {
                error: error.message,
                stack: error.stack
            });
            return null;
        }
    }

    private async fetchTokenDexInfo() {
        if (!this.running) return;

        try {
            logger.info('[Free] Fetching token metrics from Dexscreener for free trial users');

            // In fetchTokenDexInfo method, update the query to:
            const res = await questdbService.query(
                `SELECT DISTINCT 
        token AS contract, 
        'SOLANA' as chain,
        created_at
     FROM user_posts_plans 
     WHERE token IS NOT NULL 
     AND token != '' 
     AND service_type = 'freeTrial'
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
                logger.info('[Free] No active free trial 1 users with valid token addresses found');
                return;
            }

            logger.info(`[Free] Found ${items.length} active free trial tokens to monitor`);

            const uniqueContracts = Array.from(new Set(items.map(i => i.contract)));
            const batches = this.chunk(uniqueContracts, 30);

            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                const batch = batches[batchIndex];
                const batchUrl = `${config.baseUrls.dexscreener}${batch.join(',')}`;

                try {
                    logger.info(`[Free][Dexscreener][batch:${batchIndex + 1}/${batches.length}] Fetching ${batch.length} contracts`);
                    const resp = await fetch(batchUrl);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}: Failed to fetch batch from Dexscreener`);
                    const json = await resp.json();

                    // Process the response: group pairs by (contract, chain)
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

                    for (const item of items) {
                        if (batch.includes(item.contract)) {
                            const key = `${item.contract}:${item.chain}`;
                            const relevantPairs = pairsByContractChain.get(key) || [];

                            if (relevantPairs.length === 0) {
                                logger.warn(`[Free][Dexscreener] No trading pairs found for contract ${item.contract} on chain ${item.chain}`);
                                continue;
                            }

                            // Select the pair with the highest liquidity
                            const selectedPair = relevantPairs.reduce((prev, curr) => {
                                const prevLiquidity = prev.liquidity?.usd || 0;
                                const currLiquidity = curr.liquidity?.usd || 0;
                                return currLiquidity > prevLiquidity ? curr : prev;
                            });

                            const baseTokenSymbol = selectedPair.baseToken?.symbol || 'UNKNOWN';
                            const volume5m = selectedPair.volume?.m5 != null ? Number(selectedPair.volume.m5) : 0;
                            const priceChange5m = selectedPair.priceChange?.m5 != null ? Number(selectedPair.priceChange.m5) : 0;
                            const priceUsd = selectedPair.priceUsd != null ? Number(selectedPair.priceUsd) : 0;
                            const dexLink = `https://dexscreener.com/solana/${item.contract}`;

                            // Only post if there's volume in the last 5 minutes
                            if (volume5m > 0) {
                                const tweetText = `🎉 5MIN VOLUME ALERT! 
💸 5-min buy VOL: $${(volume5m / 1000).toFixed(0)}k on $${baseTokenSymbol} (${priceChange5m > 0 ? '📈' : '📉'} ${Math.abs(priceChange5m).toFixed(2)}%)

Price: $${priceUsd.toFixed(6)}
CA: ${item.contract}

[Live Chart](${dexLink})

#Solana #${baseTokenSymbol} #Crypto`;

                                logger.info(`[Free][5min Alert] Posting for ${baseTokenSymbol}: ${tweetText}`);
                                await this.postToTwitter({
                                    tweetText,
                                    contract: item.contract,
                                    chain: item.chain
                                });
                            }

                            // Update token_metrics table
                            try {
                                const safeSymbol = String(baseTokenSymbol || 'UNKNOWN').replace(/'/g, "''");
                                const safeContract = String(item.contract).replace(/'/g, "''");
                                const safeChain = String(item.chain).replace(/'/g, "''");

                                const updateQuery = `
                                    UPDATE token_metrics
                                    SET 
                                        chain = '${safeChain}',
                                        price_usd = ${priceUsd || 0},
                                        volume_5m = ${volume5m || 0},
                                        fdv = ${selectedPair.fdv || 0}
                                    WHERE contract = '${safeContract}';
                                `;

                                const insertQuery = `
                                    INSERT INTO token_metrics
                                    (contract, chain, price_usd, volume_5m, fdv, timestamp)
                                    VALUES (
                                        '${safeContract}',
                                        '${safeChain}',
                                        ${priceUsd || 0},
                                        ${volume5m || 0},
                                        ${selectedPair.fdv || 0},
                                        now()
                                    );
                                `;

                                const checkQuery = `SELECT 1 FROM token_metrics WHERE contract = '${safeContract}' AND chain = '${safeChain}' LIMIT 1;`;

                                try {
                                    const exists = (await questdbService.query(checkQuery)).rows.length > 0;
                                    if (exists) {
                                        await questdbService.query(updateQuery);
                                    } else {
                                        await questdbService.query(insertQuery);
                                    }
                                } catch (err) {
                                    await questdbService.query(insertQuery).catch(e =>
                                        logger.error(`[Free][DB] Failed to insert record for ${item.contract}:`, e)
                                    );
                                }
                            } catch (error) {
                                logger.error(`[Free] Failed to update token_metrics for ${item.contract}:`, error);
                            }
                        }
                    }
                } catch (err: any) {
                    logger.error(`[Free][Dexscreener][batch:${batchIndex + 1} failed] Error: ${err.message}`, { error: err });
                }
            }
        } catch (error: any) {
            logger.error('[Free] Error in fetchTokenDexInfo:', {
                error: error.message,
                stack: error.stack
            });
        }
    }

    private async postToTwitter(params: { tweetText: string; contract: string; chain: string }) {
        const { tweetText, contract, chain } = params;
        const twitterClient = await this.getTwitterClient();

        if (!twitterClient) {
            logger.error('[Free] No valid Twitter client available');
            return null;
        }

        try {
            // First, check if user can post
            const checkQuery = `
            SELECT 
                twitter_id,
                total_posts_count,
                total_posts_allowed
            FROM user_posts_plans 
            WHERE service_type = 'freeTrial'
            AND expire_at > now()
            LIMIT 1
        `;

            const checkResult = await questdbService.query(checkQuery);

            if (checkResult.rows.length === 0) {
                logger.warn(`[Free] No active free trial found for contract: ${contract}`);
                return null;
            }

            const [twitterId, currentCount, maxCount] = checkResult.rows[0];

            if (currentCount >= maxCount) {
                logger.info(`[Free] User ${twitterId} has reached their maximum allowed posts (${currentCount}/${maxCount})`);
                return null;
            }

            // Post the tweet
            const tweet = await twitterClient.v2.tweet(tweetText);
            logger.info(`[Free] Posted tweet for ${contract} (${chain}): ${tweet.data.text}`);

            // Update the post count
            const updateQuery = `
            UPDATE user_posts_plans 
            SET 
                total_posts_count = total_posts_count + 1,
                updated_at = now()
            WHERE twitter_id = '${twitterId}'
            AND service_type = 'freeTrial'
            AND expire_at > now()
            AND total_posts_count < total_posts_allowed
        `;

            await questdbService.query(updateQuery);

            // Verify the update
            const verifyQuery = `
            SELECT total_posts_count 
            FROM user_posts_plans 
            WHERE twitter_id = '${twitterId}'
            AND service_type = 'freeTrial'
            LIMIT 1
        `;

            const verifyResult = await questdbService.query(verifyQuery);
            if (verifyResult.rows.length > 0) {
                const newCount = verifyResult.rows[0][0];
                logger.info(`[Free] Updated post count for user ${twitterId}: ${newCount}/${maxCount} posts used`);

                if (newCount >= maxCount) {
                    logger.info(`[Free] User ${twitterId} has reached their maximum allowed posts (${newCount}/${maxCount})`);
                }
            }

            return tweet;
        } catch (error: any) {
            logger.error(`[Free] Error in postToTwitter: ${error.message}`, {
                error: error.stack,
                contract,
                chain
            });
            throw error;
        }
    }

    private formatNumber(num: number): string {
        if (num >= 1000000) {
            return (num / 1000000).toFixed(2) + 'M';
        } else if (num >= 1000) {
            return (num / 1000).toFixed(1) + 'K';
        }
        return num.toString();
    }
}

export const freeTokenMetricsDexscreenerPoller = new FreeTokenMetricsDexscreenerPoller();
