// TokenService.ts (No changes needed)

import { config } from '../utils/config';
import { chainInsightService } from './chainInsightService';
import { questdbService } from './questDbService'; // NEW IMPORT

type Chain = 'BSC' | 'ETH' | 'SOL';
type RequestOptions = {
    headers: {
        'API-KEY': string;
        'Content-Type': string;
    }
};
type TokenInfoResponse = {
    narrative: any;
    community: any;
    calls: any;
};
const logger = { info: console.log, warn: console.warn };

/**
 * The API-KEY is extracted directly from the provided config.
 */
const API_KEY = config.apiKey;

export class TokenService {
    /**
     * Fetches complete token information by making parallel, direct API calls 
     * to the ChainInsight service, ensuring the required API-KEY is included in headers.
     * * NOTE: We are using the specific, correct full URLs from config.baseUrls 
     * * instead of relying on the potentially incorrect config.ENDPOINTS.
     */
    async getTokenInfo(contractAddress: string, chain: Chain = 'BSC'): Promise<TokenInfoResponse> {
        logger.info('Starting token info fetch for', contractAddress, 'on', chain);

        // 1. Prepare Request Body
        const postBody = {
            contractAddress,
            chain,
            language: config.DEFAULT_LANGUAGE
        };

        // 2. Prepare Request Headers with API-KEY
        const requestOptions: RequestOptions = {
            headers: {
                'API-KEY': API_KEY,
                'Content-Type': 'application/json'
            }
        };

        // --- 3. Define API Call Promises using specific baseUrls ---

        // Helper function to log and make the POST request
        const createLoggedPost = (fullUrl: string, serviceName: string, body: typeof postBody, options: RequestOptions) => {
            logger.info(`[DEBUG] Preparing POST Request for ${serviceName}:`);
            logger.info(` 	URL: ${fullUrl}`);
            logger.info(` 	Body: ${JSON.stringify(body)}`);
            logger.info(` 	Headers:`, options.headers);

            // The chainInsightService.post must accept the full URL here
            return chainInsightService.post(fullUrl, body);
        };

        // Use the correct, specific full URLs from config.baseUrls
        const communityPromise = createLoggedPost(config.baseUrls.community, 'COMMUNITY', postBody, requestOptions);
        const callsPromise = createLoggedPost(config.baseUrls.callChannel, 'CALL_CHANNEL', postBody, requestOptions);

        // NOTE: KOL_TRADES is named kolAnalysis in config.baseUrls
        const kolTradePromise = createLoggedPost(config.baseUrls.kolAnalysis, 'KOL_TRADES', postBody, requestOptions);

        const narrativePromise = createLoggedPost(config.baseUrls.narration, 'NARRATION', postBody, requestOptions);

        const apiCalls: Promise<any>[] = [
            communityPromise,
            callsPromise,
            kolTradePromise,
            narrativePromise
        ];

        logger.info('Initiating parallel API calls...');

        // 4. Execute Parallel Requests and Destructure Results
        const [
            communityResponse,
            callsResponse,
            kolTradeResponse,
            narrativeResponse
        ] = await Promise.all(apiCalls);

        logger.info('All API calls resolved.');

        // 5. Enrich Community Data with KOL Trade Data
        const enrichedCommunity = {
            ...communityResponse,
            kolCallInfo: {
                // Ensure safe access to nested properties as in the original logic
                kolCalls: kolTradeResponse?.kolCalls || [],
                mentionUserCount: kolTradeResponse?.mentionUserCount || 0
            }
        };

        // 6. Construct Final Response Object
        const fullData: TokenInfoResponse = {
            // Assuming narrativeResponse returns the core data structure needed here
            narrative: { ...narrativeResponse },
            community: enrichedCommunity,
            calls: callsResponse
        };

        // 7. --- NEW: SAVE AGGREGATED DATA TO QUESTDB ---
        try {
            await questdbService.saveTokenMetrics(contractAddress, chain, fullData);
            logger.info(`Token metrics successfully saved to QuestDB for ${contractAddress}`);
        } catch (dbError) {
            logger.warn(`Failed to save token metrics to QuestDB for ${contractAddress}:`, dbError);
            // Non-fatal error: continue execution even if saving to DB fails
        }
        // --- END NEW SECTION ---


        logger.info('Token info successfully aggregated.');
        return fullData;
    }
}