/**
 * Every path that opens an ApprovalStep records the permission resource it
 * gated on. `decideApprovalStep` refuses a step whose resource is null, so a
 * step opened without one is an approval nobody can ever decide. These tests
 * open a step through each domain path that writes its own row (the gate in
 * `platform/approvals.ts` records its resource already) and assert the stored
 * resource is the grant the decide path checks `approve` against.
 */
import { describe, it, expect } from 'vitest';
import { asUser, prisma, unscopedPrisma } from './helpers.js';
import { createQuote, issueQuote } from '../domains/commercial.js';
import { createApplication, createLicence, proposeRenewal } from '../domains/it/software.js';

describe('approval steps record the resource they gate on', () => {
  it('a quote discount over the price book ceiling opens a step on the quotes resource', async () => {
    await asUser('arun@kaizen.co.in', async () => {
      const entry = await prisma.priceBookEntry.findFirstOrThrow({
        where: { status: 'active', maxDiscountPct: { gte: 10 } },
      });
      const opp = await prisma.opportunity.findFirstOrThrow({ where: { outcome: null } });
      const quote = await createQuote(opp.id, [
        { priceBookEntryId: entry.id, quantity: 1, discountPct: Math.min(entry.maxDiscountPct + 15, 100) },
      ]);

      const result = await issueQuote(quote.id);
      expect(result.approvalStepId).not.toBeNull();

      const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: result.approvalStepId! } });
      expect(step.resource).toBe('quotes');
    });
  });

  it('a licence renewal proposal opens a step on the it_licences resource that approveRenewal checks', async () => {
    const app = await asUser('operations@kaizen.co.in', () =>
      createApplication({ name: `Resource-guard app ${Date.now()}`, category: 'productivity', hosting: 'saas' }),
    );
    const licence = await asUser('operations@kaizen.co.in', () =>
      createLicence({ applicationId: app.id, kind: 'per_seat', seatsPurchased: 5, seatsInUse: 2, costPerPeriod: 10000, billingCycle: 'monthly' }),
    );
    const newTermEnd = new Date();
    newTermEnd.setUTCFullYear(newTermEnd.getUTCFullYear() + 1);

    const proposed = await asUser('operations@kaizen.co.in', () => proposeRenewal(licence.id, { newTermEnd }));
    expect(proposed.approvalStepId).toBeTruthy();

    const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: proposed.approvalStepId! } });
    expect(step.resource).toBe('it_licences');
  });
});
