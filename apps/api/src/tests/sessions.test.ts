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
    data: {
      tenantId: tid,
      recordCode: `PER-SESS-${stamp}`,
      fullName: 'Session Fixture',
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  await unscopedPrisma.affiliation.create({
    data: {
      tenantId: tid,
      partyId: person.id,
      affiliationType: 'employee',
      counterpartyName: 'Fixture',
      roleSlug: 'sales',
      primaryFlag: true,
      status: 'active',
      branch: 'Chennai',
    },
  });
  const principal = await unscopedPrisma.principal.create({
    data: { email, passwordHash: await hashPassword(PASSWORD) },
  });
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

// The refresh secret arrives in the httpOnly cookie; it is surfaced here so the
// tests can present it the way the browser would.
async function signIn(): Promise<Issued> {
  const res = await post('/auth/login', { email, password: PASSWORD });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Omit<Issued, 'refreshToken'>;
  return { ...body, refreshToken: cookieValueOf(setCookieOf(res)!) };
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
    const refreshed = await refreshWithCookie(issued.refreshToken);
    expect(refreshed.status).toBe(401);
  });

  it('rotates the refresh token, and replaying the old one revokes the whole session', async () => {
    const first = await signIn();
    const res = await refreshWithCookie(first.refreshToken);
    expect(res.status).toBe(200);
    const second = (await res.json()) as Issued;
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.token).not.toBe(first.token);
    expect((await me(second.token)).status).toBe(200);

    // Whoever replays a rotated token is either the thief or the victim with a
    // stale copy; both cases mean the family can no longer be trusted.
    // Past the ten-second grace: this replay is reuse, not a second tab.
    await unscopedPrisma.$executeRawUnsafe(
      `UPDATE sessions SET "rotatedAt" = now() - interval '11 seconds' WHERE id = $1`,
      sessionIdOf(first.refreshToken),
    );
    const replay = await refreshWithCookie(first.refreshToken);
    expect(replay.status).toBe(401);
    expect((await me(second.token)).status).toBe(401);
    expect((await refreshWithCookie(second.refreshToken)).status).toBe(401);
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
    const session = await unscopedPrisma.session.findFirstOrThrow({
      where: { jti: (jwt.decode(issued.token) as { jti: string }).jti },
    });
    await refreshWithCookie(issued.refreshToken);
    // Past the ten-second grace: this replay is reuse, not a second tab.
    await unscopedPrisma.$executeRawUnsafe(
      `UPDATE sessions SET "rotatedAt" = now() - interval '11 seconds' WHERE id = $1`,
      sessionIdOf(issued.refreshToken),
    );
    await refreshWithCookie(issued.refreshToken); // replay
    const actions = (
      await unscopedPrisma.auditRecord.findMany({
        where: { tenantId: tid, subjectType: 'session', subjectId: session.id },
      })
    ).map((r) => r.action);
    expect(actions).toContain('login');
    expect(actions).toContain('refresh_reuse');

    const second = await signIn();
    await post('/auth/logout', {}, second.token);
    const row = await unscopedPrisma.session.findFirstOrThrow({
      where: { jti: (jwt.decode(second.token) as { jti: string }).jti },
    });
    const logoutRows = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'session', subjectId: row.id, action: 'logout' },
    });
    expect(logoutRows).toHaveLength(1);
  });
});

/**
 * Fix round 1: the refresh secret moves out of the body into an httpOnly
 * cookie, a rotation has a ten-second grace for the second tab, and step-up
 * survives a refresh for its own window. Session timestamps are set directly
 * in the test database because the clock is real and these windows are short.
 */
type Res = Awaited<ReturnType<typeof fetch>>;
const COOKIE = 'kz_refresh';
const setCookieOf = (res: Res): string | undefined =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));
const cookieValueOf = (setCookie: string): string => setCookie.split(';')[0]!.slice(COOKIE.length + 1);
const sessionIdOf = (cookieValue: string): string => cookieValue.slice(0, cookieValue.indexOf('.'));
const refreshWithCookie = (cookieValue: string) =>
  fetch(`${base}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${COOKIE}=${cookieValue}` },
    body: '{}',
  });
async function signInCookie(): Promise<string> {
  const res = await post('/auth/login', { email, password: PASSWORD });
  expect(res.status).toBe(200);
  const set = setCookieOf(res);
  expect(set).toBeTruthy();
  return cookieValueOf(set!);
}

describe('0.2 fix round 1: cookie, grace and step-up', () => {
  it('login sets the refresh secret as an httpOnly, strict, /api/auth cookie of session length, and keeps it out of the body', async () => {
    const res = await post('/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(200);
    const set = setCookieOf(res);
    expect(set).toBeTruthy();
    expect(set).toMatch(/;\s*HttpOnly/i);
    expect(set).toMatch(/;\s*SameSite=Strict/i);
    expect(set).toMatch(/;\s*Path=\/api\/auth/);
    const maxAge = Number(/;\s*Max-Age=(\d+)/i.exec(set!)?.[1]);
    expect(maxAge).toBeGreaterThan(30 * 24 * 60 * 60 - 60);
    expect(maxAge).toBeLessThanOrEqual(30 * 24 * 60 * 60);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('refreshToken');
  });

  it('refresh runs on the cookie alone and rotates it', async () => {
    const cookie = await signInCookie();
    const res = await refreshWithCookie(cookie);
    expect(res.status).toBe(200);
    const next = setCookieOf(res);
    expect(next).toBeTruthy();
    expect(cookieValueOf(next!)).not.toBe(cookie);
  });

  it('a refresh secret sent in the body is ignored', async () => {
    const cookie = await signInCookie();
    const res = await fetch(`${base}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: cookie }),
    });
    expect(res.status).toBe(401);
  });

  it('a replay inside the ten-second grace is answered without rotating or revoking', async () => {
    const first = await signInCookie();
    const rotated = await refreshWithCookie(first);
    expect(rotated.status).toBe(200);
    const second = cookieValueOf(setCookieOf(rotated)!);

    const replay = await refreshWithCookie(first);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { token: string }).token).toBeTruthy();
    expect(setCookieOf(replay)).toBeUndefined();

    // The winner's secret is still the current one: the session was not revoked or rotated again.
    expect((await refreshWithCookie(second)).status).toBe(200);
  });

  it('the same replay after the grace window is reuse, and revokes the session', async () => {
    const first = await signInCookie();
    const rotated = await refreshWithCookie(first);
    const second = cookieValueOf(setCookieOf(rotated)!);
    await unscopedPrisma.$executeRawUnsafe(
      `UPDATE sessions SET "rotatedAt" = now() - interval '11 seconds' WHERE id = $1`,
      sessionIdOf(first),
    );

    expect((await refreshWithCookie(first)).status).toBe(401);
    expect((await refreshWithCookie(second)).status).toBe(401);
  });

  it('step-up survives a refresh while its window is open', async () => {
    const cookie = await signInCookie();
    await unscopedPrisma.$executeRawUnsafe(
      `UPDATE sessions SET "stepUpAt" = now() - interval '1 minute' WHERE id = $1`,
      sessionIdOf(cookie),
    );
    const res = await refreshWithCookie(cookie);
    expect(res.status).toBe(200);
    const claims = jwt.decode(((await res.json()) as { token: string }).token) as { stepUp: boolean };
    expect(claims.stepUp).toBe(true);
  });

  it('step-up lapses on refresh once its window has passed', async () => {
    const cookie = await signInCookie();
    await unscopedPrisma.$executeRawUnsafe(
      `UPDATE sessions SET "stepUpAt" = now() - interval '2 hours' WHERE id = $1`,
      sessionIdOf(cookie),
    );
    const res = await refreshWithCookie(cookie);
    expect(res.status).toBe(200);
    const claims = jwt.decode(((await res.json()) as { token: string }).token) as { stepUp: boolean };
    expect(claims.stepUp).toBe(false);
  });

  it('logout with only the cookie revokes the session and clears the cookie', async () => {
    const cookie = await signInCookie();
    const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: `${COOKIE}=${cookie}` } });
    expect(res.status).toBe(200);
    expect(setCookieOf(res)).toMatch(/Max-Age=0/i);
    expect((await refreshWithCookie(cookie)).status).toBe(401);
  });
});

/**
 * Fix round 2: a page load abandoned mid-refresh never stores the rotated
 * cookie, so the browser presents the secret it replaced, long after the grace.
 * That is a lost response, not theft, and must not end the session. Theft shows
 * up as an older secret, presented after the secret that replaced it was used.
 */
describe('0.2 fix round 2: lost response and older secrets', () => {
  const ageRotation = (cookieValue: string) =>
    unscopedPrisma.$executeRawUnsafe(
      `UPDATE sessions SET "rotatedAt" = now() - interval '11 seconds' WHERE id = $1`,
      sessionIdOf(cookieValue),
    );

  it('a lost response: the replaced secret after the grace recovers the session when the rotated secret was never used', async () => {
    const first = await signInCookie();
    const rotated = await refreshWithCookie(first);
    expect(rotated.status).toBe(200); // the response carrying it is lost: never stored
    await ageRotation(first);

    const recovered = await refreshWithCookie(first);
    expect(recovered.status).toBe(200);
    const next = setCookieOf(recovered);
    expect(next).toBeTruthy();
    expect((await refreshWithCookie(cookieValueOf(next!))).status).toBe(200);
  });

  it('a recovered refresh is audited against the session', async () => {
    const first = await signInCookie();
    await refreshWithCookie(first);
    await ageRotation(first);
    expect((await refreshWithCookie(first)).status).toBe(200);

    const rows = await unscopedPrisma.auditRecord.findMany({
      where: { subjectType: 'session', subjectId: sessionIdOf(first), action: 'refresh_recovered' },
    });
    expect(rows).toHaveLength(1);
  });

  it('an older secret presented after the newer one was used revokes the session', async () => {
    const s1 = await signInCookie();
    const s2 = cookieValueOf(setCookieOf((await refreshWithCookie(s1)))!);
    const s3 = cookieValueOf(setCookieOf((await refreshWithCookie(s2)))!);

    expect((await refreshWithCookie(s1)).status).toBe(401);
    expect((await refreshWithCookie(s3)).status).toBe(401);
  });
});
