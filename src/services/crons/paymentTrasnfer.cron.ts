import { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { questdbService } from '../questDbService';
import { logger } from '../../utils/logger';
import { QueryResult } from '../../models/db.types';

const SOLANA_RPC_URL = 'https://api.devnet.solana.com'; 
const RECIPIENT_WALLET_ADDRESS = 'GDBKs5jT6Ag39wnZoQMH9QjEMBBNNDxPJzKjr1Xmumtd'; 
const BATCH_SIZE = 20; 
const BATCH_DELAY_MS = 1000; 
const FEE_RESERVE_LAMPORTS = 5000; 

export class paymentTransferService {
    private connection: Connection;

    constructor() {
        this.connection = new Connection(SOLANA_RPC_URL, 'confirmed');
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

            // Map array rows to objects for easier handling
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

            // Run batches sequentially with delay to respect rate limits
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

        // Extract public keys for batch balance query
        const pubkeys: PublicKey[] = batch.map(payment => new PublicKey(payment.address));
        const accounts = await this.connection.getMultipleAccountsInfo(pubkeys, 'confirmed');
        const balances = accounts.map(account => account ? account.lamports : 0);

        logger.debug(`Fetched balances for batch of ${batch.length} addresses`);

        // Process each payment in the batch sequentially (parallel tx sending can overwhelm RPC)
        for (let j = 0; j < batch.length; j++) {
            const payment = batch[j];
            const balance = balances[j];

            if (balance <= FEE_RESERVE_LAMPORTS) {
                logger.warn(`Skipping transfer for ${payment.address}: insufficient balance (${balance / LAMPORTS_PER_SOL} SOL)`);
                continue;
            }

            try {
                await this.performTransfer(payment, balance);
                logger.info(`✅ Transferred ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL from ${payment.address}`);
            } catch (error) {
                logger.error(`❌ Transfer failed for ${payment.address}`, error);
                // Optionally, update status to 'failed' here if needed
            }
        }
    }

    private async performTransfer(payment: Record<string, any>, balance: number): Promise<void> {
        // Parse private key string (handles JSON array, base58, or hex formats)
        let secretKey: Uint8Array;
        try {
            // First, try parsing as JSON array (common format: "[1,2,3,...]")
            const array = JSON.parse(payment.privateKey);
            secretKey = new Uint8Array(array);
        } catch {
            try {
                // Next, try base58 decode
                secretKey = bs58.decode(payment.privateKey);
            } catch {
                // Finally, try hex decode (64 bytes = 128 hex chars)
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

        const recipientPubkey = new PublicKey(RECIPIENT_WALLET_ADDRESS);
        const transferAmount = balance - FEE_RESERVE_LAMPORTS; // Subtract approx fee

        // Get recent blockhash
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

        // Create and sign transaction
        const tx = new Transaction({
            recentBlockhash: blockhash,
            feePayer: fromKeypair.publicKey,
        }).add(
            SystemProgram.transfer({
                fromPubkey: fromKeypair.publicKey,
                toPubkey: recipientPubkey,
                lamports: transferAmount,
            })
        );

        tx.sign(fromKeypair);

        // Send and confirm
        const signature = await this.connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });
        await this.connection.confirmTransaction(signature, 'confirmed');

        logger.debug(`Transaction confirmed: ${signature} for ${payment.address}`);

        // Update DB: set status='transferred' and paymentStatus=true
        // Using twitterId and address as composite key
        const esc = (s: string) => s.replace(/'/g, "''");
        const updateSql = `UPDATE payment_history 
                     SET status = 'transferred', paymentStatus = true 
                     WHERE twitterId = '${esc(payment.twitterId)}' AND address = '${esc(payment.address)}';`;
        await questdbService.query(updateSql);
    }
}

export const paymentTransferCron = new paymentTransferService();