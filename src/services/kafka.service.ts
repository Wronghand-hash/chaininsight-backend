import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import { questdbService } from './questDbService';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';
dotenv.config();

const kafkaBrokerUrl = process.env.KAFKA_BROKER_URL;

const kafka = new Kafka({
    clientId: 'chaininsight-consumer',
    brokers: [kafkaBrokerUrl!]
});

const consumer: Consumer = kafka.consumer({
    groupId: process.env.KAFKA_GROUP_ID || 'Greez'
});

const processedTxCache: Map<string, number> = new Map();
const DUP_TTL_MS = 5 * 60 * 1000;
const pruneProcessedTxCache = () => {
    const now = Date.now();
    for (const [tx, ts] of processedTxCache) {
        if (now - ts > DUP_TTL_MS) processedTxCache.delete(tx);
    }
    if (processedTxCache.size > 10000) {
        let removed = 0;
        for (const key of processedTxCache.keys()) {
            processedTxCache.delete(key);
            if (++removed >= 1000) break;
        }
    }
};

// Define the mapping for actionType
const ACTION_TYPE_MAP: { [key: string]: string } = {
    '0': 'default',
    '1': 'initial_position',
    '2': 'add_position',
    '3': 'partial_sell',
    '4': 'full_sell'
};

/**
 * Parses numeric strings, including those with K/M suffixes and scientific notation (like 0.000001).
 * Assumes input is in milliseconds; returns milliseconds as number.
 * @param str The string value to parse.
 * @returns The parsed number in milliseconds or Date.now() if parsing fails.
 */
const parseNumericValue = (str: string | undefined): number => {
    if (!str || typeof str !== 'string') return Date.now();

    // Handle price strings like "0.0₄5643" (0.00005643) by replacing the subscript number
    const scientificMatch = str.match(/0\.0(\d+)([a-zA-Z\d\.]+)/);
    if (scientificMatch) {
        const zeros = parseInt(scientificMatch[1], 10);
        const value = parseFloat(`0.${'0'.repeat(zeros)}${scientificMatch[2]}`);
        if (!isNaN(value)) return value * 1000; // But this is for price, not timestamp; adjust if needed
    }

    // Handle K/M suffixes (unlikely for timestamps, but kept for compatibility)
    let numStr = str.replace(/[^eE\d.]/g, ''); // Clean non-numeric, non-dot, non-E/e characters
    let num = parseFloat(numStr);

    if (str.toUpperCase().includes('M')) num *= 1e6;
    else if (str.toUpperCase().includes('K')) num *= 1e3;

    const parsed = isNaN(num) ? Date.now() : num;
    // Detect if input looks like seconds (small number < 1e10) vs ms (>1e10), but assume ms as per fallback
    return parsed < 1e10 ? parsed * 1000 : parsed; // Heuristic: if <10 digits, treat as seconds and convert to ms
};

export class KafkaService {
    async connect() {
        await consumer.connect();
        await consumer.subscribe({ topic: 'prod-tob-kol-transaction-update', fromBeginning: false });
        logger.info('Kafka consumer connected to ChainInsight (43.134.238.235:32777)');
    }

    async consume() {
        await consumer.run({
            eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
                try {
                    pruneProcessedTxCache();
                    const rawValue = message.value?.toString();
                    if (!rawValue) {
                        logger.warn('Empty Kafka message - skipping');
                        return;
                    }

                    let tradeData;
                    try {
                        tradeData = JSON.parse(rawValue);
                    } catch (parseError) {
                        logger.warn(`Invalid JSON in Kafka message (offset ${message.offset}): ${rawValue.slice(0, 100)}... - skipping`);
                        return;
                    }

                    // Process each item in data array (batches)
                    for (const trade of tradeData.data || []) {

                        const txHash = String(trade.transactionHash || '');

                        // Check for required field: Transaction Hash is critical for deduplication
                        if (!txHash) {
                            logger.warn('Missing transactionHash in trade data - skipping');
                            continue;
                        }

                        const now = Date.now();
                        const lastSeen = processedTxCache.get(txHash);
                        if (lastSeen && now - lastSeen < DUP_TTL_MS) {
                            logger.debug(`⏩ Skipping duplicate tx ${txHash}`);
                            continue;
                        }

                        // === Data Parsing and Assignment ===
                        // FIX: Parse to ms, then convert to ISO string for QuestDB
                        const timestampMs = parseNumericValue(trade.createTime || String(Date.now()));
                        const timestampIso = new Date(timestampMs).toISOString();

                        const kolId = String(trade.kol?.id || '');
                        const kolName = String(trade.kol?.name || '');
                        const kolAvatar = String(trade.kol?.avatar || '');
                        const kolTwitterId = String(trade.kol?.twitterId || '');

                        const actionTypeKey = String(trade.actionType || '0');
                        const action = ACTION_TYPE_MAP[actionTypeKey] || 'unknown';

                        // Amount is the count of the token being received (toTokenCount)
                        const amount = String(trade.toTokenCount ?? '');

                        const contract = String(trade.toTokenAddress || '');
                        const chain = String(trade.chainName || 'BSC').toUpperCase(); // Normalise chain name

                        // NEW: Price/Value Fields
                        const usdtPrice = String(trade.usdtPrice ?? '');
                        const initialPrice = String(trade.initialPrice ?? '');

                        const fromToken = String(trade.fromToken || '');
                        const fromTokenAddress = String(trade.fromTokenAddress || '');
                        const fromTokenCount = String(trade.fromTokenCount ?? '');


                        const toToken = String(trade.toToken || '');
                        const toTokenAddress = String(trade.toTokenAddress || '');
                        const toTokenRemainCount = String(trade.toTokenRemainCount ?? '');
                        const walletType = trade.walletType;

                        const recentBuyerKols = JSON.stringify(trade.recentBuyerKols || []);
                        const recentSellerKols = JSON.stringify(trade.recentSellerKols || []);

                        // === Filtering and Insertion Logic ===

                        if (chain !== 'BSC') {
                            logger.debug(`⏩ Skipping trade from non-BSC chain: ${chain}`);
                            continue;
                        }

                        console.log(trade, "trade"
                        );

                        logger.info(`✅ Processing BSC trade for QuestDB: ${kolName} ${action} ${amount} of ${contract} (${usdtPrice} USDT) at ${timestampIso}`);

                        // NOTE ON DUPLICATES: 
                        // The primary key for 'kol_trades' should ideally be (txHash, timestamp) 
                        // in QuestDB to prevent duplicates, or use an UPSERT method.
                        // We are relying on the database layer to handle the deduplication 
                        // since we have a unique txHash.

                        await questdbService.insertBatch('kol_trades', [{
                            timestamp: timestampIso,  // Now ISO string
                            kolId,
                            kolName,
                            kolAvatar,
                            kolTwitterId,
                            contract,
                            action,
                            amount,
                            usdtPrice,
                            initialPrice,
                            txHash,
                            fromToken,
                            fromTokenAddress,
                            fromTokenCount,
                            toToken,
                            toTokenAddress,
                            toTokenCount: amount,
                            toTokenRemainCount,
                            walletType,
                            recentBuyerKols,
                            recentSellerKols,
                            chain
                        }]);

                        // Mark as processed only after successful insert
                        processedTxCache.set(txHash, now);
                    }
                } catch (error) {
                    logger.error(`Kafka message processing failed (offset ${message.offset}):`, error);
                }
            }
        });
    }

    async disconnect() {
        await consumer.disconnect();
        logger.info('Kafka consumer disconnected');
    }
}

export const kafkaService = new KafkaService();