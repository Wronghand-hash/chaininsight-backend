// twitterService.ts
import { TwitterApi } from 'twitter-api-v2';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { redis } from '../utils/redisHelper';

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

    async generateLoginUrl(redirectUri: string, scopes: string[] = ['users.read', 'tweet.read']): Promise<{ url: string; state: string; codeVerifier: string; codeChallenge: string }> {
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

    async handleLoginCallback(code: string, codeVerifier: string, state: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number; scope: string; username?: string }> {
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
            logger.debug('handleLoginCallback: Token exchange successful, expiresIn:', expiresIn, 'scope:', scope);

            // Get user info
            const userClient = new TwitterApi(accessToken);
            const { data: userData } = await userClient.v2.me({ 'user.fields': 'username' });
            logger.info(`Twitter login successful for user: @${userData.username}`);

            return {
                accessToken,
                refreshToken,
                expiresIn,
                scope: Array.isArray(scope) ? scope.join(' ') : scope,
                username: userData.username,
            };
        } catch (err: any) {
            logger.error(`Failed to handle Twitter login callback: ${err.code || 'Unknown error'} - ${err.message}`, err);
            throw err;
        }
    }
}

export const twitterService = new TwitterService();