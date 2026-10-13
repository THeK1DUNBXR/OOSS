/**
 * A statutory document that fails to write must not take a number from its
 * series. The tests make a real write fail, with real data and no mocks, after
 * the number has been allocated, and then check that the next document is
 * issued under the number the failed one would have had.
 *
 * "Counter unchanged" is read from record_sequences directly. A counter that
 * moved on a failed write is a hole in the series the return reports.
 */
import { describe, expect, it } from 'vitest';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from './helpers.js';
import { collectInvoicePayment, createInvoice } from '../domains/invoicing.js';
import { issueCreditNote } from '../domains/finance.js';
import { raiseFinalInvoice } from '../domains/receipts.js';
import { DOCUMENT_SERIES, financialYearStart } from '../platform/documentNumber.js';

let TENANT: string;

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function anAccount() {
  TENANT = TENANT ?? (await tenantId());
  const account = await unscopedPrisma.account.findFirstOrThrow({
    where: { tenantId: TENANT, gstin: { not: null } },
  });
  return account.organizationId;
}

/** The sequence a document in this series would take next, as record_sequences holds it. */
async function nextSequenceOf(series: string): Promise<number> {
  const row = await prisma.recordSequence.findFirst({
    where: { tenantId: TENANT, entityType: `DOC:${series}`, year: financialYearStart(new Date()) },
  });
  return row?.nextSequence ?? 1;
}

function sequenceOf(recordCode: string): number {
  return Number(recordCode.split('/').pop());
}

async function anIssuedInvoice() {
  return createInvoice({
    division: 'education',
    organizationId: await anAccount(),
    placeOfSupply: '33',
    lines: [{ description: 'Programme', unitPrice: 10_000, gstRate: 18 }],
  });
}

async function anInvoiceWithReceipt() {
  const invoice = await anIssuedInvoice();
  await collectInvoicePayment(invoice.id, { amount: 100, mode: 'cash', reference: `NUM-${stamp()}` });
  return invoice;
}

describe('a failed statutory write gives its number back', () => {
  it('credit note: a write that fails after numbering leaves the series where it was', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      const invoice = await anIssuedInvoice();
      const before = await nextSequenceOf(DOCUMENT_SERIES.creditNote);

      // 1e16 has seventeen digits; credit_notes.amount is Decimal(18,2), so the
      // database refuses the row after the number has been taken for it.
      await expectReject(() => issueCreditNote(invoice.id, 1e16, 'Overflows the amount column'));
      expect(await nextSequenceOf(DOCUMENT_SERIES.creditNote)).toBe(before);

      const note = await issueCreditNote(invoice.id, 100, 'Valid after the failure');
      expect(sequenceOf(note.recordCode)).toBe(before);
    });
  });

  it('final invoice: a write that fails after numbering leaves the series where it was', async () => {
    await asUser('latha@kaizen.co.in', async () => {
      // A final invoice consolidates receipts, so each invoice needs one.
      const failing = await anInvoiceWithReceipt();
      const valid = await anInvoiceWithReceipt();
      const before = await nextSequenceOf(DOCUMENT_SERIES.finalInvoice);

      // A NUL byte cannot be stored in a Postgres text or jsonb value. It reaches
      // the database only after the final invoice's number has been taken.
      await expectReject(() => raiseFinalInvoice(failing.id, { note: `bad\u0000${stamp()}` }));
      expect(await nextSequenceOf(DOCUMENT_SERIES.finalInvoice)).toBe(before);

      const final = await raiseFinalInvoice(valid.id, { note: `valid ${stamp()}` });
      expect(sequenceOf(final.recordCode)).toBe(before);
    });
  });
});
