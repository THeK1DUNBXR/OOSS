import { Router } from 'express';
import { z } from 'zod';
import {
  AGREEMENT_TYPES,
  BILLING_FREQUENCIES,
  DELIVERY_MODELS,
  LOST_REASONS,
  REVENUE_TREATMENTS,
  VERTICALS,
} from '@kaizen/shared';
import { handler, str, bool, numeric } from '../lib/http.js';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, canSeeMoney } from '../platform/permissions.js';
import { decideApprovalStep } from '../platform/approvals.js';
import {
  createOffering,
  publishOffering,
  retireOffering,
  publishPrice,
  createProposal,
  sendProposal,
  respondToProposal,
  createQuote,
  issueQuote,
} from '../domains/commercial.js';
import {
  createMou,
  createContract,
  createPartnerAgreement,
  transitionAgreement,
  renewAgreement,
  type AgreementKind,
} from '../domains/agreements.js';
import { completeWinLossReview, ensureWinLossReview } from '../domains/winLoss.js';

const router = Router();

// ---------------------------------------------------------------------------
// Offering catalog
// ---------------------------------------------------------------------------

router.get(
  '/offerings',
  handler(async (req) => {
    await assertCan({ resource: 'offerings', verb: 'view' });
    const auth = currentAuth();
    const money = await canSeeMoney('price_book_entries');

    const offerings = await prisma.offering.findMany({
      where: {
        tenantId: auth.tenantId,
        deletedAt: null,
        ...(str(req.query.status) ? { status: str(req.query.status) } : {}),
        ...(str(req.query.vertical) ? { vertical: str(req.query.vertical) } : {}),
      },
      include: { priceBookEntries: { where: { status: 'active' } } },
      orderBy: { name: 'asc' },
    });

    return offerings.map((o) => ({
      id: o.id,
      recordCode: o.recordCode,
      offeringCode: o.offeringCode,
      name: o.name,
      description: o.description,
      vertical: o.vertical,
      deliveryModel: o.deliveryModel,
      defaultRevenueTreatment: o.defaultRevenueTreatment,
      status: o.status,
      owningBusinessUnit: o.owningBusinessUnit,
      legacyProductStrings: o.legacyProductStrings,
      effectiveFrom: o.effectiveFrom.toISOString(),
      effectiveTo: o.effectiveTo?.toISOString() ?? null,
      priceBookEntryCount: o.priceBookEntries.length,
      activePriceBookEntries: o.priceBookEntries.map((p) => ({
        id: p.id,
        offeringId: p.offeringId,
        offeringName: o.name,
        priceBookId: p.priceBookId,
        priceBookName: p.priceBookName,
        currency: p.currency,
        unitPrice: money ? num(p.unitPrice) : null,
        billingFrequency: p.billingFrequency,
        minQuantity: p.minQuantity,
        maxDiscountPct: p.maxDiscountPct,
        status: p.status,
        version: p.version,
        effectiveFrom: p.effectiveFrom.toISOString(),
        effectiveTo: p.effectiveTo?.toISOString() ?? null,
      })),
      // DET-CRM-OFF-01: selectable but unpriceable is a coverage gap.
      coverageGap: o.status === 'active' && o.priceBookEntries.length === 0,
    }));
  }),
);

router.post(
  '/offerings',
  handler(async (req, res) => {
    const schema = z.object({
      offeringCode: z.string().min(2),
      name: z.string().min(1),
      description: z.string().nullish(),
      vertical: z.enum(VERTICALS),
      deliveryModel: z.enum(DELIVERY_MODELS),
      defaultRevenueTreatment: z.enum(REVENUE_TREATMENTS).optional(),
      owningBusinessUnit: z.string().nullish(),
    });
    const offering = await createOffering(schema.parse(req.body));
    res.status(201).json(offering);
    return undefined;
  }),
);

router.post('/offerings/:id/publish', handler(async (req) => publishOffering(req.params.id)));
router.post('/offerings/:id/retire', handler(async (req) => retireOffering(req.params.id)));

router.get(
  '/offerings/:id/prices',
  handler(async (req) => {
    await assertCan({ resource: 'price_book_entries', verb: 'view' });
    // Every version, including superseded ones — a quote must stay reproducible
    // against the exact version it was built on.
    return prisma.priceBookEntry.findMany({
      where: { offeringId: req.params.id },
      orderBy: [{ priceBookId: 'asc' }, { version: 'desc' }],
    });
  }),
);

router.post(
  '/offerings/:id/prices',
  handler(async (req, res) => {
    const schema = z.object({
      currency: z.string().length(3),
      unitPrice: z.number().positive(),
      billingFrequency: z.enum(BILLING_FREQUENCIES),
      minQuantity: z.number().int().positive().optional(),
      // Required with no default — an unset ceiling is a modelling error.
      maxDiscountPct: z.number().int().min(0).max(100),
      priceBookId: z.string().optional(),
      priceBookName: z.string().optional(),
    });
    const entry = await publishPrice({ offeringId: req.params.id, ...schema.parse(req.body) });
    res.status(201).json(entry);
    return undefined;
  }),
);

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

router.get(
  '/proposals',
  handler(async (req) => {
    await assertCan({ resource: 'proposals', verb: 'view' });
    const auth = currentAuth();
    const money = await canSeeMoney('proposals');
    const rows = await prisma.proposal.findMany({
      where: {
        tenantId: auth.tenantId,
        deletedAt: null,
        ...(str(req.query.response) ? { response: str(req.query.response) } : {}),
        ...(bool(req.query.stalled) ? { stalledNotifiedAt: { not: null }, response: 'pending' } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((p) => ({ ...p, totalValue: money ? num(p.totalValue) : null }));
  }),
);

router.post(
  '/proposals',
  handler(async (req, res) => {
    const schema = z.object({
      opportunityId: z.string(),
      title: z.string().min(1),
      quoteId: z.string().nullish(),
      totalValue: z.number().nullish(),
      validUntil: z.string().nullish(),
    });
    const input = schema.parse(req.body);
    const proposal = await createProposal({
      ...input,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
    });
    res.status(201).json(proposal);
    return undefined;
  }),
);

router.post('/proposals/:id/send', handler(async (req) => sendProposal(req.params.id)));

router.post(
  '/proposals/:id/respond',
  handler(async (req) => {
    const schema = z.object({ response: z.enum(['accepted', 'rejected', 'expired']) });
    return respondToProposal(req.params.id, schema.parse(req.body).response);
  }),
);

// ---------------------------------------------------------------------------
// Quotes and the discount-authority gate
// ---------------------------------------------------------------------------

router.get(
  '/quotes',
  handler(async (req) => {
    await assertCan({ resource: 'quotes', verb: 'view' });
    const auth = currentAuth();
    const money = await canSeeMoney('quotes');

    const rows = await prisma.quote.findMany({
      where: {
        tenantId: auth.tenantId,
        deletedAt: null,
        ...(str(req.query.opportunityId) ? { opportunityId: str(req.query.opportunityId) } : {}),
        ...(str(req.query.status) ? { status: str(req.query.status) } : {}),
      },
      include: { lines: { include: { priceBookEntry: { include: { offering: { select: { name: true } } } } } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return rows.map((q) => ({
      id: q.id,
      recordCode: q.recordCode,
      opportunityId: q.opportunityId,
      version: q.version,
      status: q.status,
      currency: q.currency,
      subtotal: money ? num(q.subtotal) : null,
      discountTotal: money ? num(q.discountTotal) : null,
      grandTotal: money ? num(q.grandTotal) : null,
      issuedAt: q.issuedAt?.toISOString() ?? null,
      validUntil: q.validUntil?.toISOString() ?? null,
      blockedReason: q.blockedReason,
      approvalStepId: q.approvalStepId,
      lines: q.lines.map((l) => ({
        id: l.id,
        priceBookEntryId: l.priceBookEntryId,
        priceBookEntryVersion: l.priceBookEntryVersion,
        offeringName: l.priceBookEntry.offering.name,
        quantity: l.quantity,
        listUnitPrice: money ? num(l.listUnitPrice) : null,
        discountPct: l.discountPct,
        maxDiscountPct: l.priceBookEntry.maxDiscountPct,
        overCeiling: l.discountPct > l.priceBookEntry.maxDiscountPct,
        discountAmount: money ? num(l.discountAmount) : null,
        lineTotal: money ? num(l.lineTotal) : null,
      })),
    }));
  }),
);

router.post(
  '/quotes',
  handler(async (req, res) => {
    const schema = z.object({
      opportunityId: z.string(),
      lines: z
        .array(
          z.object({
            priceBookEntryId: z.string(),
            quantity: z.number().int().positive(),
            discountPct: z.number().min(0).max(100),
          }),
        )
        .min(1),
    });
    const input = schema.parse(req.body);
    const quote = await createQuote(input.opportunityId, input.lines);
    res.status(201).json(quote);
    return undefined;
  }),
);

router.post(
  '/quotes/:id/issue',
  handler(async (req) => {
    const validUntil = req.body?.validUntil ? new Date(req.body.validUntil) : undefined;
    return issueQuote(req.params.id, validUntil);
  }),
);

// ---------------------------------------------------------------------------
// Agreements: MoU, Contract, Partner Agreement — one shared state machine
// ---------------------------------------------------------------------------

const KIND_MAP: Record<string, AgreementKind> = {
  mous: 'mou',
  contracts: 'contract',
  'partner-agreements': 'partner_agreement',
};

async function listAgreements(kind: AgreementKind, filters: { status?: string }) {
  const auth = currentAuth();
  const money = await canSeeMoney(`${kind}s`);

  const rows =
    kind === 'mou'
      ? await prisma.mou.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, ...(filters.status ? { status: filters.status } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 })
      : kind === 'contract'
        ? await prisma.contract.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, ...(filters.status ? { status: filters.status } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 })
        : await prisma.partnerAgreement.findMany({ where: { tenantId: auth.tenantId, deletedAt: null, ...(filters.status ? { status: filters.status } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });

  const orgIds = [
    ...new Set(
      (rows as Array<Record<string, unknown>>)
        .map((r) => (r.organizationId ?? r.partnerOrganizationId) as string | null)
        .filter(Boolean) as string[],
    ),
  ];
  const orgs = orgIds.length
    ? await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
    : [];
  const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

  const { MOU_USER_TRANSITIONS, CONTRACT_USER_TRANSITIONS } = await import('@kaizen/shared');
  const transitionMap = kind === 'contract' ? CONTRACT_USER_TRANSITIONS : MOU_USER_TRANSITIONS;

  return (rows as Array<Record<string, unknown>>).map((r) => {
    const orgId = (r.organizationId ?? r.partnerOrganizationId) as string | null;
    const endDate = r.endDate as Date | null;
    const status = r.status as string;
    const available = transitionMap[status] ?? [];

    return {
      id: r.id as string,
      kind,
      recordCode: r.recordCode as string,
      legacyReference: (r.legacyReference as string | null) ?? null,
      title: r.title as string,
      organizationId: orgId,
      organizationName: orgId ? (orgMap.get(orgId) ?? null) : null,
      institutionId: (r.institutionId as string | null) ?? null,
      opportunityId: (r.opportunityId as string | null) ?? null,
      ownerPartyId: (r.ownerPartyId as string | null) ?? null,
      ownerName: null,
      status,
      scope: (r.scope as string | null) ?? null,
      vertical: (r.vertical as string | null) ?? null,
      agreementType: (r.agreementType as string | null) ?? null,
      commercialValue: money ? num(r.commercialValue as never) : null,
      currency: (r.currency as string) ?? 'INR',
      strategicValue: (r.strategicValue as string | null) ?? null,
      startDate: (r.startDate as Date | null)?.toISOString() ?? null,
      endDate: endDate?.toISOString() ?? null,
      signedDate: (r.signedDate as Date | null)?.toISOString() ?? null,
      renewedFromId: (r.renewedFromId as string | null) ?? null,
      expiryNotifiedDays: (r.expiryNotifiedDays as number[]) ?? [],
      daysToExpiry: endDate ? Math.ceil((endDate.getTime() - Date.now()) / 86_400_000) : null,
      availableTransitions: available,
      // Which of the available transitions run the approval gate.
      requiresApprovalFor: available.filter((s) => ['approved', 'signed'].includes(s)),
      documentId: (r.documentId as string | null) ?? null,
    };
  });
}

for (const [segment, kind] of Object.entries(KIND_MAP)) {
  router.get(
    `/${segment}`,
    handler(async (req) => {
      await assertCan({ resource: `${kind}s`, verb: 'view' });
      return listAgreements(kind, { status: str(req.query.status) });
    }),
  );

  router.post(
    `/${segment}/:id/transition`,
    handler(async (req) => {
      const schema = z.object({ toStatus: z.string(), note: z.string().optional() });
      const input = schema.parse(req.body);
      return transitionAgreement(kind, req.params.id, input.toStatus, input.note ?? '');
    }),
  );

  router.post(
    `/${segment}/:id/renew`,
    handler(async (req) => {
      const schema = z.object({ endDate: z.string() });
      return renewAgreement(kind, req.params.id, new Date(schema.parse(req.body).endDate));
    }),
  );
}

router.post(
  '/mous',
  handler(async (req, res) => {
    const schema = z.object({
      title: z.string().min(1),
      organizationId: z.string().nullish(),
      institutionId: z.string().nullish(),
      opportunityId: z.string().nullish(),
      scope: z.string().nullish(),
      vertical: z.string().nullish(),
      commercialValue: z.number().nullish(),
      strategicValue: z.enum(['high', 'medium', 'low']).nullish(),
      termMonths: z.number().int().nullish(),
      startDate: z.string().nullish(),
      endDate: z.string().nullish(),
    });
    const input = schema.parse(req.body);
    const mou = await createMou({
      ...input,
      startDate: input.startDate ? new Date(input.startDate) : null,
      endDate: input.endDate ? new Date(input.endDate) : null,
    });
    res.status(201).json(mou);
    return undefined;
  }),
);

router.post(
  '/contracts',
  handler(async (req, res) => {
    const schema = z.object({
      title: z.string().min(1),
      organizationId: z.string().nullish(),
      opportunityId: z.string().nullish(),
      quoteId: z.string().nullish(),
      // Required and positive — an unpriced contract is a modelling error.
      commercialValue: z.number().positive(),
      strategicValue: z.enum(['high', 'medium', 'low']).nullish(),
      termMonths: z.number().int().nullish(),
      startDate: z.string().nullish(),
      endDate: z.string().nullish(),
    });
    const input = schema.parse(req.body);
    const contract = await createContract({
      ...input,
      startDate: input.startDate ? new Date(input.startDate) : null,
      endDate: input.endDate ? new Date(input.endDate) : null,
    });
    res.status(201).json(contract);
    return undefined;
  }),
);

router.post(
  '/partner-agreements',
  handler(async (req, res) => {
    const schema = z.object({
      title: z.string().min(1),
      partnerOrganizationId: z.string(),
      agreementType: z.enum(AGREEMENT_TYPES),
      scope: z.string().nullish(),
      territoryScope: z.string().nullish(),
      commercialValue: z.number().nullish(),
      strategicValue: z.enum(['high', 'medium', 'low']).nullish(),
      termMonths: z.number().int().nullish(),
      startDate: z.string().nullish(),
      endDate: z.string().nullish(),
    });
    const input = schema.parse(req.body);
    const agreement = await createPartnerAgreement({
      ...input,
      startDate: input.startDate ? new Date(input.startDate) : null,
      endDate: input.endDate ? new Date(input.endDate) : null,
    });
    res.status(201).json(agreement);
    return undefined;
  }),
);

// ---------------------------------------------------------------------------
// Approval steps
// ---------------------------------------------------------------------------

router.get(
  '/approvals',
  handler(async (req) => {
    const auth = currentAuth();
    const money = await canSeeMoney('contracts');
    const rows = await prisma.approvalStep.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(bool(req.query.mine) ? { resolvedApproverId: auth.partyId } : {}),
        ...(str(req.query.state) ? { state: str(req.query.state) } : { state: { in: ['open', 'escalated'] } }),
      },
      orderBy: { requestedAt: 'asc' },
      take: 100,
    });
    return rows.map((s) => ({
      ...s,
      requestedValue: money ? num(s.requestedValue) : null,
      slaBreached: Boolean(s.slaDueAt && s.slaDueAt < new Date()),
    }));
  }),
);

router.post(
  '/approvals/:id/decide',
  handler(async (req) => {
    const schema = z.object({ approve: z.boolean(), note: z.string().min(1) });
    const input = schema.parse(req.body);
    return decideApprovalStep(req.params.id, input.approve, input.note);
  }),
);

// ---------------------------------------------------------------------------
// Win/loss reviews
// ---------------------------------------------------------------------------

router.get(
  '/win-loss',
  handler(async (req) => {
    await assertCan({ resource: 'win_loss_reviews', verb: 'view' });
    const auth = currentAuth();
    const money = await canSeeMoney('win_loss_reviews');
    const rows = await prisma.winLossReview.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(bool(req.query.pending) ? { completedAt: null } : {}),
        ...(bool(req.query.mandatory) ? { mandatory: true } : {}),
      },
      orderBy: [{ mandatory: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });

    return rows.map((r) => ({
      id: r.id,
      recordCode: r.recordCode,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      subjectLabel: r.subjectLabel ?? r.subjectId,
      outcome: r.outcome,
      competitorName: r.competitorName,
      decisionMakerPersonId: r.decisionMakerPersonId,
      decisionMakerName: null,
      realLostStage: r.realLostStage,
      lostReason: r.lostReason,
      lostReasonOtherText: r.lostReasonOtherText,
      lesson: r.lesson,
      mandatory: r.mandatory,
      mandatoryBasis: r.mandatoryBasis,
      strategicValueSnapshot: r.strategicValueSnapshot,
      commercialValueSnapshot: money ? num(r.commercialValueSnapshot) : null,
      thresholdUsedSnapshot: money ? num(r.thresholdUsedSnapshot) : null,
      completedById: r.completedById,
      completedByName: null,
      completedAt: r.completedAt?.toISOString() ?? null,
      dueAt: r.dueAt?.toISOString() ?? null,
      overdue: Boolean(r.mandatory && !r.completedAt && r.dueAt && r.dueAt < new Date()),
    }));
  }),
);

router.post(
  '/win-loss/ensure',
  handler(async (req) => {
    const schema = z.object({ subjectType: z.enum(['opportunity', 'mou']), subjectId: z.string() });
    const input = schema.parse(req.body);
    return ensureWinLossReview(input.subjectType, input.subjectId);
  }),
);

router.post(
  '/win-loss/:id/complete',
  handler(async (req) => {
    const schema = z.object({
      competitorName: z.string().nullish(),
      decisionMakerPersonId: z.string().nullish(),
      realLostStage: z.string().nullish(),
      lostReason: z.enum(LOST_REASONS).nullish(),
      lostReasonOtherText: z.string().nullish(),
      lesson: z.string().nullish(),
    });
    return completeWinLossReview(req.params.id, schema.parse(req.body));
  }),
);

// ---------------------------------------------------------------------------
// Lessons — Company Memory
// ---------------------------------------------------------------------------

router.get(
  '/lessons',
  handler(async (req) => {
    const auth = currentAuth();
    return prisma.lesson.findMany({
      where: { tenantId: auth.tenantId, ...(str(req.query.domain) ? { domain: str(req.query.domain) } : {}) },
      orderBy: { createdAt: 'desc' },
      take: numeric(req.query.limit) ?? 50,
    });
  }),
);

export default router;
