// src/api/controllers/user.controller.ts
import { Request, Response, NextFunction } from 'express';
import { usersService, getGoogleAuthUrl, GoogleUserInfo } from '../../services/usersService';
import { logger } from '../../utils/logger';

// Extend Express Request type to include user
declare global {
    namespace Express {
        interface Request {
            user?: any; // You might want to replace 'any' with your User type
        }
    }
}

// Google OAuth2 flow
export const googleAuthInit = (req: Request, res: Response) => {
    try {
        const authUrl = getGoogleAuthUrl();
        res.redirect(authUrl);
    } catch (error) {
        logger.error('Error initializing Google auth:', error);
        res.status(500).json({ error: 'Failed to initialize Google authentication' });
    }
};

// Google OAuth2 callback
export const googleAuthCallback = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { code } = req.query;
        logger.info('Google OAuth callback received', {
            code: code ? 'received' : 'missing',
            queryParams: Object.keys(req.query)
        });

        if (!code || typeof code !== 'string') {
            logger.error('Missing or invalid authorization code', { code });
            return res.status(400).json({ error: 'Authorization code is required' });
        }

        // Exchange code for tokens
        logger.info('Exchanging authorization code for tokens...');
        const tokens = await usersService.getGoogleTokens(code);
        logger.info('Successfully obtained tokens', {
            access_token: tokens.access_token ? 'present' : 'missing',
            refresh_token: tokens.refresh_token ? 'present' : 'missing',
            expires_in: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'unknown'
        });

        // Get user info from Google
        logger.info('Fetching user info from Google...');
        const userInfoResponse = await usersService.getGoogleUserInfo(tokens);
        const userInfo = userInfoResponse.data as GoogleUserInfo;
        logger.info('Received user info from Google', {
            user_id: userInfo.sub,
            email: userInfo.email,
            email_verified: userInfo.email_verified,
            name: userInfo.name ? 'present' : 'missing',
            picture: userInfo.picture ? 'present' : 'missing'
        });

        // Find or create user
        logger.info('Finding or creating user in database...');
        const user = await usersService.findOrCreateGoogleUser({
            sub: userInfo.sub,
            email: userInfo.email,
            name: userInfo.name,
            picture: userInfo.picture
        });
        logger.info('User processed successfully', {
            user_id: user?.google_id,
            email: user?.email,
            is_new_user: !user?.created_at || (Date.now() - new Date(user.created_at).getTime() < 5000)
        });

        // Prepare response
        const response = {
            message: 'Successfully authenticated with Google',
            user: {
                id: user?.google_id,
                email: user?.email,
                name: user?.name,
                picture: user?.picture,
                verified: user?.verified
            },
            // In production, you would return a secure token instead
            // token: generateJwtToken(user)
        };

        logger.info('Google authentication completed successfully', {
            user_email: user?.email,
            user_id: user?.google_id
        });

        res.json(response);
    } catch (error) {
        logger.error('Error in Google auth callback:', {
            error: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
        });
        next(error);
    }
};

// Verify Google ID token (for client-side auth)
export const verifyGoogleToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { idToken } = req.body;

        if (!idToken) {
            return res.status(400).json({ error: 'ID token is required' });
        }

        const payload = await usersService.verifyGoogleToken(idToken);
        const user = await usersService.findOrCreateGoogleUser({
            sub: payload?.sub,
            email: payload?.email,
            name: payload?.name,
            picture: payload?.picture
        });

        res.json({
            success: true,
            user: {
                id: user?.google_id,
                email: user?.email,
                name: user?.name,
                picture: user?.picture,
                verified: user?.verified
            }
        });
    } catch (error) {
        logger.error('Error verifying Google token:', error);
        next(error);
    }
};

// Get current user
export const getCurrentUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        res.json({ user: req.user });
    } catch (error) {
        logger.error('Error getting current user:', error);
        next(error);
    }
};

// Error handler for authentication
export const handleAuthError = (error: Error, req: Request, res: Response, next: NextFunction) => {
    if (error.message === 'Invalid Google token') {
        return res.status(401).json({
            success: false,
            error: 'Invalid or expired authentication token'
        });
    }
    next(error);
};

// Export all auth-related routes
export const authRoutes = (router: any) => {
    // Google OAuth flow
    router.get('/auth/google', googleAuthInit);
    router.get('/auth/google/callback', googleAuthCallback);

    // Token verification (for client-side auth)
    router.post('/auth/google/verify', verifyGoogleToken);

    // Get current user
    router.get('/auth/me', getCurrentUser);
};