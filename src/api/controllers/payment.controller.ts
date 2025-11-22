import { Request, Response } from 'express';
import { walletService } from '../../services/payments/paymentService';
import { logger } from '../../utils/logger';
import { questdbService } from '../../services/questDbService';
import { paymentChecker } from '../../services/payments/paymentChecker';

interface IntrospectionResponse {
    sub: string; // Google's unique user ID (mapped to twitterId)
    email: string;
    email_verified: boolean; // Check for validity
    // From tokeninfo:
    scope: string; // Space-separated scopes
    aud: string; // Must match CLIENT_ID
    exp: number; // Expiration in seconds
    // Custom (if linking to Twitter):
    twitterId?: string; // Optional; fetch from DB if needed
}

// Google-specific token introspection/validation
// Hardcoded Google endpoints for tokeninfo and userinfo
const introspectGoogleToken = async (token: string): Promise<IntrospectionResponse> => {
    logger.debug('Starting Google token introspection', { tokenLength: token?.length || 0 });
    if (!token) {
        const errorMsg = 'Token is missing for introspection';
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }
    logger.debug('Token details', {
        tokenType: token.split('.').length === 3 ? 'JWT' : 'OAuth',
        tokenStart: token.substring(0, 10) + '...',
        tokenLength: token.length
    });
    // Explicitly reject JWTs to enforce Google opaque token validation
    if (token.split('.').length === 3) {
        const errorMsg = 'Invalid token type: JWT detected. Only Google opaque access tokens are supported for validation.';
        logger.error(errorMsg, { tokenStart: token.substring(0, 20) + '...' });
        throw new Error(errorMsg);
    }
    const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    if (!CLIENT_ID) {
        const errorMsg = 'Missing environment variable: GOOGLE_CLIENT_ID';
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }
    try {
        logger.debug('Initiating tokeninfo request to Google', {
            hasClientId: !!CLIENT_ID,
            tokenStart: token.substring(0, 5) + '...' + token.substring(token.length - 5)
        });
        // Step 1: Call tokeninfo for metadata (exp, scope, aud) - hardcoded URL
        const tokenInfoUrl = `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`;
        logger.debug('Fetching token info', { url: tokenInfoUrl });
        const tokenInfoResponse = await fetch(tokenInfoUrl);
        const responseStatus = tokenInfoResponse.status;
        const responseStatusText = tokenInfoResponse.statusText;
        if (!tokenInfoResponse.ok) {
            const errorText = await tokenInfoResponse.text();
            const errorMsg = `Tokeninfo failed: HTTP ${responseStatus} - ${responseStatusText}`;
            logger.error(errorMsg, {
                status: responseStatus,
                statusText: responseStatusText,
                errorDetails: errorText
            });
            throw new Error(errorMsg);
        }
        const tokenInfo: any = await tokenInfoResponse.json();
        logger.debug('Received token info', {
            tokenInfo: {
                aud: tokenInfo.aud,
                exp: tokenInfo.exp,
                scopes: tokenInfo.scope,
                expiresIn: tokenInfo.exp ? `${tokenInfo.exp * 1000 - Date.now()}ms` : 'unknown'
            }
        });
        // Validate tokeninfo fields
        if (tokenInfo.aud !== CLIENT_ID) {
            const errorMsg = `Token audience mismatch: expected ${CLIENT_ID}, got ${tokenInfo.aud}`;
            logger.error(errorMsg, {
                expectedAudience: CLIENT_ID,
                actualAudience: tokenInfo.aud
            });
            throw new Error(errorMsg);
        }
        const tokenExpiration = tokenInfo.exp * 1000;
        const currentTime = Date.now();
        if (tokenExpiration < currentTime) {
            const errorMsg = `Token expired at ${new Date(tokenExpiration).toISOString()}`;
            logger.error(errorMsg, {
                expiredAt: new Date(tokenExpiration).toISOString(),
                currentTime: new Date(currentTime).toISOString()
            });
            throw new Error('Token expired.');
        }
        if (!tokenInfo.scope?.includes('userinfo.email') && !tokenInfo.scope?.includes('payments')) {
            const errorMsg = `Token lacks required scope. Has: ${tokenInfo.scope || 'none'}`;
            logger.error(errorMsg, {
                requiredScopes: ['userinfo.email', 'payments'],
                actualScopes: tokenInfo.scope ? tokenInfo.scope.split(' ') : []
            });
            throw new Error('Token lacks required scope (e.g., userinfo.email or payments).');
        }
        // Step 2: Call userinfo for user data (validates token implicitly) - UPDATED URL to OpenID Connect standard
        logger.debug('Fetching user info from Google');
        const userInfoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {  // FIXED: Correct endpoint
            headers: {
                'Authorization': `Bearer ${token}`  // Only Bearer needed (no Content-Type for GET)
            }
        });
        if (!userInfoResponse.ok) {
            const errorText = await userInfoResponse.text();
            const errorMsg = `Userinfo failed (token invalid): HTTP ${userInfoResponse.status}`;
            logger.error(errorMsg, {
                status: userInfoResponse.status,
                statusText: userInfoResponse.statusText,
                errorDetails: errorText
            });
            throw new Error(errorMsg);
        }
        const userInfo: any = await userInfoResponse.json();
        // NEW: Log full response for debugging (remove after confirming fix)
        logger.debug('Full userinfo response', userInfo);
        logger.debug('Received user info', {
            userId: userInfo.sub,
            email: userInfo.email,
            emailVerified: userInfo.email_verified,
            hasPicture: !!userInfo.picture
        });
        // Validate userinfo
        if (!userInfo.email || !userInfo.sub || !userInfo.email_verified) {
            const errorMsg = 'Invalid userinfo: Missing required fields';
            logger.error(errorMsg, {
                hasEmail: !!userInfo.email,
                hasSub: !!userInfo.sub,
                emailVerified: userInfo.email_verified
            });
            throw new Error('Invalid userinfo: Missing email, sub, or email_verified.');
        }
        const payload: IntrospectionResponse = {
            sub: userInfo.sub,
            email: userInfo.email,
            email_verified: userInfo.email_verified,
            scope: tokenInfo.scope || '',
            aud: tokenInfo.aud,
            exp: tokenInfo.exp,
            // twitterId: fetch from DB if needed, e.g., await getTwitterIdFromSub(userInfo.sub)
        };
        logger.info('Google token successfully introspected', {
            email: payload.email,
            sub: payload.sub,
            emailVerified: payload.email_verified,
            scopes: payload.scope.split(' '),
            expiresIn: `${payload.exp * 1000 - Date.now()}ms`
        });
        return payload;
    } catch (error: any) {
        logger.error('Google introspection failed', { error: error.message, tokenLength: token.length });
        throw error;
    }
};

// -------------------------------------------------------------
type Chain = 'BSC' | 'SOL';

const isValidChain = (chain: any): chain is Chain => {
    return chain === 'BSC' || chain === 'SOL';
};

// Helper to validate Google access or refresh token and extract user data
// Updated for Google: Uses hardcoded endpoints, maps sub to twitterId
// Accepts res for setting new cookies on refresh
const validateAndExtractUser = async (req: Request, res?: Response): Promise<{ twitterId: string, email: string }> => {
    const accessToken = req.cookies?.google_access_token;
    const refreshToken = req.cookies?.google_refresh_token;

    // ENHANCED DEBUGGING: Log presence and lengths of both tokens early
    logger.info('Cookie token check', {
        hasAccess: !!accessToken,
        hasRefresh: !!refreshToken,
        accessLength: accessToken?.length || 0,
        refreshLength: refreshToken?.length || 0,
        accessStart: accessToken ? accessToken.substring(0, 20) + '...' : 'N/A',
        refreshStart: refreshToken ? refreshToken.substring(0, 20) + '...' : 'N/A'
    });

    if (!accessToken && !refreshToken) {
        const errorMsg = 'Authentication required: Access or Refresh token missing from cookies.';
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }
    if (accessToken) {
        logger.info('Google access token found in cookies.', { google_access_token: accessToken.substring(0, 20) + '...' });
    }
    if (refreshToken) {
        logger.info('Google refresh token found in cookies.', { google_refresh_token: refreshToken.substring(0, 20) + '...' });
    }

    let payload: IntrospectionResponse;

    // 1. Try access token first
    if (accessToken) {
        try {
            payload = await introspectGoogleToken(accessToken);
            const { twitterId } = req.body;
            if (!twitterId) {
                const errorMsg = 'Twitter ID is required in the request body';
                logger.error(errorMsg);
                throw new Error(errorMsg);
            }
            logger.debug('Access token validation succeeded; no refresh needed.', { twitterId, email: payload.email });
            return { twitterId, email: payload.email }; // Map sub to twitterId
        } catch (accessError: any) {
            logger.debug('Google access token invalid/expired, attempting refresh token path.', { accessError: accessError.message });
        }
    }

    // 2. Refresh token path (requires res for new cookies)
    if (refreshToken) {
        logger.debug('Entering refresh token exchange flow.', { refreshTokenLength: refreshToken.length });
        if (!res) {
            const errorMsg = 'Response object required for token refresh.';
            logger.error(errorMsg);
            throw new Error(errorMsg);
        }
        const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
        const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
        // Hardcoded Google token endpoint
        const AUTH_REFRESH_URL = 'https://oauth2.googleapis.com/token';
        if (!CLIENT_ID || !CLIENT_SECRET) {
            const errorMsg = 'Missing env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.';
            logger.error(errorMsg);
            throw new Error(errorMsg);
        }
        try {
            // ENHANCED DEBUGGING: Log env vars presence (without values)
            logger.debug('Refresh token exchange setup', {
                hasClientId: !!CLIENT_ID,
                hasClientSecret: !!CLIENT_SECRET,
                refreshTokenStart: refreshToken.substring(0, 20) + '...'
            });

            // Directly exchange refresh token (no introspection for refresh)
            const refreshResponse = await fetch(AUTH_REFRESH_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
                },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken
                }).toString()
            });

            // ENHANCED DEBUGGING: Log full refresh response details
            const responseStatus = refreshResponse.status;
            const responseStatusText = refreshResponse.statusText;
            logger.debug('Refresh token response received', {
                status: responseStatus,
                statusText: responseStatusText,
                ok: refreshResponse.ok
            });

            if (!refreshResponse.ok) {
                const errorText = await refreshResponse.text();
                const errorMsg = `Google refresh failed: HTTP ${responseStatus} - ${responseStatusText}`;
                logger.error(errorMsg, {
                    status: responseStatus,
                    statusText: responseStatusText,
                    errorDetails: errorText,
                    clientId: CLIENT_ID.substring(0, 10) + '...' // Partial for security
                });
                throw new Error(errorMsg);
            }

            const refreshData: any = await refreshResponse.json();
            const { access_token: newAccessToken, refresh_token: newRefreshToken } = refreshData;

            // ENHANCED DEBUGGING: Log new tokens (partial)
            logger.debug('Refresh successful; new tokens issued', {
                newAccessLength: newAccessToken?.length || 0,
                newRefreshLength: newRefreshToken?.length || 0,
                newAccessStart: newAccessToken ? newAccessToken.substring(0, 20) + '...' : 'N/A',
                newRefreshPresent: !!newRefreshToken,
                expiresIn: refreshData.expires_in || 'N/A'
            });

            if (!newAccessToken) {
                const errorMsg = 'Refresh succeeded but no new access token returned.';
                logger.error(errorMsg, { refreshDataKeys: Object.keys(refreshData) });
                throw new Error(errorMsg);
            }

            // Now introspect the NEW access token to get user data
            logger.debug('Introspecting new access token from refresh.');
            payload = await introspectGoogleToken(newAccessToken);

            // UPDATED: Set new tokens in secure HttpOnly cookies
            // For cross-domain testing (frontend/backend on different domains), set sameSite: 'none'
            // and secure: false (for HTTP/local dev). In production, use secure: true and HTTPS.
            // Ensure frontend requests include withCredentials: true and backend CORS allows credentials.
            res.cookie('google_access_token', newAccessToken, {
                httpOnly: true,
                secure: false,  // Set to false for cross-domain testing over HTTP; true in prod with HTTPS
                sameSite: 'none', // Allow cross-site requests (required for different domains)
                maxAge: 3600 * 1000 // 1 hour
            });
            logger.debug('New access token cookie set.', { maxAge: 3600 * 1000 });

            if (newRefreshToken) {
                res.cookie('google_refresh_token', newRefreshToken, {  // FIXED: res.cookie (was res.cookies in some versions)
                    httpOnly: true,
                    secure: false,  // Set to false for cross-domain testing over HTTP; true in prod with HTTPS
                    sameSite: 'none', // Allow cross-site requests (required for different domains)
                    maxAge: 7 * 24 * 3600 * 1000 // 7 days
                });
                logger.debug('New refresh token cookie set.', { maxAge: 7 * 24 * 3600 * 1000 });
            } else {
                logger.warn('Refresh issued new access but no new refresh token; continuing with old one.');
            }

            logger.info('Google refresh successful; new access token issued and cookies updated.', {
                email: payload.email,
                sub: payload.sub,
                newAccessExpiresIn: `${payload.exp * 1000 - Date.now()}ms`
            });

            const { twitterId } = req.body;
            if (!twitterId) {
                const errorMsg = 'Twitter ID is required in the request body';
                logger.error(errorMsg);
                throw new Error(errorMsg);
            }
            return { twitterId, email: payload.email };
        } catch (refreshError: any) {
            logger.error('Google refresh token exchange failed', {
                refreshError: refreshError.message,
                refreshTokenLength: refreshToken.length,
                hasClientSecret: !!process.env.GOOGLE_CLIENT_SECRET
            });
            throw new Error('Session expired or refresh token invalid. Please log in again.');
        }
    }

    // If we reach here, no valid access and no refresh available
    const errorMsg = 'Authentication failed: Both tokens invalid.';
    logger.error(errorMsg, { hasAccess: !!accessToken, hasRefresh: !!refreshToken });
    throw new Error(errorMsg);
};

const generateWalletKeypair = async (req: Request, res: Response): Promise<void> => {
    // twitterId and email are now sourced from the validated token, not the body.
    const { chain, amount, serviceType, wallet, token, twitter_community } = req.body;
    let validatedUser: { twitterId: string, email: string };
    try {
        // Await the asynchronous validation function (pass res for refresh)
        validatedUser = await validateAndExtractUser(req, res);
    } catch (error: any) {
        // Unauthorized access: tokens are invalid or missing
        logger.warn('Token validation failed for wallet generation', { error: error.message });
        res.status(401).json({ error: error.message, redirectToLogin: error.message.includes('Both tokens invalid') || error.message.includes('refresh token invalid') });
        return;
    }
    const twitterId = validatedUser.twitterId; // Use validated ID (now from Google sub)
    const email = validatedUser.email;      // Use validated email
    if (!chain || amount === undefined || !wallet || !token || !twitter_community) {
        logger.warn('Missing required body parameters for wallet generation', req.body);
        res.status(400).json({ error: 'Missing required parameters: chain, amount, wallet, token, and twitter_community are required in the request body.' });
        return;
    }
    if (!isValidChain(chain)) {
        logger.warn(`Invalid chain provided: ${chain}`);
        res.status(400).json({ error: `Unsupported chain: ${chain}. Supported chains are BSC and SOL.` });
        return;
    }
    if (typeof amount !== 'number' || amount <= 0) {
        logger.warn(`Invalid amount provided: ${amount}`);
        res.status(400).json({ error: 'Amount must be a positive number.' });
        return;
    }
    let walletDetails;
    try {
        walletDetails = await walletService.generateAndLogKeyPair(
            chain as Chain,
            twitterId, // Sourced from validated token (Google sub)
            Number(amount),
            serviceType ? String(serviceType) : 'x_alerts_service',
            wallet,
            token,
            twitter_community,
            email // Sourced from validated token
        );
    } catch (error) {
        logger.error('Error generating wallet keypair in controller', { error, chain, twitterId });
        if (error instanceof Error && error.message.includes('Unsupported chain')) {
            res.status(400).json({ error: error.message });
        } else {
            res.status(500).json({ error: 'Internal Server Error during wallet generation.' });
        }
        return;
    }
    // Immediately respond with wallet details (no streaming or waiting)
    res.status(200).json({
        type: 'wallet',
        walletAddress: walletDetails.address,
    });
    logger.info(`[Controller] Wallet generated for ${twitterId}: ${walletDetails.address}`);
};

const getPaymentStatus = async (req: Request, res: Response): Promise<void> => {
    // twitterId is now sourced from the validated token, not the body/query
    const { chain } = req.body;
    let validatedUser: { twitterId: string, email: string };
    try {
        // Await the asynchronous validation function (pass res for refresh)
        validatedUser = await validateAndExtractUser(req, res);
    } catch (error: any) {
        // Unauthorized access: tokens are invalid or missing
        logger.warn('Token validation failed for status check', { error: error.message });
        res.status(401).json({ error: error.message, redirectToLogin: error.message.includes('Both tokens invalid') || error.message.includes('refresh token invalid') });
        return;
    }
    const twitterId = validatedUser.twitterId; // Use validated ID (now from Google sub)
    if (!chain) {
        logger.warn('Missing required chain parameter for status check', req.body);
        res.status(400).json({ error: 'Missing required parameters: chain is required.' });
        return;
    }
    if (!isValidChain(chain)) {
        logger.warn(`Invalid chain provided for status: ${chain}`);
        res.status(400).json({ error: `Unsupported chain: ${chain}. Supported chains are BSC and SOL.` });
        return;
    }
    try {
        // Query for the latest payment entry for this twitterId and chain
        const escTwitterId = String(twitterId).replace(/'/g, "''");
        const statusSql = `
            SELECT amount, serviceType, address, paymentStatus, status, token, twitter_community
            FROM payment_history
            WHERE twitterId = '${escTwitterId}' AND chain = '${chain}'
            ORDER BY timestamp DESC LIMIT 1;
        `;
        const statusRes = await questdbService.query(statusSql);
        if (statusRes.rows.length === 0) {
            res.status(404).json({ error: 'No payment found for the authenticated user and chain.' });
            return;
        }
        const [amount, serviceType, address, paymentStatus, dbStatus, token, twitter_community] = statusRes.rows[0];
        if (dbStatus === 'completed') {
            // Already completed
            res.status(200).json({
                type: 'status',
                status: 'COMPLETED',
                address: address,
                transactionId: `TX_${chain}_${Date.now()}`,
            });
            return;
        }
        // If pending, perform a single check
        const confirmed = await paymentChecker.checkPaymentOnce(
            chain as Chain,
            twitterId, // Sourced from validated token (Google sub)
            Number(amount),
            String(serviceType),
            String(address),
            String(token),
            String(twitter_community)
        );
        if (confirmed) {
            res.status(200).json({
                type: 'status',
                status: 'COMPLETED',
                address: address,
                transactionId: `TX_${chain}_${Date.now()}`,
            });
        } else {
            res.status(200).json({
                type: 'status',
                status: 'PENDING',
                address: address,
                transactionId: 'N/A',
            });
        }
        logger.info(`[Controller] Status checked for ${twitterId} (${chain}): ${confirmed ? 'confirmed' : 'pending'}`);
    } catch (error) {
        logger.error('Error checking payment status', { error, twitterId, chain });
        res.status(500).json({ error: 'Internal Server Error during status check.' });
    }
};

export { generateWalletKeypair, getPaymentStatus };