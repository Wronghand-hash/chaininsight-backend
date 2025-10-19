import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import { questdbService } from './questDbService';
import { logger } from '../utils/logger';

const kafka = new Kafka({
    clientId: 'chaininsight-consumer',
    brokers: ['43.134.238.235:32777']
});

const consumer: Consumer = kafka.consumer({
    groupId: process.env.KAFKA_GROUP_ID || 'Greez'
});

// Define the mapping for actionType
const ACTION_TYPE_MAP: { [key: string]: string } = {
    '0': 'default',
    '1': 'buy',
    '2': 'add', // Typically for liquidity
    '3': 'partial_sell',
    '4': 'full_sell'
};

/**
 * Parses numeric strings, including those with K/M suffixes and scientific notation (like 0.000001).
 * @param str The string value to parse.
 * @returns The parsed number or 0 if parsing fails.
 */
const parseNumericValue = (str: string | undefined): number => {
    if (!str || typeof str !== 'string') return 0;

    // Handle price strings like "0.0₄5643" (0.00005643) by replacing the subscript number
    const scientificMatch = str.match(/0\.0(\d+)([a-zA-Z\d\.]+)/);
    if (scientificMatch) {
        const zeros = parseInt(scientificMatch[1], 10);
        const value = parseFloat(`0.${'0'.repeat(zeros)}${scientificMatch[2]}`);
        if (!isNaN(value)) return value;
    }

    // Handle K/M suffixes
    let numStr = str.replace(/[^eE\d.]/g, ''); // Clean non-numeric, non-dot, non-E/e characters
    let num = parseFloat(numStr);

    if (str.toUpperCase().includes('M')) num *= 1e6;
    else if (str.toUpperCase().includes('K')) num *= 1e3;

    return isNaN(num) ? 0 : num;
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

                        // === Data Parsing and Assignment ===
                        const timestamp = Math.floor(parseNumericValue(trade.createTime || String(Date.now())) / 1000);

                        const kolId = String(trade.kol?.id || '');
                        const kolName = String(trade.kol?.name || '');
                        const kolAvatar = String(trade.kol?.avatar || '');
                        const kolTwitterId = String(trade.kol?.twitterId || '');

                        const actionTypeKey = String(trade.actionType || '0');
                        const action = ACTION_TYPE_MAP[actionTypeKey] || 'unknown';

                        // Amount is the count of the token being received (toTokenCount)
                        const amount = parseNumericValue(trade.toTokenCount);

                        const contract = String(trade.toTokenAddress || '');
                        const chain = String(trade.chainName || 'BSC').toUpperCase(); // Normalise chain name

                        // NEW: Price/Value Fields
                        const usdtPrice = parseNumericValue(trade.usdtPrice); // USDT value of the trade
                        const initialPrice = parseNumericValue(trade.initialPrice); // Price of the token at the time of the trade

                        const fromToken = String(trade.fromToken || '');
                        const fromTokenAddress = String(trade.fromTokenAddress || '');
                        const fromTokenCount = parseNumericValue(trade.fromTokenCount);

                        const toToken = String(trade.toToken || '');
                        const toTokenAddress = String(trade.toTokenAddress || '');
                        const toTokenRemainCount = parseNumericValue(trade.toTokenRemainCount);
                        const walletType = parseNumericValue(trade.walletType);

                        const recentBuyerKols = JSON.stringify(trade.recentBuyerKols || []);
                        const recentSellerKols = JSON.stringify(trade.recentSellerKols || []);

                        // === Filtering and Insertion Logic ===

                        if (chain !== 'BSC') {
                            logger.debug(`⏩ Skipping trade from non-BSC chain: ${chain}`);
                            continue;
                        }

                        logger.info(`✅ Processing BSC trade for QuestDB: ${kolName} ${action} ${amount} of ${contract} (${usdtPrice.toFixed(2)} USDT)`);

                        // NOTE ON DUPLICATES: 
                        // The primary key for 'kol_trades' should ideally be (txHash, timestamp) 
                        // in QuestDB to prevent duplicates, or use an UPSERT method.
                        // We are relying on the database layer to handle the deduplication 
                        // since we have a unique txHash.

                        await questdbService.insertBatch('kol_trades', [{
                            timestamp,
                            kolId,
                            kolName,
                            kolAvatar,
                            kolTwitterId,
                            contract,
                            action,
                            amount,
                            usdtPrice,
                            initialPrice, // NEW: Added initial price
                            txHash,
                            fromToken,
                            fromTokenAddress,
                            fromTokenCount,
                            toToken,
                            toTokenAddress,
                            toTokenRemainCount,
                            walletType,
                            recentBuyerKols,
                            recentSellerKols,
                            chain
                        }]);
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