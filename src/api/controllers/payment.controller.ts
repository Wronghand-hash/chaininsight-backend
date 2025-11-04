import { Request, Response } from 'express';
import { walletService } from '../../services/cronServices/paymentService';
import { logger } from '../../utils/logger';


type Chain = 'BSC' | 'SOL';

const isValidChain = (chain: any): chain is Chain => {
    return chain === 'BSC' || chain === 'SOL';
};

const generateWalletKeypair = async (req: Request, res: Response): Promise<void> => {
    const { chain, twitterId, amount, serviceType } = req.body;

    if (!chain || !twitterId || amount === undefined) {
        logger.warn('Missing required parameters for wallet generation', req.body);
        res.status(400).json({ error: 'Missing required parameters: chain, twitterId, and amount are required.' });
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

    try {
        const result = await walletService.generateAndLogKeyPair(
            chain as Chain,
            String(twitterId),
            Number(amount),
            serviceType ? String(serviceType) : 'x_alerts_service'
        );

        res.status(200).json({
            message: `Wallet keypair successfully generated and logged for chain: ${chain}`,
            data: {
                chain: result.chain,
                twitterId: result.twitterId,
                address: result.address,
                publicKey: result.publicKey,
            },
        });

    } catch (error) {
        logger.error('Error generating wallet keypair in controller', { error, chain, twitterId });
        if (error instanceof Error && error.message.includes('Unsupported chain')) {
            res.status(400).json({ error: error.message });
        } else {
            res.status(500).json({ error: 'Internal Server Error during wallet generation.' });
        }
    }
};


export default generateWalletKeypair;