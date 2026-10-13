/**
 * Invoice issue under concurrency: two issues of one draft, an issue racing a
 * collection on the same invoice, and several drafts issued at once.
 *
 * Each test raises its own books tenant (booksTenant with a random slug), so no
 * other file's invoices, periods or sequence rows are in the series it reads.
 * Invoice posting is set up by the fixture (readyInvoicePosting), so an issue
 * posts its journal entry in the same transaction as the number, as it does in
 * production.
 *
 * What the defects were. issueInvoiceDraft checks the status before it takes
 * the invoice lock. Two issues that both pass the check used to both reach the
 * number allocator: the loser took a number, then overwrote the winner's, and
 * the number it took is a hole in the series. The fix re-reads the status under
 * lockInvoice (domains/invoicing.ts issueInvoiceDraft, the comment at the lock).
 * On that code the race test fails on its audit and event counts (two update
 * rows and two INVOICE_ISSUED events, where the new code writes one of each).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { asSystem } from '../../platform/context.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { asUser, booksTenant, unscopedPrisma, type BooksTenant } from '../helpers.js';
import { collectInvoicePayment, createInvoice, issueInvoiceDraft } from '../../domains/invoicing.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/** A draft in the books tenant, not yet issued, with no enrolment date so it is not a course-fee invoice. */
async function aDraft(f: BooksTenant, label: string) {
  return asUser(f.finance, () =>
    createInvoice({
      division: 'education',
      organizationId: f.organizationId,
      issue: false,
      lines: [{ description: `${label} ${stamp()}`, unitPrice: 1000, gstRate: 18 }],
    }),
  );
}

/** The trailing sequence number of a document code such as `.../0042`. */
function seqOf(code: string | null): number {
  const match = /(\d+)$/.exec(code ?? '');
  if (!match) throw new Error(`no sequence number in document code ${code ?? '(null)'}`);
  return parseInt(match[1]!, 10);
}

describe('two issues of one draft, racing', () => {
  it('one wins and the other is refused: one number, one journal entry, one audit row, one event, and no number burned', async () => {
    const f = await booksTenant(`conc-issue-${randomUUID().slice(0, 8)}`);
    const draft = await aDraft(f, 'Double issue');

    const settled = await Promise.allSettled([1, 2].map(() => asUser(f.finance, () => issueInvoiceDraft(draft.id))));

    const won = settled.filter((r) => r.status === 'fulfilled');
    const lost = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // Both checks in issueInvoiceDraft refuse with unprocessable (422), not a conflict.
    expect(lost[0]!.reason).toMatchObject({ status: 422 });

    const row = await unscopedPrisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.status).toBe('issued');
    expect(row.recordCode).not.toBeNull();
    expect(await unscopedPrisma.invoice.count({ where: { tenantId: f.tenantId, recordCode: row.recordCode } })).toBe(1);

    expect(
      await unscopedPrisma.journalEntry.count({
        where: { tenantId: f.tenantId, sourceType: 'invoice', sourceId: draft.id },
      }),
    ).toBe(1);
    expect(
      await unscopedPrisma.auditRecord.count({
        where: { tenantId: f.tenantId, subjectType: 'invoice', subjectId: draft.id, action: 'update' },
      }),
    ).toBe(1);
    expect(
      await unscopedPrisma.eventRecord.count({
        where: { tenantId: f.tenantId, eventName: EVENTS.INVOICE_ISSUED, subjectEntityId: draft.id },
      }),
    ).toBe(1);

    // The loser takes no number and writes nothing. This is the invariant the
    // count assertions above check directly: on the old code the loser also
    // wrote an update audit row and an INVOICE_ISSUED event, and the invoice
    // carried the loser's number, so the audit and event counts are what fail.
    const next = await aDraft(f, 'After the race');
    await asUser(f.finance, () => issueInvoiceDraft(next.id));
    const nextRow = await unscopedPrisma.invoice.findUniqueOrThrow({ where: { id: next.id } });
    expect(seqOf(nextRow.recordCode) - seqOf(row.recordCode)).toBe(1);

    assertTrialBalance(await asSystem(f.tenantId, () => journalTrialBalance(new Date())));
  });
});

describe('an issue and a collection racing on one invoice', () => {
  it('a receipt exists only on an issued invoice, and the issue is booked once whichever way the race goes', async () => {
    const f = await booksTenant(`conc-collect-${randomUUID().slice(0, 8)}`);
    const draft = await aDraft(f, 'Issue and collect');

    // Collecting a draft is refused, so the collection either loses (the draft
    // is still a draft when it reads) or wins (it reads the issued invoice).
    const [issued, collected] = await Promise.allSettled([
      asUser(f.finance, () => issueInvoiceDraft(draft.id)),
      asUser(f.finance, () =>
        collectInvoicePayment(draft.id, { amount: 500, mode: 'cash', reference: `ISSUE-COLLECT-${stamp()}` }),
      ),
    ]);

    expect(issued.status).toBe('fulfilled');
    const row = await unscopedPrisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.status).toBe('issued');
    expect(row.recordCode).not.toBeNull();

    const receipts = await unscopedPrisma.receipt.count({ where: { tenantId: f.tenantId, invoiceId: draft.id } });
    if (collected.status === 'fulfilled') {
      expect(receipts).toBe(1);
    } else {
      expect(collected.reason).toMatchObject({ status: 422 });
      expect(receipts).toBe(0);
    }

    expect(
      await unscopedPrisma.journalEntry.count({
        where: { tenantId: f.tenantId, sourceType: 'invoice', sourceId: draft.id },
      }),
    ).toBe(1);
    assertTrialBalance(await asSystem(f.tenantId, () => journalTrialBalance(new Date())));
  });
});

describe('several drafts issued at once', () => {
  it('four drafts issued together take four distinct, consecutive numbers in the invoice series', async () => {
    const f = await booksTenant(`conc-series-${randomUUID().slice(0, 8)}`);
    const drafts: Array<Awaited<ReturnType<typeof aDraft>>> = [];
    for (let i = 0; i < 4; i += 1) drafts.push(await aDraft(f, `Series ${i}`));

    await Promise.all(drafts.map((d) => asUser(f.finance, () => issueInvoiceDraft(d.id))));

    const rows = await unscopedPrisma.invoice.findMany({
      where: { tenantId: f.tenantId, id: { in: drafts.map((d) => d.id) } },
      select: { recordCode: true },
    });
    const seqs = rows.map((r) => seqOf(r.recordCode)).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(4);
    expect(seqs.slice(1).map((s, i) => s - seqs[i]!)).toEqual([1, 1, 1]);
  });
});
