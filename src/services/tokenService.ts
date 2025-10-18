import { chainInsightService } from './chainInsightService';
import { questdbService } from './questDbService';
import { kafkaService } from './kafka.service';
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

        await kafkaService.connect();
        const recentTrades = await this.getRecentKolTradesFromKafka(contractAddress, chain);

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

        const enrichedCommunity = {
            ...community,
            kolCallInfo: {  // Proxy/add from Kafka trades
                kolCalls: recentTrades.slice(0, 5).map(trade => ({
                    kolName: trade.kolName || `KOL_${trade.kolId}`,
                    action: trade.action,
                    amount: trade.amount,
                    timestamp: trade.timestamp
                })),
                mentionUserCount: recentTrades.length
            }
        };

        const fullData: TokenInfoResponse = {
            narrative: { narrative: chain === 'Solana' ? narrativeArr[0] : 'N/A (Solana-only)' },
            community: enrichedCommunity,
            calls
        };

        await questdbService.insertBatch('token_info', [{
            timestamp: Date.now(),
            contract: contractAddress,
            data: JSON.stringify(fullData),
            chain
        }]);

        await kafkaService.disconnect();

        return fullData;
    }

    private async getRecentKolTradesFromKafka(contractAddress: string, chain: string): Promise<any[]> {
        const sql = `
      SELECT kolId, action, amount, timestamp
      FROM kol_trades
      WHERE contract = '${contractAddress}' AND chain = '${chain}'
      ORDER BY timestamp DESC
      LIMIT 10;
    `;
        const res = await questdbService.query(sql);
        return res.rows.map(row => ({
            kolId: row[0],
            kolName: `KOL_${row[0]}`, // Enhance with lookup if needed
            action: row[1],
            amount: row[2],
            timestamp: row[3].getTime()
        }));
    }
}