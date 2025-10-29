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

        // Optional connect check
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

    // --- 1. HANDLE kol_trades TABLE CREATION (NO UNIQUE INDEX SUPPORT IN QUEStDB) ---
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
    ) TIMESTAMP(timestamp) PARTITION BY DAY${wal} TTL 30d;`;
    
    try {
        await this.pgClient.query(kolTradesCreateSql);
        logger.debug(`✅ Table verified: kol_trades`);
        logger.info('Note: Uniqueness for kol_trades enforced at application level (QuestDB does not support unique constraints)');
    } catch (error) {
        logger.warn(`⚠️ Table setup warning for kol_trades:`, error);
        // If table creation fails, we must stop, as the constraint step will also fail.
        throw error;
    }
    // --- END kol_trades HANDLING ---

    // --- 2. HANDLE ALL OTHER TABLES IN A LOOP ---
    const tables = [
      {
        name: 'prices',
        create: `CREATE TABLE IF NOT EXISTS prices (
          timestamp TIMESTAMP,
          contract SYMBOL,
          priceUsd DOUBLE,
          volume DOUBLE,
          chain SYMBOL
        ) TIMESTAMP(timestamp) PARTITION BY DAY${wal} TTL 7d;`
      },
      {
        name: 'token_info',
        create: `CREATE TABLE IF NOT EXISTS token_info (
          timestamp TIMESTAMP,
          contract SYMBOL,
          data STRING,
          chain SYMBOL
        ) TIMESTAMP(timestamp) PARTITION BY DAY${wal} TTL 1d;`
      },
      {
        name: 'security_labels',
        create: `CREATE TABLE IF NOT EXISTS security_labels (
          timestamp TIMESTAMP,
          address SYMBOL,
          data STRING,
          chain SYMBOL
        ) TIMESTAMP(timestamp) PARTITION BY DAY${wal} TTL 7d;`
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
      }
    ];

    for (const table of tables) {
      try {
        await this.pgClient.query(table.create);
        logger.debug(`✅ Table verified: ${table.name}`);
      } catch (error) {
        logger.warn(`⚠️ Table setup warning for ${table.name}:`, error);
      }
    }
    // --- END OTHER TABLES HANDLING ---

    // Ensure token_metrics has the new columns if table existed before
    await this.ensureTokenMetricsColumns();

    logger.info('✅ QuestDB tables created or verified');
  }

  private async ensureTokenMetricsColumns(): Promise<void> {
    const adds: Array<{ name: string; type: string }> = [
      { name: 'price_usd', type: 'DOUBLE' },
      { name: 'market_cap', type: 'DOUBLE' },
      { name: 'fdv', type: 'DOUBLE' },
      { name: 'volume_5m', type: 'DOUBLE' },
      { name: 'volume_24h', type: 'DOUBLE' },
      { name: 'call_count', type: 'INT' },
      { name: 'kol_calls_count', type: 'INT' },
      { name: 'mention_user_count', type: 'INT' },
      { name: 'calls_data', type: 'STRING' },
      { name: 'community_data', type: 'STRING' },
      { name: 'narrative_data', type: 'STRING' },
      { name: 'title', type: 'STRING' },
      { name: 'updated_at', type: 'TIMESTAMP' },
      { name: 'CTO', type: 'STRING' },
    ];
    for (const col of adds) {
      try {
        await this.pgClient.query(`ALTER TABLE token_metrics ADD COLUMN ${col.name} ${col.type};`);
        logger.debug(`✅ token_metrics column added: ${col.name}`);
      } catch (e) {
        // Likely already exists; keep silent unless diagnosticsVerbose
        if (config.questdb.diagnosticsVerbose) {
          logger.debug(`ℹ️ token_metrics column ensure skip: ${col.name}`);
        }
      }
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
        // Special handling for token_metrics with SELECT-then-UPSERT logic
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
          const title = row.title != null ? String(row.title) : null;
          const CTOStr = row.CTO != null ? String(row.CTO) : null;
          const hasPriceUsd = Object.prototype.hasOwnProperty.call(row, 'price_usd');
          const hasMarketCap = Object.prototype.hasOwnProperty.call(row, 'market_cap');
          const hasFdv = Object.prototype.hasOwnProperty.call(row, 'fdv');
          const hasVolume5m = Object.prototype.hasOwnProperty.call(row, 'volume_5m');
          const hasVolume24h = Object.prototype.hasOwnProperty.call(row, 'volume_24h');
          const hasTitle = Object.prototype.hasOwnProperty.call(row, 'title');
          const hasCTO = Object.prototype.hasOwnProperty.call(row, 'CTO');
          const hasCallCount = Object.prototype.hasOwnProperty.call(row, 'call_count');
          const hasKolCallsCount = Object.prototype.hasOwnProperty.call(row, 'kol_calls_count');
          const hasMentionUserCount = Object.prototype.hasOwnProperty.call(row, 'mention_user_count');
          const hasCallsData = Object.prototype.hasOwnProperty.call(row, 'calls_data');
          const hasCommunityData = Object.prototype.hasOwnProperty.call(row, 'community_data');
          const hasNarrativeData = Object.prototype.hasOwnProperty.call(row, 'narrative_data');
          const callCount = Number(row.call_count || 0);
          const kolCallsCount = Number(row.kol_calls_count || 0);
          const mentionUserCount = Number(row.mention_user_count || 0);
          const callsData = JSON.stringify(row.calls_data || {});
          const communityData = JSON.stringify(row.community_data || {});
          const narrativeData = JSON.stringify(row.narrative_data || {});

          // Check existence (binds are fine for SELECT)
          const checkSql = `SELECT count(*) as c FROM token_metrics WHERE contract = $1 AND chain = $2;`;
          const checkRes = await this.pgClient.query(checkSql, [contract, chain]);
          const exists = checkRes.rows[0] && checkRes.rows[0].c > 0;

          if (exists) {
            // Perform UPDATE without bind variables to avoid QuestDB PG limitation
            const esc = (s: string) => s.replace(/'/g, "''");
            const nullable = (n: number | null) => (n == null || Number.isNaN(n) ? 'NULL' : String(n));
            const setParts: string[] = [];
            if (hasPriceUsd) setParts.push(`price_usd = ${nullable(priceUsd)}`);
            if (hasMarketCap) setParts.push(`market_cap = ${nullable(marketCap)}`);
            if (hasFdv) setParts.push(`fdv = ${nullable(fdv)}`);
            if (hasVolume5m) setParts.push(`volume_5m = ${nullable(volume5m)}`);
            if (hasVolume24h) setParts.push(`volume_24h = ${nullable(volume24h)}`);
            if (hasTitle) setParts.push(`title = ${title == null ? 'null' : `'${esc(title)}'`}`);
            if (hasCTO) setParts.push(`CTO = ${CTOStr == null ? 'null' : `'${esc(CTOStr)}'`}`);
            // Conditionally update aggregate fields
            if (hasCallCount) setParts.push(`call_count = ${callCount}`);
            if (hasKolCallsCount) setParts.push(`kol_calls_count = ${kolCallsCount}`);
            if (hasMentionUserCount) setParts.push(`mention_user_count = ${mentionUserCount}`);
            if (hasCallsData) setParts.push(`calls_data = '${esc(callsData)}'`);
            if (hasCommunityData) setParts.push(`community_data = '${esc(communityData)}'`);
            if (hasNarrativeData) setParts.push(`narrative_data = '${esc(narrativeData)}'`);
            // Always update timestamp
            setParts.push(`updated_at = '${esc(nowIso)}'`);
            const updateSql = `UPDATE token_metrics SET ${setParts.join(', ')} WHERE contract = '${esc(contract)}' AND chain = '${esc(chain)}';`;
            await this.pgClient.query(updateSql);
          } else {
            // First write: INSERT with binds (works over PG wire)
            const insertSql = `INSERT INTO token_metrics (
              timestamp, contract, chain, price_usd, market_cap, fdv, volume_5m, volume_24h,
              call_count, kol_calls_count, mention_user_count, calls_data, community_data, narrative_data, title, updated_at, CTO
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              $10, $11, $12, $13, $14, $15, $16, $17
            );`;
            await this.pgClient.query(insertSql, [
              ts,
              contract,
              chain,
              priceUsd,
              marketCap,
              fdv,
              volume5m,
              volume24h,
              callCount,
              kolCallsCount,
              mentionUserCount,
              callsData,
              communityData,
              narrativeData,
              title,
              nowIso,
              CTOStr,
            ]);
          }

          if (config.questdb.diagnosticsVerbose) {
            try {
              const total = await this.pgClient.query('SELECT count(*) AS total FROM token_metrics;');
              logger.debug(`[QuestDB] token_metrics total=${total?.rows?.[0]?.total ?? 'N/A'}`);
              const sample = await this.pgClient.query(`SELECT * FROM token_metrics ORDER BY updated_at DESC LIMIT 5;`);
              logger.debug(`[QuestDB] token_metrics latest sample=${JSON.stringify(sample?.rows ?? [])}`);
            } catch (diagError) {
              logger.warn('⚠️ token_metrics diagnostic query failed', diagError);
            }
          }

          continue; // Skip to the next row
        }

        // Generic logic for all other tables
        let sql: string;
        let values: any[];

        switch (table) {
          case 'kol_trades':
            // Ensure timestamp is a valid ISO string for TIMESTAMP column
            const timestampIso = typeof row.timestamp === 'string'
              ? row.timestamp
              : new Date(Number(row.timestamp) * 1000).toISOString();
            
            // Ensure kolId is passed as a number/long for the LONG column type
            const kolId = typeof row.kolId === 'string' ? parseInt(row.kolId, 10) : Number(row.kolId);
            const contract = String(row.contract || '');
            const txHash = String(row.txHash || '');

            // Check for existence to enforce uniqueness (QuestDB does not support unique constraints)
            const checkSql = `SELECT count(*) as c FROM kol_trades WHERE kolId = $1 AND contract = $2 AND txHash = $3;`;
            const checkRes = await this.pgClient.query(checkSql, [kolId, contract, txHash]);
            const exists = checkRes.rows[0] && checkRes.rows[0].c > 0;

            if (exists) {
              if (config.questdb.diagnosticsVerbose) {
                logger.debug(`[QuestDB] Skipping duplicate kol_trade: kolId=${kolId}, contract=${contract}, txHash=${txHash}`);
              }
              continue; // Skip to next row
            }

            sql = `INSERT INTO kol_trades (
              timestamp, kolId, kolName, kolAvatar, kolTwitterId, contract, action, amount, usdtPrice, initialPrice, txHash,
              fromToken, fromTokenAddress, fromTokenCount, toToken, toTokenAddress, toTokenCount, toTokenRemainCount,
              walletType, recentBuyerKols, recentSellerKols, chain
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22);`;
            values = [
              timestampIso,
              kolId, // LONG
              String(row.kolName || ''),
              String(row.kolAvatar || ''),
              String(row.kolTwitterId || ''),
              contract, // SYMBOL
              String(row.action || 'unknown'), // SYMBOL
              String(row.amount || ''),
              String(row.usdtPrice || ''),
              String(row.initialPrice || ''),
              txHash, // SYMBOL
              String(row.fromToken || ''),
              String(row.fromTokenAddress || ''), // SYMBOL
              String(row.fromTokenCount || ''),
              String(row.toToken || ''),
              String(row.toTokenAddress || ''), // SYMBOL
              String(row.toTokenCount || ''),
              String(row.toTokenRemainCount || ''),
              Number(row.walletType || 0),
              JSON.stringify(row.recentBuyerKols || []),
              JSON.stringify(row.recentSellerKols || []),
              String(row.chain || 'BSC') // SYMBOL
            ];
            break;

          case 'prices':
            // Ensure timestamp is ISO string
            const priceTsIso = typeof row.timestamp === 'string'
              ? row.timestamp
              : new Date(Number(row.timestamp) * 1000).toISOString();
            sql = `INSERT INTO prices (timestamp, contract, priceUsd, volume, chain)
                    VALUES ($1,$2,$3,$4,$5);`;
            values = [
              priceTsIso,
              String(row.contract),
              row.priceUsd != null ? Number(row.priceUsd) : null,
              row.volume != null ? Number(row.volume) : null,
              String(row.chain)
            ];
            break;

          case 'token_info':
            // Ensure timestamp is ISO string
            const infoTsIso = typeof row.timestamp === 'string'
              ? row.timestamp
              : new Date(Number(row.timestamp) * 1000).toISOString();
            sql = `INSERT INTO token_info (timestamp, contract, data, chain)
                    VALUES ($1,$2,$3,$4);`;
            values = [
              infoTsIso,
              String(row.contract),
              String(row.data),
              String(row.chain)
            ];
            break;

          case 'security_labels':
            // Ensure timestamp is ISO string
            const labelTsIso = typeof row.timestamp === 'string'
              ? row.timestamp
              : new Date(Number(row.timestamp) * 1000).toISOString();
            sql = `INSERT INTO security_labels (timestamp, address, data, chain)
                    VALUES ($1,$2,$3,$4);`;
            values = [
              labelTsIso,
              String(row.address),
              String(row.data),
              String(row.chain)
            ];
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
      // Error code '23505' is often the PostgreSQL code for a unique violation.
      // QuestDB uses '42710' for "duplicate object" but sometimes other codes.
      // It is critical to confirm the QuestDB error code for unique constraint violations
      // to properly handle the Kafka at-least-once delivery duplicates here.
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
      try {
        logger.info(`[Dexscreener] full payload for ${contractAddress}: ${JSON.stringify(dexscreenerPayload)}`);
      } catch { }

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

    // Always include dexscreener fields if payload provided
    if (dexscreenerPayload) {
      row.price_usd = price_usd;
      row.market_cap = market_cap;
      row.fdv = fdv;
      row.volume_5m = volume_5m;
      row.volume_24h = volume_24h;
      row.CTO = cto;
    }

    // Include chaininsight fields only if data has relevant content
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