// routes/kolsLeaderboardRouter.ts (updated with new Twitter auth routes for nonce flow)
// Note: Added /init and /exchange for nonce-based flow; kept /login and /callback for hybrid use.
import { Router, Request, Response, NextFunction } from 'express';
import { getKolLeaderboards } from '../controllers/leaderboard.controller';
import { getTokenDetails } from '../controllers/tokenInfo.controller';
import { kolTradeService } from '../services/kolsActivity.service'; // Adjust path as needed
import { generateTwitterLoginUrl, handleTwitterExchange, handleTwitterCallback } from '../services/twitter.auth'; // Updated import
import generateWalletKeypair from '../controllers/payment.controller'; // Adjust path as needed for the provided controller
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
/**
 * @swagger
 * /kol/top-tokens:
 *   get:
 *     summary: Get top tokens by KOL trading activity
 *     tags: [KOL Trades]
 *     parameters:
 *       - in: query
 *         name: period
 *         required: true
 *         schema:
 *           type: string
 *           enum: [1h, 24h, 1w]
 *         description: Time period for filtering trades (1h, 24h, or 1w)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           minimum: 1
 *           maximum: 100
 *         description: Number of top tokens to return
 *       - in: query
 *         name: chain
 *         schema:
 *           type: string
 *           enum: [BSC, ETH, SOL]
 *         description: Optional chain filter
 *     responses:
 *       200:
 *         description: Successfully retrieved top tokens by KOL activity
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/TopTokenResponse'
 *       400:
 *         description: Invalid input parameters
 *       500:
 *         description: Internal server error
 */
kolsLeaderboardRouter.get('/top-tokens', async (req: Request, res: Response, next: NextFunction) => {
    try {
        await kolTradeService.init();
        const { period, limit = 10, chain } = req.query;
        if (!['1h', '24h', '1w'].includes(String(period))) {
            return res.status(400).json({ error: 'Invalid period. Must be 1h, 24h, or 1w.' });
        }
        const parsedLimit = parseInt(String(limit), 10);
        if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
            return res.status(400).json({ error: 'Invalid limit. Must be between 1 and 100.' });
        }
        const chainFilter = chain ? String(chain) as any : undefined;
        const topTokens = await kolTradeService.getTopTokensByKolActivity(
            String(period) as any,
            parsedLimit,
            chainFilter
        );
        res.json(topTokens);
    } catch (error) {
        next(error);
    }
});
/**
 * @swagger
 * /kol/auth/twitter/init:
 *   get:
 *     summary: Get nonce and auth URL for Twitter login (nonce flow)
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: redirectUri
 *         required: true
 *         schema:
 *           type: string
 *         description: Client callback URI (e.g., yourapp.com/twitter-callback)
 *     responses:
 *       200:
 *         description: Nonce and auth URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url: { type: string }
 *                 state: { type: string }  # Nonce for CSRF
 *                 codeVerifier: { type: string }  # PKCE secret (store client-side temporarily)
 *       400:
 *         description: Missing redirectUri
 *       500:
 *         description: Failed to generate
 */
kolsLeaderboardRouter.get('/auth/twitter/init', generateTwitterLoginUrl);
/**
 * @swagger
 * /kol/auth/twitter/login:
 *   get:
 *     summary: Generate Twitter OAuth2 login URL (legacy/redirect flow)
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: redirectUri
 *         required: true
 *         schema:
 *           type: string
 *         description: Callback URL after Twitter auth (must match app settings)
 *     responses:
 *       200:
 *         description: Twitter login URL generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                 state:
 *                   type: string
 *       400:
 *         description: Missing redirectUri
 *       500:
 *         description: Failed to generate URL
 */
kolsLeaderboardRouter.get('/auth/twitter/login', generateTwitterLoginUrl);
/**
 * @swagger
 * /kol/auth/twitter/exchange:
 *   post:
 *     summary: Exchange authorization code for access tokens (client-side nonce flow)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, state, codeVerifier]
 *             properties:
 *               code:
 *                 type: string
 *                 description: Authorization code from Twitter redirect
 *               state:
 *                 type: string
 *                 description: CSRF state token from init response
 *               codeVerifier:
 *                 type: string
 *                 description: PKCE code verifier from init response
 *     responses:
 *       200:
 *         description: Tokens exchanged successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 access_token: { type: string }
 *                 refresh_token: { type: string }
 *                 username: { type: string }
 *                 # Add other token response properties as per twitterService
 *       400:
 *         description: Invalid code, state, or PKCE mismatch
 *       500:
 *         description: Token exchange failed
 */
kolsLeaderboardRouter.post('/auth/twitter/exchange', handleTwitterExchange);
/**
 * @swagger
 * /kol/auth/twitter/callback:
 *   get:
 *     summary: Handle Twitter OAuth2 callback (server-side, legacy)
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *         description: Authorization code from Twitter
 *       - in: query
 *         name: state
 *         required: true
 *         schema:
 *           type: string
 *         description: CSRF state token
 *       - in: query
 *         name: redirectUri
 *         schema:
 *           type: string
 *         description: Optional callback URI
 *     responses:
 *       302:
 *         description: Redirect to dashboard on success, or login with error
 */
kolsLeaderboardRouter.get('/auth/twitter/callback', handleTwitterCallback);
/**
 * @swagger
 * /kol/payment/init:
 *   post:
 *     summary: Generate wallet keypair and await synchronous payment confirmation
 *     tags: [Payments]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [chain, twitterId, amount]
 *             properties:
 *               chain:
 *                 type: string
 *                 enum: [BSC, SOL]
 *                 description: The blockchain network for the wallet (BSC or SOL)
 *               twitterId:
 *                 type: string
 *                 description: Twitter user ID for associating the wallet
 *               amount:
 *                 type: number
 *                 minimum: 0
 *                 description: Payment amount (positive number)
 *               serviceType:
 *                 type: string
 *                 description: Optional service type (defaults to 'x_alerts_service')
 *     responses:
 *       200:
 *         description: Wallet generated and payment status streamed (pending -> completed/timeout)
 *         content:
 *           application/json:
 *             schema:
 *               type: array  # Chunked response as array of JSON objects
 *               items:
 *                 type: object
 *                 properties:
 *                   message:
 *                     type: string
 *                     description: Status message (e.g., "Wallet generated...", "Payment confirmed!")
 *                   data:
 *                     type: object
 *                     properties:
 *                       chain: { type: string, enum: [BSC, SOL] }
 *                       twitterId: { type: string }
 *                       amount: { type: number }
 *                       serviceType: { type: string }
 *                       address: { type: string }
 *                       publicKey: { type: string }
 *                       status: { type: string, enum: [pending, completed, timeout] }
 *       400:
 *         description: Invalid input (e.g., missing params, invalid chain, non-positive amount)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 *       500:
 *         description: Internal server error (e.g., wallet generation failed)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 *       headers:
 *         Transfer-Encoding:
 *           schema:
 *             type: string
 *             description: chunked (for streaming updates)
 */
kolsLeaderboardRouter.post('/payment/init', generateWalletKeypair);
// Assuming TopTokenResponse schema needs to be added to components/schemas in Swagger config
// e.g.:
// components:
//   schemas:
//     TopTokenResponse:
//       type: object
//       properties:
//         contract:
//           type: string
//         chain:
//           type: string
//         uniqueKolCount:
//           type: integer
//         buyerKolCount:
//           type: integer
//         sellerKolCount:
//           type: integer
//         recentBuyerKols:
//           type: array
//           items:
//             type: object
//             properties:
//               id: { type: string }
//               name: { type: string }
//               avatar: { type: string }
//         recentSellerKols:
//           type: array
//           items:
//             type: object
//             properties:
//               id: { type: string }
//               name: { type: string }
//               avatar: { type: string }
//         latestTimestamp:
//           type: string
//         tradeCount:
//           type: integer
export default kolsLeaderboardRouter;