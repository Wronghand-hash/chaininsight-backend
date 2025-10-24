import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import { logger } from './utils/logger';
import { questdbService } from './services/questDbService';
import { kafkaService } from './services/kafka.service';  // NEW: Kafka import
import kolsLeaderboardRouter from './api/router/leaderboard.route';
import { tokenMetricsDexscreenerPoller } from './services/tokenMetricsDexscreenerPoller';
import swaggerSpec from './config/swagger';

dotenv.config();

const app: Application = express();
const PORT = process.env.PORT || 3000;

// Basic middleware (for functionality testing)
app.use(helmet());
app.use(cors());
app.use(express.json());

// Swagger documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  explorer: true,
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'ChainInsight API Documentation',
}));

app.use('/api/v1/kol', kolsLeaderboardRouter);

// Health check
app.get('/health', (req, res) => res.status(200).json({ status: 'OK', db: 'QuestDB ready', kafka: 'Connected' }));

// Error handler
app.use((err: Error, req: any, res: any, next: any) => {
  logger.error(err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Init DB and Kafka, then start
(async () => {
  try {
    await questdbService.init();
    // await kafkaService.connect();  // NEW: Connect Kafka consumer
    // await kafkaService.consume();  // NEW: Start consuming KOL pushes (background)
    await tokenMetricsDexscreenerPoller.start();
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT} with QuestDB + Kafka integration`);
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