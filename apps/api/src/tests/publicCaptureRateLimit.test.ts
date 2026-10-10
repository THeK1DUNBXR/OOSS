/**
 * The public lead-capture endpoint's per-IP limit, as a caller on the internet
 * meets it: over HTTP, through createApp(), counted in Postgres.
 *
 * Caddy is the only peer that reaches the API, and it appends the real client
 * address to X-Forwarded-For. A caller can prepend anything it likes, so the
 * limit must key on the address Express derives from the trusted proxy chain
 * (req.ip), not on the first header value (which the caller wrote).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../server.js';
import { asUser, unscopedPrisma } from './helpers.js';
import { createForm, publishForm } from '../domains/marketing/capture.js';

const OPS = 'operations@kaizen.co.in'; // holds marketing_forms VCEDXF

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp({ webDistDir: '', corsOrigins: [] });
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await unscopedPrisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE key LIKE 'capture:%'`;
});

async function publishedToken(): Promise<string> {
  const form = await asUser(OPS, () =>
    createForm({
      name: `Public capture ${Date.now()}-${Math.random()}`,
      fields: [
        { key: 'fullName', label: 'Full name', type: 'text', required: true },
        { key: 'email', label: 'Email', type: 'email', required: true },
      ],
      vertical: 'education',
    } as never),
  );
  const published = await asUser(OPS, () => publishForm(form.id));
  return published.publicToken;
}

function submit(token: string, n: number, forwardedFor: string) {
  return fetch(`${base}/api/marketing/public/forms/${token}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Forwarded-For': forwardedFor },
    body: JSON.stringify({ fullName: `Caller ${n}`, email: `capture-${n}-${Date.now()}@example.com` }),
  });
}

describe('public lead capture rate limit (per IP, Postgres-backed)', () => {
  it('the 31st submission from one address in a minute is refused with 429', async () => {
    const token = await publishedToken();
    // Caddy's appended address is the rightmost entry. The leftmost entries
    // are whatever the caller claims, and change on every request.
    const statuses: number[] = [];
    let last: { error: { code: string } } | undefined;
    for (let i = 0; i < 31; i += 1) {
      const res = await submit(token, i, `198.18.${i}.1, 203.0.113.9`);
      statuses.push(res.status);
      if (res.status === 429) last = (await res.json()) as { error: { code: string } };
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(last?.error.code).toBe('RATE_LIMITED');
  });

  it('counts the address in Postgres, so every API instance sees the same count', async () => {
    const token = await publishedToken();
    for (let i = 0; i < 31; i += 1) {
      await submit(token, i, `198.18.${i}.1, 203.0.113.10`);
    }
    const rows = await unscopedPrisma.$queryRaw<{ key: string; hits: number }[]>`
      SELECT key, hits FROM "RateLimitBucket" WHERE key LIKE 'capture:%203.0.113.10%'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].hits).toBeGreaterThanOrEqual(31);
  });

  it('a different address is unaffected by another exhausting its limit', async () => {
    const token = await publishedToken();
    for (let i = 0; i < 30; i += 1) {
      await submit(token, i, '203.0.113.20');
    }
    const res = await submit(token, 99, '203.0.113.21');
    expect(res.status).toBe(200);
  });
});
