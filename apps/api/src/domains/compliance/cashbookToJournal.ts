/**
 * The legacy cashbook into the journal (ORDERED-PLAN 1.5; CLAUDE.md rules 1, 2 and 5).
 *
 * Two steps, kept apart so the mapping can be read and signed off before anything is posted:
 *
 *   mapVouchers  Pure. Vouchers and a mapping table in, entry drafts out. It refuses rather than
 *                guesses: a ledger group with no mapping, a P&L leg with no business line, a bad
 *                date or amount, and a voucher whose legs do not net to zero are each reported
 *                with a reason and produce no draft. Nothing is forced to balance, and no leg is
 *                routed to a suspense account to make a voucher fit.
 *
 *   applyDrafts  Posts the drafts through post() and nothing else (rule 2). It reads the keys
 *                already in the tenant first, so a re-run posts nothing new and the report can say
 *                which vouchers were already there.
 *
 * One idempotency key per voucher, `legacy:<voucher id>`. The source type is `import`, the
 * existing member of JOURNAL_SOURCE_TYPES for data brought in from outside the ledger; the 1.5
 * spec's `migration` is not in that vocabulary and adding it is a separate change.
 *
 * This module does not decide equivalence with the real books. The L2 harness does that, against
 * a fixture, and a pass on a synthetic fixture does not pass L2 (CI-GATES-DRAFT, L2).
 */

import { formatMinor, parseMinor } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { post } from '../../platform/ledger.js';
import { ApiError } from '../../platform/errors.js';

export const LEDGER_ACCOUNT_CLASSES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type LedgerAccountClass = (typeof LEDGER_ACCOUNT_CLASSES)[number];

/** One signed leg of a legacy voucher. `amount` is a rupee decimal string, debit positive. */
export interface CashbookLeg {
  ledgerGroup: string;
  amount: string;
}

/** A legacy cashbook voucher. `date` is the IST civil day, YYYY-MM-DD. */
export interface CashbookVoucher {
  id: string;
  date: string;
  narration: string;
  legs: CashbookLeg[];
}

/** One row of the reviewed mapping table: a legacy ledger group to a journal account. */
export interface MappingRow {
  ledgerGroup: string;
  accountClass: LedgerAccountClass;
  accountName: string;
  /** Required on income and expense rows (post() refuses those lines without one). */
  lineCode?: string;
}

export type MappingTable = ReadonlyMap<string, MappingRow>;

export interface DraftLine {
  ledgerGroup: string;
  accountName: string;
  accountClass: LedgerAccountClass;
  lineCode?: string;
  amountMinor: bigint;
}

export interface EntryDraft {
  voucherId: string;
  idempotencyKey: string;
  entryDate: Date;
  narration: string;
  lines: DraftLine[];
}

export type RefusalReason = 'invalid' | 'unbalanced' | 'unmapped_group' | 'pl_without_business_line';

export interface Refusal {
  voucherId: string;
  reason: RefusalReason;
  detail: string;
}

export interface MapReport {
  drafts: EntryDraft[];
  refused: Refusal[];
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads the reviewed mapping CSV: `ledgerGroup,accountClass,accountName,lineCode`, with a header
 * row. A row with a class outside the five canonical classes, a blank name, or an income/expense
 * class with no line code is reported in `problems` and left out of the table, so any voucher on
 * that group is then refused as unmapped. It is never mapped to a default.
 */
export function parseMappingCsv(text: string): { table: Map<string, MappingRow>; problems: string[] } {
  const table = new Map<string, MappingRow>();
  const problems: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = lines[0];
  if (header !== 'ledgerGroup,accountClass,accountName,lineCode') {
    problems.push(`mapping header is not ledgerGroup,accountClass,accountName,lineCode: ${JSON.stringify(header)}`);
    return { table, problems };
  }
  for (const [index, line] of lines.slice(1).entries()) {
    const at = `mapping line ${index + 2}`;
    const [ledgerGroup = '', accountClass = '', accountName = '', lineCode = ''] = line.split(',').map((c) => c.trim());
    if (!ledgerGroup) {
      problems.push(`${at}: no ledgerGroup`);
      continue;
    }
    if (table.has(ledgerGroup)) {
      problems.push(`${at}: ledgerGroup ${ledgerGroup} is mapped twice`);
      continue;
    }
    if (!(LEDGER_ACCOUNT_CLASSES as readonly string[]).includes(accountClass)) {
      problems.push(
        `${at}: accountClass ${JSON.stringify(accountClass)} is not one of ${LEDGER_ACCOUNT_CLASSES.join('|')}`,
      );
      continue;
    }
    if (!accountName) {
      problems.push(`${at}: no accountName`);
      continue;
    }
    const cls = accountClass as LedgerAccountClass;
    if ((cls === 'income' || cls === 'expense') && !lineCode) {
      problems.push(`${at}: ${cls} account ${accountName} has no lineCode`);
      continue;
    }
    table.set(ledgerGroup, {
      ledgerGroup,
      accountClass: cls,
      accountName,
      ...(lineCode ? { lineCode } : {}),
    });
  }
  return { table, problems };
}

/**
 * Maps vouchers to entry drafts. Pure: no database, no clock. A voucher produces either one draft,
 * with every leg mapped and the legs netting to zero, or one refusal.
 */
export function mapVouchers(vouchers: readonly CashbookVoucher[], table: MappingTable): MapReport {
  const drafts: EntryDraft[] = [];
  const refused: Refusal[] = [];

  for (const voucher of vouchers) {
    const refuse = (reason: RefusalReason, detail: string) => refused.push({ voucherId: voucher.id, reason, detail });

    // Round trip, not a parse: V8 rolls 2025-02-30 over to 2 March rather than refusing it, and a typo
    // in an export must not post on a different day or in a different period.
    const parsed = DATE_KEY.test(voucher.date) ? new Date(`${voucher.date}T00:00:00.000Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== voucher.date) {
      refuse('invalid', `date ${JSON.stringify(voucher.date)} is not a YYYY-MM-DD IST day`);
      continue;
    }
    if (voucher.legs.length < 2) {
      refuse('invalid', `a voucher needs at least two legs, it has ${voucher.legs.length}`);
      continue;
    }

    let amounts: bigint[];
    try {
      amounts = voucher.legs.map((leg) => parseMinor(leg.amount));
    } catch (err) {
      refuse('invalid', err instanceof Error ? err.message : 'an amount did not parse');
      continue;
    }

    // Balance is checked on the legacy legs, before mapping, so an unbalanced voucher is reported
    // as unbalanced even when its groups are also unmapped. Its size is the whole point of the report.
    const net = amounts.reduce((sum, amount) => sum + amount, 0n);
    if (net !== 0n) {
      refuse('unbalanced', `legs net to ${formatMinor(net)} and must net to zero`);
      continue;
    }

    const unmapped = voucher.legs.filter((leg) => !table.has(leg.ledgerGroup)).map((leg) => leg.ledgerGroup);
    if (unmapped.length > 0) {
      refuse('unmapped_group', `no mapping for ledger group ${[...new Set(unmapped)].join(', ')}`);
      continue;
    }

    const lines: DraftLine[] = [];
    let plWithoutLine: string | undefined;
    for (const [index, leg] of voucher.legs.entries()) {
      const row = table.get(leg.ledgerGroup)!;
      if ((row.accountClass === 'income' || row.accountClass === 'expense') && !row.lineCode) {
        plWithoutLine ??= leg.ledgerGroup;
      }
      lines.push({
        ledgerGroup: leg.ledgerGroup,
        accountName: row.accountName,
        accountClass: row.accountClass,
        ...(row.lineCode ? { lineCode: row.lineCode } : {}),
        amountMinor: amounts[index]!,
      });
    }
    if (plWithoutLine !== undefined) {
      refuse('pl_without_business_line', `income or expense group ${plWithoutLine} has no business line`);
      continue;
    }

    drafts.push({
      voucherId: voucher.id,
      idempotencyKey: `legacy:${voucher.id}`,
      entryDate: new Date(`${voucher.date}T00:00:00.000Z`),
      narration: voucher.narration,
      lines,
    });
  }

  return { drafts, refused };
}

export interface ApplyContext {
  entityId: string;
  /** Journal account id by accountName, resolved in the tenant before the call. */
  accountIdByName: ReadonlyMap<string, string>;
  /** Business line id by lineCode, resolved in the tenant before the call. */
  lineIdByCode: ReadonlyMap<string, string>;
}

export interface ApplyReport {
  posted: string[];
  alreadyPosted: string[];
  refused: Array<{ voucherId: string; message: string }>;
}

/**
 * Posts drafts through post(). Runs as the caller's principal, which post() checks (rule 5).
 * Business refusals (an unbalanced voucher, a closed period, a line outside the registry) are
 * recorded per voucher and the run carries on. Anything else is a fault and is thrown.
 */
export async function applyDrafts(drafts: readonly EntryDraft[], ctx: ApplyContext): Promise<ApplyReport> {
  const auth = currentAuth();
  const report: ApplyReport = { posted: [], alreadyPosted: [], refused: [] };
  if (drafts.length === 0) return report;

  const existing = await prisma.journalEntry.findMany({
    where: { tenantId: auth.tenantId, idempotencyKey: { in: drafts.map((d) => d.idempotencyKey) } },
    select: { idempotencyKey: true },
  });
  const present = new Set(existing.map((row) => row.idempotencyKey));

  for (const draft of drafts) {
    if (present.has(draft.idempotencyKey)) {
      report.alreadyPosted.push(draft.voucherId);
      continue;
    }
    const missing = draft.lines.find(
      (line) =>
        !ctx.accountIdByName.has(line.accountName) ||
        (line.lineCode !== undefined && !ctx.lineIdByCode.has(line.lineCode)),
    );
    if (missing) {
      report.refused.push({
        voucherId: draft.voucherId,
        message: `account ${missing.accountName} or line ${missing.lineCode ?? '-'} is not provisioned`,
      });
      continue;
    }
    try {
      await post({
        entityId: ctx.entityId,
        entryDate: draft.entryDate,
        narration: draft.narration,
        sourceType: 'import',
        sourceId: draft.voucherId,
        idempotencyKey: draft.idempotencyKey,
        lines: draft.lines.map((line) => ({
          accountId: ctx.accountIdByName.get(line.accountName)!,
          amountMinor: line.amountMinor,
          ...(line.lineCode ? { lineId: ctx.lineIdByCode.get(line.lineCode)! } : {}),
        })),
      });
      report.posted.push(draft.voucherId);
    } catch (err) {
      if (err instanceof ApiError) {
        report.refused.push({ voucherId: draft.voucherId, message: err.message });
        continue;
      }
      throw err;
    }
  }
  return report;
}
