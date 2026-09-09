/**
 * Sorting Tally's ledger names into the platform's two ideas.
 *
 * Tally keeps bank accounts, expense heads, income heads, fixed assets and
 * director loan accounts in one flat namespace it calls "ledgers". Here a
 * *place money sits* and *what money was for* are different things — an
 * account and a category — so every name has to be put on one side or the
 * other.
 *
 * Shared between the extractor and the commit, because both need the same
 * answer and a classifier that disagreed with itself between preview and
 * commit would show one thing and do another.
 */

export type LedgerClass =
  | { kind: 'account'; accountType: 'bank' | 'cash' | 'card' }
  | { kind: 'category'; categoryKind: string };

export function classifyLedger(name: string, chart?: Record<string, string>): LedgerClass {
  const n = name.toLowerCase().trim();

  // The company's own statements, where the workbook carried them. A ledger the
  // Profit & Loss calls an expense is an expense, whatever its name suggests.
  const stated = chart?.[n];
  if (stated) return { kind: 'category', categoryKind: stated };

  // Cost words win outright. "Bank Charges" is an expense that happens to
  // contain the word bank, and classifying it as a bank account creates a
  // phantom account that then appears in the cash position — a wrong number on
  // the founder's dashboard, arrived at from a plausible-looking rule.
  if (/charge|fee|commission|interest paid|expense|expenses/.test(n)) {
    return { kind: 'category', categoryKind: 'expense' };
  }

  // A real bank ledger in Tally carries the account number alongside the name.
  if (/\d{6,}/.test(n) && /bank|a\/c|account/.test(n)) return { kind: 'account', accountType: 'bank' };
  if (/\b(axis|hdfc|icici|sbi|kotak|indusind|yes bank|idfc|canara|union bank|bank of baroda)\b/.test(n)) {
    return { kind: 'account', accountType: 'bank' };
  }
  if (/\b(current account|savings account|bank account)\b/.test(n)) return { kind: 'account', accountType: 'bank' };
  // A cash box, however the bookkeeper named it: "Main Cash", "Petty Cash",
  // "Cash-in-Hand". Cost words were filtered above, so a bare `cash` here is
  // the box and not "Cash Discount".
  if (/^(main |petty |office |branch )?cash([- ]in[- ]hand)?$/.test(n) || /cash in hand/.test(n)) {
    return { kind: 'account', accountType: 'cash' };
  }
  if (/credit card|corporate card/.test(n)) return { kind: 'account', accountType: 'card' };

  if (/^capital\b|capital account|share capital|drawings/.test(n)) return { kind: 'category', categoryKind: 'equity' };
  if (/^income\b|^sales\b|revenue|fees received|receipts from/.test(n)) return { kind: 'category', categoryKind: 'income' };
  if (/duties & taxes|^gst|\btds\b|^tax\b/.test(n)) return { kind: 'category', categoryKind: 'tax' };
  if (/\bloan\b|borrowing|unsecured/.test(n)) return { kind: 'category', categoryKind: 'transfer' };
  if (/furniture|computer|air conditioner|cctv|interior|partition|equipment|fitting|vehicle|machinery/.test(n)) {
    return { kind: 'category', categoryKind: 'asset_purchase' };
  }
  // Tally's own spelling of "suspense" is inconsistent and both appear in real
  // exports. A suspense ledger is money in transit, not a cost — typically a
  // director paying for something personally and being squared up later.
  if (/suspence|suspense/.test(n)) return { kind: 'category', categoryKind: 'transfer' };

  // Costs named confidently rather than by default. This matters because a
  // statement-derived chart names groups, not members: the Profit & Loss says
  // "Salary & Wages 480,557" and the vouchers carry a ledger per person, so
  // without this every salary ledger fell through to the default below and
  // ₹4.8 lakh of payroll dropped out of the cost base.
  if (/salary|wages|payroll|\brent\b|electric|water charge|telephone|internet|conveyance|travel|stationary|stationery|maintenance|welfare|advertis|subscription|audit|consult|incorporat|installation|ceremony|domain|website|printing|registration/.test(n)) {
    return { kind: 'category', categoryKind: 'expense' };
  }
  if (/income$|\bincome\b/.test(n)) return { kind: 'category', categoryKind: 'income' };

  // Nothing matched. Deliberately distinguished from a confident `expense`,
  // because what a caller does with "I don't know" is not what it does with
  // "this is a cost".
  return { kind: 'category', categoryKind: 'unknown' };
}

export const isAccountName = (name: string, chart?: Record<string, string>): boolean =>
  classifyLedger(name, chart).kind === 'account';

/**
 * The division a cost belongs to, guessed from the account name.
 *
 * Kaizen runs three businesses inside one legal entity, and a consolidated
 * total hides which of them is paying for the others — so a transaction with
 * no division is a transaction that cannot answer the founder's actual
 * question. Guessed here, editable afterwards, never silently left null.
 */
export function divisionFor(name: string): string {
  const n = name.toLowerCase();
  if (/software|developer|website|domain|hosting|server|cyber/.test(n)) return 'software';
  if (/skill|internship|training|trainer|short term/.test(n)) return 'skill';
  if (/education|admission|student|instructor|academic|course/.test(n)) return 'education';
  return 'shared';
}

/**
 * The account a non-cash journal is recorded against.
 *
 * A journal between two non-cash ledgers — a director paying a supplier
 * personally, a depreciation entry — still has to land on an account, because
 * a transaction without one cannot be listed or reconciled. It lands here, on
 * an account whose type is deliberately neither `bank` nor `cash` so that the
 * cash position and the runway never count it. Money that is not in a bank
 * account is not cash, and a dashboard that says otherwise is worse than one
 * that says nothing.
 */
export const JOURNAL_ACCOUNT_NAME = 'Journal (non-cash)';
export const JOURNAL_ACCOUNT_TYPE = 'journal';
