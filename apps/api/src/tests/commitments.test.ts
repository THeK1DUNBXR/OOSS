/**
 * The Commitment record (OP:115; SPINE-CONTRACT 1.1; OPUS decision 9).
 *
 * A commitment is a promise a named person owns, due at an instant. Each
 * property below is one the record must keep on every path that writes it:
 *   - tenant scope holds on the commands and on the job that marks a commitment
 *     missed, and the database refuses a cross-tenant owner;
 *   - the backup is never the owner;
 *   - the state moves only along COMMITMENT_TRANSITIONS, and an illegal move is a
 *     409 that leaves the row and its history alone;
 *   - only a human confirms. A model's proposal stays `proposed`;
 *   - a state change commits with its CommitmentEvent, its audit row and its
 *     event record, or none of them does;
 *   - the CommitmentEvent history cannot be updated or deleted;
 *   - the missed job is idempotent on rerun.
 *
 * Real Postgres and real contexts, no mocks. The fault injections are triggers
 * installed for one test each, the same way raiseInTransactionAtomicity.test.ts
 * does it: the database really refuses the insert.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { asSystem } from '../platform/context.js';
import {
  COMMITMENT_TRANSITIONS,
  cancelCommitment,
  confirmCommitment,
  getCommitment,
  listCommitments,
  markCommitmentMet,
  markCommitmentMissed,
  proposeCommitment,
  reassignCommitment,
  type CommitmentState,
} from '../domains/commitments.js';
import { runJobsForTenant } from '../jobs/scheduler.js';
import {
  asPrincipal,
  asUser,
  authFor,
  expectReject,
  principalFor,
  tenantId,
  unscopedPrisma,
  type TestPrincipal,
} from './helpers.js';

const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );

const CHAIRMAN = 'chairman@kaizen.co.in';
const DAY = 86_400_000;
const STATES: CommitmentState[] = ['proposed', 'confirmed', 'met', 'missed', 'cancelled'];
const COMMANDS = ['confirm', 'met', 'missed', 'cancel'] as const;
type Command = (typeof COMMANDS)[number];
const TARGET: Record<Command, CommitmentState> = {
  confirm: 'confirmed',
  met: 'met',
  missed: 'missed',
  cancel: 'cancelled',
};

let KAIZEN: string;

// Tenants and people created here are left in place. CommitmentEvent rows are
// append-only (the trigger refuses DELETE for every role), so the tenant that
// owns them cannot be removed either; eventChain.test.ts makes the same choice.

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
  const email = `cmt-${uniq()}@cmt.test`;
  const row = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-CMT-${uniq().toUpperCase()}`,
      fullName: 'Commitment party',
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  return row.id;
}

/** A tenant of its own, with a role that holds the commitments resource and one human in it. */
async function otherTenant(): Promise<TestPrincipal> {
  const slug = `cmt-other-${uniq()}`;
  const tenant = await unscopedPrisma.tenant.create({ data: { name: `Commitments ${slug}`, slug } });
  const role = await unscopedPrisma.accessRole.create({
    data: {
      tenantId: tenant.id,
      slug,
      name: `Commitments fixture ${slug}`,
      description: 'Created by commitments.test. Not a product role.',
      archetype: 'workspace',
      classificationCeiling: 'internal',
      isSystem: false,
    },
  });
  await unscopedPrisma.grant.create({
    data: {
      tenantId: tenant.id,
      principalType: 'role',
      roleId: role.id,
      resource: 'commitments',
      verbs: ['view', 'create', 'edit'],
      scope: 'all',
      scopeResolver: null,
    },
  });
  const email = `${slug}@cmt.test`;
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: tenant.id,
      recordCode: `PER-${slug.toUpperCase()}`,
      fullName: slug,
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  const affiliation = await unscopedPrisma.affiliation.create({
    data: {
      tenantId: tenant.id,
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
    data: { tenantId: tenant.id, personId: person.id, email, passwordHash: 'not-a-login', branch: 'Chennai' },
  });
  return {
    tenantId: tenant.id,
    partyId: person.id,
    userId: user.id,
    affiliationId: affiliation.id,
    roleSlug: slug,
    branch: 'Chennai',
  };
}

async function propose(
  overrides: { ownerPartyId?: string; backupPartyId?: string | null; dueAt?: Date; title?: string } = {},
) {
  const owner = overrides.ownerPartyId ?? (await personIn(KAIZEN));
  const backup = overrides.backupPartyId === undefined ? await personIn(KAIZEN) : overrides.backupPartyId;
  return asUser(CHAIRMAN, () =>
    proposeCommitment({
      title: overrides.title ?? `Commitment ${uniq()}`,
      ownerPartyId: owner,
      backupPartyId: backup,
      nextAction: 'Call the client',
      dueAt: overrides.dueAt ?? future(),
      sourceType: 'manual',
      subjectType: 'mou',
      subjectId: `subject-${uniq()}`,
    }),
  );
}

/** A commitment driven to `state` through the commands, not by writing the row. */
async function inState(state: CommitmentState, dueAt?: Date): Promise<string> {
  const row = await propose({ dueAt });
  if (state === 'proposed') return row.id;
  if (state === 'cancelled') {
    await asUser(CHAIRMAN, () => cancelCommitment(row.id, 'Withdrawn in the test'));
    return row.id;
  }
  await asUser(CHAIRMAN, () => confirmCommitment(row.id));
  if (state === 'met') await asUser(CHAIRMAN, () => markCommitmentMet(row.id));
  if (state === 'missed') await asUser(CHAIRMAN, () => markCommitmentMissed(row.id));
  return row.id;
}

async function stateOf(id: string): Promise<string> {
  return (await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id } })).state;
}

async function historyOf(id: string) {
  return unscopedPrisma.commitmentEvent.findMany({ where: { commitmentId: id }, orderBy: { at: 'asc' } });
}

async function auditOf(id: string, action = 'update') {
  return unscopedPrisma.auditRecord.findMany({ where: { subjectType: 'commitment', subjectId: id, action } });
}

async function eventsOf(id: string, eventName: string) {
  return unscopedPrisma.eventRecord.findMany({ where: { subjectEntityId: id, eventName } });
}

async function refuseCommitmentAudit(action: string): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION w6c_refuse_commitment_audit() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION 'injected commitment audit failure'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER w6c_refuse_commitment_audit BEFORE INSERT ON audit_records
     FOR EACH ROW WHEN (NEW."subjectType" = 'commitment' AND NEW."action" = '${action}')
     EXECUTE FUNCTION w6c_refuse_commitment_audit()`,
  );
}

async function refuseCommitmentEvent(eventName: string): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION w6c_refuse_commitment_event() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION 'injected commitment event failure'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER w6c_refuse_commitment_event BEFORE INSERT ON event_records
     FOR EACH ROW WHEN (NEW."eventName" = '${eventName}')
     EXECUTE FUNCTION w6c_refuse_commitment_event()`,
  );
}

async function restoreFaults(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w6c_refuse_commitment_audit ON audit_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w6c_refuse_commitment_audit()`);
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w6c_refuse_commitment_event ON event_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w6c_refuse_commitment_event()`);
}

afterEach(async () => {
  await restoreFaults();
});

beforeAll(async () => {
  KAIZEN = await tenantId();
});

describe('tenant isolation', () => {
  it("another tenant's principal gets 404 on every command, and the row is unchanged", async () => {
    const row = await propose();
    const intruder = await otherTenant();
    await asPrincipal(authFor(intruder), async () => {
      expect((await expectReject(() => getCommitment(row.id))).status).toBe(404);
      expect((await expectReject(() => confirmCommitment(row.id))).status).toBe(404);
      expect((await expectReject(() => markCommitmentMet(row.id))).status).toBe(404);
      expect((await expectReject(() => markCommitmentMissed(row.id))).status).toBe(404);
      expect((await expectReject(() => cancelCommitment(row.id, 'not mine'))).status).toBe(404);
      expect((await expectReject(() => reassignCommitment(row.id, intruder.partyId))).status).toBe(404);
    });
    expect(await stateOf(row.id)).toBe('proposed');
    expect(await historyOf(row.id)).toHaveLength(1);
  });

  it('the list shows only the caller tenant', async () => {
    const row = await propose();
    const intruder = await otherTenant();
    // Filtered by owner so the result does not depend on how many other rows the
    // shared tenant holds: the list is paged by due date.
    const mine = await asUser(CHAIRMAN, () => listCommitments({ ownerPartyId: row.ownerPartyId }));
    expect(mine.map((c) => c.id)).toEqual([row.id]);
    const theirs = await asPrincipal(authFor(intruder), () => listCommitments({ ownerPartyId: row.ownerPartyId }));
    expect(theirs).toEqual([]);
  });

  it('a proposal cannot name an owner or backup from another tenant', async () => {
    const outsider = await otherTenant();
    const before = await unscopedPrisma.commitment.count({ where: { tenantId: KAIZEN } });
    const local = await personIn(KAIZEN);
    await asUser(CHAIRMAN, async () => {
      await expectReject(() =>
        proposeCommitment({
          title: 'Cross-tenant owner',
          ownerPartyId: outsider.partyId,
          dueAt: future(),
          sourceType: 'manual',
          subjectType: 'mou',
          subjectId: 'x',
        }),
      );
      await expectReject(() =>
        proposeCommitment({
          title: 'Cross-tenant backup',
          ownerPartyId: local,
          backupPartyId: outsider.partyId,
          dueAt: future(),
          sourceType: 'manual',
          subjectType: 'mou',
          subjectId: 'x',
        }),
      );
    });
    expect(await unscopedPrisma.commitment.count({ where: { tenantId: KAIZEN } })).toBe(before);
  });

  it('the application role cannot see or change another tenant row, because row-level security refuses it', async () => {
    const row = await propose();
    const intruder = await otherTenant();
    const app = new PrismaClient({ datasourceUrl: APP_URL });
    try {
      const seen = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${intruder.tenantId}, true)`;
        return tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "commitments" WHERE "id" = ${row.id}`;
      });
      expect(Number(seen[0]!.n)).toBe(0);
      const changed = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${intruder.tenantId}, true)`;
        return tx.$executeRaw`UPDATE "commitments" SET "title" = 'taken over' WHERE "id" = ${row.id}`;
      });
      expect(changed).toBe(0);
    } finally {
      await app.$disconnect();
    }
    expect((await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: row.id } })).title).not.toBe('taken over');
  });

  it('the missed job touches only the tenant it runs for', async () => {
    const mine = await inState('confirmed', past());
    const intruder = await otherTenant();
    const theirs = await asPrincipal(authFor(intruder), () =>
      proposeCommitment({
        title: 'Theirs, overdue',
        ownerPartyId: intruder.partyId,
        dueAt: past(),
        sourceType: 'manual',
        subjectType: 'mou',
        subjectId: 'theirs',
      }),
    );
    await asPrincipal(authFor(intruder), () => confirmCommitment(theirs.id));

    await runJobsForTenant(KAIZEN, { jobNames: ['runCommitmentMissedJob'] });
    expect(await stateOf(mine)).toBe('missed');
    expect(await stateOf(theirs.id)).toBe('confirmed');

    await runJobsForTenant(intruder.tenantId, { jobNames: ['runCommitmentMissedJob'] });
    expect(await stateOf(theirs.id)).toBe('missed');
  });
});

describe('the backup is never the owner', () => {
  it('a proposal naming the same person as owner and backup is refused, and no row is written', async () => {
    const same = await personIn(KAIZEN);
    const title = `Same person ${uniq()}`;
    const err = await asUser(CHAIRMAN, () =>
      expectReject(() =>
        proposeCommitment({
          title,
          ownerPartyId: same,
          backupPartyId: same,
          dueAt: future(),
          sourceType: 'manual',
          subjectType: 'mou',
          subjectId: 'x',
        }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.commitment.count({ where: { title } })).toBe(0);
  });

  it('a reassignment to the current backup is refused and the owner stays put', async () => {
    const row = await propose();
    const before = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: row.id } });
    const err = await asUser(CHAIRMAN, () => expectReject(() => reassignCommitment(row.id, row.backupPartyId!)));
    expect(err.status).toBe(422);
    const after = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.ownerPartyId).toBe(before.ownerPartyId);
    expect(await historyOf(row.id)).toHaveLength(1);
  });

  it('the database refuses a row whose backup is its owner, whichever writer put it there', async () => {
    const p = await personIn(KAIZEN);
    await expect(
      unscopedPrisma.commitment.create({
        data: {
          tenantId: KAIZEN,
          recordCode: `CMT-RAW-${uniq().toUpperCase()}`,
          title: 'Raw same person',
          ownerPartyId: p,
          backupPartyId: p,
          dueAt: future(),
          state: 'proposed',
          sourceType: 'manual',
          subjectType: 'mou',
          subjectId: 'x',
        },
      }),
    ).rejects.toThrow(/check|violates/i);
  });
});

describe('the state table', () => {
  it('no transition leaves met or cancelled, and missed may only be met or cancelled', () => {
    expect(COMMITMENT_TRANSITIONS.met).toEqual([]);
    expect(COMMITMENT_TRANSITIONS.cancelled).toEqual([]);
    expect([...COMMITMENT_TRANSITIONS.missed].sort()).toEqual(['cancelled', 'met']);
  });

  it.each(STATES.flatMap((from) => COMMANDS.map((cmd) => [from, cmd] as const)))(
    'from %s, %s is %s',
    async (from, cmd) => {
      const id = await inState(from);
      const to = TARGET[cmd];
      const allowed = COMMITMENT_TRANSITIONS[from].includes(to);
      const run = () => {
        switch (cmd) {
          case 'confirm':
            return confirmCommitment(id);
          case 'met':
            return markCommitmentMet(id);
          case 'missed':
            return markCommitmentMissed(id);
          case 'cancel':
            return cancelCommitment(id, 'Table check');
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
    },
  );

  it('a closed commitment cannot be reassigned', async () => {
    for (const state of ['met', 'cancelled'] as const) {
      const id = await inState(state);
      const successor = await personIn(KAIZEN);
      const err = await asUser(CHAIRMAN, () => expectReject(() => reassignCommitment(id, successor)));
      expect(err.status).toBe(409);
    }
  });
});

describe('only a human confirms', () => {
  it('an agent proposal stays proposed, and an agent cannot confirm it', async () => {
    const human = await propose();
    const owner = await personIn(KAIZEN);
    const chairman = await principalFor(CHAIRMAN);
    const agent = authFor(chairman, {
      principalType: 'agent',
      partyId: null,
      userId: null,
      agentId: `agent-${uniq()}`,
    });
    const proposed = await asPrincipal(agent, () =>
      proposeCommitment({
        title: 'Model suggested',
        ownerPartyId: owner,
        dueAt: future(),
        sourceType: 'agent',
        subjectType: 'mou',
        subjectId: 'model',
      }),
    );
    expect(proposed.state).toBe('proposed');
    const err = await asPrincipal(agent, () => expectReject(() => confirmCommitment(proposed.id)));
    expect(err.status).toBe(403);
    expect(await stateOf(proposed.id)).toBe('proposed');
    expect(await eventsOf(proposed.id, 'kz.gov.commitment.confirmed')).toHaveLength(0);
    expect(human.state).toBe('proposed');
  });

  it('a system principal cannot confirm either', async () => {
    const row = await propose();
    const err = await asSystem(KAIZEN, () => expectReject(() => confirmCommitment(row.id)));
    expect(err.status).toBe(403);
    expect(await stateOf(row.id)).toBe('proposed');
  });
});

describe('a state change commits with its CommitmentEvent, its audit row and its event', () => {
  it('when the audit row cannot be written, the confirmation does not happen', async () => {
    const row = await propose();
    await refuseCommitmentAudit('update');
    const err = await asUser(CHAIRMAN, () => expectReject(() => confirmCommitment(row.id)));
    await restoreFaults();
    expect(err.message).toMatch(/injected commitment audit failure/);
    expect(await stateOf(row.id)).toBe('proposed');
    expect((await historyOf(row.id)).map((e) => e.toState)).toEqual(['proposed']);
    expect(await eventsOf(row.id, 'kz.gov.commitment.confirmed')).toHaveLength(0);
  });

  it('when the event cannot be written, the met transition and its audit row are both rolled back', async () => {
    const id = await inState('confirmed');
    const auditBefore = (await auditOf(id)).length;
    await refuseCommitmentEvent('kz.gov.commitment.met');
    const err = await asUser(CHAIRMAN, () => expectReject(() => markCommitmentMet(id)));
    await restoreFaults();
    expect(err.message).toMatch(/injected commitment event failure|event chain/);
    expect(await stateOf(id)).toBe('confirmed');
    expect((await historyOf(id)).map((e) => e.toState)).toEqual(['proposed', 'confirmed']);
    expect(await auditOf(id)).toHaveLength(auditBefore);
  });

  it('a clean confirmation writes one CommitmentEvent, one audit row and one event, all with the same subject', async () => {
    const row = await propose();
    await asUser(CHAIRMAN, () => confirmCommitment(row.id));
    const history = (await historyOf(row.id)).filter((e) => e.toState === 'confirmed');
    expect(history).toHaveLength(1);
    expect(history[0]!.fromState).toBe('proposed');
    expect(await auditOf(row.id)).toHaveLength(1);
    expect(await eventsOf(row.id, 'kz.gov.commitment.confirmed')).toHaveLength(1);
  });
});

describe('CommitmentEvent is append-only', () => {
  it('an UPDATE of a history row is refused for every role', async () => {
    const row = await propose();
    await expect(
      unscopedPrisma.$executeRaw`UPDATE "commitment_events" SET "reason" = 'rewritten' WHERE "commitmentId" = ${row.id}`,
    ).rejects.toThrow(/immutable/i);
  });

  it('a DELETE of a history row is refused for every role', async () => {
    const row = await propose();
    await expect(
      unscopedPrisma.$executeRaw`DELETE FROM "commitment_events" WHERE "commitmentId" = ${row.id}`,
    ).rejects.toThrow(/immutable/i);
    expect(await historyOf(row.id)).toHaveLength(1);
  });
});

describe('the missed job', () => {
  it('marks confirmed commitments past their due instant, and leaves everything else where it is', async () => {
    const overdue = await inState('confirmed', past());
    const notYet = await inState('confirmed', future());
    const unconfirmed = await inState('proposed', past());
    const met = await inState('met', past());
    const cancelled = await inState('cancelled', past());

    const result = await asSystem(KAIZEN, () =>
      runJobsForTenant(KAIZEN, { jobNames: ['runCommitmentMissedJob'] }),
    );
    expect(result.runCommitmentMissedJob!.errors).toEqual([]);

    expect(await stateOf(overdue)).toBe('missed');
    expect(await stateOf(notYet)).toBe('confirmed');
    expect(await stateOf(unconfirmed)).toBe('proposed');
    expect(await stateOf(met)).toBe('met');
    expect(await stateOf(cancelled)).toBe('cancelled');

    const history = await historyOf(overdue);
    expect(history.at(-1)!.toState).toBe('missed');
    expect(history.at(-1)!.actorPartyId).toBeNull();
    expect(await auditOf(overdue)).toHaveLength(2);
    expect(await eventsOf(overdue, 'kz.gov.commitment.missed')).toHaveLength(1);
  });

  it('a rerun over the same data changes nothing: no new history, audit or event rows', async () => {
    const overdue = await inState('confirmed', past());
    await asSystem(KAIZEN, () => runJobsForTenant(KAIZEN, { jobNames: ['runCommitmentMissedJob'] }));
    const historyBefore = (await historyOf(overdue)).length;
    const auditBefore = (await auditOf(overdue)).length;

    const rerun = await asSystem(KAIZEN, () =>
      runJobsForTenant(KAIZEN, { jobNames: ['runCommitmentMissedJob'] }),
    );

    expect(rerun.runCommitmentMissedJob!.notified).toBe(0);
    expect(await stateOf(overdue)).toBe('missed');
    expect(await historyOf(overdue)).toHaveLength(historyBefore);
    expect(await auditOf(overdue)).toHaveLength(auditBefore);
    expect(await eventsOf(overdue, 'kz.gov.commitment.missed')).toHaveLength(1);
  });
});
