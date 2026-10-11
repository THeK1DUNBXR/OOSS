/**
 * Account recovery through the founder or the IT admin, never SMS (ORDERED-PLAN
 * Wave 6; DECISIONS round 22 item e, owner: SIM-swap risk on a finance system).
 *
 * Driven over HTTP against createApp() and the real database. Each test builds
 * its own accounts so that one refusal's state is never another test's setup.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { hashPassword } from '../lib/auth.js';
import jwt from 'jsonwebtoken';
import { generateTotpSecret, totp } from '../domains/compliance/corporate/totp.js';
import { config } from '../platform/config.js';
import { addMissingGrants } from '../platform/grantSync.js';
import authRoutes from '../routes/auth.routes.js';
import { tenantId, unscopedPrisma } from './helpers.js';

const PASSWORD = 'Recovery-Test-7q!pass';
/** Twenty-odd non-whitespace characters: over the 20-character floor. */
const GOOD_REASON = 'Locked out after a forgotten password; identity confirmed at the front desk.';
/** Five non-whitespace characters, padded with spaces so the raw length looks long enough. */
const SHORT_REASON = '     short     ';
const SECRET_PATTERN = /\$2[aby]\$/;

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let server: Server;
let base: string;
let tid: string;
let founder: Account;
let itAdmin: Account;
let employeeActor: Account;

type Res = Awaited<ReturnType<typeof fetch>>;
const COOKIE = 'kz_refresh';
const setCookieOf = (res: Res): string | undefined =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));
const cookieValueOf = (setCookie: string): string => setCookie.split(';')[0]!.slice(COOKIE.length + 1);

interface Account {
  email: string;
  userId: string;
  personId: string;
  principalId: string;
  tenantId: string;
  password: string;
  token?: string;
}

async function makeAccount(
  label: string,
  roleSlug: string,
  opts: { tenantId?: string; userStatus?: string; affiliationStatus?: string; password?: string } = {},
): Promise<Account> {
  const inTenant = opts.tenantId ?? tid;
  const email = `${label}-${stamp}-${Math.floor(Math.random() * 1e6)}@recovery.test`;
  const password = opts.password ?? PASSWORD;
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: inTenant,
      recordCode: `PER-REC-${label.toUpperCase()}-${stamp}-${Math.floor(Math.random() * 1e6)}`,
      fullName: `Recovery ${label}`,
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  await unscopedPrisma.affiliation.create({
    data: {
      tenantId: inTenant,
      partyId: person.id,
      affiliationType: 'employee',
      counterpartyName: 'Recovery fixture',
      roleSlug,
      primaryFlag: true,
      status: opts.affiliationStatus ?? 'active',
      branch: 'Chennai',
    },
  });
  const principal = await unscopedPrisma.principal.create({
    data: { email, passwordHash: await hashPassword(password) },
  });
  const user = await unscopedPrisma.user.create({
    data: {
      tenantId: inTenant,
      personId: person.id,
      email,
      principalId: principal.id,
      status: opts.userStatus ?? 'active',
      branch: 'Chennai',
    },
  });
  return { email, userId: user.id, personId: person.id, principalId: principal.id, tenantId: inTenant, password };
}

/** A second entity's user row that shares an existing principal: one email, one password, two entities. */
async function addEntityUser(of: Account, inTenant: string): Promise<string> {
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: inTenant,
      recordCode: `PER-REC-OTHER-${stamp}-${Math.floor(Math.random() * 1e6)}`,
      fullName: 'Recovery other entity',
      primaryEmail: of.email,
      primaryEmailNormalised: of.email,
      source: 'test',
    },
  });
  await unscopedPrisma.affiliation.create({
    data: {
      tenantId: inTenant,
      partyId: person.id,
      affiliationType: 'employee',
      counterpartyName: 'Other entity',
      roleSlug: 'employee',
      primaryFlag: true,
      status: 'active',
      branch: 'Chennai',
    },
  });
  const user = await unscopedPrisma.user.create({
    data: { tenantId: inTenant, personId: person.id, email: of.email, principalId: of.principalId, branch: 'Chennai' },
  });
  return user.id;
}

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const recover = (token: string | undefined, body: unknown) => post('/auth/account-recovery', body, token);

const me = (token: string) => fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });

const refreshWithCookie = (cookieValue: string) =>
  fetch(`${base}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${COOKIE}=${cookieValue}` },
    body: '{}',
  });

async function login(
  email: string,
  password: string,
): Promise<{ status: number; body: Record<string, unknown>; cookie?: string }> {
  const res = await post('/auth/login', { email, password });
  const set = setCookieOf(res);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    cookie: set ? cookieValueOf(set) : undefined,
  };
}

async function signedInToken(account: Account): Promise<string> {
  const res = await login(account.email, account.password);
  expect(res.status).toBe(200);
  return res.body.token as string;
}

/** A database row as text, for scanning it for secrets. BigInt columns (the event `seq`) need a string form. */
const rowText = (row: unknown): string =>
  JSON.stringify(row, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));

/** The row a refusal must leave exactly as it was. */
async function credentialOf(principalId: string): Promise<string> {
  return (await unscopedPrisma.principal.findUniqueOrThrow({ where: { id: principalId } })).passwordHash;
}

beforeAll(async () => {
  const app = createApp({ webDistDir: '', corsOrigins: [] });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  tid = await tenantId();
  // A database seeded before this release has no row for the new resource. The
  // boot-time grantSync supplies it; the test asks for the same thing explicitly
  // so it does not depend on which release seeded the database.
  await addMissingGrants(tid);

  founder = await makeAccount('founder', 'chairman');
  itAdmin = await makeAccount('itadmin', 'hr_ops_manager');
  employeeActor = await makeAccount('actor', 'employee');
  founder.token = await signedInToken(founder);
  itAdmin.token = await signedInToken(itAdmin);
  employeeActor.token = await signedInToken(employeeActor);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Every login and every recovery shares its address bucket across the suite.
beforeEach(async () => {
  await unscopedPrisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE key LIKE 'login:%' OR key LIKE 'recovery:%'`;
});

describe('account recovery: the founder recovers an employee', () => {
  it('rotates the password, kills the old password, every session and refresh token, and audits without the secret', async () => {
    const target = await makeAccount('lockedout', 'employee');
    const first = await login(target.email, target.password);
    const second = await login(target.email, target.password);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const oldToken = first.body.token as string;

    const res = await recover(founder.token, { userId: target.userId, reason: GOOD_REASON });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userId: string;
      email: string;
      password: string;
      mfaReset: boolean;
      sessionsRevoked: number;
    };
    expect(body.userId).toBe(target.userId);
    expect(body.email).toBe(target.email);
    expect(body.mfaReset).toBe(false);
    expect(body.sessionsRevoked).toBe(2);
    expect(body.password.length).toBeGreaterThanOrEqual(12);
    expect(body.password).not.toBe(target.password);

    // The old password is dead and the new one signs in.
    expect((await login(target.email, target.password)).status).toBe(401);
    expect((await login(target.email, body.password)).status).toBe(200);

    // Every session and refresh token the account held before is dead.
    expect((await me(oldToken)).status).toBe(401);
    expect((await refreshWithCookie(first.cookie!)).status).toBe(401);
    expect((await refreshWithCookie(second.cookie!)).status).toBe(401);

    // The audit row names actor, target, reason and MFA, and carries no secret.
    const rows = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'user', subjectId: target.userId, action: 'update' },
    });
    const recovery = rows.filter((r) => (r.meta as { kind?: string } | null)?.kind === 'account_recovery');
    expect(recovery).toHaveLength(1);
    expect(recovery[0]!.actorId).toBe(founder.personId);
    expect(recovery[0]!.meta).toMatchObject({ reason: GOOD_REASON, resetMfa: false, sessionsRevoked: 2 });
    const auditText = rowText(recovery[0]);
    expect(auditText).not.toContain(body.password);
    expect(auditText).not.toContain(target.password);
    expect(auditText).not.toMatch(SECRET_PATTERN);

    // The event is past tense, on the idn domain, and carries the same facts.
    const events = await unscopedPrisma.eventRecord.findMany({
      where: { tenantId: tid, eventName: 'kz.idn.account.recovered', subjectEntityId: target.userId },
    });
    expect(events).toHaveLength(1);
    expect(rowText(events[0])).not.toContain(body.password);
    expect(rowText(events[0])).not.toMatch(SECRET_PATTERN);
  });
});

describe('account recovery: the IT admin recovers an employee', () => {
  it('works for an hr_ops_manager holding the grant, and the recovered password signs in', async () => {
    const target = await makeAccount('ticket', 'employee');
    const res = await recover(itAdmin.token, { userId: target.userId, reason: GOOD_REASON });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { password: string };
    expect((await login(target.email, body.password)).status).toBe(200);
    expect((await login(target.email, target.password)).status).toBe(401);
  });
});

describe('account recovery: resetMfa', () => {
  it('without resetMfa the second factor stays; with it, the TOTP enrolment is cleared', async () => {
    const target = await makeAccount('mfauser', 'employee');
    const secret = generateTotpSecret();
    await unscopedPrisma.user.update({
      where: { id: target.userId },
      data: { mfaSecret: secret, mfaEnabledAt: new Date() },
    });

    const kept = await recover(founder.token, { userId: target.userId, reason: GOOD_REASON, resetMfa: false });
    expect(kept.status).toBe(200);
    const keptBody = (await kept.json()) as { password: string; mfaReset: boolean };
    expect(keptBody.mfaReset).toBe(false);
    const stillEnrolled = await unscopedPrisma.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(stillEnrolled.mfaSecret).toBe(secret);
    expect(stillEnrolled.mfaEnabledAt).not.toBeNull();
    // The password is recovered, but the second factor still stops a session.
    const challenged = await login(target.email, keptBody.password);
    expect(challenged.body.mfaRequired).toBe(true);

    const cleared = await recover(founder.token, { userId: target.userId, reason: GOOD_REASON, resetMfa: true });
    expect(cleared.status).toBe(200);
    const body = (await cleared.json()) as { password: string; mfaReset: boolean };
    expect(body.mfaReset).toBe(true);
    const enrolment = await unscopedPrisma.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(enrolment.mfaSecret).toBeNull();
    expect(enrolment.mfaEnabledAt).toBeNull();
    // With the enrolment cleared the password alone opens a session.
    const after = await login(target.email, body.password);
    expect(after.status).toBe(200);
    expect(after.body.mfaRequired).toBeUndefined();
    expect(after.body.token).toBeTruthy();
  });
});

describe('account recovery: refusals', () => {
  it('a recoverer cannot recover their own account: 403, nothing changes', async () => {
    const before = await credentialOf(itAdmin.principalId);
    const res = await recover(itAdmin.token, { userId: itAdmin.userId, reason: GOOD_REASON });
    expect(res.status).toBe(403);
    expect(await credentialOf(itAdmin.principalId)).toBe(before);
    expect((await login(itAdmin.email, PASSWORD)).status).toBe(200);
  });

  it('recovering a founder-role account is 403 and points to the operator procedure', async () => {
    const otherFounder = await makeAccount('founderb', 'chairman');
    const before = await credentialOf(otherFounder.principalId);
    const res = await recover(itAdmin.token, { userId: otherFounder.userId, reason: GOOD_REASON });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/operator procedure/i);
    expect(await credentialOf(otherFounder.principalId)).toBe(before);
  });

  it('a reason under twenty non-whitespace characters is 422, nothing changes', async () => {
    const target = await makeAccount('shortreason', 'employee');
    const before = await credentialOf(target.principalId);
    const res = await recover(founder.token, { userId: target.userId, reason: SHORT_REASON });
    expect(res.status).toBe(422);
    expect(await credentialOf(target.principalId)).toBe(before);
  });

  it('a target in another tenant is 404, indistinguishable from a missing user', async () => {
    const otherTenant = await unscopedPrisma.tenant.create({
      data: {
        name: `Recovery other ${stamp}`,
        slug: `rec-other-${stamp}-${Math.floor(Math.random() * 1e6)}`,
        status: 'active',
      },
    });
    const foreign = await makeAccount('foreign', 'employee', { tenantId: otherTenant.id });
    const before = await credentialOf(foreign.principalId);

    const crossTenant = await recover(founder.token, { userId: foreign.userId, reason: GOOD_REASON });
    const missing = await recover(founder.token, { userId: 'does-not-exist-' + stamp, reason: GOOD_REASON });
    expect(crossTenant.status).toBe(404);
    expect(missing.status).toBe(404);
    // The message must come from the recovery refusal itself, not from a missing route.
    const crossBody = (await crossTenant.json()) as { error: { code: string; message: string } };
    const missingBody = (await missing.json()) as { error: { code: string; message: string } };
    expect(crossBody.error).toMatchObject({ code: 'NOT_FOUND', message: 'User not found' });
    expect({ code: crossBody.error.code, message: crossBody.error.message }).toEqual({
      code: missingBody.error.code,
      message: missingBody.error.message,
    });
    expect(await credentialOf(foreign.principalId)).toBe(before);
  });

  it('an inactive or exited target is 409, nothing changes', async () => {
    const suspended = await makeAccount('suspended', 'employee', { userStatus: 'suspended' });
    const exited = await makeAccount('exited', 'employee', { affiliationStatus: 'ended' });
    for (const target of [suspended, exited]) {
      const before = await credentialOf(target.principalId);
      const res = await recover(founder.token, { userId: target.userId, reason: GOOD_REASON });
      expect(res.status).toBe(409);
      expect(await credentialOf(target.principalId)).toBe(before);
    }
  });

  it('an ordinary employee without the grant is 403, and the target is untouched', async () => {
    const target = await makeAccount('untouched', 'employee');
    const before = await credentialOf(target.principalId);
    const res = await recover(employeeActor.token, { userId: target.userId, reason: GOOD_REASON });
    expect(res.status).toBe(403);
    expect(await credentialOf(target.principalId)).toBe(before);
  });

  it('a principal that also holds a user in another entity is 409, because one password would cross the tenant line', async () => {
    const shared = await makeAccount('shared', 'employee');
    const otherTenant = await unscopedPrisma.tenant.create({
      data: {
        name: `Recovery shared ${stamp}`,
        slug: `rec-shared-${stamp}-${Math.floor(Math.random() * 1e6)}`,
        status: 'active',
      },
    });
    await addEntityUser(shared, otherTenant.id);
    const before = await credentialOf(shared.principalId);
    const res = await recover(founder.token, { userId: shared.userId, reason: GOOD_REASON });
    expect(res.status).toBe(409);
    expect(await credentialOf(shared.principalId)).toBe(before);
  });

  it('is rate limited per address: the eleventh request in a minute is 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await recover(founder.token, { userId: 'x', reason: SHORT_REASON })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('account recovery: tokens minted before the recovery', () => {
  const challengeFor = async (userId: string, personId: string, tenant: string, issuedAt: number) => {
    const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
      where: { partyId: personId, tenantId: tenant },
    });
    return jwt.sign(
      { userId, tenantId: tenant, affiliationId: affiliation.id, mfaChallenge: true, iat: issuedAt },
      config.JWT_SECRET,
      { expiresIn: '5m' },
    );
  };
  const verify = (challengeToken: string, code: string) => post('/auth/mfa/verify', { challengeToken, code });

  it('an MFA challenge minted before the recovery is refused, even with a current TOTP code', async () => {
    const target = await makeAccount('challenged', 'employee');
    const secret = generateTotpSecret();
    await unscopedPrisma.user.update({
      where: { id: target.userId },
      data: { mfaSecret: secret, mfaEnabledAt: new Date() },
    });
    // Minted five seconds back, so whole-second `iat` cannot blur the order against the recovery.
    const before = Math.floor(Date.now() / 1000) - 5;
    const control = await challengeFor(target.userId, target.personId, tid, before);
    expect((await verify(control, totp(secret))).status).toBe(200);

    const stale = await challengeFor(target.userId, target.personId, tid, before);
    const res = await recover(founder.token, { userId: target.userId, reason: GOOD_REASON });
    expect(res.status).toBe(200);
    // resetMfa was not asked for, so the TOTP secret is still good: only the credential changed.
    expect((await verify(stale, totp(secret))).status).toBe(401);
  });

  it('a selection token minted before the recovery is refused at switch-entity', async () => {
    const target = await makeAccount('selector', 'employee');
    const before = Math.floor(Date.now() / 1000) - 5;
    const minted = jwt.sign(
      { principalId: target.principalId, purpose: 'select-entity', iat: before },
      config.JWT_SECRET,
      {
        expiresIn: '5m',
      },
    );
    const control = await post('/auth/switch-entity', { tenantId: tid }, minted);
    expect(control.status).not.toBe(401);

    const res = await recover(founder.token, { userId: target.userId, reason: GOOD_REASON });
    expect(res.status).toBe(200);
    const after = await post('/auth/switch-entity', { tenantId: tid }, minted);
    expect(after.status).toBe(401);
  });

  it('a challenge minted after the recovery still completes', async () => {
    const target = await makeAccount('reenrolled', 'employee');
    const secret = generateTotpSecret();
    await unscopedPrisma.user.update({
      where: { id: target.userId },
      data: { mfaSecret: secret, mfaEnabledAt: new Date() },
    });
    const res = await recover(founder.token, { userId: target.userId, reason: GOOD_REASON });
    expect(res.status).toBe(200);
    const { password } = (await res.json()) as { password: string };
    // The check is whole-second, so a challenge issued in the same second as the
    // recovery is refused on purpose; wait for the boundary before the employee signs in.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const challenged = await login(target.email, password);
    expect(challenged.body.mfaRequired).toBe(true);
    const done = await verify(challenged.body.challengeToken as string, totp(secret));
    expect(done.status).toBe(200);
  });
});

describe('account recovery: no SMS or phone-based recovery', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('the recovery module and the auth routes name no SMS, phone or messaging provider', () => {
    for (const file of ['../domains/accountRecovery.ts', '../routes/auth.routes.ts']) {
      const src = stripComments(readFileSync(join(here, file), 'utf8'));
      expect(src, file).not.toMatch(/\b(sms|phone|mobile|msg91|twilio|text message|whatsapp)\b/i);
    }
  });

  it('no route matching recover, reset or forgot accepts a phone number as its only input', async () => {
    const stack = (authRoutes as unknown as { stack: Array<{ route?: { path: string } }> }).stack;
    const matching = stack
      .flatMap((layer) => (layer.route ? [layer.route.path] : []))
      .filter((p) => /recover|reset|forgot/i.test(p));
    expect(matching.length).toBeGreaterThan(0);
    for (const path of matching) {
      const res = await post(
        `/auth${path}`,
        { phone: '+919876543210', mobile: '9876543210', otp: '123456' },
        itAdmin.token,
      );
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(res.status, path).not.toBe(202);
    }
  });
});
