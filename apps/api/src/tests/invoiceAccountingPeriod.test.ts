/**
 * Wave 2 (ORDERED-PLAN "assertPeriodOpen on the remaining write paths"): an
 * invoice, payment, receipt or credit note dated inside a closed accounting
 * period is refused, and the refusal writes nothing.
 *
 * invoicing.ts's assertPeriodOpen guards a GST filing, not the books' close; the
 * books' close is the `accounting_document.before_write` hook. Real Postgres, as
 * in the other suites. Periods are closed here and reopened where a probe needs
 * the current month closed, because a credit note, a payment or its reversal is
 * stamped with the current instant.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { monthKey } from '@kaizen/shared';
import { asUser, expectReject, tenantId, unscopedPrisma } from './helpers.js';
import { createInvoice, issueInvoiceDraft, voidInvoice, collectInvoicePayment } from '../domains/invoicing.js';
import { allocatePayment, issueCreditNote, recordPayment, reversePayment } from '../domains/finance.js';
import { requestClosePeriod, closePeriod, reopenPeriod } from '../domains/compliance/books.js';

const CLOSED = '2017-10';
const FINANCE = 'finance@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';

let TENANT: string;
let ORG_ID: string;

beforeAll(async () => {
  TENANT = await tenantId();
  const org = await unscopedPrisma.organization.findFirstOrThrow({ where: { tenantId: TENANT } });
  ORG_ID = org.id;
  // The database outlives a run, so a second run finds the period already closed.
  const row = await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId: TENANT, period: CLOSED } });
  if (row?.status !== 'closed') {
    await asUser(FINANCE, () => requestClosePeriod(CLOSED));
    await asUser(CHAIRMAN, () => closePeriod(CLOSED));
  }
});

function unique(label: string): string {
  return `${label} ${Math.random().toString(36).slice(2, 10)}`;
}

async function invoiceCount(): Promise<number> {
  return unscopedPrisma.invoice.count({ where: { tenantId: TENANT } });
}

async function openDraft() {
  return asUser(FINANCE, () =>
    createInvoice({
      organizationId: ORG_ID,
      issue: false,
      lines: [{ description: unique('W2 draft'), unitPrice: 1000, gstRate: 18 }],
    }),
  );
}

async function openIssued() {
  return asUser(FINANCE, () =>
    createInvoice({
      organizationId: ORG_ID,
      lines: [{ description: unique('W2 issued'), unitPrice: 1000, gstRate: 18 }],
    }),
  );
}

describe('Closed period — invoice writes dated inside it are refused', () => {
  it('an invoice issued in the closed period is refused, and no invoice is created', async () => {
    const before = await invoiceCount();
    const err = await expectReject(() =>
      asUser(FINANCE, () =>
        createInvoice({
          organizationId: ORG_ID,
          issuedDate: new Date('2017-10-15T06:00:00Z'),
          lines: [{ description: unique('W2 closed'), unitPrice: 1000, gstRate: 18 }],
        }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await invoiceCount()).toBe(before);
  });

  it('00:30 IST on 1 October is refused; 00:30 IST on 1 November is not (IST boundary)', async () => {
    const refused = await expectReject(() =>
      asUser(FINANCE, () =>
        createInvoice({
          organizationId: ORG_ID,
          issuedDate: new Date('2017-10-01T00:30:00+05:30'),
          lines: [{ description: unique('W2 ist refused'), unitPrice: 1000, gstRate: 18 }],
        }),
      ),
    );
    expect(refused.status).toBe(422);

    const accepted = await asUser(FINANCE, () =>
      createInvoice({
        organizationId: ORG_ID,
        issuedDate: new Date('2017-11-01T00:30:00+05:30'),
        lines: [{ description: unique('W2 ist accepted'), unitPrice: 1000, gstRate: 18 }],
      }),
    );
    expect(accepted.issuedDate?.toISOString()).toBe('2017-10-31T19:00:00.000Z');
  });

  it('issuing a draft into the closed period is refused, and the draft stays a draft', async () => {
    const draft = await openDraft();
    const err = await expectReject(() =>
      asUser(FINANCE, () => issueInvoiceDraft(draft.id, { issuedDate: new Date('2017-10-15T06:00:00Z') })),
    );
    expect(err.status).toBe(422);
    const after = await unscopedPrisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.status).toBe('draft');
    expect(after.recordCode).toBeNull();
  });

  it('voiding an invoice issued in the closed period is refused, and it stays issued', async () => {
    const issued = await openIssued();
    // Set the issue date into the closed period directly, as a record imported
    // from before the books were on the platform would carry it.
    await unscopedPrisma.invoice.update({
      where: { id: issued.id },
      data: { issuedDate: new Date('2017-10-15T06:00:00Z') },
    });
    const err = await expectReject(() => asUser(FINANCE, () => voidInvoice(issued.id, 'W2 probe')));
    expect(err.status).toBe(422);
    const after = await unscopedPrisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(after.status).not.toBe('void');
  });

  it('a payment received in the closed period is refused, and no payment is recorded against the invoice', async () => {
    const issued = await openIssued();
    const err = await expectReject(() =>
      asUser(FINANCE, () =>
        collectInvoicePayment(issued.id, {
          amount: 100,
          mode: 'bank_transfer',
          receivedAt: new Date('2017-10-15T06:00:00Z'),
        }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.receipt.count({ where: { tenantId: TENANT, invoiceId: issued.id } })).toBe(0);
  });

  it('a payment recorded for a date in the closed period is refused, and no payment row is written', async () => {
    const reference = unique('W2 closed payment');
    const err = await expectReject(() =>
      asUser(FINANCE, () =>
        recordPayment({ amount: 500, gatewayReference: reference, receivedAt: new Date('2017-10-15T06:00:00Z') }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await unscopedPrisma.payment.count({ where: { tenantId: TENANT, gatewayReference: reference } })).toBe(0);
  });
});

describe('Closed period — writes dated today are refused while the current month is closed', () => {
  it('a credit note, a payment and a payment reversal are each refused; nothing is written', async () => {
    // Everything that needs an open month is made first. Then the current IST
    // month is closed for the probes and reopened after, so the next file in
    // the run finds it open again.
    const issued = await openIssued();
    const payment = await asUser(FINANCE, () =>
      recordPayment({ amount: 200, gatewayReference: unique('W2 pay before close') }),
    );

    const today = monthKey(new Date());
    await asUser(FINANCE, () => requestClosePeriod(today));
    await asUser(CHAIRMAN, () => closePeriod(today));
    try {
      const credit = await expectReject(() =>
        asUser(FINANCE, () => issueCreditNote(issued.id, 100, 'W2 probe', 'other')),
      );
      expect(credit.status).toBe(422);
      expect(await unscopedPrisma.creditNote.count({ where: { tenantId: TENANT, invoiceId: issued.id } })).toBe(0);

      const reversal = await expectReject(() => asUser(FINANCE, () => reversePayment(payment.id, 'W2 probe')));
      expect(reversal.status).toBe(422);
      expect(await unscopedPrisma.payment.count({ where: { tenantId: TENANT, reversalOfPaymentId: payment.id } })).toBe(
        0,
      );

      const allocation = await expectReject(() =>
        asUser(FINANCE, () => allocatePayment({ paymentId: payment.id, invoiceId: issued.id, amount: 50 })),
      );
      expect(allocation.status).toBe(422);
      expect(await unscopedPrisma.receipt.count({ where: { tenantId: TENANT, paymentId: payment.id } })).toBe(0);

      const recorded = await expectReject(() =>
        asUser(FINANCE, () => recordPayment({ amount: 50, gatewayReference: unique('W2 pay today closed') })),
      );
      expect(recorded.status).toBe(422);
    } finally {
      await asUser(CHAIRMAN, () => reopenPeriod(today, 'W2 probe finished; reopening the current month'));
    }
  });
});
