import axios from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { PriceResponse, HistoricalPrice } from '../models/token.types';
import type { QueryResult } from '../models/db.types';
import { questdbService } from './questDbService';

export class PriceService {
    async getRealTimePrice(contractAddress: string, chain: 'Solana' | 'BSC' = 'Solana'): Promise<PriceResponse> {
        try {
            const response = await axios.get(`${config.baseUrls.dexscreener}${contractAddress}`);
            const pair = response.data.pairs?.[0];
            if (!pair) throw new Error('No pair data');

            const priceData: PriceResponse = {
                priceUsd: pair.priceUsd || '0',
                priceChange: pair.priceChange?.h24 || 0,
                volume: parseFloat(pair.volume?.h24 || '0'),
                timestamp: Date.now()
            };

            await questdbService.insertBatch('prices', [{
                timestamp: priceData.timestamp,
                contract: contractAddress,
                priceUsd: parseFloat(priceData.priceUsd),
                volume: priceData.volume,
                chain
            }]);

            logger.info(`DexScreener price for ${contractAddress}: ${priceData.priceUsd}`);
            return priceData;
        } catch (error) {
            logger.error(`Price fetch failed for ${contractAddress}`, error);
            throw new Error('Failed to fetch real-time price from DexScreener');
        }
    }

    async getHistoricalPrices(contract: string, chain: string, limit: number = 100): Promise<HistoricalPrice[]> {
        const sql = `
      SELECT timestamp, priceUsd, volume
      FROM prices
      WHERE contract = '${contract}' AND chain = '${chain}'
      ORDER BY timestamp DESC
      LIMIT ${limit};
    `;
        const res: QueryResult = await questdbService.query(sql);
        return res.rows.map(row => ({
            priceUsd: (row[1] as number).toString(),
            priceChange: 0,
            volume: row[2] as number,
            timestamp: new Date(row[0] as Date).getTime()
        }));
    }
}