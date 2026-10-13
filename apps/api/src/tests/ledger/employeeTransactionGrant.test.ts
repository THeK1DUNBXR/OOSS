/**
 * The employee's `transactions:create` cell is `@own` (seed/grants.ts), and the evaluator
 * narrows scope only against a record. A journal write, a cashbook write or a division map
 * has no record, so each of them needs all scope (assertScopeAll), or an employee could
 * write the company's ledger. These tests hold that refusal, at each door a record-less write
 * can be reached by. The invoice's own paths are different: they are narrowed by the invoice
 * record (invoicing.ts loadForWrite), and the test for that is the last one here.
 */

import type { Server } from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, principalFor, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from '../helpers.js';
import { addMissingGrants } from '../../platform/grantSync.js';
import { post } from '../../platform/ledger.js';
import { setInvoiceDivisionLine } from '../../domains/invoicePosting.js';
import { requestRecurringRuleApproval } from '../../domains/payouts.js';
import { readyInvoicePosting } from '../fixtures/invoicePostingReady.js';
import { createApp } from '../../server.js';

const EMPLOYEE = 'employee@kaizen.co.in';
const LATHA = 'latha@kaizen.co.in';
const REFUSED = /all-scope grant/;

let TENANT: string;
let server: Server;
let base: string;

beforeAll(async () => {
  TENANT = await tenantId();
  await readyInvoicePosting(TENANT);
  await addMissingGrants(TENANT);
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

async function callAs(who: TestPrincipal, method: 'POST', path: string, body: unknown) {
  const token = await sessionToken({
    userId: who.userId,
    tenantId: who.tenantId,
    affiliationId: who.affiliationId,
    stepUp: true,
  });
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('an employee cannot write the ledger through a record-less door', () => {
  it('post(): a journal entry is refused for an employee, and nothing is written', async () => {
    const receivable = await unscopedPrisma.ledgerPostingRole.findFirstOrThrow({
      where: { tenantId: TENANT, role: 'TRADE_RECEIVABLE', scopeKey: '' },
    });
    const entity = await unscopedPrisma.ledgerEntity.findFirstOrThrow({ where: { tenantId: TENANT } });
    const before = await unscopedPrisma.journalEntry.count({ where: { tenantId: TENANT } });
    const key = `employee-leak-${Date.now()}`;

    await expect(
      asUser(EMPLOYEE, () =>
        post({
          entityId: entity.id,
          entryDate: new Date('2026-10-13T00:00:00.000Z'),
          narration: 'Employee attempt',
          sourceType: 'manual',
          idempotencyKey: key,
          lines: [
            { accountId: receivable.ledgerAccountId, amountMinor: 100n, partyId: 'x' },
            { accountId: receivable.ledgerAccountId, amountMinor: -100n, partyId: 'x' },
          ],
        }),
      ),
    ).rejects.toThrow(REFUSED);

    expect(await unscopedPrisma.journalEntry.count({ where: { tenantId: TENANT } })).toBe(before);
  });

  it('setInvoiceDivisionLine: an employee cannot map an invoice division to a business line', async () => {
    const line = await unscopedPrisma.businessLine.findFirstOrThrow({
      where: { tenantId: TENANT, code: 'INVPOST-SHARED' },
    });
    await expect(
      asUser(EMPLOYEE, () =>
        setInvoiceDivisionLine({ division: 'shared', lineId: line.id, effectiveFrom: '2099-01-01' }),
      ),
    ).rejects.toThrow(REFUSED);
  });

  it('requestRecurringRuleApproval: an employee cannot request approval of a recurring cash-out', async () => {
    await expect(asUser(EMPLOYEE, () => requestRecurringRuleApproval('00000000-no-such-rule'))).rejects.toThrow(
      REFUSED,
    );
  });
});

describe('an employee cannot collect against another person’s invoice', () => {
  it('a payment against an invoice the employee did not raise is refused, and no receipt is written', async () => {
    const latha = await principalFor(LATHA);
    const org = (await unscopedPrisma.account.findFirstOrThrow({ where: { tenantId: TENANT, gstin: { not: null } } }))
      .organizationId;
    const created = await callAs(latha, 'POST', '/finance/invoices', {
      organizationId: org,
      placeOfSupply: '33',
      division: 'education',
      lines: [{ description: 'Not the employee’s', quantity: 1, unitPrice: 500, gstRate: 18 }],
    });
    expect(created.status).toBe(201);

    const employee = await principalFor(EMPLOYEE);
    const collected = await callAs(employee, 'POST', `/finance/invoices/${created.body.id}/collect`, {
      amount: 100,
      mode: 'cash',
    });
    expect(collected.status).toBe(403);
    expect(await unscopedPrisma.receipt.count({ where: { invoiceId: created.body.id } })).toBe(0);
  });
});
