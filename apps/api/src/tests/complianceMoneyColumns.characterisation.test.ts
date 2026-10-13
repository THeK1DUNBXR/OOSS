/**
 * Characterisation of the compliance and books money columns (ORDERED-PLAN 1.6,
 * slice S5 compliance): the bank statement line amount, the TDS challan amount,
 * the advance-tax payment amount and the ledger account opening balance.
 *
 * The rupee figures pinned here pass on the Decimal columns and, unchanged, on the
 * BigInt `*Minor` columns, so no figure moves by a paisa and no client sees a field
 * change type or lose a field. The `*Minor` assertions are the new paise siblings;
 * they fail on the old code, which is the point of running this before the change.
 *
 * The bank statement fingerprint is pinned against a digest computed here from the
 * key's documented parts, not by calling the production function: a change to the
 * key would make every statement loaded before it import again.
 */

import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asUser,
  payOutSettled,
  principalFor,
  sessionToken,
  tenantId,
  unscopedPrisma,
  type TestPrincipal,
} from './helpers.js';
import { bigintReplacer } from '../platform/wire.js';
import { createApp } from '../server.js';
import { createAccount, listAccounts } from '../domains/books.js';
import { trialBalance } from '../domains/compliance/books.js';
import { importBankStatement, matchBankLines } from '../domains/compliance/books.js';
import { createChallan, markChallanPaid, recordAdvanceTaxPayment } from '../domains/compliance/tax.js';

/** What `res.json` would send: Prisma Decimals become their two-place string, BigInt its digits. */
const wire = <T>(value: T): any => JSON.parse(JSON.stringify(value, bigintReplacer));
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const CHAIRMAN = 'chairman@kaizen.co.in';
const FINANCE_2 = 'latha@kaizen.co.in';
const FAR_FUTURE = new Date('2100-01-01T00:00:00Z');

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

describe('S5 compliance money: ledger account opening balance', () => {
  it('createAccount keeps the rupee opening balance on the row and in the audit diff, and adds the paise sibling', async () => {
    const name = `S5 opening ${stamp()}`;
    const account = await asUser(CHAIRMAN, () =>
      createAccount({ name, accountType: 'bank', openingBalance: 12345.67 }),
    );
    expect(wire(account).openingBalance).toBe('12345.67');
    const audit = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { tenantId: TENANT, subjectType: 'ledger_account', subjectId: account.id, action: 'create' },
    });
    const diff = audit.diff as Record<string, unknown>; // a create audits its input as the diff
    expect(diff.openingBalance).toBe(12345.67);
    expect(wire(account).openingBalanceMinor).toBe('1234567');
    expect(String(diff.openingBalanceMinor)).toBe('1234567');
  });

  it('the trial balance and the account list carry the opening balance to the paisa', async () => {
    const name = `S5 tb ${stamp()}`;
    await asUser(CHAIRMAN, () => createAccount({ name, accountType: 'bank', openingBalance: 12345.67 }));

    const tb = await asUser(CHAIRMAN, () => trialBalance(FAR_FUTURE));
    const row = tb.rows.find((r) => r.name === name)!;
    expect(row.debit).toBe(12345.67);
    expect(row.credit).toBe(0);

    const accounts = await asUser(CHAIRMAN, () => listAccounts());
    const listed = accounts.find((a) => a.name === name)!;
    expect(wire(listed).openingBalance).toBe('12345.67');
    expect(wire(listed).openingBalanceMinor).toBe('1234567');
  });
});

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(() => {
  server?.close();
});

async function getAs(email: string, path: string) {
  const p: TestPrincipal = await principalFor(email);
  const token = await sessionToken({
    userId: p.userId,
    tenantId: p.tenantId,
    affiliationId: p.affiliationId,
    stepUp: true,
  });
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as any };
}

describe('S5 compliance money: bank statement line', () => {
  async function freshAccount(tag: string) {
    return unscopedPrisma.ledgerAccount.create({
      data: { tenantId: TENANT, name: `S5 bank ${tag} ${stamp()}`, accountType: 'bank' },
    });
  }

  it('an imported line keeps its rupee amount in the reconciliation view, with the paise sibling', async () => {
    const account = await freshAccount('amount');
    const reference = `S5-CHQ-${stamp()}`;
    const result = await asUser(CHAIRMAN, () =>
      importBankStatement(account.id, [
        {
          date: new Date('2030-04-02T00:00:00.000Z'),
          amount: 12345.67,
          direction: 'out',
          reference,
          narration: 'Paise line',
        },
      ]),
    );
    expect(result.imported).toBe(1);

    const view = await getAs(CHAIRMAN, `/compliance/books/bank/${account.id}/reconciliation`);
    expect(view.status).toBe(200);
    const line = view.body.unmatchedBank.find((l: { reference: string }) => l.reference === reference);
    expect(line.amount).toBe(12345.67);
    expect(line.amountMinor).toBe('1234567');
  });

  it('the stored fingerprint is the documented key, so a re-import of the same statement adds nothing', async () => {
    const account = await freshAccount('fingerprint');
    const line = {
      date: new Date('2030-04-02T00:00:00.000Z'),
      amount: 12345.67,
      direction: 'out' as const,
      reference: 'CHQ-FP',
      narration: 'Fingerprint line',
    };
    await asUser(CHAIRMAN, () => importBankStatement(account.id, [line]));

    // statementLineKey(accountId, content, occurrence), content = IST day | amount to two places | direction | reference | narration.
    const content = ['2030-04-02', '12345.67', 'out', 'CHQ-FP', 'Fingerprint line'].join('|');
    const expected = createHash('sha256').update(`${account.id}|${content}|0`).digest('hex');
    const stored = await unscopedPrisma.bankStatementLine.findFirstOrThrow({
      where: { tenantId: TENANT, accountId: account.id },
    });
    expect(stored.fingerprint).toBe(expected);

    const again = await asUser(CHAIRMAN, () => importBankStatement(account.id, [line]));
    expect(again).toEqual({ imported: 0, skipped: 1 });
  });

  it('a bank line of 12345.67 matches a ledger entry of 12345.67 and not one of 12345.68', async () => {
    const day = new Date('2030-07-10T00:00:00.000Z');

    const exact = await freshAccount('match-exact');
    await asUser(CHAIRMAN, () =>
      payOutSettled({ txnDate: day, direction: 'out', amount: 12345.67, accountId: exact.id, note: 'Exact' }),
    );
    await asUser(CHAIRMAN, () =>
      importBankStatement(exact.id, [{ date: day, amount: 12345.67, direction: 'out', narration: 'Exact NEFT' }]),
    );
    const matched = await asUser(CHAIRMAN, () => matchBankLines(exact.id));
    expect(matched.matched).toBe(1);

    const off = await freshAccount('match-off');
    await asUser(CHAIRMAN, () =>
      payOutSettled({ txnDate: day, direction: 'out', amount: 12345.68, accountId: off.id, note: 'Off by a paisa' }),
    );
    await asUser(CHAIRMAN, () =>
      importBankStatement(off.id, [{ date: day, amount: 12345.67, direction: 'out', narration: 'Off NEFT' }]),
    );
    const unmatched = await asUser(CHAIRMAN, () => matchBankLines(off.id));
    expect(unmatched.matched).toBe(0);
    expect(unmatched.unmatchedBank).toBe(1);
  });
});

describe('S5 compliance money: TDS challan', () => {
  it('a challan keeps its rupee amount on the row and in the audit diff, with the paise sibling', async () => {
    const challan = await asUser(FINANCE_2, () =>
      createChallan({ month: '2095-03', sectionGroup: `S5-${stamp()}`, amount: 12345.67 }),
    );
    expect(wire(challan).amount).toBe('12345.67');
    const audit = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { tenantId: TENANT, subjectType: 'tds_challan', subjectId: challan.id, action: 'create' },
    });
    const diff = audit.diff as Record<string, unknown>; // a create audits its input as the diff
    expect(diff.amount).toBe(12345.67);
    expect(wire(challan).amountMinor).toBe('1234567');
    expect(String(diff.amountMinor)).toBe('1234567');
  });

  it('the deposit event carries the rupee amount and the paise sibling', async () => {
    const challan = await asUser(FINANCE_2, () =>
      createChallan({ month: '2095-04', sectionGroup: `S5-${stamp()}`, amount: 12345.67 }),
    );
    await asUser(CHAIRMAN, () =>
      markChallanPaid(challan.id, {
        bsrCode: 'BSR1234567',
        challanNo: `CH${stamp()}`,
        paidOn: new Date('2095-04-07T00:00:00Z'),
      }),
    );

    const deposited = await unscopedPrisma.eventRecord.findFirstOrThrow({
      where: { tenantId: TENANT, eventName: 'kz.fin.tds.deposited', subjectEntityId: challan.id },
    });
    expect(deposited.newState).toMatchObject({ amount: 12345.67 });
    expect(deposited.newState).toMatchObject({ amountMinor: '1234567' });
  });
});

describe('S5 compliance money: advance-tax payment', () => {
  // A financial year of its own per run: the schedule sums every payment in the year,
  // and the test database is not reset between runs.
  const startYear = 2100 + Math.floor(Math.random() * 800);
  const fy = `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

  it('a payment keeps its rupee amount on the row and feeds the instalment schedule to the paisa', async () => {
    const payment = await asUser(CHAIRMAN, () =>
      recordAdvanceTaxPayment({
        fy,
        instalmentDate: new Date(Date.UTC(startYear, 5, 15)),
        amount: 12345.67,
        paidOn: new Date(Date.UTC(startYear, 5, 10)),
      }),
    );
    expect(wire(payment).amount).toBe('12345.67');
    const audit = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { tenantId: TENANT, subjectType: 'advance_tax_payment', subjectId: payment.id, action: 'create' },
    });
    const diff = audit.diff as Record<string, unknown>; // a create audits its input as the diff
    expect(diff.amount).toBe(12345.67);
    expect(wire(payment).amountMinor).toBe('1234567');
    expect(String(diff.amountMinor)).toBe('1234567');
  });

  it('the advance-tax estimate reports the instalment paid to the paisa', async () => {
    const estimate = await getAs(CHAIRMAN, `/compliance/tax/advance-tax/${fy}`);
    expect(estimate.status).toBe(200);
    expect(estimate.body.schedule[0].paidSoFar).toBe(12345.67);
  });
});
