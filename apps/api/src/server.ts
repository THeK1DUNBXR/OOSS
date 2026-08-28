import express from 'express';
import cors from 'cors';
import routes from './routes/index.js';
import { contextMiddleware, errorMiddleware } from './lib/http.js';
import { startScheduler } from './jobs/scheduler.js';
import { registerSubscribers } from './events/handlers.js';
import { prisma } from './platform/db.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(contextMiddleware);

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', service: 'kaizen-api', time: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ status: 'degraded', error: err instanceof Error ? err.message : 'unknown' });
    }
  });

  app.use('/api', routes);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such route' } });
  });

  app.use(errorMiddleware);
  return app;
}

const port = Number(process.env.PORT ?? 4000);

if (process.env.NODE_ENV !== 'test') {
  const app = createApp();
  // Cross-domain subscribers register once at boot, against canonical names only.
  registerSubscribers();
  app.listen(port, () => {
    console.log(`Kaizen API listening on :${port}`);
    startScheduler();
  });
}
