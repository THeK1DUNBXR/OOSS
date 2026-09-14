/**
 * HCM — J. Separations & exit management (docs/hcm/separations.md).
 *
 * A resignation is the employee-initiated request; accepting it is what
 * actually rides the employment relationship into `NoticePeriod` (via
 * `transitionEmployment(..., 'SUBMIT_RESIGNATION')`, defined in
 * `domains/employment.ts` against the machine in `packages/shared/src/hr.ts`)
 * and opens the `Offboarding` row that machine creates alongside it. From
 * there this module owns exit clearance (five departments that each have to
 * sign off), the no-dues certificate issued once they have, notice policy
 * (what `noticeDays` should come from, rather than the flat default on
 * `EmploymentRelationship`), and the alumni record that survives once the
 * employment itself reaches `Alumni`.
 */

import {
  EVENTS,
  offboardingMachine,
  type OffboardingState,
  allClearancesComplete,
  blockedClearanceCount,
  CLEARANCE_DEPARTMENTS,
  canTransitionResignation,
  resolveNoticePolicy,
  noticeShortfallDays,
  RESIGNATION_REASON_CATEGORIES,
  type NoticePolicyFact,
  type ResignationReasonCategory,
  type ResignationState,
} from '@kaizen/shared';
import { prisma, unscopedPrisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { notify } from '../../platform/exceptions.js';
import { transitionEmployment, transitionOffboarding } from '../employment.js';

registerGovernedEntities('hcm_separations', [
  'resignation',
  'notice_policy',
  'exit_clearance',
  'no_dues_certificate',
  'alumni_record',
]);

/** The HR operations manager, resolved by role — the deterministic default reviewer when nobody more specific is named. */
async function hrOpsOwnerId(tenantId: string): Promise<string | null> {
  const affiliation = await unscopedPrisma.affiliation.findFirst({
    where: { tenantId, roleSlug: 'hr_ops_manager', status: 'active' },
    select: { partyId: true },
  });
  return affiliation?.partyId ?? null;
}

async function requireEmployment(employmentRelationshipId: string) {
  const auth = currentAuth();
  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: employmentRelationshipId, tenantId: auth.tenantId },
    include: { person: { select: { fullName: true } } },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');
  return employment;
}

// ---------------------------------------------------------------------------
// Notice policy
// ---------------------------------------------------------------------------

export async function listNoticePolicies() {
  const auth = currentAuth();
  await assertCan({ resource: 'notice_policies', verb: 'view' });
  return prisma.noticePolicy.findMany({ where: { tenantId: auth.tenantId }, orderBy: { createdAt: 'desc' } });
}

export async function createNoticePolicy(input: {
  name: string;
  grade?: string | null;
  engagementType?: string | null;
  noticeDays: number;
  buyoutAllowed?: boolean;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'notice_policies', verb: 'create' });
  if (input.noticeDays < 0) throw ApiError.badRequest('Notice days cannot be negative.');

  const row = await prisma.noticePolicy.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name,
      grade: input.grade ?? null,
      engagementType: input.engagementType ?? null,
      noticeDays: input.noticeDays,
      buyoutAllowed: input.buyoutAllowed ?? true,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'notice_policy', subjectId: row.id, after: row });
  return row;
}

export async function setNoticePolicyActive(id: string, active: boolean) {
  const auth = currentAuth();
  await assertCan({ resource: 'notice_policies', verb: 'edit' });
  const before = await prisma.noticePolicy.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw ApiError.notFound('Notice policy');
  const row = await prisma.noticePolicy.update({ where: { id }, data: { active } });
  await auditWrite({ action: 'update', subjectType: 'notice_policy', subjectId: id, before, after: row });
  return row;
}

/** What notice period applies to this employment right now — the policy table first, the employment's own flat default otherwise. */
export async function noticeDaysFor(employmentRelationshipId: string): Promise<{ noticeDays: number; buyoutAllowed: boolean; source: 'policy' | 'employment_default' }> {
  const employment = await requireEmployment(employmentRelationshipId);
  const auth = currentAuth();
  const policies = await prisma.noticePolicy.findMany({ where: { tenantId: auth.tenantId, active: true }, orderBy: { createdAt: 'desc' } });
  const facts: NoticePolicyFact[] = policies.map((p) => ({
    id: p.id,
    grade: p.grade,
    engagementType: p.engagementType,
    noticeDays: p.noticeDays,
    buyoutAllowed: p.buyoutAllowed,
    active: p.active,
  }));
  const resolved = resolveNoticePolicy(facts, null, employment.engagementType ?? null);
  if (resolved) return { noticeDays: resolved.noticeDays, buyoutAllowed: resolved.buyoutAllowed, source: 'policy' };
  return { noticeDays: employment.noticePeriodDays, buyoutAllowed: true, source: 'employment_default' };
}

// ---------------------------------------------------------------------------
// Resignation
// ---------------------------------------------------------------------------

export async function listResignations(filter: { status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'resignations', verb: 'view' });
  const scope = auth.roleSlug === 'employee' ? { employmentRelationship: { personId: auth.partyId } } : {};
  return prisma.resignation.findMany({
    where: { tenantId: auth.tenantId, ...(filter.status ? { status: filter.status } : {}), ...scope },
    include: { employmentRelationship: { include: { person: { select: { fullName: true, recordCode: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getResignation(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'resignations', verb: 'view' });
  const row = await prisma.resignation.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { employmentRelationship: { include: { person: { select: { fullName: true, recordCode: true } } } } },
  });
  if (!row) throw ApiError.notFound('Resignation');
  if (auth.roleSlug === 'employee' && row.employmentRelationship.personId !== auth.partyId) {
    throw ApiError.notFound('Resignation');
  }
  return row;
}

export async function submitResignation(input: {
  employmentRelationshipId: string;
  requestedLastDay: Date;
  reasonCategory: ResignationReasonCategory;
  reasonNote?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'resignations', verb: 'create' });

  const employment = await requireEmployment(input.employmentRelationshipId);
  // At `@own` scope an employee may only resign for themselves; at `all`
  // scope HR may file one on somebody's behalf (a resignation tendered in
  // person and recorded for them).
  await assertCan({ resource: 'resignations', verb: 'create', record: { ownerPartyId: employment.personId } });

  if (!['Active', 'OnLeave'].includes(employment.status)) {
    throw ApiError.conflict(`A resignation cannot be filed while employment is ${employment.status}.`);
  }
  const existing = await prisma.resignation.findFirst({
    where: { tenantId: auth.tenantId, employmentRelationshipId: input.employmentRelationshipId, status: 'submitted' },
  });
  if (existing) throw ApiError.conflict('A resignation is already pending on this employment.', { resignationId: existing.id });
  if (!RESIGNATION_REASON_CATEGORIES.includes(input.reasonCategory)) {
    throw ApiError.badRequest(`"${input.reasonCategory}" is not a resignation reason category.`);
  }

  const { noticeDays } = await noticeDaysFor(input.employmentRelationshipId);
  const recordCode = await nextRecordCode('RSG');
  const submittedOn = new Date();

  const row = await prisma.resignation.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      employmentRelationshipId: input.employmentRelationshipId,
      submittedOn,
      requestedLastDay: input.requestedLastDay,
      noticeDays,
      reasonCategory: input.reasonCategory,
      reasonNote: input.reasonNote ?? null,
      status: 'submitted',
      createdById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.RESIGNATION_SUBMITTED,
    subject: { entityType: 'resignation', entityId: row.id, recordCode },
    related: [{ relation: 'resigns_from', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { status: 'submitted', requestedLastDay: input.requestedLastDay, reasonCategory: input.reasonCategory },
    owner: { partyId: employment.personId },
    impact: { domains: ['hr'] },
  });

  const hrOwner = await hrOpsOwnerId(auth.tenantId);
  if (hrOwner) {
    await notify({
      recipientPartyId: hrOwner,
      priority: 'N2_NORMAL',
      title: `Resignation filed: ${employment.person.fullName}`,
      body: `Requested last day ${input.requestedLastDay.toISOString().slice(0, 10)}, ${noticeDays} days' notice.`,
      subjectType: 'resignation',
      subjectId: row.id,
      drillPath: `/people/separations`,
    });
  }

  return row;
}

function assertResignationTransition(from: ResignationState, to: ResignationState) {
  if (!canTransitionResignation(from, to)) {
    throw ApiError.conflict(`A resignation in "${from}" cannot become "${to}".`);
  }
}

/**
 * Accepting a resignation is a distinct grant (`resignations:approve`) from
 * filing or editing one, and the Self-Dealing Bar applies exactly as it does
 * on a compensation record: the person the resignation is about can never be
 * the one who accepts it.
 */
export async function acceptResignation(id: string, agreedLastDay?: Date, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'resignations', verb: 'approve' });

  const row = await prisma.resignation.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { employmentRelationship: true },
  });
  if (!row) throw ApiError.notFound('Resignation');
  assertResignationTransition(row.status as ResignationState, 'accepted');

  if (row.employmentRelationship.personId === auth.partyId) {
    throw ApiError.forbidden(
      'A resignation cannot be accepted by the person who filed it (Self-Dealing Bar).',
      [{ axis: 'WHO', passed: false, reason: 'self_dealing_bar_resignation' }],
    );
  }

  const finalLastDay = agreedLastDay ?? row.requestedLastDay;

  const updated = await prisma.$transaction(async (tx) => {
    const resignation = await tx.resignation.update({
      where: { id },
      data: { status: 'accepted', acceptedById: auth.partyId, acceptedAt: new Date(), agreedLastDay: finalLastDay },
    });
    return resignation;
  });

  // The employment relationship's own transition — this is what actually
  // starts the notice period and opens the Offboarding row (see
  // `transitionEmployment` in domains/employment.ts).
  await transitionEmployment(row.employmentRelationshipId, 'SUBMIT_RESIGNATION', { note: note ?? undefined });

  const offboarding = await prisma.offboarding.findUnique({ where: { employmentRelationshipId: row.employmentRelationshipId } });
  const linked = offboarding
    ? await prisma.resignation.update({ where: { id }, data: { offboardingId: offboarding.id } })
    : updated;

  await emit({
    name: EVENTS.RESIGNATION_ACCEPTED,
    subject: { entityType: 'resignation', entityId: id, recordCode: row.recordCode },
    related: offboarding ? [{ relation: 'opens', entityType: 'offboarding', entityId: offboarding.id }] : [],
    previousState: { status: 'submitted' },
    newState: { status: 'accepted', agreedLastDay: finalLastDay },
    owner: { partyId: row.employmentRelationship.personId },
    impact: { domains: ['hr'] },
  });

  return linked;
}

export async function rejectResignation(id: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'resignations', verb: 'approve' });

  const row = await prisma.resignation.findFirst({ where: { id, tenantId: auth.tenantId }, include: { employmentRelationship: true } });
  if (!row) throw ApiError.notFound('Resignation');
  assertResignationTransition(row.status as ResignationState, 'rejected');
  if (row.employmentRelationship.personId === auth.partyId) {
    throw ApiError.forbidden(
      'A resignation cannot be rejected by the person who filed it (Self-Dealing Bar).',
      [{ axis: 'WHO', passed: false, reason: 'self_dealing_bar_resignation' }],
    );
  }
  if (!reason?.trim()) throw ApiError.badRequest('A rejection needs a reason.');

  const updated = await prisma.resignation.update({
    where: { id },
    data: { status: 'rejected', rejectedReason: reason },
  });

  await emit({
    name: EVENTS.RESIGNATION_REJECTED,
    subject: { entityType: 'resignation', entityId: id, recordCode: row.recordCode },
    previousState: { status: 'submitted' },
    newState: { status: 'rejected', reason },
    owner: { partyId: row.employmentRelationship.personId },
    impact: { domains: ['hr'] },
  });

  return updated;
}

/** Withdrawing your own resignation while it is still pending — the one mutation `resignations:create @own` is asked to carry, since a withdrawal is the requester's own act on their own not-yet-decided request. */
export async function withdrawResignation(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'resignations', verb: 'create' });

  const row = await prisma.resignation.findFirst({ where: { id, tenantId: auth.tenantId }, include: { employmentRelationship: true } });
  if (!row) throw ApiError.notFound('Resignation');
  await assertCan({ resource: 'resignations', verb: 'create', record: { ownerPartyId: row.employmentRelationship.personId } });
  assertResignationTransition(row.status as ResignationState, 'withdrawn');

  const updated = await prisma.resignation.update({ where: { id }, data: { status: 'withdrawn', withdrawnAt: new Date() } });

  await emit({
    name: EVENTS.RESIGNATION_WITHDRAWN,
    subject: { entityType: 'resignation', entityId: id, recordCode: row.recordCode },
    previousState: { status: 'submitted' },
    newState: { status: 'withdrawn' },
    owner: { partyId: row.employmentRelationship.personId },
    impact: { domains: ['hr'] },
  });

  return updated;
}

/** Days short of full notice, for the screen that shows what a buyout would cover — pure arithmetic, exported so a payroll ad-hoc line can call it without re-deriving. */
export function resignationNoticeShortfall(resignation: { noticeDays: number; submittedOn: Date; agreedLastDay: Date | null; requestedLastDay: Date }): number {
  const lastDay = resignation.agreedLastDay ?? resignation.requestedLastDay;
  return noticeShortfallDays(resignation.noticeDays, resignation.submittedOn, lastDay);
}

// ---------------------------------------------------------------------------
// Exit clearance
// ---------------------------------------------------------------------------

async function requireOffboarding(offboardingId: string) {
  const auth = currentAuth();
  const offboarding = await prisma.offboarding.findFirst({
    where: { id: offboardingId, tenantId: auth.tenantId },
    include: { employmentRelationship: true },
  });
  if (!offboarding) throw ApiError.notFound('Offboarding');
  return offboarding;
}

export async function listExitClearances(offboardingId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'exit_clearances', verb: 'view' });
  const offboarding = await requireOffboarding(offboardingId);
  if (auth.roleSlug === 'employee' && offboarding.employmentRelationship.personId !== auth.partyId) {
    throw ApiError.notFound('Offboarding');
  }
  return prisma.exitClearance.findMany({ where: { tenantId: auth.tenantId, offboardingId }, orderBy: { department: 'asc' } });
}

/** Opens the five-department clearance for an offboarding, once its last working day is reached — idempotent, so calling it twice never duplicates a row. */
export async function initiateClearance(offboardingId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'exit_clearances', verb: 'create' });
  const offboarding = await requireOffboarding(offboardingId);

  if (offboarding.status === 'NoticePeriodActive') {
    await transitionOffboarding(offboardingId, 'REACH_LWD');
  }
  const current = await prisma.offboarding.findFirst({ where: { id: offboardingId } });
  if (current?.status !== 'LastWorkingDayReached' && current?.status !== 'ClearancePending') {
    throw ApiError.conflict(`Clearance cannot be opened while offboarding is ${current?.status}.`);
  }
  if (current.status === 'LastWorkingDayReached') {
    await transitionOffboarding(offboardingId, 'BEGIN_CLEARANCE');
  }

  const existing = await prisma.exitClearance.findMany({ where: { tenantId: auth.tenantId, offboardingId } });
  const have = new Set(existing.map((e) => e.department));
  const toCreate = CLEARANCE_DEPARTMENTS.filter((d) => !have.has(d));
  for (const department of toCreate) {
    await prisma.exitClearance.create({
      data: {
        tenantId: auth.tenantId,
        offboardingId,
        employmentRelationshipId: offboarding.employmentRelationshipId,
        department,
        status: 'pending',
      },
    });
  }
  return listExitClearances(offboardingId);
}

async function afterClearanceChange(offboardingId: string) {
  const auth = currentAuth();
  const rows = await prisma.exitClearance.findMany({ where: { tenantId: auth.tenantId, offboardingId } });
  const complete = allClearancesComplete(rows);
  const offboarding = await prisma.offboarding.findFirst({ where: { id: offboardingId, tenantId: auth.tenantId } });
  if (!offboarding) return;

  if (complete && offboarding.status === 'ClearancePending') {
    await transitionOffboarding(offboardingId, 'CLEARANCE_COMPLETE');
    await emit({
      name: EVENTS.EXIT_CLEARANCE_COMPLETED,
      subject: { entityType: 'offboarding', entityId: offboardingId },
      related: [{ relation: 'clears', entityType: 'employment_relationship', entityId: offboarding.employmentRelationshipId }],
      newState: { status: 'complete', departments: rows.map((r) => r.department) },
      impact: { domains: ['hr'] },
    });
  } else if (!complete && offboarding.status === 'ClearancePending' && blockedClearanceCount(rows) > 0) {
    await transitionOffboarding(offboardingId, 'DISPUTE', 'A department blocked clearance.');
  } else if (offboarding.status === 'BlockedDisputed' && blockedClearanceCount(rows) === 0) {
    await transitionOffboarding(offboardingId, 'RESOLVE');
  }
}

export async function clearDepartment(id: string, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'exit_clearances', verb: 'edit' });

  const row = await prisma.exitClearance.findFirst({ where: { id, tenantId: auth.tenantId }, include: { employmentRelationship: true } });
  if (!row) throw ApiError.notFound('Exit clearance');
  if (row.employmentRelationship.personId === auth.partyId) {
    throw ApiError.forbidden(
      'A department cannot clear its own exit (Self-Dealing Bar): the departing employee may not sign off their own clearance.',
      [{ axis: 'WHO', passed: false, reason: 'self_dealing_bar_clearance' }],
    );
  }

  const before = row;
  const updated = await prisma.exitClearance.update({
    where: { id },
    data: { status: 'cleared', clearedById: auth.partyId, clearedAt: new Date(), note: note ?? row.note },
  });
  await auditWrite({ action: 'update', subjectType: 'exit_clearance', subjectId: id, before, after: updated });
  await afterClearanceChange(row.offboardingId);
  return updated;
}

export async function blockDepartment(id: string, note: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'exit_clearances', verb: 'edit' });
  if (!note?.trim()) throw ApiError.badRequest('Blocking a department needs a reason.');

  const row = await prisma.exitClearance.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Exit clearance');

  const before = row;
  const updated = await prisma.exitClearance.update({
    where: { id },
    data: { status: 'blocked', note, clearedById: null, clearedAt: null },
  });
  await auditWrite({ action: 'update', subjectType: 'exit_clearance', subjectId: id, before, after: updated });
  await afterClearanceChange(row.offboardingId);
  return updated;
}

// ---------------------------------------------------------------------------
// No-dues certificate
// ---------------------------------------------------------------------------

export async function getNoDues(offboardingId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'no_dues', verb: 'view' });
  const offboarding = await requireOffboarding(offboardingId);
  if (auth.roleSlug === 'employee' && offboarding.employmentRelationship.personId !== auth.partyId) {
    throw ApiError.notFound('Offboarding');
  }
  return prisma.noDuesCertificate.findUnique({ where: { offboardingId } });
}

/** Issued only once every department has cleared — asserted structurally, not just by convention. */
export async function issueNoDues(offboardingId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'no_dues', verb: 'create' });

  const existing = await prisma.noDuesCertificate.findUnique({ where: { offboardingId } });
  if (existing) throw ApiError.conflict('A no-dues certificate has already been issued for this offboarding.');

  const offboarding = await requireOffboarding(offboardingId);
  const rows = await prisma.exitClearance.findMany({ where: { tenantId: auth.tenantId, offboardingId } });
  if (!allClearancesComplete(rows)) {
    const outstanding = CLEARANCE_DEPARTMENTS.filter((d) => !rows.some((r) => r.department === d && r.status === 'cleared'));
    throw ApiError.conflict(
      `No-dues cannot be issued while ${outstanding.length === 1 ? 'a department is' : 'departments are'} outstanding: ${outstanding.join(', ')}.`,
    );
  }

  const row = await prisma.noDuesCertificate.create({
    data: {
      tenantId: auth.tenantId,
      offboardingId,
      employmentRelationshipId: offboarding.employmentRelationshipId,
      issuedById: auth.partyId ?? 'system',
      clearanceSnapshot: rows.map((r) => ({ department: r.department, status: r.status, clearedById: r.clearedById, clearedAt: r.clearedAt })) as never,
    },
  });

  await emit({
    name: EVENTS.NO_DUES_ISSUED,
    subject: { entityType: 'no_dues_certificate', entityId: row.id },
    related: [{ relation: 'for', entityType: 'offboarding', entityId: offboardingId }],
    newState: { issuedOn: row.issuedOn },
    owner: { partyId: offboarding.employmentRelationship.personId },
    impact: { domains: ['hr'] },
  });

  return row;
}

/**
 * Asset returns pending for an offboarding. WS11 owns the `Asset` /
 * `AssetAssignment` models and this workstream does not know their table or
 * column names in advance, so the count is `null` ("not measured") until
 * WS11's tables exist — never a guessed query against a schema this file
 * does not own. See docs/hcm/separations.md § Wanted from the scaffold.
 */
export async function assetsPendingCount(employmentRelationshipId: string): Promise<number | null> {
  try {
    const rows = await unscopedPrisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `select count(*)::bigint as count from hcm_asset_assignments where "employmentRelationshipId" = $1 and "returnedOn" is null`,
      employmentRelationshipId,
    );
    return Number(rows[0]?.count ?? 0);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Alumni
// ---------------------------------------------------------------------------

export async function listAlumni() {
  const auth = currentAuth();
  await assertCan({ resource: 'alumni', verb: 'view' });
  return prisma.alumniRecord.findMany({ where: { tenantId: auth.tenantId }, orderBy: { exitDate: 'desc' } });
}

/**
 * Moves the employment relationship from `Terminated` into `Alumni` (the
 * only outbound arrow that state has) and writes the record that survives
 * it. Not automatic on `ClosedArchived`: whether somebody is rehire-eligible
 * and whether they consented to being contacted is a judgement HR makes once,
 * deliberately, not a default the settlement machinery should assume.
 */
export async function recordAlumni(input: {
  employmentRelationshipId: string;
  rehireEligible?: boolean | null;
  rehireNote?: string | null;
  contactConsent?: boolean;
  contactEmail?: string | null;
  contactPhone?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'alumni', verb: 'create' });

  const employment = await requireEmployment(input.employmentRelationshipId);
  const existing = await prisma.alumniRecord.findUnique({ where: { employmentRelationshipId: input.employmentRelationshipId } });
  if (existing) throw ApiError.conflict('An alumni record already exists for this employment.');

  if (employment.status === 'Terminated') {
    await transitionEmployment(input.employmentRelationshipId, 'RETENTION_TRANSITION');
  } else if (employment.status !== 'Alumni') {
    throw ApiError.conflict(`An alumni record can only be written once employment is Terminated or Alumni (currently ${employment.status}).`);
  }

  const lastAssignment = await prisma.assignment.findFirst({
    where: { tenantId: auth.tenantId, employmentRelationshipId: input.employmentRelationshipId },
    include: { position: { include: { job: true } } },
    orderBy: { effectiveFrom: 'desc' },
  });

  const row = await prisma.alumniRecord.create({
    data: {
      tenantId: auth.tenantId,
      personId: employment.personId,
      employmentRelationshipId: input.employmentRelationshipId,
      lastDesignation: lastAssignment?.position.job.title ?? 'Not on record',
      exitDate: employment.separationDate ?? new Date(),
      separationType: employment.separationType ?? 'resignation',
      rehireEligible: input.rehireEligible ?? employment.rehireEligible ?? null,
      rehireNote: input.rehireNote ?? employment.rehireIneligibleReason ?? null,
      contactConsent: input.contactConsent ?? false,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'alumni_record', subjectId: row.id, after: row });
  return row;
}

// ---------------------------------------------------------------------------
// Offboarding read helper (a view this workstream's screens need; the machine
// itself is owned by employment.ts)
// ---------------------------------------------------------------------------

export async function getOffboardingForEmployment(employmentRelationshipId: string) {
  const auth = currentAuth();
  const employment = await requireEmployment(employmentRelationshipId);
  if (auth.roleSlug === 'employee' && employment.personId !== auth.partyId) {
    throw ApiError.notFound('Employment relationship');
  }
  const offboarding = await prisma.offboarding.findUnique({ where: { employmentRelationshipId } });
  if (!offboarding) return null;
  const clearances = await prisma.exitClearance.findMany({ where: { tenantId: auth.tenantId, offboardingId: offboarding.id }, orderBy: { department: 'asc' } });
  const noDues = await prisma.noDuesCertificate.findUnique({ where: { offboardingId: offboarding.id } });
  return {
    ...offboarding,
    clearances,
    allCleared: allClearancesComplete(clearances),
    noDues,
  };
}

export const OFFBOARDING_STATE_MACHINE = offboardingMachine;
export type { OffboardingState };
