// New file: paymentChecker.ts
// (A new utility service for synchronous balance checking in the controller.
// This avoids relying on the async cron and enables immediate polling per request.
// For BSC, use ethers to check ETH balance (assuming BNB is similar). Switch to mainnet RPC in prod.)

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ethers } from 'ethers';
import { logger } from '../../utils/logger';
import { questdbService } from '../questDbService';
import { config } from '../../utils/config';  // Assuming config has RPC URLs
import type { QueryResult } from '../../models/db.types';

type Chain = 'BSC' | 'SOL';

export class SynchronousPaymentChecker {
    private solConnection: Connection;
    private bscProvider: ethers.JsonRpcProvider;

    constructor() {
        // Use Devnet for testing; switch to mainnet in production
        this.solConnection = new Connection('https://api.devnet.solana.com', 'confirmed');
        this.bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org/');  // BSC mainnet RPC; use testnet for dev
    }

    async checkAndConfirmPayment(
        chain: Chain,
        twitterId: string,
        amount: number,
        serviceType: string,
        address: string
    ): Promise<boolean> {
        try {
            // First, check if already confirmed in DB (in case cron ran)
            const checkStatusSql = `
                SELECT paymentStatus FROM payment_history 
                WHERE twitterId = '${twitterId.replace(/'/g, "''")}' AND address = '${address.replace(/'/g, "''")}' AND chain = '${chain}';
            `;
            const statusRes: QueryResult = await questdbService.query(checkStatusSql);
            if (statusRes.rows.length > 0 && statusRes.rows[0][0] === true) {
                logger.info(`[SyncCheck] Payment already confirmed in DB for ${twitterId} (${address})`);
                await this.handlePurchaseCreation(twitterId, amount, serviceType, address);
                return true;
            }

            let currentBalance = 0;
            const pollIntervalMs = 3000;  // Poll every 3 seconds
            const maxPollDurationMs = 3 * 60000;  // 3 minutes timeout
            const startTime = Date.now();

            while (Date.now() - startTime < maxPollDurationMs) {
                if (chain === 'SOL') {
                    const pubkey = new PublicKey(address);
                    const lamports = await this.solConnection.getBalance(pubkey, 'confirmed');
                    currentBalance = lamports / LAMPORTS_PER_SOL;
                } else if (chain === 'BSC') {
                    const balanceWei = await this.bscProvider.getBalance(address);
                    currentBalance = parseFloat(ethers.formatEther(balanceWei));
                }

                logger.debug(`[SyncCheck] ${twitterId} (${address}): current=${currentBalance}, required=${amount}`);

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
                        logger.info(`✅ Synchronous payment confirmed for ${twitterId} (${address}): updated DB`);
                    }

                    // Handle purchase creation
                    await this.handlePurchaseCreation(twitterId, amount, serviceType, address);
                    return true;
                }

                // Wait before next poll
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            }

            logger.warn(`[SyncCheck] Timeout: Payment not confirmed within 5min for ${twitterId} (${address})`);
            return false;
        } catch (error) {
            logger.error(`[SyncCheck] Error checking payment for ${twitterId} (${address})`, error);
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
            logger.debug(`[SyncCheck] userPurchase already exists for ${twitterId} (${serviceType}) + address ${address}`);
        }
    }
}

export const synchronousPaymentChecker = new SynchronousPaymentChecker();