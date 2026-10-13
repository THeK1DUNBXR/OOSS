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
import type { DutyAssignment } from '@prisma/client';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { hashPassword } from '../lib/auth.js';
import jwt from 'jsonwebtoken';
import { generateTotpSecret, totp } from '../domains/compliance/corporate/totp.js';
import { IT_ADMIN_DUTY } from '../domains/accountRecovery.js';
import { FOUNDER_DUTY, assignDuty } from '../domains/statutory.js';
import { config } from '../platform/config.js';
import { addMissingGrants } from '../platform/grantSync.js';
import authRoutes from '../routes/auth.routes.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';

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

/** The kaizen tenant's duty rows as they were before this file ran, put back after it. */
let dutiesBefore: DutyAssignment[] = [];

beforeAll(async () => {
  const app = createApp({ webDistDir: '', corsOrigins: [] });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  tid = await tenantId();
  dutiesBefore = await unscopedPrisma.dutyAssignment.findMany({
    where: { tenantId: tid, dutyKey: { in: [FOUNDER_DUTY, IT_ADMIN_DUTY] } },
  });
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
  // The founder duty is the seeded owner's in the kaizen tenant. Put the rows back as they were.
  await unscopedPrisma.dutyAssignment.deleteMany({
    where: { tenantId: tid, dutyKey: { in: [FOUNDER_DUTY, IT_ADMIN_DUTY] } },
  });
  if (dutiesBefore.length > 0) await unscopedPrisma.dutyAssignment.createMany({ data: dutiesBefore });
});

// Every login and every recovery shares its address bucket across the suite.
beforeEach(async () => {
  await unscopedPrisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE key LIKE 'login:%' OR key LIKE 'recovery:%'`;
  // The recovery holder is the IT admin once one is named, otherwise the founder. Each test
  // starts with this file's founder as the holder and no IT admin, so a test that names one
  // cannot change the answer for the tests after it.
  await unscopedPrisma.dutyAssignment.deleteMany({
    where: { tenantId: tid, dutyKey: { in: [FOUNDER_DUTY, IT_ADMIN_DUTY] } },
  });
  await unscopedPrisma.dutyAssignment.create({
    data: {
      tenantId: tid,
      dutyKey: FOUNDER_DUTY,
      partyId: founder.personId,
      effectiveFrom: new Date(Date.now() - 60_000),
      assignedBy: founder.personId,
    },
  });
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
  it('works for the IT admin once onboarding names them, and the recovered password signs in', async () => {
    await asUser(founder.email, () => assignDuty({ dutyKey: IT_ADMIN_DUTY, partyId: itAdmin.personId }));
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
    const before = await credentialOf(founder.principalId);
    const res = await recover(founder.token, { userId: founder.userId, reason: GOOD_REASON });
    expect(res.status).toBe(403);
    expect(await credentialOf(founder.principalId)).toBe(before);
    expect((await login(founder.email, PASSWORD)).status).toBe(200);
  });

  it('recovering a founder-role account is 403 and points to the operator procedure', async () => {
    const otherFounder = await makeAccount('founderb', 'chairman');
    const before = await credentialOf(otherFounder.principalId);
    const res = await recover(founder.token, { userId: otherFounder.userId, reason: GOOD_REASON });
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

describe('account recovery: a recoverer assumes no role they do not hold', () => {
  it('hr_ops_manager cannot recover a finance_head: 403, nothing changes', async () => {
    const target = await makeAccount('finhead', 'finance_head');
    const before = await credentialOf(target.principalId);
    const res = await recover(itAdmin.token, { userId: target.userId, reason: GOOD_REASON });
    expect(res.status).toBe(403);
    expect(await credentialOf(target.principalId)).toBe(before);
    expect((await login(target.email, target.password)).status).toBe(200);
  });

  it('chairman can recover a finance_head, because the chairman holds every grant that role confers', async () => {
    const target = await makeAccount('finheadok', 'finance_head');
    const res = await recover(founder.token, { userId: target.userId, reason: GOOD_REASON });
    expect(res.status).toBe(200);
  });
});

describe('account recovery: a recovered sign-in must change its password first', () => {
  it('confines the recovered sign-in to change-password until the password is changed', async () => {
    const target = await makeAccount('confined', 'employee');
    const res = await recover(founder.token, { userId: target.userId, reason: GOOD_REASON });
    expect(res.status).toBe(200);
    const { password: oneTime } = (await res.json()) as { password: string };

    const signed = await login(target.email, oneTime);
    expect(signed.status).toBe(200);
    const token = signed.body.token as string;

    const blocked = await me(token);
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const navigation = await fetch(`${base}/api/auth/navigation`, { headers: { authorization: `Bearer ${token}` } });
    expect(navigation.status).toBe(403);

    const newPassword = 'Confined-Chosen-4w!pass';
    const changed = await post('/auth/change-password', { currentPassword: oneTime, newPassword }, token);
    expect(changed.status).toBe(200);
    expect((await me(token)).status).toBe(200);

    // The one-time password is spent: it no longer signs in.
    expect((await login(target.email, oneTime)).status).toBe(401);
    expect((await login(target.email, newPassword)).status).toBe(200);
  });

  it('keeps logout open to a confined sign-in, so the employee can always end the session', async () => {
    const target = await makeAccount('loggedout', 'employee');
    const res = await recover(founder.token, { userId: target.userId, reason: GOOD_REASON });
    const { password: oneTime } = (await res.json()) as { password: string };
    const signed = await login(target.email, oneTime);
    const token = signed.body.token as string;
    expect((await post('/auth/logout', {}, token)).status).toBe(200);
    expect((await me(token)).status).toBe(401);
  });

  // The web cannot learn of the gate from /auth/me, which the gate itself refuses.
  // The sign-in response is the first place it can be told, so it carries the flag.
  it('the sign-in response says a change is owed, and says it is not once the password has changed', async () => {
    const target = await makeAccount('flagged', 'employee');
    const res = await recover(founder.token, { userId: target.userId, reason: GOOD_REASON });
    const { password: oneTime } = (await res.json()) as { password: string };

    const signed = await login(target.email, oneTime);
    expect(signed.status).toBe(200);
    expect((signed.body.user as { mustChangePassword: boolean }).mustChangePassword).toBe(true);

    const newPassword = 'Flagged-Chosen-9w!pass';
    const changed = await post(
      '/auth/change-password',
      { currentPassword: oneTime, newPassword },
      signed.body.token as string,
    );
    expect(changed.status).toBe(200);

    const after = await login(target.email, newPassword);
    expect((after.body.user as { mustChangePassword: boolean }).mustChangePassword).toBe(false);
  });
});

describe('account recovery: an MFA-enabled recoverer must confirm with a current code', () => {
  const signedInWithMfa = async (account: Account, secret: string): Promise<string> => {
    const first = await login(account.email, account.password);
    expect(first.body.mfaRequired).toBe(true);
    const res = await post('/auth/mfa/verify', { challengeToken: first.body.challengeToken, code: totp(secret) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  };

  it('without a current code the recovery is 401 and changes nothing', async () => {
    const chair = await makeAccount('mfachair', 'chairman');
    const secret = generateTotpSecret();
    await unscopedPrisma.user.update({
      where: { id: chair.userId },
      data: { mfaSecret: secret, mfaEnabledAt: new Date() },
    });
    const token = await signedInWithMfa(chair, secret);
    const target = await makeAccount('stepup', 'employee');
    const before = await credentialOf(target.principalId);

    const missing = await recover(token, { userId: target.userId, reason: GOOD_REASON });
    expect(missing.status).toBe(401);
    // A code ten minutes away is outside the one-step drift window, so it is simply wrong.
    const stale = totp(secret, new Date(Date.now() + 10 * 60_000));
    const wrong = await recover(token, { userId: target.userId, reason: GOOD_REASON, totpCode: stale });
    expect(wrong.status).toBe(401);
    expect(await credentialOf(target.principalId)).toBe(before);
  });

  it('with a current code the MFA-enabled chairman recovers the account', async () => {
    const chair = await makeAccount('mfachair2', 'chairman');
    const secret = generateTotpSecret();
    await unscopedPrisma.user.update({
      where: { id: chair.userId },
      data: { mfaSecret: secret, mfaEnabledAt: new Date() },
    });
    const token = await signedInWithMfa(chair, secret);
    const target = await makeAccount('stepupok', 'employee');
    const res = await recover(token, { userId: target.userId, reason: GOOD_REASON, totpCode: totp(secret) });
    expect(res.status).toBe(200);
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
