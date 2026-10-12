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
import { apiErrorBody, contextMiddleware, errorMiddleware } from '../lib/http.js';
import { requestLog } from '../lib/requestLog.js';
import { createLogger } from '../platform/logger.js';
import { ApiError } from '../platform/errors.js';
import type { AxisOutcome } from '@kaizen/shared';
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

describe('0.3 ApiError details reach the client by allowlist only', () => {
  // A route that throws an ApiError whose details carry what a careless caller
  // might put there: a stack, a SQL fragment, a raw cause, another tenant's id,
  // beside the reason code and field errors the client is meant to get.
  const SECRET_STACK = 'at Object.<anonymous> (/srv/api/src/domains/x.ts:1:1)';
  const SECRET_SQL = 'INSERT INTO "journal_lines" VALUES (1)';
  const OTHER_TENANT = 'tenant-of-another-company-0001';

  async function over(err: unknown): Promise<{ status: number; body: { error: Record<string, unknown> } }> {
    const app = express();
    app.use(contextMiddleware);
    app.get('/probe', () => {
      throw err;
    });
    app.use(errorMiddleware);
    const s = app.listen(0);
    const port = (s.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/probe`);
      return { status: res.status, body: (await res.json()) as { error: Record<string, unknown> } };
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  }

  it('sends the keys a client reads, and drops a stack, SQL, a raw cause and another tenant id', async () => {
    const { status, body } = await over(
      new ApiError(422, 'UNPROCESSABLE', 'Refused.', {
        reasonCode: 'accounting_period_closed',
        blockingCount: 2,
        formErrors: [],
        fieldErrors: { amount: ['Required'] },
        stack: SECRET_STACK,
        sql: SECRET_SQL,
        cause: new Error(SECRET_SQL),
        subsidiaryTenantId: OTHER_TENANT,
      }),
    );
    expect(status).toBe(422);
    expect(body.error.details).toEqual({
      reasonCode: 'accounting_period_closed',
      blockingCount: 2,
      formErrors: [],
      fieldErrors: { amount: ['Required'] },
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET_STACK);
    expect(text).not.toContain('journal_lines');
    expect(text).not.toContain(OTHER_TENANT);
  });

  it('still hoists candidates and axes to the top of the error, where the client reads them', async () => {
    const candidates = [{ personId: 'p-1', score: 0.9 }];
    const axes: AxisOutcome[] = [{ axis: 'WHO', passed: false, reason: 'no grant' }];
    const dup = await over(ApiError.duplicate('Match.', candidates));
    expect(dup.body.error.candidates).toEqual(candidates);
    const denied = await over(ApiError.forbidden('No.', axes));
    expect(denied.body.error.axes).toEqual(axes);
  });

  it('keeps the permitted next states a refused campaign move names (marketing/campaigns.ts:678)', async () => {
    const { status, body } = await over(
      ApiError.conflict("Invalid transition: cannot launch a campaign from 'draft' to 'closed'.", {
        from: 'draft',
        to: 'closed',
        allowed: ['scheduled', 'cancelled'],
      }),
    );
    expect(status).toBe(409);
    expect(body.error.details).toEqual({ from: 'draft', to: 'closed', allowed: ['scheduled', 'cancelled'] });
  });

  it('drops details that are not an object, rather than sending them as they are', async () => {
    const { body } = await over(new ApiError(409, 'CONFLICT', 'Taken.', `raw ${SECRET_SQL}`));
    expect(JSON.stringify(body)).not.toContain('journal_lines');
  });
});

describe('0.3 a 5xx ApiError in production sends no message text', () => {
  it('replaces the message and the details with a generic one, and keeps the code', () => {
    const err = ApiError.internal('relation "journal_lines" violates check on tenant t-2', { stack: 'x' });
    const body = apiErrorBody(err, { production: true, requestId: 'req-9' });
    expect(JSON.stringify(body)).not.toContain('journal_lines');
    expect(JSON.stringify(body)).not.toContain('t-2');
    expect(body).toEqual({
      error: { code: 'INTERNAL', message: expect.any(String), requestId: 'req-9' },
    });
  });

  it('keeps a 4xx message, which is written for the user', () => {
    const err = ApiError.unprocessable('No accounting period is open for 2026-10.');
    const body = apiErrorBody(err, { production: true, requestId: 'req-9' });
    expect(body.error.message).toBe('No accounting period is open for 2026-10.');
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
    log.info(
      { tenantId: 'tenant-1', requestId: 'req-1', email: 'person@kaizen.test', password: 'hunter2' },
      'signed in',
    );
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
      expect(line).toContain('"route":"/ping"');
      expect(line).not.toContain('secret-token-value');
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});
