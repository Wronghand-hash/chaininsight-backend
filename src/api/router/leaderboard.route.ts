import { Router, Request, Response, NextFunction } from 'express';
import { getKolLeaderboards } from '../controllers/leaderboard.controller';
import { getTokenDetails } from '../controllers/tokenInfo.controller';
import { kolTradeService } from '../services/kolsActivity.service';
import {
    generateTwitterLoginUrl,
    handleTwitterCallback,
    handleTwitterExchange // Added for the PKCE exchange step
} from '../services/twitter.auth';

const kolsLeaderboardRouter = Router();

/**
 * @swagger
 * /kol/leaderboard:
 * get:
 * summary: Get KOL leaderboards for a specific token
 * tags: [KOL Leaderboard]
 * parameters:
 * - in: query
 * name: contractAddress
 * required: true
 * schema:
 * type: string
 * description: The contract address of the token
 * - in: query
 * name: chain
 * schema:
 * type: string
 * default: BSC
 * description: The blockchain network (e.g., BSC, ETH)
 * responses:
 * 200:
 * description: Successfully retrieved KOL leaderboards
 * content:
 * application/json:
 * schema:
 * $ref: '#/components/schemas/KolLeaderboardResponse'
 * 400:
 * description: Invalid input parameters
 * 500:
 * description: Internal server error
 */
kolsLeaderboardRouter.get('/leaderboard', getKolLeaderboards);

/**
 * @swagger
 * /kol/info:
 * get:
 * summary: Get aggregated token details
 * tags: [Token Info]
 * parameters:
 * - in: query
 * name: contractAddress
 * required: true
 * schema:
 * type: string
 * description: The contract address of the token
 * responses:
 * 200:
 * description: Successfully retrieved token details
 * content:
 * application/json:
 * schema:
 * $ref: '#/components/schemas/TokenInfoResponse'
 * 400:
 * description: Invalid contract address
 * 404:
 * description: Token not found
 * 500:
 * description: Internal server error
 */
kolsLeaderboardRouter.get('/info', getTokenDetails);

/**
 * @swagger
 * /kol/top-tokens:
 * get:
 * summary: Get top tokens by KOL trading activity
 * tags: [KOL Trades]
 * parameters:
 * - in: query
 * name: period
 * required: true
 * schema:
 * type: string
 * enum: [1h, 24h, 1w]
 * description: Time period for filtering trades (1h, 24h, or 1w)
 * - in: query
 * name: limit
 * schema:
 * type: integer
 * default: 10
 * minimum: 1
 * maximum: 100
 * description: Number of top tokens to return
 * - in: query
 * name: chain
 * schema:
 * type: string
 * enum: [BSC, ETH, SOL]
 * description: Optional chain filter
 * responses:
 * 200:
 * description: Successfully retrieved top tokens by KOL activity
 * content:
 * application/json:
 * schema:
 * type: array
 * items:
 * $ref: '#/components/schemas/TopTokenResponse'
 * 400:
 * description: Invalid input parameters
 * 500:
 * description: Internal server error
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
 * get:
 * summary: Get nonce and auth URL for Twitter login (nonce flow)
 * tags: [Auth]
 * parameters:
 * - in: query
 * name: redirectUri
 * required: true
 * schema:
 * type: string
 * description: Client callback URI (e.g., yourapp.com/twitter-callback)
 * responses:
 * 200:
 * description: Nonce and auth URL
 * content:
 * application/json:
 * schema:
 * type: object
 * properties:
 * url: { type: string, description: "The URL to redirect the user to for Twitter authorization." }
 * state: { type: string, description: "CSRF state/nonce token, returned by Twitter redirect, used for verification." }
 * codeVerifier: { type: string, description: "PKCE secret, must be stored client-side temporarily for the /exchange step." }
 * 400:
 * description: Missing redirectUri
 * 500:
 * description: Failed to generate
 */
kolsLeaderboardRouter.get('/auth/twitter/init', generateTwitterLoginUrl);

/**
 * @swagger
 * /kol/auth/twitter/exchange:
 * post:
 * summary: Exchange Twitter authorization code for access tokens (nonce/PKCE flow)
 * tags: [Auth]
 * requestBody:
 * required: true
 * content:
 * application/json:
 * schema:
 * type: object
 * required:
 * - code
 * - codeVerifier
 * - redirectUri
 * properties:
 * code:
 * type: string
 * description: The authorization code received from Twitter's redirect.
 * codeVerifier:
 * type: string
 * description: The PKCE code verifier generated during the /init step.
 * redirectUri:
 * type: string
 * description: The original redirect URI used in the /init request.
 * responses:
 * 200:
 * description: Successfully exchanged code for authentication tokens and user info.
 * content:
 * application/json:
 * schema:
 * type: object
 * properties:
 * authToken: { type: string, description: "Your application's internal JWT or session token." }
 * twitterId: { type: string, description: "The authenticated user's Twitter ID." }
 * username: { type: string, description: "The authenticated user's Twitter username." }
 * 400:
 * description: Invalid code, codeVerifier, or missing required fields.
 * 500:
 * description: Token exchange failed or internal server error.
 */
kolsLeaderboardRouter.post('/auth/twitter/exchange', handleTwitterExchange);

/**
 * @swagger
 * /kol/auth/twitter/login:
 * get:
 * summary: Generate Twitter OAuth2 login URL (legacy/redirect flow)
 * tags: [Auth]
 * parameters:
 * - in: query
 * name: redirectUri
 * required: true
 * schema:
 * type: string
 * description: Callback URL after Twitter auth (must match app settings)
 * responses:
 * 200:
 * description: Twitter login URL generated
 * content:
 * application/json:
 * schema:
 * type: object
 * properties:
 * url:
 * type: string
 * state:
 * type: string
 * 400:
 * description: Missing redirectUri
 * 500:
 * description: Failed to generate URL
 */
kolsLeaderboardRouter.get('/auth/twitter/login', generateTwitterLoginUrl);

/**
 * @swagger
 * /kol/auth/twitter/callback:
 * get:
 * summary: Handle Twitter OAuth2 callback (server-side, legacy)
 * tags: [Auth]
 * parameters:
 * - in: query
 * name: code
 * required: true
 * schema:
 * type: string
 * description: Authorization code from Twitter
 * - in: query
 * name: state
 * required: true
 * schema:
 * type: string
 * description: CSRF state token
 * - in: query
 * name: redirectUri
 * schema:
 * type: string
 * description: Optional callback URI
 * responses:
 * 302:
 * description: Redirect to dashboard on success, or login with error
 */
kolsLeaderboardRouter.get('/auth/twitter/callback', handleTwitterCallback);

export default kolsLeaderboardRouter;
