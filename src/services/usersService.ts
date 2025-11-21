import { OAuth2Client } from 'google-auth-library';
import { Request, Response } from 'express';
import { questdbService } from './questDbService';
import { logger } from '../utils/logger';

export interface GoogleUserInfo {
    sub: string;
    email: string;
    name?: string;
    picture?: string;
    email_verified?: boolean;
    locale?: string;
    hd?: string;  // The hosted domain of the user's G Suite account
    given_name?: string;
    family_name?: string;
}

// Initialize OAuth2 client with credentials
const googleClient = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI // e.g., 'http://localhost:3000/api/auth/google/callback'
);

// Generate Google OAuth URL
export const getGoogleAuthUrl = (): string => {
    return googleClient.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email'
        ],
        prompt: 'consent' // Force to get refresh token every time
    });
};

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

export class UsersService {
    // Verify Google ID token
    async verifyGoogleToken(idToken: string) {
        try {
            const ticket = await googleClient.verifyIdToken({
                idToken,
                audience: process.env.GOOGLE_CLIENT_ID,
            });
            return ticket.getPayload();
        } catch (error) {
            logger.error('Google token verification failed:', error);
            throw new Error('Invalid Google token');
        }
    }

    // Exchange authorization code for tokens
    async getGoogleTokens(code: string) {
        try {
            const { tokens } = await googleClient.getToken(code);
            return tokens;
        } catch (error) {
            logger.error('Error getting Google tokens:', error);
            throw new Error('Failed to get Google tokens');
        }
    }

    // Get user info from Google
    async getGoogleUserInfo(tokens: any) {
        try {
            // Set the credentials on the client
            googleClient.setCredentials(tokens);

            // Get the user info using the OAuth2 client
            const userInfo = await googleClient.request({
                url: 'https://www.googleapis.com/oauth2/v3/userinfo'
            });

            return userInfo;
        } catch (error) {
            logger.error('Error getting Google user info:', error);
            throw new Error('Failed to get user info from Google');
        }
    }

    // Find or create user based on Google profile
    async findOrCreateGoogleUser(googleUser: {
        sub: string | undefined;
        email: string | undefined;
        name?: string;
        picture?: string;
    }) {
        try {
            if (!googleUser.sub || !googleUser.email) {
                throw new Error('Google user ID and email are required');
            }
            // Try to find user by google_id first
            let user = await this.getUserByGoogleId(googleUser.sub);

            if (!user) {
                // If not found, try by email
                user = await this.getUserByEmail(googleUser.email);

                if (user) {
                    // Update existing user with google_id
                    await this.updateUserGoogleId(googleUser.email, googleUser.sub);
                } else {
                    // Create new user
                    user = await this.createOrUpdateUser({
                        username: googleUser.email.split('@')[0],
                        email: googleUser.email,
                        verified: true,
                        google_id: googleUser.sub,
                        name: googleUser.name,
                        picture: googleUser.picture,
                        twitter_addresses: []
                    });
                }
            }

            return user;
        } catch (error) {
            logger.error('Error in findOrCreateGoogleUser:', error);
            throw error;
        }
    }

    // Get user by Google ID
    private async getUserByGoogleId(googleId: string): Promise<User | null> {
        try {
            const safeGoogleId = googleId.replace(/'/g, "''");
            const sql = `SELECT * FROM users WHERE google_id = '${safeGoogleId}' ORDER BY created_at DESC LIMIT 1;`;
            const result = await questdbService.query(sql);

            if (result.rows.length === 0) return null;

            const row = result.rows[0];
            return this.mapUserRow(row);
        } catch (error) {
            logger.error(`Error fetching user by Google ID ${googleId}:`, error);
            throw error;
        }
    }

    // Update user's Google ID
    private async updateUserGoogleId(email: string, googleId: string): Promise<void> {
        try {
            const safeEmail = email.replace(/'/g, "''");
            const safeGoogleId = googleId.replace(/'/g, "''");
            const sql = `UPDATE users SET google_id = '${safeGoogleId}' WHERE email = '${safeEmail}';`;
            await questdbService.query(sql);
        } catch (error) {
            logger.error(`Error updating Google ID for user ${email}:`, error);
            throw error;
        }
    }

    private mapUserRow(row: any): User {
        return {
            username: row[1],
            email: row[2],
            verified: Boolean(row[3]),
            created_at: row[0],
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

    async createOrUpdateUser(userData: Partial<User>): Promise<User | null> {
        try {
            const nowIso = new Date().toISOString();
            const row = {
                username: userData.username || '',
                email: userData.email || '',
                verified: Boolean(userData.verified),
                created_at: userData.created_at || nowIso,
                updated_at: nowIso,
                twitter_addresses: userData.twitter_addresses || [],
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

            await questdbService.insertBatch('users', [row]);

            // Fetch the updated user
            const user = userData.google_id
                ? await this.getUserByGoogleId(userData.google_id)
                : await this.getUserByEmail(row.email);
            return user || null;
        } catch (error) {
            logger.error('Error creating/updating user:', error);
            throw error;
        }
    }

    async getUserByEmail(email: string): Promise<User | null> {
        try {
            const safeEmail = email.replace(/'/g, "''");
            const sql = `SELECT * FROM users WHERE email = '${safeEmail}' ORDER BY created_at DESC LIMIT 1;`;
            const result = await questdbService.query(sql);
            if (result.rows.length === 0) return null;

            return this.mapUserRow(result.rows[0]);
        } catch (error) {
            logger.error(`Error fetching user by email ${email}:`, error);
            throw error;
        }
    }

    async updateUserVerification(email: string, verified: boolean): Promise<User | null> {
        try {
            const user = await this.getUserByEmail(email);
            if (!user) return null;

            const nowIso = new Date().toISOString();
            const row = {
                username: user.username,
                email: user.email,
                verified,
                created_at: user.created_at,
                updated_at: nowIso,
                twitter_addresses: user.twitter_addresses,
                google_id: user.google_id,
                name: user.name,
                picture: user.picture
            };

            await questdbService.insertBatch('users', [row]); // Triggers upsert
            return await this.getUserByEmail(email);
        } catch (error) {
            logger.error(`Error updating verification for ${email}:`, error);
            throw error;
        }
    }

    async updateUserTwitterAddresses(email: string, twitterAddresses: string[]): Promise<User | null> {
        try {
            const user = await this.getUserByEmail(email);
            if (!user) return null;

            const nowIso = new Date().toISOString();
            const row = {
                username: user.username,
                email: user.email,
                verified: user.verified,
                created_at: user.created_at,
                updated_at: nowIso,
                twitter_addresses: twitterAddresses,
                google_id: user.google_id,
                name: user.name,
                picture: user.picture
            };

            await questdbService.insertBatch('users', [row]); // Triggers upsert
            return await this.getUserByEmail(email);
        } catch (error) {
            logger.error(`Error updating twitter addresses for ${email}:`, error);
            throw error;
        }
    }

    async listUsers(limit: number = 10, offset: number = 0, verifiedOnly?: boolean): Promise<User[]> {
        try {
            let whereClause = '';
            if (verifiedOnly) {
                whereClause = 'WHERE verified = true';
            }
            const sql = `SELECT * FROM users ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset};`;
            const result = await questdbService.query(sql);

            return result.rows.map((row: any[]) => this.mapUserRow(row));
        } catch (error) {
            logger.error('Error listing users:', error);
            throw error;
        }
    }
}

export const usersService = new UsersService();