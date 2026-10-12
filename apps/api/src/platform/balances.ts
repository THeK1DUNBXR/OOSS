/**
 * Journal trial balance and the account balance drift check (ORDERED-PLAN Wave
 * 3, item 1.4).
 *
 * Reads only. The journal is written by post() alone (CLAUDE.md rule 2). The
 * one write here is the account_balance_snapshots cache, which is insert-only
 * for the application role: a row is derived from journal_lines and is never
 * the source of a balance.
 */

import { istCivilDay, istDateKey } from '@kaizen/shared';
import { prisma, type DbTx } from './db.js';
import { currentAuth } from './context.js';
import { raiseException } from './exceptions.js';

/** An entry dated after any real posting; the trial balance is for every entry in the tenant. */
const ALL_TIME = new Date('9999-12-31T00:00:00.000Z');

const LIVE_STATUSES = ['posted', 'reversed'];

export const DRIFT_BALANCE_CODE = 'EX-LED-001';
export const DRIFT_TRIAL_BALANCE_CODE = 'EX-LED-002';

export interface JournalTrialBalance {
  /** The IST civil date the figures are as of, YYYY-MM-DD. */
  asOf: string;
  /** Sum of the positive lines, in paise. */
  debitsMinor: bigint;
  /** Sum of the negative lines with the sign removed, in paise. */
  creditsMinor: bigint;
  lineCount: number;
}

/**
 * Debits and credits of every line dated on or before the IST day of `asOf`.
 * Each entry nets to zero at commit (the deferred trigger in ledger_invariants
 * and journal_entry_lines_check), so the two sides are equal by construction:
 * this function is the evidence the tenant's books say so.
 */
export async function journalTrialBalance(asOf: Date, tx?: DbTx): Promise<JournalTrialBalance> {
  // A caller inside an interactive transaction passes its `tx`: the scoped client
  // throws there (platform/db.ts refuseOuterClientInTransaction). The close takes its
  // snapshot this way, under the period lock.
  const db = tx ?? (prisma as unknown as DbTx);
  const auth = currentAuth();
  const entry = { entryDate: { lte: istCivilDay(asOf) }, status: { in: LIVE_STATUSES } };
  const [debits, credits, lineCount] = await Promise.all([
    db.journalLine.aggregate({
      where: { tenantId: auth.tenantId, entry, amountMinor: { gt: 0n } },
      _sum: { amountMinor: true },
    }),
    db.journalLine.aggregate({
      where: { tenantId: auth.tenantId, entry, amountMinor: { lt: 0n } },
      _sum: { amountMinor: true },
    }),
    db.journalLine.count({ where: { tenantId: auth.tenantId, entry } }),
  ]);
  return {
    asOf: istDateKey(asOf),
    debitsMinor: debits._sum.amountMinor ?? 0n,
    creditsMinor: -(credits._sum.amountMinor ?? 0n),
    lineCount,
  };
}

/** Throws when the figures do not balance. Tests use it after every posting; the nightly check raises instead. */
export function assertTrialBalance(tb: JournalTrialBalance): void {
  if (tb.debitsMinor !== tb.creditsMinor) {
    throw new Error(
      `trial balance as of ${tb.asOf} does not balance: debits ${tb.debitsMinor} and credits ${tb.creditsMinor} paise`,
    );
  }
}

/** The last IST day of an YYYY-MM period, as the UTC midnight the journal stores it. */
function periodEnd(period: string): Date {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year!, month!, 0));
}

export interface BalanceDriftReport {
  /** Accounts compared or rebuilt. */
  processed: number;
  /** Snapshot rows created where none was current. */
  rebuilt: number;
  /** Snapshot rows that matched the journal. */
  matched: number;
  /** Snapshot rows that disagreed with the journal; each one raised an exception. */
  drifted: number;
  trialBalanceOk: boolean;
}

/**
 * The nightly check. For every closed period it sums the journal per account as
 * of the period's last day and compares that with the current snapshot row.
 *
 * A row is trusted only if it was derived after the period's latest close: a
 * period reopened and closed again has a new close instant, so its old row
 * describes a balance the period no longer has, and a new version is inserted
 * in its place. A missing or stale row is rebuilt, because the cache is by
 * definition rebuildable from the lines. A row that disagrees with a current
 * one raises EX-LED-001 and is left as it is: correcting it would hide the
 * change that made it disagree.
 *
 * Idempotent. A rerun with nothing changed inserts nothing, and the exception
 * for a standing disagreement is the one already open (raiseException's
 * fingerprint and open-record guard).
 */
export async function checkAccountBalanceSnapshots(now: Date, signal?: AbortSignal): Promise<BalanceDriftReport> {
  const auth = currentAuth();
  const report: BalanceDriftReport = { processed: 0, rebuilt: 0, matched: 0, drifted: 0, trialBalanceOk: true };

  const tb = await journalTrialBalance(ALL_TIME);
  if (tb.debitsMinor !== tb.creditsMinor) {
    report.trialBalanceOk = false;
    await raiseException({
      code: DRIFT_TRIAL_BALANCE_CODE,
      label: 'Journal trial balance does not balance',
      severity: 'S1_ATTENTION',
      subjectType: 'journal_trial_balance',
      subjectId: auth.tenantId,
      domain: 'fin',
      detail: `Debits ${tb.debitsMinor} and credits ${tb.creditsMinor} paise differ across the tenant's journal. Posting cannot have produced this: investigate before any period is closed.`,
      triggerFingerprint: `trial_balance:${tb.lineCount}`,
      ladderRung: 0,
    });
  }

  const accounts = await prisma.ledgerAccount.findMany({
    where: { tenantId: auth.tenantId },
    select: { id: true, name: true },
  });
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));

  const periods = await prisma.accountingPeriod.findMany({
    where: { tenantId: auth.tenantId, status: 'closed' },
    select: { id: true, period: true, closedAt: true },
    orderBy: { period: 'asc' },
  });

  for (const p of periods) {
    if (signal?.aborted) throw new Error('balance drift check stopped: the attempt was aborted');
    const asOf = periodEnd(p.period);
    const closedAt = p.closedAt ?? new Date(0);

    const derived = await prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { tenantId: auth.tenantId, entry: { entryDate: { lte: asOf }, status: { in: LIVE_STATUSES } } },
      _sum: { amountMinor: true },
    });
    const expectedByAccount = new Map(derived.map((d) => [d.accountId, d._sum.amountMinor ?? 0n]));

    const rows = await prisma.accountBalanceSnapshot.findMany({
      where: { tenantId: auth.tenantId, periodId: p.id },
      orderBy: { version: 'desc' },
    });
    const latestByAccount = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!latestByAccount.has(row.accountId)) latestByAccount.set(row.accountId, row);

    // An account with a row but no line on or before the period end still has
    // to match: its expected balance is zero, so a row that says otherwise is drift.
    const accountIds = new Set([...expectedByAccount.keys(), ...latestByAccount.keys()]);
    for (const accountId of accountIds) {
      const expected = expectedByAccount.get(accountId) ?? 0n;
      const row = latestByAccount.get(accountId);
      report.processed++;

      if (row && row.derivedAt >= closedAt) {
        if (row.balanceMinor === expected) {
          report.matched++;
          continue;
        }
        report.drifted++;
        await raiseException({
          code: DRIFT_BALANCE_CODE,
          label: 'Account balance drift',
          severity: 'S1_ATTENTION',
          subjectType: 'ledger_account',
          subjectId: accountId,
          subjectLabel: nameOf.get(accountId) ?? null,
          domain: 'fin',
          detail: `Period ${p.period}: expected ${expected} paise from the journal; the snapshot (version ${row.version}) holds actual ${row.balanceMinor} paise. Not corrected: find the change that moved the journal or the row.`,
          triggerFingerprint: `balance_drift:${p.id}:${accountId}:${row.version}`,
          ladderRung: 0,
        });
        continue;
      }

      // A rebuild for an account with no line by the period end would store a zero
      // row for nothing; only accounts the journal knows about are cached.
      if (!expectedByAccount.has(accountId)) continue;
      await prisma.accountBalanceSnapshot.create({
        data: {
          tenantId: auth.tenantId,
          accountId,
          periodId: p.id,
          version: (row?.version ?? 0) + 1,
          asOf,
          balanceMinor: expected,
          derivedAt: now,
        },
      });
      report.rebuilt++;
    }
  }

  return report;
}
