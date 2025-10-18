import axios from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { PriceResponse } from '../models/token.types';

export class PriceService {
    async getRealTimePrice(contractAddress: string): Promise<PriceResponse> {
        try {
            const response = await axios.get(`${config.baseUrls.dexscreener}${contractAddress}`);
            const pair = response.data.pairs?.[0];
            if (!pair) throw new Error('No pair data');
            console.log(pair, "pair");

            const priceData: PriceResponse = {
                priceUsd: pair.priceUsd || '0',
                volume: parseFloat(pair.volume?.h24 || '0'),
                marketCap: parseFloat(pair.marketCap || '0'),

            };
            logger.info(`DexScreener price for ${contractAddress}: ${priceData.priceUsd}`);
            return priceData;
        } catch (error) {
            logger.error(`Price fetch failed for ${contractAddress}`, error);
            throw new Error('Failed to fetch real-time price from DexScreener');
        }
    }

}