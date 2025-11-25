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
  /**
   * Fixes the google_users table by recreating it with the correct schema
   */
  private async fixGoogleUsersTable() {
    logger.info('Applying Google Users table fix...');
    
    const googleUsersFixSql = `
      DROP TABLE IF EXISTS google_users;

      CREATE TABLE google_users (
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
      ) TIMESTAMP(created_at) PARTITION BY DAY;
    `;

    try {
      // Split and execute each statement
      const statements = googleUsersFixSql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));

      for (const statement of statements) {
        logger.debug(`Executing Google Users fix: ${statement.substring(0, 100)}...`);
        await this.client.query(statement);
      }

      // Update existing rows with default values
      const updateSql = `
        UPDATE google_users
        SET
          login_count = COALESCE(login_count, 0),
          sign_in_count = COALESCE(sign_in_count, 0),
          auth_provider = COALESCE(auth_provider, 'google'),
          email_verified = COALESCE(email_verified, false)
        WHERE
          login_count IS NULL
          OR sign_in_count IS NULL
          OR auth_provider IS NULL
          OR email_verified IS NULL;
      `;

      await this.client.query(updateSql);
      logger.info('✅ Google Users table fix applied successfully');
      return true;
    } catch (error) {
      logger.error('❌ Failed to apply Google Users table fix:', error);
      throw error;
    }
  }

  async runMigrations() {
    await this.init();
    
    // Apply Google Users table fix first
    try {
      await this.fixGoogleUsersTable();
    } catch (error) {
      logger.error('Error applying Google Users table fix, continuing with other migrations...', error);
    }
    
    // Get all migration files
    logger.info(`Looking for migration files in: ${MIGRATIONS_DIR}`);
    const allFiles = readdirSync(MIGRATIONS_DIR);
    logger.debug(`All files in migrations directory: ${JSON.stringify(allFiles)}`);
    const migrationFiles = allFiles
      .filter(file => file.endsWith('.sql'));
    logger.info(`Found ${migrationFiles.length} SQL migration files: ${JSON.stringify(migrationFiles)}`);
    // Sort migrations by their numeric prefix
    const sortedMigrations = migrationFiles
      .map(file => {
        // Extract the numeric part at the start of the filename
        const match = file.match(/^(\d+)_/);
        const id = match ? parseInt(match[1], 10) : 0;
        return { file, id };
      })
      .sort((a, b) => a.id - b.id)
      .map(x => x.file);

    logger.info(`Migration files found: ${migrationFiles.join(', ')}`);
    logger.info(`Sorted migrations: ${JSON.stringify(sortedMigrations)}`);
    // Begin transaction
    // Note: QuestDB supports transactional DDL only in certain versions/contexts,
    // but using BEGIN/COMMIT/ROLLBACK is good practice for the migration tracker table.
    await this.client.query('BEGIN');
    try {
      // Get applied migrations with names for better debugging
      const { rows: appliedMigrations } = await this.client.query<{ id: number, name: string }>(
        `SELECT id, name FROM ${MIGRATIONS_TABLE} ORDER BY id`
      );
      logger.info(`Applied migrations: ${JSON.stringify(appliedMigrations)}`);

      const appliedIds = new Set(appliedMigrations.map(m => m.id));
      let migrationsRun = 0;

      // Check for missing migrations in the database
      const missingMigrations = sortedMigrations.filter(file => {
        const match = file.match(/^(\d+)_/);
        const id = match ? parseInt(match[1], 10) : 0;
        return !appliedIds.has(id);
      });
      logger.info(`Missing migrations that need to be applied: ${JSON.stringify(missingMigrations)}`);

      // Check for migrations in DB without corresponding files
      const extraMigrations = appliedMigrations.filter(m =>
        !sortedMigrations.some(file => file.startsWith(m.id.toString().padStart(4, '0') + '_'))
      );
      if (extraMigrations.length > 0) {
        logger.warn(`Found ${extraMigrations.length} migrations in the database without corresponding files: ${JSON.stringify(extraMigrations)}`);
      }

      logger.info(`Processing migrations, ${sortedMigrations.length} found, ${appliedIds.size} already applied`);
      for (const file of sortedMigrations) {
        const match = file.match(/^(\d+)_/);
        if (!match) {
          logger.warn(`Skipping invalid migration file (missing ID prefix): ${file}`);
          continue;
        }

        const id = parseInt(match[1], 10);
        if (appliedIds.has(id)) {
          logger.debug(`Skipping already applied migration: ${file} (ID: ${id})`);
          continue;
        }

        const filePath = join(MIGRATIONS_DIR, file);
        logger.info(`Applying migration: ${file} (ID: ${id})`);

        try {
          const sql = readFileSync(filePath, 'utf-8');

          // 🛠️ Robust split: Split SQL into individual statements by semicolon,
          // filtering out empty lines and lines starting with SQL comments (--)
          const statements = sql
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0 && !s.startsWith('--'));

          // Execute each statement individually
          for (const [index, statement] of statements.entries()) {
            const shortStmt = statement.length > 100 ? `${statement.substring(0, 100)}...` : statement;
            logger.debug(`[${file}] Executing statement ${index + 1}/${statements.length}: ${shortStmt}`);

            try {
              await this.client.query(statement);
            } catch (error: any) {
              logger.error(`Error executing statement ${index + 1} in ${file}: ${error.message}`);
              logger.error(`Failed statement: ${statement}`);
              throw error; // Re-throw to trigger transaction rollback
            }
          }
          // Record migration in the tracking table
          await this.client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (id, name, applied_at) VALUES ($1, $2, now())`,
            [id, file]
          );
          migrationsRun++;
          logger.info(`✅ Successfully applied migration: ${file} (ID: ${id})`);

        } catch (error) {
          logger.error(`❌ Failed to apply migration ${file} (ID: ${id}):`, error);
          throw error; // This will trigger the transaction rollback
        }
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