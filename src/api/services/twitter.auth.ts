// twitter.auth.ts
import { Request, Response, NextFunction } from 'express';
import { twitterService } from '../../services/twitterService'; // Adjust path as needed
import { logger } from '../../utils/logger'; // Assuming logger is available; adjust path if needed

// CRITICAL: Define the required, registered HTTPS ngrok URI once for consistency
const NGROK_REDIRECT_URI = 'https://tiesha-postrorse-blindfoldedly.ngrok-free.dev/scanner/api/v1/kol/auth/twitter/callback';

// 1. Get nonce/auth URL (init for nonce flow)
export const generateTwitterLoginUrl = async (req: Request, res: Response): Promise<void> => {
    try {
        const redirectUri = NGROK_REDIRECT_URI;
        logger.debug('generateTwitterLoginUrl: Final processed redirectUri:', redirectUri);

        const scopes = ['users.read', 'tweet.read', "tweet.write"];
        logger.debug('generateTwitterLoginUrl: Using scopes:', scopes);

        const { url, state, codeVerifier } = await twitterService.generateLoginUrl(redirectUri, scopes);
        logger.debug('generateTwitterLoginUrl: Generated login URL, state:', state.substring(0, 10) + '...', 'codeVerifier length:', codeVerifier.length);

        res.json({ url, state, codeVerifier });
        logger.debug('generateTwitterLoginUrl: Response sent successfully');
    } catch (error: any) {
        logger.error('generateTwitterLoginUrl: Error generating Twitter login URL:', error);
        res.status(500).json({ error: 'Failed to generate Twitter login URL' });
    }
};

// 2. Exchange code for tokens (client-side flow)
export const handleTwitterExchange = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { code, state, codeVerifier } = req.body;
        logger.debug('handleTwitterExchange: Received code length:', code?.length, 'state:', state?.substring(0, 10) + '...', 'codeVerifier length:', codeVerifier?.length);

        const finalRedirectUri = NGROK_REDIRECT_URI;
        logger.debug('handleTwitterExchange: Using finalRedirectUri:', finalRedirectUri);

        const result = await twitterService.handleLoginCallback(code, codeVerifier, state, finalRedirectUri);
        logger.debug('handleTwitterExchange: Token exchange successful, username:', result.username);

        // Include refreshToken in the response if available
        const response = {
            ...result,
            // Don't expose the refresh token in the response for security
            refreshToken: undefined
        };
        res.json(response);
        logger.debug('handleTwitterExchange: Response sent successfully');
    } catch (error: any) {
        logger.error('handleTwitterExchange: Error exchanging Twitter code:', error);
        res.status(400).json({ error: error.message || 'Token exchange failed' });
    }
};

// 3. Server-side redirect flow callback
export const handleTwitterCallback = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { code, state } = req.query;
        logger.debug('handleTwitterCallback: Received code length:', code?.length, 'state:', state?.toString().substring(0, 10) + '...');

        if (!code || typeof code !== 'string' || !state || typeof state !== 'string') {
            logger.warn('handleTwitterCallback: Missing or invalid params, redirecting with error');
            res.redirect(`${process.env.CLIENT_URL || 'https://xalerts.vercel.app/'}/login?error=missing_params`);
            return;
        }

        const codeVerifier = await twitterService.getCodeVerifier(state as string);
        logger.debug('handleTwitterCallback: Retrieved codeVerifier length:', codeVerifier?.length);

        if (!codeVerifier) {
            // This indicates the stored nonce (PKCE secret) was not found (session expired, etc.)
            logger.error('handleTwitterCallback: CodeVerifier not found for state:', state);
            res.redirect(`${process.env.CLIENT_URL || 'https://xalerts.vercel.app/'}/login?error=session_expired_or_pkce_missing`);
            return;
        }

        const redirectUri = NGROK_REDIRECT_URI;
        logger.debug('handleTwitterCallback: Using redirectUri for exchange:', redirectUri);

        const result = await twitterService.handleLoginCallback(code as string, codeVerifier, state as string, redirectUri);
        logger.debug('handleTwitterCallback: Callback successful, username:', result.username);

        // Redirect to client dashboard with success
        // Note: We don't include the refresh token in the URL for security
        const clientUrl = `${process.env.CLIENT_URL || 'https://xalerts.vercel.app'}/dashboard?success=true&username=${result.username}&userId=${result.userId}`;
        logger.debug('handleTwitterCallback: Redirecting to client URL:', clientUrl);
        res.redirect(clientUrl);
    } catch (error: any) {
        logger.error('handleTwitterCallback: Error handling Twitter callback:', error);
        res.redirect(`${process.env.CLIENT_URL || 'https://xalerts.vercel.app/dashboard'}/login?error=auth_failed`);
    }
};

/**
 * Handles Twitter OAuth logout
 * Revokes the user's Twitter tokens and clears the session
 */
export const handleTwitterLogout = async (req: Request, res: Response): Promise<void> => {
    try {
        const { userId } = req.body;

        if (!userId) {
            logger.warn('handleTwitterLogout: Missing userId in request');
            res.status(400).json({ error: 'User ID is required' });
            return;
        }

        logger.debug(`handleTwitterLogout: Attempting to log out user ${userId}`);
        const success = await twitterService.logout(userId);

        if (success) {
            logger.info(`handleTwitterLogout: Successfully logged out user ${userId}`);
            res.status(200).json({ success: true, message: 'Successfully logged out' });
        } else {
            logger.warn(`handleTwitterLogout: Failed to log out user ${userId}`);
            res.status(500).json({ error: 'Failed to log out' });
        }
    } catch (error: any) {
        logger.error('handleTwitterLogout: Error during logout:', error);
        res.status(500).json({ error: 'An error occurred during logout' });
    }
};