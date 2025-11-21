import { Sender } from '@questdb/nodejs-client';
import { Client } from 'pg';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { QueryResult, TableRow } from '../models/db.types';
import { TokenInfoResponse } from '../models/token.types';

// Supported chains
type Chain = 'BSC' | 'ETH' | 'SOL';

export class QuestDBService {
  private sender?: Sender;
  private pgClient: Client;
  private initialized = false;
  private initPromise?: Promise<void>;

  constructor() {
    this.pgClient = new Client({
      host: config.questdb.host,
      port: config.questdb.pgPort,
      database: 'qdb',
      user: 'admin',
      password: 'quest',
      // ssl: { rejectUnauthorized: false }, // enable if HTTPS in production
    });
  }

  async init(): Promise<void> {
    if (this.initialized) {
      if (config.questdb.diagnosticsVerbose) {
        logger.debug('QuestDB already initialized, skipping re-init');
      }
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = (async () => {
      try {
        logger.info('Initializing QuestDB...');
        await this.pgClient.connect();
        await this.pgClient.query('SELECT 1 as ping;');
        const tcpConfig = `tcp::addr=${config.questdb.host}:${config.questdb.fastPort};`;
        this.sender = await Sender.fromConfig(tcpConfig);
        await this.sender.connect();
        await this.createTables();
        this.initialized = true;
        logger.info('✅ QuestDB initialized successfully (PG + Sender)');
      } catch (error) {
        logger.error('❌ QuestDB initialization failed', error);
        throw error;
      }
    })();
    return this.initPromise;
  }

  private async createTables(): Promise<void> {
    const wal = config.questdb.enableWal ? ' WAL' : '';

    // kol_trades (no unique index in QuestDB; enforce at app level)
    const kolTradesCreateSql = `CREATE TABLE IF NOT EXISTS kol_trades (
        timestamp TIMESTAMP,
        kolId LONG,
        kolName STRING,
        kolAvatar STRING,
        kolTwitterId STRING,
        contract SYMBOL,
        action SYMBOL,
        amount STRING,
        usdtPrice STRING,
        initialPrice STRING,
        txHash SYMBOL,
        fromToken STRING,
        fromTokenAddress SYMBOL,
        fromTokenCount STRING,
        toToken STRING,
        toTokenAddress SYMBOL,
        toTokenCount STRING,
        toTokenRemainCount STRING,
        walletType INT,
        recentBuyerKols STRING,
        recentSellerKols STRING,
        chain SYMBOL
      ) TIMESTAMP(timestamp) PARTITION BY DAY${wal};`;
    await this.pgClient.query(kolTradesCreateSql);
    logger.debug(`✅ Table created: kol_trades`);

    // users table
    const usersCreateSql = `CREATE TABLE IF NOT EXISTS users (
        created_at TIMESTAMP,
        username STRING,
        email SYMBOL,
        verified BOOLEAN,
        updated_at TIMESTAMP,
        twitter_addresses STRING,
        google_id STRING,
        name STRING,
        picture STRING,
        access_token STRING,
        refresh_token STRING,
        token_expiry TIMESTAMP,
        last_login_at TIMESTAMP,
        login_count LONG,
        locale STRING,
        hd STRING,
        auth_provider STRING,
        current_sign_in_ip STRING,
        last_sign_in_ip STRING,
        sign_in_count LONG,
        tos_accepted_at TIMESTAMP,
        email_verified BOOLEAN
      ) TIMESTAMP(created_at) PARTITION BY DAY${wal};`;
    await this.pgClient.query(usersCreateSql);
    logger.debug(`✅ Table created: users`);
    
    // Ensure all columns exist in the users table
    await this.ensureUsersTableColumns();

    // Other tables
    const tables = [
      {
        name: 'prices',
        create: `CREATE TABLE IF NOT EXISTS prices (
          timestamp TIMESTAMP,
          contract SYMBOL,
          priceUsd DOUBLE,
          volume DOUBLE,
          chain SYMBOL
        ) TIMESTAMP(timestamp) PARTITION BY DAY${wal};`
      },
      {
        name: 'token_info',
        create: `CREATE TABLE IF NOT EXISTS token_info (
          timestamp TIMESTAMP,
          contract SYMBOL,
          data STRING,
          chain SYMBOL
        ) TIMESTAMP(timestamp) PARTITION BY DAY${wal};`
      },
      {
        name: 'security_labels',
        create: `CREATE TABLE IF NOT EXISTS security_labels (
          timestamp TIMESTAMP,
          address SYMBOL,
          data STRING,
          chain SYMBOL
        ) TIMESTAMP(timestamp) PARTITION BY DAY${wal};`
      },
      {
        name: 'token_metrics',
        create: `CREATE TABLE IF NOT EXISTS token_metrics (
          timestamp TIMESTAMP,
          contract SYMBOL,
          chain SYMBOL,
          price_usd DOUBLE,
          market_cap DOUBLE,
          fdv DOUBLE,
          volume_5m DOUBLE,
          volume_24h DOUBLE,
          call_count INT,
          kol_calls_count INT,
          mention_user_count INT,
          calls_data STRING,
          community_data STRING,
          narrative_data STRING,
          title STRING,
          updated_at TIMESTAMP,
          CTO STRING
        ) TIMESTAMP(timestamp) PARTITION BY DAY${wal};`
      },
      {
        name: 'payment_history',
        create: `CREATE TABLE IF NOT EXISTS payment_history (
          timestamp TIMESTAMP,
          twitterId STRING,
          amount DOUBLE,
          serviceType STRING,
          chain SYMBOL,
          wallet STRING,
          address SYMBOL,
          publicKey STRING,
          privateKey STRING,  -- Store securely; consider encryption in production
          paymentStatus BOOLEAN,
          status STRING,  -- e.g., 'completed', 'pending'
          twitter_community STRING,
          token STRING
        ) TIMESTAMP(timestamp) PARTITION BY DAY${wal};`
      },
      {
        name: 'userPurchase',
        create: `CREATE TABLE IF NOT EXISTS userPurchase (
          id LONG,  -- Auto-increment or UUID as LONG
          twitterId STRING,
          amount DOUBLE,
          address SYMBOL,
          created_at TIMESTAMP,
          expire_at TIMESTAMP,
          serviceType STRING,
          twitter_community STRING,
          token STRING
        ) TIMESTAMP(created_at) PARTITION BY DAY${wal};`
      },
      {
        name: 'user_posts_plans',
        create: `CREATE TABLE IF NOT EXISTS user_posts_plans (
          timestamp TIMESTAMP,
          twitter_id STRING,
          username STRING,
          service_type STRING,
          created_at TIMESTAMP,
          updated_at TIMESTAMP,
          expire_at TIMESTAMP,
          total_posts_allowed INT,
          total_posts_count INT,
          twitter_community STRING,
          token STRING
        ) TIMESTAMP(timestamp) PARTITION BY DAY${wal}`
      }
    ];

    try {
      // Add updated_at column to user_posts_plans if it doesn't exist
      try {
        await this.pgClient.query(`
          ALTER TABLE user_posts_plans 
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP
        `);
        logger.info('Successfully added updated_at column to user_posts_plans table');
      } catch (migrationError) {
        logger.error('Error adding updated_at column to user_posts_plans table:', migrationError);
        // Continue with table creation even if migration fails
      }

      for (const table of tables) {
        try {
          logger.debug(`Creating table: ${table.name}`);
          if (Array.isArray(table.create)) {
            for (const query of table.create) {
              await this.pgClient.query(query);
            }
          } else {
            await this.pgClient.query(table.create);
            // Verify table was created
            const checkTable = await this.pgClient.query(
              `SELECT table_name FROM tables() WHERE table_name = '${table.name}';`
            );
            if (checkTable.rows.length === 0) {
              logger.error(`❌ Table ${table.name} was not created successfully`);
            } else {
              logger.debug(`✅ Verified table exists: ${table.name}`);
            }
          }
          logger.debug(`✅ Table created: ${table.name}`);
        } catch (error) {
          logger.error(`❌ Error creating table ${table.name}:`, error);
          throw error;
        }
      }
      logger.info('✅ QuestDB tables created');
    } catch (error) {
      logger.error('❌ Error initializing QuestDB tables:', error);
      throw error;
    }
  }

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('QuestDBService not initialized — call await questdbService.init() before using it.');
    }
  }

  async insertBatch(table: string, rows: Array<Record<string, any>>): Promise<void> {
    this.ensureInit();
    if (rows.length === 0) return;

    try {
      for (const row of rows) {
        // Special handling for users table (upsert on email)
        if (table === 'users') {
          const nowIso = new Date().toISOString();
          const createdAt = row.created_at || nowIso;
          const username = String(row.username || '');
          const email = String(row.email || '');
          const verified = Boolean(row.verified || false);
          const twitterAddresses = JSON.stringify(row.twitter_addresses || []);
          const updatedAt = row.updated_at || nowIso;

          // Check if user exists by email
          const checkSql = `SELECT count(*) as c FROM users WHERE email = $1;`;
          const checkRes = await this.pgClient.query(checkSql, [email]);
          const exists = checkRes.rows[0]?.c > 0;

          if (exists) {
            // Update existing user
            const esc = (s: string) => s.replace(/'/g, "''");
            const updateSql = `
              UPDATE users 
              SET username = '${esc(username)}', 
                  verified = ${verified}, 
                  updated_at = '${updatedAt}',
                  twitter_addresses = '${esc(twitterAddresses)}'
              WHERE email = '${esc(email)}';
            `;
            await this.pgClient.query(updateSql);
          } else {
            // Insert new user
            const insertSql = `INSERT INTO users (created_at, username, email, verified, updated_at, twitter_addresses) VALUES ($1, $2, $3, $4, $5, $6);`;
            await this.pgClient.query(insertSql, [createdAt, username, email, verified, updatedAt, twitterAddresses]);
          }
          continue;
        }

        // Special upsert for token_metrics
        if (table === 'token_metrics') {
          const nowIso = new Date().toISOString();
          const ts = String(row.timestamp ?? nowIso);
          const contract = String(row.contract || '');
          const chain = String(row.chain || 'BSC');
          const priceUsd = row.price_usd != null ? Number(row.price_usd) : null;
          const marketCap = row.market_cap != null ? Number(row.market_cap) : null;
          const fdv = row.fdv != null ? Number(row.fdv) : null;
          const volume5m = row.volume_5m != null ? Number(row.volume_5m) : null;
          const volume24h = row.volume_24h != null ? Number(row.volume_24h) : null;
          const title = row.title != null ? String(row.title) : '';
          const CTOStr = row.CTO != null ? String(row.CTO) : '';
          const callCount = Number(row.call_count || 0);
          const kolCallsCount = Number(row.kol_calls_count || 0);
          const mentionUserCount = Number(row.mention_user_count || 0);
          const callsData = JSON.stringify(row.calls_data || {});
          const communityData = JSON.stringify(row.community_data || {});
          const narrativeData = JSON.stringify(row.narrative_data || {});

          const checkSql = `SELECT count(*) as c FROM token_metrics WHERE contract = $1 AND chain = $2;`;
          const checkRes = await this.pgClient.query(checkSql, [contract, chain]);
          const exists = checkRes.rows[0]?.c > 0;

          if (exists) {
            const esc = (s: string) => s.replace(/'/g, "''");
            const nullable = (n: number | null) => (n == null || Number.isNaN(n) ? 'NULL' : String(n));
            const setParts: string[] = [
              `updated_at = '${esc(nowIso)}'`
            ];
            if (row.price_usd != null) setParts.push(`price_usd = ${nullable(priceUsd)}`);
            if (row.market_cap != null) setParts.push(`market_cap = ${nullable(marketCap)}`);
            if (row.fdv != null) setParts.push(`fdv = ${nullable(fdv)}`);
            if (row.volume_5m != null) setParts.push(`volume_5m = ${nullable(volume5m)}`);
            if (row.volume_24h != null) setParts.push(`volume_24h = ${nullable(volume24h)}`);
            if (row.title != null) setParts.push(`title = '${esc(title)}'`);
            if (row.CTO != null) setParts.push(`CTO = '${esc(CTOStr)}'`);
            if (row.call_count != null) setParts.push(`call_count = ${callCount}`);
            if (row.kol_calls_count != null) setParts.push(`kol_calls_count = ${kolCallsCount}`);
            if (row.mention_user_count != null) setParts.push(`mention_user_count = ${mentionUserCount}`);
            if (row.calls_data != null) setParts.push(`calls_data = '${esc(callsData)}'`);
            if (row.community_data != null) setParts.push(`community_data = '${esc(communityData)}'`);
            if (row.narrative_data != null) setParts.push(`narrative_data = '${esc(narrativeData)}'`);

            const updateSql = `UPDATE token_metrics SET ${setParts.join(', ')} WHERE contract = '${esc(contract)}' AND chain = '${esc(chain)}';`;
            await this.pgClient.query(updateSql);
          } else {
            const insertSql = `INSERT INTO token_metrics (
              timestamp, contract, chain, price_usd, market_cap, fdv, volume_5m, volume_24h,
              call_count, kol_calls_count, mention_user_count, calls_data, community_data, narrative_data, title, updated_at, CTO
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17);`;
            await this.pgClient.query(insertSql, [
              ts, contract, chain, priceUsd, marketCap, fdv, volume5m, volume24h,
              callCount, kolCallsCount, mentionUserCount, callsData, communityData, narrativeData, title, nowIso, CTOStr
            ]);
          }
          continue;
        }

        // Special insert for payment_history and userPurchase
        if (table === 'payment_history' || table === 'userPurchase') {
          const nowIso = new Date().toISOString();
          const ts = String(row.timestamp ?? nowIso);
          const twitterId = String(row.twitterId || '');
          const amount = row.amount != null ? Number(row.amount) : null;
          const serviceType = String(row.serviceType || 'unknown');
          const chain = String(row.chain || 'BSC');
          const wallet = String(row.wallet || '');
          const address = String(row.address || '');
          const publicKey = String(row.publicKey || '');
          const privateKey = String(row.privateKey || '');
          const status = String(row.status || 'completed');

          let sql: string;
          let values: any[];
          if (table === 'payment_history') {
            sql = `INSERT INTO payment_history (timestamp, twitterId, amount, serviceType, chain, wallet, address, publicKey, privateKey, paymentStatus, status, twitter_community, token)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`;
            values = [ts, twitterId, amount, serviceType, chain, wallet, address, publicKey, privateKey, false, status, row.twitter_community || '', row.token || ''];
          } else {
            const createdAt = new Date(nowIso);
            const expireAt = new Date(createdAt.getTime() + (30 * 24 * 60 * 60 * 1000));
            const expireAtIso = expireAt.toISOString();
            const checkCount = await this.pgClient.query('SELECT count(*) as c FROM userPurchase;');
            const nextId = (checkCount.rows[0]?.c || 0) + 1;
            sql = `INSERT INTO userPurchase (id, twitterId, amount, address, created_at, expire_at, serviceType, twitter_community, token)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`;
            values = [nextId, twitterId, amount, address, nowIso, expireAtIso, serviceType, row.twitter_community || '', row.token || ''];
          }
          await this.pgClient.query(sql, values);
          continue;
        }

        // Handle user_posts_plans table
        if (table === 'user_posts_plans') {
          const nowIso = new Date().toISOString();
          const ts = String(row.timestamp || nowIso);
          const twitterId = String(row.twitter_id || '');
          const username = String(row.username || '');
          const serviceType = String(row.service_type || 'oneDayPlan');
          const createdAt = String(row.created_at || nowIso);
          const expireAt = String(row.expire_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
          const totalPostsAllowed = Number(row.total_posts_allowed || 336);
          const totalPostsCount = Number(row.total_posts_count || 0);

          // Check if a plan already exists for this user and service type
          const checkSql = `SELECT count(*) as c FROM user_posts_plans WHERE twitter_id = $1 AND service_type = $2;`;
          const checkRes = await this.pgClient.query(checkSql, [twitterId, serviceType]);

          if (checkRes.rows[0]?.c > 0) {
            // Update existing plan - don't update the timestamp as it's a designated column
            // Using string interpolation for QuestDB compatibility
            const updateSql = `
              UPDATE user_posts_plans 
              SET expire_at = '${expireAt.replace(/'/g, "''")}', 
                  total_posts_allowed = ${totalPostsAllowed}, 
                  total_posts_count = ${totalPostsCount},
                  twitter_community = '${(row.twitter_community || '').replace(/'/g, "''")}',
                  token = '${(row.token || '').replace(/'/g, "''")}'
              WHERE twitter_id = '${twitterId.replace(/'/g, "''")}' 
              AND service_type = '${serviceType.replace(/'/g, "''")}';
            `;
            await this.pgClient.query(updateSql);
          } else {
            // Insert new plan
            const insertSql = `
              INSERT INTO user_posts_plans (
                timestamp, twitter_id, username, service_type, 
                created_at, expire_at, total_posts_allowed, total_posts_count,
                twitter_community, token
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
            `;
            await this.pgClient.query(insertSql, [
              ts, twitterId, username, serviceType,
              createdAt, expireAt, totalPostsAllowed, totalPostsCount,
              row.twitter_community || '', row.token || ''
            ]);
          }
          continue;
        }

        // Generic inserts
        let sql: string;
        let values: any[];
        const timestampIso = typeof row.timestamp === 'string' ? row.timestamp : new Date(Number(row.timestamp) * 1000).toISOString();

        switch (table) {
          case 'kol_trades':
            const kolId = typeof row.kolId === 'string' ? parseInt(row.kolId, 10) : Number(row.kolId);
            const contract = String(row.contract || '');
            const txHash = String(row.txHash || '');
            // Check uniqueness using txHash only (app-level, with index for performance)
            const checkSql = `SELECT count(*) as c FROM kol_trades WHERE txHash = $1;`;
            const checkRes = await this.pgClient.query(checkSql, [txHash]);
            if (checkRes.rows[0]?.c > 0) {
              if (config.questdb.diagnosticsVerbose) logger.debug(`Skipping duplicate kol_trade: txHash=${txHash}`);
              continue;
            }
            sql = `INSERT INTO kol_trades (
              timestamp, kolId, kolName, kolAvatar, kolTwitterId, contract, action, amount, usdtPrice, initialPrice, txHash,
              fromToken, fromTokenAddress, fromTokenCount, toToken, toTokenAddress, toTokenCount, toTokenRemainCount,
              walletType, recentBuyerKols, recentSellerKols, chain
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22);`;
            values = [
              timestampIso, kolId, String(row.kolName || ''), String(row.kolAvatar || ''), String(row.kolTwitterId || ''),
              contract, String(row.action || 'unknown'), String(row.amount || ''), String(row.usdtPrice || ''), String(row.initialPrice || ''),
              txHash, String(row.fromToken || ''), String(row.fromTokenAddress || ''), String(row.fromTokenCount || ''),
              String(row.toToken || ''), String(row.toTokenAddress || ''), String(row.toTokenCount || ''), String(row.toTokenRemainCount || ''),
              Number(row.walletType || 0), JSON.stringify(row.recentBuyerKols || []), JSON.stringify(row.recentSellerKols || []),
              String(row.chain || 'BSC')
            ];
            break;
          case 'prices':
            sql = `INSERT INTO prices (timestamp, contract, priceUsd, volume, chain) VALUES ($1,$2,$3,$4,$5);`;
            values = [timestampIso, String(row.contract), row.priceUsd != null ? Number(row.priceUsd) : null, row.volume != null ? Number(row.volume) : null, String(row.chain)];
            break;
          case 'token_info':
            sql = `INSERT INTO token_info (timestamp, contract, data, chain) VALUES ($1,$2,$3,$4);`;
            values = [timestampIso, String(row.contract), String(row.data), String(row.chain)];
            break;
          case 'security_labels':
            sql = `INSERT INTO security_labels (timestamp, address, data, chain) VALUES ($1,$2,$3,$4);`;
            values = [timestampIso, String(row.address), String(row.data), String(row.chain)];
            break;
          default:
            throw new Error(`Unsupported table: ${table}`);
        }

        if (config.questdb.diagnosticsVerbose) {
          logger.debug(`[QuestDB] inserting into ${table} => ${JSON.stringify(row, null, 2)}`);
        }
        await this.pgClient.query(sql, values);
      }
      if (config.questdb.diagnosticsVerbose) {
        logger.debug(`✅ Inserted ${rows.length} rows into ${table}`);
      }
    } catch (error) {
      logger.error(`❌ PG insert failed for ${table}`, error);
      throw error;
    }
  }

  /**
   * Transforms and saves aggregated token info into the token_metrics table.
   */
  async saveTokenMetrics(contractAddress: string, chain: Chain, data: TokenInfoResponse, dexscreenerPayload?: any): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
    const kolCallInfo = data.community?.kolCallInfo;
    console.log('kolCallInfo', kolCallInfo);
    const normContract = (contractAddress || '').toLowerCase();
    const normChain = (chain || 'BSC').toUpperCase() as Chain;
    const now = new Date().toISOString();

    let price_usd: number | null = null;
    let market_cap: number | null = null;
    let fdv: number | null = null;
    let volume_5m: number | null = null;
    let volume_24h: number | null = null;
    let cto: string | null = null;

    if (dexscreenerPayload) {
      const pair = dexscreenerPayload?.pairs?.[0] || null;
      price_usd = pair?.priceUsd != null ? Number(pair.priceUsd) : null;
      market_cap = pair?.marketCap != null ? Number(pair.marketCap) : null;
      fdv = pair?.fdv != null ? Number(pair.fdv) : null;
      volume_5m = pair?.volume?.m5 != null ? Number(pair.volume.m5) : null;
      volume_24h = pair?.volume?.h24 != null ? Number(pair.volume.h24) : null;
      cto = pair?.info ? JSON.stringify(pair.info) : null;
      logger.info(`[Dexscreener] metrics for ${contractAddress}: priceUsd=${price_usd} marketCap=${market_cap} fdv=${fdv} vol5m=${volume_5m} vol24h=${volume_24h}`);
    }

    const row: Record<string, any> = {
      timestamp: now,
      contract: normContract,
      chain: normChain,
      updated_at: now,
    };

    // Add dexscreener fields if provided
    if (dexscreenerPayload) {
      row.price_usd = price_usd;
      row.market_cap = market_cap;
      row.fdv = fdv;
      row.volume_5m = volume_5m;
      row.volume_24h = volume_24h;
      row.CTO = cto;
    }

    // Add chaininsight fields if relevant
    if (data && (data.calls || data.community || data.narrative)) {
      row.call_count = data.calls?.callChannelInfo?.callChannels?.length || 0;
      row.kol_calls_count = kolCallInfo?.kolCalls?.length || 0;
      row.mention_user_count = kolCallInfo?.mentionUserCount || 0;
      row.calls_data = data.calls || {};
      row.community_data = data.community || {};
      row.narrative_data = data.narrative || {};
      row.title = data.narrative?.symbol ?? null;
    }

    logger.info(`💾 Saving token metrics for ${contractAddress} (${chain})`);
    await this.insertBatch('token_metrics', [row]);
  }

  async query(sql: string): Promise<QueryResult> {
    this.ensureInit();
    try {
      const res = await this.pgClient.query({ text: sql, rowMode: 'array' });
      return {
        rows: res.rows as TableRow[],
        columns: res.fields.map(f => f.name)
      };
    } catch (error) {
      logger.error(`❌ Query failed: ${sql}`, error);
      throw error;
    }
  }

  async getLatest(table: string, whereClause?: string, orderBy: string = 'timestamp DESC'): Promise<TableRow | null> {
    this.ensureInit();
    const where = whereClause ? `WHERE ${whereClause}` : '';
    const sql = `SELECT * FROM ${table} ${where} ORDER BY ${orderBy} LIMIT 1;`;
    const res = await this.query(sql);
    return res.rows[0] || null;
  }

  private async ensureUsersTableColumns(): Promise<void> {
    try {
      const columnsToAdd = [
        { name: 'google_id', type: 'STRING' },
        { name: 'name', type: 'STRING' },
        { name: 'picture', type: 'STRING' },
        { name: 'access_token', type: 'STRING' },
        { name: 'refresh_token', type: 'STRING' },
        { name: 'token_expiry', type: 'TIMESTAMP' },
        { name: 'last_login_at', type: 'TIMESTAMP' },
        { name: 'login_count', type: 'LONG' },
        { name: 'locale', type: 'STRING' },
        { name: 'hd', type: 'STRING' },
        { name: 'auth_provider', type: 'STRING' },
        { name: 'current_sign_in_ip', type: 'STRING' },
        { name: 'last_sign_in_ip', type: 'STRING' },
        { name: 'sign_in_count', type: 'LONG' },
        { name: 'tos_accepted_at', type: 'TIMESTAMP' },
        { name: 'email_verified', type: 'BOOLEAN' }
      ];

      // Check each column and add if it doesn't exist
      for (const column of columnsToAdd) {
        try {
          const checkSql = `SELECT * FROM table_columns('users') WHERE column = '${column.name}'`;
          const result = await this.pgClient.query(checkSql);
          
          if (result.rows.length === 0) {
            const addColumnSql = `ALTER TABLE users ADD COLUMN ${column.name} ${column.type}`;
            await this.pgClient.query(addColumnSql);
            logger.debug(`✅ Added column '${column.name}' to users table`);
          }
        } catch (error) {
          logger.warn(`Could not check/add column '${column.name}':`, error);
        }
      }
      
      // Set default values
      await this.pgClient.query(`
        UPDATE users 
        SET 
          login_count = COALESCE(login_count, 0),
          sign_in_count = COALESCE(sign_in_count, 0),
          auth_provider = COALESCE(auth_provider, 'google'),
          email_verified = COALESCE(email_verified, false)
        WHERE 
          login_count IS NULL 
          OR sign_in_count IS NULL 
          OR auth_provider IS NULL 
          OR email_verified IS NULL
      `);
      
    } catch (error) {
      logger.error('Error ensuring users table columns:', error);
    }
  }

  async close(): Promise<void> {
    if (this.sender) {
      await this.sender.close();
    }
    await this.pgClient.end();
    this.initialized = false;
    this.initPromise = undefined;
    logger.info('🔒 QuestDB connections closed');
  }
}

export const questdbService = new QuestDBService();