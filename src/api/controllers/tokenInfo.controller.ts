import { Request, Response } from 'express';
import { tokenInfoApiService } from '../services/tokenInfo.service';
import { logger } from '../../utils/logger';


export const getTokenDetails = async (req: Request, res: Response): Promise<void> => {
    const { contractAddress } = req.query;

    if (!contractAddress || typeof contractAddress !== 'string') {
        logger.warn('400: Missing or invalid contractAddress for token details request.');
        res.status(400).json({ error: 'The contractAddress query parameter is required and must be a string.' });
        return;
    }

    try {
        const data = await tokenInfoApiService.getTokenInfo(contractAddress);

        if (!data) {
            logger.info(`404: Token info not found for ${contractAddress}`);
            res.status(404).json({ error: 'Token information not found.' });
            return;
        }

        res.status(200).json(data);

    } catch (error) {
        logger.error(`500: Failed to fetch token details for ${contractAddress}.`, error);

        res.status(500).json({
            error: 'Internal Server Error',
            details: 'Could not process token information request.'
        });
    }
};
