import { Client } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { config } from '../../utils/config';
import { logger } from '../../utils/logger';

const MIGRATIONS_TABLE = 'schema_migrations';
const MIGRATIONS_DIR = __dirname;

export class MigrationRunner {
  private client: Client;

  constructor() {
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

  private async ensureMigrationsTable() {
    const query = `
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id INTEGER NOT NULL,
        name STRING,
        applied_at TIMESTAMP
      ) TIMESTAMP(applied_at) PARTITION BY MONTH;
    `;
    await this.client.query(query);
  }

  async runMigrations() {
    await this.init();
    
    // Get all migration files
    const migrationFiles = readdirSync(MIGRATIONS_DIR)
      .filter(file => file.endsWith('.sql'))
      .sort();

    logger.info(`Found ${migrationFiles.length} migration files`);

    // Begin transaction
    await this.client.query('BEGIN');

    try {
      // Get applied migrations
      const { rows: appliedMigrations } = await this.client.query<{ id: number }>(
        `SELECT id FROM ${MIGRATIONS_TABLE}`
      );

      const appliedIds = new Set(appliedMigrations.map(m => m.id));
      let migrationsRun = 0;

      for (const file of migrationFiles) {
        const id = parseInt(file.split('_')[0]);
        if (appliedIds.has(id)) continue;

        const filePath = join(MIGRATIONS_DIR, file);
        const sql = readFileSync(filePath, 'utf-8');

        logger.info(`Running migration: ${file}`);
        await this.client.query(sql);

        // Record migration
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
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
