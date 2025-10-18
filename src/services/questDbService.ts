import { Sender } from '@questdb/nodejs-client';
import { Client } from 'pg';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { QueryResult, TableRow } from '../models/db.types';

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
      password: 'quest'
      // Add ssl: { rejectUnauthorized: false } if using HTTPS in prod
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.pgClient.connect();
      await this.pgClient.query({ text: 'SELECT 1 as ping;', rowMode: 'array' });

      const tcpConfig = `tcp::addr=${config.questdb.host}:${config.questdb.fastPort};`;
      this.sender = await Sender.fromConfig(tcpConfig);
      await this.sender.connect();  // Optional: Explicit connect for health check

      await this.createTables();
      this.initialized = true;
      logger.info('QuestDB initialized successfully (PG + Sender)');
    } catch (error) {
      logger.error('QuestDB initialization failed', error);
      throw error;
    }
  }

  private async createTables(): Promise<void> {
    const tables = [
      {
        name: 'prices',
        create: `CREATE TABLE IF NOT EXISTS prices (timestamp TIMESTAMP, contract SYMBOL, priceUsd DOUBLE, volume DOUBLE, chain SYMBOL) TIMESTAMP(timestamp) PARTITION BY DAY TTL 7d;`
      },
      {
        name: 'kol_trades',
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
        create: `CREATE TABLE IF NOT EXISTS token_info (timestamp TIMESTAMP, contract SYMBOL, data STRING, chain SYMBOL) TIMESTAMP(timestamp) PARTITION BY DAY TTL 1d;`
      },
      {
        name: 'security_labels',
        create: `CREATE TABLE IF NOT EXISTS security_labels (timestamp TIMESTAMP, address SYMBOL, data STRING, chain SYMBOL) TIMESTAMP(timestamp) PARTITION BY DAY TTL 7d;`
      }
    ];

    for (const table of tables) {
      try {
        await this.pgClient.query({ text: table.create, rowMode: 'array' });
        logger.debug(`Table ${table.name} created`);
      } catch (error) {
        logger.warn(`Table setup warning for ${table.name}:`, error);
      }
    }
    logger.info('QuestDB tables created/verified');
  }

  async insertBatch(table: string, rows: Array<Record<string, any>>): Promise<void> {
    if (rows.length === 0) return;

    try {
      for (const row of rows) {
        let sql: string;
        let values: any[];
        switch (table) {
          case 'kol_trades':
            sql = `INSERT INTO ${table} (
              timestamp, kolId, kolName, kolAvatar, kolTwitterId, contract, action, amount, usdtPrice, txHash,
              fromToken, fromTokenAddress, fromTokenCount, toToken, toTokenAddress, toTokenCount, toTokenRemainCount,
              walletType, recentBuyerKols, recentSellerKols, chain
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21);`;
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
              String(row.txHash || ''),
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
              String(row.chain || 'BSC')
            ];
            break;
          case 'prices':
            sql = `INSERT INTO ${table} (timestamp, contract, priceUsd, volume, chain) VALUES ($1, $2, $3, $4, $5);`;
            values = [row.timestamp, String(row.contract), Number(row.priceUsd), Number(row.volume), String(row.chain)];
            break;
          case 'token_info':
            sql = `INSERT INTO ${table} (timestamp, contract, data, chain) VALUES ($1, $2, $3, $4);`;
            values = [row.timestamp, String(row.contract), String(row.data), String(row.chain)];
            break;
          case 'security_labels':
            sql = `INSERT INTO ${table} (timestamp, address, data, chain) VALUES ($1, $2, $3, $4);`;
            values = [row.timestamp, String(row.address), String(row.data), String(row.chain)];
            break;
          default:
            throw new Error(`Unsupported table: ${table}`);
        }

        await this.pgClient.query({ text: sql, values, rowMode: 'array' });
      }
      logger.debug(`Inserted ${rows.length} rows into ${table} via parameterized PG`);
    } catch (error) {
      logger.error(`PG insert failed for ${table}`, error);
      throw error;
    }
  }

  // SQL Query via PG
  async query(sql: string): Promise<QueryResult> {
    try {
      const res = await this.pgClient.query({ text: sql, rowMode: 'array' });
      return {
        rows: res.rows as TableRow[],
        columns: res.fields.map(f => f.name)
      };
    } catch (error) {
      logger.error(`Query failed: ${sql}`, error);
      throw error;
    }
  }

  // Helper: Get latest row
  async getLatest(table: string, whereClause?: string, orderBy: string = 'timestamp DESC'): Promise<TableRow | null> {
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
  }
}

export const questdbService = new QuestDBService();