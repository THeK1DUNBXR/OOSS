/**
 * Credit notes post to the journal (Phase 0, owner decision 2026-10-13: the follow-up to invoice
 * posting). A note takes back its share of the invoice it credits: the receivable is credited the
 * note's amount, and revenue and each output tax are debited the parts the invoice's own components
 * give it, in paise (postingRules.ts buildCreditNoteEntry).
 *
 * Real Postgres through the API, the routes and the ledger. Each test raises its own invoice, and
 * the receivable is read as a movement from the party's own start, so no test relies on another's rows.
 */

import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server.js';
import { asUser, principalFor, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from '../helpers.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { prisma } from '../../platform/db.js';
import { balanceOf } from '../../platform/ledger.js';
import { postCreditNote } from '../../domains/invoicePosting.js';
import { readyInvoicePosting } from '../fixtures/invoicePostingReady.js';
import { addMissingGrants } from '../../platform/grantSync.js';

const LATHA = 'latha@kaizen.co.in';
const DIVISION = 'education';
let server: Server;
let base: string;
let TENANT: string;
let latha: TestPrincipal;

beforeAll(async () => {
  TENANT = await tenantId();
  await readyInvoicePosting(TENANT);
  // The employee's transactions:create cell reaches a tenant seeded before it, here as at boot (grantSync.ts).
  await addMissingGrants(TENANT);
  latha = await principalFor(LATHA);
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(() => {
  server?.close();
});

async function call(method: 'GET' | 'POST', path: string, body?: unknown, who: TestPrincipal = latha) {
  const token = await sessionToken({
    userId: who.userId,
    tenantId: who.tenantId,
    affiliationId: who.affiliationId,
    stepUp: true,
  });
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

async function anOrganization() {
  const account = await unscopedPrisma.account.findFirstOrThrow({
    where: { tenantId: TENANT, gstin: { not: null } },
  });
  return account.organizationId;
}

/**
 * Scenario A from invoiceMoneyCharacterisation: 1234.57 at 18%, intra-state, rounded up by 0.21.
 * Grand total 1457.00 (145700 paise): taxable 123457, CGST 11111, SGST 11111, round-off 21.
 */
function scenarioA(organizationId: string, extra: Record<string, unknown> = {}) {
  return {
    organizationId,
    placeOfSupply: '33',
    division: DIVISION,
    lines: [{ description: 'Programme', quantity: 1, unitPrice: 1234.57, gstRate: 18 }],
    ...extra,
  };
}

/** Orders paise without a float: Number(a - b) would read a large difference through a double. */
const byMinor = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** The journal entries a document posted under one source, with their lines. */
async function entriesFor(sourceType: string, sourceId: string) {
  return unscopedPrisma.journalEntry.findMany({
    where: { tenantId: TENANT, sourceType, sourceId },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
}

async function trialBalanceHolds() {
  const tb = await asUser(LATHA, async () => journalTrialBalance(new Date()));
  expect(() => assertTrialBalance(tb)).not.toThrow();
}

async function divisionLineId(division: string): Promise<string> {
  const mapping = await unscopedPrisma.invoiceDivisionLine.findFirstOrThrow({
    where: { tenantId: TENANT, division, effectiveTo: null },
  });
  return mapping.lineId;
}

async function receivableAccountId(): Promise<string> {
  const mapped = await unscopedPrisma.ledgerPostingRole.findFirstOrThrow({
    where: { tenantId: TENANT, role: 'TRADE_RECEIVABLE', scopeKey: '' },
  });
  return mapped.ledgerAccountId;
}

async function receivableOf(organizationId: string, receivable: string): Promise<bigint> {
  return asUser(LATHA, () => balanceOf(receivable, new Date(), { partyId: organizationId }));
}

describe('a part credit against an issued invoice posts its share, in the invoice proportion', () => {
  it('500.00 off 1457.00: the receivable falls by exactly 500.00, and revenue and each tax fall in proportion', async () => {
    const org = await anOrganization();
    const receivable = await receivableAccountId();
    const lineId = await divisionLineId(DIVISION);
    // Read before the invoice is raised: the issue posts 1457.00 to the same receivable, and the
    // movement this test checks has to include that issue (the second test reads its baseline the same way).
    const beforeIssue = await receivableOf(org, receivable);
    const invoice = (await call('POST', '/finance/invoices', scenarioA(org))).body;
    expect(invoice.grandTotalMinor).toBe('145700');

    const credited = await call('POST', `/finance/invoices/${invoice.id}/credit-note`, {
      amount: 500,
      reason: 'Rate correction',
    });
    expect(credited.status).toBe(200);
    expect(credited.body.amountMinor).toBe('50000');

    const [entry] = await entriesFor('credit_note', credited.body.id);
    expect(entry).toBeDefined();
    expect(entry!.idempotencyKey).toBe(`credit_note:${credited.body.id}`);
    expect(entry!.lines.reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(0n);

    // The receivable is credited the note's amount, to the customer.
    expect(entry!.lines).toContainEqual(
      expect.objectContaining({ accountId: receivable, amountMinor: -50000n, partyId: org }),
    );
    // Revenue, CGST, SGST and round-off, each as the proportion gives it: 500.00 of 1457.00 is
    // 42368 taxable, 3813 CGST, 3812 SGST and 7 round-off, which sum to 50000 (allocate's paise).
    expect(entry!.lines.map((l) => l.amountMinor).sort(byMinor)).toEqual(
      [-50000n, 3812n, 3813n, 7n, 42368n].sort(byMinor),
    );
    expect(entry!.lines.find((l) => l.amountMinor === 42368n)?.lineId).toBe(lineId);
    expect(entry!.lines.find((l) => l.amountMinor === 7n)?.lineId).toBe(lineId);
    await trialBalanceHolds();

    // From the baseline taken before the issue: the issue adds 1457.00 and the note takes 500.00 back,
    // so 957.00 is left on the receivable.
    expect((await receivableOf(org, receivable)) - beforeIssue).toBe(145700n - 50000n);
  });
});

describe('a credit of the whole grand total reverses the issue to the paisa', () => {
  it('1457.00 off 1457.00: each line of the issue is reversed, and the receivable nets to zero', async () => {
    const org = await anOrganization();
    const receivable = await receivableAccountId();
    const beforeIssue = await receivableOf(org, receivable);
    const invoice = (await call('POST', '/finance/invoices', scenarioA(org))).body;

    const credited = await call('POST', `/finance/invoices/${invoice.id}/credit-note`, {
      amount: 1457,
      reason: 'Cancelled in full',
    });
    expect(credited.status).toBe(200);
    expect(credited.body.amountMinor).toBe('145700');

    const [entry] = await entriesFor('credit_note', credited.body.id);
    expect(entry!.lines.map((l) => l.amountMinor).sort(byMinor)).toEqual(
      [-145700n, 11111n, 11111n, 21n, 123457n].sort(byMinor),
    );
    await trialBalanceHolds();
    expect(await receivableOf(org, receivable)).toBe(beforeIssue);
  });
});

describe('a credit against an invoice issued before posting was wired posts nothing (owner decision, 2026-10-13)', () => {
  // Interim rule, pending the owner's backfill decision: an issued invoice with no
  // `invoice:<id>:issue` entry has nothing to reverse, so its note posts nothing either. The
  // note row is still written. The invoice is written the way the old code issued it, with no entry.
  it('the note is written with no journal entry, and the receivable does not move', async () => {
    const org = await anOrganization();
    const receivable = await receivableAccountId();
    const draft = (await call('POST', '/finance/invoices', scenarioA(org, { issue: false }))).body;
    await unscopedPrisma.invoice.update({
      where: { id: draft.id },
      data: { status: 'issued', issuedDate: new Date(), recordCode: `LEGACY-${randomUUID().slice(0, 8)}` },
    });
    const before = await receivableOf(org, receivable);

    const credited = await call('POST', `/finance/invoices/${draft.id}/credit-note`, {
      amount: 100,
      reason: 'Legacy correction',
    });
    expect(credited.status).toBe(200);
    expect(await entriesFor('credit_note', credited.body.id)).toHaveLength(0);
    expect(await unscopedPrisma.creditNote.count({ where: { tenantId: TENANT, invoiceId: draft.id } })).toBe(1);
    expect((await receivableOf(org, receivable)) - before).toBe(0n);
    await trialBalanceHolds();
  });
});

describe('a credit against a course-fee invoice posts nothing (owner decision, 2026-10-13)', () => {
  // A course-fee invoice has no issue entry either, so the enrolment gate and the legacy gate
  // both withhold it. The test pins the outcome the owner decided: no note entry, a note row.
  it('the temp-series invoice is credited, and no journal entry is written for the note', async () => {
    const org = await anOrganization();
    const receivable = await receivableAccountId();
    const created = await call('POST', '/finance/invoices', scenarioA(org, { enrollmentDate: '2026-10-01' }));
    expect(created.status).toBe(201);
    expect(created.body.invoiceType).toBe('temp');
    const before = await receivableOf(org, receivable);

    const credited = await call('POST', `/finance/invoices/${created.body.id}/credit-note`, {
      amount: 200,
      reason: 'Course withdrawn',
    });
    expect(credited.status).toBe(200);
    expect(await entriesFor('credit_note', credited.body.id)).toHaveLength(0);
    expect((await receivableOf(org, receivable)) - before).toBe(0n);
    await trialBalanceHolds();
  });
});

describe('a credit note against an invoice not in this tenant is refused', () => {
  // Before the fix a note was written against any id, with no invoice behind it.
  it('404, and no note row is written against that id', async () => {
    const missing = randomUUID();
    const res = await call('POST', `/finance/invoices/${missing}/credit-note`, {
      amount: 100,
      reason: 'No such invoice',
    });
    expect(res.status).toBe(404);
    expect(await unscopedPrisma.creditNote.count({ where: { tenantId: TENANT, invoiceId: missing } })).toBe(0);
  });
});

describe('a credit note may not exceed what the invoice has left (paise, under the invoice lock)', () => {
  it('a note over the balance is refused 422 and names the balance; an exact balance is allowed', async () => {
    const org = await anOrganization();
    const receivable = await receivableAccountId();
    const invoice = (await call('POST', '/finance/invoices', scenarioA(org))).body;
    const first = await call('POST', `/finance/invoices/${invoice.id}/credit-note`, { amount: 1000, reason: 'Part' });
    expect(first.status).toBe(200);
    const beforeRefusal = await receivableOf(org, receivable);

    // 1457.00 less 1000.00 leaves 457.00.
    const over = await call('POST', `/finance/invoices/${invoice.id}/credit-note`, { amount: 500, reason: 'Too much' });
    expect(over.status).toBe(422);
    expect(over.body.message ?? JSON.stringify(over.body)).toMatch(/only ₹457\.00 left to credit/);
    expect(await unscopedPrisma.creditNote.count({ where: { tenantId: TENANT, invoiceId: invoice.id } })).toBe(1);
    expect(await receivableOf(org, receivable)).toBe(beforeRefusal);

    // The exact balance is allowed, and then nothing is left.
    const exact = await call('POST', `/finance/invoices/${invoice.id}/credit-note`, { amount: 457, reason: 'Balance' });
    expect(exact.status).toBe(200);
    const none = await call('POST', `/finance/invoices/${invoice.id}/credit-note`, {
      amount: 0.01,
      reason: 'Past zero',
    });
    expect(none.status).toBe(422);
    await trialBalanceHolds();
  });

  it('two notes raced against one invoice: one is issued, the other is refused, and the balance holds', async () => {
    // Each is 1000.00 against 1457.00: both read the full balance unless the invoice lock serialises them.
    const org = await anOrganization();
    const invoice = (await call('POST', '/finance/invoices', scenarioA(org))).body;
    const [a, b] = await Promise.all([
      call('POST', `/finance/invoices/${invoice.id}/credit-note`, { amount: 1000, reason: 'Race A' }),
      call('POST', `/finance/invoices/${invoice.id}/credit-note`, { amount: 1000, reason: 'Race B' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    expect(await unscopedPrisma.creditNote.count({ where: { tenantId: TENANT, invoiceId: invoice.id } })).toBe(1);
    await trialBalanceHolds();
  });

  it('a legacy invoice (no issue entry) is capped the same way, and posts nothing', async () => {
    // The lock and the cap apply even where the note will not post, so the legacy invoice is not a way round the cap.
    const org = await anOrganization();
    const draft = (await call('POST', '/finance/invoices', scenarioA(org, { issue: false }))).body;
    await unscopedPrisma.invoice.update({
      where: { id: draft.id },
      data: { status: 'issued', issuedDate: new Date(), recordCode: `LEGACY-${randomUUID().slice(0, 8)}` },
    });
    const over = await call('POST', `/finance/invoices/${draft.id}/credit-note`, { amount: 1500, reason: 'Over' });
    expect(over.status).toBe(422);
    const exact = await call('POST', `/finance/invoices/${draft.id}/credit-note`, { amount: 1457, reason: 'Whole' });
    expect(exact.status).toBe(200);
    expect(await entriesFor('credit_note', exact.body.id)).toHaveLength(0);
    await trialBalanceHolds();
  });
});

describe('an idempotent replay of a credit note posting writes no second entry', () => {
  it('posting the same note again in a new transaction returns the first entry', async () => {
    const org = await anOrganization();
    const invoice = (await call('POST', '/finance/invoices', scenarioA(org))).body;
    const credited = await call('POST', `/finance/invoices/${invoice.id}/credit-note`, {
      amount: 500,
      reason: 'Rate correction',
    });
    expect(credited.status).toBe(200);
    const [first] = await entriesFor('credit_note', credited.body.id);
    expect(first).toBeDefined();

    const note = await unscopedPrisma.creditNote.findFirstOrThrow({
      where: { tenantId: TENANT, id: credited.body.id },
    });
    const row = await unscopedPrisma.invoice.findFirstOrThrow({ where: { tenantId: TENANT, id: invoice.id } });
    const again = await asUser(LATHA, () => prisma.$transaction((tx) => postCreditNote(tx, note, row)));
    expect(again?.id).toBe(first!.id);
    expect(await entriesFor('credit_note', credited.body.id)).toHaveLength(1);
    await trialBalanceHolds();
  });
});
