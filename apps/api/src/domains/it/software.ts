/**
 * Technology — applications, licences and subscriptions (docs/plan/cio.md,
 * workstream B).
 *
 * `ItApplication` is the catalogue: every application the company runs on,
 * whether or not it currently has a licence attached. `ItLicence` is one
 * commercial agreement against an application — seats, cost, term, renewal.
 * `ItLicenceEvent` is the append-only history of what happened to a
 * licence's seats and renewals (docs/plan/cio.md Principle 5).
 *
 * Renewal is a two-party act by construction, not merely by convention: the
 * grant matrix gives Operations Head `it_licences:edit` with no `approve`,
 * and gives Finance Head `it_licences:approve` with no `edit` — so a renewal
 * a request can never be both proposed and decided by the same person, and
 * there is no direct-apply path to route around (unlike the MoU/contract
 * gate, where one role often holds both verbs and the Self-Dealing Bar is
 * the only thing standing between a proposer and their own approval).
 * `evaluateApprovalGate`'s own required-permission check reflects that
 * asymmetry literally — "holding edit alone never confers approval
 * authority" — so `proposeRenewal` (held by an edit-only proposer) opens the
 * `ApprovalStep` itself, using the same primitive and the same
 * `POL-IT-LICENCE-APPROVAL` policy version the gate reads, and
 * `approveRenewal` (held by an approve-only decider) hands the decision to
 * `decideApprovalStep`, which is where the Self-Dealing Bar actually lives
 * (a requester may never decide their own step). The shape at the call site
 * — `{ applied: false, ...gate }` when a step opens, `{ applied: true, ... }`
 * once decided — is exactly `transitionAgreement`'s in `domains/agreements.ts`.
 */

import {
  EVENTS,
  IT_DOMAIN,
  IT_TIERS,
  APPROVAL_LADDER,
  annualisedCost,
  daysUntilLicenceDate,
  isUnderUsed,
  itApplicationMachine,
  renewalRung,
  seatUtilisation,
  totalAnnualisedSpend,
  type ItApplicationEvent,
  type ItApplicationStatus,
  type ItBillingCycle,
  type ItSummaryBase,
} from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, canSeeMoney, evaluate } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException, notify } from '../../platform/exceptions.js';
import { decideApprovalStep, addBusinessDays } from '../../platform/approvals.js';
import { availableTransitions } from '../../platform/lifecycle.js';

registerGovernedEntities('it_software', ['it_application', 'it_licence']);

const RENEWAL_POLICY_CODE = 'POL-IT-LICENCE-APPROVAL';

function num(d: unknown): number {
  if (d === null || d === undefined) return 0;
  return typeof d === 'number' ? d : Number((d as { toString(): string }).toString());
}

/**
 * `costPerPeriod`, `pendingRenewalCostPerPeriod` and the derived
 * `annualisedCost` are withheld — present but nulled, never a silently
 * dropped key — from any caller who does not hold `it_licences:financial`
 * (Finance Head and the chairman hold it; Operations Head, who can create
 * and edit licences, does not). The same shape `maskContractMoney` in
 * `domains/it/vendors.ts` uses, applied explicitly here rather than through
 * `applyFieldVisibility`: none of these field names are in the platform's
 * shared `MONEY_FIELDS` list (`packages/shared/src/permissions.ts`, not
 * this workstream's file to extend).
 */
function maskLicenceMoney<T extends Record<string, unknown>>(row: T, seesMoney: boolean): T {
  if (seesMoney) return row;
  const masked: Record<string, unknown> = { ...row };
  if ('costPerPeriod' in masked) masked.costPerPeriod = null;
  if ('pendingRenewalCostPerPeriod' in masked) masked.pendingRenewalCostPerPeriod = null;
  if ('annualisedCost' in masked) masked.annualisedCost = null;
  return masked as T;
}

// ---------------------------------------------------------------------------
// Thresholds (dated table — Principle 4)
// ---------------------------------------------------------------------------

export async function currentThreshold() {
  const auth = currentAuth();
  const now = new Date();
  const row = await prisma.itSoftwareThreshold.findFirst({
    where: { tenantId: auth.tenantId, effectiveFrom: { lte: now } },
    orderBy: { effectiveFrom: 'desc' },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export interface CreateApplicationInput {
  name: string;
  vendorName?: string | null;
  vendorId?: string | null;
  category: string;
  tier?: number;
  hosting: string;
  ownerPartyId?: string | null;
  dataClassificationHandled?: string;
  sso?: boolean;
  url?: string | null;
  notes?: string | null;
}

export async function createApplication(input: CreateApplicationInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_applications', verb: 'create' });

  if (!input.name?.trim()) throw ApiError.badRequest('An application needs a name.');
  if (input.tier !== undefined && !(IT_TIERS as readonly number[]).includes(input.tier)) {
    throw ApiError.badRequest(`Tier must be one of ${IT_TIERS.join(', ')}.`);
  }

  const recordCode = await nextRecordCode('SWA');
  const app = await prisma.itApplication.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: input.name.trim(),
      vendorName: input.vendorName ?? null,
      vendorId: input.vendorId ?? null,
      category: input.category,
      tier: input.tier ?? 3,
      hosting: input.hosting,
      ownerPartyId: input.ownerPartyId ?? null,
      dataClassificationHandled: input.dataClassificationHandled ?? 'internal',
      sso: input.sso ?? false,
      status: 'evaluating',
      url: input.url ?? null,
      notes: input.notes ?? null,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_application', subjectId: app.id, after: { recordCode, name: app.name } });
  await emit({
    name: EVENTS.IT_APPLICATION_CREATED,
    subject: { entityType: 'it_application', entityId: app.id, recordCode },
    newState: { name: app.name, status: app.status, tier: app.tier },
    owner: { partyId: app.ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return app;
}

export interface ApplicationFilter {
  status?: string;
  tier?: number;
  hosting?: string;
}

export async function listApplications(filter: ApplicationFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_applications', verb: 'view' });
  return prisma.itApplication.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.tier !== undefined ? { tier: filter.tier } : {}),
      ...(filter.hosting ? { hosting: filter.hosting } : {}),
    },
    orderBy: [{ tier: 'asc' }, { name: 'asc' }],
  });
}

async function loadApplication(id: string) {
  const auth = currentAuth();
  const app = await prisma.itApplication.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!app) throw ApiError.notFound('Application');
  return app;
}

/**
 * An application's licences are included only for a caller who separately
 * holds `it_licences:view` — an employee holds `it_applications:view` (the
 * catalogue) but no grant on `it_licences` at all (the matrix's `–`), and
 * must not see a licence's existence, let alone its cost, by way of the
 * application it hangs off. Checked with `evaluate`, not `assertCan`, so
 * the absence of the grant quietly empties the array rather than refusing
 * the whole application.
 */
export async function applicationDetail(id: string) {
  await assertCan({ resource: 'it_applications', verb: 'view' });
  const app = await loadApplication(id);
  const auth = currentAuth();

  const licenceGrant = await evaluate({ resource: 'it_licences', verb: 'view' });
  let licences: unknown[] = [];
  if (licenceGrant.allowed) {
    const seesMoney = await canSeeMoney('it_licences');
    const rows = await prisma.itLicence.findMany({
      where: { tenantId: auth.tenantId, applicationId: id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    licences = rows.map((row) => maskLicenceMoney(row, seesMoney));
  }

  return {
    ...app,
    availableTransitions: availableTransitions(itApplicationMachine, app.status as ItApplicationStatus),
    licences,
  };
}

export interface UpdateApplicationInput {
  name?: string;
  vendorName?: string | null;
  vendorId?: string | null;
  category?: string;
  tier?: number;
  hosting?: string;
  ownerPartyId?: string | null;
  dataClassificationHandled?: string;
  sso?: boolean;
  url?: string | null;
  notes?: string | null;
}

export async function updateApplication(id: string, patch: UpdateApplicationInput) {
  const auth = currentAuth();
  const app = await loadApplication(id);
  await assertCan({ resource: 'it_applications', verb: 'edit', record: { ownerPartyId: app.ownerPartyId } });

  if (patch.tier !== undefined && !(IT_TIERS as readonly number[]).includes(patch.tier)) {
    throw ApiError.badRequest(`Tier must be one of ${IT_TIERS.join(', ')}.`);
  }

  const gainedOwner = !app.ownerPartyId && patch.ownerPartyId;

  const updated = await prisma.itApplication.update({
    where: { id },
    data: {
      ...patch,
      ...(gainedOwner ? { unownedNotifiedAt: null } : {}),
    },
  });

  await auditWrite({ action: 'update', subjectType: 'it_application', subjectId: id, before: app, after: updated });
  return updated;
}

export async function transitionApplication(id: string, event: ItApplicationEvent, note?: string) {
  const auth = currentAuth();
  const app = await loadApplication(id);
  await assertCan({ resource: 'it_applications', verb: 'edit', record: { ownerPartyId: app.ownerPartyId } });

  const from = app.status as ItApplicationStatus;
  if (!itApplicationMachine.can(from, event)) {
    throw ApiError.unprocessable(
      `${app.recordCode ?? id} is ${from}; ${event} is not one of its transitions. From here it accepts: ` +
        `${itApplicationMachine.allowedEvents(from).join(', ') || 'nothing — this is a terminal state'}.`,
    );
  }
  const to = itApplicationMachine.apply(from, event);

  const updated = await prisma.itApplication.update({ where: { id }, data: { status: to } });

  await auditWrite({
    action: 'update',
    subjectType: 'it_application',
    subjectId: id,
    before: { status: from },
    after: { status: to },
    meta: { transition: event, note: note ?? null },
  });
  await emit({
    name: EVENTS.IT_APPLICATION_TRANSITIONED,
    subject: { entityType: 'it_application', entityId: id, recordCode: app.recordCode },
    previousState: { status: from },
    newState: { status: to },
    owner: { partyId: app.ownerPartyId },
    reason: note ? { note } : null,
    impact: { domains: [IT_DOMAIN] },
  });

  return { ...updated, availableTransitions: availableTransitions(itApplicationMachine, to) };
}

/**
 * Raises `IT_APP_UNOWNED` for an active application with no owner — a
 * routing defect, not a row that quietly sits unowned (IT-APP-001). Called
 * by the daily job; idempotent via `unownedNotifiedAt` and via
 * `raiseException`'s own open-exception dedupe.
 */
export async function flagUnownedApplications(): Promise<number> {
  const auth = currentAuth();
  const rows = await prisma.itApplication.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, ownerPartyId: null, status: { in: ['evaluating', 'active'] } },
  });

  let flagged = 0;
  for (const app of rows) {
    await raiseException({
      code: 'IT_APP_UNOWNED',
      label: `No owner for ${app.name}`,
      severity: 'S2_WARNING',
      subjectType: 'it_application',
      subjectId: app.id,
      subjectLabel: app.recordCode ?? app.name,
      domain: IT_DOMAIN,
      detail: `${app.name} carries no ownerPartyId. An application nobody is accountable for is a routing defect, not a silent gap.`,
      triggerFingerprint: 'it_application_unowned',
    });
    if (!app.unownedNotifiedAt) {
      await prisma.itApplication.update({ where: { id: app.id }, data: { unownedNotifiedAt: new Date() } });
    }
    flagged += 1;
  }
  return flagged;
}

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

export interface CreateLicenceInput {
  applicationId: string;
  kind: string;
  seatsPurchased?: number;
  seatsInUse?: number;
  costPerPeriod: number;
  currency?: string;
  billingCycle: string;
  termStart?: Date | null;
  termEnd?: Date | null;
  renewalDate?: Date | null;
  noticeDays?: number;
  autoRenew?: boolean;
  vendorContractId?: string | null;
  lastVendorBillId?: string | null;
}

export async function createLicence(input: CreateLicenceInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_licences', verb: 'create' });

  const application = await prisma.itApplication.findFirst({
    where: { id: input.applicationId, tenantId: auth.tenantId, deletedAt: null },
  });
  if (!application) throw ApiError.notFound('Application');
  if (input.costPerPeriod < 0) throw ApiError.badRequest('Cost per period cannot be negative.');

  const recordCode = await nextRecordCode('LIC');
  const licence = await prisma.itLicence.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      applicationId: input.applicationId,
      kind: input.kind,
      seatsPurchased: input.seatsPurchased ?? 0,
      seatsInUse: input.seatsInUse ?? 0,
      costPerPeriod: input.costPerPeriod,
      currency: input.currency ?? 'INR',
      billingCycle: input.billingCycle,
      termStart: input.termStart ?? null,
      termEnd: input.termEnd ?? null,
      renewalDate: input.renewalDate ?? null,
      noticeDays: input.noticeDays ?? 30,
      autoRenew: input.autoRenew ?? false,
      vendorContractId: input.vendorContractId ?? null,
      lastVendorBillId: input.lastVendorBillId ?? null,
      status: 'active',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_licence', subjectId: licence.id, after: { recordCode, applicationId: input.applicationId } });
  await emit({
    name: EVENTS.IT_LICENCE_CREATED,
    subject: { entityType: 'it_licence', entityId: licence.id, recordCode },
    related: [{ relation: 'licenses', entityType: 'it_application', entityId: application.id }],
    newState: { kind: licence.kind, seatsPurchased: licence.seatsPurchased, costPerPeriod: num(licence.costPerPeriod) },
    owner: { partyId: application.ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return licence;
}

export interface LicenceFilter {
  status?: string;
  applicationId?: string;
  view?: 'renewing' | 'over_allocated' | 'all';
}

export async function listLicences(filter: LicenceFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_licences', verb: 'view' });
  const seesMoney = await canSeeMoney('it_licences');

  const rows = await prisma.itLicence.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.applicationId ? { applicationId: filter.applicationId } : {}),
    },
    include: { application: true },
    orderBy: { createdAt: 'desc' },
  });

  let filtered = rows;
  if (filter.view === 'renewing') {
    const now = new Date();
    filtered = rows.filter((r) => r.renewalDate && daysUntilLicenceDate(r.renewalDate, now) <= 90 && r.status !== 'cancelled');
  } else if (filter.view === 'over_allocated') {
    filtered = rows.filter((r) => seatUtilisation(r.seatsPurchased, r.seatsInUse).overAllocated);
  }

  return filtered.map((row) => maskLicenceMoney(row, seesMoney));
}

async function loadLicence(id: string) {
  const auth = currentAuth();
  const licence = await prisma.itLicence.findFirst({
    where: { id, tenantId: auth.tenantId, deletedAt: null },
    include: { application: true },
  });
  if (!licence) throw ApiError.notFound('Licence');
  return licence;
}

export async function licenceDetail(id: string) {
  await assertCan({ resource: 'it_licences', verb: 'view' });
  const licence = await loadLicence(id);
  const seesMoney = await canSeeMoney('it_licences');
  const events = await prisma.itLicenceEvent.findMany({ where: { licenceId: id }, orderBy: { createdAt: 'desc' } });
  const shaped = {
    ...licence,
    annualisedCost: annualisedCost(num(licence.costPerPeriod), licence.billingCycle as ItBillingCycle),
    seatUtilisation: seatUtilisation(licence.seatsPurchased, licence.seatsInUse),
    events,
  };
  return maskLicenceMoney(shaped, seesMoney);
}

/** Seats in use are typed in — the platform does not meter SaaS logins
 * (docs/plan/cio.md Principle 7). Recorded as an append-only event. */
export async function updateSeats(id: string, seatsInUse: number, note?: string) {
  const auth = currentAuth();
  const licence = await loadLicence(id);
  await assertCan({ resource: 'it_licences', verb: 'edit', record: { ownerPartyId: licence.application.ownerPartyId } });

  if (!Number.isInteger(seatsInUse) || seatsInUse < 0) throw ApiError.badRequest('Seats in use must be a non-negative whole number.');
  if (licence.status === 'cancelled') throw ApiError.conflict(`${licence.recordCode ?? id} is cancelled; its seat count is no longer live.`);

  const before = licence.seatsInUse;
  const updated = await prisma.itLicence.update({
    where: { id },
    data: { seatsInUse, overAllocationNotifiedAt: null, underUseNotifiedAt: null },
  });

  await prisma.itLicenceEvent.create({
    data: {
      tenantId: auth.tenantId,
      licenceId: id,
      kind: 'seats_changed',
      actorPartyId: auth.partyId,
      note: note ?? null,
      detail: { before, after: seatsInUse },
    },
  });
  await auditWrite({ action: 'update', subjectType: 'it_licence', subjectId: id, before: { seatsInUse: before }, after: { seatsInUse } });

  return updated;
}

/**
 * Resolves the standing renewal decider: Finance Head first, the chairman
 * if nobody currently holds that role — `APPROVAL_LADDER` as data, the same
 * shape `resolveApprover` in `platform/approvals.ts` reads a role slug from,
 * never a role-slug comparison in this file's own logic.
 */
async function resolveLicenceApprover(excludePartyId: string | null) {
  const auth = currentAuth();
  for (const roleSlug of APPROVAL_LADDER) {
    const affiliation = await prisma.affiliation.findFirst({
      where: {
        tenantId: auth.tenantId,
        roleSlug,
        status: 'active',
        ...(excludePartyId ? { partyId: { not: excludePartyId } } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    if (affiliation) return { partyId: affiliation.partyId, roleSlug };
  }
  return null;
}

export interface ProposeRenewalInput {
  newTermEnd: Date;
  newCostPerPeriod?: number;
  newBillingCycle?: string;
  note?: string;
}

export interface RenewalGateResult {
  applied: boolean;
  licence: unknown;
  approvalStepId: string | null;
  resolvedApproverRole: string | null;
  reason: string;
}

/**
 * Proposes a renewal: the new term end, and optionally a new cost or
 * billing cycle. Held by whoever holds `it_licences:edit` (Operations Head
 * per the matrix) — never by whoever will decide it. Always opens an
 * `ApprovalStep` against the standing decider; there is no ceiling under
 * which a proposer applies it directly, because the matrix gives nobody
 * both verbs on this resource at once (see the file header).
 */
export async function proposeRenewal(id: string, input: ProposeRenewalInput): Promise<RenewalGateResult> {
  const auth = currentAuth();
  const licence = await loadLicence(id);
  await assertCan({ resource: 'it_licences', verb: 'edit', record: { ownerPartyId: licence.application.ownerPartyId } });

  if (licence.status === 'cancelled') throw ApiError.conflict(`${licence.recordCode ?? id} is cancelled and cannot be renewed.`);
  if (licence.pendingRenewalApprovalStepId) {
    throw ApiError.conflict(`${licence.recordCode ?? id} already has a renewal proposal awaiting a decision.`);
  }
  if (!input.newTermEnd) throw ApiError.badRequest('A renewal proposal needs the new term end date.');

  const costPerPeriod = input.newCostPerPeriod ?? num(licence.costPerPeriod);
  const billingCycle = (input.newBillingCycle ?? licence.billingCycle) as ItBillingCycle;
  const annualised = annualisedCost(costPerPeriod, billingCycle);

  const approver = await resolveLicenceApprover(auth.partyId);
  const policy = await prisma.policy.findFirst({
    where: { tenantId: auth.tenantId, policyCode: RENEWAL_POLICY_CODE },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  const policyVersion = policy?.versions[0];

  const step = await prisma.approvalStep.create({
    data: {
      tenantId: auth.tenantId,
      policyId: policy?.id ?? null,
      policyVersion: policyVersion?.version ?? null,
      subjectType: 'it_licence',
      subjectId: id,
      subjectLabel: licence.recordCode ?? id,
      action: 'it_licence.renew',
      requestedById: auth.partyId ?? 'system',
      requestedValue: annualised,
      currency: licence.currency,
      resolvedApproverId: approver?.partyId ?? null,
      resolvedApproverRole: approver?.roleSlug ?? 'finance_head',
      resolutionTier: 0,
      selfDealingBarTripped: false,
      slaDueAt: addBusinessDays(new Date(), 3),
    },
  });

  const updated = await prisma.itLicence.update({
    where: { id },
    data: {
      pendingRenewalProposedById: auth.partyId,
      pendingRenewalApprovalStepId: step.id,
      pendingRenewalTermEnd: input.newTermEnd,
      pendingRenewalCostPerPeriod: costPerPeriod,
      pendingRenewalNote: input.note ?? null,
    },
  });

  await prisma.itLicenceEvent.create({
    data: {
      tenantId: auth.tenantId,
      licenceId: id,
      kind: 'renewal_proposed',
      actorPartyId: auth.partyId,
      note: input.note ?? null,
      detail: { approvalStepId: step.id, newTermEnd: input.newTermEnd, newCostPerPeriod: costPerPeriod, annualisedCost: annualised },
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'it_licence',
    subjectId: id,
    before: { pendingRenewalApprovalStepId: null },
    after: { pendingRenewalApprovalStepId: step.id },
  });
  await emit({
    name: EVENTS.IT_LICENCE_RENEWAL_PROPOSED,
    subject: { entityType: 'it_licence', entityId: id, recordCode: licence.recordCode },
    related: [{ relation: 'gates', entityType: 'approval_step', entityId: step.id }],
    newState: { approvalStepId: step.id, annualisedCost: annualised, newTermEnd: input.newTermEnd },
    reason: { reasonCode: 'renewal_proposed' },
    impact: { domains: [IT_DOMAIN] },
  });

  if (approver?.partyId) {
    await notify({
      recipientPartyId: approver.partyId,
      priority: 'N3_HIGH',
      title: `Renewal approval required: ${licence.recordCode ?? id}`,
      body: `${licence.application.name} — annualised cost ${annualised} ${licence.currency}. Proposed by the requester; the Self-Dealing Bar means they cannot decide it.`,
      severity: 'S2_WARNING',
      subjectType: 'approval_step',
      subjectId: step.id,
      drillPath: `/it/licences/${id}`,
    });
  } else {
    await raiseException({
      code: 'EX-GOV-001',
      label: 'Nobody could be found to approve this licence renewal',
      severity: 'S3_HIGH_RISK',
      subjectType: 'approval_step',
      subjectId: step.id,
      subjectLabel: licence.recordCode ?? id,
      domain: IT_DOMAIN,
      detail: `No active Finance Head or chairman affiliation could be resolved to decide ${licence.recordCode ?? id}'s renewal.`,
      reasonCode: 'approver_unresolved',
    });
  }

  return {
    applied: false,
    licence: updated,
    approvalStepId: step.id,
    resolvedApproverRole: approver?.roleSlug ?? 'finance_head',
    reason: 'Awaiting approval — a licence renewal is never applied by the person who proposed it.',
  };
}

/**
 * Decides an open renewal proposal. Requires `it_licences:approve`
 * (Finance Head or the chairman per the matrix); `decideApprovalStep`
 * itself refuses a decider who is also the requester — the Self-Dealing Bar
 * (IT-LIC-003).
 */
export async function approveRenewal(id: string, approve: boolean, note = ''): Promise<RenewalGateResult> {
  const auth = currentAuth();
  const licence = await loadLicence(id);
  await assertCan({ resource: 'it_licences', verb: 'approve' });

  if (!licence.pendingRenewalApprovalStepId) {
    throw ApiError.conflict(`${licence.recordCode ?? id} has no renewal proposal awaiting a decision.`);
  }

  const decided = await decideApprovalStep(licence.pendingRenewalApprovalStepId, approve, note);

  if (!approve) {
    const cleared = await prisma.itLicence.update({
      where: { id },
      data: {
        pendingRenewalApprovalStepId: null,
        pendingRenewalProposedById: null,
        pendingRenewalTermEnd: null,
        pendingRenewalCostPerPeriod: null,
        pendingRenewalNote: null,
      },
    });
    await prisma.itLicenceEvent.create({
      data: { tenantId: auth.tenantId, licenceId: id, kind: 'renewal_declined', actorPartyId: auth.partyId, note: note || null },
    });
    await auditWrite({ action: 'update', subjectType: 'it_licence', subjectId: id, before: { status: licence.status }, after: { renewalDeclined: true } });
    return { applied: false, licence: cleared, approvalStepId: decided.id, resolvedApproverRole: decided.resolvedApproverRole, reason: 'Declined.' };
  }

  const updated = await prisma.itLicence.update({
    where: { id },
    data: {
      status: 'active',
      termEnd: licence.pendingRenewalTermEnd ?? licence.termEnd,
      renewalDate: licence.pendingRenewalTermEnd ?? licence.renewalDate,
      costPerPeriod: licence.pendingRenewalCostPerPeriod ?? licence.costPerPeriod,
      renewalNotifiedRungs: [],
      pendingRenewalApprovalStepId: null,
      pendingRenewalProposedById: null,
      pendingRenewalTermEnd: null,
      pendingRenewalCostPerPeriod: null,
      pendingRenewalNote: null,
    },
  });

  await prisma.itLicenceEvent.create({
    data: {
      tenantId: auth.tenantId,
      licenceId: id,
      kind: 'renewal_approved',
      actorPartyId: auth.partyId,
      note: note || null,
      detail: { termEnd: updated.termEnd, costPerPeriod: num(updated.costPerPeriod) },
    },
  });
  await auditWrite({ action: 'update', subjectType: 'it_licence', subjectId: id, before: { status: licence.status }, after: { status: 'active', termEnd: updated.termEnd } });
  await emit({
    name: EVENTS.IT_LICENCE_RENEWED,
    subject: { entityType: 'it_licence', entityId: id, recordCode: licence.recordCode },
    previousState: { termEnd: licence.termEnd },
    newState: { termEnd: updated.termEnd, costPerPeriod: num(updated.costPerPeriod) },
    owner: { partyId: licence.application.ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return { applied: true, licence: updated, approvalStepId: decided.id, resolvedApproverRole: decided.resolvedApproverRole, reason: 'Renewed.' };
}

export async function cancelLicence(id: string, reason: string) {
  const auth = currentAuth();
  const licence = await loadLicence(id);
  await assertCan({ resource: 'it_licences', verb: 'edit', record: { ownerPartyId: licence.application.ownerPartyId } });

  const trimmed = reason?.trim();
  if (!trimmed) throw ApiError.badRequest('Cancelling a licence needs a reason — it is a decision, not a shrug.');
  if (licence.status === 'cancelled') throw ApiError.conflict(`${licence.recordCode ?? id} is already cancelled.`);

  const updated = await prisma.itLicence.update({
    where: { id },
    data: {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledReason: trimmed,
      pendingRenewalApprovalStepId: null,
      pendingRenewalProposedById: null,
      pendingRenewalTermEnd: null,
      pendingRenewalCostPerPeriod: null,
      pendingRenewalNote: null,
    },
  });

  await prisma.itLicenceEvent.create({
    data: { tenantId: auth.tenantId, licenceId: id, kind: 'cancelled', actorPartyId: auth.partyId, note: trimmed },
  });
  await auditWrite({ action: 'update', subjectType: 'it_licence', subjectId: id, before: { status: licence.status }, after: { status: 'cancelled', reason: trimmed } });
  await emit({
    name: EVENTS.IT_LICENCE_CANCELLED,
    subject: { entityType: 'it_licence', entityId: id, recordCode: licence.recordCode },
    previousState: { status: licence.status },
    newState: { status: 'cancelled', reason: trimmed },
    owner: { partyId: licence.application.ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Ladder / exception detectors (called by the daily job)
// ---------------------------------------------------------------------------

export async function runRenewalLadder(): Promise<{ notified: number; flippedToExpiring: number; flippedToExpired: number }> {
  const auth = currentAuth();
  const threshold = await currentThreshold();
  const rungs = threshold?.renewalLadderRungs ?? undefined;

  const rows = await prisma.itLicence.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, status: { in: ['active', 'expiring'] }, renewalDate: { not: null } },
    include: { application: true },
  });

  let notified = 0;
  let flippedToExpiring = 0;
  let flippedToExpired = 0;
  const now = new Date();

  for (const row of rows) {
    const daysLeft = daysUntilLicenceDate(row.renewalDate as Date, now);
    const newStatus = daysLeft < 0 ? 'expired' : daysLeft <= 90 ? 'expiring' : row.status;
    if (newStatus !== row.status) {
      await prisma.itLicence.update({ where: { id: row.id }, data: { status: newStatus } });
      if (newStatus === 'expiring') flippedToExpiring += 1;
      if (newStatus === 'expired') flippedToExpired += 1;
    }

    const rung = renewalRung(daysLeft, rungs);
    if (rung === null) continue;

    const already = row.renewalNotifiedRungs ?? [];
    if (already.includes(rung)) continue;

    const overdue = rung <= 0;
    await raiseException({
      code: overdue ? 'IT_LIC_EXPIRED' : 'IT_LIC_RENEWAL_DUE',
      label: overdue ? `${row.application.name} licence expired` : `${row.application.name} licence renews in ${rung} day${rung === 1 ? '' : 's'}`,
      severity: overdue ? 'S3_HIGH_RISK' : rung <= 7 ? 'S2_WARNING' : 'S1_ATTENTION',
      subjectType: 'it_licence',
      subjectId: row.id,
      subjectLabel: row.recordCode ?? row.application.name,
      domain: IT_DOMAIN,
      detail: overdue
        ? `${row.application.name}'s licence renewal date has passed with no renewal recorded.`
        : `${row.application.name}'s licence renews in ${rung} day${rung === 1 ? '' : 's'} (${(row.renewalDate as Date).toISOString().slice(0, 10)}).`,
      ownerPartyId: row.application.ownerPartyId,
      slaDueAt: row.renewalDate,
      triggerFingerprint: 'it_licence_renewal_ladder',
      ladderRung: rung,
    });
    notified += 1;

    await prisma.itLicence.update({
      where: { id: row.id },
      data: { renewalNotifiedRungs: [...new Set([...already, rung])] },
    });
  }

  return { notified, flippedToExpiring, flippedToExpired };
}

export async function runSeatExceptionSweep(): Promise<{ overAllocated: number; underUsed: number }> {
  const auth = currentAuth();
  const threshold = await currentThreshold();
  const underUsePercent = threshold?.underUsePercent ?? 30;
  const underUseMinSeats = threshold?.underUseMinSeats ?? 5;

  const rows = await prisma.itLicence.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, status: { in: ['active', 'expiring'] } },
    include: { application: true },
  });

  let overAllocated = 0;
  let underUsed = 0;

  for (const row of rows) {
    const util = seatUtilisation(row.seatsPurchased, row.seatsInUse);
    if (util.overAllocated) {
      await raiseException({
        code: 'IT_LIC_SEAT_OVERALLOCATED',
        label: `${row.application.name} has more seats in use than purchased`,
        severity: 'S2_WARNING',
        subjectType: 'it_licence',
        subjectId: row.id,
        subjectLabel: row.recordCode ?? row.application.name,
        domain: IT_DOMAIN,
        detail: `${row.seatsInUse} seats in use against ${row.seatsPurchased} purchased.`,
        ownerPartyId: row.application.ownerPartyId,
        triggerFingerprint: 'it_licence_seat_overallocated',
      });
      await prisma.itLicence.update({ where: { id: row.id }, data: { overAllocationNotifiedAt: new Date() } });
      overAllocated += 1;
    }

    if (isUnderUsed(row.seatsPurchased, row.seatsInUse, underUsePercent, underUseMinSeats)) {
      await raiseException({
        code: 'IT_LIC_SEAT_UNDERUSED',
        label: `${row.application.name} is under-used`,
        severity: 'S1_ATTENTION',
        subjectType: 'it_licence',
        subjectId: row.id,
        subjectLabel: row.recordCode ?? row.application.name,
        domain: IT_DOMAIN,
        detail: `${row.seatsInUse} of ${row.seatsPurchased} seats in use (${util.percent}%), below the ${underUsePercent}% threshold judged on licences of at least ${underUseMinSeats} seats.`,
        ownerPartyId: row.application.ownerPartyId,
        triggerFingerprint: 'it_licence_seat_underused',
      });
      await prisma.itLicence.update({ where: { id: row.id }, data: { underUseNotifiedAt: new Date() } });
      underUsed += 1;
    }
  }

  return { overAllocated, underUsed };
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export interface ApplicationsSummary extends ItSummaryBase {
  byTier: Record<string, number>;
  byHosting: Record<string, number>;
  byStatus: Record<string, number>;
  unowned: number;
}

export async function applicationsSummary(): Promise<ApplicationsSummary> {
  const auth = currentAuth();
  await assertCan({ resource: 'it_applications', verb: 'view' });

  const apps = await prisma.itApplication.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } });
  if (apps.length === 0) {
    return {
      notYetMeasured: true,
      byTier: {},
      byHosting: { saas: 0, on_prem: 0, cloud: 0 },
      byStatus: { evaluating: 0, active: 0, sunsetting: 0, retired: 0 },
      unowned: 0,
    };
  }

  const byTier: Record<string, number> = {};
  const byHosting: Record<string, number> = { saas: 0, on_prem: 0, cloud: 0 };
  const byStatus: Record<string, number> = { evaluating: 0, active: 0, sunsetting: 0, retired: 0 };
  let unowned = 0;
  for (const a of apps) {
    byTier[a.tier] = (byTier[a.tier] ?? 0) + 1;
    byHosting[a.hosting] = (byHosting[a.hosting] ?? 0) + 1;
    byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    if (!a.ownerPartyId) unowned += 1;
  }

  return { notYetMeasured: false, byTier, byHosting, byStatus, unowned };
}

export interface LicencesSummary extends ItSummaryBase {
  /** `null` — present, withheld — for a caller without `it_licences:financial`. */
  annualisedSpend: number | null;
  annualisedSpendByApplication: Array<{ applicationId: string; applicationName: string; annualisedCost: number | null }>;
  renewingIn90Days: number;
  overAllocated: number;
  underUsed: number;
  seatsPurchased: number;
  seatsInUse: number;
}

export async function licencesSummary(): Promise<LicencesSummary> {
  const auth = currentAuth();
  await assertCan({ resource: 'it_licences', verb: 'view' });
  const seesMoney = await canSeeMoney('it_licences');

  const rows = await prisma.itLicence.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, status: { not: 'cancelled' } },
    include: { application: true },
  });
  if (rows.length === 0) {
    return {
      notYetMeasured: true,
      annualisedSpend: seesMoney ? 0 : null,
      annualisedSpendByApplication: [],
      renewingIn90Days: 0,
      overAllocated: 0,
      underUsed: 0,
      seatsPurchased: 0,
      seatsInUse: 0,
    };
  }

  const threshold = await currentThreshold();
  const underUsePercent = threshold?.underUsePercent ?? 30;
  const underUseMinSeats = threshold?.underUseMinSeats ?? 5;

  const byApp = new Map<string, { applicationId: string; applicationName: string; annualisedCost: number }>();
  let renewingIn90Days = 0;
  let overAllocated = 0;
  let underUsed = 0;
  let seatsPurchased = 0;
  let seatsInUse = 0;
  const now = new Date();

  for (const row of rows) {
    const cost = annualisedCost(num(row.costPerPeriod), row.billingCycle as ItBillingCycle);
    const existing = byApp.get(row.applicationId);
    byApp.set(row.applicationId, {
      applicationId: row.applicationId,
      applicationName: row.application.name,
      annualisedCost: (existing?.annualisedCost ?? 0) + cost,
    });

    if (row.renewalDate && daysUntilLicenceDate(row.renewalDate, now) <= 90 && daysUntilLicenceDate(row.renewalDate, now) >= 0) {
      renewingIn90Days += 1;
    }
    if (seatUtilisation(row.seatsPurchased, row.seatsInUse).overAllocated) overAllocated += 1;
    if (isUnderUsed(row.seatsPurchased, row.seatsInUse, underUsePercent, underUseMinSeats)) underUsed += 1;
    seatsPurchased += row.seatsPurchased;
    seatsInUse += row.seatsInUse;
  }

  const spendByApplication = [...byApp.values()].sort((a, b) => b.annualisedCost - a.annualisedCost);

  return {
    notYetMeasured: false,
    annualisedSpend: seesMoney
      ? totalAnnualisedSpend(rows.map((r) => ({ costPerPeriod: num(r.costPerPeriod), billingCycle: r.billingCycle as ItBillingCycle })))
      : null,
    annualisedSpendByApplication: seesMoney
      ? spendByApplication
      : spendByApplication.map((a) => ({ ...a, annualisedCost: null })),
    renewingIn90Days,
    overAllocated,
    underUsed,
    seatsPurchased,
    seatsInUse,
  };
}
