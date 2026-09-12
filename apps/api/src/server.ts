import express from 'express';
import cors from 'cors';
import routes from './routes/index.js';
import { contextMiddleware, errorMiddleware } from './lib/http.js';
import { startScheduler } from './jobs/scheduler.js';
import { registerSubscribers } from './events/handlers.js';
import { prisma } from './platform/db.js';
import { BUILD, STARTED_AT, buildLabel } from './platform/build.js';
import { reconcileNavForAllTenants } from './platform/navSync.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(contextMiddleware);

  // The build is on /health as well as behind the login, so "did my deploy land"
  // is one curl rather than a sign-in. Nothing tenant-specific is here: the seed
  // stamp is somebody's data and lives behind `/api/meta/version`.
  app.get('/health', async (_req, res) => {
    const build = { version: BUILD.version, sequence: BUILD.sequence, commit: BUILD.commit, startedAt: STARTED_AT };
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', service: 'kaizen-api', time: new Date().toISOString(), build });
    } catch (err) {
      res
        .status(503)
        .json({ status: 'degraded', error: err instanceof Error ? err.message : 'unknown', build });
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

  // The sidebar is code. Reconciling it here means a deploy is enough to make
  // the menu match what shipped — a new screen appears, a renamed one is
  // renamed, a retired one goes — without anybody remembering to run the seed.
  // Two releases in a row shipped screens that could not be reached because
  // that step was manual and nobody knew it existed.
  //
  // Failure is logged and swallowed: a menu one deploy stale is bad, an API
  // that will not start is worse.
  void reconcileNavForAllTenants()
    .then(({ tenants, written, retired }) => {
      console.log(
        `Navigation reconciled: ${written} entries across ${tenants} tenant(s)` +
          (retired > 0 ? `, ${retired} retired` : ''),
      );
    })
    .catch((error: unknown) => {
      console.error('Navigation could not be reconciled at boot:', error);
    });

  app.listen(port, () => {
    // Says which build, so a log line answers "what is running" too.
    console.log(`Kaizen API listening on :${port} — build ${buildLabel()}`);
    startScheduler();
  });
}
