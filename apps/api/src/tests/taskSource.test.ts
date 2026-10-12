/**
 * The typed task source (Wave 6, OP:118; SPINE-CONTRACT 1.4; OPUS decision 6).
 *
 * A task says what it is about with a `sourceKind` from TASK_SOURCE_KINDS and a
 * `sourceId` naming the row. Each property below is one the source must keep:
 *   - the kind is inside the registry, and the database refuses a value outside
 *     it even for a writer that goes around the domain;
 *   - a typed task names its row, and a manual task names none;
 *   - the named row exists in the same tenant. A row from another tenant reads as
 *     absent, so a refusal for a foreign id is the same refusal as for a missing one;
 *   - a refused write leaves no task behind;
 *   - a created task is audited and its event is emitted;
 *   - closing a task does not change who owns it (contract PR 0 check);
 *   - the migration's backfill maps the relatedType values that name a registry
 *     kind, to rows that exist, and leaves every other row manual.
 *
 * Real Postgres and real contexts, no mocks. The backfill is run from the
 * migration file itself, so the test cannot drift from the SQL that shipped.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { EVENTS, TASK_SOURCE_KINDS } from '@kaizen/shared';
import { createTask, completeTask } from '../domains/tasks.js';
import { emittedEvents, setEventCapture } from '../platform/eventBus.js';
import { asUser, expectReject, tenantId, unscopedPrisma } from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const MIGRATION = new URL('../../prisma/migrations/20261013130000_task_source_kind/migration.sql', import.meta.url);

let KAIZEN: string;

function uniq(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function personIn(tid: string): Promise<string> {
  const email = `tsk-${uniq()}@tsk.test`;
  const row = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-TSK-${uniq().toUpperCase()}`,
      fullName: 'Task source party',
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  return row.id;
}

async function commitmentIn(tid: string): Promise<string> {
  const owner = await personIn(tid);
  const row = await unscopedPrisma.commitment.create({
    data: {
      tenantId: tid,
      recordCode: `CMT-TSK-${uniq().toUpperCase()}`,
      title: 'Task source commitment',
      ownerPartyId: owner,
      dueAt: new Date(Date.now() + 86_400_000),
      sourceType: 'manual',
      subjectType: 'mou',
      subjectId: `subject-${uniq()}`,
    },
  });
  return row.id;
}

/** A tenant of its own, with one commitment in it. Its id must not resolve for KAIZEN. */
async function commitmentInOtherTenant(): Promise<string> {
  const slug = `tsk-other-${uniq()}`;
  const tenant = await unscopedPrisma.tenant.create({ data: { name: `Task source ${slug}`, slug } });
  return commitmentIn(tenant.id);
}

function taskRecordCode(): string {
  return `TSK-W6T-${uniq().toUpperCase()}`;
}

async function taskRow(id: string) {
  return unscopedPrisma.task.findUniqueOrThrow({ where: { id } });
}

async function taskCountWithTitle(title: string): Promise<number> {
  return unscopedPrisma.task.count({ where: { tenantId: KAIZEN, title } });
}

beforeAll(async () => {
  KAIZEN = await tenantId();
});

describe('task source registry and the database floor', () => {
  it('the registry is the six kinds the contract names', () => {
    expect([...TASK_SOURCE_KINDS]).toEqual([
      'commitment',
      'case',
      'decision',
      'exception',
      'onboarding_task',
      'manual',
    ]);
  });

  it('the sourceKind CHECK names exactly the registry values', async () => {
    const rows = await unscopedPrisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      WHERE c.conname = 'tasks_source_kind_known'`;
    expect(rows).toHaveLength(1);
    const listed = [...rows[0].def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...TASK_SOURCE_KINDS].sort());
  });

  it('the database refuses a sourceKind outside the registry', async () => {
    const err = await expectReject(() =>
      unscopedPrisma.task.create({
        data: {
          tenantId: KAIZEN,
          recordCode: taskRecordCode(),
          title: 'Kind outside the registry',
          status: 'open',
          sourceKind: 'invoice',
          sourceId: 'anything',
        },
      }),
    );
    expect(err.message).toMatch(/tasks_source_kind_known/);
  });

  it('the database refuses a typed task that names no row', async () => {
    const err = await expectReject(() =>
      unscopedPrisma.task.create({
        data: {
          tenantId: KAIZEN,
          recordCode: taskRecordCode(),
          title: 'Typed, no row',
          status: 'open',
          sourceKind: 'commitment',
          sourceId: null,
        },
      }),
    );
    expect(err.message).toMatch(/tasks_source_id_when_typed/);
  });
});

describe('createTask refuses at the write boundary', () => {
  it('refuses a kind outside the registry with 422, and writes no task', async () => {
    const title = `Refused kind ${uniq()}`;
    const owner = await personIn(KAIZEN);
    const err = await asUser(CHAIRMAN, () =>
      expectReject(() => createTask({ title, ownerPartyId: owner, sourceKind: 'invoice' as never, sourceId: 'x' })),
    );
    expect(err.status).toBe(422);
    expect(await taskCountWithTitle(title)).toBe(0);
  });

  it('refuses a commitment id from another tenant with 422, and writes no task', async () => {
    const title = `Foreign source ${uniq()}`;
    const owner = await personIn(KAIZEN);
    const foreign = await commitmentInOtherTenant();
    const err = await asUser(CHAIRMAN, () =>
      expectReject(() => createTask({ title, ownerPartyId: owner, sourceKind: 'commitment', sourceId: foreign })),
    );
    expect(err.status).toBe(422);
    expect(await taskCountWithTitle(title)).toBe(0);
  });

  it('refuses a case id that names no row, with 422', async () => {
    const title = `Missing source ${uniq()}`;
    const owner = await personIn(KAIZEN);
    const err = await asUser(CHAIRMAN, () =>
      expectReject(() =>
        createTask({ title, ownerPartyId: owner, sourceKind: 'case', sourceId: `no-such-case-${uniq()}` }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await taskCountWithTitle(title)).toBe(0);
  });

  it('refuses a typed kind with no sourceId, and a manual task that names a row, with 422', async () => {
    const owner = await personIn(KAIZEN);
    const typedNoRow = await asUser(CHAIRMAN, () =>
      expectReject(() => createTask({ title: `Typed no row ${uniq()}`, ownerPartyId: owner, sourceKind: 'decision' })),
    );
    expect(typedNoRow.status).toBe(422);
    const manualWithRow = await asUser(CHAIRMAN, () =>
      expectReject(() =>
        createTask({ title: `Manual with row ${uniq()}`, ownerPartyId: owner, sourceKind: 'manual', sourceId: 'x' }),
      ),
    );
    expect(manualWithRow.status).toBe(422);
  });

  it('a commitment of the same tenant is accepted, its kind and id are stored, and the write is audited and emitted', async () => {
    const title = `Own source ${uniq()}`;
    const owner = await personIn(KAIZEN);
    const own = await commitmentIn(KAIZEN);

    setEventCapture(true);
    emittedEvents.length = 0;
    const task = await asUser(CHAIRMAN, () =>
      createTask({ title, ownerPartyId: owner, sourceKind: 'commitment', sourceId: own }),
    );

    const row = await taskRow(task.id);
    expect(row.sourceKind).toBe('commitment');
    expect(row.sourceId).toBe(own);

    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { subjectType: 'task', subjectId: task.id, action: 'create' },
    });
    expect(audit).not.toBeNull();

    const events = emittedEvents.filter((e) => e.eventName === EVENTS.TASK_CREATED && e.subject.entityId === task.id);
    expect(events).toHaveLength(1);
  });
});

describe('closing a task (contract PR 0 check)', () => {
  it('completing a task does not change its owner, and its source is untouched', async () => {
    const owner = await personIn(KAIZEN);
    const assignee = await personIn(KAIZEN);
    const task = await asUser(CHAIRMAN, () =>
      createTask({
        title: `Close keeps owner ${uniq()}`,
        ownerPartyId: owner,
        assigneePartyId: assignee,
        sourceKind: 'manual',
        sourceId: null,
      }),
    );

    await asUser(CHAIRMAN, () => completeTask(task.id));

    const row = await taskRow(task.id);
    expect(row.status).toBe('done');
    expect(row.ownerPartyId).toBe(owner);
    expect(row.sourceKind).toBe('manual');
  });
});

describe('the backfill in the migration', () => {
  /** The SQL between the BACKFILL markers, exactly as the migration ships it. */
  function backfillSql(): string {
    const sql = readFileSync(MIGRATION, 'utf8');
    const begin = sql.indexOf('-- BACKFILL:BEGIN');
    const end = sql.indexOf('-- BACKFILL:END');
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    return sql.slice(begin, end);
  }

  it('maps each relatedType that names a registry kind to a row that exists, and leaves the rest manual', async () => {
    const ownCommitment = await commitmentIn(KAIZEN);
    const foreignCommitment = await commitmentInOtherTenant();
    const owner = await personIn(KAIZEN);

    const decision = await unscopedPrisma.decision.create({
      data: {
        tenantId: KAIZEN,
        recordCode: `DEC-TSK-${uniq().toUpperCase()}`,
        question: 'Backfill probe',
        subjectType: 'task',
        subjectId: `subject-${uniq()}`,
        authorityBasis: 'test',
      },
    });
    const caseRow = await unscopedPrisma.case.create({
      data: {
        tenantId: KAIZEN,
        recordCode: `CAS-TSK-${uniq().toUpperCase()}`,
        kind: 'customer',
        title: 'Backfill probe case',
        ownerPartyId: owner,
        responseDueAt: new Date(Date.now() + 86_400_000),
        visibilityTier: 'internal',
        severity: 'S1_ATTENTION',
      },
    });
    const exception = await unscopedPrisma.exceptionRecord.create({
      data: {
        tenantId: KAIZEN,
        recordCode: `EXC-TSK-${uniq().toUpperCase()}`,
        code: 'EX-TSK-TEST',
        label: 'Backfill probe exception',
        severity: 'S1_ATTENTION',
        subjectType: 'task',
        subjectId: `subject-${uniq()}`,
      },
    });
    const onboarding = await unscopedPrisma.onboardingTask.create({
      data: {
        tenantId: KAIZEN,
        employmentId: `emp-${uniq()}`,
        title: 'Backfill probe onboarding',
        assignee: 'HR',
      },
    });

    const cases: Array<{ relatedType: string; relatedId: string; expectKind: string; expectSource: string | null }> = [
      { relatedType: 'commitment', relatedId: ownCommitment, expectKind: 'commitment', expectSource: ownCommitment },
      { relatedType: 'decision', relatedId: decision.id, expectKind: 'decision', expectSource: decision.id },
      { relatedType: 'case', relatedId: caseRow.id, expectKind: 'case', expectSource: caseRow.id },
      { relatedType: 'exception', relatedId: exception.id, expectKind: 'exception', expectSource: exception.id },
      {
        relatedType: 'onboarding_task',
        relatedId: onboarding.id,
        expectKind: 'onboarding_task',
        expectSource: onboarding.id,
      },
      // The id exists, in another tenant: the same as an id that does not exist.
      { relatedType: 'commitment', relatedId: foreignCommitment, expectKind: 'manual', expectSource: null },
      // A registry kind with no row behind it.
      { relatedType: 'case', relatedId: `no-such-case-${uniq()}`, expectKind: 'manual', expectSource: null },
      // A relatedType outside the registry is never mapped.
      { relatedType: 'lead', relatedId: caseRow.id, expectKind: 'manual', expectSource: null },
    ];

    const ids: string[] = [];
    for (const c of cases) {
      const row = await unscopedPrisma.task.create({
        data: {
          tenantId: KAIZEN,
          recordCode: taskRecordCode(),
          title: `Backfill ${c.relatedType} ${uniq()}`,
          status: 'open',
          relatedType: c.relatedType,
          relatedId: c.relatedId,
        },
      });
      ids.push(row.id);
    }

    await unscopedPrisma.$executeRawUnsafe(backfillSql());

    for (let i = 0; i < cases.length; i += 1) {
      const c = cases[i];
      const row = await taskRow(ids[i]);
      expect({ type: c.relatedType, kind: row.sourceKind, source: row.sourceId }).toEqual({
        type: c.relatedType,
        kind: c.expectKind,
        source: c.expectSource,
      });
      // The backfill adds the typed source. It does not drop the legacy pair.
      expect(row.relatedType).toBe(c.relatedType);
      expect(row.relatedId).toBe(c.relatedId);
    }
  });
});
