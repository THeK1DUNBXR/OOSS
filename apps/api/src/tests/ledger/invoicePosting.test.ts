/**
 * Invoice posting (Phase 0, owner decision 2026-10-13): an issue and each receipt post
 * their journal entry in the transaction that writes the document, through postInTx.
 *
 * Real Postgres through the API, the routes and the ledger. The entries are read from the
 * journal and checked against the figures the invoice and the receipt store (rule 1: the
 * journal says what the document says, in paise).
 */

import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server.js';
import { asUser, principalFor, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from '../helpers.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { prisma } from '../../platform/db.js';
import { balanceOf } from '../../platform/ledger.js';
import { postInvoiceIssue } from '../../domains/invoicePosting.js';
import { reversePayment } from '../../domains/finance.js';
import { readyInvoicePosting } from '../fixtures/invoicePostingReady.js';
import { addMissingGrants } from '../../platform/grantSync.js';
import { checkTransactionAllowed } from '../../domains/books.js';

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

/** Scenario A from invoiceMoneyCharacterisation: 1234.57 at 18%, intra-state, rounded up by 0.21. */
function scenarioA(organizationId: string, extra: Record<string, unknown> = {}) {
  return {
    organizationId,
    placeOfSupply: '33',
    division: DIVISION,
    lines: [{ description: 'Programme', quantity: 1, unitPrice: 1234.57, gstRate: 18 }],
    ...extra,
  };
}

function withoutDivisionOf(body: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...body };
  delete copy.division;
  return copy;
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

describe('issuing an invoice posts one balanced entry that says what the invoice stores', () => {
  it('a GST intra-state invoice with round-off: receivable debited the grand total, each credit as stored', async () => {
    const created = await call('POST', '/finance/invoices', scenarioA(await anOrganization()));
    expect(created.status).toBe(201);
    const inv = created.body;
    expect(inv.grandTotalMinor).toBe('145700');

    const entries = await entriesFor('invoice', inv.id);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry!.idempotencyKey).toBe(`invoice:${inv.id}:issue`);

    const total = entry!.lines.reduce((sum, line) => sum + line.amountMinor, 0n);
    expect(total).toBe(0n);

    const lineId = await divisionLineId(DIVISION);
    const receivable = await receivableAccountId();
    const posted = entry!.lines.map((l) => [l.accountId, l.amountMinor, l.lineId, l.partyId] as const);

    // Receivable, debited the grand total, to the customer.
    expect(posted).toContainEqual([receivable, 145700n, null, expect.any(String)]);
    // Revenue under the line the division maps to, the taxable value as stored.
    expect(entry!.lines.find((l) => l.lineId === lineId && l.amountMinor === -123457n)).toBeDefined();
    // The tax and the round-off as the invoice stores them (credited, round-off up by 21).
    expect(entry!.lines.map((l) => l.amountMinor).sort(byMinor)).toEqual(
      [-123457n, -21n, -11111n, -11111n, 145700n].sort(byMinor),
    );
    expect(entry!.lines.find((l) => l.amountMinor === -21n)?.lineId).toBe(lineId);
    await trialBalanceHolds();
  });
});

describe('a payment at issue and a later instalment each post the receipt allocation', () => {
  it('two instalments: each receipt posts Dr bank, Cr receivable, and the receivable nets to zero', async () => {
    const org = await anOrganization();
    // The tenant is shared across the file, so the receivable is read as a movement from here.
    const receivableStart = await receivableBalance(org);
    const created = await call('POST', '/finance/invoices', scenarioA(org, { payment: { amount: 500, mode: 'cash' } }));
    expect(created.status).toBe(201);
    const inv = created.body;
    expect(created.body.receipt).not.toBeNull();

    const first = await entriesFor('receipt', created.body.receipt.id);
    expect(first).toHaveLength(1);
    expect(first[0]!.lines.map((l) => l.amountMinor).sort(byMinor)).toEqual([-50000n, 50000n]);
    expect(first[0]!.idempotencyKey).toBe(`receipt:${created.body.receipt.id}`);
    await trialBalanceHolds();
    const receivable = await receivableAccountId();
    const afterFirst = await asUser(LATHA, () => balanceOf(receivable, new Date(), { partyId: org }));
    expect(afterFirst - receivableStart).toBe(95700n);

    const second = await call('POST', `/finance/invoices/${inv.id}/collect`, { amount: 957, mode: 'bank_transfer' });
    expect(second.status).toBe(200);
    const instalment = await entriesFor('receipt', second.body.receipt.id);
    expect(instalment).toHaveLength(1);
    expect(instalment[0]!.lines.map((l) => l.amountMinor).sort(byMinor)).toEqual([-95700n, 95700n]);
    await trialBalanceHolds();

    const afterSecond = await asUser(LATHA, () => balanceOf(receivable, new Date(), { partyId: org }));
    expect(afterSecond - receivableStart).toBe(0n);
    // The journal carries the receipt's own figure, not a float of it.
    const receipt = await unscopedPrisma.receipt.findFirstOrThrow({ where: { id: second.body.receipt.id } });
    expect(receipt.allocatedAmount.toFixed(2)).toBe('957.00');
  });
});

describe('a refused issue leaves nothing behind', () => {
  it('an invoice with no division is refused at issue; no invoice and no journal rows are written', async () => {
    const org = await anOrganization();
    const before = await unscopedPrisma.journalEntry.count({ where: { tenantId: TENANT } });
    const invoicesBefore = await unscopedPrisma.invoice.count({ where: { tenantId: TENANT, organizationId: org } });
    const withoutDivision = withoutDivisionOf(scenarioA(org));

    const res = await call('POST', '/finance/invoices', withoutDivision);
    expect(res.status).toBe(422);
    expect(res.body.message ?? JSON.stringify(res.body)).toMatch(/division/);

    expect(await unscopedPrisma.journalEntry.count({ where: { tenantId: TENANT } })).toBe(before);
    expect(await unscopedPrisma.invoice.count({ where: { tenantId: TENANT, organizationId: org } })).toBe(
      invoicesBefore,
    );
    await trialBalanceHolds();
  });

  it('a draft with no division stays a draft when its issue is refused, with no number and no entry', async () => {
    const org = await anOrganization();
    const withoutDivision = withoutDivisionOf(scenarioA(org, { issue: false }));
    const draft = (await call('POST', '/finance/invoices', withoutDivision)).body;
    expect(draft.status).toBe('draft');
    const before = await unscopedPrisma.journalEntry.count({ where: { tenantId: TENANT } });

    const res = await call('POST', `/finance/invoices/${draft.id}/issue`, {});
    expect(res.status).toBe(422);
    const row = await unscopedPrisma.invoice.findFirstOrThrow({ where: { id: draft.id } });
    expect(row.status).toBe('draft');
    expect(row.recordCode).toBeNull();
    expect(await unscopedPrisma.journalEntry.count({ where: { tenantId: TENANT } })).toBe(before);
    expect(await entriesFor('invoice', draft.id)).toHaveLength(0);
  });

  it('an invoice with no ledger entity is refused at issue, and names the entity', async () => {
    const org = await anOrganization();
    const draft = (await call('POST', '/finance/invoices', scenarioA(org, { issue: false }))).body;
    await unscopedPrisma.invoice.update({ where: { id: draft.id }, data: { ledgerEntityId: null } });

    const res = await call('POST', `/finance/invoices/${draft.id}/issue`, {});
    expect(res.status).toBe(422);
    expect(res.body.message ?? JSON.stringify(res.body)).toMatch(/ledger entity/);
    expect(await entriesFor('invoice', draft.id)).toHaveLength(0);
  });
});

describe('re-running a posting is idempotent', () => {
  it('posting the same issue again in a new transaction returns the first entry and writes no second one', async () => {
    const created = (await call('POST', '/finance/invoices', scenarioA(await anOrganization()))).body;
    const [first] = await entriesFor('invoice', created.id);
    expect(first).toBeDefined();

    const again = await asUser(LATHA, () =>
      prisma.$transaction((tx) => postInvoiceIssue(tx, created.id, new Date(created.issuedDate))),
    );
    expect(again?.id).toBe(first!.id);
    expect(await entriesFor('invoice', created.id)).toHaveLength(1);
    await trialBalanceHolds();
  });
});

describe('a void reverses the issue entry, so the receivable does not outlive the document', () => {
  it('voiding an issued invoice posts its reversal, and the receivable nets to zero', async () => {
    const org = await anOrganization();
    const receivableStart = await receivableBalance(org);
    const created = (await call('POST', '/finance/invoices', scenarioA(org))).body;
    const voided = await call('POST', `/finance/invoices/${created.id}/void`, { reason: 'raised in error' });
    expect(voided.status).toBe(200);

    const [issue] = await entriesFor('invoice', created.id);
    const reversals = await unscopedPrisma.journalEntry.findMany({
      where: { tenantId: TENANT, sourceType: 'reversal', sourceId: issue!.id },
      include: { lines: true },
    });
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.lines.reduce((sum, l) => sum + l.amountMinor, 0n)).toBe(0n);
    const receivable = await receivableAccountId();
    const net = await asUser(LATHA, () => balanceOf(receivable, new Date(), { partyId: org }));
    expect(net - receivableStart).toBe(0n);
    await trialBalanceHolds();
  });
});

async function accountOf(role: string, scopeKey: string): Promise<string> {
  const mapped = await unscopedPrisma.ledgerPostingRole.findFirstOrThrow({
    where: { tenantId: TENANT, role, scopeKey },
  });
  return mapped.ledgerAccountId;
}

/** Balances of the accounts one invoice touches, read as of now for one party. Compare deltas: the tenant is shared. */
async function movementAccounts(org: string, lineId: string) {
  const accounts = {
    receivable: await accountOf('TRADE_RECEIVABLE', ''),
    revenue: await accountOf('REVENUE', lineId),
    cgst: await accountOf('OUTPUT_CGST', ''),
    sgst: await accountOf('OUTPUT_SGST', ''),
    bank: await accountOf('BANK', 'cash'),
  };
  return asUser(LATHA, async () => ({
    receivable: await balanceOf(accounts.receivable, new Date(), { partyId: org }),
    revenue: await balanceOf(accounts.revenue, new Date()),
    cgst: await balanceOf(accounts.cgst, new Date()),
    sgst: await balanceOf(accounts.sgst, new Date()),
    bank: await balanceOf(accounts.bank, new Date()),
  }));
}

function deltas(from: Awaited<ReturnType<typeof movementAccounts>>, to: Awaited<ReturnType<typeof movementAccounts>>) {
  return {
    receivable: to.receivable - from.receivable,
    revenue: to.revenue - from.revenue,
    cgst: to.cgst - from.cgst,
    sgst: to.sgst - from.sgst,
    bank: to.bank - from.bank,
  };
}

describe('each account moves once, by the amount the document states', () => {
  it('the issue moves the receivable, revenue and tax; the full collection moves bank and the receivable back', async () => {
    const org = await anOrganization();
    const lineId = await divisionLineId(DIVISION);
    const start = await movementAccounts(org, lineId);

    // Scenario A: taxable 1234.57, CGST 111.11, SGST 111.11, round-off 0.21, total 1457.00.
    const created = await call('POST', '/finance/invoices', scenarioA(org));
    expect(created.status).toBe(201);
    const issued = await movementAccounts(org, lineId);
    expect(deltas(start, issued)).toEqual({
      receivable: 145700n,
      revenue: -123457n,
      cgst: -11111n,
      sgst: -11111n,
      bank: 0n,
    });

    const collected = await call('POST', `/finance/invoices/${created.body.id}/collect`, {
      amount: 1457,
      mode: 'cash',
    });
    expect(collected.status).toBe(200);
    const paid = await movementAccounts(org, lineId);
    expect(deltas(issued, paid)).toEqual({ receivable: -145700n, revenue: 0n, cgst: 0n, sgst: 0n, bank: 145700n });
    expect(deltas(start, paid)).toEqual({
      receivable: 0n,
      revenue: -123457n,
      cgst: -11111n,
      sgst: -11111n,
      bank: 145700n,
    });
    await trialBalanceHolds();
  });
});

describe('an invoice issued before posting was wired stays outside the journal for now', () => {
  // Interim rule, pending the owner's backfill decision: an issued invoice with no
  // `invoice:<id>:issue` entry gets no receipt entry, so the receivable is never credited
  // with no debit behind it. It is a legacy row, so the test writes its status the way the
  // old code did, and no entry.
  it('a collection against it posts nothing, and the receivable does not move', async () => {
    const org = await anOrganization();
    const draft = (await call('POST', '/finance/invoices', scenarioA(org, { issue: false }))).body;
    await unscopedPrisma.invoice.update({
      where: { id: draft.id },
      data: { status: 'issued', issuedDate: new Date(), recordCode: `LEGACY-${randomUUID().slice(0, 8)}` },
    });
    const lineId = await divisionLineId(DIVISION);
    const before = await movementAccounts(org, lineId);

    const collected = await call('POST', `/finance/invoices/${draft.id}/collect`, { amount: 100, mode: 'cash' });
    expect(collected.status).toBe(200);
    expect(await entriesFor('invoice', draft.id)).toHaveLength(0);
    expect(await entriesFor('receipt', collected.body.receipt.id)).toHaveLength(0);
    expect(deltas(before, await movementAccounts(org, lineId)).receivable).toBe(0n);
    await trialBalanceHolds();
  });
});

describe('reversing a collected payment reverses its receipt entries', () => {
  it('collect in full, then reverse the payment: the receivable is back to the invoice total, and the trial balance holds', async () => {
    const org = await anOrganization();
    const lineId = await divisionLineId(DIVISION);
    const start = await movementAccounts(org, lineId);
    const created = (await call('POST', '/finance/invoices', scenarioA(org))).body;
    const collected = await call('POST', `/finance/invoices/${created.id}/collect`, { amount: 1457, mode: 'cash' });
    expect(collected.status).toBe(200);
    const paid = await movementAccounts(org, lineId);
    expect(deltas(start, paid).receivable).toBe(0n);

    await asUser(LATHA, () => reversePayment(collected.body.payment.id, 'entered against the wrong invoice'));

    const reversed = await movementAccounts(org, lineId);
    expect(deltas(paid, reversed)).toEqual({ receivable: 145700n, revenue: 0n, cgst: 0n, sgst: 0n, bank: -145700n });
    const [receiptEntry] = await entriesFor('receipt', collected.body.receipt.id);
    const reversals = await unscopedPrisma.journalEntry.findMany({
      where: { tenantId: TENANT, sourceType: 'reversal', sourceId: receiptEntry!.id },
      include: { lines: true },
    });
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.lines.reduce((sum, l) => sum + l.amountMinor, 0n)).toBe(0n);
    await trialBalanceHolds();
  });
});

describe('an employee raises an invoice at the counter, and it posts', () => {
  it('the employee issues their own invoice: one issue entry, and the receivable rises by its total', async () => {
    const employee = await principalFor('employee@kaizen.co.in');
    const org = await anOrganization();
    const lineId = await divisionLineId(DIVISION);
    const start = await movementAccounts(org, lineId);

    const created = await call('POST', '/finance/invoices', scenarioA(org), employee);
    expect(created.status).toBe(201);
    const entries = await entriesFor('invoice', created.body.id);
    expect(entries).toHaveLength(1);
    expect(deltas(start, await movementAccounts(org, lineId)).receivable).toBe(145700n);
    await trialBalanceHolds();
  });

  it('the employee cannot write the cashbook: the record-less create needs all scope, and the grant is scoped', async () => {
    await expect(
      asUser('employee@kaizen.co.in', () => checkTransactionAllowed({ txnDate: new Date(), source: 'manual' })),
    ).rejects.toThrow(/all-scope grant/);
  });
});

/** The party's receivable as of now. Read as a movement: the tenant is shared. */
async function receivableBalance(org: string): Promise<bigint> {
  const receivable = await receivableAccountId();
  return asUser(LATHA, () => balanceOf(receivable, new Date(), { partyId: org }));
}

// Owner decision, 2026-10-13: the temporary course-fee scheme is being replaced by receipts
// leading to a final invoice. Until that lands a course-fee invoice in the temp series posts
// nothing, on issue, collection, allocation or void.
describe('a course-fee invoice in the temporary series posts nothing (owner decision, 2026-10-13)', () => {
  it('issue and collect a course-fee temp invoice: no journal entry for it or its receipt, and the trial balance holds', async () => {
    const created = await call(
      'POST',
      '/finance/invoices',
      scenarioA(await anOrganization(), { enrollmentDate: '2026-10-01' }),
    );
    expect(created.status).toBe(201);
    // The temp series is the course-fee one: the number carries it, and the hook forced the type.
    expect(created.body.recordCode).toMatch(/temp/);
    expect(created.body.invoiceType).toBe('temp');
    expect(await entriesFor('invoice', created.body.id)).toHaveLength(0);
    await trialBalanceHolds();

    const collected = await call('POST', `/finance/invoices/${created.body.id}/collect`, { amount: 500, mode: 'cash' });
    expect(collected.status).toBe(200);
    expect(await entriesFor('receipt', collected.body.receipt.id)).toHaveLength(0);
    expect(await entriesFor('invoice', created.body.id)).toHaveLength(0);
    await trialBalanceHolds();
  });

  it('an allocation of a payment to a course-fee temp invoice posts no receipt entry', async () => {
    const created = await call(
      'POST',
      '/finance/invoices',
      scenarioA(await anOrganization(), { enrollmentDate: '2026-10-01' }),
    );
    expect(created.status).toBe(201);
    const payment = await call('POST', '/finance/payments', {
      amount: 200,
      gatewayReference: `temp-alloc-${randomUUID()}`,
      method: 'cash',
    });
    expect(payment.status).toBe(201);
    const allocated = await call('POST', `/finance/payments/${payment.body.id}/allocate`, {
      invoiceId: created.body.id,
      amount: 200,
    });
    expect(allocated.status).toBe(200);
    const receipts = await unscopedPrisma.receipt.findMany({ where: { tenantId: TENANT, invoiceId: created.body.id } });
    expect(receipts).toHaveLength(1);
    expect(await entriesFor('receipt', receipts[0]!.id)).toHaveLength(0);
    await trialBalanceHolds();
  });

  it('a void of a course-fee temp invoice posts no reversal, because there is no entry to reverse', async () => {
    const created = await call(
      'POST',
      '/finance/invoices',
      scenarioA(await anOrganization(), { enrollmentDate: '2026-10-01' }),
    );
    expect(created.status).toBe(201);
    const voided = await call('POST', `/finance/invoices/${created.body.id}/void`, { reason: 'raised in error' });
    expect(voided.status).toBe(200);
    expect(await entriesFor('invoice', created.body.id)).toHaveLength(0);
    expect(
      await unscopedPrisma.journalEntry.count({
        where: { tenantId: TENANT, sourceType: 'reversal', sourceId: created.body.id },
      }),
    ).toBe(0);
    await trialBalanceHolds();
  });
});
