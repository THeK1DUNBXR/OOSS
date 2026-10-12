/**
 * Wave 2 (ORDERED-PLAN "assertPeriodOpen on the remaining write paths"): an
 * invoice, payment, receipt or credit note dated inside a closed accounting
 * period is refused, and the refusal writes nothing.
 *
 * invoicing.ts's assertPeriodOpen guards a GST filing, not the books' close; the
 * books' close is the `accounting_document.before_write` hook. Real Postgres, as
 * in the other suites. The file runs in a books tenant of its own (booksTenant),
 * so the months it closes are not read by any other file. A probe that needs the
 * current month closed closes it with closeThrough and reopens it after with
 * reopenLatestFirst, because a credit note, a payment or its reversal is stamped
 * with the current instant.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthKey } from '@kaizen/shared';
import {
  asUser,
  booksTenant,
  closeThrough,
  expectReject,
  reopenLatestFirst,
  unscopedPrisma,
  type BooksTenant,
} from './helpers.js';
import { createInvoice, issueInvoiceDraft, voidInvoice, collectInvoicePayment } from '../domains/invoicing.js';
import { allocatePayment, issueCreditNote, recordPayment, reversePayment } from '../domains/finance.js';

const CLOSED = '2017-10';

let FIXTURE: BooksTenant;
let TENANT: string;
let ORG_ID: string;

beforeAll(async () => {
  FIXTURE = await booksTenant('invoice-accounting-period');
  TENANT = FIXTURE.tenantId;
  ORG_ID = FIXTURE.organizationId;
  // A run that stopped inside a close window leaves months closed. Reopen them before this run writes.
  await reopenLatestFirst(FIXTURE, 'Test fixture reset at the start of the run');
  await closeThrough(FIXTURE, CLOSED);
});

afterAll(async () => {
  await reopenLatestFirst(FIXTURE, 'Invoice accounting period tests finished; reopening the months they closed');
});

function unique(label: string): string {
  return `${label} ${Math.random().toString(36).slice(2, 10)}`;
}

async function invoiceCount(): Promise<number> {
  return unscopedPrisma.invoice.count({ where: { tenantId: TENANT } });
}

async function openDraft() {
  return asUser(FIXTURE.finance, () =>
    createInvoice({
      organizationId: ORG_ID,
      issue: false,
      lines: [{ description: unique('W2 draft'), unitPrice: 1000, gstRate: 18 }],
    }),
  );
}

async function openIssued() {
  return asUser(FIXTURE.finance, () =>
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
      asUser(FIXTURE.finance, () =>
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
      asUser(FIXTURE.finance, () =>
        createInvoice({
          organizationId: ORG_ID,
          issuedDate: new Date('2017-10-01T00:30:00+05:30'),
          lines: [{ description: unique('W2 ist refused'), unitPrice: 1000, gstRate: 18 }],
        }),
      ),
    );
    expect(refused.status).toBe(422);

    const accepted = await asUser(FIXTURE.finance, () =>
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
      asUser(FIXTURE.finance, () => issueInvoiceDraft(draft.id, { issuedDate: new Date('2017-10-15T06:00:00Z') })),
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
    const err = await expectReject(() => asUser(FIXTURE.finance, () => voidInvoice(issued.id, 'W2 probe')));
    expect(err.status).toBe(422);
    const after = await unscopedPrisma.invoice.findUniqueOrThrow({ where: { id: issued.id } });
    expect(after.status).not.toBe('void');
  });

  it('a payment received in the closed period is refused, and no payment is recorded against the invoice', async () => {
    const issued = await openIssued();
    const err = await expectReject(() =>
      asUser(FIXTURE.finance, () =>
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
      asUser(FIXTURE.finance, () =>
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
    const payment = await asUser(FIXTURE.finance, () =>
      recordPayment({ amount: 200, gatewayReference: unique('W2 pay before close') }),
    );

    const today = monthKey(new Date());
    await closeThrough(FIXTURE, today);
    try {
      const credit = await expectReject(() =>
        asUser(FIXTURE.finance, () => issueCreditNote(issued.id, 100, 'W2 probe', 'other')),
      );
      expect(credit.status).toBe(422);
      expect(await unscopedPrisma.creditNote.count({ where: { tenantId: TENANT, invoiceId: issued.id } })).toBe(0);

      const reversal = await expectReject(() => asUser(FIXTURE.finance, () => reversePayment(payment.id, 'W2 probe')));
      expect(reversal.status).toBe(422);
      expect(await unscopedPrisma.payment.count({ where: { tenantId: TENANT, reversalOfPaymentId: payment.id } })).toBe(
        0,
      );

      const allocation = await expectReject(() =>
        asUser(FIXTURE.finance, () => allocatePayment({ paymentId: payment.id, invoiceId: issued.id, amount: 50 })),
      );
      expect(allocation.status).toBe(422);
      expect(await unscopedPrisma.receipt.count({ where: { tenantId: TENANT, paymentId: payment.id } })).toBe(0);

      const recorded = await expectReject(() =>
        asUser(FIXTURE.finance, () => recordPayment({ amount: 50, gatewayReference: unique('W2 pay today closed') })),
      );
      expect(recorded.status).toBe(422);
    } finally {
      await reopenLatestFirst(FIXTURE, 'W2 probe finished; reopening the months it closed');
    }
  });
});
