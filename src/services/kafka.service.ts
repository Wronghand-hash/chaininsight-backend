import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import { questdbService } from './questDbService';
import { logger } from '../utils/logger';
import { stringify } from 'querystring';

const kafka = new Kafka({
    clientId: 'chaininsight-consumer',
    brokers: ['43.134.238.235:32777']  // Your ChainInsight Kafka broker
});

const consumer: Consumer = kafka.consumer({
    groupId: process.env.KAFKA_GROUP_ID || 'your-username-here'  // Replace with your ChainInsight username
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

                    // Log full received data to console
                    console.log('=== FULL KAFKA DATA RECEIVED ===');
                    console.log(JSON.stringify(tradeData, null, 2));
                    console.log('=== END KAFKA DATA ===\n');

                    // Process each item in data array (batches possible)
                    for (const trade of tradeData.data || []) {
                        // Ensure required fields (defaults as strings/numbers)
                        const kolId = trade.kol?.id || 0;
                        const action = trade.actionType ? ['default', 'buy', 'add', 'partial_sell', 'full_sell'][trade.actionType] || 'unknown' : 'unknown';
                        const amount = Number(trade.toTokenCount || trade.toToken?.count || 0);
                        const contract = String(trade.toTokenAddress || trade.toToken?.address || '');
                        const timestamp = Number(trade.createTime || Date.now());
                        const chain = String(trade.chainName || 'BSC');

                        logger.info(`Kafka KOL trade push: KOL_${kolId} ${action} ${amount} of ${contract}`);

                        // Single-row insert + immediate flush per trade (clears buffer for next)
                        const insertData = [{
                            timestamp,
                            kolId: String(kolId),
                            contract,
                            action,
                            amount,
                            chain
                        }];
                        await questdbService.insertBatch('kol_trades', insertData);
                    }
                } catch (error) {
                    logger.error(`Kafka message processing failed (offset ${message.offset}):`, error);
                    // Don't rethrow—let consumer continue (kafkajs handles retries)
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