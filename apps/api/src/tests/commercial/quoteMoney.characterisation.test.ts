/**
 * Characterisation of the quote and price book money figures on the wire
 * (ORDERED-PLAN 1.6, the last commercial slice): Quote subtotal, discountTotal and
 * grandTotal; QuoteLine listUnitPrice, discountAmount and lineTotal; and
 * PriceBookEntry unitPrice.
 *
 * Every figure is computed in paise from the stored price, rounded once, half away
 * from zero (owner decision, 2026-10-13). The old code computed these in floats and
 * let Postgres round the result, so an exact half paisa went whichever way the float
 * noise fell. Where the new figure differs by a paisa from the old one, the test
 * states the NEW value and the comment names the OLD one. Those assertions fail on
 * the old code; that is the point of them.
 *
 * Assertions without a comment about the old value pass on both the old and the new
 * code: the rupee fields keep their type and value on the wire. The `*Minor` siblings
 * are new and are only asserted in the tests that name them.
 *
 * The header total is rounded once from its exact sum, not summed from rounded lines:
 * the quote discount is the rounded total of the exact discounts, and so on. That is
 * pinned in the two-line case below, as it was in MONEY-S6 part 2.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server.js';
import { unscopedPrisma } from '../../platform/db.js';
import { verifyChain } from '../../platform/eventBus.js';
import { computeAuditHash, hashPayloadOf } from '../../platform/audit.js';
import { sessionToken, tenantId, principalFor, type TestPrincipal } from '../helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';

let server: Server;
let base: string;
let TENANT: string;
let token: string;
let chairman: TestPrincipal;

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

beforeAll(async () => {
  TENANT = await tenantId();
  chairman = await principalFor(CHAIRMAN);
  token = await sessionToken({
    userId: chairman.userId,
    tenantId: chairman.tenantId,
    affiliationId: chairman.affiliationId,
    stepUp: true,
  });
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(() => {
  server?.close();
});

/** A request as the chairman, with the JSON body and status. */
async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** The first object with this id anywhere in a response, however it is nested. */
function findById(node: unknown, id: string): any {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findById(item, id);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    if ((node as { id?: unknown }).id === id) return node;
    for (const value of Object.values(node)) {
      const hit = findById(value, id);
      if (hit) return hit;
    }
  }
  return null;
}

async function newOffering(label: string) {
  const res = await call('POST', '/commercial/offerings', {
    offeringCode: `QM-${label}-${stamp()}`,
    name: `Quote money ${label} ${stamp()}`,
    vertical: 'software_ai',
    deliveryModel: 'cohort',
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function publish(offeringId: string, unitPrice: number, maxDiscountPct = 100) {
  const res = await call('POST', `/commercial/offerings/${offeringId}/prices`, {
    currency: 'INR',
    unitPrice,
    billingFrequency: 'one_time',
    maxDiscountPct,
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; unitPrice: string; unitPriceMinor?: string };
}

describe('ORDERED-PLAN 1.6: quote and price book money, characterised on the wire', () => {
  let quoteOpportunityId: string;
  let entry1000_25: string;
  let entry100_05: string;
  let entry0_15: string;
  let entry0_35: string;
  let entry0_05: string;
  let entry0_25: string;
  let entry158_39: string;
  let entryCeiling5: string;

  beforeAll(async () => {
    quoteOpportunityId = (await unscopedPrisma.opportunity.findFirstOrThrow({ where: { tenantId: TENANT } })).id;

    entry1000_25 = (await publish(await newOffering('A'), 1000.25)).id;
    entry100_05 = (await publish(await newOffering('B'), 100.05)).id;
    entry0_15 = (await publish(await newOffering('C'), 0.15)).id;
    entry0_35 = (await publish(await newOffering('D'), 0.35)).id;
    entry0_05 = (await publish(await newOffering('E'), 0.05)).id;
    entry0_25 = (await publish(await newOffering('J'), 0.25)).id;
    entry158_39 = (await publish(await newOffering('K'), 158.39)).id;
    entryCeiling5 = (await publish(await newOffering('F'), 1000.25, 5)).id;
  });

  describe('price book entries', () => {
    it('a published price goes out as the Decimal string it always was, and is listed as a number', async () => {
      const offeringId = await newOffering('G');
      const published = await call('POST', `/commercial/offerings/${offeringId}/prices`, {
        currency: 'INR',
        unitPrice: 1000.25,
        billingFrequency: 'one_time',
        maxDiscountPct: 100,
      });
      expect(published.status).toBe(201);
      expect(published.body.unitPrice).toBe('1000.25');

      const prices = await call('GET', `/commercial/offerings/${offeringId}/prices`);
      expect(prices.status).toBe(200);
      expect(prices.body[0].unitPrice).toBe('1000.25');

      const offerings = await call('GET', '/commercial/offerings');
      const offering = findById(offerings.body, offeringId);
      expect(offering.activePriceBookEntries[0].unitPrice).toBe(1000.25);
    });

    it('a three-decimal price is stored at the paisa the database rounds it to, 33.34', async () => {
      // 33.335 is a tie. The database rounded it half up before the change, and
      // toMinorHalfUp does the same from the shortest decimal, so both give 33.34.
      const offeringId = await newOffering('H');
      const published = await publish(offeringId, 33.335);
      expect(published.unitPrice).toBe('33.34');

      const offerings = await call('GET', '/commercial/offerings');
      expect(findById(offerings.body, offeringId).activePriceBookEntries[0].unitPrice).toBe(33.34);
    });

    it('the price is sent in paise beside the rupee field', async () => {
      const offeringId = await newOffering('I');
      const published = await publish(offeringId, 1000.25);
      expect(published.unitPriceMinor).toBe('100025');

      const prices = await call('GET', `/commercial/offerings/${offeringId}/prices`);
      expect(prices.body[0].unitPriceMinor).toBe('100025');

      const offerings = await call('GET', '/commercial/offerings');
      expect(findById(offerings.body, offeringId).activePriceBookEntries[0].unitPriceMinor).toBe('100025');
    });
  });

  describe('quotes: create, lines and the list route', () => {
    it('one line, 10% off a half-paisa discount: 300.075 rounds half away to 300.08 (pass on both)', async () => {
      // 1000.25 x 3 = 3000.75. Ten per cent is 300.075, a tie. The total is 2700.675, also a tie.
      const created = await call('POST', '/commercial/quotes', {
        opportunityId: quoteOpportunityId,
        lines: [{ priceBookEntryId: entry1000_25, quantity: 3, discountPct: 10 }],
      });
      expect(created.status).toBe(201);
      expect(created.body.subtotal).toBe('3000.75');
      expect(created.body.discountTotal).toBe('300.08');
      expect(created.body.grandTotal).toBe('2700.68');

      const listed = await call('GET', `/commercial/quotes?opportunityId=${quoteOpportunityId}`);
      const quote = findById(listed.body, created.body.id);
      expect(quote.subtotal).toBe(3000.75);
      expect(quote.discountTotal).toBe(300.08);
      expect(quote.grandTotal).toBe(2700.68);
      expect(quote.lines[0].listUnitPrice).toBe(1000.25);
      expect(quote.lines[0].discountAmount).toBe(300.08);
      expect(quote.lines[0].lineTotal).toBe(2700.68);
    });

    it('two lines: the quote discount is the rounded total of the exact discounts, not of the rounded lines (pass on both)', async () => {
      // Line B: 100.05 at 10% is 10.005, a tie that rounds to 10.01. Line A: 300.075 to 300.08.
      // The quote discount is round(310.08), not 300.08 + 10.01 = 310.09.
      const created = await call('POST', '/commercial/quotes', {
        opportunityId: quoteOpportunityId,
        lines: [
          { priceBookEntryId: entry1000_25, quantity: 3, discountPct: 10 },
          { priceBookEntryId: entry100_05, quantity: 1, discountPct: 10 },
        ],
      });
      expect(created.status).toBe(201);
      expect(created.body.subtotal).toBe('3100.8');
      expect(created.body.discountTotal).toBe('310.08');
      expect(created.body.grandTotal).toBe('2790.72');

      const listed = await call('GET', `/commercial/quotes?opportunityId=${quoteOpportunityId}`);
      const quote = findById(listed.body, created.body.id);
      expect(quote.lines.map((l: any) => l.discountAmount)).toEqual([300.08, 10.01]);
      expect(quote.lines.map((l: any) => l.lineTotal)).toEqual([2700.68, 90.05]);
    });

    it('a tie that does not move: 10% off 0.05 is 0.01 off, and 0.05 total (pass on both)', async () => {
      // 0.005 rounds to 0.01 and 0.045 rounds to 0.05, half away from zero. The old
      // float path reached the same paisa here, so this pins the tie that stays.
      const created = await call('POST', '/commercial/quotes', {
        opportunityId: quoteOpportunityId,
        lines: [{ priceBookEntryId: entry0_05, quantity: 1, discountPct: 10 }],
      });
      expect(created.status).toBe(201);
      expect(created.body.subtotal).toBe('0.05');
      expect(created.body.discountTotal).toBe('0.01');
      expect(created.body.grandTotal).toBe('0.05');

      const listed = await call('GET', `/commercial/quotes?opportunityId=${quoteOpportunityId}`);
      const quote = findById(listed.body, created.body.id);
      expect(quote.lines[0].discountAmount).toBe(0.01);
      expect(quote.lines[0].lineTotal).toBe(0.05);
    });

    it('3 x 0.15 at 90%: the discount 0.405 rounds half away to 0.41, where the float path gave 0.40', async () => {
      // Old wire: discountTotal '0.4' and discountAmount '0.4'. The total 0.045 is 0.05 both ways.
      const created = await call('POST', '/commercial/quotes', {
        opportunityId: quoteOpportunityId,
        lines: [{ priceBookEntryId: entry0_15, quantity: 3, discountPct: 90 }],
      });
      expect(created.status).toBe(201);
      expect(created.body.subtotal).toBe('0.45');
      expect(created.body.discountTotal).toBe('0.41');
      expect(created.body.grandTotal).toBe('0.05');

      const listed = await call('GET', `/commercial/quotes?opportunityId=${quoteOpportunityId}`);
      const quote = findById(listed.body, created.body.id);
      expect(quote.discountTotal).toBe(0.41);
      expect(quote.lines[0].discountAmount).toBe(0.41);
      expect(quote.lines[0].lineTotal).toBe(0.05);
    });

    it('1 x 0.25 at 90%: the total 0.025 rounds half away to 0.03, where the float path gave 0.02', async () => {
      // Old wire: lineTotal '0.02' and grandTotal '0.02'. The discount 0.225 is 0.23 both ways.
      const created = await call('POST', '/commercial/quotes', {
        opportunityId: quoteOpportunityId,
        lines: [{ priceBookEntryId: entry0_25, quantity: 1, discountPct: 90 }],
      });
      expect(created.status).toBe(201);
      expect(created.body.discountTotal).toBe('0.23');
      expect(created.body.grandTotal).toBe('0.03');

      const listed = await call('GET', `/commercial/quotes?opportunityId=${quoteOpportunityId}`);
      const quote = findById(listed.body, created.body.id);
      expect(quote.grandTotal).toBe(0.03);
      expect(quote.lines[0].lineTotal).toBe(0.03);
    });

    it('1 x 158.39 at 50%: the discount and the total are both 79.195, which round to 79.20 (old 79.19)', async () => {
      // Old wire: discountTotal, discountAmount, lineTotal and grandTotal all '79.19'.
      const created = await call('POST', '/commercial/quotes', {
        opportunityId: quoteOpportunityId,
        lines: [{ priceBookEntryId: entry158_39, quantity: 1, discountPct: 50 }],
      });
      expect(created.status).toBe(201);
      expect(created.body.subtotal).toBe('158.39');
      expect(created.body.discountTotal).toBe('79.2');
      expect(created.body.grandTotal).toBe('79.2');

      const listed = await call('GET', `/commercial/quotes?opportunityId=${quoteOpportunityId}`);
      const quote = findById(listed.body, created.body.id);
      expect(quote.grandTotal).toBe(79.2);
      expect(quote.lines[0].discountAmount).toBe(79.2);
      expect(quote.lines[0].lineTotal).toBe(79.2);
    });

    it('6 x 0.35 at 5%: the discount 0.105 and total 1.995 both round up, to 0.11 and 2 (pass on both)', async () => {
      // The float path reached the same paisa here, so this pins a tie that does not move.
      const created = await call('POST', '/commercial/quotes', {
        opportunityId: quoteOpportunityId,
        lines: [{ priceBookEntryId: entry0_35, quantity: 6, discountPct: 5 }],
      });
      expect(created.status).toBe(201);
      expect(created.body.subtotal).toBe('2.1');
      expect(created.body.discountTotal).toBe('0.11');
      expect(created.body.grandTotal).toBe('2');

      const listed = await call('GET', `/commercial/quotes?opportunityId=${quoteOpportunityId}`);
      const quote = findById(listed.body, created.body.id);
      expect(quote.discountTotal).toBe(0.11);
      expect(quote.grandTotal).toBe(2);
      expect(quote.lines[0].discountAmount).toBe(0.11);
      expect(quote.lines[0].lineTotal).toBe(2);
    });

    it('the quote and its lines carry their paise beside each rupee field (new)', async () => {
      const created = await call('POST', '/commercial/quotes', {
        opportunityId: quoteOpportunityId,
        lines: [{ priceBookEntryId: entry0_15, quantity: 3, discountPct: 90 }],
      });
      expect(created.body.grandTotalMinor).toBe('5');
      expect(created.body.subtotalMinor).toBe('45');
      expect(created.body.discountTotalMinor).toBe('41');

      const listed = await call('GET', `/commercial/quotes?opportunityId=${quoteOpportunityId}`);
      const quote = findById(listed.body, created.body.id);
      expect(quote.grandTotalMinor).toBe('5');
      expect(quote.lines[0].listUnitPriceMinor).toBe('15');
      expect(quote.lines[0].discountAmountMinor).toBe('41');
      expect(quote.lines[0].lineTotalMinor).toBe('5');
    });
  });

  describe('quotes: issue, block and the opportunity detail route', () => {
    it('an issued quote keeps its wire figures, and the opportunity detail carries the paise beside them (new)', async () => {
      const created = await call('POST', '/commercial/quotes', {
        opportunityId: quoteOpportunityId,
        lines: [
          { priceBookEntryId: entry1000_25, quantity: 3, discountPct: 10 },
          { priceBookEntryId: entry100_05, quantity: 1, discountPct: 10 },
        ],
      });
      expect(created.status).toBe(201);

      const issued = await call('POST', `/commercial/quotes/${created.body.id}/issue`, {});
      expect(issued.status).toBe(200);
      expect(issued.body.issued).toBe(true);
      expect(issued.body.quote.status).toBe('issued');
      expect(issued.body.quote.grandTotal).toBe('2790.72');
      expect(issued.body.quote.subtotal).toBe('3100.8');

      // The opportunity detail sends the Decimal object as applyFieldVisibility leaves it:
      // decimal.js's internal form, not a string. It is pinned as the wire it is today, not as
      // a contract (the proposal and MoU entries in the same route do the same). The paise
      // sibling is new.
      const detail = await call('GET', `/crm/opportunities/${quoteOpportunityId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.quote.grandTotal).toEqual({ s: 1, e: 3, d: [2790, 7200000] });
      expect(detail.body.quote.grandTotalMinor).toBe('279072');
      expect(detail.body.quote.lines.map((l: any) => l.lineTotalMinor)).toEqual(['270068', '9005']);
    });

    it('a quote over its discount ceiling blocks, and the approval step holds the exact total', async () => {
      // 1000.25 x 1 at 10% is 100.025 off, a tie, so the discount is 100.03 and the total 900.225,
      // which rounds to 900.23. Both figures are the same on the old code (pass on both).
      const created = await call('POST', '/commercial/quotes', {
        opportunityId: quoteOpportunityId,
        lines: [{ priceBookEntryId: entryCeiling5, quantity: 1, discountPct: 10 }],
      });
      expect(created.status).toBe(201);
      expect(created.body.discountTotal).toBe('100.03');
      expect(created.body.grandTotal).toBe('900.23');

      const blocked = await call('POST', `/commercial/quotes/${created.body.id}/issue`, {});
      expect(blocked.status).toBe(200);
      expect(blocked.body.issued).toBe(false);
      expect(blocked.body.quote.status).toBe('blocked');
      expect(blocked.body.blockedLines[0].discountPct).toBe(10);

      const step = await unscopedPrisma.approvalStep.findFirstOrThrow({
        where: { tenantId: TENANT, id: blocked.body.approvalStepId },
      });
      expect(step.requestedValueMinor).toBe(90023n);
    });
  });

  describe('paise on the events and the audit trail', () => {
    it('the quote.created body carries the stored total as a two-place string and its paise (new)', async () => {
      // Old body: grandTotal '79.19' (the stored value), and no grandTotalMinor.
      const head = await unscopedPrisma.eventRecord.findFirstOrThrow({
        where: { tenantId: TENANT },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const created = await call('POST', '/commercial/quotes', {
        opportunityId: quoteOpportunityId,
        lines: [{ priceBookEntryId: entry158_39, quantity: 1, discountPct: 50 }],
      });
      expect(created.status).toBe(201);

      const emitted = await unscopedPrisma.eventRecord.findFirstOrThrow({
        where: { tenantId: TENANT, eventName: 'kz.crm.quote.created', subjectEntityId: created.body.id },
        select: { newState: true },
      });
      expect(emitted.newState).toEqual(expect.objectContaining({ grandTotal: '79.20', grandTotalMinor: '7920' }));

      const chain = await verifyChain(TENANT, { cursor: head.seq.toString() });
      expect(chain.valid).toBe(true);
      expect(chain.brokenAt).toBeNull();
    });

    it('issuing the quote emits its total as a number, 79.2 (old 79.19), and the audit rows carry the paise and verify (new)', async () => {
      const created = await call('POST', '/commercial/quotes', {
        opportunityId: quoteOpportunityId,
        lines: [{ priceBookEntryId: entry158_39, quantity: 1, discountPct: 50 }],
      });
      expect(created.status).toBe(201);
      const issued = await call('POST', `/commercial/quotes/${created.body.id}/issue`, {});
      expect(issued.body.issued).toBe(true);

      const emitted = await unscopedPrisma.eventRecord.findFirstOrThrow({
        where: { tenantId: TENANT, eventName: 'kz.crm.quote.issued', subjectEntityId: created.body.id },
        select: { newState: true },
      });
      expect((emitted.newState as { grandTotal: number }).grandTotal).toBe(79.2);

      // The quote-update audit diffs carry the exact paise.
      const update = await unscopedPrisma.auditRecord.findFirstOrThrow({
        where: { tenantId: TENANT, subjectType: 'quote', subjectId: created.body.id, action: 'update' },
        orderBy: { seq: 'asc' },
        select: { diff: true },
      });
      expect(update.diff).toEqual(
        expect.objectContaining({
          grandTotalMinor: { from: null, to: '7920' },
          subtotalMinor: { from: null, to: '15839' },
        }),
      );

      // Every audit row this quote wrote verifies once stored: its hash is recomputed from
      // the row as read back, and its prevHash is the hash of the row before it in the chain.
      // verifyAuditChain walks from genesis, so it stops at the float-hashed quote rows that
      // earlier runs left on this database (the first is seq 95: hashed over 2790.7200000000003,
      // read back as 2790.72). Those rows are immutable and are not rewritten here. This check
      // covers the rows this change writes and is the verifier's per-row test, not a shortcut.
      const rows = await unscopedPrisma.auditRecord.findMany({
        where: { tenantId: TENANT, subjectType: 'quote', subjectId: created.body.id },
        orderBy: { seq: 'asc' },
      });
      expect(rows.length).toBeGreaterThanOrEqual(3);
      for (const row of rows) {
        const prior = await unscopedPrisma.auditRecord.findFirst({
          where: { tenantId: TENANT, seq: { lt: row.seq }, hash: { not: null } },
          orderBy: { seq: 'desc' },
          select: { hash: true },
        });
        expect(row.prevHash).toBe(prior?.hash ?? null);
        expect(row.hash).toBe(computeAuditHash(hashPayloadOf(row), row.prevHash));
      }
    });
  });
});
