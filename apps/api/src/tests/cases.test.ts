/**
 * The customer Case record (Wave 6, OP:116; SPINE-CONTRACT 1.2; OPUS decision 2).
 *
 * A case is a customer, learner or complaint matter one named person owns, with a
 * response due at a UTC instant. A case can raise one ExceptionRecord, and only
 * one. Each property below is one the record must keep on every path that writes
 * it:
 *   - tenant scope holds on the commands and on the job that flags an overdue
 *     case, and the database refuses a cross-tenant owner;
 *   - the backup is never the owner;
 *   - the state moves only along CASE_TRANSITIONS, and an illegal move is a 409
 *     that leaves the row and its history alone;
 *   - silence never acknowledges: the overdue job flags a case and touches
 *     nothing else;
 *   - a case raises exactly one exception, in the same transaction as the link;
 *   - a visibility tier the principal does not clear hides the case (404 on get,
 *     absent from list);
 *   - a remedy amount is paise, carried as bigint and as a string on the wire;
 *   - a state change commits with its CaseEvent, its audit row and its event, or
 *     none of them does;
 *   - the CaseEvent history cannot be updated or deleted.
 *
 * Real Postgres and real contexts, no mocks. The fault injections are triggers
 * installed for one test each, as commitments.test.ts does it.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { SensitivityClass } from '@kaizen/shared';
import { asSystem } from '../platform/context.js';
import { isGoverned } from '../platform/audit.js';
import {
  CASE_EXCEPTION_CODE,
  CASE_TRANSITIONS,
  acknowledgeCase,
  closeCase,
  getCase,
  listCases,
  openCase,
  raiseExceptionFromCase,
  resolveCase,
  withdrawCase,
  type CaseState,
  type OpenCaseInput,
} from '../domains/cases.js';
import { caseOnWire, openCaseBody } from '../routes/cases.routes.js';
import { runJobsForTenant } from '../jobs/scheduler.js';
import { asPrincipal, asUser, authFor, expectReject, tenantId, unscopedPrisma, type TestPrincipal } from './helpers.js';

const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );

const CHAIRMAN = 'chairman@kaizen.co.in';
const DAY = 86_400_000;
const STATES: CaseState[] = ['open', 'acknowledged', 'resolved', 'closed', 'withdrawn'];
const COMMANDS = ['acknowledge', 'resolve', 'close', 'withdraw'] as const;
type Command = (typeof COMMANDS)[number];
const TARGET: Record<Command, CaseState> = {
  acknowledge: 'acknowledged',
  resolve: 'resolved',
  close: 'closed',
  withdraw: 'withdrawn',
};

let KAIZEN: string;

function uniq(): string {
  return Math.random().toString(36).slice(2, 10);
}

function future(): Date {
  return new Date(Date.now() + 7 * DAY);
}

function past(): Date {
  return new Date(Date.now() - DAY);
}

async function personIn(tid: string): Promise<string> {
  const email = `case-${uniq()}@case.test`;
  const row = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-CASE-${uniq().toUpperCase()}`,
      fullName: 'Case party',
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  return row.id;
}

async function newTenantId(): Promise<string> {
  const slug = `case-other-${uniq()}`;
  const tenant = await unscopedPrisma.tenant.create({ data: { name: `Cases ${slug}`, slug } });
  return tenant.id;
}

/**
 * A role in `tid` that holds the cases resource at `verbs`, and one person in it.
 * The ceiling is passed to authFor by the caller, which is what the WHAT axis reads.
 */
async function fixturePrincipal(tid: string, verbs: string[]): Promise<TestPrincipal> {
  const slug = `case-role-${uniq()}`;
  const role = await unscopedPrisma.accessRole.create({
    data: {
      tenantId: tid,
      slug,
      name: `Cases fixture ${slug}`,
      description: 'Created by cases.test. Not a product role.',
      archetype: 'workspace',
      classificationCeiling: 'internal',
      isSystem: false,
    },
  });
  await unscopedPrisma.grant.create({
    data: {
      tenantId: tid,
      principalType: 'role',
      roleId: role.id,
      resource: 'cases',
      verbs,
      scope: 'all',
      scopeResolver: null,
    },
  });
  const email = `${slug}@case.test`;
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-${slug.toUpperCase()}`,
      fullName: slug,
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  const affiliation = await unscopedPrisma.affiliation.create({
    data: {
      tenantId: tid,
      partyId: person.id,
      affiliationType: 'employee',
      counterpartyName: 'Fixture',
      roleSlug: slug,
      primaryFlag: true,
      status: 'active',
      branch: 'Chennai',
    },
  });
  const user = await unscopedPrisma.user.create({
    data: { tenantId: tid, personId: person.id, email, passwordHash: 'not-a-login', branch: 'Chennai' },
  });
  return {
    tenantId: tid,
    partyId: person.id,
    userId: user.id,
    affiliationId: affiliation.id,
    roleSlug: slug,
    branch: 'Chennai',
  };
}

/** A principal from `p` whose classification ceiling is `ceiling`, the one a non-founder carries. */
function asCeiling(p: TestPrincipal, ceiling: SensitivityClass) {
  return authFor(p, { classificationCeiling: ceiling });
}

async function openIn(overrides: Partial<OpenCaseInput> = {}) {
  const { ownerPartyId, backupPartyId, ...rest } = overrides;
  const owner = ownerPartyId ?? (await personIn(KAIZEN));
  const backup = backupPartyId === undefined ? await personIn(KAIZEN) : backupPartyId;
  const input: OpenCaseInput = {
    kind: 'customer',
    title: `Case ${uniq()}`,
    description: 'Billing dispute on the March invoice',
    ownerPartyId: owner,
    backupPartyId: backup,
    responseDueAt: future(),
    visibilityTier: 'internal',
    severity: 'S2_WARNING',
    lineId: null,
    subjectType: 'invoice',
    subjectId: `subject-${uniq()}`,
    remedyAmountMinor: null,
    ...rest,
  };
  return asUser(CHAIRMAN, () => openCase(input));
}

/** A case driven to `state` through the commands, not by writing the row. */
async function inState(state: CaseState, responseDueAt?: Date): Promise<string> {
  const row = await openIn(responseDueAt ? { responseDueAt } : {});
  if (state === 'open') return row.id;
  if (state === 'withdrawn') {
    await asUser(CHAIRMAN, () => withdrawCase(row.id, 'Withdrawn in the test'));
    return row.id;
  }
  await asUser(CHAIRMAN, () => acknowledgeCase(row.id));
  if (state === 'resolved' || state === 'closed') await asUser(CHAIRMAN, () => resolveCase(row.id));
  if (state === 'closed') await asUser(CHAIRMAN, () => closeCase(row.id));
  return row.id;
}

async function stateOf(id: string): Promise<string> {
  return (await unscopedPrisma.case.findUniqueOrThrow({ where: { id } })).state;
}

async function historyOf(id: string) {
  return unscopedPrisma.caseEvent.findMany({ where: { caseId: id }, orderBy: { at: 'asc' } });
}

async function auditOf(id: string, action = 'update') {
  return unscopedPrisma.auditRecord.findMany({ where: { subjectType: 'case', subjectId: id, action } });
}

async function eventsOf(id: string, eventName: string) {
  return unscopedPrisma.eventRecord.findMany({ where: { subjectEntityId: id, eventName } });
}

async function exceptionsOf(caseId: string) {
  return unscopedPrisma.exceptionRecord.findMany({
    where: { tenantId: KAIZEN, subjectType: 'case', subjectId: caseId },
  });
}

async function linksOf(caseId: string) {
  return unscopedPrisma.caseExceptionLink.findMany({ where: { caseId } });
}

/** Refuses audit rows for one subject type and action, the way the database would if the write failed. */
async function refuseAudit(subjectType: string, action: string): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION w6case_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION 'injected case audit failure'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER w6case_refuse_audit BEFORE INSERT ON audit_records
     FOR EACH ROW WHEN (NEW."subjectType" = '${subjectType}' AND NEW."action" = '${action}')
     EXECUTE FUNCTION w6case_refuse_audit()`,
  );
}

async function restoreFaults(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w6case_refuse_audit ON audit_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w6case_refuse_audit()`);
}

afterEach(async () => {
  await restoreFaults();
});

beforeAll(async () => {
  KAIZEN = await tenantId();
});

describe('tenant isolation', () => {
  it("another tenant's principal gets 404 on every command, and the row is unchanged", async () => {
    const row = await openIn();
    const intruder = await fixturePrincipal(await newTenantId(), ['view', 'create', 'edit']);
    await asPrincipal(asCeiling(intruder, 'regulated'), async () => {
      expect((await expectReject(() => getCase(row.id))).status).toBe(404);
      expect((await expectReject(() => acknowledgeCase(row.id))).status).toBe(404);
      expect((await expectReject(() => resolveCase(row.id))).status).toBe(404);
      expect((await expectReject(() => closeCase(row.id))).status).toBe(404);
      expect((await expectReject(() => withdrawCase(row.id, 'not mine'))).status).toBe(404);
      expect((await expectReject(() => raiseExceptionFromCase(row.id))).status).toBe(404);
    });
    expect(await stateOf(row.id)).toBe('open');
    expect(await historyOf(row.id)).toHaveLength(1);
    expect(await exceptionsOf(row.id)).toHaveLength(0);
  });

  it('the list shows only the caller tenant', async () => {
    const row = await openIn();
    const intruder = await fixturePrincipal(await newTenantId(), ['view']);
    // Filtered by owner so the result does not depend on how many other rows the
    // shared tenant holds: the list is paged by response due date.
    const mine = await asUser(CHAIRMAN, () => listCases({ ownerPartyId: row.ownerPartyId }));
    expect(mine.map((c) => c.id)).toEqual([row.id]);
    const theirs = await asPrincipal(asCeiling(intruder, 'regulated'), () =>
      listCases({ ownerPartyId: row.ownerPartyId }),
    );
    expect(theirs).toEqual([]);
  });

  it('a case cannot name an owner or backup from another tenant', async () => {
    const outsider = await fixturePrincipal(await newTenantId(), ['view']);
    const before = await unscopedPrisma.case.count({ where: { tenantId: KAIZEN } });
    const local = await personIn(KAIZEN);
    await asUser(CHAIRMAN, async () => {
      await expectReject(() => openCase({ ...baseInput(outsider.partyId, local) }));
      await expectReject(() => openCase({ ...baseInput(local, outsider.partyId) }));
    });
    expect(await unscopedPrisma.case.count({ where: { tenantId: KAIZEN } })).toBe(before);
  });

  it('the application role cannot see or change another tenant row, because row-level security refuses it', async () => {
    const row = await openIn();
    const intruder = await newTenantId();
    const app = new PrismaClient({ datasourceUrl: APP_URL });
    try {
      const seen = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${intruder}, true)`;
        return tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "cases" WHERE "id" = ${row.id}`;
      });
      expect(Number(seen[0]!.n)).toBe(0);
      const changed = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${intruder}, true)`;
        return tx.$executeRaw`UPDATE "cases" SET "title" = 'taken over' WHERE "id" = ${row.id}`;
      });
      expect(changed).toBe(0);
    } finally {
      await app.$disconnect();
    }
    expect((await unscopedPrisma.case.findUniqueOrThrow({ where: { id: row.id } })).title).not.toBe('taken over');
  });

  it('the overdue job touches only the tenant it runs for', async () => {
    const mine = await inState('open', past());
    const intruder = await fixturePrincipal(await newTenantId(), ['view', 'create', 'edit']);
    const theirs = await asPrincipal(asCeiling(intruder, 'regulated'), () =>
      openCase(baseInput(intruder.partyId, null, past())),
    );

    await runJobsForTenant(KAIZEN, { jobNames: ['runCaseOverdueJob'] });
    expect(await flaggedOf(mine)).not.toBeNull();
    expect(await flaggedOf(theirs.id)).toBeNull();

    await runJobsForTenant(intruder.tenantId, { jobNames: ['runCaseOverdueJob'] });
    expect(await flaggedOf(theirs.id)).not.toBeNull();
  });
});

function baseInput(owner: string, backup: string | null, responseDueAt: Date = future()): OpenCaseInput {
  return {
    kind: 'complaint',
    title: `Cross-tenant ${uniq()}`,
    ownerPartyId: owner,
    backupPartyId: backup,
    responseDueAt,
    visibilityTier: 'internal',
    severity: 'S1_ATTENTION',
    lineId: null,
    subjectType: 'invoice',
    subjectId: 'x',
    remedyAmountMinor: null,
  };
}

async function flaggedOf(id: string): Promise<Date | null> {
  return (await unscopedPrisma.case.findUniqueOrThrow({ where: { id } })).overdueFlaggedAt;
}

describe('the backup is never the owner', () => {
  it('a case naming the same person as owner and backup is refused, and no row is written', async () => {
    const same = await personIn(KAIZEN);
    const title = `Same person ${uniq()}`;
    const err = await asUser(CHAIRMAN, () => expectReject(() => openCase({ ...baseInput(same, same), title })));
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.case.count({ where: { title } })).toBe(0);
  });

  it('the database refuses a row whose backup is its owner, whichever writer put it there', async () => {
    const p = await personIn(KAIZEN);
    await expect(
      unscopedPrisma.case.create({
        data: {
          tenantId: KAIZEN,
          recordCode: `CAS-RAW-${uniq().toUpperCase()}`,
          kind: 'customer',
          title: 'Raw same person',
          ownerPartyId: p,
          backupPartyId: p,
          responseDueAt: future(),
          state: 'open',
          visibilityTier: 'internal',
          severity: 'S2_WARNING',
        },
      }),
    ).rejects.toThrow(/check|violates/i);
  });
});

describe('the state table', () => {
  it('nothing leaves closed or withdrawn, and resolved may only be closed', () => {
    expect(CASE_TRANSITIONS.closed).toEqual([]);
    expect(CASE_TRANSITIONS.withdrawn).toEqual([]);
    expect(CASE_TRANSITIONS.resolved).toEqual(['closed']);
    expect([...CASE_TRANSITIONS.open].sort()).toEqual(['acknowledged', 'withdrawn']);
    expect([...CASE_TRANSITIONS.acknowledged].sort()).toEqual(['resolved', 'withdrawn']);
  });

  it.each(STATES.flatMap((from) => COMMANDS.map((cmd) => [from, cmd] as const)))('from %s, %s', async (from, cmd) => {
    const id = await inState(from);
    const to = TARGET[cmd];
    const allowed = CASE_TRANSITIONS[from].includes(to);
    const run = () => {
      switch (cmd) {
        case 'acknowledge':
          return acknowledgeCase(id);
        case 'resolve':
          return resolveCase(id);
        case 'close':
          return closeCase(id);
        case 'withdraw':
          return withdrawCase(id, 'Table check');
      }
    };
    const historyBefore = (await historyOf(id)).length;
    const auditBefore = (await auditOf(id)).length;

    if (allowed) {
      const row = await asUser(CHAIRMAN, run);
      expect(row.state).toBe(to);
      expect(await stateOf(id)).toBe(to);
      expect(await historyOf(id)).toHaveLength(historyBefore + 1);
      expect(await auditOf(id)).toHaveLength(auditBefore + 1);
    } else {
      const err = await asUser(CHAIRMAN, () => expectReject(run));
      expect(err.status).toBe(409);
      expect(await stateOf(id)).toBe(from);
      expect(await historyOf(id)).toHaveLength(historyBefore);
      expect(await auditOf(id)).toHaveLength(auditBefore);
    }
  });
});

describe('silence never acknowledges', () => {
  it('an open case past its response due instant is flagged overdue and nothing else changes', async () => {
    const id = await inState('open', past());
    const result = await asSystem(KAIZEN, () => runJobsForTenant(KAIZEN, { jobNames: ['runCaseOverdueJob'] }));
    expect(result.runCaseOverdueJob!.errors).toEqual([]);

    const row = await unscopedPrisma.case.findUniqueOrThrow({ where: { id } });
    expect(row.overdueFlaggedAt).not.toBeNull();
    expect(row.state).toBe('open');
    expect(row.acknowledgedById).toBeNull();
    expect(row.acknowledgedAt).toBeNull();

    const history = await historyOf(id);
    expect(history.map((e) => e.toState)).toEqual(['open', 'open']);
    expect(history.at(-1)!.actorPartyId).toBeNull();
    expect(await eventsOf(id, 'kz.gov.case.marked_overdue')).toHaveLength(1);
    expect(await eventsOf(id, 'kz.gov.case.acknowledged')).toHaveLength(0);
  });

  it('a rerun of the overdue job writes nothing new', async () => {
    const id = await inState('open', past());
    await asSystem(KAIZEN, () => runJobsForTenant(KAIZEN, { jobNames: ['runCaseOverdueJob'] }));
    const historyBefore = (await historyOf(id)).length;
    const auditBefore = (await auditOf(id)).length;

    const rerun = await asSystem(KAIZEN, () => runJobsForTenant(KAIZEN, { jobNames: ['runCaseOverdueJob'] }));

    expect(rerun.runCaseOverdueJob!.notified).toBe(0);
    expect(await historyOf(id)).toHaveLength(historyBefore);
    expect(await auditOf(id)).toHaveLength(auditBefore);
    expect(await eventsOf(id, 'kz.gov.case.marked_overdue')).toHaveLength(1);
  });

  it('a case acknowledged in time is not flagged, however late its due instant now reads', async () => {
    const id = await inState('acknowledged');
    await unscopedPrisma.case.update({ where: { id }, data: { responseDueAt: past() } });
    await asSystem(KAIZEN, () => runJobsForTenant(KAIZEN, { jobNames: ['runCaseOverdueJob'] }));
    expect(await flaggedOf(id)).toBeNull();
    expect(await stateOf(id)).toBe('acknowledged');
  });
});

describe('only a human acknowledges', () => {
  it('a system principal cannot acknowledge, and the case stays open', async () => {
    const row = await openIn();
    const err = await asSystem(KAIZEN, () => expectReject(() => acknowledgeCase(row.id)));
    expect(err.status).toBe(403);
    expect(await stateOf(row.id)).toBe('open');
    expect(await eventsOf(row.id, 'kz.gov.case.acknowledged')).toHaveLength(0);
  });
});

describe('a state change commits with its CaseEvent, its audit row and its event', () => {
  it('when the audit row cannot be written, the acknowledgement does not happen', async () => {
    const row = await openIn();
    await refuseAudit('case', 'update');
    const err = await asUser(CHAIRMAN, () => expectReject(() => acknowledgeCase(row.id)));
    await restoreFaults();
    expect(err.message).toMatch(/injected case audit failure/);
    expect(await stateOf(row.id)).toBe('open');
    expect((await historyOf(row.id)).map((e) => e.toState)).toEqual(['open']);
    expect(await eventsOf(row.id, 'kz.gov.case.acknowledged')).toHaveLength(0);
  });

  it('a clean acknowledgement writes one CaseEvent, one audit row and one event, all on the same subject', async () => {
    const row = await openIn();
    await asUser(CHAIRMAN, () => acknowledgeCase(row.id));
    const history = (await historyOf(row.id)).filter((e) => e.toState === 'acknowledged');
    expect(history).toHaveLength(1);
    expect(history[0]!.fromState).toBe('open');
    expect(await auditOf(row.id)).toHaveLength(1);
    expect(await eventsOf(row.id, 'kz.gov.case.acknowledged')).toHaveLength(1);
  });
});

describe('CaseEvent is append-only', () => {
  it('an UPDATE of a history row is refused for every role', async () => {
    const row = await openIn();
    await expect(
      unscopedPrisma.$executeRaw`UPDATE "case_events" SET "reason" = 'rewritten' WHERE "caseId" = ${row.id}`,
    ).rejects.toThrow(/immutable/i);
  });

  it('a DELETE of a history row is refused for every role', async () => {
    const row = await openIn();
    await expect(unscopedPrisma.$executeRaw`DELETE FROM "case_events" WHERE "caseId" = ${row.id}`).rejects.toThrow(
      /immutable/i,
    );
    expect(await historyOf(row.id)).toHaveLength(1);
  });
});

describe('raising an exception from a case', () => {
  it('creates exactly one ExceptionRecord, its link, and one event, on the case owner and severity', async () => {
    const row = await openIn({ severity: 'S3_HIGH_RISK' });
    const { exception } = await asUser(CHAIRMAN, () => raiseExceptionFromCase(row.id));

    const exceptions = await exceptionsOf(row.id);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.id).toBe(exception.id);
    expect(exceptions[0]!.code).toBe(CASE_EXCEPTION_CODE);
    expect(exceptions[0]!.severity).toBe('S3_HIGH_RISK');
    expect(exceptions[0]!.ownerPartyId).toBe(row.ownerPartyId);

    const links = await linksOf(row.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.exceptionRecordId).toBe(exception.id);
    expect(await eventsOf(row.id, 'kz.gov.case.exception_raised')).toHaveLength(1);
    expect(await stateOf(row.id)).toBe('open');
  });

  it('a second raise is refused with 409 and creates nothing', async () => {
    const row = await openIn();
    await asUser(CHAIRMAN, () => raiseExceptionFromCase(row.id));
    const err = await asUser(CHAIRMAN, () => expectReject(() => raiseExceptionFromCase(row.id)));
    expect(err.status).toBe(409);
    expect(await exceptionsOf(row.id)).toHaveLength(1);
    expect(await linksOf(row.id)).toHaveLength(1);
  });

  it('a withdrawn case raises nothing', async () => {
    const id = await inState('withdrawn');
    const err = await asUser(CHAIRMAN, () => expectReject(() => raiseExceptionFromCase(id)));
    expect(err.status).toBe(409);
    expect(await exceptionsOf(id)).toHaveLength(0);
    expect(await linksOf(id)).toHaveLength(0);
  });

  it('when the exception audit row cannot be written, neither the exception nor the link survives', async () => {
    const row = await openIn();
    await refuseAudit('exception', 'create');
    const err = await asUser(CHAIRMAN, () => expectReject(() => raiseExceptionFromCase(row.id)));
    await restoreFaults();
    expect(err.message).toMatch(/injected case audit failure/);
    expect(await exceptionsOf(row.id)).toHaveLength(0);
    expect(await linksOf(row.id)).toHaveLength(0);
    expect(await eventsOf(row.id, 'kz.gov.case.exception_raised')).toHaveLength(0);
  });
});

describe('visibility tier', () => {
  it('a non-founder whose ceiling does not clear the tier cannot get the case, and it is absent from the list', async () => {
    const owner = await personIn(KAIZEN);
    const open = await openIn({ ownerPartyId: owner, visibilityTier: 'internal' });
    const sealed = await openIn({ ownerPartyId: owner, visibilityTier: 'confidential' });
    const viewer = await fixturePrincipal(KAIZEN, ['view', 'edit']);
    const auth = asCeiling(viewer, 'internal');

    await asPrincipal(auth, async () => {
      expect((await expectReject(() => getCase(sealed.id))).status).toBe(404);
      expect((await getCase(open.id)).id).toBe(open.id);
      const seen = (await listCases({ ownerPartyId: owner })).map((c) => c.id);
      expect(seen).toEqual([open.id]);
      const err = await expectReject(() => acknowledgeCase(sealed.id));
      expect(err.status).toBe(404);
    });
    expect(await stateOf(sealed.id)).toBe('open');

    const chairman = await asUser(CHAIRMAN, () => listCases({ ownerPartyId: owner }));
    expect(chairman.map((c) => c.id).sort()).toEqual([open.id, sealed.id].sort());
  });
});

describe('permission', () => {
  it('a principal with view but not edit gets 403 on every command and the case is unchanged', async () => {
    const row = await openIn();
    const reader = await fixturePrincipal(KAIZEN, ['view']);
    await asPrincipal(asCeiling(reader, 'regulated'), async () => {
      expect((await expectReject(() => acknowledgeCase(row.id))).status).toBe(403);
      expect((await expectReject(() => withdrawCase(row.id, 'no'))).status).toBe(403);
      expect((await expectReject(() => raiseExceptionFromCase(row.id))).status).toBe(403);
    });
    expect(await stateOf(row.id)).toBe('open');
    expect(await historyOf(row.id)).toHaveLength(1);
    expect(await exceptionsOf(row.id)).toHaveLength(0);
  });
});

describe('audit and registration', () => {
  it('the case entity is governed, and opening a case writes its audit row and its event', async () => {
    expect(isGoverned('case')).toBe(true);
    const row = await openIn();
    const audit = await auditOf(row.id, 'create');
    expect(audit).toHaveLength(1);
    expect(await eventsOf(row.id, 'kz.gov.case.opened')).toHaveLength(1);
  });
});

describe('remedy amounts are paise', () => {
  it('the wire takes a paise string, refuses a JavaScript number, and returns a string', () => {
    const body = {
      kind: 'learner',
      title: 'Refund',
      ownerPartyId: 'p',
      responseDueAt: future().toISOString(),
      visibilityTier: 'internal',
      severity: 'S2_WARNING',
    };
    expect(openCaseBody.parse({ ...body, remedyAmountMinor: '1234500' }).remedyAmountMinor).toBe(1234500n);
    expect(openCaseBody.safeParse({ ...body, remedyAmountMinor: 1234500 }).success).toBe(false);
    expect(openCaseBody.safeParse({ ...body, remedyAmountMinor: '12.50' }).success).toBe(false);
    expect(openCaseBody.safeParse({ ...body, remedyAmountMinor: '-5' }).success).toBe(false);
  });

  it('a stored remedy amount reads back as the same bigint, and the wire form is a string', async () => {
    const row = await openIn({ remedyAmountMinor: 1234500n });
    const read = await asUser(CHAIRMAN, () => getCase(row.id));
    expect(read.remedyAmountMinor).toBe(1234500n);
    const wire = caseOnWire(read);
    expect(wire.remedyAmountMinor).toBe('1234500');
    expect(JSON.stringify(wire)).toContain('"remedyAmountMinor":"1234500"');
  });

  it('the database refuses a negative remedy amount, whichever writer put it there', async () => {
    const p = await personIn(KAIZEN);
    await expect(
      unscopedPrisma.case.create({
        data: {
          tenantId: KAIZEN,
          recordCode: `CAS-NEG-${uniq().toUpperCase()}`,
          kind: 'customer',
          title: 'Negative remedy',
          ownerPartyId: p,
          responseDueAt: future(),
          state: 'open',
          visibilityTier: 'internal',
          severity: 'S2_WARNING',
          remedyAmountMinor: -1n,
        },
      }),
    ).rejects.toThrow(/check|violates/i);
  });
});
