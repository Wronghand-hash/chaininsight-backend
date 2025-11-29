import { Router, Request, Response, NextFunction } from 'express';
import { getKolLeaderboards } from '../controllers/leaderboard.controller';
import { getTokenDetails } from '../controllers/tokenInfo.controller';
import { kolTradeService } from '../services/kolsActivity.service';
import { generateTwitterLoginUrl, handleTwitterCallback, handleTwitterLogout } from '../services/twitter.auth';
import { generateWalletKeypair, getPaymentStatus } from '../controllers/payment.controller';
import { freeTrialController } from '../controllers/freeTrial.controller';
import { googleAuthCallback, googleAuthInit, verifyGoogleToken, logoutUser, getCurrentUserProfile, getAllUsers, getCurrentUserPaymentHistory } from '../controllers/user.controller';

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
 * /kol/payment/init:
 *   post:
 *     summary: Generate wallet keypair for payment initiation
 *     tags: [Payment]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [chain, twitterId, amount, wallet]
 *             properties:
 *               email:
 *                 type: string
 *                 description: User's email
 *               chain:
 *                 type: string
 *                 enum: [BSC, SOL]
 *                 description: Blockchain chain
 *               twitterId:
 *                 type: string
 *                 description: User's Twitter ID
 *               amount:
 *                 type: number
 *                 minimum: 0
 *                 description: Payment amount
 *               wallet:
 *                 type: string
 *                 description: User's wallet address
 *               serviceType:
 *                 type: string
 *                 description: Optional service type
 *               token:
 *                 type: string
 *                 description: Optional token  
 *               twitter_community:
 *                 type: string
 *                 description: Optional twitter community
 *     responses:
 *       200:
 *         description: Wallet generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 type:
 *                   type: string
 *                   enum: [wallet]
 *                 walletAddress:
 *                   type: string
 *       400:
 *         description: Invalid input parameters
 *       500:
 *         description: Internal server error
 */
kolsLeaderboardRouter.post('/payment/init', generateWalletKeypair);
/**
 * @swagger
 * /kol/payment/status:
 *   post:
 *     summary: Check status of initiated payment
 *     tags: [Payment]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [twitterId, chain]
 *             properties:
 *               twitterId:
 *                 type: string
 *                 description: User's Twitter ID
 *               chain:
 *                 type: string
 *                 enum: [BSC, SOL]
 *                 description: Blockchain chain
 *     responses:
 *       200:
 *         description: Payment status retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 type:
 *                   type: string
 *                   enum: [status]
 *                 status:
 *                   type: string
 *                   enum: [COMPLETED, PENDING]
 *                 transactionId:
 *                   type: string
 *       400:
 *         description: Invalid input parameters
 *       404:
 *         description: No payment found
 *       500:
 *         description: Internal server error
 */
kolsLeaderboardRouter.post('/payment/status', getPaymentStatus);

/**
 * @swagger
 * /kol/check-community-admin:
 *   get:
 *     summary: Check if a Twitter user is a community admin
 *     tags: [Community]
 *     parameters:
 *       - in: query
 *         name: twitterId
 *         required: true
 *         schema:
 *           type: string
 *         description: Twitter user ID to check
 *       - in: query
 *         name: communityId
 *         required: true
 *         schema:
 *           type: string
 *         description: Community ID to check admin status for
 *     responses:
 *       200:
 *         description: Successfully checked admin status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 isAdmin:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing required parameters
 *       500:
 *         description: Internal server error
 */
kolsLeaderboardRouter.get('/check-community-admin', freeTrialController.checkCommunityAdmin);

/**
 * @swagger
 * /kol/auth/logout:
 *   post:
 *     summary: Logout user and clear authentication cookies
 *     tags: [Authentication]
 *     responses:
 *       200:
 *         description: Successfully logged out
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: 'Successfully logged out'
 *       500:
 *         description: Internal server error during logout
 */
kolsLeaderboardRouter.post('/auth/logout', logoutUser);


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
 * /kol/auth/twitter/logout:
 *   post:
 *     summary: Logout from Twitter OAuth
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *                 description: The user's ID to log out
 *     responses:
 *       200:
 *         description: Successfully logged out
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing or invalid parameters
 *       500:
 *         description: Error during logout
 */
kolsLeaderboardRouter.post('/auth/twitter/logout', handleTwitterLogout);

/**
 * @swagger
 * /kol/auth/twitter/init:
 *   get:
 *     summary: Get nonce and auth URL for Twitter login (nonce flow)
 *     tags: [Auth]
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
 * /scanner/api/v1/kol/leaderboard/free-trial/start:
 *   post:
 *     summary: Start a new free trial
 *     tags: [Free Trial]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - twitterId
 *             properties:
 *               username:
 *                 type: string
 *                 description: User's username
 *               twitterId:
 *                 type: string
 *                 description: User's Twitter ID
 *     responses:
 *       '201':
 *         description: Free trial started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 postsRemaining:
 *                   type: number
 *                 expiryDate:
 *                   type: string
 *       '400':
 *         description: Invalid input or free trial already used
 *       '500':
 *         description: Server error
 */
// Mount free trial endpoints under /leaderboard
kolsLeaderboardRouter.post('/leaderboard/free-trial/start', freeTrialController.startFreeTrial);

/**
 * @swagger
 * /scanner/api/v1/kol/leaderboard/free-trial/status/{username}:
 *   get:
 *     summary: Get free trial status for a user
 *     tags: [Free Trial]
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to check status for
 *     responses:
 *       '200':
 *         description: Returns free trial status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 hasTrial:
 *                   type: boolean
 *                 postCount:
 *                   type: number
 *                 maxPosts:
 *                   type: number
 *                 postsRemaining:
 *                   type: number
 *                 isExpired:
 *                   type: boolean
 *                 expiryDate:
 *                   type: string
 *                 canPost:
 *                   type: boolean
 *       '400':
 *         description: Username is required
 *       '500':
 *         description: Server error
 */
kolsLeaderboardRouter.get('/leaderboard/free-trial/status/:username', freeTrialController.getTrialStatus);

/**
 * @swagger
 * /scanner/api/v1/kol/leaderboard/user-posts-plans:
 *   get:
 *     summary: Get all posts plans for a user by Twitter ID
 *     tags: [User Posts Plans]
 *     parameters:
 *       - in: query
 *         name: twitter_id
 *         required: true
 *         schema:
 *           type: string
 *         description: Twitter ID of the user
 *     responses:
 *       '200':
 *         description: Returns all posts plans for the user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/UserPostPlan'
 *       '400':
 *         description: Twitter ID is required as a query parameter
 *       '500':
 *         description: Server error
 * 
 * components:
 *   schemas:
 *     UserPostPlan:
 *       type: object
 *       properties:
 *         username:
 *           type: string
 *         twitterId:
 *           type: string
 *         serviceType:
 *           type: string
 *         postsCount:
 *           type: number
 *         postsAllowed:
 *           type: number
 *         expiryDate:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         createdAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         twitterCommunity:
 *           type: string
 */
kolsLeaderboardRouter.get('/leaderboard/user-posts-plans', freeTrialController.getUserPostsPlans);


// Add Google auth routes under /api/kol/auth/google
kolsLeaderboardRouter.get('/auth/google', googleAuthInit);
kolsLeaderboardRouter.get('/auth/google/callback', googleAuthCallback);
kolsLeaderboardRouter.post('/auth/google/verify', verifyGoogleToken);



kolsLeaderboardRouter.get('/me', getCurrentUserProfile);

// Current user's payment history (completed/transferred, grouped by recency)
kolsLeaderboardRouter.get('/auth/payment-history', getCurrentUserPaymentHistory);


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
/**
 * @swagger
 * /kol/users:
 *   get:
 *     summary: Get all users from google_users table
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: Successfully retrieved users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: number
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: number
 *                       email:
 *                         type: string
 *                       name:
 *                         type: string
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                       last_login_at:
 *                         type: string
 *                         format: date-time
 *                       login_count:
 *                         type: number
 *       500:
 *         description: Internal server error
 */
kolsLeaderboardRouter.get('/users', getAllUsers);

export default kolsLeaderboardRouter;