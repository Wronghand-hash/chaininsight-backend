import { Keypair } from '@solana/web3.js';
import { Wallet } from 'ethers';
import { logger } from '../utils/logger';
import { questdbService } from './questDbService';

// Define Chain type if not imported
type Chain = 'BSC' | 'SOL';

export class WalletService {
    /**
     * Generates a new keypair for the specified chain, derives the address,
     * logs the details, and stores in payment_history and userPurchase tables.
     * 
     * @param chain - The blockchain chain ('BSC' or 'SOL')
     * @param twitterId - The Twitter user ID
     * @param amount - An amount parameter (e.g., funding amount in native token)
     * @param serviceType - The type of service (e.g., 'wallet_generation')
     */
    async generateAndLogKeyPair(
        chain: Chain,
        twitterId: string,
        amount: number,
        serviceType: string = 'wallet_generation'
    ): Promise<{
        chain: Chain;
        twitterId: string;
        amount: number;
        serviceType: string;
        publicKey: string;
        privateKey: string;
        address: string;
    }> {

        let publicKey: string;
        let privateKey: string;
        let address: string;

        if (chain === 'BSC') {
            const wallet = Wallet.createRandom();
            address = wallet.address;
            publicKey = wallet.publicKey; 
            privateKey = wallet.privateKey;
        } else if (chain === 'SOL') {
            const keypair = Keypair.generate();
            address = keypair.publicKey.toBase58();
            publicKey = keypair.publicKey.toBase58(); 
            privateKey = Buffer.from(keypair.secretKey).toString('hex');
        } else {
            throw new Error(`Unsupported chain: ${chain}. Supported: BSC, SOL.`);
        }

        const nowIso = new Date().toISOString();

        const paymentHistoryRow = {
            timestamp: nowIso,
            twitterId,
            amount,
            serviceType,
            chain,
            address,
            publicKey,
            privateKey,  // Store securely; consider hashing or encryption
            paymentStatus: false,
            status: 'pending'
        };

        // Prepare data for userPurchase (expire_at = created_at + 1 month)
        // const createdAt = new Date(nowIso);
        // const expireAt = new Date(createdAt.getTime() + (30 * 24 * 60 * 60 * 1000));  // 30 days
        // const userPurchaseRow = {
        //     timestamp: nowIso,  // Use for consistency, though table uses created_at
        //     twitterId,
        //     amount,
        //     serviceType,
        //     created_at: nowIso,
        //     expire_at: expireAt.toISOString()
        // };

        // Insert into DB tables
        try {
            await questdbService.insertBatch('payment_history', [paymentHistoryRow]);
            logger.info('💾 Wallet data stored in payment_history table');
        } catch (dbError) {
            logger.error('❌ Failed to store wallet data in DB', dbError);
            // Continue logging but don't throw if DB fails (non-critical for generation)
        }

        // Log the details
        logger.info('🔑 New Wallet Generated', {
            chain,
            twitterId,
            amount,
            serviceType,
            address,
            publicKey,
            privateKey: privateKey.substring(0, 10) + '...', // Log truncated private key for security
        });

        console.log(`
🚀 User's Wallet Choice Summary:
- Chain: ${chain}
- Twitter ID: ${twitterId}
- Amount: ${amount}
- Service Type: ${serviceType}
- Address: ${address}
- Public Key: ${publicKey}
- Private Key: ${privateKey} (Keep this secure!)
    `);

        // Return the full details (private key included for programmatic use, but handle securely)
        return {
            chain,
            twitterId,
            amount,
            serviceType,
            publicKey,
            privateKey,
            address,
        };
    }
}

export const walletService = new WalletService();