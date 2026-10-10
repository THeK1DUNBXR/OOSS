/**
 * FX-52 and Phase 0.3/0.4: what the HTTP edge will and will not say.
 *
 * These run against createApp() and a real database, as every API test does.
 * The rate-limit assertion reads the Postgres counter directly: a limit that
 * only lives in one process's memory holds for one process and nothing else,
 * which is the defect the shared store exists to close.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createApp } from '../server.js';
import { contextMiddleware, errorMiddleware } from '../lib/http.js';
import { requestLog } from '../lib/requestLog.js';
import { createLogger } from '../platform/logger.js';
import { unscopedPrisma } from '../platform/db.js';

const ALLOWED = 'https://zen.kaizen.test';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp({ webDistDir: '', corsOrigins: [ALLOWED] });
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('CORS allowlist (FX-52)', () => {
  it('sends no Access-Control-Allow-Origin to an origin that is not allowlisted', async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('echoes an allowlisted origin', async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: ALLOWED } });
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
  });

  it('refuses a preflight from an origin that is not allowlisted', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a same-origin request, which carries no Origin header', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });
});

describe('security headers (helmet)', () => {
  it('sends a CSP that forbids inline scripts, and leaves HSTS to Caddy', async () => {
    const res = await fetch(`${base}/health`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });
});

describe('login rate limit', () => {
  it('refuses the sixth attempt in a minute with 429, and counts it in Postgres', async () => {
    await unscopedPrisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE key LIKE 'login:%'`;
    const email = `rate-${Date.now()}@kaizen.test`;
    const statuses: number[] = [];
    let last: { error: { code: string } } | undefined;
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'wrong-password-value' }),
      });
      statuses.push(res.status);
      if (res.status === 429) last = (await res.json()) as { error: { code: string } };
    }
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
    expect(last?.error.code).toBe('RATE_LIMITED');

    const rows = await unscopedPrisma.$queryRaw<{ hits: number }[]>`
      SELECT hits FROM "RateLimitBucket" WHERE key LIKE 'login:%'`;
    expect(rows.some((r) => r.hits >= 6)).toBe(true);
  });
});

describe('unexpected errors (http.ts errorMiddleware)', () => {
  it('returns a generic body with a request id, never the message', async () => {
    const app = express();
    app.use(contextMiddleware);
    app.get('/boom', () => {
      throw new Error('connect ECONNREFUSED postgresql://kaizen:hunter2@db.internal:5432/kaizen');
    });
    app.use(errorMiddleware);
    const s = app.listen(0);
    const port = (s.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/boom`);
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('ECONNREFUSED');
      const body = JSON.parse(text) as { error: { code: string; requestId?: string } };
      expect(body.error.code).toBe('INTERNAL');
      expect(body.error.requestId).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});

describe('body parser errors (http.ts errorMiddleware)', () => {
  it('answers a malformed JSON body with 400, not a generic 500', async () => {
    const res = await fetch(`${base}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email": "person@kaizen.test",',
    });
    const body = (await res.json()) as { error: { code: string; message?: string; requestId?: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('person@kaizen.test');
  });

  it('answers a body over the 2mb limit with 413, not a generic 500', async () => {
    const res = await fetch(`${base}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(2_500_000) }),
    });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(413);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('structured logging (platform/logger.ts)', () => {
  it('drops fields that are not on the allowlist, such as email and password', () => {
    const chunks: string[] = [];
    const log = createLogger({ destination: { write: (s: string) => void chunks.push(s) } });
    log.info({ tenantId: 'tenant-1', requestId: 'req-1', email: 'person@kaizen.test', password: 'hunter2' }, 'signed in');
    const line = chunks.join('');
    expect(line).toContain('"tenantId":"tenant-1"');
    expect(line).toContain('"requestId":"req-1"');
    expect(line).not.toContain('person@kaizen.test');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('"email"');
    expect(line).not.toContain('"password"');
  });

  it('logs the route pattern, never the raw path, so a public token in the path stays out of the log', async () => {
    // The public form and webhook routes carry their token in the path itself.
    // A raw path in the log would hand every token to anyone who can read logs.
    const chunks: string[] = [];
    const log = createLogger({ destination: { write: (s: string) => void chunks.push(s) } });
    const app = express();
    app.use(contextMiddleware);
    app.use(requestLog(log));
    app.post('/public/forms/:publicToken/submit', (_req, res) => void res.json({ ok: true }));
    const s = app.listen(0);
    const port = (s.address() as { port: number }).port;
    try {
      await fetch(`http://127.0.0.1:${port}/public/forms/tok-SECRET-form-token-9f8e7d/submit`, { method: 'POST' });
      await fetch(`http://127.0.0.1:${port}/no/such/tok-SECRET-form-token-9f8e7d`);
      const line = chunks.join('');
      expect(line).not.toContain('tok-SECRET-form-token-9f8e7d');
      expect(line).toContain('"route":"/public/forms/:publicToken/submit"');
      expect(line).toContain('"route":"unmatched"');
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('puts tenantId and requestId on the request line, and never the query string', async () => {
    const chunks: string[] = [];
    const log = createLogger({ destination: { write: (s: string) => void chunks.push(s) } });
    const app = express();
    app.use(contextMiddleware);
    app.use(requestLog(log));
    app.get('/ping', (_req, res) => void res.json({ ok: true }));
    const s = app.listen(0);
    const port = (s.address() as { port: number }).port;
    try {
      await fetch(`http://127.0.0.1:${port}/ping?token=secret-token-value`);
      const line = chunks.join('');
      expect(line).toContain('"requestId":');
      expect(line).toContain('"tenantId":null');
      expect(line).toContain('"path":"/ping"');
      expect(line).not.toContain('secret-token-value');
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});
