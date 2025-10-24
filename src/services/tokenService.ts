import { TokenInfoResponse } from '../models/token.types';
import { config } from '../utils/config';
import { chainInsightService } from './chainInsightService';
import { questdbService } from './questDbService';

type Chain = 'BSC'
type ChainId = 56
type RequestOptions = {
    headers: {
        'API-KEY': string;
        'Content-Type': string;
    }
};

const logger = { info: console.log, warn: console.warn };

const API_KEY = config.apiKey;

const getChainId = (chain: Chain): ChainId => {
    switch (chain) {
        case 'BSC': return 56;
        default: throw new Error(`Unsupported chain: ${chain}`);
    }
};

export class TokenService {
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
            return chainInsightService.post(fullUrl, body);
        };

        // Use the correct, specific full URLs from config.baseUrls
        const communityPromise = createLoggedPost(config.baseUrls.community, 'COMMUNITY', postBody, requestOptions);
        const callsPromise = createLoggedPost(config.baseUrls.callChannel, 'CALL_CHANNEL', postBody, requestOptions);

        const kolTradePromise = createLoggedPost(config.baseUrls.kolAnalysis, 'KOL_TRADES', postBody, requestOptions);

        const narrativePromise = createLoggedPost(config.baseUrls.narration, 'NARRATION', postBody, requestOptions);

        // --- NEW: Honeypot API Call for Pairs/Liquidity ---
        const chainId = getChainId(chain);
        const pairsUrl = `https://api.honeypot.is/v1/GetPairs?address=${contractAddress}&chainID=${chainId}`;
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

        const dexscreenerPromise = fetch(`${config.baseUrls.dexscreener}${contractAddress}`, {
            method: 'GET'
        }).then(async (res) => {
            if (!res.ok) throw new Error(`Dexscreener error: ${res.status}`);
            const json = await res.json();

            return json;
        }).catch((err) => {
            logger.warn(`Dexscreener fetch failed for ${contractAddress}:`, err);
            return null;
        });

        const apiCalls: Promise<any>[] = [
            communityPromise,
            callsPromise,
            kolTradePromise,
            narrativePromise,
            pairsPromise,
            goplusPromise,
            dexscreenerPromise
        ];

        logger.info('Initiating parallel API calls...');

        // 4. Execute Parallel Requests and Destructure Results
        const [
            communityResponse,
            callsResponse,
            kolTradeResponse,
            narrativeResponse,
            pairsData,
            goplusResponse,
            dexscreenerResponse
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

        // Honeypot IsHoneypot API Call (sequential, depends on pairsData)
        let honeypotData: any = null;
        if (pairsData && Array.isArray(pairsData) && pairsData.length > 0) {
            // Use the first pair as primary based on the actual response structure
            const primaryPairAddress = pairsData[0]?.Pair?.Address;
            if (primaryPairAddress) {
                const honeypotUrl = `https://api.honeypot.is/v2/IsHoneypot?address=${contractAddress}&pair=${primaryPairAddress}&chainID=${chainId}`;
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

        // 7. SAVE AGGREGATED DATA TO QUESTDB
        try {
            await questdbService.saveTokenMetrics(contractAddress, chain, fullData, dexscreenerResponse);
            logger.info(`Token metrics successfully saved to QuestDB for ${contractAddress}`);
        } catch (dbError) {
            logger.warn(`Failed to save token metrics to QuestDB for ${contractAddress}:`, dbError);
        }

        logger.info('Token info successfully aggregated.');
        return fullData;
    }
}