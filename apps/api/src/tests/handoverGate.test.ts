/**
 * The handover gate (Wave 6, SPINE-CONTRACT 1.7; OPUS decision 14).
 *
 * The exit that ends a person's access is the offboarding settlement,
 * FFSettlementCompleted: the `offboarding.completed` hook there ends their
 * affiliations (privacy.ts:1353). That transition is refused with a 409 while the
 * leaver still owns an open Commitment, Case or Lead, or holds an asset in custody,
 * unless each such row is given a successor, or an approver records a waiver with a
 * reason. Real Postgres and the real decision paths; no mocks.
 *
 * Fixtures open the leaver's rows while they are still active. Nothing can be
 * assigned to someone in notice (ownership.ts), so a row that exists at the exit
 * was opened before the resignation, as it would be in practice.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asUser,
  prisma,
  sessionToken,
  tenantId,
  unscopedPrisma,
  withFixtureRole,
  type TestPrincipal,
} from './helpers.js';
import { hire, transitionEmployment, transitionOffboarding } from '../domains/employment.js';
import { proposeCommitment } from '../domains/commitments.js';
import { openCase } from '../domains/cases.js';
import { createLead, reassignLead } from '../domains/leads.js';
import { assignAsset, createAsset } from '../domains/hcm/assets.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { Prisma, type DbTx } from '../platform/db.js';
import { createApp } from '../server.js';

const HR = 'hr@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';
const REASON = 'Leaver unreachable during handover; operations will re-route the rows in week two.';
const DAY = 86_400_000;

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

function must(value: string | undefined): string {
  if (!value) throw new Error('The fixture did not open the row the test needs.');
  return value;
}

function stamp(): string {
  seq += 1;
  return `${Date.now()}-${seq}-${Math.floor(Math.random() * 1e6)}`;
}

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

type OpenKind = 'commitment' | 'case' | 'lead' | 'custody';

interface OpenRows {
  commitmentId?: string;
  caseId?: string;
  leadId?: string;
  assignmentId?: string;
  assetId?: string;
}

interface Leaver {
  personId: string;
  employmentId: string;
  offboardingId: string;
  rows: OpenRows;
}

/** A leaver at FFSettlementPending, holding the named open rows. The rows are opened before the resignation. */
async function leaver(label: string, open: OpenKind[] = []): Promise<Leaver> {
  const hired = await hiredAndActive(label);
  const rows: OpenRows = {};
  if (open.includes('commitment')) rows.commitmentId = await ownCommitment(hired.personId, hired.employmentId);
  if (open.includes('case')) rows.caseId = await ownCase(hired.personId);
  if (open.includes('lead')) rows.leadId = await ownLead(hired.personId);
  if (open.includes('custody')) Object.assign(rows, await custodyOf(hired.employmentId));
  const offboardingId = await settledButNotExited(hired.employmentId);
  return { ...hired, offboardingId, rows };
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

/** An asset issued to the employment. Returns the open assignment, which is the custody row the gate names. */
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

/**
 * Whether an audit row for the subject recorded `field` changing to a value that `matches`.
 * An `update` row stores each changed field as `{ from, to }`; a `create` row stores the
 * whole new row as its diff, where a field is a plain value, so it is not a change.
 */
async function auditChanged(
  subjectType: string,
  subjectId: string,
  field: string,
  matches: (to: unknown) => boolean,
): Promise<boolean> {
  const rows = await auditRowsFor(subjectType, subjectId);
  return rows.some((row) => {
    const diff = row.diff as unknown as Record<string, unknown> | null;
    const change = diff?.[field];
    return typeof change === 'object' && change !== null && 'to' in change && matches((change as { to: unknown }).to);
  });
}

describe('the handover gate refuses an exit while the leaver still owns open rows', () => {
  it('a commitment the leaver owns blocks the exit with a 409 that names it', async () => {
    const l = await leaver('gate-commitment', ['commitment']);
    const commitmentId = must(l.rows.commitmentId);
    const commitment = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: commitmentId } });

    const err = await rejectionOf(() => exit(l.offboardingId));

    expect(err.status).toBe(409);
    expect(blockersOf(err)).toEqual([{ kind: 'commitment', id: commitmentId, recordCode: commitment.recordCode }]);
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
  });

  it('an open case the leaver owns blocks the exit with a 409 that names it', async () => {
    const l = await leaver('gate-case', ['case']);
    const caseId = must(l.rows.caseId);
    const kase = await unscopedPrisma.case.findUniqueOrThrow({ where: { id: caseId } });

    const err = await rejectionOf(() => exit(l.offboardingId));

    expect(err.status).toBe(409);
    expect(blockersOf(err)).toEqual([{ kind: 'case', id: caseId, recordCode: kase.recordCode }]);
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
  });

  it('an asset in the leaver custody blocks the exit with a 409 that names the open assignment', async () => {
    const l = await leaver('gate-custody', ['custody']);
    const assignmentId = must(l.rows.assignmentId);
    const asset = await unscopedPrisma.asset.findUniqueOrThrow({ where: { id: must(l.rows.assetId) } });

    const err = await rejectionOf(() => exit(l.offboardingId));

    expect(err.status).toBe(409);
    expect(blockersOf(err)).toEqual([{ kind: 'asset_custody', id: assignmentId, recordCode: asset.recordCode }]);
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
  });

  it('a lead the leaver owns blocks the exit with a 409 that names it', async () => {
    const l = await leaver('gate-lead', ['lead']);
    const leadId = must(l.rows.leadId);
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
    const successorA = await hiredAndActive('successor-a');
    const successorB = await hiredAndActive('successor-b');
    const l = await leaver('handover-moves', ['commitment', 'case', 'lead', 'custody']);
    const commitmentId = must(l.rows.commitmentId);
    const caseId = must(l.rows.caseId);
    const leadId = must(l.rows.leadId);
    const assignmentId = must(l.rows.assignmentId);
    const assetId = must(l.rows.assetId);

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

    const to = (partyId: string) => (value: unknown) => value === partyId;
    expect(await auditChanged('commitment', commitmentId, 'ownerPartyId', to(successorA.personId))).toBe(true);
    expect(await auditChanged('case', caseId, 'ownerPartyId', to(successorB.personId))).toBe(true);
    expect(await auditChanged('lead', leadId, 'ownerPartyId', to(successorA.personId))).toBe(true);
    expect(await auditChanged('asset_assignment', assignmentId, 'returnedOn', (v) => typeof v === 'string')).toBe(true);
  });
});

describe('a successor must be an active person in this tenant', () => {
  it('the leaver, a person already leaving, and a merged duplicate are each refused with a 422, and nothing moves', async () => {
    const l = await leaver('bad-successor', ['commitment']);
    const commitmentId = must(l.rows.commitmentId);
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
    const l = await leaver('override-403', ['commitment']);
    const commitmentId = must(l.rows.commitmentId);

    const err = await rejectionOf(() => exit(l.offboardingId, { override: { reason: REASON } }, HR));

    expect(err.status).toBe(403);
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
    const commitment = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: commitmentId } });
    expect(commitment.ownerPartyId).toBe(l.personId);
  });

  it('a reason under 20 non-whitespace characters is a 422, and nothing moves', async () => {
    const l = await leaver('override-422', ['commitment']);

    const err = await rejectionOf(() => exit(l.offboardingId, { override: { reason: '  too   short  ' } }));

    expect(err.status).toBe(422);
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
  });

  it('a valid override exits, leaves the rows with the leaver, and writes an audit row with the reason and the rows', async () => {
    const l = await leaver('override-valid', ['commitment']);
    const commitmentId = must(l.rows.commitmentId);
    const commitment = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: commitmentId } });

    const exited = await exit(l.offboardingId, { override: { reason: REASON } });

    expect(exited.status).toBe('FFSettlementCompleted');
    const still = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: commitmentId } });
    expect(still.ownerPartyId).toBe(l.personId);

    // The waiver stands through the archive: ARCHIVE follows the settlement, and does not re-run the gate.
    const archived = await asUser(CHAIRMAN, () => transitionOffboarding(l.offboardingId, 'ARCHIVE'));
    expect(archived.status).toBe('ClosedArchived');

    const audit = (await auditRowsFor('offboarding', l.offboardingId)).find(
      (row) => (row.meta as unknown as { handoverOverride?: unknown } | null)?.handoverOverride !== undefined,
    );
    expect(audit).toBeDefined();
    const override = (audit!.meta as unknown as { handoverOverride: { reason: string; rowsLeftOpen: Blocker[] } })
      .handoverOverride;
    expect(override.reason).toBe(REASON);
    expect(override.rowsLeftOpen).toEqual([
      { kind: 'commitment', id: commitmentId, recordCode: commitment.recordCode },
    ]);

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

    const busy = await leaver('tenant-busy', ['commitment']);
    const ownCommitmentId = must(busy.rows.commitmentId);
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

// ---------------------------------------------------------------------------
// What the 409 shows, and the lock that keeps a late assignment out of the gate.
// ---------------------------------------------------------------------------

/** The grants a caller needs to settle an exit, and to view each kind the gate can name, except leads when withLeads is false. */
function viewerGrants(withLeads: boolean) {
  return [
    { resource: 'employees', verbs: ['edit'] },
    { resource: 'commitments', verbs: ['view'] },
    { resource: 'cases', verbs: ['view'] },
    { resource: 'asset_assignments', verbs: ['view'] },
    ...(withLeads ? [{ resource: 'leads', verbs: ['view'] }] : []),
  ];
}

describe('the 409 shows the caller only the blockers they may view', () => {
  let server: Server;
  let base: string;

  beforeAll(() => {
    server = createApp().listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}/api`;
  });

  afterAll(() => {
    server?.close();
  });

  /** The exit over HTTP, through the route a client calls. The caller's own token, not a service call. */
  async function exitOverHttp(offboardingId: string, caller: TestPrincipal) {
    const token = await sessionToken({
      userId: caller.userId,
      tenantId: caller.tenantId,
      affiliationId: caller.affiliationId,
      stepUp: true,
    });
    const res = await fetch(`${base}/hr/offboardings/${offboardingId}/transition`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'DISBURSE', note: 'Final settlement paid.' }),
    });
    return { status: res.status, body: (await res.json()) as { error?: { details?: { blockers?: unknown[] } } } };
  }

  it('a caller without leads:view is shown the lead as a count, with no id or code, and the exit is still refused', async () => {
    const l = await leaver('http-withheld', ['commitment', 'lead']);
    const commitment = await unscopedPrisma.commitment.findUniqueOrThrow({ where: { id: must(l.rows.commitmentId) } });
    const lead = await unscopedPrisma.lead.findUniqueOrThrow({ where: { id: must(l.rows.leadId) } });

    await withFixtureRole({ slug: 'w6_no_lead_view', grants: viewerGrants(false) }, async (caller) => {
      const res = await exitOverHttp(l.offboardingId, caller);

      expect(res.status).toBe(409);
      expect(res.body.error?.details?.blockers).toEqual([
        { kind: 'commitment', id: commitment.id, recordCode: commitment.recordCode },
        { kind: 'lead', count: 1, withheld: true },
      ]);
      const wire = JSON.stringify(res.body);
      expect(wire).not.toContain(lead.id);
      if (lead.recordCode) expect(wire).not.toContain(lead.recordCode);
    });
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
  });

  it('a caller with leads:view is shown the lead by id and code', async () => {
    const l = await leaver('http-visible', ['lead']);
    const lead = await unscopedPrisma.lead.findUniqueOrThrow({ where: { id: must(l.rows.leadId) } });

    await withFixtureRole({ slug: 'w6_lead_view', grants: viewerGrants(true) }, async (caller) => {
      const res = await exitOverHttp(l.offboardingId, caller);

      expect(res.status).toBe(409);
      expect(res.body.error?.details?.blockers).toEqual([{ kind: 'lead', id: lead.id, recordCode: lead.recordCode }]);
    });
    expect(await offboardingStatus(l.offboardingId)).toBe('FFSettlementPending');
  });
});

/** The outcome of a call that may reject: the value, or the rejection with its status and details. */
type Outcome<T> = { ok: true; value: T } | { ok: false; err: Rejection };

function settle<T>(p: Promise<T>): Promise<Outcome<T>> {
  return p.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (err: Rejection): Outcome<T> => ({ ok: false, err }),
  );
}

function rejectedWith<T>(o: Outcome<T>): Rejection {
  if (o.ok) throw new Error('Expected the call to be refused, but it succeeded.');
  return o.err;
}

/**
 * Backends in this database that are waiting on a lock. A transaction parked behind another
 * shows here. The database is read through pg_stat_activity: a transactionid wait has no
 * database of its own in pg_locks, and the other suites share the server.
 */
async function lockWaiters(): Promise<number> {
  const rows = await unscopedPrisma.$queryRaw<{ n: number }[]>(
    Prisma.sql`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database()`,
  );
  return rows[0].n;
}

async function until(cond: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('a commitment assigned while the leaver is still active cannot outlive the exit', () => {
  it('the exit waits for the assignment, which the gate then sees; the settlement and the new open commitment never both land', async () => {
    // A leaver with no rows yet, and an employment still Active: the assignment's check passes.
    const fx = await hiredAndActive('race-assign');

    let releaseHolder!: () => void;
    const released = new Promise<void>((resolve) => (releaseHolder = resolve));
    let signalHeld!: () => void;
    const heldNow = new Promise<void>((resolve) => (signalHeld = resolve));
    // Connection H takes the commitment sequence row. The assignment takes the same row after
    // its check and before its insert, so it parks there holding its FOR SHARE on the leaver.
    const holder = unscopedPrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${TENANT}, true)`;
        await asUser(CHAIRMAN, () => nextRecordCode('CMT', new Date(), tx as unknown as DbTx));
        signalHeld();
        await released;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    try {
      // Without this the assignment can run to completion before H holds the row, and nothing parks.
      await Promise.race([heldNow, holder]);

      const assigned = settle(
        asUser(CHAIRMAN, () =>
          proposeCommitment({
            title: 'Assigned while the leaver is still active',
            ownerPartyId: fx.personId,
            dueAt: new Date(Date.now() + 14 * DAY),
            sourceType: 'manual',
            subjectType: 'employment_relationship',
            subjectId: fx.employmentId,
          }),
        ),
      );
      // Parked on the sequence row, not finished: if it settled first, the test has not set up the race.
      await Promise.race([
        until(async () => (await lockWaiters()) >= 1, 'the assignment to park on the sequence row'),
        assigned.then((o) => {
          throw new Error(`The assignment settled before reaching the sequence row: ${o.ok ? 'ok' : o.err.message}`);
        }),
      ]);

      // The leaver resigns and is cleared while the assignment is parked.
      const offboardingId = await settledButNotExited(fx.employmentId);

      // The exit starts while the assignment holds its FOR SHARE. It must wait for it, or the
      // gate would run before the assignment's row exists and settle the leaver anyway.
      let exitSettled = false;
      const exitP = settle(exit(offboardingId)).then((o) => {
        exitSettled = true;
        return o;
      });
      await until(async () => exitSettled || (await lockWaiters()) >= 2, 'the exit to wait or settle');

      releaseHolder();
      const [assignedOutcome, exitOutcome] = await Promise.all([assigned, exitP]);

      expect(
        assignedOutcome.ok && exitOutcome.ok,
        'the settlement completed while the leaver owned the new open commitment',
      ).toBe(false);

      if (assignedOutcome.ok) {
        const err = rejectedWith(exitOutcome);
        expect(err.status).toBe(409);
        expect(blockersOf(err)).toEqual([
          {
            kind: 'commitment',
            id: assignedOutcome.value.id,
            recordCode: assignedOutcome.value.recordCode,
          },
        ]);
        expect(await offboardingStatus(offboardingId)).toBe('FFSettlementPending');
      } else {
        expect(exitOutcome.ok).toBe(true);
        expect(rejectedWith(assignedOutcome).status).toBe(422);
        expect(await offboardingStatus(offboardingId)).toBe('FFSettlementCompleted');
      }
    } finally {
      releaseHolder();
      await holder;
    }
  });
});
