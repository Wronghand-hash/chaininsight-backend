import { chainInsightService } from './chainInsightService';
import { questdbService } from './questDbService';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { TokenInfoResponse } from '../models/token.types';

export class TokenService {
    async getTokenInfo(contractAddress: string, chain: 'BSC' | 'Solana' = 'BSC'): Promise<TokenInfoResponse> {
        // DB-first: Latest within 1h
        const cache = await questdbService.getLatest(
            'token_info',
            `contract = '${contractAddress}' AND chain = '${chain}' AND timestamp > dateadd('h', -1, now())`
        );
        if (cache) {
            const data = JSON.parse(cache[2] as string);
            logger.info(`DB cache hit for token info: ${contractAddress} on ${chain}`);
            return data as TokenInfoResponse;
        }

        // Parallel API calls (narrative only for Solana)
        const apiCalls = [
            chainInsightService.post(config.baseUrls.community, { contractAddress, chain }),
            chainInsightService.post(config.baseUrls.callChannel, { contractAddress, chain })
        ];

        if (chain === 'Solana') {
            apiCalls.push(chainInsightService.post(config.baseUrls.narration, { contractAddress, chain }));
        } else {
            logger.warn(`Narrative skipped for ${chain} chain (Solana-only)`);
        }

        const [community, calls, ...narrativeArr] = await Promise.all(apiCalls);
        const fullData: TokenInfoResponse = {
            narrative: { narrative: chain === 'Solana' ? narrativeArr[0] : 'N/A (Solana-only)' },  // Fallback
            community,
            calls
        };

        // Insert to DB
        await questdbService.insertBatch('token_info', [{
            timestamp: Date.now(),
            contract: contractAddress,
            data: JSON.stringify(fullData),
            chain
        }]);

        return fullData;
    }
}