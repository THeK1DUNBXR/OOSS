/**
 * Who may recover a sign-in: the IT admin once onboarding names one, otherwise the
 * founder (DECISIONS round 23 c, C-015). A grant alone does not make someone the holder.
 *
 * Driven over HTTP against createApp() and the real database. The holder is a duty, so
 * these tests name holders through assignDuty, as a person would, and not by granting
 * a role. Each test resets the two duty keys at its start, so a test that names an IT
 * admin cannot change the answer for the tests after it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { DutyAssignment } from '@prisma/client';
import { createApp } from '../server.js';
import { hashPassword } from '../lib/auth.js';
import { IT_ADMIN_DUTY, recoveryHolder } from '../domains/accountRecovery.js';
import { FOUNDER_DUTY, assignDuty } from '../domains/statutory.js';
import { addMissingGrants } from '../platform/grantSync.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';

const PASSWORD = 'Holder-Test-4w!pass';
/** Twenty-odd non-whitespace characters: over the 20-character floor. */
const GOOD_REASON = 'Locked out after a forgotten password; identity confirmed at the front desk.';

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let server: Server;
let base: string;
let tid: string;
let dutiesBefore: DutyAssignment[] = [];
let founder: Account;
let itAdmin: Account;

interface Account {
  email: string;
  userId: string;
  personId: string;
  principalId: string;
  password: string;
  token?: string;
}

async function makeAccount(label: string, roleSlug: string): Promise<Account> {
  const email = `${label}-${stamp}-${Math.floor(Math.random() * 1e6)}@holder.test`;
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-HOLD-${label.toUpperCase()}-${stamp}-${Math.floor(Math.random() * 1e6)}`,
      fullName: `Holder ${label}`,
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
      counterpartyName: 'Holder fixture',
      roleSlug,
      primaryFlag: true,
      status: 'active',
      branch: 'Chennai',
    },
  });
  const principal = await unscopedPrisma.principal.create({
    data: { email, passwordHash: await hashPassword(PASSWORD) },
  });
  const user = await unscopedPrisma.user.create({
    data: {
      tenantId: tid,
      personId: person.id,
      email,
      principalId: principal.id,
      status: 'active',
      branch: 'Chennai',
    },
  });
  return { email, userId: user.id, personId: person.id, principalId: principal.id, password: PASSWORD };
}

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const recover = (token: string, body: unknown) => post('/auth/account-recovery', body, token);

async function signedInToken(account: Account): Promise<string> {
  const res = await post('/auth/login', { email: account.email, password: account.password });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function credentialOf(principalId: string): Promise<string> {
  return (await unscopedPrisma.principal.findUniqueOrThrow({ where: { id: principalId } })).passwordHash;
}

/** The governed recovery audit row for one target, as the holder's recovery wrote it. */
async function recoveryAudit(userId: string) {
  const rows = await unscopedPrisma.auditRecord.findMany({
    where: { tenantId: tid, subjectType: 'user', subjectId: userId, action: 'update' },
  });
  return rows.filter((r) => (r.meta as { kind?: string } | null)?.kind === 'account_recovery');
}

beforeAll(async () => {
  const app = createApp({ webDistDir: '', corsOrigins: [] });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  tid = await tenantId();
  dutiesBefore = await unscopedPrisma.dutyAssignment.findMany({
    where: { tenantId: tid, dutyKey: { in: [FOUNDER_DUTY, IT_ADMIN_DUTY] } },
  });
  await addMissingGrants(tid);

  // The founder account is chairman-role, which holds every grant. The IT admin account
  // holds account_recovery:approve through hr_ops_manager, which is what makes the
  // grant-only refusals below mean something.
  founder = await makeAccount('founder', 'chairman');
  itAdmin = await makeAccount('itadmin', 'hr_ops_manager');
  founder.token = await signedInToken(founder);
  itAdmin.token = await signedInToken(itAdmin);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // The founder duty is the seeded owner's in the kaizen tenant. Put the rows back as they were.
  await unscopedPrisma.dutyAssignment.deleteMany({
    where: { tenantId: tid, dutyKey: { in: [FOUNDER_DUTY, IT_ADMIN_DUTY] } },
  });
  if (dutiesBefore.length > 0) await unscopedPrisma.dutyAssignment.createMany({ data: dutiesBefore });
});

beforeEach(async () => {
  await unscopedPrisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE key LIKE 'login:%' OR key LIKE 'recovery:%'`;
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

describe('recovery holder: the founder holds it until onboarding names an IT admin', () => {
  it('the founder is the holder with no IT admin, recovers an employee, and the audit names the founder', async () => {
    expect(await asUser(founder.email, () => recoveryHolder())).toEqual({
      kind: 'founder',
      partyId: founder.personId,
    });

    const target = await makeAccount('founderholds', 'employee');
    const before = await credentialOf(target.principalId);
    const res = await recover(founder.token!, { userId: target.userId, reason: GOOD_REASON });
    expect(res.status).toBe(200);
    expect(await credentialOf(target.principalId)).not.toBe(before);

    const rows = await recoveryAudit(target.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ holder: 'founder' });
  });
});

describe('recovery holder: the named IT admin holds it, and the founder is refused', () => {
  it('once onboarding names an IT admin, the IT admin recovers and the founder is refused 403', async () => {
    await asUser(founder.email, () => assignDuty({ dutyKey: IT_ADMIN_DUTY, partyId: itAdmin.personId }));
    expect(await asUser(founder.email, () => recoveryHolder())).toEqual({
      kind: 'it_admin',
      partyId: itAdmin.personId,
    });

    const target = await makeAccount('namedadmin', 'employee');
    const before = await credentialOf(target.principalId);

    const refused = await recover(founder.token!, { userId: target.userId, reason: GOOD_REASON });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect(await credentialOf(target.principalId)).toBe(before);

    const allowed = await recover(itAdmin.token!, { userId: target.userId, reason: GOOD_REASON });
    expect(allowed.status).toBe(200);
    const rows = await recoveryAudit(target.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(itAdmin.personId);
    expect(rows[0]!.meta).toMatchObject({ holder: 'it_admin' });
  });
});

describe('recovery holder: a grant does not make someone the holder', () => {
  it('the IT admin is refused 403 before anyone names them, though their grant would allow it', async () => {
    const target = await makeAccount('grantonly', 'employee');
    const before = await credentialOf(target.principalId);

    const res = await recover(itAdmin.token!, { userId: target.userId, reason: GOOD_REASON });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect(await credentialOf(target.principalId)).toBe(before);
    expect(await recoveryAudit(target.userId)).toHaveLength(0);
  });

  it('with neither a founder nor an IT admin named, nobody recovers: 422, nothing changes', async () => {
    await unscopedPrisma.dutyAssignment.deleteMany({ where: { tenantId: tid, dutyKey: FOUNDER_DUTY } });
    const target = await makeAccount('noholder', 'employee');
    const before = await credentialOf(target.principalId);

    const res = await recover(founder.token!, { userId: target.userId, reason: GOOD_REASON });
    expect(res.status).toBe(422);
    expect(await credentialOf(target.principalId)).toBe(before);
    expect(await recoveryAudit(target.userId)).toHaveLength(0);
  });
});
