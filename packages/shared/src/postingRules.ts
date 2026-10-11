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
