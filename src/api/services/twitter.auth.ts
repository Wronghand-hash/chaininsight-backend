// controllers/auth.controller.ts
import { Request, Response, NextFunction } from 'express';
import { twitterService } from '../../services/twitterService';

export const generateTwitterLoginUrl = async (req: Request, res: Response): Promise<void> => {
    try {
        const { redirectUri } = req.query;
        if (!redirectUri || typeof redirectUri !== 'string') {
            res.status(400).json({ error: 'redirectUri query parameter is required' });
            return;
        }

        const scopes = ['users.read', 'tweet.read', 'tweet.write', 'offline.access']; // Default scopes; can be customized via query if needed
        const { url, state, codeVerifier, codeChallenge } = twitterService.generateLoginUrl(redirectUri, scopes);

        // In a real app, store state and codeVerifier securely (e.g., in Redis or session store) keyed by a session ID
        // For example: await redis.set(`twitter_auth:${state}`, codeVerifier, 'EX', 600); // 10 min expiry
        // Return state to client for verification if needed, but handle storage server-side

        res.json({
            url,
            state, // Client can store this for callback verification
        });
    } catch (error: any) {
        console.error('Error generating Twitter login URL:', error);
        res.status(500).json({ error: 'Failed to generate Twitter login URL' });
    }
};

export const handleTwitterCallback = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { code, state } = req.query;
        if (!code || typeof code !== 'string' || !state || typeof state !== 'string') {
            res.redirect(`${process.env.CLIENT_URL || 'http://127.0.0.1:3000'}/login?error=missing_params`);
            return;
        }

        // Retrieve stored codeVerifier (e.g., from Redis: const codeVerifier = await redis.get(`twitter_auth:${state}`);)
        // For demo, assuming you have a way to retrieve it; replace with actual storage logic
        // const codeVerifier = req.session?.codeVerifier || ''; // If using express-session
        // If no storage, this would fail – implement properly
        const codeVerifier = 'retrieved_from_storage'; // Placeholder – implement retrieval

        const redirectUri = req.query.redirectUri as string || 'http://http://127.0.0.1:3000/api/v1/kol/auth/twitter/callback'; // Or from config

        const result = await twitterService.handleLoginCallback(code, codeVerifier, redirectUri);

        // Store tokens securely (e.g., in DB associated with user)
        // Create session/JWT: e.g., const sessionToken = generateJWT({ username: result.username, ... });
        // Invalidate temp storage: await redis.del(`twitter_auth:${state}`);

        // Redirect to client dashboard with success (or return JSON if API-only)
        const clientUrl = `${process.env.CLIENT_URL || 'http://127.0.0.1:3000'}/dashboard?success=true&username=${result.username}`;
        res.redirect(clientUrl);
    } catch (error: any) {
        console.error('Error handling Twitter callback:', error);
        res.redirect(`${process.env.CLIENT_URL || 'http://127.0.0.1:3000'}/login?error=auth_failed`);
    }
};