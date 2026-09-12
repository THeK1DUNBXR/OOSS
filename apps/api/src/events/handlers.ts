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

import { EVENTS, type EventEnvelope } from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { subscribe, wouldLoop } from '../platform/eventBus.js';
import { createInvoice, rehydrateReceivables, issueFeeInstalments } from '../domains/finance.js';
import { ensureWinLossReview } from '../domains/winLoss.js';
import { computeSensitivity } from '../domains/interactions.js';

let registered = false;

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

    const total = 60_000;
    const now = Date.now();
    await issueFeeInstalments(enrollment.id, [
      { amount: total * 0.4, dueDate: new Date(now + 7 * 86_400_000) },
      { amount: total * 0.3, dueDate: new Date(now + 45 * 86_400_000) },
      { amount: total * 0.3, dueDate: new Date(now + 90 * 86_400_000) },
    ]);
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
}
