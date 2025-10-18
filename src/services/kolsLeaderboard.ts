import { chainInsightService } from './chainInsightService';
import { questdbService } from './questDbService';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { KolLeaderboardResponse } from '../models/kols.types';
import type { QueryResult } from '../models/db.types';

export class KolService {
    async getLeaderboards(contractAddress: string, chain: 'Solana' = 'Solana'): Promise<KolLeaderboardResponse> {
        // DB-first: Aggregate from kol_trades
        const sql = `
      SELECT kolId, action, COUNT(*) as count, SUM(amount) as totalAmount
      FROM kol_trades
      WHERE contract = '${contractAddress}' AND chain = '${chain}'
      GROUP BY kolId, action
      ORDER BY count DESC
      LIMIT 20;
    `;
        const res: QueryResult = await questdbService.query(sql);
        if (res.rows.length > 0) {
            const buyers = res.rows.filter(row => row[1] === 'buy');
            const sellers = res.rows.filter(row => row[1] === 'sell');
            logger.info(`DB cache hit for KOL leaderboards: ${buyers.length} buyers, ${sellers.length} sellers`);
            return {
                buyerCount: buyers.length,
                sellerCount: sellers.length,
                tradeStatList: res.rows.map(row => ({
                    kolName: `KOL_${row[0]}`, // TODO: Enhance with real KOL lookup
                    action: row[1] as 'buy' | 'sell',
                    amount: row[3] as number
                }))
            };
        }

        // Fallback to API
        const apiData = await chainInsightService.post(config.baseUrls.kolAnalysis, { contractAddress }) as KolLeaderboardResponse;

        // Parse and insert trades to DB (assuming API structure)
        const trades: Array<Record<string, any>> = (apiData.tradeStatList || []).map(stat => ({
            timestamp: Date.now(),
            kolId: parseInt(stat.kolName.replace(/[^0-9]/g, '') || '0'), // Extract ID from name
            contract: contractAddress,
            action: stat.action,
            amount: stat.amount || 0,
            chain
        }));
        if (trades.length > 0) {
            await questdbService.insertBatch('kol_trades', trades);
        }

        return apiData;
    }

    // Global leaderboards: Top KOLs by buy count
    async getGlobalLeaderboards(chain: string, limit: number = 50): Promise<KolLeaderboardResponse[]> {
        const sql = `
      SELECT kolId, COUNT(*) as buys, SUM(amount) as totalBuys
      FROM kol_trades
      WHERE chain = '${chain}' AND action = 'buy'
      GROUP BY kolId
      ORDER BY buys DESC
      LIMIT ${limit};
    `;
        const res: QueryResult = await questdbService.query(sql);
        return res.rows.map(row => ({
            buyerCount: row[1] as number,
            sellerCount: 0,
            tradeStatList: [{
                kolName: `KOL_${row[0]}`,
                action: 'buy',
                amount: row[2] as number
            }]
        }));
    }
}