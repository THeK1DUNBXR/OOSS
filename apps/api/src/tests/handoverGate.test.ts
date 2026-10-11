/**
 * The handover gate (Wave 6, SPINE-CONTRACT 1.7; OPUS decision 14).
 *
 * The exit that ends a person's access is the offboarding transition to
 * FFSettlementCompleted or ClosedArchived: the `offboarding.completed` hook there
 * ends their affiliations (privacy.ts:1353). Those transitions are refused with a
 * 409 while the leaver still owns an open Commitment, Case or Lead, or holds an
 * asset in custody, unless each such row is given a successor, or an approver
 * records a waiver with a reason. Real Postgres and the real decision paths; no
 * mocks.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, prisma, tenantId, unscopedPrisma, withFixtureRole } from './helpers.js';
import { hire, transitionEmployment, transitionOffboarding } from '../domains/employment.js';
import { proposeCommitment } from '../domains/commitments.js';
import { openCase } from '../domains/cases.js';
import { createLead, reassignLead } from '../domains/leads.js';
import { assignAsset, createAsset } from '../domains/hcm/assets.js';
import { nextRecordCode } from '../platform/recordCode.js';

const HR = 'hr@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';
const REASON = 'Leaver unreachable during handover; operations will re-route the rows in week two.';

let TENANT: string;
let seq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

interface Rejection {
  status?: number;
  code?: string;
  message: string;
  details?: unknown;
}

/** The whole rejection, details included. The shared `expectReject` drops `details`, and the gate's blocker list lives there. */
async function rejectionOf(fn: () => Promise<unknown>): Promise<Rejection> {
  try {
    await fn();
  } catch (err) {
    return err as Rejection;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

interface Blocker {
  kind: string;
  id: string;
  recordCode: string | null;
}

function blockersOf(err: Rejection): Blocker[] {
  return ((err.details as { blockers?: Blocker[] } | undefined)?.blockers ?? []) as Blocker[];
}

function stamp(): string {
  seq += 1;
  return `${Date.now()}-${seq}-${Math.floor(Math.random() * 1e6)}`;
}

const DAY = 86_400_000;

/** A person hired and activated by HR. Their employment is the one a resignation will be filed against. */
async function hiredAndActive(label: string): Promise<{ personId: string; employmentId: string }> {
  const s = stamp();
  return asUser(HR, async () => {
    const position = await prisma.position.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('POS'),
        jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        status: 'Open',
      },
    });
    const person = await prisma.person.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('PER'),
        fullName: `Handover ${label} ${s}`,
        primaryEmail: `handover.${label}.${s}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { personId: person.id, employmentId: employment.id };
  });
}

/** Files a resignation for the employment and drives the offboarding to FFSettlementPending, one step short of the exit. */
async function settledButNotExited(employmentId: string): Promise<string> {
  await asUser(HR, () => transitionEmployment(employmentId, 'SUBMIT_RESIGNATION', { note: 'Resigned (test)' }));
  const offboarding = await unscopedPrisma.offboarding.findUniqueOrThrow({
    where: { employmentRelationshipId: employmentId },
  });
  await asUser(HR, async () => {
    await transitionOffboarding(offboarding.id, 'REACH_LWD');
    await transitionOffboarding(offboarding.id, 'BEGIN_CLEARANCE');
    await transitionOffboarding(offboarding.id, 'CLEARANCE_COMPLETE');
  });
  return offboarding.id;
}

/** A leaver ready for the exit: active, resigned, at FFSettlementPending. */
async function leaver(label: string): Promise<{ personId: string; employmentId: string; offboardingId: string }> {
  const hired = await hiredAndActive(label);
  const offboardingId = await settledButNotExited(hired.employmentId);
  return { ...hired, offboardingId };
}

/** The exit itself: the offboarding transition that fires the access-revocation hook. */
function exit(offboardingId: string, options?: Record<string, unknown>, actor = CHAIRMAN) {
  return asUser(actor, () =>
    transitionOffboarding(offboardingId, 'DISBURSE', 'Final settlement paid.', options as never),
  );
}

async function offboardingStatus(offboardingId: string): Promise<string> {
  return (await unscopedPrisma.offboarding.findUniqueOrThrow({ where: { id: offboardingId } })).status;
}

async function ownCommitment(ownerPartyId: string, employmentId: string): Promise<string> {
  const row = await asUser(CHAIRMAN, () =>
    proposeCommitment({
      title: 'Hand over the quarterly close pack',
      ownerPartyId,
      dueAt: new Date(Date.now() + 14 * DAY),
      sourceType: 'manual',
      subjectType: 'employment_relationship',
      subjectId: employmentId,
    }),
  );
  return row.id;
}

async function ownCase(ownerPartyId: string): Promise<string> {
  const row = await asUser(CHAIRMAN, () =>
    openCase({
      kind: 'customer',
      title: 'Invoice dispute to hand over',
      ownerPartyId,
      responseDueAt: new Date(Date.now() + 3 * DAY),
      visibilityTier: 'internal',
      severity: 'S1_ATTENTION',
    }),
  );
  return row.id;
}

async function ownLead(ownerPartyId: string): Promise<string> {
  const s = stamp();
  const lead = await asUser(CHAIRMAN, () =>
    createLead({
      title: `Handover lead ${s}`,
      person: { fullName: `Handover contact ${s}`, primaryEmail: `handover.contact.${s}@example.com` },
      vertical: 'cybersecurity',
      source: 'manual',
    }),
  );
  await asUser(CHAIRMAN, () => reassignLead(lead.id, ownerPartyId, 'Test: owned by the leaver.'));
  return lead.id;
}

/** An asset issued to the employment. Returns the open assignment's id, which is the custody row the gate names. */
async function custodyOf(employmentId: string): Promise<{ assignmentId: string; assetId: string }> {
  const asset = await asUser(CHAIRMAN, () => createAsset({ tag: `HO-${stamp()}`, category: 'laptop' }));
  const assignment = await asUser(CHAIRMAN, () =>
    assignAsset({ assetId: asset.id, employmentRelationshipId: employmentId }),
  );
  return { assignmentId: assignment.id, assetId: asset.id };
}

async function auditRowsFor(subjectType: string, subjectId: string) {
  return unscopedPrisma.auditRecord.findMany({ where: { tenantId: TENANT, subjectType, subjectId } });
}

describe('the handover gate refuses an exit while the leaver still owns open rows', () => {
  it('a commitment the leaver owns blocks the exit with a 409 that names it', async () => {
    const l = await leaver('gate-commitment');
    const commitmentId = await ownCommitment(l.personId, l.employmentId);
    const commitment = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: commitmentId } });

    const err = await rejectionOf(() => exit(l.offboardingId));

    expect(err.status).toBe(409);
    expect(blockersOf(err)).toEqual([{ kind: 'commitment', id: commitmentId, recordCode: commitment.recordCode }]);
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
  });

  it('an open case the leaver owns blocks the exit with a 409 that names it', async () => {
    const l = await leaver('gate-case');
    const caseId = await ownCase(l.personId);
    const kase = await unscopedPrisma.case.findUniqueOrThrow({ where: { id: caseId } });

    const err = await rejectionOf(() => exit(l.offboardingId));

    expect(err.status).toBe(409);
    expect(blockersOf(err)).toEqual([{ kind: 'case', id: caseId, recordCode: kase.recordCode }]);
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
  });

  it('an asset in the leaver custody blocks the exit with a 409 that names the open assignment', async () => {
    const l = await leaver('gate-custody');
    const { assignmentId, assetId } = await custodyOf(l.employmentId);
    const asset = await unscopedPrisma.asset.findUniqueOrThrow({ where: { id: assetId } });

    const err = await rejectionOf(() => exit(l.offboardingId));

    expect(err.status).toBe(409);
    expect(blockersOf(err)).toEqual([{ kind: 'asset_custody', id: assignmentId, recordCode: asset.recordCode }]);
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
  });

  it('a lead the leaver owns blocks the exit with a 409 that names it', async () => {
    const l = await leaver('gate-lead');
    const leadId = await ownLead(l.personId);
    const lead = await unscopedPrisma.lead.findUniqueOrThrow({ where: { id: leadId } });

    const err = await rejectionOf(() => exit(l.offboardingId));

    expect(err.status).toBe(409);
    expect(blockersOf(err)).toEqual([{ kind: 'lead', id: leadId, recordCode: lead.recordCode }]);
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
  });

  it('a person with no open rows exits as before, and the access revocation runs', async () => {
    const l = await leaver('gate-none');

    const exited = await exit(l.offboardingId);

    expect(exited.status).toBe('FFSettlementCompleted');
    const affiliations = await unscopedPrisma.affiliation.findMany({
      where: { tenantId: TENANT, partyId: l.personId, affiliationType: 'employee' },
    });
    expect(affiliations.length).toBeGreaterThan(0);
    for (const aff of affiliations) expect(aff.status).toBe('ended');
  });
});

describe('a successor takes each open row, and the move is governed', () => {
  it('one successor for every row, plus a per-row successor, moves every row and audits each move', async () => {
    const l = await leaver('handover-moves');
    const successorA = await hiredAndActive('successor-a');
    const successorB = await hiredAndActive('successor-b');
    const commitmentId = await ownCommitment(l.personId, l.employmentId);
    const caseId = await ownCase(l.personId);
    const leadId = await ownLead(l.personId);
    const { assignmentId, assetId } = await custodyOf(l.employmentId);

    const exited = await exit(l.offboardingId, {
      handover: {
        successorPartyId: successorA.personId,
        rows: [{ kind: 'case', id: caseId, successorPartyId: successorB.personId }],
      },
    });

    expect(exited.status).toBe('FFSettlementCompleted');

    const commitment = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: commitmentId } });
    expect(commitment.ownerPartyId).toBe(successorA.personId);
    const kase = await unscopedPrisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(kase.ownerPartyId).toBe(successorB.personId);
    const lead = await unscopedPrisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.ownerPartyId).toBe(successorA.personId);

    const closed = await unscopedPrisma.assetAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(closed.returnedOn).not.toBeNull();
    const reissued = await unscopedPrisma.assetAssignment.findFirstOrThrow({
      where: { tenantId: TENANT, assetId, returnedOn: null },
    });
    expect(reissued.employmentRelationshipId).toBe(successorA.employmentId);
    expect((await unscopedPrisma.asset.findUniqueOrThrow({ where: { id: assetId } })).status).toBe('assigned');

    const ownerAudited = async (subjectType: string, subjectId: string, partyId: string) =>
      (await auditRowsFor(subjectType, subjectId)).some(
        (row) => (row.after as { ownerPartyId?: string } | null)?.ownerPartyId === partyId,
      );
    expect(await ownerAudited('commitment', commitmentId, successorA.personId)).toBe(true);
    expect(await ownerAudited('case', caseId, successorB.personId)).toBe(true);
    expect(await ownerAudited('lead', leadId, successorA.personId)).toBe(true);
    expect(
      (await auditRowsFor('asset_assignment', assignmentId)).some(
        (row) => (row.after as { returnedOn?: unknown } | null)?.returnedOn != null,
      ),
    ).toBe(true);
  });
});

describe('a successor must be an active person in this tenant', () => {
  it('the leaver, a person already leaving, and a merged duplicate are each refused with a 422, and nothing moves', async () => {
    const l = await leaver('bad-successor');
    const commitmentId = await ownCommitment(l.personId, l.employmentId);
    const leaving = await leaver('already-leaving');
    const s = stamp();
    const merged = await unscopedPrisma.person.create({
      data: {
        tenantId: TENANT,
        recordCode: `PER-MERGED-${s}`,
        fullName: `Merged duplicate ${s}`,
        primaryEmail: `merged.${s}@example.com`,
        primaryEmailNormalised: `merged.${s}@example.com`,
        source: 'test',
        dedupeStatus: 'merged',
      },
    });

    for (const successorPartyId of [l.personId, leaving.personId, merged.id]) {
      const err = await rejectionOf(() => exit(l.offboardingId, { handover: { successorPartyId } }));
      expect(err.status).toBe(422);
    }

    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
    const commitment = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: commitmentId } });
    expect(commitment.ownerPartyId).toBe(l.personId);
  });
});

describe('an override is a separately permissioned, reasoned waiver', () => {
  it('without the approve permission the override is a 403, and nothing moves', async () => {
    const l = await leaver('override-403');
    const commitmentId = await ownCommitment(l.personId, l.employmentId);

    const err = await rejectionOf(() => exit(l.offboardingId, { override: { reason: REASON } }, HR));

    expect(err.status).toBe(403);
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
    const commitment = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: commitmentId } });
    expect(commitment.ownerPartyId).toBe(l.personId);
  });

  it('a reason under 20 non-whitespace characters is a 422, and nothing moves', async () => {
    const l = await leaver('override-422');
    await ownCommitment(l.personId, l.employmentId);

    const err = await rejectionOf(() => exit(l.offboardingId, { override: { reason: '  too   short  ' } }));

    expect(err.status).toBe(422);
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
  });

  it('a valid override exits, leaves the rows with the leaver, and writes an audit row with the reason and the rows', async () => {
    const l = await leaver('override-valid');
    const commitmentId = await ownCommitment(l.personId, l.employmentId);
    const commitment = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: commitmentId } });

    const exited = await exit(l.offboardingId, { override: { reason: REASON } });

    expect(exited.status).toBe('FFSettlementCompleted');
    const still = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: commitmentId } });
    expect(still.ownerPartyId).toBe(l.personId);

    const audit = (await auditRowsFor('offboarding', l.offboardingId)).find(
      (row) => (row.meta as { handoverOverride?: unknown } | null)?.handoverOverride !== undefined,
    );
    expect(audit).toBeDefined();
    const override = (audit!.meta as { handoverOverride: { reason: string; rowsLeftOpen: Blocker[] } }).handoverOverride;
    expect(override.reason).toBe(REASON);
    expect(override.rowsLeftOpen).toEqual([{ kind: 'commitment', id: commitmentId, recordCode: commitment.recordCode }]);

    const waived = await unscopedPrisma.eventRecord.count({
      where: {
        tenantId: TENANT,
        eventName: 'kz.hr.offboarding.handover_override_recorded',
        subjectEntityId: l.offboardingId,
      },
    });
    expect(waived).toBe(1);
  });

  it('the leaver cannot override their own exit, even holding the approve permission', async () => {
    await withFixtureRole(
      { slug: 'self_override', grants: [{ resource: 'employees', verbs: ['view', 'edit', 'approve'] }] },
      async (p) => {
        const hired = await hiredAndActiveFor(p.partyId);
        const offboardingId = await settledButNotExited(hired.employmentId);

        const err = await rejectionOf(() =>
          transitionOffboarding(offboardingId, 'DISBURSE', 'Final settlement paid.', {
            override: { reason: REASON },
          } as never),
        );

        expect(err.status).toBe(403);
        expect(await offboardingStatus(offboardingId)).toBe('FFSettlementPending');
      },
    );
  });
});

/** Hires an existing person, so a fixture principal can be the leaver. */
async function hiredAndActiveFor(personId: string): Promise<{ personId: string; employmentId: string }> {
  return asUser(HR, async () => {
    const position = await prisma.position.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('POS'),
        jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        status: 'Open',
      },
    });
    const employment = await hire({ personId, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { personId, employmentId: employment.id };
  });
}

describe('another tenant never blocks an exit and is never a successor', () => {
  it('open rows in another tenant do not block, and a person from another tenant cannot take a row', async () => {
    const s = stamp();
    const other = await unscopedPrisma.tenant.create({
      data: { name: `Handover other ${s}`, slug: `handover-other-${s}`, status: 'active' },
    });
    const otherPerson = await unscopedPrisma.person.create({
      data: {
        tenantId: other.id,
        recordCode: `PER-OTHER-${s}`,
        fullName: `Other tenant ${s}`,
        primaryEmail: `other.${s}@example.com`,
        primaryEmailNormalised: `other.${s}@example.com`,
        source: 'test',
      },
    });
    const otherCommitment = await unscopedPrisma.commitment.create({
      data: {
        tenantId: other.id,
        recordCode: `CMT-OTHER-${s}`,
        title: 'Another tenant commitment',
        ownerPartyId: otherPerson.id,
        dueAt: new Date(Date.now() + DAY),
        state: 'proposed',
        sourceType: 'manual',
        subjectType: 'employment_relationship',
        subjectId: 'none',
      },
    });

    const quiet = await leaver('tenant-quiet');
    const exited = await exit(quiet.offboardingId);
    expect(exited.status).toBe('FFSettlementCompleted');

    const busy = await leaver('tenant-busy');
    const ownCommitmentId = await ownCommitment(busy.personId, busy.employmentId);
    const err = await rejectionOf(() => exit(busy.offboardingId));
    expect(err.status).toBe(409);
    expect(blockersOf(err).map((b) => b.id)).toEqual([ownCommitmentId]);

    const crossing = await rejectionOf(() =>
      exit(busy.offboardingId, { handover: { successorPartyId: otherPerson.id } }),
    );
    expect(crossing.status).toBe(404);
    const untouched = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: otherCommitment.id } });
    expect(untouched.ownerPartyId).toBe(otherPerson.id);
    expect(await offboardingStatus(busy.offboardingId)).toBe('FFSettlementPending');
  });
});

describe('an exited person cannot be given new open rows', () => {
  it('a new commitment owned by someone who has exited is refused with a 422', async () => {
    const l = await leaver('exited-assignee');
    expect((await exit(l.offboardingId)).status).toBe('FFSettlementCompleted');

    const err = await rejectionOf(() =>
      asUser(CHAIRMAN, () =>
        proposeCommitment({
          title: 'Assigned after the exit',
          ownerPartyId: l.personId,
          dueAt: new Date(Date.now() + DAY),
          sourceType: 'manual',
          subjectType: 'employment_relationship',
          subjectId: l.employmentId,
        }),
      ),
    );

    expect(err.status).toBe(422);
  });
});
