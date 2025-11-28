import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import { logger } from './utils/logger';
import { questdbService } from './services/questDbService';
import { kafkaService } from './services/kafka.service';  // NEW: Kafka import
import kolsLeaderboardRouter from './api/router/leaderboard.route';
import { tokenMetricsDexscreenerPoller } from './services/tokenMetricsDexscreenerPoller'
import cookieParser from 'cookie-parser';  // Ensure this middleware is used: app.use(cookieParser());
import { MigrationRunner } from './db/migrations/migration-runner';
import swaggerSpec from './config/swagger';
import { walletService } from './services/payments/paymentService';
import { solanaPaymentCheckerService } from './services/payments/checkSOLpayment';
import { bscPaymentCheckerService } from './services/payments/checkBSCpayment';
import { paymentTransferCron } from './services/crons/paymentTrasnfer.cron';
import { freeTokenMetricsDexscreenerPoller } from './services/freeTokenMetricsDexscreenerPoller';
dotenv.config();

const app: Application = express();
const PORT = process.env.PORT || 3000;

// Basic middleware (for functionality testing)
app.use(helmet());
const allowedOrigins = [
  'https://xalerts.vercel.app',
  'http://localhost:3000',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
].filter((value, index, self) => self.indexOf(value) === index);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('Not allowed by CORS'));
    }
    return callback(null, true);
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use(express.json());
app.use(cookieParser());

// Swagger documentation
app.use('/scanner/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  explorer: true,
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'ChainInsight API Documentation',
}));

app.use('/scanner/api/v1/kol', kolsLeaderboardRouter);

// Health check
app.get('/scanner/health', (req, res) => res.status(200).json({ status: 'OK', db: 'QuestDB ready', kafka: 'Connected' }));

// Error handler
app.use((err: Error, req: any, res: any, next: any) => {
  logger.error(err.message);
  res.status(500).json({ error: 'Internal server error' });
});



// Run database migrations
const runMigrations = async () => {
  try {
    const migrationRunner = new MigrationRunner();
    const migrationsApplied = await migrationRunner.runMigrations();
    logger.info(`Applied ${migrationsApplied} database migrations`);
  } catch (error) {
    logger.error('Failed to run database migrations:', error);
    process.exit(1);
  }
};

// Init DB, run migrations, and start the server
(async () => {
  try {
    await questdbService.init();
    // await runMigrations();
    // await kafkaService.connect();  // NEW: Connect Kafka consumer
    // await kafkaService.consume();  // NEW: Start consuming KOL pushes (background)
    await tokenMetricsDexscreenerPoller.start();
    // await freeTokenMetricsDexscreenerPoller.start()
    // await solanaPaymentCheckerService.startCron();
    // bscPaymentCheckerService.startCron();
    // paymentTransferCron.runTransferCron();


    //test payement service
    try {
      // const result = walletService.generateAndLogKeyPair('BSC', 'iwan', 1);
      // console.log(result);
    } catch (error) {
      logger.error('Payment service test failed:', error);
    }
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT} with QuestDB`);
    });
  } catch (error) {
    logger.error('Startup failed', error);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  await kafkaService.disconnect();  // NEW: Disconnect Kafka
  tokenMetricsDexscreenerPoller.stop();
  await questdbService.close();
  process.exit(0);
});

export default app;  // For testing if needed
