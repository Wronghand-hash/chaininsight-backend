import { Router } from 'express';
import { getKolLeaderboards, } from '../controllers/leaderboard.controller';
import { getTokenDetails } from '../controllers/tokenInfo.controller';

const kolsLeaderboardRouter = Router();

/**
 * GET /api/v1/kol/leaderboard
 * Fetches KOL leaderboards for a specific contract.
 * Query Params:
 * - contractAddress (required)
 * - chain (optional,   'BSC' )
 */
kolsLeaderboardRouter.get('/leaderboard', getKolLeaderboards);
/**
 * GET /api/v1/token/info
 * Fetches aggregated token details (price, narrative, social) for a specific contract.
 * Query Params:
 * - contractAddress (required)
 */
kolsLeaderboardRouter.get('/info', getTokenDetails);



// Export the router to be used in your main Express application file (e.g., server.ts)
export default kolsLeaderboardRouter;
