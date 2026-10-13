/**
 * The quote.created event carries the rupee total as a float sum: subtotal and
 * discountTotal are accumulated in Numbers, and grandTotal is their difference.
 * 3100.8 - 310.08 is 2790.7200000000003 in floats, but the row stores 2790.72.
 * The chain hash covered the float, so the link broke on the first walk after
 * the emit (kaizen_s6b seq 587 and 1364). The body now carries the total read
 * back from the persisted quote, plus its paise as a string.
 *
 * The walk starts at the head read before the quote is created, not at genesis:
 * the event log is append-only and other suites have written rows into the
 * same tenant, so a genesis walk would also report rows this test did not write.
 */

import { describe, expect, it } from 'vitest';
import { formatMinor } from '@kaizen/shared';
import { createOffering, createQuote, publishPrice } from '../../domains/commercial.js';
import { verifyChain } from '../../platform/eventBus.js';
import { unscopedPrisma } from '../../platform/db.js';
import { asUser, tenantId } from '../helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

describe('quote.created emits a body that still verifies once stored', () => {
  it('a two-line quote with a float-inexact total links the chain and stores the paise', async () => {
    const TENANT = await tenantId();

    await asUser(CHAIRMAN, async () => {
      const offeringA = await createOffering({
        offeringCode: `CHN-A-${stamp()}`,
        name: `Chain A ${stamp()}`,
        vertical: 'software_ai',
        deliveryModel: 'cohort',
      });
      const entryA = await publishPrice({
        offeringId: offeringA.id,
        currency: 'INR',
        unitPrice: 1000.25,
        billingFrequency: 'one_time',
        maxDiscountPct: 100,
      });
      const offeringB = await createOffering({
        offeringCode: `CHN-B-${stamp()}`,
        name: `Chain B ${stamp()}`,
        vertical: 'software_ai',
        deliveryModel: 'cohort',
      });
      const entryB = await publishPrice({
        offeringId: offeringB.id,
        currency: 'INR',
        unitPrice: 100.05,
        billingFrequency: 'one_time',
        maxDiscountPct: 100,
      });

      const opportunity = await unscopedPrisma.opportunity.findFirstOrThrow({ where: { tenantId: TENANT } });
      const head = await unscopedPrisma.eventRecord.findFirstOrThrow({
        where: { tenantId: TENANT },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });

      const quote = await createQuote(opportunity.id, [
        { priceBookEntryId: entryA.id, quantity: 3, discountPct: 10 },
        { priceBookEntryId: entryB.id, quantity: 1, discountPct: 10 },
      ]);
      expect(formatMinor(quote.grandTotalMinor!)).toBe('2790.72');

      const result = await verifyChain(TENANT, { cursor: head.seq.toString() });
      expect(result.valid).toBe(true);
      expect(result.brokenAt).toBeNull();
      expect(result.checked).toBeGreaterThan(0);

      const emitted = await unscopedPrisma.eventRecord.findFirstOrThrow({
        where: { tenantId: TENANT, eventName: 'kz.crm.quote.created', subjectEntityId: quote.id },
        select: { newState: true },
      });
      expect(emitted.newState).toEqual(expect.objectContaining({ grandTotal: '2790.72', grandTotalMinor: '279072' }));
    });
  });
});
