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

  /**
   * Saves Dexscreener metrics (price_usd, market_cap, fdv, volume_5m, volume_24h) and raw payload
   * into token_metrics, keyed by (contract, chain). Logs full payload at info level.
   */
  async saveDexscreenerMetrics(contractAddress: string, chain: Chain, dexscreenerPayload: any): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }

    try {
      logger.info(`[Dexscreener] full payload for ${contractAddress}: ${JSON.stringify(dexscreenerPayload)}`);
    } catch {}

    const pair = dexscreenerPayload?.pairs?.[0] || null;
    const priceUsd = pair?.priceUsd != null ? Number(pair.priceUsd) : null;
    const marketCap = pair?.marketCap != null ? Number(pair.marketCap) : null;
    const fdv = pair?.fdv != null ? Number(pair.fdv) : null;
    const volume5m = pair?.volume?.m5 != null ? Number(pair.volume.m5) : null;
    const volume24h = pair?.volume?.h24 != null ? Number(pair.volume.h24) : null;

    logger.info(`[Dexscreener] metrics for ${contractAddress}: priceUsd=${priceUsd} marketCap=${marketCap} fdv=${fdv} vol5m=${volume5m} vol24h=${volume24h}`);

    const row = {
      timestamp: new Date().toISOString(),
      contract: (contractAddress || '').toLowerCase(),
      chain: (chain || 'BSC').toUpperCase(),
      price_usd: priceUsd,
      market_cap: marketCap,
      fdv,
      volume_5m: volume5m,
      volume_24h: volume24h,
    };

    await this.insertBatch('token_metrics', [row]);
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
        name: 'kol_trades',
        // FIX: Added 'initialPrice DOUBLE' to match the insertion logic in kafka.service.ts
        create: `CREATE TABLE IF NOT EXISTS kol_trades (
          timestamp TIMESTAMP,
          kolId STRING,
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
        ) TIMESTAMP(timestamp) PARTITION BY DAY${wal} TTL 30d;`
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
          dexscreener_raw STRING,
          call_count INT,
          kol_calls_count INT,
          mention_user_count INT,
          calls_data STRING,
          community_data STRING,
          narrative_data STRING,
          updated_at TIMESTAMP
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
      { name: 'dexscreener_raw', type: 'STRING' },
      { name: 'call_count', type: 'INT' },
      { name: 'kol_calls_count', type: 'INT' },
      { name: 'mention_user_count', type: 'INT' },
      { name: 'calls_data', type: 'STRING' },
      { name: 'community_data', type: 'STRING' },
      { name: 'narrative_data', type: 'STRING' },
      { name: 'updated_at', type: 'TIMESTAMP' },
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
          const dexscreenerRaw = row.dexscreener_raw != null ? JSON.stringify(row.dexscreener_raw) : null;
          const hasPriceUsd = Object.prototype.hasOwnProperty.call(row, 'price_usd');
          const hasMarketCap = Object.prototype.hasOwnProperty.call(row, 'market_cap');
          const hasFdv = Object.prototype.hasOwnProperty.call(row, 'fdv');
          const hasVolume5m = Object.prototype.hasOwnProperty.call(row, 'volume_5m');
          const hasVolume24h = Object.prototype.hasOwnProperty.call(row, 'volume_24h');
          const hasDexRaw = Object.prototype.hasOwnProperty.call(row, 'dexscreener_raw');
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
            if (hasDexRaw) setParts.push(`dexscreener_raw = ${dexscreenerRaw == null ? 'null' : `'${esc(dexscreenerRaw)}'`}`);
            // Always update these aggregate fields
            setParts.push(
              `call_count = ${callCount}`,
              `kol_calls_count = ${kolCallsCount}`,
              `mention_user_count = ${mentionUserCount}`,
              `calls_data = '${esc(callsData)}'`,
              `community_data = '${esc(communityData)}'`,
              `narrative_data = '${esc(narrativeData)}'`,
              `updated_at = '${esc(nowIso)}'`
            );
            const updateSql = `UPDATE token_metrics SET ${setParts.join(', ')} WHERE contract = '${esc(contract)}' AND chain = '${esc(chain)}';`;
            await this.pgClient.query(updateSql);
          } else {
            // First write: INSERT with binds (works over PG wire)
            const insertSql = `INSERT INTO token_metrics (
              timestamp, contract, chain, price_usd, market_cap, fdv, volume_5m, volume_24h, dexscreener_raw,
              call_count, kol_calls_count, mention_user_count, calls_data, community_data, narrative_data, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              $10, $11, $12, $13, $14, $15, $16
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
              dexscreenerRaw,
              callCount,
              kolCallsCount,
              mentionUserCount,
              callsData,
              communityData,
              narrativeData,
              nowIso,
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
            sql = `INSERT INTO kol_trades (
              timestamp, kolId, kolName, kolAvatar, kolTwitterId, contract, action, amount, usdtPrice, initialPrice, txHash,
              fromToken, fromTokenAddress, fromTokenCount, toToken, toTokenAddress, toTokenCount, toTokenRemainCount,
              walletType, recentBuyerKols, recentSellerKols, chain
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22);`;
            values = [
              row.timestamp,
              String(row.kolId || ''),
              String(row.kolName || ''),
              String(row.kolAvatar || ''),
              String(row.kolTwitterId || ''),
              String(row.contract || ''),
              String(row.action || 'unknown'),
              String(row.amount || ''),
              String(row.usdtPrice || ''),
              String(row.initialPrice || ''),
              String(row.txHash || ''),
              String(row.fromToken || ''),
              String(row.fromTokenAddress || ''),
              String(row.fromTokenCount || ''),
              String(row.toToken || ''),
              String(row.toTokenAddress || ''),
              String(row.toTokenCount || ''),
              String(row.toTokenRemainCount || ''),
              Number(row.walletType || 0),
              JSON.stringify(row.recentBuyerKols || []),
              JSON.stringify(row.recentSellerKols || []),
              String(row.chain || 'BSC')
            ];
            break;

          case 'prices':
            sql = `INSERT INTO prices (timestamp, contract, priceUsd, volume, chain)
                    VALUES ($1,$2,$3,$4,$5);`;
            values = [
              row.timestamp,
              String(row.contract),
              row.priceUsd != null ? Number(row.priceUsd) : null,
              row.volume != null ? Number(row.volume) : null,
              String(row.chain)
            ];
            break;

          case 'token_info':
            sql = `INSERT INTO token_info (timestamp, contract, data, chain)
                    VALUES ($1,$2,$3,$4);`;
            values = [
              row.timestamp,
              String(row.contract),
              String(row.data),
              String(row.chain)
            ];
            break;

          case 'security_labels':
            sql = `INSERT INTO security_labels (timestamp, address, data, chain)
                    VALUES ($1,$2,$3,$4);`;
            values = [
              row.timestamp,
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
      logger.error(`❌ PG insert failed for ${table}`, error);
      throw error;
    }
  }

  /**
   * Transforms and saves aggregated token info into the token_metrics table.
   */
  async saveTokenMetrics(contractAddress: string, chain: Chain, data: TokenInfoResponse): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }

    const kolCallInfo = data.community?.kolCallInfo;
    console.log('kolCallInfo', kolCallInfo);
    const normContract = (contractAddress || '').toLowerCase();
    const normChain = (chain || 'BSC').toUpperCase() as Chain;
    const row = {
      timestamp: new Date().toISOString(),
      contract: normContract,
      chain: normChain,
      // Dexscreener metrics may be patched in by a separate call
      call_count: data.calls?.callChannelInfo?.callChannels?.length || 0,
      kol_calls_count: kolCallInfo?.kolCalls?.length || 0,
      mention_user_count: kolCallInfo?.mentionUserCount || 0,
      calls_data: data.calls || {},
      community_data: data.community || {},
      narrative_data: data.narrative || {}
    };

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
