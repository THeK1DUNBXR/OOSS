/**
 * Phase 0.2 sessions: a revocable session behind every access token.
 *
 * Driven over HTTP against createApp() and the real database. Before this,
 * a stolen token was good for twelve hours and "log out" only forgot it
 * client-side, so a leaked laptop could not be locked out. Each test names
 * what the old behaviour cost.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import { createApp } from '../server.js';
import { hashPassword } from '../lib/auth.js';
import { isGoverned } from '../platform/audit.js';
import { tenantId, unscopedPrisma } from './helpers.js';

const PASSWORD = 'Sessions-Test-9x!pass';
let server: Server;
let base: string;
let email: string;
let userId: string;
let tid: string;

type Issued = { token: string; refreshToken: string; user: unknown };

beforeAll(async () => {
  const app = createApp({ webDistDir: '', corsOrigins: [] });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  tid = await tenantId();
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  email = `sess-${stamp}@fixture.test`;
  const person = await unscopedPrisma.person.create({
    data: { tenantId: tid, recordCode: `PER-SESS-${stamp}`, fullName: 'Session Fixture', primaryEmail: email, primaryEmailNormalised: email, source: 'test' },
  });
  await unscopedPrisma.affiliation.create({
    data: { tenantId: tid, partyId: person.id, affiliationType: 'employee', counterpartyName: 'Fixture', roleSlug: 'sales', primaryFlag: true, status: 'active', branch: 'Chennai' },
  });
  const principal = await unscopedPrisma.principal.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } });
  const user = await unscopedPrisma.user.create({
    data: { tenantId: tid, personId: person.id, email, principalId: principal.id, branch: 'Chennai' },
  });
  userId = user.id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// The address bucket is 5/minute and shared by every test here.
beforeEach(async () => {
  await unscopedPrisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE key LIKE 'login:%'`;
});

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const me = (token: string) => fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });

async function signIn(): Promise<Issued> {
  const res = await post('/auth/login', { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (await res.json()) as Issued;
}

describe('0.2 sessions', () => {
  it('issues a 15-minute access token carrying a jti, and stores only a hash of the refresh token', async () => {
    const issued = await signIn();
    const claims = jwt.decode(issued.token) as { jti?: string; iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(15 * 60);
    expect(claims.jti).toBeTruthy();

    const session = await unscopedPrisma.session.findFirstOrThrow({ where: { jti: claims.jti! } });
    expect(session.tenantId).toBe(tid);
    expect(session.userId).toBe(userId);
    expect(session.revokedAt).toBeNull();
    expect(issued.refreshToken).toBeTruthy();
    // A database read must not be enough to replay the credential.
    expect(session.refreshTokenHash).not.toContain(issued.refreshToken);
    expect(issued.refreshToken).not.toContain(session.refreshTokenHash);
  });

  it('logout revokes the session, so the still-unexpired access token stops working at once', async () => {
    const issued = await signIn();
    expect((await me(issued.token)).status).toBe(200);

    expect((await post('/auth/logout', {}, issued.token)).status).toBe(200);

    expect((await me(issued.token)).status).toBe(401);
    const refreshed = await post('/auth/refresh', { refreshToken: issued.refreshToken });
    expect(refreshed.status).toBe(401);
  });

  it('rotates the refresh token, and replaying the old one revokes the whole session', async () => {
    const first = await signIn();
    const res = await post('/auth/refresh', { refreshToken: first.refreshToken });
    expect(res.status).toBe(200);
    const second = (await res.json()) as Issued;
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.token).not.toBe(first.token);
    expect((await me(second.token)).status).toBe(200);

    // Whoever replays a rotated token is either the thief or the victim with a
    // stale copy; both cases mean the family can no longer be trusted.
    const replay = await post('/auth/refresh', { refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
    expect((await me(second.token)).status).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: second.refreshToken })).status).toBe(401);
  });

  it('throttles login per email in Postgres as well as per address', async () => {
    const throttled = `throttle-${Date.now()}@fixture.test`;
    await post('/auth/login', { email: throttled, password: 'wrong-password-value' });
    const rows = await unscopedPrisma.$queryRaw<{ key: string }[]>`
      SELECT key FROM "RateLimitBucket" WHERE key LIKE 'login:email:%'`;
    expect(rows.some((r) => r.key.includes(throttled))).toBe(true);
  });

  it('audits login, logout and refresh reuse against a governed session subject', async () => {
    expect(isGoverned('session')).toBe(true);
    const issued = await signIn();
    const session = await unscopedPrisma.session.findFirstOrThrow({ where: { jti: (jwt.decode(issued.token) as { jti: string }).jti } });
    await post('/auth/refresh', { refreshToken: issued.refreshToken });
    await post('/auth/refresh', { refreshToken: issued.refreshToken }); // replay
    const actions = (
      await unscopedPrisma.auditRecord.findMany({ where: { tenantId: tid, subjectType: 'session', subjectId: session.id } })
    ).map((r) => r.action);
    expect(actions).toContain('login');
    expect(actions).toContain('refresh_reuse');

    const second = await signIn();
    await post('/auth/logout', {}, second.token);
    const row = await unscopedPrisma.session.findFirstOrThrow({ where: { jti: (jwt.decode(second.token) as { jti: string }).jti } });
    const logoutRows = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'session', subjectId: row.id, action: 'logout' },
    });
    expect(logoutRows).toHaveLength(1);
  });
});
