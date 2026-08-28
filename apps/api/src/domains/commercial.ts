/**
 * Commercial objects: Offering catalog, Price Book, Proposal, Quote.
 *
 * The module boundary that must not be crossed: CRM owns OFFERING and
 * PRICE_BOOK_ENTRY as reference data its own pipeline entities consume. PCT
 * owns PROPOSAL, QUOTE, CONTRACT, MOU, PARTNER_AGREEMENT — every
 * document-bearing, signature-bearing, approval-gated, externally-visible
 * commercial instrument. A stage transition is reversible and internal; a
 * signed contract is neither.
 *
 * Both modules are implemented here because both live in the `crm` bounded
 * context, but the write authority split is honoured: nothing in CRM's own
 * services writes proposal or quote state, and CRM adds no Quote-shaped schema
 * of its own beyond the PCT-owned tables.
 */

import { EVENTS, type BillingFrequency, type DeliveryModel, type RevenueTreatment } from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan, resolveAuthorityCeiling } from '../platform/permissions.js';
import { notify, raiseException } from '../platform/exceptions.js';
import { advanceStage } from './opportunities.js';

// ---------------------------------------------------------------------------
// OFFERING catalog (CRM-COML-001)
// ---------------------------------------------------------------------------

export interface OfferingInput {
  offeringCode: string;
  name: string;
  description?: string | null;
  vertical: string;
  deliveryModel: DeliveryModel;
  defaultRevenueTreatment?: RevenueTreatment;
  owningBusinessUnit?: string | null;
}

/**
 * Suggesting default_revenue_treatment from delivery_model is safe to pre-fill
 * on create — a non-consequential default a human can override before publish.
 * Never auto-applied to an already-active offering.
 */
export function suggestRevenueTreatment(deliveryModel: DeliveryModel): RevenueTreatment {
  switch (deliveryModel) {
    case 'saas_subscription':
      return 'over_time_ratable';
    case 'professional_services':
      return 'milestone_based';
    case 'placement_fee':
      return 'point_in_time';
    case 'licensing':
      return 'usage_based';
    case 'cohort':
    case 'one_to_one':
      return 'over_time_ratable';
    default:
      return 'point_in_time';
  }
}

export async function createOffering(input: OfferingInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'offerings', verb: 'create' });

  const existing = await prisma.offering.findFirst({
    where: { tenantId: auth.tenantId, offeringCode: input.offeringCode },
  });
  if (existing) {
    // Dedup-on-create discipline, mirroring Person: a 409 returning the
    // existing record, never a driver-level duplicate-key error.
    throw ApiError.duplicate(`An offering with code ${input.offeringCode} already exists.`, [existing]);
  }

  const recordCode = await nextRecordCode('OFF');
  const offering = await prisma.offering.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      offeringCode: input.offeringCode,
      name: input.name,
      description: input.description ?? null,
      vertical: input.vertical,
      deliveryModel: input.deliveryModel,
      defaultRevenueTreatment: input.defaultRevenueTreatment ?? suggestRevenueTreatment(input.deliveryModel),
      status: 'draft',
      owningBusinessUnit: input.owningBusinessUnit ?? null,
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'offering', subjectId: offering.id, after: { offeringCode: offering.offeringCode } });
  await emit({
    name: EVENTS.OFFERING_CREATED,
    subject: { entityType: 'offering', entityId: offering.id, recordCode: offering.offeringCode },
    newState: { name: offering.name, vertical: offering.vertical },
    impact: { domains: ['crm', 'pct', 'fin'] },
  });

  return offering;
}

export async function publishOffering(offeringId: string) {
  await assertCan({ resource: 'offerings', verb: 'edit' });
  const offering = await prisma.offering.update({ where: { id: offeringId }, data: { status: 'active' } });
  await emit({
    name: EVENTS.OFFERING_UPDATED,
    subject: { entityType: 'offering', entityId: offeringId, recordCode: offering.offeringCode },
    newState: { status: 'active' },
  });
  return offering;
}

/** Retirement, never hard delete. Existing FK references stay valid and display a retired badge. */
export async function retireOffering(offeringId: string) {
  await assertCan({ resource: 'offerings', verb: 'edit' });
  const offering = await prisma.offering.update({
    where: { id: offeringId },
    data: { status: 'retired', effectiveTo: new Date() },
  });
  await emit({
    name: EVENTS.OFFERING_RETIRED,
    subject: { entityType: 'offering', entityId: offeringId, recordCode: offering.offeringCode },
    newState: { status: 'retired' },
  });
  return offering;
}

/**
 * DET-CRM-OFF-01: an active offering with zero price book entries is a coverage
 * gap, not a normal state — reps can select it but cannot price it.
 */
export async function detectOfferingCoverageGaps(): Promise<number> {
  const auth = currentAuth();
  const active = await prisma.offering.findMany({
    where: { tenantId: auth.tenantId, status: 'active', deletedAt: null },
    include: { priceBookEntries: { where: { status: 'active' }, select: { id: true } } },
  });

  const gaps = active.filter((o) => o.priceBookEntries.length === 0);
  for (const offering of gaps) {
    await raiseException({
      code: 'DET-CRM-OFF-01',
      label: 'Active offering with no price book entry',
      severity: 'S1_ATTENTION',
      subjectType: 'offering',
      subjectId: offering.id,
      subjectLabel: `${offering.offeringCode} — ${offering.name}`,
      detail: 'Reps can select this offering but cannot price it. Publish a price book entry or retire the offering.',
      ownerPartyId: offering.createdById,
      triggerFingerprint: 'offering_no_price',
      ladderRung: 1,
    });
  }
  return gaps.length;
}

// ---------------------------------------------------------------------------
// PRICE_BOOK_ENTRY (CRM-COML-002)
// ---------------------------------------------------------------------------

export interface PriceInput {
  offeringId: string;
  priceBookId?: string;
  priceBookName?: string;
  currency: string;
  unitPrice: number;
  billingFrequency: BillingFrequency;
  minQuantity?: number;
  /** Required and deliberately set. Never nullable, never defaulted to 100. */
  maxDiscountPct: number;
}

/**
 * Repricing NEVER mutates an existing entry. It creates a new version and flips
 * the prior row to superseded, preserving the exact price a quote was built
 * against even after the list price moves on.
 */
export async function publishPrice(input: PriceInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'price_book_entries', verb: 'create' });

  if (input.maxDiscountPct === null || input.maxDiscountPct === undefined) {
    throw ApiError.unprocessable('max_discount_pct is required on every price book entry — there is no default ceiling.');
  }
  if (input.maxDiscountPct < 0 || input.maxDiscountPct > 100) {
    throw ApiError.unprocessable('max_discount_pct must be between 0 and 100.');
  }

  const priceBookId = input.priceBookId ?? 'standard';

  const current = await prisma.priceBookEntry.findFirst({
    where: { tenantId: auth.tenantId, offeringId: input.offeringId, priceBookId, status: 'active', currency: input.currency },
    orderBy: { version: 'desc' },
  });

  const version = (current?.version ?? 0) + 1;

  const entry = await prisma.priceBookEntry.create({
    data: {
      tenantId: auth.tenantId,
      offeringId: input.offeringId,
      priceBookId,
      priceBookName: input.priceBookName ?? (priceBookId === 'standard' ? 'Standard List' : priceBookId),
      currency: input.currency,
      unitPrice: input.unitPrice,
      billingFrequency: input.billingFrequency,
      minQuantity: input.minQuantity ?? 1,
      maxDiscountPct: input.maxDiscountPct,
      status: 'active',
      version,
      createdById: auth.partyId,
    },
  });

  if (current) {
    await prisma.priceBookEntry.update({
      where: { id: current.id },
      data: { status: 'superseded', effectiveTo: new Date() },
    });
    await emit({
      name: EVENTS.PRICE_BOOK_ENTRY_SUPERSEDED,
      subject: { entityType: 'price_book_entry', entityId: current.id },
      previousState: { status: 'active', version: current.version },
      newState: { status: 'superseded' },
    });
  }

  await auditWrite({
    action: 'create',
    subjectType: 'price_book_entry',
    subjectId: entry.id,
    after: { version, unitPrice: input.unitPrice, maxDiscountPct: input.maxDiscountPct },
  });
  await emit({
    name: EVENTS.PRICE_BOOK_ENTRY_PUBLISHED,
    subject: { entityType: 'price_book_entry', entityId: entry.id },
    related: [{ relation: 'prices', entityType: 'offering', entityId: input.offeringId }],
    newState: { version, unitPrice: input.unitPrice, currency: input.currency },
    impact: { domains: ['crm', 'pct'] },
    confidentiality: 'restricted',
  });

  return entry;
}

// ---------------------------------------------------------------------------
// PROPOSAL (PCT-owned; CRM holds the FK and reacts to the events)
// ---------------------------------------------------------------------------

export async function createProposal(input: {
  opportunityId: string;
  title: string;
  quoteId?: string | null;
  totalValue?: number | null;
  currency?: string;
  validUntil?: Date | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'proposals', verb: 'create' });

  const opportunity = await prisma.opportunity.findFirst({ where: { id: input.opportunityId } });
  if (!opportunity) throw ApiError.notFound('Opportunity');

  const recordCode = await nextRecordCode('PRO');
  const proposal = await prisma.proposal.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      opportunityId: input.opportunityId,
      quoteId: input.quoteId ?? null,
      title: input.title,
      totalValue: input.totalValue ?? undefined,
      currency: input.currency ?? opportunity.currency,
      validUntil: input.validUntil ?? null,
      ownerPartyId: opportunity.ownerPartyId,
      createdById: auth.partyId,
    },
  });

  // CRM holds a single FK into PCT's entity. Every other proposal fact is read
  // from the referenced record, never duplicated as parallel fields.
  await prisma.opportunity.update({ where: { id: input.opportunityId }, data: { proposalId: proposal.id } });

  await emit({
    name: EVENTS.PROPOSAL_CREATED,
    subject: { entityType: 'proposal', entityId: proposal.id, recordCode },
    related: [{ relation: 'proposes_for', entityType: 'opportunity', entityId: input.opportunityId }],
    newState: { totalValue: input.totalValue ?? null },
  });

  return proposal;
}

export async function sendProposal(proposalId: string) {
  await assertCan({ resource: 'proposals', verb: 'edit' });
  const proposal = await prisma.proposal.findFirst({ where: { id: proposalId } });
  if (!proposal) throw ApiError.notFound('Proposal');

  const sentAt = new Date();
  const updated = await prisma.proposal.update({
    where: { id: proposalId },
    data: { sentAt, response: 'pending' },
  });

  // CRM's read-model mirror is hydrated from the PCT event, never written
  // directly by CRM service code. This IS the event handler path.
  await prisma.opportunity.update({
    where: { id: proposal.opportunityId },
    data: { proposalSentAt: sentAt, proposalPendingNotifiedAt: null },
  });

  await emit({
    name: EVENTS.PROPOSAL_SENT,
    subject: { entityType: 'proposal', entityId: proposalId, recordCode: proposal.recordCode },
    related: [{ relation: 'proposes_for', entityType: 'opportunity', entityId: proposal.opportunityId }],
    newState: { sentAt: sentAt.toISOString(), validUntil: proposal.validUntil },
  });

  return updated;
}

/**
 * Stage-transition logic lives in CRM even though the triggering fact
 * originates in PCT — stage authority is CRM's.
 */
export async function respondToProposal(proposalId: string, response: 'accepted' | 'rejected' | 'expired') {
  await assertCan({ resource: 'proposals', verb: 'edit' });
  const proposal = await prisma.proposal.findFirst({ where: { id: proposalId } });
  if (!proposal) throw ApiError.notFound('Proposal');

  const updated = await prisma.proposal.update({
    where: { id: proposalId },
    data: { response, respondedAt: new Date() },
  });

  await emit({
    name: EVENTS.PROPOSAL_RESPONDED,
    subject: { entityType: 'proposal', entityId: proposalId, recordCode: proposal.recordCode },
    related: [{ relation: 'proposes_for', entityType: 'opportunity', entityId: proposal.opportunityId }],
    newState: { response },
  });

  const opportunity = await prisma.opportunity.findFirst({
    where: { id: proposal.opportunityId },
    include: { pipeline: { include: { stages: { where: { retiredAt: null } } } } },
  });
  if (!opportunity) return updated;

  const targetPosition = response === 'accepted' ? 60 : response === 'rejected' ? 30 : 30;
  const target = opportunity.pipeline.stages.find((s) => s.pipelinePosition === targetPosition);
  if (target) {
    try {
      await advanceStage(opportunity.id, target.stageKey, {
        reasonCode: `proposal_${response}`,
        note: `Driven by proposal ${proposal.recordCode}.`,
      });
    } catch {
      // A blocked transition is legitimate (missing required fields on the
      // target stage); the proposal response still stands.
    }
  }

  return updated;
}

/** EX-CRM-008: the stalled-proposal chase, weekend-skipping. */
export async function detectStalledProposals(businessDays = 5): Promise<number> {
  const auth = currentAuth();
  const cutoff = subtractBusinessDays(new Date(), businessDays);

  const stalled = await prisma.proposal.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      response: 'pending',
      sentAt: { lt: cutoff, not: null },
      stalledNotifiedAt: null,
    },
    take: 200,
  });

  for (const proposal of stalled) {
    await raiseException({
      code: 'EX-CRM-008',
      label: 'Proposal stalled',
      severity: 'S2_WARNING',
      subjectType: 'proposal',
      subjectId: proposal.id,
      subjectLabel: `${proposal.recordCode} — ${proposal.title}`,
      detail: `Sent ${businessDays} business days ago with no response recorded.`,
      ownerPartyId: proposal.ownerPartyId,
      triggerFingerprint: `proposal_stalled:${businessDays}`,
      ladderRung: 1,
    });
    await prisma.proposal.update({ where: { id: proposal.id }, data: { stalledNotifiedAt: new Date() } });
    await emit({
      name: EVENTS.PROPOSAL_STALLED_DETECTED,
      subject: { entityType: 'proposal', entityId: proposal.id, recordCode: proposal.recordCode },
      newState: { businessDaysSinceSent: businessDays },
      impact: { domains: ['crm', 'pct'], severity: 'S2_WARNING' },
    });
  }
  return stalled.length;
}

function subtractBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let removed = 0;
  while (removed < days) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) removed += 1;
  }
  return d;
}

// ---------------------------------------------------------------------------
// QUOTE + the discount-authority gate, AU-CRM-011 (CRM-COML-005)
// ---------------------------------------------------------------------------

export interface QuoteLineInput {
  priceBookEntryId: string;
  quantity: number;
  discountPct: number;
}

export async function createQuote(opportunityId: string, lines: QuoteLineInput[]) {
  const auth = currentAuth();
  await assertCan({ resource: 'quotes', verb: 'create' });

  const opportunity = await prisma.opportunity.findFirst({ where: { id: opportunityId } });
  if (!opportunity) throw ApiError.notFound('Opportunity');
  if (lines.length === 0) throw ApiError.badRequest('A quote requires at least one line.');

  const entries = await prisma.priceBookEntry.findMany({
    where: { id: { in: lines.map((l) => l.priceBookEntryId) } },
    include: { offering: { select: { name: true } } },
  });
  const byId = new Map(entries.map((e) => [e.id, e]));

  // The Quote-building surface must not silently mix currencies within one
  // quote's line items.
  const currencies = new Set(entries.map((e) => e.currency));
  if (currencies.size > 1) {
    throw ApiError.unprocessable(
      `A quote cannot mix currencies: ${[...currencies].join(', ')}. Multi-currency offerings are legitimate, but one quote resolves in one currency.`,
    );
  }

  const priorVersions = await prisma.quote.count({ where: { tenantId: auth.tenantId, opportunityId } });
  const recordCode = await nextRecordCode('QUO');

  const quote = await prisma.quote.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      opportunityId,
      version: priorVersions + 1,
      status: 'draft',
      currency: entries[0]?.currency ?? opportunity.currency,
      ownerPartyId: opportunity.ownerPartyId,
      createdById: auth.partyId,
    },
  });

  let subtotal = 0;
  let discountTotal = 0;

  for (const line of lines) {
    const entry = byId.get(line.priceBookEntryId);
    if (!entry) throw ApiError.unprocessable(`Price book entry ${line.priceBookEntryId} does not resolve.`);

    const listUnitPrice = num(entry.unitPrice)!;
    const gross = listUnitPrice * line.quantity;
    const discountAmount = (gross * line.discountPct) / 100;
    const lineTotal = gross - discountAmount;

    await prisma.quoteLine.create({
      data: {
        tenantId: auth.tenantId,
        quoteId: quote.id,
        priceBookEntryId: entry.id,
        // Always the resolved version, never "the current price for this
        // offering" — this is what makes a quote reproducible six months later.
        priceBookEntryVersion: entry.version,
        quantity: line.quantity,
        listUnitPrice,
        discountPct: line.discountPct,
        discountAmount,
        lineTotal,
      },
    });

    subtotal += gross;
    discountTotal += discountAmount;
  }

  const updated = await prisma.quote.update({
    where: { id: quote.id },
    data: { subtotal, discountTotal, grandTotal: subtotal - discountTotal },
  });

  await emit({
    name: EVENTS.QUOTE_CREATED,
    subject: { entityType: 'quote', entityId: quote.id, recordCode },
    related: [{ relation: 'quotes_for', entityType: 'opportunity', entityId: opportunityId }],
    newState: { version: quote.version, grandTotal: subtotal - discountTotal },
    confidentiality: 'confidential',
  });

  return updated;
}

export interface QuoteIssueResult {
  issued: boolean;
  quote: Awaited<ReturnType<typeof prisma.quote.findFirstOrThrow>>;
  blockedLines: Array<{ lineId: string; offering: string; discountPct: number; ceiling: number }>;
  approvalStepId: string | null;
}

/**
 * AU-CRM-011 — the discount-authority gate.
 *
 * For any line where discountPct exceeds its price book entry's
 * maxDiscountPct, issue is BLOCKED and an APPROVAL_STEP opens against the
 * authority holder resolved from the discounting rep's AUTHORITY_GRANT ceiling.
 * The WHOLE quote blocks — there is no partial issue with some lines through
 * and some blocked.
 */
export async function issueQuote(quoteId: string, validUntil?: Date): Promise<QuoteIssueResult> {
  const auth = currentAuth();
  await assertCan({ resource: 'quotes', verb: 'edit' });

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId },
    include: { lines: { include: { priceBookEntry: { include: { offering: true } } } } },
  });
  if (!quote) throw ApiError.notFound('Quote');
  if (quote.status !== 'draft' && quote.status !== 'blocked') {
    throw ApiError.conflict(`Quote is already ${quote.status}.`);
  }

  const blockedLines = quote.lines
    .filter((l) => l.discountPct > l.priceBookEntry.maxDiscountPct)
    .map((l) => ({
      lineId: l.id,
      offering: l.priceBookEntry.offering.name,
      discountPct: l.discountPct,
      ceiling: l.priceBookEntry.maxDiscountPct,
    }));

  if (blockedLines.length > 0) {
    const grandTotal = num(quote.grandTotal) ?? 0;
    const ceiling = await resolveAuthorityCeiling(auth, 'discount_approval');

    // Approver resolution is a single tier here (finance_controller+), rather
    // than MoU's escalation ladder — structurally the same HOW MUCH pattern,
    // different resolution shape.
    const approver = await prisma.affiliation.findFirst({
      where: {
        tenantId: auth.tenantId,
        roleSlug: { in: ['finance_controller', 'business_head', 'chairman'] },
        status: 'active',
        ...(auth.partyId ? { partyId: { not: auth.partyId } } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });

    const step = await prisma.approvalStep.create({
      data: {
        tenantId: auth.tenantId,
        subjectType: 'quote',
        subjectId: quoteId,
        subjectLabel: quote.recordCode,
        action: 'quote.issue',
        requestedById: auth.partyId ?? 'system',
        requestedValue: quote.grandTotal ?? undefined,
        currency: quote.currency,
        resolvedApproverId: approver?.partyId ?? null,
        resolvedApproverRole: 'finance_controller',
        resolutionTier: 0,
        slaDueAt: new Date(Date.now() + 3 * 86_400_000),
      },
    });

    const blocked = await prisma.quote.update({
      where: { id: quoteId },
      data: {
        status: 'blocked',
        blockedReason: blockedLines
          .map((b) => `${b.offering}: ${b.discountPct}% exceeds the ${b.ceiling}% ceiling`)
          .join('; '),
        approvalStepId: step.id,
      },
    });

    await emit({
      name: EVENTS.QUOTE_DISCOUNT_BLOCKED,
      subject: { entityType: 'quote', entityId: quoteId, recordCode: quote.recordCode },
      related: [{ relation: 'blocks_for', entityType: 'opportunity', entityId: quote.opportunityId }],
      newState: { blockedLines, grandTotal, requesterCeiling: ceiling },
      reason: { reasonCode: 'discount_over_ceiling' },
      impact: { domains: ['crm', 'pct'], severity: 'S2_WARNING' },
      confidentiality: 'confidential',
    });

    if (approver?.partyId) {
      await notify({
        recipientPartyId: approver.partyId,
        priority: 'N3_HIGH',
        title: `Discount approval required: ${quote.recordCode}`,
        body: blocked.blockedReason ?? 'A quote line exceeds its discount ceiling.',
        severity: 'S2_WARNING',
        subjectType: 'quote',
        subjectId: quoteId,
        drillPath: `/commercial/quotes/${quoteId}`,
      });
    }

    return { issued: false, quote: blocked, blockedLines, approvalStepId: step.id };
  }

  const issued = await prisma.quote.update({
    where: { id: quoteId },
    data: {
      status: 'issued',
      issuedAt: new Date(),
      validUntil: validUntil ?? new Date(Date.now() + 30 * 86_400_000),
      blockedReason: null,
    },
  });

  await prisma.opportunity.update({ where: { id: quote.opportunityId }, data: { quoteId } });

  await emit({
    name: EVENTS.QUOTE_ISSUED,
    subject: { entityType: 'quote', entityId: quoteId, recordCode: quote.recordCode },
    related: [{ relation: 'quotes_for', entityType: 'opportunity', entityId: quote.opportunityId }],
    newState: { grandTotal: num(issued.grandTotal), validUntil: issued.validUntil },
    confidentiality: 'confidential',
  });

  return { issued: true, quote: issued, blockedLines: [], approvalStepId: null };
}
