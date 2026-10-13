/**
 * A gateway reference is unique per tenant (Payment `@@unique([tenantId, gatewayReference])`).
 *
 * Three things follow, and each has a test here:
 *
 *   - a replay in sequence is the idempotent path: the same payment comes back;
 *   - a payment supplied with an invoice whose reference is already on file is refused
 *     before the invoice is written. Refused after, the invoice is issued behind a 409
 *     and a client retry issues a second one;
 *   - a draft whose issue is refused stays a draft: no number, no event.
 *
 * Real Postgres and the real paths. Counts are taken around each refusal rather than
 * asserted absolutely, so the file does not depend on what other files left behind.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { asUser, expectReject, tenantId, unscopedPrisma } from './helpers.js';
import { recordPayment } from '../domains/finance.js';
import { createInvoice, issueInvoiceDraft } from '../domains/invoicing.js';

const EMAIL = 'latha@kaizen.co.in';
let TENANT: string;
let ORGANIZATION: string;

const stamp = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

beforeAll(async () => {
  TENANT = await tenantId();
  const account = await unscopedPrisma.account.findFirstOrThrow({
    where: { tenantId: TENANT, gstin: { not: null } },
  });
  ORGANIZATION = account.organizationId!;
});

/** A 10,000 programme at 18% GST: 11,800.00 payable, so a 1,000 payment is well inside it. */
function invoiceInput(issue: boolean) {
  return {
    division: 'education',
    organizationId: ORGANIZATION,
    placeOfSupply: '33',
    issue,
    lines: [{ description: 'Programme', unitPrice: 10_000, gstRate: 18 }],
  };
}

async function snapshot() {
  return {
    invoices: await unscopedPrisma.invoice.count({ where: { tenantId: TENANT } }),
    issued: await unscopedPrisma.eventRecord.count({
      where: { tenantId: TENANT, eventName: EVENTS.INVOICE_ISSUED },
    }),
  };
}

describe('a replayed gateway reference', () => {
  it('recordPayment in sequence returns the payment already on file, and writes no second row', async () => {
    await asUser(EMAIL, async () => {
      const reference = stamp('REPLAY');
      const first = await recordPayment({ amount: 250, gatewayReference: reference });
      const second = await recordPayment({ amount: 250, gatewayReference: reference });

      expect(second.id).toBe(first.id);
      const rows = await unscopedPrisma.payment.count({ where: { tenantId: TENANT, gatewayReference: reference } });
      expect(rows).toBe(1);
    });
  });
});

describe('an invoice whose payment reference is already on file', () => {
  it('createInvoice is refused with 409 before the invoice is written', async () => {
    await asUser(EMAIL, async () => {
      const reference = stamp('CLASH-CREATE');
      await recordPayment({ amount: 100, gatewayReference: reference });
      const before = await snapshot();

      const refused = await expectReject(() =>
        createInvoice({ ...invoiceInput(true), payment: { amount: 1_000, mode: 'cash', reference } }),
      );

      expect(refused.status).toBe(409);
      expect(refused.code).toBe('CONFLICT');
      expect(refused.message).toContain(reference);
      expect(await snapshot()).toEqual(before);
    });
  });

  it('issueInvoiceDraft is refused with 409 and the draft stays a draft', async () => {
    await asUser(EMAIL, async () => {
      const reference = stamp('CLASH-ISSUE');
      await recordPayment({ amount: 100, gatewayReference: reference });
      const draft = await createInvoice(invoiceInput(false));
      const before = await snapshot();

      const refused = await expectReject(() =>
        issueInvoiceDraft(draft.id, { payment: { amount: 1_000, mode: 'cash', reference } }),
      );

      expect(refused.status).toBe(409);
      expect(refused.code).toBe('CONFLICT');
      expect(refused.message).toContain(reference);
      const row = await unscopedPrisma.invoice.findFirstOrThrow({ where: { id: draft.id } });
      expect(row.status).toBe('draft');
      expect(row.recordCode).toBeNull();
      expect(await snapshot()).toEqual(before);
    });
  });
});
