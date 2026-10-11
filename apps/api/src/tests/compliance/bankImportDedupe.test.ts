/**
 * FX-34: nothing is counted twice, and nothing is committed on a guess
 * (archive/FIXES.md row FX-34; domains/compliance/books.ts importBankStatement
 * and matchBankLines; domains/invoicing.ts collectInvoicePayment).
 *
 * - A statement re-imported unchanged adds no rows. The fingerprint was computed
 *   nowhere and enforced nowhere, so each re-import doubled the statement.
 * - Two identical lines in one statement (two bank charges of the same amount on
 *   one day) are both kept: the fingerprint carries the occurrence within the file.
 * - A counter payment with no reference is identified by invoice, amount and day,
 *   not by the millisecond it was taken, so the same cash cannot be booked twice
 *   by accident.
 * - A bank line that fits two ledger entries is not committed to the first one.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { collectInvoicePayment, createInvoice } from '../../domains/invoicing.js';
import { enrolStudent } from '../../domains/education.js';
import { importBankStatement, matchBankLines } from '../../domains/compliance/books.js';
import { recordTransaction } from '../../domains/books.js';
import '../../domains/compliance/gst.js';

const FINANCE = 'finance@kaizen.co.in';
const EMPLOYEE = 'chairman@kaizen.co.in';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function freshAccount(tag: string) {
  return unscopedPrisma.ledgerAccount.create({
    data: { tenantId: TENANT, name: `FX-34 ${tag} ${Date.now()}`, accountType: 'bank' },
  });
}

describe('FX-34: a statement re-import adds no rows', () => {
  it('importing the same lines twice leaves one row per line', async () => {
    const account = await freshAccount('reimport');
    const lines = [
      { date: new Date('2030-04-02T00:00:00.000Z'), amount: 1200.5, direction: 'out' as const, reference: 'CHQ-1' },
      { date: new Date('2030-04-03T00:00:00.000Z'), amount: 300, direction: 'in' as const, reference: 'NEFT-9' },
      { date: new Date('2030-04-03T00:00:00.000Z'), amount: 75, direction: 'out' as const, narration: 'Bank charge' },
    ];

    const first = await asUser(FINANCE, () => importBankStatement(account.id, lines));
    expect(first.imported).toBe(3);
    const second = await asUser(FINANCE, () => importBankStatement(account.id, lines));
    expect(second.imported).toBe(0);

    const stored = await unscopedPrisma.bankStatementLine.count({ where: { tenantId: TENANT, accountId: account.id } });
    expect(stored).toBe(3);
  });

  it('two identical lines in one statement are both kept', async () => {
    const account = await freshAccount('twins');
    const twin = { date: new Date('2030-04-05T00:00:00.000Z'), amount: 50, direction: 'out' as const };

    const result = await asUser(FINANCE, () => importBankStatement(account.id, [twin, twin]));
    expect(result.imported).toBe(2);
    const stored = await unscopedPrisma.bankStatementLine.count({ where: { tenantId: TENANT, accountId: account.id } });
    expect(stored).toBe(2);
  });
});

describe('FX-34: a counter payment with no reference is identified by invoice, amount and day', () => {
  async function anIssuedInvoice(tag: string) {
    const course = await prisma.course.create({
      data: { tenantId: TENANT, recordCode: await nextRecordCode('CRS'), name: `${tag} Course`, code: `${tag}-C` },
    });
    const cohort = await prisma.cohort.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('COH'),
        courseId: course.id,
        name: `${tag} Batch`,
        startDate: new Date(),
        capacity: 30,
      },
    });
    const enrollment = await enrolStudent({
      cohortId: cohort.id,
      fullName: `${tag} Student`,
      primaryPhone: `9${Date.now()}`.slice(0, 10),
      adultAttested: true,
    });
    return createInvoice({
      personId: enrollment.personId,
      placeOfSupply: '33',
      enrollmentDate: new Date(),
      lines: [{ description: 'Course fee', enrollmentId: enrollment.id, unitPrice: 50_000, gstRate: 18 }],
      issue: true,
    });
  }

  it('the second identical cash receipt on the same day, with no reference, is refused', async () => {
    await asUser(EMPLOYEE, async () => {
      const invoice = await anIssuedInvoice(`DUP${Date.now()}`);
      await collectInvoicePayment(invoice.id, { amount: 1000, mode: 'cash' });

      const refused = await expectReject(() => collectInvoicePayment(invoice.id, { amount: 1000, mode: 'cash' }));
      expect(refused.status).toBe(409);
      expect(refused.message).toMatch(/reference/);
    });
  });
});

describe('FX-34: a bank line that fits two ledger entries is not committed to either', () => {
  it('leaves both entries unreconciled and reports the line as ambiguous', async () => {
    const account = await freshAccount('ambiguous');
    const day = new Date('2030-06-10T00:00:00.000Z');

    const [a, b] = await asUser(FINANCE, async () => [
      await recordTransaction({ txnDate: day, direction: 'out', amount: 4321, accountId: account.id, note: 'A' }),
      await recordTransaction({ txnDate: day, direction: 'out', amount: 4321, accountId: account.id, note: 'B' }),
    ]);
    await asUser(FINANCE, () =>
      importBankStatement(account.id, [{ date: day, amount: 4321, direction: 'out', narration: 'Vendor NEFT' }]),
    );

    const result = await asUser(FINANCE, () => matchBankLines(account.id));
    expect(result.matched).toBe(0);
    expect(result.ambiguous).toBe(1);

    const rows = await unscopedPrisma.transaction.findMany({ where: { id: { in: [a!.id, b!.id] } } });
    expect(rows.map((r) => r.reconciledAt)).toEqual([null, null]);
  });
});
