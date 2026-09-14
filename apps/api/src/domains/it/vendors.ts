/**
 * Technology — vendors and contracts (docs/plan/cio.md, workstream C).
 *
 * `ItVendor` is the master `VendorBill.vendorName` should have pointed at:
 * category, tier, a dated risk rating, a security-assessment status due on a
 * cadence the tenant can tune (`ItVendorAssessmentCadenceRule`), and whether
 * a DPA is on file. `ItVendorContract` is the priced, dated instrument that
 * governs the relationship, running the identical approval-gate shape
 * `domains/agreements.ts` runs for MoU/Contract/Partner Agreement — the
 * proposer never approves their own contract (the Self-Dealing Bar), and
 * `expiring`/`expired` are job-driven, never a user transition.
 *
 * No role-slug branch anywhere in this file: `assertCan` and the grant
 * matrix carry the WHO/WHERE axes, and a contract's owner is whoever
 * proposed it, resolved from the authenticated principal, never a lookup by
 * role name.
 */

import {
  EVENTS,
  IT_DOMAIN,
  IT_TIERS,
  VENDOR_ASSESSMENT_CADENCE_MONTHS,
  VENDOR_CONTRACT_USER_TRANSITIONS,
  VENDOR_CONTRACT_PRIVILEGED_STATUSES,
  VENDOR_EVENT_VERBS,
  VENDOR_LADDER_RUNGS,
  vendorStatusMachine,
  addMonths,
  noticeDate,
  noticeRung,
  type ItTier,
  type VendorAssessmentOutcome,
  type VendorContractStatus,
  type VendorEvent,
  type VendorRiskRating,
  type VendorStatus,
} from '@kaizen/shared';
import { prisma, num, dec } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, applyFieldVisibility, canSeeMoney } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';
import { evaluateApprovalGate } from '../../platform/approvals.js';
import { availableTransitions as machineAvailableTransitions } from '../../platform/lifecycle.js';

registerGovernedEntities('it_vendors', ['it_vendor', 'it_vendor_risk_assessment', 'it_vendor_contract']);

// ---------------------------------------------------------------------------
// Assessment cadence
// ---------------------------------------------------------------------------

/** The cadence (months) a vendor's tier is re-assessed on: the dated
 * `ItVendorAssessmentCadenceRule` row when the tenant has one, else the
 * seeded default in shared. Never a constant in domain logic (Principle 4). */
export async function cadenceMonthsForTier(tier: number): Promise<number> {
  const auth = currentAuth();
  const rule = await prisma.itVendorAssessmentCadenceRule.findFirst({ where: { tenantId: auth.tenantId, tier } });
  if (rule) return rule.cadenceMonths;
  return VENDOR_ASSESSMENT_CADENCE_MONTHS[(tier as ItTier) in VENDOR_ASSESSMENT_CADENCE_MONTHS ? (tier as ItTier) : 3];
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

export interface CreateVendorInput {
  name: string;
  organizationId?: string | null;
  category: string;
  tier?: number;
  riskRating?: VendorRiskRating;
  contactName?: string | null;
  contactEmail?: string | null;
  dpaSigned?: boolean;
  notes?: string | null;
}

function assertTier(tier: number) {
  if (!(IT_TIERS as readonly number[]).includes(tier)) {
    throw ApiError.badRequest(`Tier must be one of ${IT_TIERS.join(', ')}.`);
  }
}

export async function createVendor(input: CreateVendorInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_vendors', verb: 'create' });

  if (!input.name?.trim()) throw ApiError.badRequest('A vendor needs a name.');
  const tier = input.tier ?? 3;
  assertTier(tier);

  const cadence = await cadenceMonthsForTier(tier);
  const now = new Date();

  const recordCode = await nextRecordCode('ITV');
  const vendor = await prisma.itVendor.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: input.name.trim(),
      organizationId: input.organizationId ?? null,
      category: input.category,
      tier,
      riskRating: input.riskRating ?? 'medium',
      riskRatedAt: input.riskRating ? now : null,
      assessmentStatus: 'not_assessed',
      assessmentDueAt: addMonths(now, cadence),
      dpaSigned: input.dpaSigned ?? false,
      dpaSignedAt: input.dpaSigned ? now : null,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      status: 'active',
      notes: input.notes ?? null,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_vendor', subjectId: vendor.id, after: { recordCode, name: vendor.name, tier } });
  await emit({
    name: EVENTS.IT_VENDOR_CREATED,
    subject: { entityType: 'it_vendor', entityId: vendor.id, recordCode },
    newState: { name: vendor.name, tier, riskRating: vendor.riskRating },
    impact: { domains: [IT_DOMAIN] },
  });

  return vendor;
}

export interface VendorFilter {
  status?: string;
  tier?: number;
  riskRating?: string;
}

export async function listVendors(filter: VendorFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_vendors', verb: 'view' });
  return prisma.itVendor.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.tier ? { tier: filter.tier } : {}),
      ...(filter.riskRating ? { riskRating: filter.riskRating } : {}),
    },
    orderBy: [{ tier: 'asc' }, { name: 'asc' }],
  });
}

export async function vendorDetail(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_vendors', verb: 'view' });
  const vendor = await prisma.itVendor.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!vendor) throw ApiError.notFound('Vendor');

  const [assessments, contracts] = await Promise.all([
    prisma.itVendorRiskAssessment.findMany({ where: { tenantId: auth.tenantId, vendorId: id }, orderBy: { assessedAt: 'desc' } }),
    prisma.itVendorContract.findMany({ where: { tenantId: auth.tenantId, vendorId: id }, orderBy: { createdAt: 'desc' } }),
  ]);

  return {
    ...vendor,
    availableTransitions: machineAvailableTransitions(vendorStatusMachine, vendor.status as VendorStatus),
    riskAssessments: assessments,
    contracts: contracts.map((c) => ({ ...c, value: num(c.value) })),
  };
}

export interface TransitionVendorInput {
  event: VendorEvent;
  note?: string | null;
}

/** Vendor status lifecycle: active <-> suspended -> offboarded (terminal).
 * Runs the machine directly rather than `platform/lifecycle.ts`'s `transition`
 * helper, which hard-codes the `kz.hr.*` event namespace and `hr` domain —
 * wrong for technology; `availableTransitions` (the generic half) is still
 * reused above so the UI can never render a button the machine would refuse. */
export async function transitionVendor(id: string, input: TransitionVendorInput) {
  const auth = currentAuth();
  const vendor = await prisma.itVendor.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!vendor) throw ApiError.notFound('Vendor');

  await assertCan({ resource: 'it_vendors', verb: 'edit' });

  const from = vendor.status as VendorStatus;
  if (!vendorStatusMachine.can(from, input.event)) {
    throw ApiError.unprocessable(
      `Vendor is ${from}; ${input.event} is not one of its transitions. From here it accepts: ${
        vendorStatusMachine.allowedEvents(from).join(', ') || 'nothing — this is terminal'
      }.`,
    );
  }
  const to = vendorStatusMachine.apply(from, input.event);

  const updated = await prisma.itVendor.update({ where: { id }, data: { status: to } });

  await auditWrite({
    action: 'update',
    subjectType: 'it_vendor',
    subjectId: id,
    before: { status: from },
    after: { status: to },
    meta: { transition: input.event, note: input.note ?? null },
  });

  // No dedicated "vendor transitioned" event exists in the shared IT event
  // block (docs/plan/cio.md, workstream C only names created/assessed/
  // contract_* names) — reusing IT_VENDOR_ASSESSED would misdescribe this as
  // an assessment, so the closest honest choice is IT_VENDOR_CONTRACT_
  // TRANSITIONED's sibling shape reused at the vendor subject: the envelope's
  // `subject.entityType` (`it_vendor`) still disambiguates it from a contract
  // transition for any subscriber. Noted in docs/it/vendors.md.
  await emit({
    name: EVENTS.IT_VENDOR_CONTRACT_TRANSITIONED,
    subject: { entityType: 'it_vendor', entityId: id, recordCode: vendor.recordCode },
    previousState: { status: from },
    newState: { status: to },
    reason: { reasonCode: VENDOR_EVENT_VERBS[input.event], note: input.note ?? null },
    impact: { domains: [IT_DOMAIN] },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Risk assessments
// ---------------------------------------------------------------------------

export interface RecordAssessmentInput {
  assessedAt?: Date | null;
  assessor: string;
  score?: number | null;
  outcome: VendorAssessmentOutcome;
  questionnaire?: unknown;
  notes?: string | null;
  evidenceDocumentId?: string | null;
  /** Optional — an assessment often prompts a fresh risk rating. */
  riskRating?: VendorRiskRating | null;
}

export async function recordAssessment(vendorId: string, input: RecordAssessmentInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_vendors', verb: 'edit' });

  const vendor = await prisma.itVendor.findFirst({ where: { id: vendorId, tenantId: auth.tenantId } });
  if (!vendor) throw ApiError.notFound('Vendor');
  if (!input.assessor?.trim()) throw ApiError.badRequest('An assessment needs an assessor.');

  const assessedAt = input.assessedAt ?? new Date();
  const cadence = await cadenceMonthsForTier(vendor.tier);

  const assessment = await prisma.itVendorRiskAssessment.create({
    data: {
      tenantId: auth.tenantId,
      vendorId,
      assessedAt,
      assessorPartyId: input.assessor,
      score: input.score ?? null,
      outcome: input.outcome,
      questionnaire: (input.questionnaire ?? undefined) as never,
      notes: input.notes ?? null,
      evidenceDocumentId: input.evidenceDocumentId ?? null,
    },
  });

  const updated = await prisma.itVendor.update({
    where: { id: vendorId },
    data: {
      assessmentStatus: input.outcome,
      assessmentDueAt: addMonths(assessedAt, cadence),
      assessmentNotifiedRungs: [],
      ...(input.riskRating ? { riskRating: input.riskRating, riskRatedAt: new Date() } : {}),
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'it_vendor_risk_assessment',
    subjectId: assessment.id,
    after: { vendorId, outcome: input.outcome, score: input.score ?? null },
  });
  await emit({
    name: EVENTS.IT_VENDOR_ASSESSED,
    subject: { entityType: 'it_vendor', entityId: vendorId, recordCode: vendor.recordCode },
    newState: { outcome: input.outcome, assessmentDueAt: updated.assessmentDueAt, riskRating: updated.riskRating },
    impact: { domains: [IT_DOMAIN] },
  });

  return { assessment, vendor: updated };
}

// ---------------------------------------------------------------------------
// Vendor contracts
// ---------------------------------------------------------------------------

export interface CreateContractInput {
  vendorId: string;
  title: string;
  value: number;
  currency?: string;
  termMonths?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
  noticeDays?: number;
  autoRenew?: boolean;
  slaText?: string | null;
  documentId?: string | null;
  renewedFromId?: string | null;
}

export async function createVendorContract(input: CreateContractInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_vendor_contracts', verb: 'create' });

  const vendor = await prisma.itVendor.findFirst({ where: { id: input.vendorId, tenantId: auth.tenantId } });
  if (!vendor) throw ApiError.notFound('Vendor');
  if (!input.title?.trim()) throw ApiError.badRequest('A vendor contract needs a title.');
  if (!(input.value > 0)) throw ApiError.unprocessable('A vendor contract must carry a value greater than zero.');

  const recordCode = await nextRecordCode('VCT');
  const contract = await prisma.itVendorContract.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      vendorId: input.vendorId,
      title: input.title.trim(),
      value: dec(input.value)!,
      currency: input.currency ?? 'INR',
      termMonths: input.termMonths ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      noticeDays: input.noticeDays ?? 30,
      autoRenew: input.autoRenew ?? false,
      slaText: input.slaText ?? null,
      documentId: input.documentId ?? null,
      ownerPartyId: auth.partyId ?? 'system',
      createdById: auth.partyId ?? 'system',
      status: 'draft',
      renewedFromId: input.renewedFromId ?? null,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_vendor_contract', subjectId: contract.id, after: { recordCode, title: contract.title, value: input.value } });
  await emit({
    name: EVENTS.IT_VENDOR_CONTRACT_CREATED,
    subject: { entityType: 'it_vendor_contract', entityId: contract.id, recordCode },
    related: [{ relation: 'with', entityType: 'it_vendor', entityId: input.vendorId }],
    newState: { status: 'draft', value: input.value, currency: contract.currency },
    impact: { domains: [IT_DOMAIN], materiality: { measure: 'it_vendor_contract_value', value: input.value, currency: contract.currency } },
    confidentiality: 'confidential',
  });

  const seesMoney = await canSeeMoney('it_vendor_contracts');
  return maskContractMoney({ ...contract, value: num(contract.value) }, seesMoney, auth.classificationCeiling);
}

export interface ContractFilter {
  status?: string;
  vendorId?: string;
}

/**
 * `value`/`currency` are withheld — present-but-nulled, never a silently
 * dropped key — from any caller who does not hold `it_vendor_contracts:F`
 * (the `financial` verb; Finance Head and chairman hold it, Operations Head
 * does not). `value` runs through the platform's own `applyFieldVisibility`
 * (it is a declared `MONEY_FIELDS` entry); `currency` is not itself money and
 * so is masked alongside it explicitly, the same way `value` is.
 */
function maskContractMoney<T extends Record<string, unknown>>(row: T, seesMoney: boolean, ceiling: Parameters<typeof applyFieldVisibility>[1]['ceiling']): T {
  if (seesMoney) return row;
  const { data } = applyFieldVisibility(row, { canSeeMoney: false, ceiling });
  return { ...data, currency: null } as T;
}

async function decorateContract(
  row: Awaited<ReturnType<typeof prisma.itVendorContract.findFirstOrThrow>> & { vendor?: { name: string } | null },
  seesMoney: boolean,
  ceiling: Parameters<typeof applyFieldVisibility>[1]['ceiling'],
) {
  const value = num(row.value)!;
  let daysToNotice: number | null = null;
  if (row.endDate) {
    const nd = noticeDate(row.endDate, row.noticeDays);
    daysToNotice = Math.ceil((nd.getTime() - Date.now()) / 86_400_000);
  }
  const shaped = {
    ...row,
    value,
    vendorName: row.vendor?.name ?? null,
    daysToNotice,
    availableTransitions: VENDOR_CONTRACT_USER_TRANSITIONS[row.status as VendorContractStatus] ?? [],
    requiresApprovalFor: VENDOR_CONTRACT_PRIVILEGED_STATUSES,
  };
  return maskContractMoney(shaped, seesMoney, ceiling);
}

export async function listVendorContracts(filter: ContractFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_vendor_contracts', verb: 'view' });
  const seesMoney = await canSeeMoney('it_vendor_contracts');
  const rows = await prisma.itVendorContract.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.vendorId ? { vendorId: filter.vendorId } : {}),
    },
    include: { vendor: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(rows.map((r) => decorateContract(r, seesMoney, auth.classificationCeiling)));
}

export async function vendorContractDetail(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_vendor_contracts', verb: 'view' });
  const seesMoney = await canSeeMoney('it_vendor_contracts');
  const row = await prisma.itVendorContract.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { vendor: { select: { name: true } } },
  });
  if (!row) throw ApiError.notFound('Vendor contract');
  return decorateContract(row, seesMoney, auth.classificationCeiling);
}

export interface ContractTransitionResult {
  applied: boolean;
  contract: Record<string, unknown>;
  approvalStepId: string | null;
  resolvedApproverRole: string | null;
  resolutionTier: number;
  selfDealingBarTripped: boolean;
  reason: string;
}

/**
 * Runs the shared status machine plus, on `approved`, the identical
 * approval-gate shape `domains/agreements.ts` runs for a CRM-side contract —
 * the Self-Dealing Bar reroutes a proposer's attempt to approve their own
 * contract to the next tier (IT-VCT-001) rather than throwing.
 */
export async function transitionVendorContract(id: string, toStatus: VendorContractStatus, note = ''): Promise<ContractTransitionResult> {
  const auth = currentAuth();
  const contract = await prisma.itVendorContract.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!contract) throw ApiError.notFound('Vendor contract');

  const from = contract.status as VendorContractStatus;
  if (toStatus === 'expiring' || toStatus === 'expired') {
    throw ApiError.unprocessable(`'${toStatus}' is a job-driven status derived from the notice ladder, never a user transition.`);
  }
  const allowed = VENDOR_CONTRACT_USER_TRANSITIONS[from] ?? [];
  if (!allowed.includes(toStatus)) {
    throw ApiError.unprocessable(`No permitted transition from '${from}' to '${toStatus}' on a vendor contract.`);
  }

  if ((VENDOR_CONTRACT_PRIVILEGED_STATUSES as readonly string[]).includes(toStatus)) {
    const gate = await evaluateApprovalGate(
      'POL-IT-VENDOR-CONTRACT-APPROVAL',
      {
        id,
        type: 'it_vendor_contract',
        label: `${contract.recordCode} — ${contract.title}`,
        ownerPartyId: contract.ownerPartyId,
        commercialValue: num(contract.value),
        currency: contract.currency,
        strategicValue: null,
        termMonths: contract.termMonths,
      },
      `it_vendor_contract.${toStatus}`,
    );

    if (!gate.permitted) {
      const seesMoney = await canSeeMoney('it_vendor_contracts');
      return {
        applied: false,
        contract: maskContractMoney({ ...contract, value: num(contract.value) }, seesMoney, auth.classificationCeiling),
        approvalStepId: gate.approvalStepId,
        resolvedApproverRole: gate.resolvedApproverRole,
        resolutionTier: gate.resolutionTier,
        selfDealingBarTripped: gate.selfDealingBarTripped,
        reason: gate.reason,
      };
    }
  } else {
    await assertCan({ resource: 'it_vendor_contracts', verb: 'edit', record: { ownerPartyId: contract.ownerPartyId } });
  }

  const patch: Record<string, unknown> = { status: toStatus };
  if (toStatus === 'approved') {
    patch.approvedById = auth.partyId;
    patch.approvedAt = new Date();
  }
  if (toStatus === 'terminated') {
    const reason = note?.trim();
    if (!reason) throw ApiError.badRequest('Terminating a vendor contract needs a reason.');
    patch.terminatedAt = new Date();
    patch.terminationReason = reason;
  }

  const updated = await prisma.itVendorContract.update({ where: { id }, data: patch });

  await auditWrite({
    action: 'update',
    subjectType: 'it_vendor_contract',
    subjectId: id,
    before: { status: from },
    after: { status: toStatus },
    meta: { note },
  });
  await emit({
    name: EVENTS.IT_VENDOR_CONTRACT_TRANSITIONED,
    subject: { entityType: 'it_vendor_contract', entityId: id, recordCode: contract.recordCode },
    previousState: { status: from },
    newState: { status: toStatus },
    reason: { reasonCode: `it_vendor_contract_${toStatus}`, note },
    impact: { domains: [IT_DOMAIN] },
    confidentiality: 'confidential',
  });

  const seesMoney = await canSeeMoney('it_vendor_contracts');
  return {
    applied: true,
    contract: maskContractMoney({ ...updated, value: num(updated.value) }, seesMoney, auth.classificationCeiling),
    approvalStepId: null,
    resolvedApproverRole: null,
    resolutionTier: 0,
    selfDealingBarTripped: false,
    reason: `Transitioned ${from} -> ${toStatus}.`,
  };
}

/** Terminating is always available whatever the status machine allows through
 * `transitionVendorContract('terminated', reason)` — this thin wrapper exists
 * only so the route can require the reason before it ever reaches the
 * machine, and so "leaves the approval history intact" (IT-VCT-003) is
 * visibly true: nothing here touches `approvedById`/`approvedAt`. */
export async function terminateVendorContract(id: string, reason: string) {
  return transitionVendorContract(id, 'terminated', reason);
}

export interface RenewContractInput {
  endDate: Date;
  value?: number | null;
  startDate?: Date | null;
  noticeDays?: number | null;
  autoRenew?: boolean | null;
  slaText?: string | null;
}

/** A renewal is a new contract chained by `renewedFromId`, never a mutation
 * of the predecessor — the same discipline `renewAgreement` keeps for
 * MoU/Contract/Partner Agreement. The predecessor's own notice ladder keeps
 * running independently; nothing here forces it to any particular status. */
export async function renewVendorContract(id: string, input: RenewContractInput) {
  const auth = currentAuth();
  const existing = await prisma.itVendorContract.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!existing) throw ApiError.notFound('Vendor contract');

  const renewal = await createVendorContract({
    vendorId: existing.vendorId,
    title: `${existing.title} (renewed)`,
    value: input.value ?? num(existing.value)!,
    currency: existing.currency,
    termMonths: existing.termMonths,
    startDate: input.startDate ?? new Date(),
    endDate: input.endDate,
    noticeDays: input.noticeDays ?? existing.noticeDays,
    autoRenew: input.autoRenew ?? existing.autoRenew,
    slaText: input.slaText ?? existing.slaText,
    renewedFromId: id,
  });

  await auditWrite({
    action: 'update',
    subjectType: 'it_vendor_contract',
    subjectId: id,
    before: {},
    after: { renewedAs: renewal.id },
    meta: { note: 'Renewal chained; predecessor left as-is.' },
  });

  return renewal;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export async function summaryVendors() {
  const auth = currentAuth();
  await assertCan({ resource: 'it_vendors', verb: 'view' });

  const vendors = await prisma.itVendor.findMany({ where: { tenantId: auth.tenantId } });
  if (vendors.length === 0) {
    return {
      notYetMeasured: true,
      byTier: {},
      byRisk: { low: 0, medium: 0, high: 0, critical: 0 },
      assessmentsOverdue: 0,
      highRiskCount: 0,
      highRiskWithDpa: 0,
    };
  }

  const byTier: Record<string, number> = {};
  const byRisk = { low: 0, medium: 0, high: 0, critical: 0 };
  let assessmentsOverdue = 0;
  let highRiskCount = 0;
  let highRiskWithDpa = 0;
  const now = new Date();

  for (const v of vendors) {
    byTier[v.tier] = (byTier[v.tier] ?? 0) + 1;
    byRisk[v.riskRating as keyof typeof byRisk] = (byRisk[v.riskRating as keyof typeof byRisk] ?? 0) + 1;
    if (v.assessmentDueAt && v.assessmentDueAt < now) assessmentsOverdue += 1;
    if (v.riskRating === 'high' || v.riskRating === 'critical') {
      highRiskCount += 1;
      if (v.dpaSigned) highRiskWithDpa += 1;
    }
  }

  return { notYetMeasured: false, byTier, byRisk, assessmentsOverdue, highRiskCount, highRiskWithDpa };
}

export async function summaryContracts() {
  const auth = currentAuth();
  await assertCan({ resource: 'it_vendor_contracts', verb: 'view' });

  const seesMoneyEarly = await canSeeMoney('it_vendor_contracts');
  const rows = await prisma.itVendorContract.findMany({ where: { tenantId: auth.tenantId } });
  if (rows.length === 0) {
    return {
      notYetMeasured: true,
      byStatus: { draft: 0, proposed: 0, approved: 0, active: 0, expiring: 0, expired: 0, terminated: 0 },
      valueUnderManagement: seesMoneyEarly ? 0 : null,
      expiringIn90Days: 0,
      awaitingApproval: 0,
    };
  }

  const byStatus = { draft: 0, proposed: 0, approved: 0, active: 0, expiring: 0, expired: 0, terminated: 0 };
  const now = new Date();
  const in90 = new Date(now.getTime() + 90 * 86_400_000);
  let expiringIn90Days = 0;

  for (const r of rows) {
    byStatus[r.status as keyof typeof byStatus] = (byStatus[r.status as keyof typeof byStatus] ?? 0) + 1;
    if (r.endDate && r.endDate >= now && r.endDate <= in90 && r.status !== 'terminated' && r.status !== 'expired') {
      expiringIn90Days += 1;
    }
  }

  const rawValueUnderManagement = rows.reduce((sum, r) => {
    const inForce = r.status === 'approved' || r.status === 'active' || r.status === 'expiring';
    return inForce ? sum + (num(r.value) ?? 0) : sum;
  }, 0);
  // Present-but-withheld, the same rule a single contract's own `value` field
  // follows (`maskContractMoney`) — a caller without `it_vendor_contracts:F`
  // (Operations Head) never receives an aggregate money figure either.
  const valueUnderManagement = seesMoneyEarly ? rawValueUnderManagement : null;

  const openSteps = await prisma.approvalStep.count({
    where: { tenantId: auth.tenantId, subjectType: 'it_vendor_contract', state: { in: ['open', 'escalated'] } },
  });

  return { notYetMeasured: false, byStatus, valueUnderManagement, expiringIn90Days, awaitingApproval: openSteps };
}

// Re-exported for the notice/assessment ladder jobs.
export { VENDOR_LADDER_RUNGS, noticeRung, noticeDate };
