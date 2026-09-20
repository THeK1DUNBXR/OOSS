/**
 * Cross-domain subscribers.
 *
 * Every subscription is registered against the CANONICAL event name. No
 * automation is authored against a legacy PascalCase name — the bus refuses
 * such a registration outright.
 *
 * Handlers remain responsible for their own idempotency, now backed by durable
 * delivery instead of an in-memory queue a restart would drop.
 *
 * The CRM<->Finance cycle is deliberately permitted, with the causation-ancestry
 * chain as its named guard: a consumer checks whether it is about to re-trigger
 * an event it is itself downstream of, and refuses.
 */

import { EVENTS, round2, type EventEnvelope } from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { subscribe, wouldLoop } from '../platform/eventBus.js';
import { createInvoice, rehydrateReceivables, issueFeeInstalments } from '../domains/finance.js';
import { ensureWinLossReview } from '../domains/winLoss.js';
import { computeSensitivity } from '../domains/interactions.js';
import { markSnapshotDirty } from '../domains/group.js';
import { handleEmploymentExit } from '../domains/esop.js';
import { handleAllotmentEffectiveForFema, handleTransferEffectiveForFema } from '../domains/filings.js';
import { onLeadCreated, onEnrolment, onEventRegistered } from '../domains/marketing/journeys.js';

let registered = false;

/** One instalment of a course's fee plan. */
interface FeePlanPart {
  share: number;
  dueInDays: number;
}

/**
 * The default schedule, used when a course does not carry its own.
 *
 * 40/30/30 at 7/45/90 days is what the hardcoded handler did, kept so existing
 * behaviour is unchanged for courses that have not been given a plan — the
 * defect was the hardcoded *amount*, not this shape.
 */
const DEFAULT_FEE_PLAN: FeePlanPart[] = [
  { share: 0.4, dueInDays: 7 },
  { share: 0.3, dueInDays: 45 },
  { share: 0.3, dueInDays: 90 },
];

/** A course's plan when it has a usable one, the default otherwise. */
export function instalmentPlan(raw: unknown): FeePlanPart[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_FEE_PLAN;
  const parts = raw
    .filter((p): p is FeePlanPart => !!p && typeof p === 'object' && 'share' in p && 'dueInDays' in p)
    .map((p) => ({ share: Number(p.share), dueInDays: Number(p.dueInDays) }))
    .filter((p) => Number.isFinite(p.share) && p.share > 0 && Number.isFinite(p.dueInDays));
  if (!parts.length) return DEFAULT_FEE_PLAN;
  // A plan that does not add up to the fee would under- or over-bill silently,
  // which is the same class of bug as the one being fixed.
  const total = parts.reduce((s, p) => s + p.share, 0);
  if (Math.abs(total - 1) > 0.001) return DEFAULT_FEE_PLAN;
  return parts;
}

export function registerSubscribers(): void {
  if (registered) return;
  registered = true;

  /**
   * The load-bearing cross-domain event. Finance derives the billing schedule
   * from the contract, and the revenue-recognition method from the offering's
   * default treatment — with no manual sales-to-finance conversation.
   */
  subscribe(EVENTS.CONTRACT_SIGNED, 'fin.billing_schedule', async (event: EventEnvelope) => {
    // Guard the permitted CRM<->Finance cycle.
    if (await wouldLoop(event, EVENTS.INVOICE_ISSUED)) return;

    const contract = await prisma.contract.findFirst({ where: { id: event.subject.entityId } });
    if (!contract) return;

    // Idempotency: a replayed signature must not double-bill.
    const existing = await prisma.invoice.findFirst({ where: { contractId: contract.id } });
    if (existing) return;

    const opportunity = contract.opportunityId
      ? await prisma.opportunity.findFirst({ where: { id: contract.opportunityId } })
      : null;

    await createInvoice({
      accountId: contract.accountId,
      organizationId: contract.organizationId,
      contractId: contract.id,
      opportunityId: contract.opportunityId,
      currency: contract.currency,
      dueInDays: 30,
      // The contract value is the line's own price, and the tax on it is priced
      // from the place of supply at creation rather than left at zero for
      // somebody to remember later.
      lines: [
        {
          offeringId: opportunity?.offeringId ?? null,
          description: `${contract.recordCode} — ${contract.title}`,
          unitPrice: num(contract.commercialValue) ?? 0,
        },
      ],
      issue: true,
    });
  });

  /**
   * The education-motion parallel: a confirmed enrollment generates its fee
   * plan, a sibling obligation structure to the invoice rather than a variant.
   */
  subscribe(EVENTS.ENROLLMENT_CONFIRMED, 'fin.fee_plan', async (event: EventEnvelope) => {
    if (await wouldLoop(event, EVENTS.FEE_INSTALMENT_ISSUED)) return;

    const existing = await prisma.feeInstalment.findFirst({ where: { enrollmentId: event.subject.entityId } });
    if (existing) return;

    const enrollment = await prisma.enrollment.findFirst({
      where: { id: event.subject.entityId },
      include: { cohort: { include: { course: true } } },
    });
    if (!enrollment) return;

    // The fee is the course's. This used to be `const total = 60_000`, applied
    // to every confirmed enrolment regardless of what the learner had actually
    // enrolled on — the handler loaded `cohort.course` three lines above and
    // then ignored its price. A ₹25,000 course raised a ₹60,000 fee plan, and
    // `priceLines` two files away (`invoicing.ts:465`) had been reading the
    // right field the whole time.
    const total = num(enrollment.cohort?.course?.feeAmount) ?? 0;
    if (total <= 0) {
      // No price on the course is not a reason to invent one. The enrolment
      // stands; somebody prices the course and the plan is raised then.
      return;
    }

    const plan = instalmentPlan(enrollment.cohort?.course?.feePlan);
    const now = Date.now();
    await issueFeeInstalments(
      enrollment.id,
      plan.map((part) => ({
        amount: round2(total * part.share),
        dueDate: new Date(now + part.dueInDays * 86_400_000),
      })),
    );
  });

  /** Finance -> CRM flows back only as a read-only projection. */
  subscribe(EVENTS.PAYMENT_RECEIVED, 'crm.receivables_projection', async (event: EventEnvelope) => {
    const payment = await prisma.payment.findFirst({ where: { id: event.subject.entityId } });
    if (payment?.payerOrganizationId) await rehydrateReceivables(payment.payerOrganizationId, 'account');
  });

  subscribe(EVENTS.INVOICE_ISSUED, 'crm.receivables_projection_invoice', async (event: EventEnvelope) => {
    const invoice = await prisma.invoice.findFirst({ where: { id: event.subject.entityId } });
    const subject = invoice?.accountId ?? invoice?.organizationId ?? null;
    if (subject) await rehydrateReceivables(subject, 'account');
  });

  /** A terminal outcome opens the structured post-mortem shell. */
  subscribe(EVENTS.OPPORTUNITY_LOST, 'crm.win_loss_shell', async (event: EventEnvelope) => {
    await ensureWinLossReview('opportunity', event.subject.entityId);
  });

  subscribe(EVENTS.OPPORTUNITY_WON, 'crm.win_loss_shell_won', async (event: EventEnvelope) => {
    await ensureWinLossReview('opportunity', event.subject.entityId);
  });

  /**
   * Classification is re-evaluated at every read, so no batch rewrite is ever
   * required. This subscriber only refreshes the denormalised index column so
   * reporting queries stay fast — it is never the authority.
   */
  subscribe(EVENTS.INTERACTION_LOGGED, 'crm.interaction_index', async (event: EventEnvelope) => {
    const interaction = await prisma.interaction.findFirst({ where: { id: event.subject.entityId } });
    if (!interaction) return;
    const refs = (interaction.relatedReferences as unknown as Array<{ contextCode: string; entityType: string; entityId: string }>) ?? [];
    const { sensitivityClass } = await computeSensitivity(refs);
    if (sensitivityClass !== interaction.sensitivityClass) {
      await prisma.interaction.update({ where: { id: interaction.id }, data: { sensitivityClass } });
    }
  });

  /**
   * The group (equity-portal plan §6, phase 2). Nothing here reads or writes
   * a snapshot itself — it only flags this tenant's own `config.
   * snapshotDirty`, so the `publish_entity_snapshots` job (every 15 minutes)
   * publishes it soon rather than waiting for the nightly run. A tenant
   * with no parent is flagged harmlessly; `publishEntitySnapshot` is a no-op
   * for it.
   */
  const markDirty = (key: string, eventName: string) =>
    subscribe(eventName, key, async (event: EventEnvelope) => {
      await markSnapshotDirty(event.tenantId);
    });
  markDirty('eqt.snapshot_dirty.allotment', EVENTS.ALLOTMENT_EFFECTIVE);
  markDirty('eqt.snapshot_dirty.transfer', EVENTS.TRANSFER_EFFECTIVE);
  markDirty('eqt.snapshot_dirty.reversed', EVENTS.SHARE_TRANSACTION_REVERSED);
  markDirty('eqt.snapshot_dirty.valuation', EVENTS.VALUATION_RECORDED);
  markDirty('eqt.snapshot_dirty.transaction', EVENTS.TRANSACTION_RECORDED);
  // ESOP (equity-portal plan §6, phase 5): an employee's exit lapses their
  // unvested options immediately and starts the exercise-window clock on any
  // vested-unexercised balance. Subscribed against the HRM's own past-tense
  // name for every terminal separation transition (resignation reaching its
  // last working day, post-disciplinary termination, confirmed abandonment —
  // `EMPLOYMENT_EVENT_VERB` maps all three to `separated`), never a role slug.
  subscribe('kz.hr.employment.separated', 'eqt.esop_exit_lapse', async (event: EventEnvelope) => {
    await handleEmploymentExit(event.subject.entityId, new Date(event.occurredAt));
  });

  // FEMA (equity-portal plan §6 phase 6a). Repatriable non-resident holdings
  // carry FC-GPR/FC-TRS deadlines; a non-repatriable one (Schedule IV) is
  // treated as resident money and raises nothing — `handle*ForFema` makes
  // that check itself, subject by subject, rather than here.
  subscribe(EVENTS.ALLOTMENT_EFFECTIVE, 'eqt.fema_fc_gpr', async (event: EventEnvelope) => {
    await handleAllotmentEffectiveForFema(event.subject.entityId);
  });
  subscribe(EVENTS.TRANSFER_EFFECTIVE, 'eqt.fema_fc_trs', async (event: EventEnvelope) => {
    await handleTransferEffectiveForFema(event.subject.entityId);
  });

  /** A band transition, not a raw reading, is what reaches the Command Center. */
  subscribe(EVENTS.HEALTH_BAND_CHANGED, 'xdm.band_transition_log', async (event: EventEnvelope) => {
    const state = event.newState as { domainCode?: string; band?: string } | null;
    if (!state?.domainCode) return;
    // Recorded as a narrative claim source; the surface reads it, never polls.
    await prisma.narrative.create({
      data: {
        tenantId: event.tenantId,
        forUserId: 'system',
        windowFrom: new Date(event.occurredAt),
        windowTo: new Date(event.occurredAt),
        reconciliationLine: `${state.domainCode} moved to band ${state.band}.`,
        body: `Health band transition recorded for ${state.domainCode}.`,
        claimRefs: [event.eventId],
      },
    });
  });

  // ---------------------------------------------------------------------
  // Marketing journeys — enrolment triggers this module does not own.
  // `capture.ts` already calls `journeys.onFormSubmitted` directly on
  // submission conversion, so `MKT_FORM_SUBMISSION_CONVERTED` is
  // deliberately not subscribed here (it would double-enrol).
  // ---------------------------------------------------------------------

  /** A new lead may enrol a person into any `lead_created`-triggered journey. */
  subscribe(EVENTS.LEAD_CREATED, 'mkt.journey.on_lead_created', async (event: EventEnvelope) => {
    await onLeadCreated(event.subject.entityId);
  });

  /** A confirmed education enrolment may enrol the same person into an `enrolment`-triggered journey. */
  subscribe(EVENTS.ENROLLMENT_CREATED, 'mkt.journey.on_enrolment', async (event: EventEnvelope) => {
    const personId = event.related.find((r) => r.relation === 'about' && r.entityType === 'person')?.entityId;
    if (!personId) return;
    await onEnrolment(personId);
  });

  /** An event registration may enrol the registrant into an `event_registered`-triggered journey. */
  subscribe(EVENTS.MKT_EVENT_REGISTERED, 'mkt.journey.on_event_registered', async (event: EventEnvelope) => {
    const personId = event.related.find((r) => r.relation === 'registrant' && r.entityType === 'person')?.entityId;
    if (!personId) return;
    await onEventRegistered(personId);
  });
}
