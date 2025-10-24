import { Router } from 'express';
import { getKolLeaderboards } from '../controllers/leaderboard.controller';
import { getTokenDetails } from '../controllers/tokenInfo.controller';

const kolsLeaderboardRouter = Router();

/**
 * @swagger
 * /kol/leaderboard:
 *   get:
 *     summary: Get KOL leaderboards for a specific token
 *     tags: [KOL Leaderboard]
 *     parameters:
 *       - in: query
 *         name: contractAddress
 *         required: true
 *         schema:
 *           type: string
 *         description: The contract address of the token
 *       - in: query
 *         name: chain
 *         schema:
 *           type: string
 *           default: BSC
 *         description: The blockchain network (e.g., BSC, ETH)
 *     responses:
 *       200:
 *         description: Successfully retrieved KOL leaderboards
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/KolLeaderboardResponse'
 *       400:
 *         description: Invalid input parameters
 *       500:
 *         description: Internal server error
 */
kolsLeaderboardRouter.get('/leaderboard', getKolLeaderboards);

/**
 * @swagger
 * /kol/info:
 *   get:
 *     summary: Get aggregated token details
 *     tags: [Token Info]
 *     parameters:
 *       - in: query
 *         name: contractAddress
 *         required: true
 *         schema:
 *           type: string
 *         description: The contract address of the token
 *     responses:
 *       200:
 *         description: Successfully retrieved token details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TokenInfoResponse'
 *       400:
 *         description: Invalid contract address
 *       404:
 *         description: Token not found
 *       500:
 *         description: Internal server error
 */
kolsLeaderboardRouter.get('/info', getTokenDetails);

export default kolsLeaderboardRouter;
