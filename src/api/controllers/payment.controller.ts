import { Request, Response } from 'express';
import { walletService } from '../../services/payments/paymentService';  // Adjust path as needed
import { synchronousPaymentChecker } from '../../services/payments/paymentChecker';  // New import
import { logger } from '../../utils/logger';

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

    // Immediately respond with wallet details (client can start transfer)
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked'
    });

    // 💡 FIX 1: Format the initial response as a 'wallet' type object
    res.write(JSON.stringify({
        type: 'wallet', // <-- MATCHES client's 'data.type' check
        walletAddress: walletDetails.address, // <-- Client expects this
    }) + '\n'); // <-- Newline separator is essential for streaming

    // Now synchronously await confirmation via polling
    const confirmed = await synchronousPaymentChecker.checkAndConfirmPayment(
        chain as Chain,
        String(twitterId),
        Number(amount),
        walletDetails.serviceType,
        walletDetails.address
    );

    // 💡 FIX 2: Format status updates as 'status' type objects
    if (confirmed) {
        res.write(JSON.stringify({
            type: 'status', // <-- MATCHES client's 'data.type' check
            status: 'COMPLETED', // <-- Client expects this status
            // Note: You must link the transaction ID here
            transactionId: `TX_${chain}_${Date.now()}`, // Placeholder for real transaction ID
        }) + '\n');
    } else {
        res.write(JSON.stringify({
            type: 'status', // <-- MATCHES client's 'data.type' check
            status: 'FAILED', // Using FAILED instead of a custom 'timeout' for clarity
            transactionId: 'N/A',
        }) + '\n');
    }

    res.end();  // Close the response
    logger.info(`[Controller] Request completed for ${twitterId}: ${confirmed ? 'confirmed' : 'timeout'}`);
};

export default generateWalletKeypair;