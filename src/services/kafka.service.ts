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

                    console.log('=== FULL KAFKA DATA RECEIVED ===');
                    console.log(JSON.stringify(tradeData, null, 2));
                    console.log('=== END KAFKA DATA ===\n');

                    // Process each item in data array (batches)
                    for (const trade of tradeData.data || []) {
                        const timestamp = Math.floor(Number(trade.createTime || Date.now()) / 1000);

                        // Parse amount with units (e.g., "3.89M" → 3890000)
                        const parseAmount = (str: string): number => {
                            if (!str || typeof str !== 'string') return 0;
                            let num = parseFloat(str.replace(/[^\d.]/g, ''));
                            if (str.toUpperCase().includes('M')) num *= 1e6;
                            else if (str.toUpperCase().includes('K')) num *= 1e3;
                            return num;
                        };

                        // Ensure required fields
                        const kolId = String(trade.kol?.id || '');
                        const kolName = String(trade.kol?.name || '');
                        const kolAvatar = String(trade.kol?.avatar || '');
                        const kolTwitterId = String(trade.kol?.twitterId || '');
                        const action = trade.actionType ? ['default', 'buy', 'add', 'partial_sell', 'full_sell'][trade.actionType] || 'unknown' : 'unknown';
                        const amount = parseAmount(trade.toTokenCount || '0');
                        const contract = String(trade.toTokenAddress || '');
                        const chain = String(trade.chainName || 'BSC');
                        const usdtPrice = Number(trade.usdtPrice || 0);
                        const txHash = String(trade.transactionHash || '');
                        const fromToken = String(trade.fromToken || '');
                        const fromTokenAddress = String(trade.fromTokenAddress || '');
                        const fromTokenCount = parseAmount(trade.fromTokenCount || '0');
                        const toToken = String(trade.toToken || '');
                        const toTokenAddress = String(trade.toTokenAddress || '');
                        const toTokenRemainCount = parseAmount(trade.toTokenRemainCount || '0');
                        const walletType = Number(trade.walletType || 0);
                        const recentBuyerKols = JSON.stringify(trade.recentBuyerKols || []);
                        const recentSellerKols = JSON.stringify(trade.recentSellerKols || []);

                        logger.info(`Kafka KOL trade push: ${kolName} ${action} ${amount} of ${contract} (${usdtPrice} USDT)`);

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