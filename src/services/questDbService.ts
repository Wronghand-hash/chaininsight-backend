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
    // PG client for queries/inserts/DDL (with auth) - Use for all ops (stateless)
    this.pgClient = new Client({
      host: config.questdb.host,
      port: config.questdb.pgPort,
      database: 'qdb',  // QuestDB default
      user: 'admin',    // Default username
      password: 'quest' // Default password
      // Add ssl: { rejectUnauthorized: false } if using HTTPS in prod
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.pgClient.connect();
      // Test PG connection
      await this.pgClient.query({ text: 'SELECT 1 as ping;', rowMode: 'array' });

      // Async init Sender (optional for bulk; use PG for now to avoid state issues)
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
    // Inline TTL in CREATE (QuestDB requires this; no separate ALTER)
    const tables = [
      {
        name: 'prices',
        create: `CREATE TABLE IF NOT EXISTS prices (timestamp TIMESTAMP, contract SYMBOL, priceUsd DOUBLE, volume DOUBLE, chain SYMBOL) TIMESTAMP(timestamp) PARTITION BY DAY TTL 7d;`
      },
      {
        name: 'kol_trades',
        create: `CREATE TABLE IF NOT EXISTS kol_trades (timestamp TIMESTAMP, kolId STRING, contract SYMBOL, action SYMBOL, amount DOUBLE, chain SYMBOL) TIMESTAMP(timestamp) PARTITION BY DAY TTL 30d;`
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

  // FIXED: Parameterized PG INSERT (single per row for safety; no SQL escaping issues)
  async insertBatch(table: string, rows: Array<Record<string, string | number>>): Promise<void> {
    if (rows.length === 0) return;

    try {
      for (const row of rows) {
        // Parameterized INSERT per row (avoids comma/escaping errors in multi-row)
        const sql = `INSERT INTO ${table} (timestamp, kolId, contract, action, amount, chain) VALUES ($1, $2, $3, $4, $5, $6);`;
        const values = [row.timestamp, String(row.kolId || 0), String(row.contract || ''), String(row.action || 'unknown'), Number(row.amount || 0), String(row.chain || 'BSC')];

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