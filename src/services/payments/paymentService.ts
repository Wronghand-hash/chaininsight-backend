import { Keypair } from '@solana/web3.js';
import { Wallet } from 'ethers';
import { logger } from '../../utils/logger';
import { questdbService } from '../questDbService';

type Chain = 'BSC' | 'SOL';

export class WalletService {
    async generateAndLogKeyPair(
        chain: Chain,
        twitterId: string,
        amount: number,
        serviceType: string = 'x_alerts_service'
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

        // Insert into DB tables
        try {
            await questdbService.insertBatch('payment_history', [paymentHistoryRow]);
            logger.info('💾 Wallet data stored in payment_history table');
        } catch (dbError) {
            logger.error('❌ Failed to store wallet data in DB', dbError);
            // Continue logging but don't throw if DB fails (non-critical for generation)
        }

        // Log the details (masked private key)
        logger.info('🔑 New Wallet Generated', {
            chain,
            twitterId,
            amount,
            serviceType,
            address,
            publicKey,
            privateKey: privateKey.substring(0, 10) + '...',
        });

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