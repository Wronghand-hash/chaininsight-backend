import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ethers } from 'ethers';
import { logger } from '../../utils/logger';
import { questdbService } from '../questDbService';
import { config } from '../../utils/config';  // Assuming config has RPC URLs
import type { QueryResult } from '../../models/db.types';

type Chain = 'BSC' | 'SOL';

export class PaymentChecker {  // Renamed from SynchronousPaymentChecker
    private solConnection: Connection;
    private bscProvider: ethers.JsonRpcProvider;

    constructor() {
        this.solConnection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
        this.bscProvider = new ethers.JsonRpcProvider(config.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/');
    }

    /**
     * Returns undefined on max retries exceeded to allow skipping the check.
     */
    private async getBscBalanceWithRetry(address: string): Promise<bigint | undefined> {
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
            try {
                const balanceWei = await this.bscProvider.getBalance(address);
                return balanceWei;
            } catch (rpcError: any) {
                if (rpcError.message?.includes('429') || rpcError.status === 429) {
                    const backoffMs = Math.pow(2, retryCount) * 1000;
                    logger.warn(`[Check] BSC Rate limit hit for ${address}; retrying in ${backoffMs}ms (attempt ${retryCount + 1})`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    retryCount++;
                } else {
                    throw rpcError;
                }
            }
        }

        logger.error(`[Check] Max retries exceeded for BSC balance of ${address}; skipping this check`);
        return undefined;
    }

    /**
     * Performs a single check for payment confirmation (no polling loop).
     * Returns true if confirmed (and updates DB), false otherwise.
     */
    async checkPaymentOnce(
        chain: Chain,
        twitterId: string,
        amount: number,
        serviceType: string,
        address: string
    ): Promise<boolean> {
        try {
            // First, check if already confirmed in DB (quick exit)
            const checkStatusSql = `
                SELECT paymentStatus FROM payment_history 
                WHERE twitterId = '${twitterId.replace(/'/g, "''")}' AND address = '${address.replace(/'/g, "''")}' AND chain = '${chain}';
            `;
            const statusRes: QueryResult = await questdbService.query(checkStatusSql);
            if (statusRes.rows.length > 0 && statusRes.rows[0][0] === true) {
                logger.info(`[Check] Payment already confirmed in DB for ${twitterId} (${address})`);
                await this.handlePurchaseCreation(twitterId, amount, serviceType, address);
                return true;
            }

            let currentBalance = 0;

            if (chain === 'SOL') {
                const pubkey = new PublicKey(address);
                const lamports = await this.solConnection.getBalance(pubkey, 'confirmed');
                currentBalance = lamports / LAMPORTS_PER_SOL;
            } else if (chain === 'BSC') {
                const balanceWei = await this.getBscBalanceWithRetry(address);
                if (balanceWei === undefined) {
                    logger.warn(`[Check] Skipping balance check for ${address} due to retries exceeded`);
                    return false;  // Treat as not confirmed for this check
                }
                currentBalance = parseFloat(ethers.formatEther(balanceWei));
            }

            logger.debug(`[Check] ${twitterId} (${address}): current=${currentBalance}, required=${amount}`);

            if (currentBalance >= amount) {
                // Update DB
                const escTwitterId = twitterId.replace(/'/g, "''");
                const escAddress = address.replace(/'/g, "''");
                const updatePaymentSql = `
                    UPDATE payment_history 
                    SET paymentStatus = true, status = 'completed' 
                    WHERE twitterId = '${escTwitterId}' AND address = '${escAddress}';
                `;
                const updateRes = await questdbService.query(updatePaymentSql);
                if (updateRes.rows.length > 0) {  // Adjust based on QuestDB response
                    logger.info(`✅ Payment confirmed for ${twitterId} (${address}): updated DB`);
                }

                // Handle purchase creation
                await this.handlePurchaseCreation(twitterId, amount, serviceType, address);
                return true;
            }

            logger.debug(`[Check] Payment not yet confirmed for ${twitterId} (${address})`);
            return false;
        } catch (error) {
            logger.error(`[Check] Error checking payment for ${twitterId} (${address})`, error);
            return false;
        }
    }

    private async handlePurchaseCreation(
        twitterId: string,
        amount: number,
        serviceType: string,
        address: string
    ): Promise<void> {
        // Check if purchase already exists
        const checkPurchaseSql = `
            SELECT count(*) as c 
            FROM userPurchase 
            WHERE twitterId = '${twitterId.replace(/'/g, "''")}' AND serviceType = '${serviceType.replace(/'/g, "''")}' AND address = '${address.replace(/'/g, "''")}';
        `;
        const checkRes: QueryResult = await questdbService.query(checkPurchaseSql);
        const exists = Number(checkRes.rows[0]?.[0]) > 0;

        if (!exists) {
            const nowIso = new Date().toISOString();
            const expireAt = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString();  // 30 days

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
            logger.debug(`[Check] userPurchase already exists for ${twitterId} (${serviceType}) + address ${address}`);
        }
    }
}

export const paymentChecker = new PaymentChecker();  // Renamed export