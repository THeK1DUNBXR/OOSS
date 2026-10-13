/**
 * Posting rules for the domain consumers (contract FX-70; CLAUDE.md rules 1, 2
 * and 4). Pure: no database, no clock, no account numbers.
 *
 * A posting role names what an entry touches ("the receivable from a party",
 * "output CGST"). The role resolves to a ledger account through a data row in
 * ledger_posting_roles, keyed by a scope (a business line, a payment mode, or
 * the empty string for an unscoped role). Nothing here says which account a role
 * is. That is the finance head's mapping, and until it is entered every role
 * is unmapped and a posting that needs it is refused.
 */

/**
 * Every role a posting can name. A role added here needs a migration-free data
 * row per tenant before any domain can post with it; a role removed here
 * orphans its rows, so do not remove one.
 */
export const POSTING_ROLES = [
  'TRADE_RECEIVABLE',
  'REVENUE',
  'OUTPUT_CGST',
  'OUTPUT_SGST',
  'OUTPUT_IGST',
  'ROUND_OFF',
  'CUSTOMER_ADVANCE',
  'BANK',
  'CASH',
  'EXPENSE',
  'VENDOR_PAYABLE',
  'ITC_RECEIVABLE',
  'PAYROLL_SALARY_EXPENSE',
  'PAYROLL_EMPLOYER_CONTRIB_EXPENSE',
  'PAYROLL_NET_PAY_PAYABLE',
  'PAYROLL_PF_PAYABLE',
  'PAYROLL_ESI_PAYABLE',
  'PAYROLL_PT_PAYABLE',
  'PAYROLL_TDS_PAYABLE',
  'PAYROLL_LWF_PAYABLE',
] as const;

export type PostingRole = (typeof POSTING_ROLES)[number];

/**
 * The scope of a role that has none. TRADE_RECEIVABLE is unscoped because the
 * party goes on the journal line (the party dimension), not into the mapping:
 * one control account serves every party.
 */
export const UNSCOPED = '';

/**
 * Journal source types. The column is a plain string (no database enum), so a
 * new type is a union member here and no migration.
 */
export const JOURNAL_SOURCE_TYPES = [
  'invoice',
  'receipt',
  'payment',
  'payroll_run',
  'depreciation',
  'import',
  'manual',
  'opening_balance',
  'fx_revaluation',
  'accrual',
  'reversal',
  'credit_note',
  'expense_claim',
  'vendor_bill',
] as const;

/** A caller's reason for refusing a posting or a build. Carries no account numbers, only the role and its scope. */
export class PostingRuleError extends Error {
  constructor(
    message: string,
    readonly code: 'ROLE_UNMAPPED' | 'INCOME_LINE_WITHOUT_BUSINESS_LINE' | 'UNBALANCED_SOURCE' | 'INVALID_AMOUNT',
  ) {
    super(message);
    this.name = 'PostingRuleError';
  }
}

/**
 * The accounts a builder posts to, resolved before the build. Keyed by
 * postingAccountKey, so a builder asks for (role, scope) and gets the account
 * or a refusal. There is no default account, and a builder never looks one up.
 */
export type ResolvedPostingAccounts = ReadonlyMap<string, string>;

export function postingAccountKey(role: PostingRole, scopeKey: string = UNSCOPED): string {
  return `${role}|${scopeKey}`;
}

/** The account for a role in a scope, or a refusal naming both. Fails closed. */
export function accountFor(accounts: ResolvedPostingAccounts, role: PostingRole, scopeKey: string = UNSCOPED): string {
  const id = accounts.get(postingAccountKey(role, scopeKey));
  if (id === undefined) {
    throw new PostingRuleError(
      `Account role ${role} is not mapped for ${scopeKey === UNSCOPED ? 'the tenant' : scopeKey}.`,
      'ROLE_UNMAPPED',
    );
  }
  return id;
}

/**
 * The line a builder hands to postInTx. Field names match JournalLineInput so
 * the lines pass straight through; the builders never set a currency, and the
 * journal writes INR only until the foreign-amount pair lands (decision 17).
 */
export interface PostingLine {
  accountId: string;
  /** Signed paise, debit positive. */
  amountMinor: bigint;
  lineId?: string;
  partyId?: string;
  memo?: string;
}

/**
 * Idempotency keys for the source documents (contract D5). A document posts
 * once under its key; a second post with the same key returns the first entry.
 */
export const postingKeys = {
  invoiceIssue: (invoiceId: string) => `invoice:${invoiceId}:issue`,
  paymentTaken: (paymentId: string) => `payment:${paymentId}`,
  receiptAllocated: (receiptId: string) => `receipt:${receiptId}`,
  creditNote: (creditNoteId: string) => `credit_note:${creditNoteId}`,
  expenseReimbursed: (claimId: string) => `expense_claim:${claimId}:reimburse`,
  /** One accrual per run and ledger entity (FX-73): the run posts once per entity, however many routes reach it. */
  payrollRunAccrual: (runId: string, entityId: string) => `payroll_run:${runId}:accrual:${entityId}`,
} as const;

/** Throws unless every amount is a bigint. A JavaScript number is a rounded float; money is bigint (CLAUDE.md rule 1). */
export function requireBigints(values: Record<string, unknown>): void {
  for (const [label, value] of Object.entries(values)) {
    if (typeof value !== 'bigint') {
      throw new TypeError(`${label} must be bigint paise; a JavaScript number is refused`);
    }
  }
}

/** Throws unless the lines net to zero. A builder that cannot balance refuses rather than posting a one-sided entry. */
export function assertBalancedLines(lines: readonly PostingLine[], label: string): void {
  let total = 0n;
  for (const line of lines) total += line.amountMinor;
  if (total !== 0n) {
    throw new PostingRuleError(`${label} does not balance: out by ${total} paise.`, 'UNBALANCED_SOURCE');
  }
}

export interface InvoiceIssueSource {
  partyId: string;
  grandTotalMinor: bigint;
  /** One entry per invoice line: its taxable value and the business line it is earned under. */
  revenue: ReadonlyArray<{ lineId: string | null | undefined; taxableMinor: bigint }>;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  /** Signed: positive when the invoice total was rounded up to the rupee. */
  roundOffMinor: bigint;
}

/**
 * The entry an invoice posts when it is issued (accrual; contract D3). The
 * receivable is debited for the grand total and each piece of it is credited
 * to its own role: revenue per business line, then each tax, then round-off.
 *
 * Every component is a figure the invoice already stores, so nothing is split
 * here and nothing is rounded. The build refuses when the components do not
 * add to the grand total, because a split that quietly absorbed the gap would
 * hide the mismatch the books exist to show.
 *
 * An income line with no business line is refused, whatever its amount (O2).
 * A default "unassigned" line would hide revenue by line, which is the defect
 * the business-line registry exists to prevent.
 */
export function buildInvoiceIssueEntry(source: InvoiceIssueSource, accounts: ResolvedPostingAccounts): PostingLine[] {
  requireBigints({
    grandTotalMinor: source.grandTotalMinor,
    cgstMinor: source.cgstMinor,
    sgstMinor: source.sgstMinor,
    igstMinor: source.igstMinor,
    roundOffMinor: source.roundOffMinor,
  });
  if (source.revenue.length === 0) {
    throw new PostingRuleError('An invoice issue needs at least one revenue line.', 'UNBALANCED_SOURCE');
  }

  const revenue = source.revenue.map((line, index) => {
    requireBigints({ [`revenue[${index}].taxableMinor`]: line.taxableMinor });
    if (!line.lineId) {
      throw new PostingRuleError(
        `Revenue line ${index + 1} has no business line. An income line is refused without one (O2).`,
        'INCOME_LINE_WITHOUT_BUSINESS_LINE',
      );
    }
    return { lineId: line.lineId, taxableMinor: line.taxableMinor };
  });

  const taxable = revenue.reduce((sum, line) => sum + line.taxableMinor, 0n);
  const components = taxable + source.cgstMinor + source.sgstMinor + source.igstMinor + source.roundOffMinor;
  if (components !== source.grandTotalMinor) {
    throw new PostingRuleError(
      `Invoice components do not add to the grand total: out by ${source.grandTotalMinor - components} paise.`,
      'UNBALANCED_SOURCE',
    );
  }

  const lines: PostingLine[] = [
    {
      accountId: accountFor(accounts, 'TRADE_RECEIVABLE'),
      amountMinor: source.grandTotalMinor,
      partyId: source.partyId,
    },
  ];
  for (const line of revenue) {
    if (line.taxableMinor === 0n) continue;
    lines.push({
      accountId: accountFor(accounts, 'REVENUE', line.lineId),
      amountMinor: -line.taxableMinor,
      lineId: line.lineId,
    });
  }
  if (source.cgstMinor !== 0n)
    lines.push({ accountId: accountFor(accounts, 'OUTPUT_CGST'), amountMinor: -source.cgstMinor });
  if (source.sgstMinor !== 0n)
    lines.push({ accountId: accountFor(accounts, 'OUTPUT_SGST'), amountMinor: -source.sgstMinor });
  if (source.igstMinor !== 0n)
    lines.push({ accountId: accountFor(accounts, 'OUTPUT_IGST'), amountMinor: -source.igstMinor });
  if (source.roundOffMinor !== 0n)
    lines.push({ accountId: accountFor(accounts, 'ROUND_OFF'), amountMinor: -source.roundOffMinor });

  assertBalancedLines(lines, 'Invoice issue');
  return lines;
}

export interface ReceiptAllocationSource {
  partyId: string;
  /** Positive paise: the amount of the receipt applied to the receivable. */
  amountMinor: bigint;
  /** The payment mode, which is the scope of the BANK role (contract A4). */
  paymentMode: string;
}

/**
 * The entry a receipt posts when it is allocated to the receivable: the bank
 * for the payment mode is debited and the party's receivable is credited.
 */
export function buildReceiptAllocationEntry(
  source: ReceiptAllocationSource,
  accounts: ResolvedPostingAccounts,
): PostingLine[] {
  requireBigints({ amountMinor: source.amountMinor });
  if (source.amountMinor <= 0n) {
    throw new PostingRuleError('A receipt allocation must be a positive amount.', 'INVALID_AMOUNT');
  }
  const lines: PostingLine[] = [
    { accountId: accountFor(accounts, 'BANK', source.paymentMode), amountMinor: source.amountMinor },
    { accountId: accountFor(accounts, 'TRADE_RECEIVABLE'), amountMinor: -source.amountMinor, partyId: source.partyId },
  ];
  assertBalancedLines(lines, 'Receipt allocation');
  return lines;
}

/**
 * One business line's share of a run, for one ledger entity: the gross it bears
 * (Dr salary expense) and the employer contributions it bears (Dr employer
 * contributions expense). Both are positive paise, summed from the instructions.
 */
export interface PayrollAccrualLine {
  lineId: string;
  grossMinor: bigint;
  employerMinor: bigint;
}

/**
 * What one entity's share of a run owes, in paise. The payables are summed from
 * the stored instruction components: net pay, PF (employee, employer and EPS),
 * ESI (both shares), PT, LWF (both shares) and salary TDS.
 *
 * EDLI and admin charges are not in this source: the statutory lines do not store
 * them (compliance/payroll.ts computeInstruction), so they are not posted here.
 * Adding them is a statutory-lines change, not an accrual change.
 */
export interface PayrollAccrualSource {
  byLine: readonly PayrollAccrualLine[];
  netPayMinor: bigint;
  pfPayableMinor: bigint;
  esiPayableMinor: bigint;
  ptMinor: bigint;
  lwfPayableMinor: bigint;
  tdsMinor: bigint;
}

/**
 * The entry a run's liabilities post as, for one ledger entity (FX-73). Debits:
 * salary expense and employer contributions expense, each per business line, since
 * a ledger expense line must name its business line. Credits: each payable, once.
 * A zero amount is omitted, and so is its role: a run with no LWF in the month
 * needs no LWF account.
 *
 * Refuses an entry that does not balance. The caller checks each instruction's
 * residual first, so this is the backstop, not the first place a gap is named.
 */
export function buildPayrollAccrualEntry(
  source: PayrollAccrualSource,
  accounts: ResolvedPostingAccounts,
): PostingLine[] {
  requireBigints({
    netPayMinor: source.netPayMinor,
    pfPayableMinor: source.pfPayableMinor,
    esiPayableMinor: source.esiPayableMinor,
    ptMinor: source.ptMinor,
    lwfPayableMinor: source.lwfPayableMinor,
    tdsMinor: source.tdsMinor,
  });
  const lines: PostingLine[] = [];
  source.byLine.forEach((row, index) => {
    requireBigints({
      [`byLine[${index}].grossMinor`]: row.grossMinor,
      [`byLine[${index}].employerMinor`]: row.employerMinor,
    });
    if (row.grossMinor !== 0n) {
      lines.push({
        accountId: accountFor(accounts, 'PAYROLL_SALARY_EXPENSE'),
        amountMinor: row.grossMinor,
        lineId: row.lineId,
      });
    }
    if (row.employerMinor !== 0n) {
      lines.push({
        accountId: accountFor(accounts, 'PAYROLL_EMPLOYER_CONTRIB_EXPENSE'),
        amountMinor: row.employerMinor,
        lineId: row.lineId,
      });
    }
  });
  const payables: Array<[PostingRole, bigint]> = [
    ['PAYROLL_NET_PAY_PAYABLE', source.netPayMinor],
    ['PAYROLL_PF_PAYABLE', source.pfPayableMinor],
    ['PAYROLL_ESI_PAYABLE', source.esiPayableMinor],
    ['PAYROLL_PT_PAYABLE', source.ptMinor],
    ['PAYROLL_LWF_PAYABLE', source.lwfPayableMinor],
    ['PAYROLL_TDS_PAYABLE', source.tdsMinor],
  ];
  for (const [role, amount] of payables) {
    if (amount !== 0n) lines.push({ accountId: accountFor(accounts, role), amountMinor: -amount });
  }
  assertBalancedLines(lines, 'Payroll accrual');
  return lines;
}

/**
 * The posting roles an accrual needs, for the lines that are not zero. A run with
 * no LWF this month does not need the LWF role mapped; it is resolved only when a
 * line uses it.
 */
export function payrollAccrualRoles(source: PayrollAccrualSource): PostingRole[] {
  const roles: PostingRole[] = [];
  if (source.byLine.some((row) => row.grossMinor !== 0n)) roles.push('PAYROLL_SALARY_EXPENSE');
  if (source.byLine.some((row) => row.employerMinor !== 0n)) roles.push('PAYROLL_EMPLOYER_CONTRIB_EXPENSE');
  const payables: Array<[PostingRole, bigint]> = [
    ['PAYROLL_NET_PAY_PAYABLE', source.netPayMinor],
    ['PAYROLL_PF_PAYABLE', source.pfPayableMinor],
    ['PAYROLL_ESI_PAYABLE', source.esiPayableMinor],
    ['PAYROLL_PT_PAYABLE', source.ptMinor],
    ['PAYROLL_LWF_PAYABLE', source.lwfPayableMinor],
    ['PAYROLL_TDS_PAYABLE', source.tdsMinor],
  ];
  for (const [role, amount] of payables) if (amount !== 0n) roles.push(role);
  return roles;
}
