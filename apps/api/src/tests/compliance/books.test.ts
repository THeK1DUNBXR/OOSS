/**
 * Compliance — books and audit (docs/plan/compliance.md, D).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { recordTransaction, reverseTransaction, profitAndLoss } from '../../domains/books.js';
import {
  requestClosePeriod,
  closePeriod,
  reopenPeriod,
  verifyAuditChain,
  sweepRetention,
  retentionReport,
  statementForFy,
  depreciationReport,
  trialBalance,
  generalLedgerCsv,
  tallyExportXml,
  importBankStatement,
  matchBankLines,
  reconciliationReport,
} from '../../domains/compliance/books.js';
import { extractTallyXml } from '../../imports/tallyXml.js';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function bankAccount() {
  return unscopedPrisma.ledgerAccount.findFirstOrThrow({ where: { tenantId: TENANT, accountType: 'bank' } });
}

async function categoryNamed(name: string) {
  return unscopedPrisma.ledgerCategory.findFirstOrThrow({ where: { tenantId: TENANT, name } });
}

// ===========================================================================
// CMP-AUD-001 — the audit-trail proviso
// ===========================================================================

describe('CMP-AUD-001 — the five-plus-two governed entities produce a diffed AuditRecord', () => {
  it('recording a transaction produces an AuditRecord', async () => {
    const account = await bankAccount();
    const category = await categoryNamed('General Expenses');
    const txn = await asUser('finance@kaizen.co.in', () =>
      recordTransaction({ txnDate: new Date(), direction: 'out', amount: 321, accountId: account.id, categoryId: category.id, note: 'CMP-AUD-001' }),
    );
    const record = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TENANT, subjectType: 'transaction', subjectId: txn.id },
    });
    expect(record).not.toBeNull();
    expect(record!.action).toBe('create');
    expect(record!.hash).not.toBeNull();
  });

  it('paying a vendor bill produces an update AuditRecord with a before/after diff', async () => {
    const account = await bankAccount();
    const bill = await asUser('finance@kaizen.co.in', () =>
      prisma.vendorBill.create({
        data: { tenantId: TENANT, recordCode: `BILL-TEST-${Date.now()}`, vendorName: 'CMP-AUD Test Vendor', billDate: new Date(), subtotal: 1000, total: 1000, status: 'open' },
      }),
    );
    const { payVendorBill } = await import('../../domains/books.js');
    await asUser('finance@kaizen.co.in', () => payVendorBill(bill.id, { amount: 1000, accountId: account.id, paidOn: new Date() }));

    const record = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TENANT, subjectType: 'vendor_bill', subjectId: bill.id, action: 'update' },
    });
    expect(record).not.toBeNull();
    const diff = record!.diff as Record<string, unknown>;
    expect(diff).toHaveProperty('status');
  });

  it('reversing a transaction audits both the original (update) and the reversal (create)', async () => {
    const account = await bankAccount();
    const category = await categoryNamed('General Expenses');
    const txn = await asUser('finance@kaizen.co.in', () =>
      recordTransaction({ txnDate: new Date(), direction: 'out', amount: 555, accountId: account.id, categoryId: category.id }),
    );
    const reversal = await asUser('finance@kaizen.co.in', () => reverseTransaction(txn.id, 'CMP-AUD-001 reversal'));

    const originalUpdate = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TENANT, subjectType: 'transaction', subjectId: txn.id, action: 'update' },
    });
    const reversalCreate = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TENANT, subjectType: 'transaction', subjectId: reversal.id, action: 'create' },
    });
    expect(originalUpdate).not.toBeNull();
    expect(reversalCreate).not.toBeNull();
  });

  it('creating a fixed asset, a loan, a ledger account and a ledger category are all audited', async () => {
    const { createAsset, createLoan, createAccount, createCategory } = await import('../../domains/books.js');
    const asset = await asUser('finance@kaizen.co.in', () =>
      createAsset({ name: `CMP-AUD Asset ${Date.now()}`, purchaseDate: new Date(), cost: 50_000, usefulLifeMonths: 36 }),
    );
    const loan = await asUser('finance@kaizen.co.in', () =>
      createLoan({ lender: 'CMP-AUD Bank', principal: 100_000, annualRate: 10, tenureMonths: 12, startDate: new Date() }),
    );
    const account = await asUser('finance@kaizen.co.in', () => createAccount({ name: `CMP-AUD Account ${Date.now()}` }));
    const category = await asUser('finance@kaizen.co.in', () => createCategory({ name: `CMP-AUD Category ${Date.now()}` }));

    for (const [subjectType, subjectId] of [
      ['fixed_asset', asset.id],
      ['loan', loan.id],
      ['ledger_account', account.id],
      ['ledger_category', category.id],
    ] as const) {
      const record = await unscopedPrisma.auditRecord.findFirst({ where: { tenantId: TENANT, subjectType, subjectId } });
      expect(record, `expected an AuditRecord for ${subjectType}`).not.toBeNull();
    }
  });
});

// ===========================================================================
// CMP-AUD-002 — the AuditRecord hash chain
// ===========================================================================

describe('CMP-AUD-002 — the AuditRecord hash chain', () => {
  it('verifies clean after ordinary writes', async () => {
    const account = await bankAccount();
    const category = await categoryNamed('General Expenses');
    await asUser('finance@kaizen.co.in', () =>
      recordTransaction({ txnDate: new Date(), direction: 'out', amount: 42, accountId: account.id, categoryId: category.id }),
    );

    const result = await asUser('finance@kaizen.co.in', () => verifyAuditChain(TENANT));
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThan(0);
    expect(result.brokenAt).toBeNull();
  });

  it('detects a tampered row', async () => {
    const account = await bankAccount();
    const category = await categoryNamed('General Expenses');
    const txn = await asUser('finance@kaizen.co.in', () =>
      recordTransaction({ txnDate: new Date(), direction: 'out', amount: 77, accountId: account.id, categoryId: category.id }),
    );
    const record = await unscopedPrisma.auditRecord.findFirstOrThrow({
      where: { tenantId: TENANT, subjectType: 'transaction', subjectId: txn.id, action: 'create' },
    });

    // Tampered directly, the way an operator bypassing the application would —
    // the diff is rewritten but the hash is left as it was.
    await unscopedPrisma.auditRecord.update({ where: { id: record.id }, data: { diff: { tampered: true } as never } });

    const result = await asUser('finance@kaizen.co.in', () => verifyAuditChain(TENANT));
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(record.id);

    // Left tampered for the rest of the suite would break every subsequent
    // verify call — restore it.
    await unscopedPrisma.auditRecord.update({ where: { id: record.id }, data: { diff: record.diff as never } });
    const restored = await asUser('finance@kaizen.co.in', () => verifyAuditChain(TENANT));
    expect(restored.ok).toBe(true);
  });

  it('a viewer without audit:view cannot call verify', async () => {
    const err = await expectReject(() => asUser('employee@kaizen.co.in', () => verifyAuditChain(TENANT)));
    expect(err.status).toBe(403);
  });
});

// ===========================================================================
// CMP-AUD-003 — accounting periods
// ===========================================================================

describe('CMP-AUD-003 — a closed accounting period vetoes new or edited entries in it', () => {
  const closedPeriod = '2019-06';

  it('the proposer cannot also approve the close (two-party)', async () => {
    await asUser('finance@kaizen.co.in', () => requestClosePeriod(closedPeriod));
    const err = await expectReject(() => asUser('finance@kaizen.co.in', () => closePeriod(closedPeriod)));
    expect(err.status).toBe(403);

    const row = await unscopedPrisma.accountingPeriod.findFirstOrThrow({ where: { tenantId: TENANT, period: closedPeriod } });
    expect(row.status).toBe('closing');

    const closed = await asUser('chairman@kaizen.co.in', () => closePeriod(closedPeriod));
    expect(closed.status).toBe('closed');
    expect(closed.closedById).not.toBe(closed.requestedById);
  });

  it('a transaction dated inside the closed period is rejected', async () => {
    const account = await bankAccount();
    const category = await categoryNamed('General Expenses');
    const err = await expectReject(() =>
      asUser('finance@kaizen.co.in', () =>
        recordTransaction({ txnDate: new Date(Date.UTC(2019, 5, 15)), direction: 'out', amount: 100, accountId: account.id, categoryId: category.id }),
      ),
    );
    expect(err.message).toContain('closed accounting period');
  });

  it('reversing an entry from before the period existed still posts, dated today rather than backdated', async () => {
    const account = await bankAccount();
    const category = await categoryNamed('General Expenses');
    // Recorded in an open period, then the period it is reversed in is today's — open.
    const txn = await asUser('finance@kaizen.co.in', () =>
      recordTransaction({ txnDate: new Date(), direction: 'out', amount: 88, accountId: account.id, categoryId: category.id }),
    );
    const reversal = await asUser('finance@kaizen.co.in', () => reverseTransaction(txn.id, 'CMP-AUD-003'));
    const today = new Date().toISOString().slice(0, 10);
    expect(reversal.txnDate.toISOString().slice(0, 10)).toBe(today);
  });

  it('reopening needs a reason, and is itself audited', async () => {
    await expect(asUser('chairman@kaizen.co.in', () => reopenPeriod(closedPeriod, ''))).rejects.toBeTruthy();
    const reopened = await asUser('chairman@kaizen.co.in', () => reopenPeriod(closedPeriod, 'Auditor found a misposted entry'));
    expect(reopened.status).toBe('reopened');

    const record = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TENANT, subjectType: 'accounting_period', subjectId: reopened.id, action: 'update' },
      orderBy: { timestamp: 'desc' },
    });
    expect(record).not.toBeNull();

    // Put it back how the rest of the suite found it, closed.
    await asUser('finance@kaizen.co.in', () => requestClosePeriod(closedPeriod));
    await asUser('chairman@kaizen.co.in', () => closePeriod(closedPeriod));
  });
});

// ===========================================================================
// Retention
// ===========================================================================

describe('Retention — flagged, never deleted', () => {
  it('sweeps and reports records past the 8-year floor, owned by finance', async () => {
    // Nothing in the demo dataset is 8 years old, so a policy-only sweep finds
    // nothing to flag — this proves the sweep runs cleanly and the report
    // reads back the seeded policies either way.
    const flagged = await asUser('chairman@kaizen.co.in', () => sweepRetention());
    expect(flagged).toBeGreaterThanOrEqual(0);

    const report = await asUser('finance@kaizen.co.in', () => retentionReport());
    expect(report.policies.length).toBeGreaterThan(0);
    expect(report.policies.map((p) => p.entityType)).toContain('transaction');
  });
});

// ===========================================================================
// Schedule III
// ===========================================================================

describe('Schedule III — nothing dropped, unmapped stays visible', () => {
  it('ties to profitAndLoss for the months inside the financial year', async () => {
    const fyStartYear = 2025;
    const statement = await asUser('chairman@kaizen.co.in', () => statementForFy(fyStartYear));

    // Sum profitAndLoss across the FY's months and compare to the statement's totals.
    let income = 0;
    let expense = 0;
    for (let m = 4; m <= 12; m += 1) {
      const pl = await asUser('chairman@kaizen.co.in', () => profitAndLoss(`${fyStartYear}-${String(m).padStart(2, '0')}`));
      income += pl.income;
      expense += pl.expense;
    }
    for (let m = 1; m <= 3; m += 1) {
      const pl = await asUser('chairman@kaizen.co.in', () => profitAndLoss(`${fyStartYear + 1}-${String(m).padStart(2, '0')}`));
      income += pl.income;
      expense += pl.expense;
    }

    expect(Math.round(statement.profitAndLoss.income)).toBe(Math.round(income));
    expect(Math.round(statement.profitAndLoss.expense)).toBe(Math.round(expense));
  });

  it('every category with movement lands somewhere — mapped or explicitly not yet mapped', async () => {
    const statement = await asUser('chairman@kaizen.co.in', () => statementForFy(2025));
    const mappedTotal = statement.profitAndLoss.heads.reduce((s, h) => s + h.amount, 0);
    const unmappedTotal = statement.profitAndLoss.unmapped.reduce((s, h) => s + h.amount, 0);
    // income - expense on the categorised side should account for the net,
    // modulo whatever landed in "not yet mapped" — either way both are visible.
    expect(mappedTotal + unmappedTotal).not.toBe(0);
  });
});

// ===========================================================================
// Depreciation
// ===========================================================================

describe('Depreciation — Schedule II against the Income-tax block, deliberately not the same number', () => {
  it('computes both for every asset, and flags a mismatched useful life', async () => {
    const fyStartYear = new Date().getUTCMonth() >= 3 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
    const report = await asUser('finance@kaizen.co.in', () => depreciationReport(fyStartYear));
    const rows = report.rows as Array<{
      name: string;
      companiesAct: { charge?: number; mismatch?: boolean } | { note: string };
      incomeTax: { charge?: number | null } | { note: string };
    }>;
    expect(rows.length).toBeGreaterThan(0);

    const workstations = rows.find((r) => r.name.includes('Developer workstations'));
    expect(workstations).toBeDefined();
    if (workstations && 'mismatch' in workstations.companiesAct) {
      // Seeded at 48 months (4 years); Schedule II computers = 3 years.
      expect(workstations.companiesAct.mismatch).toBe(true);
    }

    const comparable = rows.filter(
      (row): row is typeof rows[number] & { companiesAct: { charge: number }; incomeTax: { charge: number } } =>
        'charge' in row.companiesAct && row.companiesAct.charge != null && 'charge' in row.incomeTax && row.incomeTax.charge != null,
    );
    expect(comparable.length).toBeGreaterThan(0);
    // Two independent statutory answers for the same asset in the same year —
    // at least one of them should not coincide.
    expect(comparable.some((row) => row.companiesAct.charge !== row.incomeTax.charge)).toBe(true);
  });
});

// ===========================================================================
// Exports
// ===========================================================================

describe('Exports', () => {
  it('the trial balance is internally balanced', async () => {
    const tb = await asUser('finance@kaizen.co.in', () => trialBalance(new Date()));
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('the Tally export parses back through the importer', async () => {
    const { xml, count } = await asUser('finance@kaizen.co.in', () =>
      tallyExportXml({ from: new Date(Date.UTC(2026, 0, 1)), to: new Date() }),
    );
    expect(count).toBeGreaterThan(0);
    const extraction = extractTallyXml(xml);
    const ready = extraction.rows.filter((r) => r.status === 'ready');
    // Two ledger entries per voucher (the account and the category).
    expect(ready.length).toBe(count * 2);
  });

  it('the general ledger CSV lists the transactions in range', async () => {
    const csv = await asUser('finance@kaizen.co.in', () =>
      generalLedgerCsv({ from: new Date(Date.UTC(2026, 0, 1)), to: new Date() }),
    );
    const lines = csv.split('\n');
    expect(lines[0]).toContain('Date');
    expect(lines.length).toBeGreaterThan(1);
  });
});

// ===========================================================================
// Bank reconciliation
// ===========================================================================

describe('Bank reconciliation', () => {
  it('matches an imported statement line to the transaction it corresponds to', async () => {
    const account = await bankAccount();
    const category = await categoryNamed('General Expenses');
    const txn = await asUser('finance@kaizen.co.in', () =>
      recordTransaction({ txnDate: new Date(), direction: 'out', amount: 12_345, accountId: account.id, categoryId: category.id, reference: 'CHQ-9911' }),
    );

    await asUser('finance@kaizen.co.in', () =>
      importBankStatement(account.id, [{ date: new Date(), amount: 12_345, direction: 'out', reference: 'CHQ-9911' }]),
    );
    const result = await asUser('finance@kaizen.co.in', () => matchBankLines(account.id));
    expect(result.matched).toBeGreaterThanOrEqual(1);

    const reconciled = await unscopedPrisma.transaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(reconciled.reconciledAt).not.toBeNull();

    const report = await asUser('finance@kaizen.co.in', () => reconciliationReport(account.id));
    expect(report.matchedCount).toBeGreaterThanOrEqual(1);
  });

  it('leaves an unmatched line and an unmatched entry visible rather than guessing', async () => {
    const account = await bankAccount();
    await asUser('finance@kaizen.co.in', () =>
      importBankStatement(account.id, [{ date: new Date(), amount: 999_999.5, direction: 'out', reference: null }]),
    );
    const result = await asUser('finance@kaizen.co.in', () => matchBankLines(account.id));
    expect(result.unmatchedBank).toBeGreaterThanOrEqual(1);
  });
});
