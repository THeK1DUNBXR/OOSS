/**
 * Child process for logRedaction.test.ts (G11).
 *
 * The process logger is a singleton that is silent under NODE_ENV=test, so the
 * test cannot read it in-process without replacing its stream. This file runs
 * with NODE_ENV=development instead, drives the real singleton, the real request
 * log and the real error middleware, and writes everything they produce to
 * stdout. The parent test reads that stdout. Nothing here is mocked.
 */

import express from 'express';
import { contextMiddleware, errorMiddleware } from '../lib/http.js';
import { requestLog } from '../lib/requestLog.js';
import { logger } from '../platform/logger.js';

interface Probe {
  field: string;
  sentinel: string;
}

const probes: Probe[] = JSON.parse(process.env.LOG_REDACTION_PROBES ?? '[]');

const app = express();
app.use(contextMiddleware);
app.use(requestLog());

probes.forEach(({ field, sentinel }, i) => {
  // A handler that fails with an error carrying a record's value, the way a
  // driver or a hand-built error would.
  app.get(`/fail/${i}`, () => {
    throw Object.assign(new Error('the handler failed'), { [field]: sentinel });
  });
  // A line written to the singleton with the field in its context.
  app.get(`/log/${i}`, (_req, res) => {
    logger.info({ requestId: 'probe', [field]: sentinel }, 'probe line');
    res.json({ ok: true });
  });
});

app.use(errorMiddleware);

const server = app.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < probes.length; i += 1) {
    const failed = await fetch(`${base}/fail/${i}`);
    process.stdout.write(`PROBE-HTTP ${failed.status} ${await failed.text()}\n`);
    await fetch(`${base}/log/${i}`);
  }
  server.close(() => process.exit(0));
});
