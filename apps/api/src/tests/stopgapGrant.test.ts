/**
 * The stopgap IT owner grant (DECISIONS round 24 item c, C-015; ACCESS-MODEL-PLAN Wave 4).
 *
 * Until onboarding names an IT admin, only the founder may create a stopgap grant set, tagged
 * `to_migrate`. It is audited, listed in the exceptions view, and ended (never deleted) when
 * onboarding retires it. A holder of grants:create who is not the founder is refused, because
 * the founder is read from the duty and not from a grant.
 *
 * Driven over HTTP against createApp() and the real database. Each test makes its own person
 * and its own grants, and ends any stopgap grant the tenant still holds at its start, so no
 * test depends on another's rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { DutyAssignment } from '@prisma/client';
import { createApp } from '../server.js';
import { hashPassword } from '../lib/auth.js';
import { FOUNDER_DUTY } from '../domains/statutory.js';
import { addMissingGrants } from '../platform/grantSync.js';
import { STOPGAP_PROVENANCE } from '../domains/access/stopgapGrants.js';
import { tenantId, unscopedPrisma } from './helpers.js';

const PASSWORD = 'Stopgap-Test-4w!pass';
const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

let server: Server;
let base: string;
let tid: string;
let dutiesBefore: DutyAssignment[] = [];
let founder: Account;
let notFounder: Account;

interface Account {
  email: string;
  personId: string;
  password: string;
  token?: string;
}

async function makePerson(label: string): Promise<string> {
  const email = `${label}-${stamp}-${Math.floor(Math.random() * 1e6)}@stopgap.test`;
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-SG-${label.toUpperCase()}-${stamp}-${Math.floor(Math.random() * 1e6)}`,
      fullName: `Stopgap ${label}`,
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  return person.id;
}

/** A chairman-role account holds grants:create, so a refusal of it is the founder check and not the grant check. */
async function makeAccount(label: string): Promise<Account> {
  const email = `${label}-${stamp}-${Math.floor(Math.random() * 1e6)}@stopgap.test`;
  const personId = await makePerson(label);
  await unscopedPrisma.affiliation.create({
    data: {
      tenantId: tid,
      partyId: personId,
      affiliationType: 'employee',
      counterpartyName: 'Stopgap fixture',
      roleSlug: 'chairman',
      primaryFlag: true,
      status: 'active',
      branch: 'Chennai',
    },
  });
  const principal = await unscopedPrisma.principal.create({
    data: { email, passwordHash: await hashPassword(PASSWORD) },
  });
  await unscopedPrisma.user.create({
    data: { tenantId: tid, personId, email, principalId: principal.id, status: 'active', branch: 'Chennai' },
  });
  return { email, personId, password: PASSWORD };
}

const call = (method: 'GET' | 'POST', path: string, token: string, body?: unknown) =>
  fetch(`${base}/api/admin${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

async function signedInToken(account: Account): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** One stopgap grant set for the IT owner, as the founder would send it. */
const stopgapBody = (personId: string, resource = 'access_assignments') => ({
  personId,
  provenance: STOPGAP_PROVENANCE,
  grants: [{ resource, verbs: ['view', 'edit'], scope: 'all' }],
});

async function stopgapRowsFor(personId: string) {
  return unscopedPrisma.grant.findMany({
    where: { tenantId: tid, principalType: 'individual', principalId: personId, provenance: STOPGAP_PROVENANCE },
  });
}

async function auditFor(grantId: string, action: string) {
  return unscopedPrisma.auditRecord.findMany({
    where: { tenantId: tid, subjectType: 'grant', subjectId: grantId, action },
  });
}

beforeAll(async () => {
  const app = createApp({ webDistDir: '', corsOrigins: [] });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  tid = await tenantId();
  dutiesBefore = await unscopedPrisma.dutyAssignment.findMany({
    where: { tenantId: tid, dutyKey: FOUNDER_DUTY },
  });
  await addMissingGrants(tid);

  founder = await makeAccount('founder');
  notFounder = await makeAccount('notfounder');
  // The suite shares one database, so the login limiter's buckets carry over from earlier files; CI hit 429 here.
  await unscopedPrisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE key LIKE 'login:%'`;
  founder.token = await signedInToken(founder);
  notFounder.token = await signedInToken(notFounder);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Ends what the tests created; the rows stay, as history, and are no longer in force.
  await unscopedPrisma.grant.updateMany({
    where: { tenantId: tid, provenance: STOPGAP_PROVENANCE, effectiveTo: null },
    data: { effectiveTo: new Date() },
  });
  // The founder duty is the seeded owner's in the kaizen tenant. Put the rows back as they were.
  await unscopedPrisma.dutyAssignment.deleteMany({ where: { tenantId: tid, dutyKey: FOUNDER_DUTY } });
  if (dutiesBefore.length > 0) await unscopedPrisma.dutyAssignment.createMany({ data: dutiesBefore });
});

beforeEach(async () => {
  await unscopedPrisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE key LIKE 'login:%'`;
  await unscopedPrisma.dutyAssignment.deleteMany({ where: { tenantId: tid, dutyKey: FOUNDER_DUTY } });
  await unscopedPrisma.dutyAssignment.create({
    data: {
      tenantId: tid,
      dutyKey: FOUNDER_DUTY,
      partyId: founder.personId,
      effectiveFrom: new Date(Date.now() - 60_000),
      assignedBy: founder.personId,
    },
  });
  // Ends every stopgap the tenant holds, so each test starts with none in force.
  await unscopedPrisma.grant.updateMany({
    where: { tenantId: tid, provenance: STOPGAP_PROVENANCE, effectiveTo: null },
    data: { effectiveTo: new Date(Date.now() - 1000) },
  });
});

describe('stopgap IT owner grant: the founder creates it', () => {
  it('the founder creates a grant tagged to_migrate, the audit row records it, and the exceptions view lists it', async () => {
    const personId = await makePerson('itowner');

    const res = await call('POST', '/grants/stopgap', founder.token!, stopgapBody(personId));
    expect(res.status).toBe(201);
    const { grants } = (await res.json()) as { grants: { id: string }[] };
    expect(grants).toHaveLength(1);

    const [row] = await stopgapRowsFor(personId);
    expect(row).toBeDefined();
    expect(row!.id).toBe(grants[0]!.id);
    expect(row!.provenance).toBe('to_migrate');
    expect(row!.principalType).toBe('individual');
    expect(row!.effectiveTo).toBeNull();

    const created = await auditFor(row!.id, 'create');
    expect(created).toHaveLength(1);
    expect(created[0]!.actorId).toBe(founder.personId);
    expect(created[0]!.meta).toMatchObject({ provenance: 'to_migrate' });

    const listed = await call('GET', '/grants/stopgap', founder.token!);
    expect(listed.status).toBe(200);
    const { grants: inView } = (await listed.json()) as { grants: { id: string }[] };
    expect(inView.map((g) => g.id)).toContain(row!.id);
  });

  it('a non-founder who holds grants:create is refused 403 and nothing is written', async () => {
    const personId = await makePerson('refusedowner');

    const res = await call('POST', '/grants/stopgap', notFounder.token!, stopgapBody(personId));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details?: { reasonCode?: string } } };
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.details?.reasonCode).toBe('founder_only');

    expect(await stopgapRowsFor(personId)).toHaveLength(0);
  });

  it('a provenance other than to_migrate is refused 400 and nothing is written', async () => {
    const personId = await makePerson('wrongprovenance');

    const res = await call('POST', '/grants/stopgap', founder.token!, {
      ...stopgapBody(personId),
      provenance: 'bootstrap',
    });
    expect(res.status).toBe(400);
    expect(await stopgapRowsFor(personId)).toHaveLength(0);
  });

  it('a second in-force stopgap for the same resource is refused 409', async () => {
    const personId = await makePerson('twice');
    expect((await call('POST', '/grants/stopgap', founder.token!, stopgapBody(personId))).status).toBe(201);

    const again = await call('POST', '/grants/stopgap', founder.token!, stopgapBody(personId));
    expect(again.status).toBe(409);
    expect(await stopgapRowsFor(personId)).toHaveLength(1);
  });
});

describe('stopgap IT owner grant: retiring ends it, and it leaves the exceptions view', () => {
  it('the founder retires the stopgap: rows are ended not deleted, audited, and no longer listed', async () => {
    const personId = await makePerson('retiree');
    expect((await call('POST', '/grants/stopgap', founder.token!, stopgapBody(personId))).status).toBe(201);
    const [row] = await stopgapRowsFor(personId);

    const res = await call('POST', '/grants/stopgap/retire', founder.token!);
    expect(res.status).toBe(200);
    // beforeEach ended every other stopgap, so the one created above is the only one retired.
    expect(((await res.json()) as { retired: number }).retired).toBe(1);

    const [ended] = await stopgapRowsFor(personId);
    expect(ended).toBeDefined();
    expect(ended!.effectiveTo).not.toBeNull();
    expect(ended!.effectiveTo!.getTime()).toBeLessThanOrEqual(Date.now());

    const updated = await auditFor(row!.id, 'update');
    expect(updated.length).toBeGreaterThanOrEqual(1);
    expect(updated.some((a) => (a.meta as { retired?: boolean } | null)?.retired === true)).toBe(true);

    const listed = await call('GET', '/grants/stopgap', founder.token!);
    const { grants: inView } = (await listed.json()) as { grants: { id: string }[] };
    expect(inView.map((g) => g.id)).not.toContain(row!.id);
  });

  it('a non-founder cannot retire: 403, and the stopgap stays in force', async () => {
    const personId = await makePerson('stays');
    expect((await call('POST', '/grants/stopgap', founder.token!, stopgapBody(personId))).status).toBe(201);
    const [row] = await stopgapRowsFor(personId);

    const res = await call('POST', '/grants/stopgap/retire', notFounder.token!);
    expect(res.status).toBe(403);

    const [still] = await stopgapRowsFor(personId);
    expect(still!.effectiveTo).toBeNull();
    expect(await auditFor(row!.id, 'update')).toHaveLength(0);
  });
});
