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

        // 🛠️ CRITICAL FIX: Split SQL into individual statements and filter out comments.
        const statements = sql
          .split(';')
          .map(s => s.trim())
          // Filter: Keep if non-empty AND does not start with standard SQL comments
          // We'll use a regex check for robustness
          .filter(s => {
            if (s.length === 0) return false;
            // Check for single-line comments (--) or multi-line comments (/*)
            const isComment = s.startsWith('--') || s.startsWith('/*');
            return !isComment;
          });

        

        // Execute each statement individually
        for (const statement of statements) {
          logger.debug(`Executing statement: ${statement}`);
          await this.client.query(statement);
        }

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