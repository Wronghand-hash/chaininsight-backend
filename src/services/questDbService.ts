import { Sender } from '@questdb/nodejs-client';
import { Client } from 'pg';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { QueryResult, TableRow } from '../models/db.types';

// Supported chains
type Chain = 'BSC' | 'ETH' | 'SOL';

type TokenInfoResponse = {
  narrative: any;
  community: any;
  calls: any;
};

export class QuestDBService {
  private sender?: Sender;
  private pgClient: Client;
  private initialized = false;

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
      logger.debug('QuestDB already initialized, skipping re-init');
      return;
    }

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
  }

  private async createTables(): Promise<void> {
    const tables = [
      {
        name: 'prices',
        create: `CREATE TABLE IF NOT EXISTS prices (
          timestamp TIMESTAMP,
          contract SYMBOL,
          priceUsd DOUBLE,
          volume DOUBLE,
          chain SYMBOL
        ) TIMESTAMP(timestamp) PARTITION BY DAY TTL 7d;`
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
          amount DOUBLE,
          usdtPrice DOUBLE,
          initialPrice DOUBLE,
          txHash SYMBOL,
          fromToken STRING,
          fromTokenAddress SYMBOL,
          fromTokenCount DOUBLE,
          toToken STRING,
          toTokenAddress SYMBOL,
          toTokenCount DOUBLE,
          toTokenRemainCount DOUBLE,
          walletType INT,
          recentBuyerKols STRING,
          recentSellerKols STRING,
          chain SYMBOL
        ) TIMESTAMP(timestamp) PARTITION BY DAY TTL 30d;`
      },
      {
        name: 'token_info',
        create: `CREATE TABLE IF NOT EXISTS token_info (
          timestamp TIMESTAMP,
          contract SYMBOL,
          data STRING,
          chain SYMBOL
        ) TIMESTAMP(timestamp) PARTITION BY DAY TTL 1d;`
      },
      {
        name: 'security_labels',
        create: `CREATE TABLE IF NOT EXISTS security_labels (
          timestamp TIMESTAMP,
          address SYMBOL,
          data STRING,
          chain SYMBOL
        ) TIMESTAMP(timestamp) PARTITION BY DAY TTL 7d;`
      },
      {
        name: 'token_metrics',
        create: `CREATE TABLE IF NOT EXISTS token_metrics (
          timestamp TIMESTAMP,
          contract SYMBOL,
          chain SYMBOL,
          call_count INT,
          kol_calls_count INT,
          mention_user_count INT,
          calls_data STRING,
          community_data STRING,
          narrative_data STRING
        ) TIMESTAMP(timestamp) PARTITION BY DAY TTL 7d;`
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

    logger.info('✅ QuestDB tables created or verified');
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
        let sql: string;
        let values: any[];

        switch (table) {
          case 'kol_trades':
            // FIX: Added 'initialPrice' to the column list and updated placeholders to $22.
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
              Number(row.amount || 0),
              Number(row.usdtPrice || 0),
              // FIX: Added initialPrice value
              Number(row.initialPrice || 0), // $10
              String(row.txHash || ''), // $11 (shifted)
              String(row.fromToken || ''),
              String(row.fromTokenAddress || ''),
              Number(row.fromTokenCount || 0),
              String(row.toToken || ''),
              String(row.toTokenAddress || ''),
              Number(row.toTokenCount || 0),
              Number(row.toTokenRemainCount || 0),
              Number(row.walletType || 0),
              JSON.stringify(row.recentBuyerKols || []),
              JSON.stringify(row.recentSellerKols || []),
              String(row.chain || 'BSC') // $22
            ];
            break;

          case 'prices':
            sql = `INSERT INTO prices (timestamp, contract, priceUsd, volume, chain)
                    VALUES ($1,$2,$3,$4,$5);`;
            values = [
              row.timestamp,
              String(row.contract),
              Number(row.priceUsd),
              Number(row.volume),
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

          case 'token_metrics':
            sql = `INSERT INTO token_metrics (
              timestamp, contract, chain, call_count, kol_calls_count,
              mention_user_count, calls_data, community_data, narrative_data
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9);`;
            values = [
              row.timestamp,
              String(row.contract || ''),
              String(row.chain || 'BSC'),
              Number(row.call_count || 0),
              Number(row.kol_calls_count || 0),
              Number(row.mention_user_count || 0),
              JSON.stringify(row.calls_data || {}),
              JSON.stringify(row.community_data || {}),
              JSON.stringify(row.narrative_data || {})
            ];
            break;

          default:
            throw new Error(`Unsupported table: ${table}`);
        }

        logger.debug(`[QuestDB] inserting into ${table} => ${JSON.stringify(row, null, 2)}`);
        await this.pgClient.query(sql, values);
      }

      logger.debug(`✅ Inserted ${rows.length} rows into ${table}`);
    } catch (error) {
      logger.error(`❌ PG insert failed for ${table}`, error);
      throw error;
    }
  }

  /**
   * Transforms and saves aggregated token info into the token_metrics table.
   */
  async saveTokenMetrics(contractAddress: string, chain: Chain, data: TokenInfoResponse): Promise<void> {
    this.ensureInit();

    const kolCallInfo = data.community?.kolCallInfo;
    console.log('kolCallInfo', kolCallInfo);
    const row = {
      timestamp: new Date().toISOString(), // UTC timestamp
      contract: contractAddress,
      chain: chain,
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
    logger.info('🔒 QuestDB connections closed');
  }
}

export const questdbService = new QuestDBService();
