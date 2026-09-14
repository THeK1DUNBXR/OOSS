/**
 * HCM — payrollops (docs/hcm/payrollops.md, workstream WS8).
 *
 * `payroll.ts` instructs payroll and settles it; `compliance/payroll.ts`
 * makes the statutory numbers correct. This is what happens around a run:
 * the ad-hoc lines and arrears somebody proposed for it (Self-Dealing Bar
 * enforced the same way `approveSalaryStructure` enforces it), the
 * double-entry breakdown finance reads a run as, the bank file it becomes,
 * the delta report that catches a run gone wrong before the money leaves,
 * the calendar a period runs against, and the question an employee raises
 * about their own payslip.
 *
 * The books have no multi-line journal-entry primitive — `recordTransaction`
 * posts one cash movement at a time. So the full debit/credit breakdown by
 * division lives in `PayrollJournal` here, and only the net-pay disbursement
 * leg is posted into the books proper, via that exported function, carrying
 * `payrollRunId` (a column `Transaction` already reserves for this).
 */

import {
  buildPayrollJournalLines,
  journalTotals,
  neftAdviceCsv,
  neftAdviceTotal,
  reconciliationDiff,
  unexplainedCount,
  payrollCalendarMilestone,
  PAY_ITEM_KINDS,
  EVENTS,
  type NeftBeneficiary,
} from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, canSeeMoney, scopeFor } from '../../platform/permissions.js';
import { assertEmploymentVisible } from '../../platform/recordScope.js';
import { auditWrite, auditExport, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';
import { payrollCostByDivision } from '../payroll.js';
import { recordTransaction } from '../books.js';
import { readRegulated } from '../compliance/privacy.js';

/** Withholds a money field for a caller who cannot see it — null, never zero, with a reason. Same shape as `hcm/compensation.ts`'s `money()`. */
function money(value: unknown, visible: boolean): number | null {
  return visible ? (num(value as never) ?? null) : null;
}

/** The account-types a net-pay disbursement may actually be posted from — a costing or equity account is never a cash movement. */
const CASH_ACCOUNT_TYPES = ['bank', 'cash', 'wallet'];

registerGovernedEntities('hcm_payrollops', [
  'pay_item',
  'adhoc_pay_line',
  'arrear',
  'payroll_journal',
  'bank_advice',
  'payroll_reconciliation',
  'payroll_calendar',
  'payroll_query',
]);

function assertPayPeriod(payPeriod: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(payPeriod)) {
    throw ApiError.badRequest(`"${payPeriod}" is not a pay period. Use YYYY-MM.`);
  }
}

/** The employment ids the caller may act as, when their grant is `own`-scoped. */
async function ownEmploymentIds(): Promise<string[]> {
  const auth = currentAuth();
  const rows = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, personId: auth.partyId ?? '' },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Pay items
// ---------------------------------------------------------------------------

export interface PayItemInput {
  code: string;
  name: string;
  kind: string;
  taxable?: boolean;
  statutoryBasis?: boolean;
  glAccountCode: string;
}

export async function listPayItems() {
  const auth = currentAuth();
  await assertCan({ resource: 'pay_items', verb: 'view' });
  return prisma.payItem.findMany({ where: { tenantId: auth.tenantId }, orderBy: { code: 'asc' } });
}

export async function createPayItem(input: PayItemInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'pay_items', verb: 'create' });
  if (!PAY_ITEM_KINDS.includes(input.kind as never)) {
    throw ApiError.badRequest(`"${input.kind}" is not a pay item kind. Expected one of ${PAY_ITEM_KINDS.join(', ')}.`);
  }
  const existing = await prisma.payItem.findFirst({ where: { tenantId: auth.tenantId, code: input.code } });
  if (existing) throw ApiError.conflict(`A pay item with code "${input.code}" already exists.`);

  const row = await prisma.payItem.create({
    data: {
      tenantId: auth.tenantId,
      code: input.code,
      name: input.name,
      kind: input.kind,
      taxable: input.taxable ?? true,
      statutoryBasis: input.statutoryBasis ?? false,
      glAccountCode: input.glAccountCode,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'pay_item', subjectId: row.id, after: row as never });
  return row;
}

export async function setPayItemActive(id: string, active: boolean) {
  const auth = currentAuth();
  await assertCan({ resource: 'pay_items', verb: 'edit' });
  const before = await prisma.payItem.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw ApiError.notFound('Pay item');
  const row = await prisma.payItem.update({ where: { id }, data: { active } });
  await auditWrite({ action: 'update', subjectType: 'pay_item', subjectId: id, before: before as never, after: row as never });
  return row;
}

// ---------------------------------------------------------------------------
// Ad-hoc pay lines — proposed by hrOps, approved by financeHead, never the
// same partyId.
// ---------------------------------------------------------------------------

export interface AdHocPayLineInput {
  employmentRelationshipId: string;
  payItemId: string;
  payPeriod: string;
  amount: number;
  reason: string;
}

export async function listAdHocPayLines(filter: { payPeriod?: string; employmentRelationshipId?: string; status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'adhoc_pay', verb: 'view' });
  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (filter.payPeriod) where.payPeriod = filter.payPeriod;
  if (filter.status) where.status = filter.status;
  const scope = await scopeFor('adhoc_pay', 'view');
  if (scope !== 'all') {
    where.employmentRelationshipId = { in: await ownEmploymentIds() };
  } else if (filter.employmentRelationshipId) {
    where.employmentRelationshipId = filter.employmentRelationshipId;
  }
  const visible = await canSeeMoney('adhoc_pay');
  const rows = await prisma.adHocPayLine.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
  return rows.map((r) => ({ ...r, amount: money(r.amount, visible), moneyWithheldReason: visible ? null : 'no_permission' }));
}

export async function createAdHocPayLine(input: AdHocPayLineInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'adhoc_pay', verb: 'create' });
  assertPayPeriod(input.payPeriod);
  await assertEmploymentVisible('adhoc_pay', input.employmentRelationshipId, 'create');

  const payItem = await prisma.payItem.findFirst({ where: { id: input.payItemId, tenantId: auth.tenantId, active: true } });
  if (!payItem) throw ApiError.notFound('Pay item');
  if (input.amount <= 0) throw ApiError.unprocessable('An ad-hoc pay line amount must be positive; the pay item\'s kind says which way it moves the payslip.');

  const row = await prisma.adHocPayLine.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      payItemId: input.payItemId,
      payPeriod: input.payPeriod,
      amount: input.amount,
      reason: input.reason,
      status: 'Proposed',
      proposedById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'adhoc_pay_line', subjectId: row.id, after: row as never, force: true });
  return row;
}

async function decideAdHocPayLine(id: string, approve: boolean, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'adhoc_pay', verb: 'approve' });
  const before = await prisma.adHocPayLine.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw ApiError.notFound('Ad-hoc pay line');
  if (before.status !== 'Proposed') throw ApiError.conflict(`This line is already ${before.status}.`);
  if (before.proposedById && before.proposedById === auth.partyId) {
    throw ApiError.forbidden(
      'The proposer of an ad-hoc pay line cannot also approve it (Self-Dealing Bar).',
      [{ axis: 'WHO', passed: false, reason: 'proposer_is_approver' }],
    );
  }

  const row = await prisma.adHocPayLine.update({
    where: { id },
    data: { status: approve ? 'Approved' : 'Rejected', approvedById: auth.partyId, approvedAt: new Date() },
  });
  await auditWrite({ action: 'update', subjectType: 'adhoc_pay_line', subjectId: id, before: before as never, after: row as never, force: true });
  if (approve) {
    await emit({
      name: EVENTS.ADHOC_PAY_APPROVED,
      subject: { entityType: 'adhoc_pay_line', entityId: row.id },
      newState: { payPeriod: row.payPeriod, amount: num(row.amount), reason: note ?? row.reason },
      confidentiality: 'confidential',
      impact: { domains: ['hr', 'fin'] },
    });
  }
  return row;
}

export const approveAdHocPayLine = (id: string, note?: string) => decideAdHocPayLine(id, true, note);
export const rejectAdHocPayLine = (id: string, note?: string) => decideAdHocPayLine(id, false, note);

// ---------------------------------------------------------------------------
// Arrears — same proposer/approver split.
// ---------------------------------------------------------------------------

export interface ArrearInput {
  employmentRelationshipId: string;
  fromPeriod: string;
  amount: number;
  reason: string;
}

export async function listArrears(filter: { employmentRelationshipId?: string; status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'arrears', verb: 'view' });
  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (filter.status) where.status = filter.status;
  const scope = await scopeFor('arrears', 'view');
  if (scope !== 'all') {
    where.employmentRelationshipId = { in: await ownEmploymentIds() };
  } else if (filter.employmentRelationshipId) {
    where.employmentRelationshipId = filter.employmentRelationshipId;
  }
  const visible = await canSeeMoney('arrears');
  const rows = await prisma.arrear.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
  return rows.map((r) => ({ ...r, amount: money(r.amount, visible), moneyWithheldReason: visible ? null : 'no_permission' }));
}

export async function createArrear(input: ArrearInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'arrears', verb: 'create' });
  assertPayPeriod(input.fromPeriod);
  await assertEmploymentVisible('arrears', input.employmentRelationshipId, 'create');
  if (input.amount <= 0) throw ApiError.unprocessable('An arrear amount must be positive.');

  const row = await prisma.arrear.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      fromPeriod: input.fromPeriod,
      amount: input.amount,
      reason: input.reason,
      status: 'Proposed',
      proposedById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'arrear', subjectId: row.id, after: row as never, force: true });
  return row;
}

async function decideArrear(id: string, approve: boolean) {
  const auth = currentAuth();
  await assertCan({ resource: 'arrears', verb: 'approve' });
  const before = await prisma.arrear.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw ApiError.notFound('Arrear');
  if (before.status !== 'Proposed') throw ApiError.conflict(`This arrear is already ${before.status}.`);
  if (before.proposedById && before.proposedById === auth.partyId) {
    throw ApiError.forbidden(
      'The proposer of an arrear cannot also approve it (Self-Dealing Bar).',
      [{ axis: 'WHO', passed: false, reason: 'proposer_is_approver' }],
    );
  }

  const row = await prisma.arrear.update({
    where: { id },
    data: { status: approve ? 'Approved' : 'Rejected', approvedById: auth.partyId, approvedAt: new Date() },
  });
  await auditWrite({ action: 'update', subjectType: 'arrear', subjectId: id, before: before as never, after: row as never, force: true });
  if (approve) {
    await emit({
      name: EVENTS.ARREAR_APPROVED,
      subject: { entityType: 'arrear', entityId: row.id },
      newState: { fromPeriod: row.fromPeriod, amount: num(row.amount) },
      confidentiality: 'confidential',
      impact: { domains: ['hr', 'fin'] },
    });
  }
  return row;
}

export const approveArrear = (id: string) => decideArrear(id, true);
export const rejectArrear = (id: string) => decideArrear(id, false);

export async function markArrearPaid(id: string, payPeriod: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'arrears', verb: 'edit' });
  assertPayPeriod(payPeriod);
  const before = await prisma.arrear.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw ApiError.notFound('Arrear');
  if (before.status !== 'Approved') throw ApiError.unprocessable(`Only an Approved arrear can be marked paid; this one is ${before.status}.`);
  const row = await prisma.arrear.update({ where: { id }, data: { status: 'Paid', paidInPayPeriod: payPeriod, paidAt: new Date() } });
  await auditWrite({ action: 'update', subjectType: 'arrear', subjectId: id, before: before as never, after: row as never, force: true });
  return row;
}

// ---------------------------------------------------------------------------
// Payroll journal
// ---------------------------------------------------------------------------

/** Masks a journal's money — its two running totals and every line's debit/credit — leaving the account/cost-centre labels (classification, not money) visible either way. */
function maskJournal<T extends { totalDebit: unknown; totalCredit: unknown; lines: unknown }>(row: T, visible: boolean) {
  const lines = (row.lines as Array<Record<string, unknown>>).map((l) => ({
    ...l,
    debit: money(l.debit, visible),
    credit: money(l.credit, visible),
  }));
  return { ...row, totalDebit: money(row.totalDebit, visible), totalCredit: money(row.totalCredit, visible), lines, moneyWithheldReason: visible ? null : 'no_permission' };
}

export async function listPayrollJournals() {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_journals', verb: 'view' });
  const visible = await canSeeMoney('payroll_journals');
  const rows = await prisma.payrollJournal.findMany({ where: { tenantId: auth.tenantId }, orderBy: { payPeriod: 'desc' }, take: 36 });
  return rows.map((r) => maskJournal(r, visible));
}

export async function getPayrollJournal(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_journals', verb: 'view' });
  const row = await prisma.payrollJournal.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Payroll journal');
  const visible = await canSeeMoney('payroll_journals');
  return maskJournal(row, visible);
}

/**
 * Builds (or rebuilds, while still Prepared) the division-wise double entry
 * for a run from `payrollCostByDivision` — the same aggregate the executive
 * dashboard reads. Only an Approved or later run's figures are final enough
 * to journal; a Draft run's totals are still a work in progress.
 */
export async function generatePayrollJournal(payrollRunId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_journals', verb: 'create' });

  const run = await prisma.payrollRun.findFirst({ where: { id: payrollRunId, tenantId: auth.tenantId } });
  if (!run) throw ApiError.notFound('Payroll run');
  if (!['Approved', 'Disbursed', 'Locked'].includes(run.status)) {
    throw ApiError.unprocessable(`The run is ${run.status}. A journal is prepared once figures are Approved, not before.`);
  }

  const existing = await prisma.payrollJournal.findUnique({ where: { payrollRunId } });
  if (existing && existing.status === 'Posted') {
    throw ApiError.conflict('This run\'s journal is already posted. A correction is a new run, not a rewritten journal.');
  }

  const rows = await payrollCostByDivision(run.payPeriod);
  const lines = buildPayrollJournalLines(rows);
  const totals = journalTotals(lines);
  if (!totals.balanced) {
    // Structurally unreachable from `buildPayrollJournalLines`'s own arithmetic,
    // kept as a hard stop rather than trusted silently — a journal that does
    // not balance is never posted, whatever produced it.
    throw ApiError.unprocessable('The generated journal does not balance (debits ≠ credits). Nothing was written.');
  }

  const data = {
    tenantId: auth.tenantId,
    payrollRunId,
    payPeriod: run.payPeriod,
    lines: lines as never,
    totalDebit: totals.totalDebit,
    totalCredit: totals.totalCredit,
    status: 'Prepared',
    preparedById: auth.partyId,
  };

  const row = existing
    ? await prisma.payrollJournal.update({ where: { id: existing.id }, data })
    : await prisma.payrollJournal.create({ data });

  await auditWrite({ action: existing ? 'update' : 'create', subjectType: 'payroll_journal', subjectId: row.id, after: row as never, force: true });
  return row;
}

/**
 * Posts the net-pay disbursement leg into the books, via `recordTransaction`
 * — the one exported, clean create function `books.ts` offers. That call is
 * single-entry (one account, one direction, one amount), so this posts only
 * the cash-out side; the full division-wise debit/credit breakdown stays on
 * the journal row itself, which is the record of how that cash figure was
 * arrived at.
 */
export async function postPayrollJournal(id: string, accountId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_journals', verb: 'approve' });

  const journal = await prisma.payrollJournal.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!journal) throw ApiError.notFound('Payroll journal');
  if (journal.status === 'Posted') throw ApiError.conflict('This journal is already posted.');
  if (journal.preparedById && journal.preparedById === auth.partyId) {
    throw ApiError.forbidden(
      'The preparer of a payroll journal cannot also post it (Self-Dealing Bar).',
      [{ axis: 'WHO', passed: false, reason: 'preparer_is_poster' }],
    );
  }

  const run = await prisma.payrollRun.findFirst({ where: { id: journal.payrollRunId, tenantId: auth.tenantId } });
  if (!run) throw ApiError.notFound('Payroll run');

  const account = await prisma.ledgerAccount.findFirst({ where: { id: accountId, tenantId: auth.tenantId, deletedAt: null } });
  if (!account) throw ApiError.notFound('Account');
  if (!CASH_ACCOUNT_TYPES.includes(account.accountType)) {
    throw ApiError.unprocessable(`Net pay must be disbursed from a bank, cash or wallet account; "${account.name}" is a ${account.accountType} account.`);
  }

  // The cash leg is the net pay payable, not the journal's total credit —
  // that total also carries the statutory/other deductions payable, which
  // moves the company's money to a different payee on a different day, not
  // straight to employees now.
  const txn = await recordTransaction({
    txnDate: new Date(),
    direction: 'out',
    amount: num(run.netTotal) ?? 0,
    accountId,
    division: null,
    counterparty: `Payroll ${run.payPeriod}`,
    method: 'bank_transfer',
    reference: run.recordCode,
    note: `Net pay disbursement for ${run.payPeriod} (${run.headcount} employee${run.headcount === 1 ? '' : 's'}).`,
    source: 'payroll',
    payrollRunId: run.id,
  });

  const row = await prisma.payrollJournal.update({
    where: { id },
    data: { status: 'Posted', transactionId: txn.id, postedById: auth.partyId, postedAt: new Date() },
  });
  await auditWrite({ action: 'update', subjectType: 'payroll_journal', subjectId: id, before: journal as never, after: row as never, force: true });
  await emit({
    name: EVENTS.PAYROLL_JOURNAL_POSTED,
    subject: { entityType: 'payroll_journal', entityId: row.id },
    related: [{ relation: 'posts_as', entityType: 'transaction', entityId: txn.id }],
    newState: { payPeriod: row.payPeriod, totalDebit: num(row.totalDebit), totalCredit: num(row.totalCredit) },
    confidentiality: 'confidential',
    impact: { domains: ['hr', 'fin'] },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Bank advice
// ---------------------------------------------------------------------------

/** Masks an account number to its last 4 digits — the same shape `compliance/payroll.ts` exposes on a payslip snapshot (`bankLast4`). */
function maskAccountNumber(accountNumber: string): string {
  const last4 = accountNumber.slice(-4);
  return last4 ? `••••${last4}` : '••••';
}

export async function listBankAdvices() {
  const auth = currentAuth();
  await assertCan({ resource: 'bank_advices', verb: 'view' });
  const visible = await canSeeMoney('bank_advices');
  const rows = await prisma.bankAdvice.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { generatedAt: 'desc' },
    take: 36,
    select: { id: true, payrollRunId: true, payPeriod: true, format: true, count: true, total: true, generatedAt: true },
  });
  return rows.map((r) => ({ ...r, total: money(r.total, visible), moneyWithheldReason: visible ? null : 'no_permission' }));
}

/**
 * A view of one bank advice for the web — beneficiary rows with the account
 * number masked to its last 4 digits, never the raw NEFT file. A caller who
 * needs the full account numbers (to actually pay a bank) calls
 * `downloadBankAdvice` instead, which is gated on the `export` verb rather
 * than `view` and is the one path that is audited as an export.
 */
export async function getBankAdvice(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'bank_advices', verb: 'view' });
  const row = await prisma.bankAdvice.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Bank advice');
  const visible = await canSeeMoney('bank_advices');
  const rows = (row.rows as unknown as NeftBeneficiary[]).map((r) => ({ ...r, accountNumber: maskAccountNumber(r.accountNumber), amount: money(r.amount, visible) }));
  return {
    id: row.id,
    payrollRunId: row.payrollRunId,
    payPeriod: row.payPeriod,
    format: row.format,
    count: row.count,
    total: money(row.total, visible),
    generatedAt: row.generatedAt,
    rows,
    moneyWithheldReason: visible ? null : 'no_permission',
  };
}

/**
 * The raw NEFT CSV, full account numbers included — gated on `export`
 * (never `view` alone, and never held by `employee` at any scope) and
 * audited every time it is read, since this is the point a regulated field
 * leaves the system in the clear for a bank to act on.
 */
export async function downloadBankAdvice(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'bank_advices', verb: 'export' });
  const row = await prisma.bankAdvice.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Bank advice');
  await auditExport('bank_advice', row.id, row.count);
  return { filename: `bank-advice-${row.payPeriod}-${row.id.slice(-6)}.csv`, csv: row.fileText };
}

/**
 * The NEFT file for a run — every bank account read here is decrypted and
 * handed straight to the file. `bank_advices` is held only by hrOps and
 * financeHead (never `employee`), so this is exactly the boundary where a
 * regulated field is meant to leave in the clear: the point of the file is
 * that a bank reads it.
 */
export async function generateBankAdvice(payrollRunId: string) {
  const auth = currentAuth();
  // hrOps and financeHead hold `bank_advices:export` (never `create` — the
  // matrix treats producing this file as the export it is), and neither
  // holds it at `employee` scope at all.
  await assertCan({ resource: 'bank_advices', verb: 'export' });

  const run = await prisma.payrollRun.findFirst({ where: { id: payrollRunId, tenantId: auth.tenantId } });
  if (!run) throw ApiError.notFound('Payroll run');
  if (!['Approved', 'Disbursed', 'Locked'].includes(run.status)) {
    throw ApiError.unprocessable(`The run is ${run.status}. A bank advice is generated once pay is Approved, not before.`);
  }

  const instructions = await prisma.payrollInstruction.findMany({ where: { tenantId: auth.tenantId, payrollRunId } });
  const rows: NeftBeneficiary[] = [];
  for (const instr of instructions) {
    const net = num(instr.netAmount) ?? 0;
    if (net <= 0) continue;
    const employment = await prisma.employmentRelationship.findFirst({
      where: { id: instr.employmentRelationshipId },
      include: { person: { select: { fullName: true } } },
    });
    if (!employment) continue;
    const account = readRegulated(employment.bankAccountNumber);
    if (!account) {
      // No bank on file is an actionable gap, not a silently skipped row.
      await raiseException({
        code: 'EX-HCM-PAYROLLOPS-001',
        label: 'No bank account on file for a payslip with net pay due',
        severity: 'S2_WARNING',
        subjectType: 'employment_relationship',
        subjectId: employment.id,
        subjectLabel: employment.person?.fullName ?? employment.id,
        domain: 'hr',
        detail: `${employment.person?.fullName ?? employment.id} has net pay of ${net} for ${run.payPeriod} but no bank account on file.`,
        ownerPartyId: run.preparedById ?? auth.partyId,
      });
      continue;
    }
    rows.push({
      employeeName: employment.person?.fullName ?? employment.id,
      accountNumber: account,
      ifsc: employment.bankIfsc ?? '',
      amount: net,
      reference: `${run.recordCode}/${employment.id.slice(-6)}`,
    });
  }

  const fileText = neftAdviceCsv(rows);
  const total = neftAdviceTotal(rows);

  const row = await prisma.bankAdvice.create({
    data: {
      tenantId: auth.tenantId,
      payrollRunId,
      payPeriod: run.payPeriod,
      format: 'NEFT_CSV',
      fileText,
      rows: rows as never,
      count: rows.length,
      total,
      generatedById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'bank_advice', subjectId: row.id, after: { payPeriod: row.payPeriod, count: row.count, total: num(row.total) }, force: true });
  await auditExport('bank_advice', 'generated', rows.length);
  await emit({
    name: EVENTS.BANK_ADVICE_GENERATED,
    subject: { entityType: 'bank_advice', entityId: row.id },
    newState: { payPeriod: row.payPeriod, count: row.count, total },
    confidentiality: 'confidential',
    impact: { domains: ['hr', 'fin'] },
  });
  return { id: row.id, payrollRunId, payPeriod: row.payPeriod, count: row.count, total, generatedAt: row.generatedAt };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Masks a reconciliation's money — each delta's net figures — while leaving `unexplained`/`note`/`deltaPct` (a ratio, not money) visible either way. */
function maskReconciliation<T extends { deltas: unknown }>(row: T, visible: boolean) {
  const deltas = (row.deltas as Array<Record<string, unknown>>).map((d) => ({
    ...d,
    previousNet: visible ? d.previousNet : null,
    currentNet: visible ? d.currentNet : null,
    delta: visible ? d.delta : null,
  }));
  return { ...row, deltas, moneyWithheldReason: visible ? null : 'no_permission' };
}

export async function listPayrollReconciliations() {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_reconciliations', verb: 'view' });
  const visible = await canSeeMoney('payroll_reconciliations');
  const rows = await prisma.payrollReconciliation.findMany({ where: { tenantId: auth.tenantId }, orderBy: { generatedAt: 'desc' }, take: 36 });
  return rows.map((r) => maskReconciliation(r, visible));
}

export async function getPayrollReconciliation(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_reconciliations', verb: 'view' });
  const row = await prisma.payrollReconciliation.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Payroll reconciliation');
  const visible = await canSeeMoney('payroll_reconciliations');
  return maskReconciliation(row, visible);
}

/**
 * Diffs a run against the previous run for the prior calendar month (or an
 * explicitly named one), before disbursal — a swing beyond the threshold is
 * flagged so someone looks at it while the money has not left yet.
 */
export async function generatePayrollReconciliation(payrollRunId: string, previousPayrollRunId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_reconciliations', verb: 'create' });

  const run = await prisma.payrollRun.findFirst({ where: { id: payrollRunId, tenantId: auth.tenantId } });
  if (!run) throw ApiError.notFound('Payroll run');

  let previous = previousPayrollRunId
    ? await prisma.payrollRun.findFirst({ where: { id: previousPayrollRunId, tenantId: auth.tenantId } })
    : null;
  if (!previous && !previousPayrollRunId) {
    const [y, m] = run.payPeriod.split('-').map(Number);
    const prevPeriod = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    previous = await prisma.payrollRun.findFirst({ where: { tenantId: auth.tenantId, payPeriod: prevPeriod } });
  }

  const [currentInstr, previousInstr] = await Promise.all([
    prisma.payrollInstruction.findMany({ where: { tenantId: auth.tenantId, payrollRunId } }),
    previous ? prisma.payrollInstruction.findMany({ where: { tenantId: auth.tenantId, payrollRunId: previous.id } }) : Promise.resolve([]),
  ]);

  const deltas = reconciliationDiff(
    previousInstr.map((i) => ({ employmentRelationshipId: i.employmentRelationshipId, net: num(i.netAmount) ?? 0 })),
    currentInstr.map((i) => ({ employmentRelationshipId: i.employmentRelationshipId, net: num(i.netAmount) ?? 0 })),
  );
  const flagged = unexplainedCount(deltas);

  const row = await prisma.payrollReconciliation.create({
    data: {
      tenantId: auth.tenantId,
      payrollRunId,
      previousPayrollRunId: previous?.id ?? null,
      deltas: deltas as never,
      unexplainedCount: flagged,
      generatedById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'payroll_reconciliation', subjectId: row.id, after: { payrollRunId, unexplainedCount: flagged }, force: true });

  if (flagged > 0) {
    await raiseException({
      code: 'EX-HCM-PAYROLLOPS-002',
      label: 'Payroll reconciliation found unexplained deltas',
      severity: 'S2_WARNING',
      subjectType: 'payroll_reconciliation',
      subjectId: row.id,
      subjectLabel: `${run.payPeriod} reconciliation`,
      domain: 'hr',
      detail: `${flagged} employee${flagged === 1 ? '' : 's'} moved by more than the usual range against ${previous?.payPeriod ?? 'the previous run'}.`,
      ownerPartyId: run.preparedById ?? auth.partyId,
    });
    await emit({
      name: EVENTS.PAYROLL_RECONCILIATION_FLAGGED,
      subject: { entityType: 'payroll_reconciliation', entityId: row.id },
      newState: { payPeriod: run.payPeriod, unexplainedCount: flagged },
      confidentiality: 'confidential',
      impact: { domains: ['hr', 'fin'], severity: 'S2_WARNING' },
    });
  }

  return row;
}

// ---------------------------------------------------------------------------
// Payroll calendar
// ---------------------------------------------------------------------------

export interface PayrollCalendarInput {
  payPeriod: string;
  attendanceLockAt: Date;
  inputFreezeAt: Date;
  runByAt: Date;
  approveByAt: Date;
  payDate: Date;
  note?: string;
}

export async function listPayrollCalendar() {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_calendar', verb: 'view' });
  const rows = await prisma.payrollCalendar.findMany({ where: { tenantId: auth.tenantId }, orderBy: { payPeriod: 'desc' }, take: 36 });
  const now = new Date();
  return rows.map((r) => ({ ...r, milestone: payrollCalendarMilestone(r, now) }));
}

export async function upsertPayrollCalendarEntry(input: PayrollCalendarInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_calendar', verb: 'create' });
  assertPayPeriod(input.payPeriod);

  const dates = [input.attendanceLockAt, input.inputFreezeAt, input.runByAt, input.approveByAt, input.payDate];
  for (let i = 1; i < dates.length; i += 1) {
    if (dates[i].getTime() < dates[i - 1].getTime()) {
      throw ApiError.unprocessable('The calendar\'s milestones must fall in order: attendance lock, input freeze, run, approve, pay date.');
    }
  }

  const row = await prisma.payrollCalendar.upsert({
    where: { tenantId_payPeriod: { tenantId: auth.tenantId, payPeriod: input.payPeriod } },
    create: {
      tenantId: auth.tenantId,
      payPeriod: input.payPeriod,
      attendanceLockAt: input.attendanceLockAt,
      inputFreezeAt: input.inputFreezeAt,
      runByAt: input.runByAt,
      approveByAt: input.approveByAt,
      payDate: input.payDate,
      note: input.note ?? null,
    },
    update: {
      attendanceLockAt: input.attendanceLockAt,
      inputFreezeAt: input.inputFreezeAt,
      runByAt: input.runByAt,
      approveByAt: input.approveByAt,
      payDate: input.payDate,
      note: input.note ?? null,
    },
  });
  await auditWrite({ action: 'update', subjectType: 'payroll_calendar', subjectId: row.id, after: row as never });
  return row;
}

// ---------------------------------------------------------------------------
// Payroll queries — an employee's question about their own payslip.
// ---------------------------------------------------------------------------

export interface PayrollQueryInput {
  employmentRelationshipId: string;
  payslipId?: string | null;
  payPeriod: string;
  subject: string;
  message: string;
}

export async function listPayrollQueries(filter: { status?: string; employmentRelationshipId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_queries', verb: 'view' });
  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (filter.status) where.status = filter.status;
  const scope = await scopeFor('payroll_queries', 'view');
  if (scope !== 'all') {
    where.employmentRelationshipId = { in: await ownEmploymentIds() };
  } else if (filter.employmentRelationshipId) {
    where.employmentRelationshipId = filter.employmentRelationshipId;
  }
  return prisma.payrollQuery.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
}

export async function createPayrollQuery(input: PayrollQueryInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_queries', verb: 'create' });
  assertPayPeriod(input.payPeriod);
  await assertEmploymentVisible('payroll_queries', input.employmentRelationshipId, 'create');

  if (input.payslipId) {
    const payslip = await prisma.payslip.findFirst({ where: { id: input.payslipId, tenantId: auth.tenantId, employmentRelationshipId: input.employmentRelationshipId } });
    if (!payslip) throw ApiError.notFound('Payslip');
  }

  const row = await prisma.payrollQuery.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      payslipId: input.payslipId ?? null,
      payPeriod: input.payPeriod,
      subject: input.subject,
      message: input.message,
      status: 'Open',
    },
  });
  await auditWrite({ action: 'create', subjectType: 'payroll_query', subjectId: row.id, after: row as never, force: true });
  await emit({
    name: EVENTS.PAYROLL_QUERY_RAISED,
    subject: { entityType: 'payroll_query', entityId: row.id },
    newState: { payPeriod: row.payPeriod, subject: row.subject },
    confidentiality: 'confidential',
    impact: { domains: ['hr'] },
  });
  return row;
}

export async function respondToPayrollQuery(id: string, response: string, close = false) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_queries', verb: 'edit' });
  const before = await prisma.payrollQuery.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw ApiError.notFound('Payroll query');
  if (before.status === 'Closed') throw ApiError.conflict('This query is already closed.');

  const row = await prisma.payrollQuery.update({
    where: { id },
    data: {
      response,
      respondedById: auth.partyId,
      respondedAt: new Date(),
      status: close ? 'Closed' : 'Responded',
    },
  });
  await auditWrite({ action: 'update', subjectType: 'payroll_query', subjectId: id, before: before as never, after: row as never, force: true });
  await emit({
    name: EVENTS.PAYROLL_QUERY_RESOLVED,
    subject: { entityType: 'payroll_query', entityId: row.id },
    newState: { status: row.status },
    confidentiality: 'confidential',
    impact: { domains: ['hr'] },
  });
  return row;
}

export async function closePayrollQuery(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll_queries', verb: 'edit' });
  const before = await prisma.payrollQuery.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw ApiError.notFound('Payroll query');
  const row = await prisma.payrollQuery.update({ where: { id }, data: { status: 'Closed' } });
  await auditWrite({ action: 'update', subjectType: 'payroll_query', subjectId: id, before: before as never, after: row as never, force: true });
  return row;
}
