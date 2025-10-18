import axios from 'axios';
import { config } from '../utils/config';
import { questdbService } from './questDbService';
import { logger } from '../utils/logger';
import type { PriceResponse, HistoricalPrice } from '../models/token.types';
import type { QueryResult } from '../models/db.types';

export class PriceService {
    async getRealTimePrice(contractAddress: string, chain: 'Solana' = 'Solana'): Promise<PriceResponse> {
        // DB-first: Latest within 1min
        const cache = await questdbService.getLatest(
            'prices',
            `contract = '${contractAddress}' AND chain = '${chain}' AND timestamp > dateadd('m', -1, now())`
        );
        if (cache) {
            logger.info(`DB cache hit for price: ${contractAddress}`);
            return {
                priceUsd: (cache[2] as number).toString(),
                priceChange: 0, // TODO: Compute from prev
                volume: cache[3] as number,
                timestamp: new Date(cache[0] as Date).getTime()
            };
        }

        // Fallback to DexScreener
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

            // Insert to DB
            await questdbService.insertBatch('prices', [{
                timestamp: priceData.timestamp,
                contract: contractAddress,
                priceUsd: parseFloat(priceData.priceUsd),
                volume: priceData.volume,
                chain
            }]);

            return priceData;
        } catch (error) {
            logger.error(`Price fetch failed for ${contractAddress}`, error);
            throw new Error('Failed to fetch real-time price');
        }
    }

    // Historical prices query
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
            priceChange: 0, // Derive via subquery if needed
            volume: row[2] as number,
            timestamp: new Date(row[0] as Date).getTime()
        }));
    }
}