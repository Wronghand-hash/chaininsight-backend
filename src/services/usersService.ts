import { OAuth2Client } from 'google-auth-library';
import { questdbService } from './questDbService';
import { logger } from '../utils/logger';
/**
 * Interface for Google's user information payload.
 */
export interface GoogleUserInfo {
    sub: string;
    email: string;
    name?: string;
    picture?: string;
    email_verified?: boolean;
    locale?: string;
    hd?: string;
    given_name?: string;
    family_name?: string;
}
/**
 * Interface for a User object stored in the database.
 */
export interface User {
    username: string;
    email: string;
    verified: boolean;
    created_at?: string;
    updated_at?: string;
    twitter_addresses: string[];
    google_id?: string;
    name?: string;
    picture?: string;
    access_token?: string;
    refresh_token?: string;
    token_expiry?: string;
    last_login_at?: string;
    login_count?: number;
    locale?: string;
    hd?: string;
    auth_provider?: string;
    current_sign_in_ip?: string;
    last_sign_in_ip?: string;
    sign_in_count?: number;
    tos_accepted_at?: string;
    email_verified?: boolean;
}
// Initialize OAuth2 client with credentials
const googleClient = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://api.hypeignite.io/scanner/api/v1/kol/auth/google/callback"
);
/**
 * Generates the Google OAuth URL for sign-in.
 * @returns The Google authorization URL.
 */
export const getGoogleAuthUrl = (): string => {
    return googleClient.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email'
        ],
        prompt: 'consent' // Force to get refresh token
    });
};
export class UsersService {
    // --- Google OAuth Methods ---
    /**
     * Verifies a Google ID token.
     * @param idToken The ID token from Google.
     * @returns The token payload.
     */
    async verifyGoogleToken(idToken: string) {
        try {
            const ticket = await googleClient.verifyIdToken({
                idToken,
                audience: process.env.GOOGLE_CLIENT_ID,
            });
            return ticket.getPayload();
        } catch (error) {
            logger.error('Google ID token verification failed:', error);
            throw new Error('Invalid Google token');
        }
    }
    /**
     * Exchanges an authorization code for access and refresh tokens.
     * @param code The authorization code from Google redirect.
     * @returns The tokens object.
     */
    async getGoogleTokens(code: string) {
        try {
            const { tokens } = await googleClient.getToken(code);
            return tokens;
        } catch (error) {
            logger.error('Error getting Google tokens:', error);
            throw new Error('Failed to get Google tokens');
        }
    }
    /**
     * Retrieves user profile information from Google.
     * @param tokens The access and refresh tokens.
     * @returns The user info object from Google.
     */
    async getGoogleUserInfo(tokens: any) {
        try {
            googleClient.setCredentials(tokens);
            const userInfo = await googleClient.request({
                url: 'https://www.googleapis.com/oauth2/v3/userinfo'
            });
            return userInfo; // The library response has data property
        } catch (error) {
            logger.error('Error getting Google user info:', error);
            throw new Error('Failed to get user info from Google');
        }
    }
    /**
     * Validates a Google access token and returns user info.
     * @param token The Google access token.
     * @returns The user info payload.
     */
    private async introspectGoogleToken(token: string): Promise<any> {
        if (!token) {
            throw new Error('Token is missing for introspection');
        }
        const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
        if (!CLIENT_ID) {
            throw new Error('Missing environment variable: GOOGLE_CLIENT_ID');
        }
        try {
            // Use the tokeninfo endpoint to validate and get basic info
            const tokenInfoUrl = `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`;
            const tokenInfoResponse = await fetch(tokenInfoUrl, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });
            const responseText = await tokenInfoResponse.text();
            if (!tokenInfoResponse.ok) {
                // Token is invalid/expired, throw error to trigger refresh flow in getCurrentUser
                throw new Error(`Token validation failed: ${responseText}`);
            }
            const tokenInfo = JSON.parse(responseText);
            // Validate token audience
            if (tokenInfo.aud !== CLIENT_ID) {
                throw new Error(`Token audience mismatch: expected ${CLIENT_ID}, got ${tokenInfo.aud}`);
            }
            // Check token expiration (exp is in seconds)
            const tokenExpiration = tokenInfo.exp * 1000;
            if (tokenExpiration < Date.now()) {
                throw new Error(`Token expired at ${new Date(tokenExpiration).toISOString()}`);
            }
            // Fetch full user info using the token for more details
            const userInfoUrl = 'https://www.googleapis.com/oauth2/v3/userinfo';
            const userInfoResponse = await fetch(userInfoUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!userInfoResponse.ok) {
                throw new Error('Failed to fetch user info from Google');
            }
            const userInfo = await userInfoResponse.json();
            return {
                ...tokenInfo,
                ...userInfo
            };
        } catch (error: any) {
            logger.error('Token introspection failed', { error: error.message });
            throw new Error(`Authentication failed: ${error.message}`);
        }
    }
    /**
     * Fetches the current user, attempting to refresh the token if necessary.
     * @param accessToken Current access token.
     * @param refreshToken Refresh token (optional).
     * @returns The user object from the database.
     */
    getCurrentUser = async (accessToken: string, refreshToken?: string): Promise<User> => {
        try {
            // 1. First try with the current access token
            try {
                const payload = await this.introspectGoogleToken(accessToken);
                return await this.getUserFromDatabase(payload.email);
            } catch (accessError: any) {
                logger.debug('Access token validation failed, attempting refresh...', { error: accessError.message });
                // 2. If we have a refresh token, try to get a new access token
                if (refreshToken) {
                    logger.info('Attempting to refresh access token...');
                    const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
                    const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
                    if (!CLIENT_ID || !CLIENT_SECRET) {
                        throw new Error('Missing Google OAuth configuration');
                    }
                    const tokenUrl = 'https://oauth2.googleapis.com/token';
                    const response = await fetch(tokenUrl, {
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
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(`Token refresh failed: ${response.status} - ${response.statusText}: ${errorText}`);
                    }
                    const refreshData = await response.json();
                    const { access_token: newAccessToken } = refreshData;
                    if (!newAccessToken) {
                        throw new Error('No access token in refresh response');
                    }
                    // Verify the new access token
                    const payload = await this.introspectGoogleToken(newAccessToken);
                    // Return the user data
                    return await this.getUserFromDatabase(payload.email);
                }
                // If no refresh token, re-throw the original error
                throw accessError;
            }
        } catch (error: any) {
            logger.error('Error in getCurrentUser', { error: error.message });
            throw error;
        }
    };
    // --- Database Helper Methods (QuestDB) ---
    /**
     * Maps a QuestDB row array to the User interface.
     * NOTE: This relies on a strict, pre-determined column order in the DB table.
     * @param row A single row array from QuestDB query result.
     * @returns A partial User object.
     */
    private mapUserRow(row: any[]): User {
        return {
            created_at: row[0],
            username: row[1],
            email: row[2],
            verified: Boolean(row[3]),
            updated_at: row[4],
            twitter_addresses: JSON.parse(row[5] || '[]'),
            google_id: row[6],
            name: row[7],
            picture: row[8],
            access_token: row[9],
            refresh_token: row[10],
            token_expiry: row[11],
            last_login_at: row[12],
            login_count: row[13] ? Number(row[13]) : 0,
            locale: row[14],
            hd: row[15],
            auth_provider: row[16] || 'google',
            current_sign_in_ip: row[17],
            last_sign_in_ip: row[18],
            sign_in_count: row[19] ? Number(row[19]) : 0,
            tos_accepted_at: row[20],
            email_verified: Boolean(row[21])
        };
    }
    /**
     * Fetches a user from the database by email.
     * @param email The user's email.
     * @returns The User object or null if not found.
     */
    async getUserByEmail(email: string): Promise<User | null> {
        try {
            logger.debug(`getUserByEmail: Starting fetch for email "${email}"`);
            const safeEmail = email.replace(/'/g, "''");
            const sql = `SELECT * FROM google_users WHERE email = '${safeEmail}' ORDER BY created_at DESC LIMIT 1;`;
            logger.debug(`getUserByEmail: Generated SQL: ${sql}`);
            const result = await questdbService.query(sql);
            logger.debug(`getUserByEmail: Raw result structure: { rowsLength: ${result.rows?.length || 'undefined'}, hasError: ${!!result}, sampleRowEmail: ${result.rows?.[0]?.[2] || 'none'} }`);
            if (result.rows.length === 0) {
                logger.debug(`getUserByEmail: No rows found for email "${email}"`);
                return null;
            }
            const mappedUser = this.mapUserRow(result.rows[0]);
            logger.debug(`getUserByEmail: Successfully mapped user with email "${mappedUser.email}"`);

            // Exclude sensitive fields from the response
            const { access_token, refresh_token, ...safeUser } = mappedUser;
            return safeUser;
        } catch (error) {
            logger.error(`Error fetching user by email ${email}:`, error);
            throw error;
        }
    }
    /**
     * Fetches a user from the database by Google ID.
     * @param googleId The user's Google ID.
     * @returns The User object or null if not found.
     */
    private async getUserByGoogleId(googleId: string): Promise<User | null> {
        try {
            const safeGoogleId = googleId.replace(/'/g, "''");
            const sql = `SELECT * FROM google_users WHERE google_id = '${safeGoogleId}' ORDER BY created_at DESC LIMIT 1;`;
            const result = await questdbService.query(sql);
            if (result.rows.length === 0) return null;
            return this.mapUserRow(result.rows[0]);
        } catch (error) {
            logger.error(`Error fetching user by Google ID ${googleId}:`, error);
            throw error;
        }
    }
    /**
     * Private helper to fetch user from DB and throw an error if not found.
     * @param email The user's email.
     * @returns The User object.
     */
    private async getUserFromDatabase(email: string): Promise<User> {
        if (!email) {
            throw new Error('No email provided for database lookup');
        }
        const user = await this.getUserByEmail(email);
        if (!user) {
            logger.warn('User not found in database', { email });
            throw new Error('User not found');
        }
        logger.info('Successfully retrieved user from database', {
            email: user.email,
            username: user.username
        });
        return user;
    }
    // --- User Management Methods ---
    /**
     * Finds a user by google_id or email, or creates a new user.
     * Updates user information on subsequent logins.
     * @param googleUser User data from Google and OAuth tokens.
     * @returns The newly created or updated User object.
     */
    async findOrCreateGoogleUser(googleUser: GoogleUserInfo & Partial<User>): Promise<User> {
        try {
            // Log 1: Function start and received data
            logger.debug('Starting findOrCreateGoogleUser for sub:', googleUser.sub, 'email:', googleUser.email);
            if (!googleUser.sub || !googleUser.email) {
                // Log 2: Validation failure
                logger.error('Validation Error: Google user ID and email are required. Received:', { sub: googleUser.sub, email: googleUser.email });
                throw new Error('Google user ID and email are required');
            }
            // Prepare base user data for update/creation
            const nowIso = new Date().toISOString();
            const userData: Partial<User> = {
                username: googleUser.email.split('@')[0],
                email: googleUser.email,
                verified: true,
                google_id: googleUser.sub,
                name: googleUser.name,
                picture: googleUser.picture,
                locale: googleUser.locale,
                hd: googleUser.hd,
                twitter_addresses: [],
                auth_provider: 'google',
                email_verified: googleUser.email_verified,
                last_login_at: nowIso,
                current_sign_in_ip: googleUser.current_sign_in_ip,
                last_sign_in_ip: googleUser.last_sign_in_ip,
                access_token: googleUser.access_token,
                refresh_token: googleUser.refresh_token,
                token_expiry: googleUser.token_expiry
            };
            // Log 3: Prepared base user data
            logger.debug('Prepared base userData for upsert:', { google_id: userData.google_id, email: userData.email });
            let user = await this.getUserByGoogleId(googleUser.sub);
            // Log 4: Result of first lookup
            if (user) {
                logger.debug('Found user by Google ID:', googleUser.sub);
            } else {
                logger.debug('User not found by Google ID. Attempting lookup by email:', googleUser.email);
            }
            if (!user) {
                user = await this.getUserByEmail(googleUser.email);
                // Log 5: Result of second lookup
                if (user) {
                    logger.debug('Found user by email. Merging accounts/updating profile.');
                } else {
                    logger.debug('User not found by email. A new user will be created.');
                }
            }
            // Merge data for create or update
            const isNewUser = !user;
            const newUserData: Partial<User> = {
                ...user, // existing user data
                ...userData, // new data from Google/login
                created_at: user?.created_at || nowIso, // preserve created_at or set now
                updated_at: nowIso,
                login_count: (user?.login_count || 0) + 1,
                sign_in_count: (user?.sign_in_count || 0) + 1,
            };
            // Log 6: Before database operation
            logger.debug(`${isNewUser ? 'Creating' : 'Updating'} user in database. Login count: ${newUserData.login_count}.`);
            logger.debug('Final newUserData keys being passed:', Object.keys(newUserData));
            const createdOrUpdatedUser = await this.createOrUpdateUser(newUserData);
            // Log 7: Database operation result check
            if (!createdOrUpdatedUser) {
                logger.error('Database Error: createOrUpdateUser returned null/undefined for:', googleUser.sub);
                throw new Error('Failed to create or update user in database.');
            }
            // Log 8: Successful exit
            logger.debug(`Successfully ${isNewUser ? 'created' : 'updated'} user ID: ${createdOrUpdatedUser.google_id}`);
            return createdOrUpdatedUser;
        } catch (error) {
            // Existing Error Log
            logger.error('Error in findOrCreateGoogleUser:', error);
            throw error;
        }
    }
    /**
     * Creates a new user or updates an existing one based on email/google_id.
     * @param userData The user data to create or update.
     * @returns The created or updated User object.
     */
    async createOrUpdateUser(userData: Partial<User>): Promise<User | null> {
        try {
            const nowIso = new Date().toISOString();
            const row = {
                username: userData.username || '',
                email: userData.email || '',
                verified: userData.verified || false,
                created_at: userData.created_at || nowIso,
                updated_at: nowIso,
                twitter_addresses: JSON.stringify(userData.twitter_addresses || []),
                google_id: userData.google_id || null,
                name: userData.name || null,
                picture: userData.picture || null,
                access_token: userData.access_token || null,
                refresh_token: userData.refresh_token || null,
                token_expiry: userData.token_expiry || null,
                last_login_at: userData.last_login_at || nowIso,
                login_count: userData.login_count || 1,
                locale: userData.locale || null,
                hd: userData.hd || null,
                auth_provider: userData.auth_provider || 'google',
                current_sign_in_ip: userData.current_sign_in_ip || null,
                last_sign_in_ip: userData.last_sign_in_ip || userData.current_sign_in_ip || null,
                sign_in_count: userData.sign_in_count || 1,
                tos_accepted_at: userData.tos_accepted_at || nowIso,
                email_verified: userData.email_verified || false
            };
            logger.debug(`createOrUpdateUser: Prepared row with email "${row.email}", google_id "${row.google_id}"`);
            // Check if user exists
            const existingUser = userData.google_id
                ? await this.getUserByGoogleId(userData.google_id)
                : await this.getUserByEmail(row.email);
            logger.debug(`createOrUpdateUser: Existing user found? ${!!existingUser}`);
            if (existingUser) {
                logger.debug(`createOrUpdateUser: Updating existing user for email "${row.email}"`);
                // Fix TS7053 by explicitly casting to key/value tuple: [keyof typeof row, any]
                const updateFields = (Object.entries(row) as [keyof typeof row, any][])
                    .filter(([key]) => key !== 'created_at') // Don't update created_at
                    .map(([key, value]) => {
                        const safeValue = value === null ? 'NULL' :
                            typeof value === 'boolean' ? (value ? 'true' : 'false') :
                                `'${String(value).replace(/'/g, "''")}'`;
                        return `${String(key)} = ${safeValue}`; // Convert key back to string for SQL
                    })
                    .join(', ');
                const sql = `UPDATE google_users
                SET ${updateFields}
                WHERE email = '${row.email.replace(/'/g, "''")}';`;
                logger.debug(`createOrUpdateUser: Update SQL: ${sql}`);
                const updateResult = await questdbService.query(sql);
                logger.debug(`createOrUpdateUser: Update executed, result: { hasError: ${!!updateResult}, affectedRows: ${updateResult.rows || 'unknown'} }`);
            } else {
                logger.debug(`createOrUpdateUser: Inserting new user for email "${row.email}"`);
                // Insert new user
                const columns = Object.keys(row).join(', ');
                const values = Object.values(row)
                    .map(v => {
                        if (v === null) return 'NULL';
                        if (typeof v === 'boolean') return v ? 'true' : 'false'; // Handle boolean values
                        return `'${String(v).replace(/'/g, "''")}'`; // Ensure all string values are escaped
                    })
                    .join(', ');
                const sql = `INSERT INTO google_users (${columns}) VALUES (${values});`;
                logger.debug(`createOrUpdateUser: Insert SQL: ${sql}`);
                const insertResult = await questdbService.query(sql);
                logger.debug(`createOrUpdateUser: Insert executed, result: { hasError: ${!!insertResult}, insertedId: ${insertResult.rows || 'unknown'} }`);
                // Brief delay to allow WAL commit in QuestDB
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            // Fetch the updated/inserted user
            logger.debug(`createOrUpdateUser: Fetching user by email "${row.email}" after ${existingUser ? 'update' : 'insert'}`);
            const user = await this.getUserByEmail(row.email);
            logger.debug(`createOrUpdateUser: Fetched user after operation: ${!!user ? 'success' : 'null'}`);
            return user;
        } catch (error) {
            logger.error('Error creating/updating user:', error);
            throw error;
        }
    }
    /**
     * Updates the user's email verification status.
     * @param email The user's email.
     * @param verified The new verification status.
     * @returns The updated User object or null.
     */
    async updateUserVerification(email: string, verified: boolean): Promise<User | null> {
        try {
            const safeEmail = email.replace(/'/g, "''");
            const sql = `UPDATE google_users SET verified = ${verified ? 'true' : 'false'}, email_verified = ${verified ? 'true' : 'false'}, updated_at = '${new Date().toISOString()}' WHERE email = '${safeEmail}';`;
            await questdbService.query(sql);
            return await this.getUserByEmail(email);
        } catch (error) {
            logger.error(`Error updating verification for ${email}:`, error);
            throw error;
        }
    }
    /**
     * Updates the user's Twitter addresses list.
     * @param email The user's email.
     * @param twitterAddresses The new list of Twitter addresses.
     * @returns The updated User object or null.
     */
    async updateUserTwitterAddresses(email: string, twitterAddresses: string[]): Promise<User | null> {
        try {
            const safeEmail = email.replace(/'/g, "''");
            const safeAddresses = JSON.stringify(twitterAddresses).replace(/'/g, "''");
            const sql = `UPDATE google_users SET twitter_addresses = '${safeAddresses}', updated_at = '${new Date().toISOString()}' WHERE email = '${safeEmail}';`;
            await questdbService.query(sql);
            return await this.getUserByEmail(email);
        } catch (error) {
            logger.error(`Error updating twitter addresses for ${email}:`, error);
            throw error;
        }
    }
    /**
     * Lists users with optional filtering and pagination.
     * @param limit Maximum number of users to return.
     * @param offset Number of users to skip.
     * @param verifiedOnly If true, only return verified users.
     * @returns An array of User objects.
     */
    async listUsers(limit: number = 10, offset: number = 0, verifiedOnly?: boolean): Promise<User[]> {
        try {
            const whereClause = verifiedOnly ? 'WHERE verified = true' : '';
            const sql = `SELECT * FROM google_users ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset};`;
            const result = await questdbService.query(sql);
            return result.rows.map((row: any[]) => this.mapUserRow(row));
        } catch (error) {
            logger.error('Error listing users:', error);
            throw error;
        }
    }
}
export const usersService = new UsersService();