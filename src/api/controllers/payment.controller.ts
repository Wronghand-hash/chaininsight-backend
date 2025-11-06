import { Request, Response } from 'express';
import { walletService } from '../../services/payments/paymentService';
import { logger } from '../../utils/logger';
import { questdbService } from '../../services/questDbService';
import { paymentChecker } from '../../services/payments/paymentChecker';

type Chain = 'BSC' | 'SOL';

const isValidChain = (chain: any): chain is Chain => {
    return chain === 'BSC' || chain === 'SOL';
};

const generateWalletKeypair = async (req: Request, res: Response): Promise<void> => {
    const { chain, twitterId, amount, serviceType, wallet } = req.body;

    if (!chain || !twitterId || amount === undefined || !wallet) {
        logger.warn('Missing required parameters for wallet generation', req.body);
        res.status(400).json({ error: 'Missing required parameters: chain, twitterId, amount, and wallet are required.' });
        return;
    }

    if (!isValidChain(chain)) {
        logger.warn(`Invalid chain provided: ${chain}`);
        res.status(400).json({ error: `Unsupported chain: ${chain}. Supported chains are BSC and SOL.` });
        return;
    }

    if (typeof amount !== 'number' || amount <= 0) {
        logger.warn(`Invalid amount provided: ${amount}`);
        res.status(400).json({ error: 'Amount must be a positive number.' });
        return;
    }

    let walletDetails;
    try {
        walletDetails = await walletService.generateAndLogKeyPair(
            chain as Chain,
            String(twitterId),
            Number(amount),
            serviceType ? String(serviceType) : 'x_alerts_service',
            wallet
        );
    } catch (error) {
        logger.error('Error generating wallet keypair in controller', { error, chain, twitterId });
        if (error instanceof Error && error.message.includes('Unsupported chain')) {
            res.status(400).json({ error: error.message });
        } else {
            res.status(500).json({ error: 'Internal Server Error during wallet generation.' });
        }
        return;
    }

    // Immediately respond with wallet details (no streaming or waiting)
    res.status(200).json({
        type: 'wallet',
        walletAddress: walletDetails.address,
    });

    logger.info(`[Controller] Wallet generated for ${twitterId}: ${walletDetails.address}`);
};

const getPaymentStatus = async (req: Request, res: Response): Promise<void> => {
    const { twitterId, chain } = req.body;  // Or use req.query if preferred

    if (!twitterId || !chain) {
        logger.warn('Missing required parameters for status check', req.body);
        res.status(400).json({ error: 'Missing required parameters: twitterId and chain are required.' });
        return;
    }

    if (!isValidChain(chain)) {
        logger.warn(`Invalid chain provided for status: ${chain}`);
        res.status(400).json({ error: `Unsupported chain: ${chain}. Supported chains are BSC and SOL.` });
        return;
    }

    try {
        // Query for the latest payment entry for this twitterId and chain
        const escTwitterId = String(twitterId).replace(/'/g, "''");
        const statusSql = `
            SELECT amount, serviceType, address, paymentStatus, status 
            FROM payment_history 
            WHERE twitterId = '${escTwitterId}' AND chain = '${chain}' 
            ORDER BY timestamp DESC LIMIT 1;
        `;
        const statusRes = await questdbService.query(statusSql);  // Now imported

        if (statusRes.rows.length === 0) {
            res.status(404).json({ error: 'No payment found for the given twitterId and chain.' });
            return;
        }

        const [amount, serviceType, address, paymentStatus, dbStatus] = statusRes.rows[0];

        if (dbStatus === 'completed') {
            // Already completed
            res.status(200).json({
                type: 'status',
                status: 'COMPLETED',
                address: address,
                transactionId: `TX_${chain}_${Date.now()}`,  // Placeholder; enhance to fetch real TX if needed
            });
            return;
        }

        // If pending, perform a single check
        const confirmed = await paymentChecker.checkPaymentOnce(
            chain as Chain,
            String(twitterId),
            Number(amount),
            String(serviceType),
            String(address)
        );

        if (confirmed) {
            res.status(200).json({
                type: 'status',
                status: 'COMPLETED',
                address: address,
                transactionId: `TX_${chain}_${Date.now()}`,  // Placeholder
            });
        } else {
            res.status(200).json({
                type: 'status',
                status: 'PENDING',
                address: address,
                transactionId: 'N/A',
            });
        }

        logger.info(`[Controller] Status checked for ${twitterId} (${chain}): ${confirmed ? 'confirmed' : 'pending'}`);
    } catch (error) {
        logger.error('Error checking payment status', { error, twitterId, chain });
        res.status(500).json({ error: 'Internal Server Error during status check.' });
    }
};

export { generateWalletKeypair, getPaymentStatus };  // Named exports for router import