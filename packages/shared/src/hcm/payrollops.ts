/**
 * HCM — payrollops (docs/hcm/payrollops.md, workstream WS8).
 *
 * Pure, database-free logic for the three arithmetic questions payroll
 * operations asks every cycle: does this journal balance, what does the bank
 * file look like, and does this run's numbers move the way a run should move
 * from the last one. Each is checked without touching a row.
 */

export const HCM_PAYROLLOPS_MODULE = 'payrollops' as const;

export const PAY_ITEM_KINDS = ['earning', 'deduction', 'reimbursement', 'employer_contribution'] as const;
export type PayItemKind = (typeof PAY_ITEM_KINDS)[number];

export const ADHOC_PAY_STATES = ['Proposed', 'Approved', 'Rejected', 'Applied'] as const;
export type AdHocPayState = (typeof ADHOC_PAY_STATES)[number];

export const ARREAR_STATES = ['Proposed', 'Approved', 'Rejected', 'Paid'] as const;
export type ArrearState = (typeof ARREAR_STATES)[number];

export const PAYROLL_QUERY_STATES = ['Open', 'Responded', 'Closed'] as const;
export type PayrollQueryState = (typeof PAYROLL_QUERY_STATES)[number];

/** Rounds to paise the same way the rest of the platform's money arithmetic does. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Journal — a division's gross/net split, turned into a balanced double entry.
// ---------------------------------------------------------------------------

export interface DivisionPayCost {
  division: string;
  gross: number;
  net: number;
}

export interface JournalLine {
  ledgerAccountCode: string;
  label: string;
  costCentre: string;
  debit: number;
  credit: number;
}

/** The two ledger codes this workstream posts to when no `PayItem` breakdown overrides them. */
export const DEFAULT_PAYROLL_GL_CODES = {
  salariesExpense: '6010-SALARIES',
  salariesPayable: '2410-SALARIES-PAYABLE',
  deductionsPayable: '2420-STATUTORY-DEDUCTIONS-PAYABLE',
} as const;

/**
 * One journal per division per run: debit the division's gross as expense,
 * credit its net as a payable to employees, and — when gross exceeds net —
 * credit the difference as a payable to whoever the deduction is ultimately
 * owed (PF/ESI/PT/TDS et al, netted into one payable line here since the
 * per-authority split is workstream E's rate-table concern, not this one's).
 * A division with gross equal to net (no deductions) produces two lines, not
 * three — a zero-amount line would be noise, not information.
 */
export function buildPayrollJournalLines(rows: DivisionPayCost[]): JournalLine[] {
  const lines: JournalLine[] = [];
  for (const row of rows) {
    const gross = round2(row.gross);
    const net = round2(row.net);
    const deductions = round2(gross - net);
    if (gross <= 0) continue;
    lines.push({
      ledgerAccountCode: DEFAULT_PAYROLL_GL_CODES.salariesExpense,
      label: `Salaries & wages — ${row.division}`,
      costCentre: row.division,
      debit: gross,
      credit: 0,
    });
    lines.push({
      ledgerAccountCode: DEFAULT_PAYROLL_GL_CODES.salariesPayable,
      label: `Net pay payable — ${row.division}`,
      costCentre: row.division,
      debit: 0,
      credit: net,
    });
    if (deductions > 0) {
      lines.push({
        ledgerAccountCode: DEFAULT_PAYROLL_GL_CODES.deductionsPayable,
        label: `Statutory & other deductions payable — ${row.division}`,
        costCentre: row.division,
        debit: 0,
        credit: deductions,
      });
    }
  }
  return lines;
}

export interface JournalTotals {
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

/** Debits must equal credits — the one invariant a journal cannot post without. */
export function journalTotals(lines: JournalLine[]): JournalTotals {
  const totalDebit = round2(lines.reduce((sum, l) => sum + l.debit, 0));
  const totalCredit = round2(lines.reduce((sum, l) => sum + l.credit, 0));
  return { totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
}

// ---------------------------------------------------------------------------
// Bank advice — the NEFT file a run's net pay becomes.
// ---------------------------------------------------------------------------

export interface NeftBeneficiary {
  employeeName: string;
  accountNumber: string;
  ifsc: string;
  amount: number;
  reference: string;
}

const NEFT_HEADER = ['Beneficiary Name', 'Account Number', 'IFSC', 'Amount', 'Reference'];

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC-4180 with CRLF endings — the same convention `compliance/labour.ts`'s registers use, since a bank's own tools expect it. */
export function neftAdviceCsv(rows: NeftBeneficiary[]): string {
  const lines = [NEFT_HEADER.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [csvCell(r.employeeName), csvCell(r.accountNumber), csvCell(r.ifsc), csvCell(round2(r.amount)), csvCell(r.reference)]
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

export function neftAdviceTotal(rows: NeftBeneficiary[]): number {
  return round2(rows.reduce((sum, r) => sum + r.amount, 0));
}

// ---------------------------------------------------------------------------
// Reconciliation — per-employee delta between two runs.
// ---------------------------------------------------------------------------

export interface EmployeeNet {
  employmentRelationshipId: string;
  net: number;
}

export interface ReconciliationDelta {
  employmentRelationshipId: string;
  previousNet: number | null;
  currentNet: number | null;
  delta: number;
  deltaPct: number | null;
  /** True when the swing has no obvious explanation (not a plain joiner or leaver). */
  unexplained: boolean;
  note: string;
}

/**
 * Compares two runs' net pay per employee. A joiner (absent in the previous
 * run) or a leaver (absent in the current one) is flagged with a plain note
 * and never marked `unexplained` — an employee's first or last payslip is
 * expected to look like a full swing. Anyone present in both runs whose net
 * moved by more than `thresholdPct` is `unexplained`: real, but the kind of
 * thing a run should not disburse without someone having looked at it.
 */
export function reconciliationDiff(
  previous: EmployeeNet[],
  current: EmployeeNet[],
  thresholdPct = 20,
): ReconciliationDelta[] {
  const prevMap = new Map(previous.map((p) => [p.employmentRelationshipId, p.net]));
  const currMap = new Map(current.map((c) => [c.employmentRelationshipId, c.net]));
  const ids = new Set([...prevMap.keys(), ...currMap.keys()]);

  const out: ReconciliationDelta[] = [];
  for (const id of ids) {
    const prevNet = prevMap.has(id) ? prevMap.get(id)! : null;
    const currNet = currMap.has(id) ? currMap.get(id)! : null;

    if (prevNet === null && currNet !== null) {
      out.push({ employmentRelationshipId: id, previousNet: null, currentNet: currNet, delta: round2(currNet), deltaPct: null, unexplained: false, note: 'New in this run (joiner or first pay).' });
      continue;
    }
    if (prevNet !== null && currNet === null) {
      out.push({ employmentRelationshipId: id, previousNet: prevNet, currentNet: null, delta: round2(-prevNet), deltaPct: null, unexplained: false, note: 'Absent from this run (leaver or excluded).' });
      continue;
    }

    const p = prevNet ?? 0;
    const c = currNet ?? 0;
    const delta = round2(c - p);
    const deltaPct = p !== 0 ? round2((delta / p) * 100) : c !== 0 ? 100 : 0;
    const unexplained = Math.abs(deltaPct) > thresholdPct;
    out.push({
      employmentRelationshipId: id,
      previousNet: p,
      currentNet: c,
      delta,
      deltaPct,
      unexplained,
      note: unexplained ? `Net pay moved ${deltaPct > 0 ? 'up' : 'down'} ${Math.abs(deltaPct)}% — beyond the ${thresholdPct}% check.` : 'Within the usual range.',
    });
  }
  return out.sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0));
}

export function unexplainedCount(deltas: ReconciliationDelta[]): number {
  return deltas.filter((d) => d.unexplained).length;
}

// ---------------------------------------------------------------------------
// Calendar — which milestone a period is at, relative to now.
// ---------------------------------------------------------------------------

export interface PayrollCalendarDates {
  attendanceLockAt: Date | string;
  inputFreezeAt: Date | string;
  runByAt: Date | string;
  approveByAt: Date | string;
  payDate: Date | string;
}

export type PayrollCalendarMilestone =
  | 'before_attendance_lock'
  | 'attendance_locked'
  | 'input_frozen'
  | 'run_due'
  | 'approval_due'
  | 'ready_to_pay'
  | 'past_pay_date';

/** Which stage a period's calendar is at right now — what the ops screen highlights without the viewer doing date arithmetic. */
export function payrollCalendarMilestone(calendar: PayrollCalendarDates, now: Date): PayrollCalendarMilestone {
  const t = now.getTime();
  const at = (d: Date | string) => new Date(d).getTime();
  const payDay = at(calendar.payDate);
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (t < at(calendar.attendanceLockAt)) return 'before_attendance_lock';
  if (t < at(calendar.inputFreezeAt)) return 'attendance_locked';
  if (t < at(calendar.runByAt)) return 'input_frozen';
  if (t < at(calendar.approveByAt)) return 'run_due';
  if (t < payDay) return 'approval_due';
  if (t < payDay + oneDayMs) return 'ready_to_pay';
  return 'past_pay_date';
}
