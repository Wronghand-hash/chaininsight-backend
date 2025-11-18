import { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      trialInfo?: {
        username: string;
        postCount: number;
        maxPosts: number;
        postsRemaining: number;
        expiryDate: Date;
      };
    }
  }
}

interface QueryResult {
  rows: any[];
  rowCount: number;
  columns: any[];
  error?: Error;
}
import { questdbService } from '../../services/questDbService';
import { logger } from '../../utils/logger';

export class FreeTrialController {
  private readonly MAX_FREE_POSTS = 10;
  private readonly FREE_TRIAL_DAYS = 7; // 7-day free trial

  /**
   * Start a new free trial for a user
   * POST /api/free-trial/start
   */
  public startFreeTrial = async (req: Request, res: Response) => {
    const { username, twitterId, twitter_community, token } = req.body;

    if (!username || !twitterId || !twitter_community || !token) {
      return res.status(400).json({
        success: false,
        message: 'Username, twitterId, twitter_community, and token are required'
      });
    }

    try {
      // Check if user already has an active free trial
      const checkQuery = `
        SELECT 
          twitter_id,
          total_posts_count as post_count,
          total_posts_allowed as max_posts,
          expire_at as expiry_date
        FROM user_posts_plans 
        WHERE twitter_id = '${username.replace(/'/g, "''")}'
        AND service_type = 'freeTrial'
        LIMIT 1`;

      const checkResult = await questdbService.query(checkQuery);

      if (checkResult.rows.length > 0) {
        const trialData = checkResult.rows[0];
        const postCount = parseInt(trialData[1] || '0');

        if (postCount >= this.MAX_FREE_POSTS) {
          return res.status(400).json({
            success: false,
            message: 'Free trial already used. You have reached the maximum number of free posts.'
          });
        }

        return res.status(200).json({
          success: true,
          message: 'Free trial already active',
          postsRemaining: this.MAX_FREE_POSTS - postCount
        });
      }

      // Create new free trial
      const currentDate = new Date();
      const expiryDate = new Date();
      expiryDate.setDate(currentDate.getDate() + this.FREE_TRIAL_DAYS);

      const insertQuery = `
        INSERT INTO user_posts_plans (
          timestamp,
          username,
          twitter_id,
          service_type,
          total_posts_count,
          total_posts_allowed,
          expire_at,
          created_at,
          updated_at,
          twitter_community,
          token
        ) VALUES (
          now(),
          '${username.replace(/'/g, "''")}',
          '${twitterId.replace(/'/g, "''")}',
          'freeTrial',
          0,
          ${this.MAX_FREE_POSTS},
          to_timestamp('${expiryDate.toISOString()}', 'yyyy-MM-ddTHH:mm:ss.SSSZ'),
          now(),
          now(),
          '${twitter_community.replace(/'/g, "''")}',
          '${token.replace(/'/g, "''")}'
        )`;

      await questdbService.query(insertQuery);

      return res.status(201).json({
        success: true,
        message: 'Free trial started successfully',
        postsRemaining: this.MAX_FREE_POSTS,
        expiryDate: expiryDate.toISOString()
      });

    } catch (error: any) {
      logger.error('Error starting free trial:', {
        error: error.message,
        username,
        twitterId
      });

      return res.status(500).json({
        success: false,
        message: 'Failed to start free trial',
        error: error.message
      });
    }
  };

  /**
   * Get free trial status for a user
   * GET /api/free-trial/status/:username
   */
  public getTrialStatus = async (req: Request, res: Response) => {
    const { username } = req.params;

    if (!username) {
      return res.status(400).json({
        success: false,
        message: 'Username is required'
      });
    }

    try {
      const query = `
        SELECT 
          total_posts_count as post_count,
          total_posts_allowed as max_posts,
          expire_at as expiry_date
        FROM user_posts_plans 
        WHERE username = '${username.replace(/'/g, "''")}'
        AND service_type = 'freeTrial'
        LIMIT 1`;

      const result = await questdbService.query(query);

      if (result.rows.length === 0) {
        return res.status(200).json({
          success: true,
          hasTrial: false,
          message: 'No active free trial found'
        });
      }

      const [postCount, maxPosts, expiryDate] = result.rows[0];
      const postsRemaining = Math.max(0, maxPosts - postCount);
      const isExpired = new Date(expiryDate) < new Date();

      return res.status(200).json({
        success: true,
        hasTrial: true,
        postCount,
        maxPosts,
        postsRemaining,
        isExpired,
        expiryDate: expiryDate.toISOString(),
        canPost: postsRemaining > 0 && !isExpired
      });

    } catch (error: any) {
      logger.error('Error getting free trial status:', {
        error: error.message,
        username
      });

      return res.status(500).json({
        success: false,
        message: 'Failed to get free trial status',
        error: error.message
      });
    }
  };

  /**
   * Get all posts plans for a user by Twitter ID
   * GET /api/leaderboard/user-posts-plans/:twitterId
   */
  public getUserPostsPlans = async (req: Request, res: Response) => {
    const { twitter_id } = req.query;

    if (!twitter_id) {
      return res.status(400).json({
        success: false,
        message: 'Twitter username is required as a query parameter (username)'
      });
    }

    try {
      const query = `
        SELECT 
          username,
          twitter_id as "twitterId",
          service_type as "serviceType",
          total_posts_count as "postsCount",
          total_posts_allowed as "postsAllowed",
          expire_at as "expiryDate",
          created_at as "createdAt",
          updated_at as "updatedAt",
          twitter_community as "twitterCommunity"
        FROM user_posts_plans 
        WHERE twitter_id = '${String(twitter_id).replace(/'/g, "''")}'
        ORDER BY created_at DESC`;

      const result = await questdbService.query(query);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found with the provided Twitter ID'
        });
      }

      const plans = result.rows.map(row => ({
        username: row[0],
        twitterId: row[1],
        serviceType: row[2],
        postsCount: parseInt(row[3] || '0'),
        postsAllowed: parseInt(row[4] || '0'),
        expiryDate: row[5] ? new Date(row[5]).toISOString() : null,
        createdAt: row[6] ? new Date(row[6]).toISOString() : null,
        updatedAt: row[7] ? new Date(row[7]).toISOString() : null,
        twitterCommunity: row[8]
      }));

      return res.status(200).json({
        success: true,
        data: plans
      });

    } catch (error: any) {
      logger.error('Error getting user posts plans:', {
        error: error.message,
        twitter_id
      });

      return res.status(500).json({
        success: false,
        message: 'Failed to get user posts plans',
        error: error.message
      });
    }
  };

  /**
   * Middleware to check if user can post (used in routes)
   */
  public canPost = async (req: Request, res: Response, next: NextFunction) => {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        message: 'Username is required'
      });
    }

    try {
      const query = `
        SELECT 
          total_posts_count as post_count,
          total_posts_allowed as max_posts,
          expire_at as expiry_date
        FROM user_posts_plans 
        WHERE username = '${username.replace(/'/g, "''")}'
        AND service_type = 'freeTrial'
        LIMIT 1`;

      const result = await questdbService.query(query);

      if (result.rows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'No active free trial found'
        });
      }

      const [postCount, maxPosts, expiryDate] = result.rows[0];
      const postsRemaining = Math.max(0, maxPosts - postCount);
      const isExpired = new Date(expiryDate) < new Date();

      if (postsRemaining <= 0) {
        return res.status(403).json({
          success: false,
          message: 'You have reached the maximum number of free posts'
        });
      }

      if (isExpired) {
        return res.status(403).json({
          success: false,
          message: 'Your free trial has expired'
        });
      }

      // Add trial info to request for use in route handlers
      req.trialInfo = {
        username,
        postCount,
        maxPosts,
        postsRemaining,
        expiryDate
      };

      next();
    } catch (error: any) {
      logger.error('Error checking free trial status:', {
        error: error.message,
        username
      });

      return res.status(500).json({
        success: false,
        message: 'Failed to verify free trial status',
        error: error.message
      });
    }
  };

  /**
   * Increment post count for a user (call this after successful post)
   */
  public incrementPostCount = async (username: string): Promise<boolean> => {
    try {
      const updateQuery = `
        UPDATE user_posts_plans 
        SET 
          total_posts_count = total_posts_count + 1,
          updated_at = now()
        WHERE username = '${username.replace(/'/g, "''")}'
        AND service_type = 'freeTrial'
        AND total_posts_count < total_posts_allowed
        AND expire_at > now()`;

      const result = await questdbService.query(updateQuery);
      return result.rows.length > 0;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error incrementing post count:', {
        error: errorMessage,
        username
      });
      return false;
    }
  };
}

export const freeTrialController = new FreeTrialController();
