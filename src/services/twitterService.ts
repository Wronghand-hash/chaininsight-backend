// twitterService.ts
import { TwitterApi } from 'twitter-api-v2';
import { logger } from '../utils/logger';
import { config } from '../utils/config';

class TwitterService {
    private client: TwitterApi | null = null;
    private initialized = false;

    async init() {
        if (this.initialized) return;
        if (!config.twitter?.appKey || !config.twitter?.appSecret || !config.twitter?.accessToken || !config.twitter?.accessSecret) {
            logger.error('TwitterService: Missing required credentials (need appKey, appSecret, accessToken, accessSecret)');
            this.initialized = false;
            return;
        }
        try {
            this.client = new TwitterApi({
                appKey: config.twitter.appKey,
                appSecret: config.twitter.appSecret,
                accessToken: config.twitter.accessToken,
                accessSecret: config.twitter.accessSecret,
            });
            // Verify credentials by making a simple call
            const user = await this.client.v2.me({ 'user.fields': 'username' });
            logger.info(`TwitterService initialized successfully for user: @${user.data.username}`);
            this.initialized = true;
        } catch (err: any) {
            logger.error(`Failed to initialize TwitterService: ${err.code || 'Unknown error'} - ${err.message}`, err);
            this.initialized = false;
        }
    }

    async postTweet(text: string): Promise<boolean> {
        if (!this.initialized || !this.client) {
            logger.warn('TwitterService not initialized, skipping tweet');
            return false;
        }
        try {
            // Ensure text is within 280 chars
            const truncatedText = text.length > 280 ? text.substring(0, 277) + '...' : text;
            await this.client.v2.tweet(truncatedText);
            logger.info(`Tweet posted: ${truncatedText}`);
            return true;
        } catch (err: any) {
            logger.error(`Failed to post tweet: ${err.code || 'Unknown error'} - ${err.message}`, err);
            return false;
        }
    }

    generateLoginUrl(redirectUri: string, scopes: string[] = ['users.read', 'tweet.read', 'tweet.write', 'offline.access']): { url: string; state: string; codeVerifier: string; codeChallenge: string } {
        if (!config.twitter?.appKey) {
            throw new Error('Twitter appKey is required for OAuth2 login');
        }
        const client = new TwitterApi({
            clientId: config.twitter.appKey,
        });
        const { url, state, codeVerifier, codeChallenge } = client.generateOAuth2AuthLink(redirectUri, {
            scope: scopes.join(' '),
        });
        return { url, state, codeVerifier, codeChallenge };
    }

    async handleLoginCallback(code: string, codeVerifier: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number; scope: string; username?: string }> {
        if (!config.twitter?.appKey || !config.twitter?.appSecret) {
            throw new Error('Twitter appKey and appSecret are required for token exchange');
        }
        try {
            const appClient = new TwitterApi({
                clientId: config.twitter.appKey,
                clientSecret: config.twitter.appSecret,
            });
            const tokenData = await appClient.loginWithOAuth2({
                code,
                codeVerifier,
                redirectUri,
            });
            const { accessToken, refreshToken, expiresIn, scope } = tokenData;

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