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
// Google OAuth2 callback
export const googleAuthCallback = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { code } = req.query;
        const clientIp = req.ip || req.socket.remoteAddress || '';
        logger.info('Google OAuth callback received', {
            code: code ? 'received' : 'missing',
            clientIp,
            queryParams: Object.keys(req.query)
        });
        if (!code || typeof code !== 'string') {
            logger.error('Missing or invalid authorization code', { code, clientIp });
            return res.status(400).json({ error: 'Authorization code is required' });
        }
        // Exchange code for tokens
        logger.info('Exchanging authorization code for tokens...', { clientIp });
        const tokens = await usersService.getGoogleTokens(code);
        logger.info('Successfully obtained tokens', {
            clientIp,
            hasAccessToken: !!tokens.access_token,
            hasRefreshToken: !!tokens.refresh_token,
            expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'unknown',
            tokenScope: tokens.scope || 'default',
            tokenType: tokens.token_type || 'Bearer'
        });
        // Get user info from Google
        logger.info('Fetching user info from Google...', { clientIp });
        const userInfoResponse = await usersService.getGoogleUserInfo(tokens);
        const userInfo = userInfoResponse.data as GoogleUserInfo;
        // Log additional user info for debugging
        const userInfoLog = {
            userId: userInfo.sub,
            email: userInfo.email,
            emailVerified: userInfo.email_verified,
            name: userInfo.name ? 'present' : 'missing',
            picture: userInfo.picture ? 'present' : 'missing',
            locale: userInfo.locale || 'not provided',
            hd: userInfo.hd || 'not provided',
            clientIp
        };
        logger.info('Received user info from Google', userInfoLog);
        // Prepare user data with all available information
        const userData = {
            sub: userInfo.sub,
            email: userInfo.email,
            name: userInfo.name,
            picture: userInfo.picture,
            locale: userInfo.locale,
            hd: userInfo.hd,
            email_verified: userInfo.email_verified,
            access_token: tokens.access_token || undefined,  // Convert null to undefined
            refresh_token: tokens.refresh_token || undefined, // Convert null to undefined
            token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : undefined,
            last_login_at: new Date().toISOString(),
            current_sign_in_ip: clientIp,
            last_sign_in_ip: clientIp,
            auth_provider: 'google',
            verified: userInfo.email_verified || false,
            // Initialize counters to 0 if they don't exist
            login_count: 0,
            sign_in_count: 0
        };
        // Find or create user
        logger.info('Finding or creating user in database...', { email: userInfo.email, clientIp });
        const user = await usersService.findOrCreateGoogleUser(userData);
        // Log user processing result
        const userLogData = {
            userId: user?.google_id,
            email: user?.email,
            isNewUser: !user?.created_at || (Date.now() - new Date(user.created_at).getTime() < 5000),
            loginCount: user?.login_count,
            lastLogin: user?.last_login_at,
            clientIp
        };
        logger.info('User processed successfully', userLogData);

        // UPDATED: Set real Google opaque tokens as secure HttpOnly cookies
        // This ensures the payment controller gets valid opaque tokens for Google validation
        // For cross-domain testing (frontend/backend on different domains), set sameSite: 'none'
        // and secure: false (for HTTP/local dev). In production, use secure: true and HTTPS.
        // Ensure frontend requests include withCredentials: true and backend CORS allows credentials.
        res.cookie('google_access_token', tokens.access_token, {
            httpOnly: true,  // Prevents JS access (secure)
            secure: false,   // Set to false for cross-domain testing over HTTP; true in prod with HTTPS
            sameSite: 'none', // Allow cross-site requests (required for different domains)
            maxAge: tokens.expiry_date ? tokens.expiry_date - Date.now() : 3600 * 1000  // Match Google's expiry (~1h)
        });
        if (tokens.refresh_token) {
            res.cookie('google_refresh_token', tokens.refresh_token, {
                httpOnly: true,
                secure: false,  // Set to false for cross-domain testing over HTTP; true in prod with HTTPS
                sameSite: 'none', // Allow cross-site requests (required for different domains)
                maxAge: 7 * 24 * 3600 * 1000  // 7 days for refresh
            });
        }
        logger.info('Set Google tokens in cookies', {
            hasAccess: !!tokens.access_token,
            hasRefresh: !!tokens.refresh_token,
            accessExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'unknown',
            clientIp
        });

        console.log(user?.picture, userInfo.picture, "picutre")

        // Prepare user data for URL parameters with manual query string construction
        const params = [];
        if (user?.email) params.push(`email=${encodeURIComponent(user.email)}`);
        if (userInfo?.name) params.push(`name=${encodeURIComponent(userInfo.name)}`);
        if (userInfo?.picture && userInfo.picture.startsWith('http')) {
            // Add picture URL as-is without additional encoding
            params.push(`picture=${userInfo.picture}`);
        }

        // Create redirect URL with user data as query parameters
        const redirectBase = '/dashboard';
        const queryString = params.length > 0 ? `?${params.join('&')}` : '';
        const redirectUrl = `${redirectBase}${queryString}`;

        logger.info('Google authentication completed successfully', {
            user_email: user?.email,
            user_id: user?.google_id,
            redirect_url: redirectUrl
        });

        // Redirect with user data in query parameters
        res.redirect(redirectUrl);
    } catch (error) {
        logger.error('Error in Google auth callback:', {
            error: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
        });
        next(error);
    }
};

// Logout user
export const logoutUser = (req: Request, res: Response) => {
    try {
        // Clear Google auth cookies
        res.clearCookie('google_access_token', {
            httpOnly: true,
            secure: false,  // Should match the settings used when setting the cookie
            sameSite: 'none'
        });

        res.clearCookie('google_refresh_token', {
            httpOnly: true,
            secure: false,  // Should match the settings used when setting the cookie
            sameSite: 'none'
        });

        logger.info('User logged out successfully', {
            clientIp: req.ip || req.socket.remoteAddress || 'unknown'
        });

        res.status(200).json({
            success: true,
            message: 'Successfully logged out'
        });
    } catch (error) {
        logger.error('Error during logout:', {
            error: error instanceof Error ? error.message : 'Unknown error',
            clientIp: req.ip || req.socket.remoteAddress || 'unknown'
        });
        res.status(500).json({
            success: false,
            error: 'An error occurred during logout'
        });
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

        // Ensure required fields are present
        if (!payload?.email) {
            return res.status(400).json({ error: 'Invalid ID token: email is required' });
        }

        const clientIp = req.ip || req.socket.remoteAddress || '';

        const user = await usersService.findOrCreateGoogleUser({
            sub: payload.sub || '',
            email: payload.email,  // This is now guaranteed to be a string
            name: payload.name,
            picture: payload.picture,
            locale: payload.locale,
            hd: payload.hd,
            email_verified: payload.email_verified,
            access_token: undefined,
            refresh_token: undefined,
            token_expiry: undefined,
            last_login_at: new Date().toISOString(),
            current_sign_in_ip: clientIp,
            last_sign_in_ip: clientIp,
            login_count: 0,
            sign_in_count: 0
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

export const getCurrentUserProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Get the access token from cookies
        const accessToken = req.cookies?.google_access_token;
        if (!accessToken) {
            return res.status(401).json({ error: 'No access token provided' });
        }

        const user = await usersService.getCurrentUser(accessToken);
        res.json(user);
    } catch (error: any) {
        logger.error('Error in getCurrentUserProfile:', error);
        if (error.message === 'No email found in token') {
            return res.status(400).json({ error: 'Invalid token: No email found' });
        }
        if (error.message === 'User not found') {
            return res.status(404).json({ error: 'User not found' });
        }
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