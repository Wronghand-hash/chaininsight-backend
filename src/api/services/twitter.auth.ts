// twitter.auth.ts
import { Request, Response, NextFunction } from 'express';
import { twitterService } from '../../services/twitterService'; // Adjust path as needed
import { logger } from '../../utils/logger'; // Assuming logger is available; adjust path if needed

// CRITICAL: Define the required, registered HTTPS ngrok URI once for consistency
const NGROK_REDIRECT_URI = 'https://tiesha-postrorse-blindfoldedly.ngrok-free.dev/api/v1/kol/auth/twitter/callback';

// 1. Get nonce/auth URL (init for nonce flow)
export const generateTwitterLoginUrl = async (req: Request, res: Response): Promise<void> => {
    try {
        // CRITICAL FIX: Standardize redirectUri to the constant NGROK_REDIRECT_URI.
        // This ensures the URI used in the initial request exactly matches the one in the token exchange.
        const redirectUri = NGROK_REDIRECT_URI;
        logger.debug('generateTwitterLoginUrl: Final processed redirectUri:', redirectUri);

        const scopes = ['users.read' , 'tweet.read'];
        logger.debug('generateTwitterLoginUrl: Using scopes:', scopes);

        // The service generates the state and codeVerifier and stores the verifier internally
        const { url, state, codeVerifier } = twitterService.generateLoginUrl(redirectUri, scopes);
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

        // Use the single registered HTTPS ngrok URI for the exchange step
        const finalRedirectUri = NGROK_REDIRECT_URI;
        logger.debug('handleTwitterExchange: Using finalRedirectUri:', finalRedirectUri);

        const result = await twitterService.handleLoginCallback(code, codeVerifier, state, finalRedirectUri);
        logger.debug('handleTwitterExchange: Token exchange successful, username:', result.username);

        res.json(result);
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
            res.redirect(`${process.env.CLIENT_URL || 'http://127.0.0.1:3000'}/login?error=missing_params`);
            return;
        }

        // Retrieve the codeVerifier using the state from the service
        const codeVerifier = twitterService.getCodeVerifier(state as string);
        logger.debug('handleTwitterCallback: Retrieved codeVerifier length:', codeVerifier?.length);

        if (!codeVerifier) {
            // This indicates the stored nonce (PKCE secret) was not found (session expired, etc.)
            logger.error('handleTwitterCallback: CodeVerifier not found for state:', state);
            res.redirect(`${process.env.CLIENT_URL || 'http://127.0.0.1:3000'}/login?error=session_expired_or_pkce_missing`);
            return;
        }

        // Use the single registered HTTPS ngrok URI for the token exchange
        const redirectUri = NGROK_REDIRECT_URI;
        logger.debug('handleTwitterCallback: Using redirectUri for exchange:', redirectUri);

        // Complete the PKCE exchange
        const result = await twitterService.handleLoginCallback(code as string, codeVerifier, state as string, redirectUri);
        logger.debug('handleTwitterCallback: Callback successful, username:', result.username);

        // Redirect to client dashboard with success
        const clientUrl = `${process.env.CLIENT_URL || 'http://127.0.0.1:3000'}/dashboard?success=true&username=${result.username}`;
        logger.debug('handleTwitterCallback: Redirecting to client URL:', clientUrl);
        res.redirect(clientUrl);
    } catch (error: any) {
        logger.error('handleTwitterCallback: Error handling Twitter callback:', error);
        res.redirect(`${process.env.CLIENT_URL || 'http://127.0.0.1:3000'}/login?error=auth_failed`);
    }
};