import { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { questdbService } from '../questDbService';
import { logger } from '../../utils/logger';
import { QueryResult } from '../../models/db.types';
import { config } from '../../utils/config';
import { CronJob } from 'cron';

const RECIPIENT_WALLET_ADDRESS = '2msCrwxzu4ba5Zi7qFy8iEJYAqCmWbCMoykRHiLC1CCf';
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1000;
const RECIPIENT_PRIVATE_KEY_B58 = process.env.RECIPIENT_PRIVATE_KEY || '';
const SOLANA_RPC_URL = config.SOLANA_RPC_URL;
let RECIPIENT_KEYPAIR: Keypair;
try {
    const secretKey = bs58.decode(RECIPIENT_PRIVATE_KEY_B58);
    RECIPIENT_KEYPAIR = Keypair.fromSecretKey(secretKey);
    if (!RECIPIENT_KEYPAIR.publicKey.equals(new PublicKey(RECIPIENT_WALLET_ADDRESS))) {
        throw new Error('Recipient private key does not match RECIPIENT_WALLET_ADDRESS');
    }
} catch (error) {
    logger.error('FATAL: Could not load Recipient Keypair. Using a dummy keypair, transfers will fail.', error);
    RECIPIENT_KEYPAIR = new Keypair();
}
// --- END: Recipient Keypair Setup ---
export class paymentTransferService {
    private connection: Connection;
    private recipientKeypair: Keypair; // Added to store the fee payer keypair
    constructor() {
        this.connection = new Connection(SOLANA_RPC_URL, 'confirmed');
        this.recipientKeypair = RECIPIENT_KEYPAIR;
    }
    async runTransferCron(): Promise<void> {
        try {
            await questdbService.init();
            logger.info('🚀 Starting SOL transfer cron job');
            const sql = `SELECT * FROM payment_history WHERE chain='SOL' AND status='completed' AND paymentStatus = true;`;
            const { rows, columns }: QueryResult = await questdbService.query(sql);
            if (rows.length === 0) {
                logger.info('No eligible SOL payments found for transfer');
                return;
            }
            logger.info(`Found ${rows.length} eligible payments for transfer`);
            const payments: Array<Record<string, any>> = rows.map((row: any[]) => {
                const obj: Record<string, any> = {};
                columns.forEach((col: string, i: number) => {
                    obj[col] = row[i];
                });
                return obj;
            });
            // Process in batches for balance fetching
            const batchPromises = [];
            for (let i = 0; i < payments.length; i += BATCH_SIZE) {
                const batch = payments.slice(i, i + BATCH_SIZE);
                batchPromises.push(this.processBatch(batch));
            }
            // Run batches rate limits
            for (const promise of batchPromises) {
                await promise;
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
            }
            logger.info('✅ SOL transfer cron job completed');
        } catch (error) {
            logger.error('❌ SOL transfer cron job failed', error);
            throw error;
        }
    }
    private async processBatch(batch: Array<Record<string, any>>): Promise<void> {
        if (batch.length === 0) return;
        const pubkeys: PublicKey[] = batch.map(payment => new PublicKey(payment.address));
        const accounts = await this.connection.getMultipleAccountsInfo(pubkeys, 'confirmed');
        const balances = accounts.map(account => account ? account.lamports : 0);
        logger.debug(`Fetched balances for batch of ${batch.length} addresses`);
        // Collect valid payments with a balance greater than 0
        const validPayments: Array<{ payment: Record<string, any>, balance: number, keypair: Keypair }> = [];
        for (let j = 0; j < batch.length; j++) {
            const payment = batch[j];
            const balance = balances[j];
            // Only skip if balance is exactly zero, as recipient pays the fee
            if (balance === 0) {
                logger.warn(`Skipping transfer for ${payment.address}: zero balance`);
                continue;
            }
            try {
                let secretKey: Uint8Array;
                try {
                    const array = JSON.parse(payment.privateKey);
                    secretKey = new Uint8Array(array);
                } catch {
                    try {
                        secretKey = bs58.decode(payment.privateKey);
                    } catch {
                        if (payment.privateKey.length === 128 && /^[0-9a-fA-F]+$/.test(payment.privateKey)) {
                            secretKey = Buffer.from(payment.privateKey, 'hex');
                        } else {
                            throw new Error(`Failed to parse private key for ${payment.address}: unsupported format`);
                        }
                    }
                }
                // Validate length and create keypair
                let fromKeypair: Keypair;
                if (secretKey.length === 32) {
                    fromKeypair = Keypair.fromSeed(secretKey);
                } else if (secretKey.length === 64) {
                    fromKeypair = Keypair.fromSecretKey(secretKey);
                } else {
                    throw new Error(`Invalid secret key length (${secretKey.length}) for ${payment.address}; expected 32 or 64 bytes`);
                }
                // Validate public key matches stored address
                if (!fromKeypair.publicKey.equals(new PublicKey(payment.address))) {
                    throw new Error('Private key does not match stored address');
                }
                validPayments.push({ payment, balance, keypair: fromKeypair });
            } catch (error) {
                logger.error(`❌ Failed to prepare transfer for ${payment.address}: invalid keypair`, error);
            }
        }
        if (validPayments.length === 0) {
            logger.info(`No valid payments with sufficient balance in this batch`);
            return;
        }
        try {
            const recipientPubkey = this.recipientKeypair.publicKey;
            const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
            const tx = new Transaction({
                recentBlockhash: blockhash,
                feePayer: recipientPubkey,
            });
            for (const vp of validPayments) {
                const transferAmount = vp.balance;
                tx.add(
                    SystemProgram.transfer({
                        fromPubkey: vp.keypair.publicKey,
                        toPubkey: recipientPubkey,
                        lamports: transferAmount,
                    })
                );
            }
            const senderKeypairs = validPayments.map(vp => vp.keypair);
            const allKeypairs = [...senderKeypairs, this.recipientKeypair];
            tx.sign(...allKeypairs);
            const signature = await this.connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
            });
            await this.connection.confirmTransaction(signature, 'confirmed');
            logger.debug(`Batch transaction confirmed: ${signature} for ${validPayments.length} addresses`);
            // Update DB for all valid payments
            const esc = (s: string) => s.replace(/'/g, "''");
            const updatePromises = validPayments.map(vp => {
                const updateSql = `UPDATE payment_history
                                      SET status = 'transferred', paymentStatus = true
                                      WHERE twitterId = '${esc(vp.payment.twitterId)}' AND address = '${esc(vp.payment.address)}';`;
                return questdbService.query(updateSql);
            });
            await Promise.all(updatePromises);
            const totalTransferred = validPayments.reduce((sum, vp) => sum + (vp.balance / LAMPORTS_PER_SOL), 0);
            logger.info(`✅ Batch transferred ${totalTransferred.toFixed(6)} SOL from ${validPayments.length} addresses via ${signature}`);
        } catch (error) {
            logger.error(`❌ Batch transfer failed for ${validPayments.length} addresses`, error);
        }
    }
}
export const paymentTransferCron = new paymentTransferService();

// Schedule the cron job to run every 10 minutes
const job = new CronJob('*/10 * * * *', async () => {
    try {
        await paymentTransferCron.runTransferCron();
    } catch (error) {
        logger.error('Cron job execution failed', error);
    }
}, null, true, 'UTC');  