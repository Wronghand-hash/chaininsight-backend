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
    chain: Chain;
    uniqueKolCount: number;
    buyerKolCount: number;
    sellerKolCount: number;
    recentBuyerKols: KolInfo[];
    recentSellerKols: KolInfo[];
    latestTimestamp: string;
    tradeCount: number;
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

    /**
     * Robust JSON parser for KOL arrays, handling various escaping scenarios from DB.
     */
    private parseKolArray(jsonStr: string): KolInfo[] {
        if (!jsonStr || typeof jsonStr !== 'string') return [];

        let cleaned = jsonStr.trim();

        // Try direct parse first (expected case)
        try {
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed)) {
                return parsed.map((b: any) => ({
                    id: String(b.id || ''),
                    name: String(b.name || ''),
                    avatar: String(b.avatar || '')
                })).filter(kol => kol.id);  // Filter valid
            }
        } catch (e) {
            // Ignore, try alternatives
        }

        // Try unescape triple quotes (CSV-like)
        try {
            cleaned = cleaned.replace(/"""/g, '"');
            const parsed = JSON.parse(cleaned);
            if (typeof parsed === 'string') {
                const doubleParsed = JSON.parse(parsed);
                if (Array.isArray(doubleParsed)) {
                    return doubleParsed.map((b: any) => ({
                        id: String(b.id || ''),
                        name: String(b.name || ''),
                        avatar: String(b.avatar || '')
                    })).filter(kol => kol.id);
                }
            } else if (Array.isArray(parsed)) {
                return parsed.map((b: any) => ({
                    id: String(b.id || ''),
                    name: String(b.name || ''),
                    avatar: String(b.avatar || '')
                })).filter(kol => kol.id);
            }
        } catch (e2) {
            // Ignore
        }

        // Last resort: regex extract (crude, for escaped)
        try {
            const arrayMatch = cleaned.match(/\[([\s\S]*?)\]/);
            if (arrayMatch) {
                const inner = arrayMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\t/g, ' ');
                const parsed = JSON.parse(`[${inner}]`);
                if (Array.isArray(parsed)) {
                    return parsed.map((b: any) => ({
                        id: String(b.id || ''),
                        name: String(b.name || ''),
                        avatar: String(b.avatar || '')
                    })).filter(kol => kol.id);
                }
            }
        } catch (e3) {
            // Final fail
        }

        logger.warn(`Failed to parse KOL JSON: ${jsonStr.slice(0, 200)}...`);
        return [];
    }

    async getTopTokensByKolActivity(
        period: TimePeriod,
        limit: number = 10,
        chain?: Chain
    ): Promise<TopToken[]> {
        this.ensureInit();

        const chainFilter = chain ? `AND chain = '${chain}'` : '';
        const timeFilter = this.getTimeFilter(period);
        const whereClause = `${timeFilter} ${chainFilter}`.trim();
        const countSql = `SELECT count(*) as total FROM kol_trades WHERE ${whereClause};`;
        const sql = `
            SELECT 
                timestamp,
                contract, 
                chain, 
                recentBuyerKols, 
                recentSellerKols
            FROM kol_trades 
            WHERE ${whereClause}
            ORDER BY timestamp DESC;
        `;

        try {
            const countRes: any = await questdbService.query(countSql);
            const matchingCount = countRes.rows[0]?.[0] || 0;
            logger.info(`[DEBUG] Query matches ${matchingCount} rows for ${period}${chain ? ` on ${chain}` : ''}`);

            if (matchingCount === 0) {
                logger.warn(`[DEBUG] No matches - try 'all' or '1w' for older data like 2025-10-19.`);
                return [];
            }

            const result: any = await questdbService.query(sql);
            const rows: any[] = result.rows;

            const contractMap = new Map<string, {
                originalContract: string;
                chain: Chain;
                buyerIds: Set<string>;
                sellerIds: Set<string>;
                buyerKols: KolInfo[];
                sellerKols: KolInfo[];
                latestTimestamp: string;
                tradeCount: number;
            }>();

            let debugRowCount = 0;
            for (const row of rows) {
                const ts = String(row[0]);
                let contract = String(row[1]).toLowerCase();  // Normalize case-insensitive
                const originalContract = String(row[1]);  // Keep original for output
                const chainStr = String(row[2]) as Chain;
                const buyerJson = String(row[3] || '');
                const sellerJson = String(row[4] || '');

                if (!contractMap.has(contract)) {
                    contractMap.set(contract, {
                        originalContract,
                        chain: chainStr,
                        buyerIds: new Set(),
                        sellerIds: new Set(),
                        buyerKols: [],
                        sellerKols: [],
                        latestTimestamp: ts,
                        tradeCount: 0,
                    });
                }

                const agg = contractMap.get(contract)!;
                agg.tradeCount++;
                if (ts > agg.latestTimestamp) {
                    agg.latestTimestamp = ts;
                }

                // Parse buyers
                const buyers = this.parseKolArray(buyerJson);
                for (const b of buyers) {
                    if (b.id && !agg.buyerIds.has(b.id)) {
                        agg.buyerIds.add(b.id);
                        agg.buyerKols.push(b);
                    }
                }

                // Parse sellers
                const sellers = this.parseKolArray(sellerJson);
                for (const s of sellers) {
                    if (s.id && !agg.sellerIds.has(s.id)) {
                        agg.sellerIds.add(s.id);
                        agg.sellerKols.push(s);
                    }
                }

                // Debug first 3 rows
                if (debugRowCount++ < 3) {
                    logger.debug(`[DEBUG] Row sample - Contract: ${contract}, Buyers: ${buyers.length}, Sellers: ${sellers.length}, Buyer raw: ${buyerJson.slice(0, 100)}...`);
                }
            }

            const topTokens: TopToken[] = Array.from(contractMap.values())
                .map(agg => ({
                    contract: agg.originalContract,
                    chain: agg.chain,
                    uniqueKolCount: agg.buyerIds.size + agg.sellerIds.size,
                    buyerKolCount: agg.buyerIds.size,
                    sellerKolCount: agg.sellerIds.size,
                    recentBuyerKols: agg.buyerKols,
                    recentSellerKols: agg.sellerKols,
                    latestTimestamp: agg.latestTimestamp,
                    tradeCount: agg.tradeCount,
                }))
                // Sort: primary uniqueKolCount desc, secondary tradeCount desc
                .sort((a, b) => (b.uniqueKolCount - a.uniqueKolCount) || (b.tradeCount - a.tradeCount))
                .slice(0, limit);

            logger.info(`Retrieved top ${topTokens.length} tokens for ${period}${chain ? ` on ${chain}` : ''}`);
            if (topTokens.length > 0) {
                logger.info(`Top token: ${topTokens[0].contract} - uniqueKOLs=${topTokens[0].uniqueKolCount}, trades=${topTokens[0].tradeCount}`);
            }
            return topTokens;
        } catch (error) {
            logger.error(`❌ Failed to fetch top tokens: ${sql}`, error);
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