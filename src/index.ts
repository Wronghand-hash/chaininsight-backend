import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { logger } from './utils/logger';
import { questdbService } from './services/questdbService';
// Note: Routes/controllers omitted per request; add back as needed

dotenv.config();

const app: Application = express();
const PORT = process.env.PORT || 3000;

// Basic middleware (for functionality testing)
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.status(200).json({ status: 'OK', db: 'QuestDB ready' }));

// Error handler
app.use((err: Error, req: any, res: any, next: any) => {
  logger.error(err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Init DB and start
(async () => {
  try {
    await questdbService.init();
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT} with QuestDB integration`);
    });
  } catch (error) {
    logger.error('Startup failed', error);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  await questdbService.close();
  process.exit(0);
});

export default app;  // For testing if needed