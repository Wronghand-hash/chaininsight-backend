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
}

export const twitterService = new TwitterService();