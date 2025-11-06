import { Client } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
// Assuming the following imports are correctly defined in your project structure
// Since I don't have access to your file system, I'm keeping the original import paths.
import { config } from '../../utils/config';
import { logger } from '../../utils/logger';
// Fallback types for environment variables not accessible in this context
declare const __app_id: string;
declare const __firebase_config: string;
declare const __initial_auth_token: string | undefined;
const MIGRATIONS_TABLE = 'schema_migrations';
// Define the directory where SQL migrations are stored (relative to this file)
const MIGRATIONS_DIR = __dirname;
/**
 * MigrationRunner is responsible for connecting to QuestDB (via Postgres)
 * and applying SQL scripts located in the same directory.
 */
export class MigrationRunner {
  private client: Client;
  constructor() {
    // QuestDB uses the PostgreSQL wire protocol
    this.client = new Client({
      host: config.questdb.host,
      port: config.questdb.pgPort,
      database: 'qdb',
      user: 'admin',
      password: 'quest',
    });
  }
  async init() {
    await this.client.connect();
    await this.ensureMigrationsTable();
  }
  /**
   * Ensures the existence of the table used to track applied migrations.
   * Note: For QuestDB, using TIMESTAMP(applied_at) and PARTITION BY MONTH is standard practice.
   * Index on 'id' omitted as QuestDB does not support efficient secondary indexes on INT columns;
   * the table will remain small, so no index is needed for performance.
   */
  private async ensureMigrationsTable() {
    const query = `
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id INT,
        name STRING,
        applied_at TIMESTAMP
      ) TIMESTAMP(applied_at) PARTITION BY MONTH;
    `;
    await this.client.query(query);
  }
  /**
   * Reads, sorts, and executes new migration files.
   * The entire process runs within a single transaction (BEGIN/COMMIT/ROLLBACK).
   */
  async runMigrations() {
    await this.init();
    // Get all migration files
    logger.info(`Looking for migration files in: ${MIGRATIONS_DIR}`);
    const allFiles = readdirSync(MIGRATIONS_DIR);
    logger.debug(`All files in migrations directory: ${JSON.stringify(allFiles)}`);
    const migrationFiles = allFiles
      .filter(file => file.endsWith('.sql'));
    logger.info(`Found ${migrationFiles.length} SQL migration files: ${JSON.stringify(migrationFiles)}`);
    // Sort migrations by their numeric prefix
    const sortedMigrations = migrationFiles
      .map(file => ({
        file,
        id: parseInt(file.split('_')[0])
      }))
      .sort((a, b) => a.id - b.id)
      .map(x => x.file);
    logger.info(`Sorted migrations: ${JSON.stringify(sortedMigrations)}`);
    // Begin transaction
    // Note: QuestDB supports transactional DDL only in certain versions/contexts,
    // but using BEGIN/COMMIT/ROLLBACK is good practice for the migration tracker table.
    await this.client.query('BEGIN');
    try {
      // Get applied migrations
      const { rows: appliedMigrations } = await this.client.query<{ id: number }>(
        `SELECT id FROM ${MIGRATIONS_TABLE}`
      );
      const appliedIds = new Set(appliedMigrations.map(m => m.id));
      let migrationsRun = 0;
      logger.info(`Processing migrations, ${sortedMigrations.length} found, ${appliedIds.size} already applied`);
      for (const file of sortedMigrations) {
        const id = parseInt(file.split('_')[0]);
        if (appliedIds.has(id)) continue;
        const filePath = join(MIGRATIONS_DIR, file);
        const sql = readFileSync(filePath, 'utf-8');
        logger.info(`Running migration: ${file}`);
        // 🛠️ Robust split: Split SQL into individual statements by semicolon,
        // filtering out empty lines and lines starting with SQL comments (--)
        const statements = sql
          .split(';')
          .map(s => s.trim())
          // Filter: Keep if non-empty AND does not start with a comment
          .filter(s => s.length > 0 && !s.startsWith('--'));
        // Execute each statement individually
        for (const statement of statements) {
          logger.debug(`Executing statement: ${statement}`);
          // QuestDB DDL (like ALTER TABLE ADD INDEX) executes immediately and is not
          // part of the transaction, but we proceed with the transaction logic for safety.
          await this.client.query(statement);
        }
        // Record migration in the tracking table
        await this.client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (id, name, applied_at) VALUES ($1, $2, now())`,
          [id, file]
        );
        migrationsRun++;
        logger.info(`Successfully applied migration: ${file}`);
      }
      await this.client.query('COMMIT');
      logger.info(`Migrations complete. ${migrationsRun} new migrations applied.`);
      return migrationsRun;
    } catch (error) {
      await this.client.query('ROLLBACK');
      logger.error('Migration failed:', error);
      throw error;
    } finally {
      await this.client.end();
    }
  }
}
// Run migrations if this file is executed directly
if (require.main === module) {
  const runner = new MigrationRunner();
  runner.runMigrations()
    .then(count => process.exit(0))
    .catch(err => {
      // Use console.error directly since logger might not be fully initialized on exit path
      console.error('Migration failed:', err);
      process.exit(1);
    });
}