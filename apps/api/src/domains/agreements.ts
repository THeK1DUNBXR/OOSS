/**
 * MoU, Contract and Partner Agreement.
 *
 * These are NOT a supertype/subtype family. They share a design pattern —
 * state machine shape, expiry-escalation-ladder shape, POLICY-gated
 * privileged-transition shape — because the underlying business facts are
 * genuinely different: an MoU is a coverage instrument that may carry zero
 * commercial value; a contract is always a priced commitment; a partner
 * agreement formalises a channel relationship. Modelling MoU as "a contract
 * with a flag" would lose the one-MoU-to-many-contracts shape entirely.
 *
 * All three run the identical approval gate — instantiated, not re-derived.
 */

import {
  CONTRACT_EXPIRY_LADDER,
  CONTRACT_USER_TRANSITIONS,
  EVENTS,
  MOU_EXPIRY_LADDER,
  MOU_USER_TRANSITIONS,
  PRIVILEGED_TARGET_STATUSES,
  type AgreementType,
  type SeverityCode,
} from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan } from '../platform/permissions.js';
import { evaluateApprovalGate } from '../platform/approvals.js';
import { raiseException } from '../platform/exceptions.js';
import { createRelationship } from './relationships.js';

export type AgreementKind = 'mou' | 'contract' | 'partner_agreement';

// ---------------------------------------------------------------------------
// MoU
// ---------------------------------------------------------------------------

export async function createMou(input: {
  title: string;
  organizationId?: string | null;
  institutionId?: string | null;
  opportunityId?: string | null;
  scope?: string | null;
  vertical?: string | null;
  commercialValue?: number | null;
  currency?: string;
  strategicValue?: string | null;
  termMonths?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
  renewedFromId?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'mous', verb: 'create' });

  if (!input.organizationId && !input.institutionId) {
    throw ApiError.badRequest('An MoU requires at least one of organization_id or institution_id.');
  }

  const recordCode = await nextRecordCode('MOU');
  const mou = await prisma.mou.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title,
      organizationId: input.organizationId ?? null,
      institutionId: input.institutionId ?? null,
      opportunityId: input.opportunityId ?? null,
      scope: input.scope ?? null,
      vertical: input.vertical ?? null,
      status: 'proposed',
      // Zero is a valid coverage-instrument state for an MoU.
      commercialValue: input.commercialValue ?? 0,
      currency: input.currency ?? 'INR',
      strategicValue: input.strategicValue ?? null,
      termMonths: input.termMonths ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      renewedFromId: input.renewedFromId ?? null,
      ownerPartyId: auth.partyId,
      createdById: auth.partyId,
    },
  });

  if (input.opportunityId) {
    await prisma.opportunity.update({ where: { id: input.opportunityId }, data: { mouId: mou.id } });
  }

  await auditWrite({ action: 'create', subjectType: 'mou', subjectId: mou.id, after: { recordCode, title: mou.title } });
  await emit({
    name: EVENTS.MOU_CREATED,
    subject: { entityType: 'mou', entityId: mou.id, recordCode },
    related: input.organizationId ? [{ relation: 'covers', entityType: 'organization', entityId: input.organizationId }] : [],
    newState: { status: 'proposed', commercialValue: input.commercialValue ?? 0 },
    confidentiality: 'confidential',
  });

  return mou;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export async function createContract(input: {
  title: string;
  organizationId?: string | null;
  accountId?: string | null;
  opportunityId?: string | null;
  quoteId?: string | null;
  commercialValue: number;
  currency?: string;
  strategicValue?: string | null;
  termMonths?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
  renewedFromId?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'contracts', verb: 'create' });

  // Unlike MoU, where zero is valid, an unpriced contract is a modelling error.
  if (!(input.commercialValue > 0)) {
    throw ApiError.unprocessable('A contract must carry a commercial_value greater than zero. An unpriced contract is a modelling error, not a coverage instrument — use an MoU for that.');
  }

  const recordCode = await nextRecordCode('CON');
  const contract = await prisma.contract.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title,
      organizationId: input.organizationId ?? null,
      accountId: input.accountId ?? null,
      opportunityId: input.opportunityId ?? null,
      quoteId: input.quoteId ?? null,
      status: 'proposed',
      commercialValue: input.commercialValue,
      currency: input.currency ?? 'INR',
      strategicValue: input.strategicValue ?? null,
      termMonths: input.termMonths ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      renewedFromId: input.renewedFromId ?? null,
      ownerPartyId: auth.partyId,
      createdById: auth.partyId,
    },
  });

  if (input.opportunityId) {
    await prisma.opportunity.update({ where: { id: input.opportunityId }, data: { contractId: contract.id } });
  }

  await auditWrite({ action: 'create', subjectType: 'contract', subjectId: contract.id, after: { recordCode } });
  await emit({
    name: EVENTS.CONTRACT_CREATED,
    subject: { entityType: 'contract', entityId: contract.id, recordCode },
    newState: { status: 'proposed', commercialValue: input.commercialValue },
    confidentiality: 'confidential',
  });

  return contract;
}

// ---------------------------------------------------------------------------
// Partner Agreement
// ---------------------------------------------------------------------------

/**
 * Creation is blocked without an existing or atomically-created `partner_of`
 * relationship edge — the agreement formalises a relationship that must exist
 * as a recorded fact, not a speculative one.
 */
export async function createPartnerAgreement(input: {
  title: string;
  partnerOrganizationId: string;
  agreementType: AgreementType;
  scope?: string | null;
  territoryScope?: string | null;
  commercialValue?: number | null;
  currency?: string;
  strategicValue?: string | null;
  termMonths?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'partner_agreements', verb: 'create' });

  let relationship = await prisma.relationship.findFirst({
    where: {
      tenantId: auth.tenantId,
      relationshipType: 'partner_of',
      status: 'active',
      OR: [
        { toType: 'organization', toId: input.partnerOrganizationId },
        { fromType: 'organization', fromId: input.partnerOrganizationId },
      ],
    },
  });

  if (!relationship) {
    relationship = await createRelationship({
      fromType: 'organization',
      fromId: 'kaizen',
      toType: 'organization',
      toId: input.partnerOrganizationId,
      relationshipType: 'partner_of',
      role: input.agreementType,
      strength: 'moderate',
    });
  }

  // EX-CRM-013: two active agreements of the same channel type with the same
  // partner is a dual-channel conflict, not a normal state.
  const existing = await prisma.partnerAgreement.findFirst({
    where: {
      tenantId: auth.tenantId,
      partnerOrganizationId: input.partnerOrganizationId,
      agreementType: input.agreementType,
      status: { in: ['signed', 'active'] },
      deletedAt: null,
    },
  });

  const recordCode = await nextRecordCode('PA');
  const agreement = await prisma.partnerAgreement.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title,
      partnerOrganizationId: input.partnerOrganizationId,
      relationshipId: relationship.id,
      agreementType: input.agreementType,
      scope: input.scope ?? null,
      territoryScope: input.territoryScope ?? null,
      status: 'proposed',
      commercialValue: input.commercialValue ?? 0,
      currency: input.currency ?? 'INR',
      strategicValue: input.strategicValue ?? null,
      termMonths: input.termMonths ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      ownerPartyId: auth.partyId,
      createdById: auth.partyId,
    },
  });

  if (existing) {
    await raiseException({
      code: 'EX-CRM-013',
      label: 'Dual-channel partner conflict',
      severity: 'S2_WARNING',
      subjectType: 'partner_agreement',
      subjectId: agreement.id,
      subjectLabel: `${recordCode} — ${input.title}`,
      detail: `An active ${input.agreementType} agreement (${existing.recordCode}) already covers this partner. Two channels for the same motion conflict on attribution.`,
      ownerPartyId: auth.partyId,
      reasonCode: 'dual_channel_conflict',
    });
  }

  await emit({
    name: EVENTS.PARTNER_AGREEMENT_CREATED,
    subject: { entityType: 'partner_agreement', entityId: agreement.id, recordCode },
    related: [{ relation: 'with', entityType: 'organization', entityId: input.partnerOrganizationId }],
    newState: { agreementType: input.agreementType, status: 'proposed' },
    confidentiality: 'confidential',
  });

  return agreement;
}

// ---------------------------------------------------------------------------
// The shared state machine, running the shared approval gate
// ---------------------------------------------------------------------------

const POLICY_CODE: Record<AgreementKind, string> = {
  mou: 'POL-CRM-MOU-APPROVAL',
  contract: 'POL-CRM-CONTRACT-APPROVAL',
  partner_agreement: 'POL-CRM-PARTNER-APPROVAL',
};

async function loadAgreement(kind: AgreementKind, id: string) {
  if (kind === 'mou') return prisma.mou.findFirst({ where: { id } });
  if (kind === 'contract') return prisma.contract.findFirst({ where: { id } });
  return prisma.partnerAgreement.findFirst({ where: { id } });
}

async function updateAgreement(kind: AgreementKind, id: string, data: Record<string, unknown>) {
  if (kind === 'mou') return prisma.mou.update({ where: { id }, data: data as never });
  if (kind === 'contract') return prisma.contract.update({ where: { id }, data: data as never });
  return prisma.partnerAgreement.update({ where: { id }, data: data as never });
}

export interface TransitionResult {
  applied: boolean;
  agreement: Record<string, unknown>;
  approvalStepId: string | null;
  reason: string;
}

export async function transitionAgreement(
  kind: AgreementKind,
  id: string,
  toStatus: string,
  note = '',
): Promise<TransitionResult> {
  const agreement = (await loadAgreement(kind, id)) as Record<string, unknown> | null;
  if (!agreement) throw ApiError.notFound('Agreement');

  const from = agreement.status as string;
  const map = kind === 'contract' ? CONTRACT_USER_TRANSITIONS : MOU_USER_TRANSITIONS;
  const allowed = map[from] ?? [];

  // expiring / expired / renewed are job-driven, never user transitions.
  if (['expiring', 'expired', 'renewed'].includes(toStatus)) {
    throw ApiError.unprocessable(
      `'${toStatus}' is a job-driven status derived from the expiry ladder, never a user transition.`,
    );
  }
  if (!allowed.includes(toStatus)) {
    throw ApiError.unprocessable(`No permitted transition from '${from}' to '${toStatus}' on a ${kind}.`);
  }

  // Privileged transitions run the gate.
  if ((PRIVILEGED_TARGET_STATUSES as readonly string[]).includes(toStatus)) {
    const gate = await evaluateApprovalGate(
      POLICY_CODE[kind],
      {
        id,
        type: kind,
        label: `${agreement.recordCode} — ${agreement.title}`,
        ownerPartyId: (agreement.ownerPartyId as string | null) ?? null,
        commercialValue: num(agreement.commercialValue as never),
        currency: (agreement.currency as string) ?? 'INR',
        strategicValue: (agreement.strategicValue as string | null) ?? null,
        termMonths: (agreement.termMonths as number | null) ?? null,
      },
      `${kind}.${toStatus}`,
    );

    if (!gate.permitted) {
      return {
        applied: false,
        agreement,
        approvalStepId: gate.approvalStepId,
        reason: gate.reason,
      };
    }
  } else {
    await assertCan({ resource: `${kind}s`, verb: 'edit', record: { ownerPartyId: agreement.ownerPartyId as string | null } });
  }

  const auth = currentAuth();
  const patch: Record<string, unknown> = { status: toStatus };
  if (toStatus === 'approved') {
    patch.approvedById = auth.partyId;
    patch.approvedAt = new Date();
  }
  if (toStatus === 'signed') {
    patch.signedById = auth.partyId;
    patch.signedDate = new Date();
  }
  if (toStatus === 'terminated') {
    patch.terminatedAt = new Date();
    patch.terminationReason = note;
  }

  const updated = (await updateAgreement(kind, id, patch)) as Record<string, unknown>;

  await auditWrite({
    action: 'update',
    subjectType: kind,
    subjectId: id,
    before: { status: from },
    after: { status: toStatus },
    meta: { note },
  });

  const eventName =
    kind === 'mou'
      ? EVENTS.MOU_STATUS_CHANGED
      : kind === 'contract'
        ? toStatus === 'signed'
          ? EVENTS.CONTRACT_SIGNED
          : toStatus === 'terminated'
            ? EVENTS.CONTRACT_TERMINATED
            : EVENTS.CONTRACT_STATUS_CHANGED
        : EVENTS.PARTNER_AGREEMENT_STATUS_CHANGED;

  await emit({
    name: eventName,
    subject: { entityType: kind, entityId: id, recordCode: agreement.recordCode as string },
    related: agreement.opportunityId
      ? [{ relation: 'formalizes', entityType: 'opportunity', entityId: agreement.opportunityId as string }]
      : [],
    previousState: { status: from },
    newState: {
      status: toStatus,
      commercialValue: num(agreement.commercialValue as never),
      currency: agreement.currency,
      startDate: agreement.startDate,
      endDate: agreement.endDate,
    },
    reason: { reasonCode: `${kind}_${toStatus}`, note },
    impact: {
      domains: kind === 'contract' && toStatus === 'signed' ? ['crm', 'fin', 'prj'] : ['crm'],
      materiality: agreement.commercialValue
        ? { measure: `${kind}_value`, value: num(agreement.commercialValue as never)!, currency: (agreement.currency as string) ?? 'INR' }
        : null,
    },
    // The load-bearing cross-domain event: Finance subscribes for billing
    // schedule publication, deriving revenue recognition from the offering's
    // default treatment rather than asking sales.
    confidentiality: 'confidential',
  });

  return { applied: true, agreement: updated, approvalStepId: null, reason: `Transitioned ${from} -> ${toStatus}.` };
}

// ---------------------------------------------------------------------------
// Expiry ladders. Each rung is idempotent — it does not re-notify on a repeat
// evaluation of an already-notified rung.
// ---------------------------------------------------------------------------

export async function runExpiryLadder(kind: 'mou' | 'contract' | 'partner_agreement'): Promise<number> {
  const auth = currentAuth();
  const ladder: readonly number[] = kind === 'contract' ? CONTRACT_EXPIRY_LADDER : MOU_EXPIRY_LADDER;
  const now = new Date();

  const rows =
    kind === 'mou'
      ? await prisma.mou.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, status: { in: ['signed', 'active', 'expiring'] }, endDate: { not: null } } })
      : kind === 'contract'
        ? await prisma.contract.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, status: { in: ['signed', 'active', 'expiring'] }, endDate: { not: null } } })
        : await prisma.partnerAgreement.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, status: { in: ['signed', 'active', 'expiring'] }, endDate: { not: null } } });

  let notified = 0;

  for (const row of rows as Array<Record<string, unknown>>) {
    const endDate = row.endDate as Date;
    const daysToExpiry = Math.ceil((endDate.getTime() - now.getTime()) / 86_400_000);
    const already = (row.expiryNotifiedDays as number[]) ?? [];

    if (daysToExpiry < 0) {
      if (row.status !== 'expired') {
        await updateAgreement(kind, row.id as string, { status: 'expired' });
        await emit({
          name: kind === 'mou' ? EVENTS.MOU_EXPIRED : EVENTS.CONTRACT_EXPIRED,
          subject: { entityType: kind, entityId: row.id as string, recordCode: row.recordCode as string },
          previousState: { status: row.status },
          newState: { status: 'expired' },
          impact: { domains: ['crm'], severity: 'S2_WARNING' },
        });
      }
      continue;
    }

    // Every rung the runway has already passed. The ladder is ordered widest
    // first, so this is every entry at or above the remaining days.
    const crossed = ladder.filter((r) => daysToExpiry <= r);

    // The *tightest* crossed rung is the one that describes the situation now.
    // Taking the widest instead would fire 90, then 60, then 30 on three
    // successive runs for an agreement first seen at 25 days out — three
    // notifications about two rungs that are already history.
    const rung = crossed.length ? crossed[crossed.length - 1] : undefined;
    if (rung === undefined || already.includes(rung)) continue;

    // Severity climbs as the runway shortens.
    const idx = ladder.indexOf(rung);
    const severity: SeverityCode = (['S1_ATTENTION', 'S2_WARNING', 'S3_HIGH_RISK', 'S4_CRITICAL'] as const)[idx] ?? 'S2_WARNING';

    await raiseException({
      code: kind === 'mou' ? 'EX-CRM-014' : 'EX-PCT-001',
      label: `${kind === 'mou' ? 'MoU' : kind === 'contract' ? 'Contract' : 'Partner agreement'} expiry approaching`,
      severity,
      subjectType: kind,
      subjectId: row.id as string,
      subjectLabel: `${row.recordCode} — ${row.title}`,
      domain: 'crm',
      detail: `${daysToExpiry} days to expiry (${rung}-day rung). Open a renewal or let it lapse deliberately.`,
      ownerPartyId: (row.ownerPartyId as string | null) ?? null,
      triggerFingerprint: `${kind}_expiry_ladder`,
      ladderRung: rung,
    });

    // Every crossed rung is recorded, not just the one notified: a wider rung
    // the agreement passed before anyone was watching is spent, and must not
    // fire later as though it had just been reached.
    await updateAgreement(kind, row.id as string, {
      status: 'expiring',
      expiryNotifiedDays: [...new Set([...already, ...crossed])],
    });

    await emit({
      name: kind === 'mou' ? EVENTS.MOU_EXPIRY_APPROACHING : EVENTS.CONTRACT_EXPIRING,
      subject: { entityType: kind, entityId: row.id as string, recordCode: row.recordCode as string },
      newState: { daysToExpiry, rung },
      impact: { domains: ['crm'], severity },
      owner: { partyId: (row.ownerPartyId as string | null) ?? null },
    });

    notified += 1;
  }

  return notified;
}

/** Renewal chains, never mutating the predecessor. */
export async function renewAgreement(kind: AgreementKind, id: string, endDate: Date) {
  const existing = (await loadAgreement(kind, id)) as Record<string, unknown> | null;
  if (!existing) throw ApiError.notFound('Agreement');

  const base = {
    title: `${existing.title} (renewed)`,
    organizationId: existing.organizationId as string | null,
    commercialValue: num(existing.commercialValue as never) ?? 0,
    currency: existing.currency as string,
    strategicValue: existing.strategicValue as string | null,
    termMonths: existing.termMonths as number | null,
    startDate: new Date(),
    endDate,
    renewedFromId: id,
  };

  const renewal =
    kind === 'mou'
      ? await createMou({ ...base, institutionId: existing.institutionId as string | null })
      : kind === 'contract'
        ? await createContract({ ...base, commercialValue: base.commercialValue || 1 })
        : await createPartnerAgreement({
            title: base.title,
            partnerOrganizationId: existing.partnerOrganizationId as string,
            agreementType: existing.agreementType as AgreementType,
            commercialValue: base.commercialValue,
            currency: base.currency,
            startDate: base.startDate,
            endDate,
          });

  await updateAgreement(kind, id, { status: 'renewed' });
  await emit({
    name: EVENTS.MOU_RENEWED,
    subject: { entityType: kind, entityId: id, recordCode: existing.recordCode as string },
    related: [{ relation: 'renewed_as', entityType: kind, entityId: renewal.id }],
    newState: { status: 'renewed', renewalId: renewal.id },
  });

  return renewal;
}

/**
 * EX-CRM-011 remains available as a manual data-integrity check, so it
 * functions as a true exception rather than depending on the service-layer
 * block for its only enforcement.
 */
export async function auditWonWithoutContract(): Promise<number> {
  const auth = currentAuth();
  const offenders = await prisma.opportunity.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, outcome: 'won', contractId: null, mouId: null },
    take: 200,
  });

  for (const opp of offenders) {
    await raiseException({
      code: 'EX-CRM-011',
      label: 'Won without contract or MoU reference',
      severity: 'S3_HIGH_RISK',
      subjectType: 'opportunity',
      subjectId: opp.id,
      subjectLabel: `${opp.recordCode} — ${opp.title}`,
      detail: 'A won opportunity carries neither a contract nor an MoU reference. This should be impossible through the service layer — investigate the path that produced it.',
      ownerPartyId: opp.ownerPartyId,
      reasonCode: 'won_without_award_artefact',
      triggerFingerprint: 'won_without_contract_sweep',
      ladderRung: 1,
    });
  }
  return offenders.length;
}
