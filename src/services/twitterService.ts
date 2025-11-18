// twitterService.ts
import { TwitterApi } from 'twitter-api-v2';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { redis } from '../utils/redisHelper';
import { questdbService } from './questDbService';
import type { TwitterAuthRow } from '../models/db.types';

const REDIS_NONCE_PREFIX = 'twitter:oauth:nonce:';
const NONCE_EXPIRY_SECONDS = 600;

class TwitterService {
    private client: TwitterApi | null = null;
    private initialized = false;

    public async getCodeVerifier(state: string): Promise<string | null> {
        const redisKey = REDIS_NONCE_PREFIX + state;
        logger.debug('getCodeVerifier: Looking up state in Redis:', redisKey);

        const codeVerifier = await redis.get(redisKey);

        logger.debug('getCodeVerifier: Found verifier length:', codeVerifier?.length || 0);
        return codeVerifier;
    }

    private async deleteNonce(state: string): Promise<void> {
        const redisKey = REDIS_NONCE_PREFIX + state;
        logger.debug('deleteNonce: Removing state from Redis:', redisKey);
        await redis.del(redisKey);
    }

    async init() {
        logger.debug('init: Starting TwitterService initialization');
        if (this.initialized) {
            logger.debug('init: Already initialized, skipping');
            return;
        }
        if (!config.twitter?.appKey || !config.twitter?.clientSecret || !config.twitter?.accessToken || !config.twitter?.accessSecret) {
            logger.error('TwitterService: Missing required credentials (need appKey, clientSecret, accessToken, accessSecret)');
            this.initialized = false;
            return;
        }
        try {
            this.client = new TwitterApi({
                appKey: config.twitter.appKey,
                appSecret: config.twitter.clientSecret,
                accessToken: config.twitter.accessToken,
                accessSecret: config.twitter.accessSecret,
            });
            const user = await this.client.v2.me({ 'user.fields': 'username' });
            logger.info(`TwitterService initialized successfully for user: @${user.data.username}`);
            this.initialized = true;
        } catch (err: any) {
            logger.error(`Failed to initialize TwitterService: ${err.code || 'Unknown error'} - ${err.message}`, err);
            this.initialized = false;
        }
    }

    async postTweet(text: string): Promise<boolean> {
        logger.debug('postTweet: Attempting to post tweet, text length:', text.length);
        if (!this.initialized || !this.client) {
            logger.warn('TwitterService not initialized, skipping tweet');
            return false;
        }
        try {
            const truncatedText = text.length > 280 ? text.substring(0, 277) + '...' : text;
            logger.debug('postTweet: Posting truncated text length:', truncatedText.length);
            await this.client.v2.tweet(truncatedText);
            logger.info(`Tweet posted: ${truncatedText}`);
            return true;
        } catch (err: any) {
            logger.error(`Failed to post tweet: ${err.code || 'Unknown error'} - ${err.message}`, err);
            return false;
        }
    }

    async generateLoginUrl(redirectUri: string, scopes: string[] = ['users.read', 'community.read', 'tweet.read']): Promise<{ url: string; state: string; codeVerifier: string; codeChallenge: string }> {
        logger.debug('generateLoginUrl: Using redirectUri:', redirectUri, 'scopes:', scopes);
        if (!config.twitter?.clientId) {
            logger.error('generateLoginUrl: Twitter clientId is required for OAuth2 login');
            throw new Error('Twitter clientId is required for OAuth2 login');
        }
        const client = new TwitterApi({
            clientId: config.twitter.clientId,
        });

        const { url, state, codeVerifier, codeChallenge } = client.generateOAuth2AuthLink(redirectUri, {
            scope: scopes.join(' '),
        });

        logger.debug('generateLoginUrl: Generated auth link, state:', state.substring(0, 10) + '...', 'codeVerifier length:', codeVerifier.length, 'codeChallenge length:', codeChallenge.length);

        // Store nonce (state) with codeVerifier in Redis with an expiration time
        const redisKey = REDIS_NONCE_PREFIX + state;
        await redis.set(redisKey, codeVerifier, 'EX', NONCE_EXPIRY_SECONDS);
        logger.debug(`generateLoginUrl: Stored nonce for state in Redis (${NONCE_EXPIRY_SECONDS}s expiry):`, state.substring(0, 10) + '...');

        return { url, state, codeVerifier, codeChallenge };
    }

    async handleLoginCallback(code: string, codeVerifier: string, state: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number; scope: string; username?: string; userId: string }> {
        logger.debug('handleLoginCallback: Received code length:', code.length, 'state:', state.substring(0, 10) + '...', 'codeVerifier length:', codeVerifier.length, 'redirectUri:', redirectUri);

        // Get codeVerifier from Redis
        const storedCodeVerifier = await this.getCodeVerifier(state);
        logger.debug('handleLoginCallback: Found stored codeVerifier:', !!storedCodeVerifier);

        if (!storedCodeVerifier) {
            // Redis TTL handles expiration: if key is missing, it's either expired or invalid
            logger.error('handleLoginCallback: Invalid or missing nonce (state). Session expired.');
            throw new Error('Invalid or missing nonce (state). Session expired.');
        }

        if (storedCodeVerifier !== codeVerifier) {
            // PKCE mismatch or CSRF detected
            logger.error('handleLoginCallback: Code Verifier mismatch - possible CSRF attack or incorrect codeVerifier used.');
            // Clean up the invalid state
            await this.deleteNonce(state);
            throw new Error('Code Verifier mismatch - possible CSRF attack or incorrect codeVerifier used.');
        }

        logger.debug('handleLoginCallback: Nonce verification successful');

        // Clean up nonce immediately after successful verification
        await this.deleteNonce(state);
        logger.debug('handleLoginCallback: Cleaned up nonce for state:', state.substring(0, 10) + '...');

        if (!config.twitter?.clientId || !config.twitter?.clientSecret) {
            logger.error('handleLoginCallback: Twitter clientId and clientSecret are required for token exchange');
            throw new Error('Twitter clientId and clientSecret are required for token exchange');
        }

        try {
            const appClient = new TwitterApi({
                clientId: config.twitter.clientId,
                clientSecret: config.twitter.clientSecret,
            });
            logger.debug('handleLoginCallback: Starting OAuth2 token exchange');

            // --- DEBUG: LOGGING PKCE PARAMETERS ---
            logger.debug('handleLoginCallback: Exchange Payload:', {
                code: code.substring(0, 10) + '...',
                codeVerifier: codeVerifier.substring(0, 10) + '...',
                redirectUri,
            });
            // ----------------------------------------

            const tokenData = await appClient.loginWithOAuth2({
                code,
                codeVerifier,
                redirectUri,
            });
            const { accessToken, refreshToken, expiresIn, scope } = tokenData;
            console.log("tokken data", tokenData)
            logger.debug('handleLoginCallback: Token exchange successful, expiresIn:', expiresIn, 'scope:', scope);

            // Get user info with more fields
            const userClient = new TwitterApi(accessToken);
            const { data: userData } = await userClient.v2.me({
                'user.fields': 'id,username,name,profile_image_url,created_at,verified'
            });

            logger.info(`Twitter login successful for user: @${userData.username}`);

            // Calculate expiration timestamp
            const expiresAt = new Date();
            expiresAt.setSeconds(expiresAt.getSeconds() + expiresIn);

            // Prepare the scope as a string
            const scopeStr = Array.isArray(scope) ? scope.join(' ') : scope;

            try {
                // First, check if user exists
                const existingUser = await questdbService.query(`
                    SELECT id FROM twitter_auth WHERE id = '${userData.id}'
                `);

                if (existingUser.rows.length > 0) {
                    // Update existing record
                    await questdbService.query(`
                        UPDATE twitter_auth 
                        SET 
                            username = '${userData.username.replace(/'/g, "''")}',
                            access_token = '${accessToken.replace(/'/g, "''")}',
                            refresh_token = ${refreshToken ? `'${refreshToken.replace(/'/g, "''")}'` : 'NULL'},
                            expires_at = '${expiresAt.toISOString()}',
                            scope = '${scopeStr.replace(/'/g, "''")}',
                            updated_at = now()
                        WHERE id = '${userData.id}'
                    `);
                } else {
                    // Insert new record
                    await questdbService.query(`
                        INSERT INTO twitter_auth (
                            timestamp,
                            id, 
                            username, 
                            access_token, 
                            refresh_token, 
                            expires_at, 
                            scope, 
                            created_at, 
                            updated_at
                        ) VALUES (
                            now(),
                            '${userData.id}',
                            '${userData.username.replace(/'/g, "''")}',
                            '${accessToken.replace(/'/g, "''")}',
                            ${refreshToken ? `'${refreshToken.replace(/'/g, "''")}'` : 'NULL'},
                            '${expiresAt.toISOString()}',
                            '${scopeStr.replace(/'/g, "''")}',
                            now(),
                            now()
                        )
                    `);
                }

                logger.debug(`Successfully stored/updated Twitter auth data for user: @${userData.username}`);
            } catch (error) {
                logger.error('Failed to store Twitter auth data:', error);
                // Don't fail the login flow if DB update fails, just log the error
            }

            return {
                accessToken,
                refreshToken,
                expiresIn,
                scope: scopeStr,
                username: userData.username,
                userId: userData.id
            };
        } catch (err: any) {
            logger.error(`Failed to handle Twitter login callback: ${err.code || 'Unknown error'} - ${err.message}`, err);
            throw err;
        }
    }
    public async logout(userId: string): Promise<boolean> {
        const clientId = config.twitter?.clientId;
        const clientSecret = config.twitter?.clientSecret;

        if (!clientId || !clientSecret) {
            logger.error('Twitter OAuth client credentials not configured');
            return false;
        }

        try {
            // 1. Fetch tokens from database
            const query = `SELECT * FROM twitter_auth WHERE id = '${userId}'`;
            logger.debug(`Fetching tokens for user ${userId}`);
            const result = await questdbService.query(query);

            if (result.rows.length === 0) {
                logger.info(`No Twitter auth found for user ${userId}`);
                return true; // No record to delete, consider it a success
            }

            const row = result.rows[0];
            const access_token = row[3];
            const refresh_token = row[4];
            const expires_at = row[5];
            const isTokenExpired = new Date(expires_at) < new Date();

            // 2. Revoke tokens if they exist and aren't expired
            if (access_token && refresh_token && !isTokenExpired) {
                const auth = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
                const revokeUrl = 'https://api.twitter.com/2/oauth2/revoke';

                // Revoke access token
                const accessTokenParams = new URLSearchParams();
                accessTokenParams.append('token', access_token);
                accessTokenParams.append('token_type_hint', 'access_token');

                await fetch(revokeUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': auth
                    },
                    body: accessTokenParams.toString()
                });

                // Revoke refresh token
                const refreshTokenParams = new URLSearchParams();
                refreshTokenParams.append('token', refresh_token);
                refreshTokenParams.append('token_type_hint', 'refresh_token');

                await fetch(revokeUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': auth
                    },
                    body: refreshTokenParams.toString()
                });

                logger.debug(`Revoked Twitter tokens for user ${userId}`);
            } else if (isTokenExpired) {
                logger.debug(`Skipping token revocation for user ${userId} - tokens are already expired`);
            }

            // 3. Always attempt to delete the record
            // QuestDB 6.0+ supports DELETE with WHERE clause
            const updateQuery = `
                    UPDATE twitter_auth 
                    SET 
                        access_token = NULL, 
                        refresh_token = NULL, 
                        expires_at = '1970-01-01T00:00:00Z'::TIMESTAMP,
                        scope = NULL
                    WHERE id = '${userId}';
                    `;
            await questdbService.query(updateQuery);
            logger.info(`Successfully logged out and removed Twitter auth for user ${userId}`);

            return true;
        } catch (error) {
            logger.error(`Error during Twitter logout for user ${userId}:`, error);

            // Even if there was an error, try to clean up the database record
            try {
                // QuestDB 6.0+ supports DELETE with WHERE clause
                const updateQuery = `
  UPDATE twitter_auth 
  SET 
    access_token = NULL, 
    refresh_token = NULL, 
    expires_at = '1970-01-01T00:00:00Z'::TIMESTAMP,
    scope = NULL
    WHERE id = '${userId}';
`;
                await questdbService.query(updateQuery);
                logger.info(`Cleaned up Twitter auth record for user ${userId} after error`);
            } catch (dbError) {
                logger.error(`Failed to clean up Twitter auth record for user ${userId}:`, dbError);
            }

            return false;
        }
    }
}




export const twitterService = new TwitterService();