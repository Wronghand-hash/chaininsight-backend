import { Request, Response } from 'express';
import { KolService } from '../../services/kolsLeaderboard';
import { logger } from '../../utils/logger';
// Initialize the service instance
const kolService = new KolService();

/**
 * Handles GET requests to fetch the KOL leaderboards for a specific contract.
 * Expects 'contractAddress' and optionally 'chain' in the query parameters.
 */
export const getKolLeaderboards = async (req: Request, res: Response): Promise<void> => {
    // We expect contractAddress to be a required query parameter
    const { contractAddress, chain } = req.query;

    if (!contractAddress || typeof contractAddress !== 'string') {
        logger.warn('400: Missing or invalid contractAddress in query.');
        res.status(400).json({ error: 'The contractAddress query parameter is required and must be a string.' });
        return;
    }

    // Safely cast and validate the optional chain parameter
    const safeChain = (
        (typeof chain === 'string' && (chain === 'Solana' || chain === 'BSC'))
            ? chain
            : 'Solana' // Default to Solana if not provided or invalid
    ) as 'Solana' | 'BSC';

    try {
        const data = await kolService.getLeaderboards(contractAddress, safeChain);

        // Send a successful response with the fetched data
        res.status(200).json(data);

    } catch (error) {
        logger.error(`500: Failed to fetch KOL leaderboards for ${contractAddress}.`, error);

        // Send a generic 500 error response
        res.status(500).json({
            error: 'Internal Server Error',
            details: 'Could not fetch data from external API.'
        });
    }
};
