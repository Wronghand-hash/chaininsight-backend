import { chainInsightService } from './chainInsightService';
import { questdbService } from './questDbService';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { SecurityCheckResponse } from '../models/security.types';

export class SecurityService {
    async checkSecurity(walletAddresses: string[], chain: 'Solana' = 'Solana'): Promise<SecurityCheckResponse> {
        const cachedTags: any[] = [];
        const uncachedAddresses: string[] = [];

        // Check cache per address (24h TTL)
        for (const addr of walletAddresses) {
            const cache = await questdbService.getLatest(
                'security_labels',
                `address = '${addr}' AND chain = '${chain}' AND timestamp > dateadd('h', -24, now())`
            );
            if (cache) {
                cachedTags.push(JSON.parse(cache[2] as string));
            } else {
                uncachedAddresses.push(addr);
            }
        }

        let apiData: SecurityCheckResponse | undefined;
        if (uncachedAddresses.length > 0) {
            const data = { chain, walletAddresses: uncachedAddresses };
            apiData = await chainInsightService.post(config.baseUrls.walletTags, data) as SecurityCheckResponse;

            // Insert uncached
            const inserts = apiData.walletTags.map(tag => ({
                timestamp: Date.now(),
                address: tag.address,
                data: JSON.stringify(tag),
                chain
            }));
            if (inserts.length > 0) {
                await questdbService.insertBatch('security_labels', inserts);
            }
        }

        // Merge
        const finalTags = uncachedAddresses.length > 0
            ? [...cachedTags, ...apiData!.walletTags]
            : cachedTags;
        const responseChain = apiData?.chain || chain;

        logger.info(`Security check: ${cachedTags.length} cached, ${uncachedAddresses.length} API calls for ${walletAddresses.length} addresses`);
        return { chain: responseChain, walletTags: finalTags };
    }
}