// TokenService.ts (Updated with Honeypot API integration and GoPlus Labs security integration)

import { config } from '../utils/config';
import { chainInsightService } from './chainInsightService';
import { questdbService } from './questDbService';

type Chain = 'BSC' | 'ETH' | 'SOL';
type ChainId = 1 | 56 | 137; // ETH:1, BSC:56, Polygon:137 (SOL not directly supported by Honeypot; adjust as needed)
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
    pairs?: any[]; // NEW: Array of pair objects from Honeypot API
    honeypot?: any; // NEW: Honeypot analysis result
    goplusSecurity?: any; // NEW: GoPlus Labs security analysis result
};
const logger = { info: console.log, warn: console.warn };

/**
 * The API-KEY is extracted directly from the provided config.
 */
const API_KEY = config.apiKey;

// Chain to ChainID mapping for Honeypot API (SOL omitted; fallback or error if unsupported)
const getChainId = (chain: Chain): ChainId => {
    switch (chain) {
        case 'BSC': return 56;
        case 'ETH': return 1;
        // case 'SOL': return undefined; // Honeypot doesn't support SOL; handle as needed
        default: throw new Error(`Unsupported chain: ${chain}`);
    }
};

export class TokenService {
    /**
     * Fetches complete token information by making parallel, direct API calls 
     * to the ChainInsight service, ensuring the required API-KEY is included in headers.
     * * NOTE: We are using the specific, correct full URLs from config.baseUrls 
     * * instead of relying on the potentially incorrect config.ENDPOINTS.
     * * NEW: Added parallel fetch to Honeypot API for liquidity pairs data.
     * * NEW: Added sequential fetch to Honeypot IsHoneypot API using the primary pair from GetPairs.
     * * NEW: Added parallel fetch to GoPlus Labs API for token security analysis.
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

        // --- NEW: Honeypot API Call for Pairs/Liquidity ---
        const chainId = getChainId(chain);
        const pairsUrl = `https://api.honeypot.is/v1/GetPairs?address=${contractAddress}&chainID=${chainId}`;
        logger.info(`[DEBUG] Preparing GET Request for HONEYPOT PAIRS:`);
        logger.info(` 	URL: ${pairsUrl}`);

        const pairsPromise = fetch(pairsUrl, {
            credentials: 'omit',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.5',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-site'
            },
            referrer: 'https://honeypot.is/',
            method: 'GET',
            mode: 'cors'
        }).then(response => {
            if (!response.ok) {
                throw new Error(`Honeypot API error: ${response.status}`);
            }
            return response.json();
        }).catch(error => {
            logger.warn(`Honeypot API fetch failed for ${contractAddress}:`, error);
            return []; // Graceful fallback: empty array on failure
        });

        // --- NEW: GoPlus Labs API Call for Token Security ---
        const goplusUrl = `https://open-api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${contractAddress}`;
        logger.info(`[DEBUG] Preparing GET Request for GOPLUS SECURITY:`);
        logger.info(` 	URL: ${goplusUrl}`);

        const goplusPromise = fetch(goplusUrl, {
            credentials: 'omit',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.5',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-site'
            },
            referrer: 'https://gopluslabs.io/',
            method: 'GET',
            mode: 'cors'
        }).then(response => {
            if (!response.ok) {
                throw new Error(`GoPlus Labs API error: ${response.status}`);
            }
            return response.json();
        }).catch(error => {
            logger.warn(`GoPlus Labs API fetch failed for ${contractAddress}:`, error);
            return { code: 0, message: 'Error', result: {} }; // Graceful fallback: empty result on failure
        });

        const apiCalls: Promise<any>[] = [
            communityPromise,
            callsPromise,
            kolTradePromise,
            narrativePromise,
            pairsPromise, // Add pairsPromise to parallel execution
            goplusPromise // Add goplusPromise to parallel execution
        ];

        logger.info('Initiating parallel API calls...');

        // 4. Execute Parallel Requests and Destructure Results
        const [
            communityResponse,
            callsResponse,
            kolTradeResponse,
            narrativeResponse,
            pairsData,
            goplusResponse
        ] = await Promise.all(apiCalls);

        logger.info('All API calls resolved.');

        // Extract GoPlus security data (lowercase contract address in result)
        let goplusData: any = null;
        if (goplusResponse && goplusResponse.code === 1 && goplusResponse.result) {
            const lowerCaseAddress = contractAddress.toLowerCase();
            goplusData = goplusResponse.result[lowerCaseAddress];
            logger.info(`GoPlus security fetched for ${contractAddress}: is_honeypot=${goplusData?.is_honeypot}`);
        } else {
            logger.warn(`GoPlus Labs API did not return valid data for ${contractAddress}`);
        }

        // --- NEW: Honeypot IsHoneypot API Call (sequential, depends on pairsData) ---
        let honeypotData: any = null;
        if (pairsData && Array.isArray(pairsData) && pairsData.length > 0) {
            // Use the first pair as primary based on the actual response structure
            const primaryPairAddress = pairsData[0]?.Pair?.Address;
            if (primaryPairAddress) {
                const honeypotUrl = `https://api.honeypot.is/v2/IsHoneypot?address=${contractAddress}&pair=${primaryPairAddress}&chainID=${chainId}`;
                logger.info(`[DEBUG] Preparing GET Request for HONEYPOT ISHONEYPOT:`);
                logger.info(` 	URL: ${honeypotUrl}`);

                try {
                    const honeypotResponse = await fetch(honeypotUrl, {
                        credentials: 'omit',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
                            'Accept': '*/*',
                            'Accept-Language': 'en-US,en;q=0.5',
                            'Sec-Fetch-Dest': 'empty',
                            'Sec-Fetch-Mode': 'cors',
                            'Sec-Fetch-Site': 'same-site'
                        },
                        referrer: 'https://honeypot.is/',
                        method: 'GET',
                        mode: 'cors'
                    });

                    if (!honeypotResponse.ok) {
                        throw new Error(`Honeypot IsHoneypot API error: ${honeypotResponse.status}`);
                    }

                    honeypotData = await honeypotResponse.json();
                    logger.info(`Honeypot analysis fetched for ${contractAddress}: isHoneypot=${honeypotData?.honeypotResult?.isHoneypot}`);
                } catch (error) {
                    logger.warn(`Honeypot IsHoneypot API fetch failed for ${contractAddress}:`, error);
                    honeypotData = null; // Graceful fallback
                }
            } else {
                logger.warn(`No valid primary pair address found in pairsData for ${contractAddress}`);
            }
        } else {
            logger.warn(`No pairs data available for Honeypot analysis on ${contractAddress}`);
        }
        // --- END NEW SECTION ---

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
            calls: callsResponse,
            pairs: pairsData,
            honeypot: honeypotData,
            goplusSecurity: goplusData
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