import { QueryResult } from "pg";
import { TableRow } from "../../models/db.types";
import { questdbService } from "../../services/questDbService";
import { logger } from "../../utils/logger";

enum Chain {
    BSC = 'BSC',
    ETH = 'ETH',
    SOL = 'SOL',
}

type TimePeriod = '1h' | '24h' | '1w' | 'all';

interface KolInfo {
    id: string;
    name: string;
    avatar: string;
}

interface TopToken {
    contract: string;
    tokenName: string;
    chain: Chain;
    uniqueKolCount: number;
    buyerKolCount: number;
    sellerKolCount: number;
    latestTimestamp: string;
    tradeCount: number;
    totalBoughtAmount: number;
    totalSoldAmount: number;
}

export class KolTradeService {
    private initialized = false;
    private initPromise?: Promise<void>;

    async init(): Promise<void> {
        if (this.initialized) {
            logger.debug('KolTradeService already initialized, skipping re-init');
            return;
        }

        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async () => {
            try {
                await questdbService.init();
                this.initialized = true;
                logger.info('✅ KolTradeService initialized successfully');
            } catch (error) {
                logger.error('❌ KolTradeService initialization failed', error);
                throw error;
            }
        })();

        return this.initPromise;
    }

    private ensureInit(): void {
        if (!this.initialized) {
            throw new Error('KolTradeService not initialized — call await kolTradeService.init() before using it.');
        }
    }

    private getTimeFilter(period: TimePeriod): string {
        switch (period) {
            case '1h':
                return `timestamp > dateadd('h', -1, now())`;
            case '24h':
                return `timestamp > dateadd('h', -24, now())`;
            case '1w':
                return `timestamp > dateadd('d', -7, now())`;
            case 'all':
                return '1=1';
            default:
                throw new Error(`Unsupported period: ${period}`);
        }
    }

    private parseAmount(col: string): string {
        return `
          CASE
            WHEN upper(${col}) LIKE '%M' THEN CAST(substring(${col}, 1, length(${col}) - 1) AS DOUBLE) * 1000000.0
            WHEN upper(${col}) LIKE '%K' THEN CAST(substring(${col}, 1, length(${col}) - 1) AS DOUBLE) * 1000.0
            ELSE CAST(COALESCE(${col}, '0') AS DOUBLE)
          END
        `;
    }

    /**
     * Get top tokens by KOL activity
     * @param period Time period to analyze
     * @param limit Maximum number of tokens to return
     * @param chain Optional chain filter
     * @returns Array of TopToken objects
     */

    async getTopTokensByKolActivity(
        period: TimePeriod,
        limit: number = 10,
        chain?: Chain
    ): Promise<TopToken[]> {
        this.ensureInit();

        const chainFilter = chain ? `AND chain = '${chain}'` : '';
        const timeFilter = this.getTimeFilter(period);
        const whereClause = `${timeFilter} ${chainFilter}`.trim();
        const wbnb = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
        const lowerWbnb = wbnb.toLowerCase();
        const isBuyCond = `lower(fromTokenAddress) = '${lowerWbnb}'`;
        const contractExpr = `CASE WHEN ${isBuyCond} THEN toTokenAddress ELSE fromTokenAddress END`;
        const tokenNameExpr = `CASE WHEN ${isBuyCond} THEN toToken ELSE fromToken END`;
        const parseToCount = this.parseAmount('toTokenCount');
        const parseFromCount = this.parseAmount('fromTokenCount');

        const sql = `
    SELECT 
        ${contractExpr} AS contract,
        ${tokenNameExpr} AS token_name,
        chain,
        COUNT(DISTINCT kolId) AS unique_kol_count,
        COUNT(DISTINCT CASE WHEN ${isBuyCond} THEN kolId END) AS buyer_kol_count,
        COUNT(DISTINCT CASE WHEN NOT ${isBuyCond} THEN kolId END) AS seller_kol_count,
        MAX(timestamp) AS latest_timestamp,
        COUNT(*) AS trade_count,
        SUM(CASE WHEN ${isBuyCond} THEN ${parseToCount} ELSE 0.0 END) AS total_bought_amount,
        SUM(CASE WHEN NOT ${isBuyCond} THEN ${parseFromCount} ELSE 0.0 END) AS total_sold_amount
    FROM kol_trades
    WHERE ${whereClause}
    GROUP BY 
        ${contractExpr}, 
        ${tokenNameExpr},
        chain
    ORDER BY unique_kol_count DESC
    LIMIT ${limit};
        `;

        try {
            const result: any = await questdbService.query(sql);
            const tokens: TopToken[] = result.rows.map((row: any) => ({
                contract: String(row[0]).toLowerCase(),
                tokenName: String(row[1]),
                chain: row[2] as Chain,
                uniqueKolCount: Number(row[3] || 0),
                buyerKolCount: Number(row[4] || 0),
                sellerKolCount: Number(row[5] || 0),
                latestTimestamp: String(row[6]),
                tradeCount: Number(row[7] || 0),
                totalBoughtAmount: Number(row[8] || 0),
                totalSoldAmount: Number(row[9] || 0)
            }));

            logger.info(`Retrieved top ${tokens.length} tokens for ${period}${chain ? ` on ${chain}` : ''}`);
            if (tokens.length > 0) {
                logger.info(`Top token: ${tokens[0].contract} - uniqueKOLs=${tokens[0].uniqueKolCount}, trades=${tokens[0].tradeCount}`);
            }
            return tokens;
        } catch (error: any) {
            logger.error('❌ Failed to fetch top tokens', { error: error.message, sql });
            throw error;
        }
    }

    async close(): Promise<void> {
        this.initialized = false;
        this.initPromise = undefined;
        logger.info('🔒 KolTradeService closed');
    }
}

export const kolTradeService = new KolTradeService();