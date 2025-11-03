import { CronJob } from 'cron';
import { Connection, PublicKey, LAMPORTS_PER_SOL, AccountInfo } from '@solana/web3.js';
import { logger } from '../utils/logger';
import { questdbService } from './questDbService';
import { config } from '../utils/config';
import type { QueryResult } from '../models/db.types';

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 200;

export class SolanaPaymentCheckerService {
    private connection: Connection;
    private cronJob?: CronJob;

    constructor() {
        // Use Devnet for testing; switch to 'https://api.mainnet-beta.solana.com' for production
        this.connection = new Connection('https://api.devnet.solana.com', 'confirmed');
    }

    startCron(): void {
        this.runCheck().catch((error) => logger.error('❌ Initial run failed', error));

        this.cronJob = new CronJob('*/1 * * * *', async () => {
            try {
                logger.info('🕐 Running Solana payment check cron...');
                await this.runCheck();
            } catch (error) {
                logger.error('❌ Cron execution failed', error);
            }
        }, null, true, 'UTC'); // Start immediately, UTC timezone
        logger.info('✅ Solana payment checker cron started (every 1 minute)');
    }

    /**
     * Stops the cron job.
     */
    stopCron(): void {
        if (this.cronJob) {
            this.cronJob.stop();
            logger.info('⏹️ Solana payment checker cron stopped');
        }
    }

    private async runCheck(): Promise<void> {
        let confirmedCount = 0;  // Track for summary log
        try {
            // Query pending SOL payments: SELECT with named columns for clarity
            const pendingSql = `
        SELECT 
          twitterId, amount, serviceType, address, timestamp 
        FROM payment_history 
        WHERE paymentStatus = false AND chain = 'SOL';
      `;
            const result: QueryResult = await questdbService.query(pendingSql);

            if (result.rows.length === 0) {
                if (config.questdb.diagnosticsVerbose) {
                    logger.debug('[SolanaCron] No pending SOL payments to check');
                }
                return;
            }

            logger.debug(`[SolanaCron] Checking ${result.rows.length} pending payments`);

            const pendingRows = result.rows.map(row => {
                const [twitterId, amountStr, serviceType, address, timestamp] = row;
                const amount = Number(amountStr);
                if (isNaN(amount) || amount <= 0) {
                    logger.warn(`[SolanaCron] Invalid amount for ${twitterId}: ${amountStr}, skipping`);
                    return null;
                }
                return { twitterId, amount, serviceType, address, timestamp };
            }).filter(row => row !== null);

            if (pendingRows.length === 0) {
                return;
            }

            const addresses = pendingRows.map(r => r.address);
            const pubkeys = addresses.map(addr => new PublicKey(addr));

            const allAccountsInfo: (AccountInfo<Buffer> | null)[] = [];
            for (let i = 0; i < pubkeys.length; i += BATCH_SIZE) {
                const batchPubkeys = pubkeys.slice(i, i + BATCH_SIZE);
                let batchAccountsInfo: (AccountInfo<Buffer> | null)[] = [];

                let retryCount = 0;
                const maxRetries = 3;
                while (retryCount < maxRetries) {
                    try {
                        batchAccountsInfo = await this.connection.getMultipleAccountsInfo(batchPubkeys);
                        break; // Success
                    } catch (rpcError: any) {
                        if (rpcError.message?.includes('429') || rpcError.status === 429) {
                            // Rate limit hit: exponential backoff
                            const backoffMs = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
                            logger.warn(`[SolanaCron] Rate limit hit on batch ${i / BATCH_SIZE + 1}; retrying in ${backoffMs}ms (attempt ${retryCount + 1})`);
                            await new Promise(resolve => setTimeout(resolve, backoffMs));
                            retryCount++;
                        } else {
                            throw rpcError; // Non-rate-limit error
                        }
                    }
                }

                if (retryCount >= maxRetries) {
                    logger.error(`[SolanaCron] Max retries exceeded for batch ${i / BATCH_SIZE + 1}; skipping`);
                } else {
                    allAccountsInfo.push(...batchAccountsInfo);
                    if (i + BATCH_SIZE < pubkeys.length) {
                        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
                    }
                }
            }

            logger.debug(`[SolanaCron] Fetched balances for ${pubkeys.length} addresses in ${Math.ceil(pubkeys.length / BATCH_SIZE)} batches`);

            for (let i = 0; i < pendingRows.length; i++) {
                const { twitterId, amount, serviceType, address } = pendingRows[i];
                const accountInfo = allAccountsInfo[i];

                try {
                    let solBalance = 0;
                    if (accountInfo) {
                        solBalance = accountInfo.lamports / LAMPORTS_PER_SOL;
                    } else {
                        logger.debug(`[SolanaCron] Account not found for ${address}`);
                    }

                    logger.debug(`[SolanaCron] ${twitterId} address ${address}: balance=${solBalance} SOL, required=${amount} SOL`);

                    if (solBalance >= amount) {
                        const escTwitterId = twitterId.replace(/'/g, "''");
                        const escAddress = address.replace(/'/g, "''");
                        const updatePaymentSql = `
              UPDATE payment_history 
              SET paymentStatus = true, status = 'completed' 
              WHERE twitterId = '${escTwitterId}' AND address = '${escAddress}';
            `;
                        if (config.questdb.diagnosticsVerbose) {
                            logger.debug(`[SolanaCron] Executing UPDATE: ${updatePaymentSql}`);
                        }
                        const updateRes = await questdbService.query(updatePaymentSql);
                        if (updateRes.rows.length > 0) {
                            logger.info(`✅ Payment confirmed for ${twitterId} (${address}): updated ${updateRes.rows.length} row(s) in payment_history`);
                            confirmedCount++;
                        } else {
                            logger.warn(`⚠️ No rows updated for ${twitterId} (${address}) (rowCount: ${updateRes.rows.length || 0})`);
                        }

                        const checkPurchaseSql = `
              SELECT count(*) as c 
              FROM userPurchase 
              WHERE twitterId = '${twitterId}' AND serviceType = '${serviceType}' AND address = '${address}';
            `;
                        const checkRes: QueryResult = await questdbService.query(checkPurchaseSql);
                        const exists = Number(checkRes.rows[0]?.[0]) > 0;

                        if (!exists) {
                            const nowIso = new Date().toISOString();
                            const expireAt = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString();

                            const purchaseRow: Record<string, any> = {
                                timestamp: nowIso,
                                twitterId,
                                amount,
                                address,
                                serviceType,
                                created_at: nowIso,
                                expire_at: expireAt
                            };

                            await questdbService.insertBatch('userPurchase', [purchaseRow]);
                            logger.info(`💾 Added userPurchase for ${twitterId} (${serviceType}) with address ${address}`);
                        } else {
                            logger.debug(`[SolanaCron] userPurchase already exists for ${twitterId} (${serviceType}) + address ${address}`);
                        }
                    }
                } catch (balanceError) {
                    logger.error(`❌ Error processing balance for ${twitterId} (${address})`, balanceError);
                }
            }

            // Summary log
            logger.info(`[SolanaCron] Check complete: ${result.rows.length} pending checked, ${confirmedCount} confirmed/updated`);
        } catch (error) {
            logger.error('❌ Solana payment check failed', error);
        }
    }
}

export const solanaPaymentCheckerService = new SolanaPaymentCheckerService();