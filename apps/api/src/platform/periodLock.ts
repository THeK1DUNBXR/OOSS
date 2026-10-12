/**
 * The period lock for a legacy cashbook write (Wave 5 PR1, FX-70).
 *
 * A legacy `Transaction` used to be checked against its month's status outside
 * any transaction, and inserted later. A close could move the month between the
 * check and the insert. The write then landed in a closed period and was missing
 * from its snapshot. This takes the period row in the same transaction as the
 * insert, before the insert. FOR SHARE, so writes share the row. The close's
 * request (an UPDATE, whose row lock conflicts with FOR SHARE) and its close
 * (FOR UPDATE) both wait for every write that holds the row, and a write that
 * starts after the close has the lock sees the status.
 *
 * Lock order on every path that writes a legacy row:
 *   1. the accounting period rows (this file). A caller that writes more than one
 *      month takes all of them first, in ascending month order (lockLegacyPeriods);
 *   2. the record sequence row (nextRecordCode);
 *   3. the Transaction and ledger rows;
 *   4. the audit and event advisory locks (auditWrite, emit), last.
 * The close takes 1, then 4, and no other lock. No close path takes a source row
 * (invoice, refund), so a caller may take its source row before 1, as payRefund
 * does, without a cycle.
 *
 * Why several months are taken up front: a row taken after the audit lock is the
 * cycle. An import chunk that has written its first month holds the audit lock while
 * it asks for the second month's row. A close of that second month holds the row
 * and asks for the audit lock. Each waits for the other, and Postgres aborts one
 * (40P01). Taking every row before the first write, in one order, keeps the period
 * rows ahead of the audit lock on every path.
 *
 * A month with no period row gets one here, in this transaction. Without it, a
 * write into a fresh month would take no lock at all, and a close requested later
 * would snapshot without it.
 */

import { EVENTS, financialYearOf, istMonthKey } from '@kaizen/shared';
import { type DbTx } from './db.js';
import { auditWrite } from './audit.js';
import { emit } from './eventBus.js';
import { ApiError } from './errors.js';
import { POSTABLE_PERIOD_STATUSES } from './ledger.js';

/** A period row the transaction holds FOR SHARE. `created` says this call made the row. */
interface HeldPeriod {
  id: string;
  status: string;
  period: string;
  fy: string;
  created: boolean;
}

/**
 * Takes the IST month's period row FOR SHARE in `tx`, creating the row first if the
 * month has none. It takes no audit or event lock and refuses nothing: the caller
 * decides what the status allows, and writes the creation's audit row only after
 * every period row it needs is held (auditOpenedPeriods).
 */
async function holdPeriodRow(tx: DbTx, tenantId: string, date: Date): Promise<HeldPeriod> {
  const period = istMonthKey(date);
  const fy = financialYearOf(date);
  const created = await tx.accountingPeriod.createMany({
    data: [{ tenantId, period, fy, status: 'open' }],
    skipDuplicates: true,
  });
  const [row] = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status" FROM "cmp_accounting_periods"
    WHERE "tenantId" = ${tenantId} AND "period" = ${period}
    FOR SHARE`;
  if (!row) throw ApiError.unprocessable(`No accounting period is open for ${period}.`);
  return { id: row.id, status: row.status, period, fy, created: created.count > 0 };
}

/** The audit and event rows for periods this call created. They take the advisory locks, so they come after every period row. */
async function auditOpenedPeriods(tx: DbTx, held: HeldPeriod[]): Promise<void> {
  for (const h of held) {
    if (!h.created) continue;
    await auditWrite({
      action: 'create',
      subjectType: 'accounting_period',
      subjectId: h.id,
      after: { period: h.period, status: 'open' },
      tx,
    });
    await emit({
      name: EVENTS.ACCOUNTING_PERIOD_OPENED,
      subject: { entityType: 'accounting_period', entityId: h.id },
      newState: { period: h.period, status: 'open' },
      impact: { domains: ['fin'] },
      confidentiality: 'confidential',
      tx,
    });
  }
}

/**
 * Takes the IST month's period row FOR SHARE and refuses unless the month is
 * postable. Call it before the first write in the transaction. Returns the
 * period's id.
 */
export async function lockLegacyPeriod(tx: DbTx, tenantId: string, date: Date): Promise<string> {
  const held = await holdPeriodRow(tx, tenantId, date);
  await auditOpenedPeriods(tx, [held]);

  if (!POSTABLE_PERIOD_STATUSES.includes(held.status)) {
    throw ApiError.unprocessable(
      held.status === 'closing'
        ? `${held.period} is a closing accounting period: its close has been requested and not yet approved. It takes no entries until the close completes.`
        : `${held.period} is a ${held.status} accounting period. It takes no entries.`,
      { period: held.period, status: held.status, reasonCode: 'accounting_period_closed' },
    );
  }
  return held.id;
}

/**
 * Takes the period rows for every IST month in `dates` FOR SHARE, in ascending month
 * order, before the caller's first write. It refuses nothing: a month that is closing
 * or closed is refused by the write that lands in it (lockLegacyPeriod), so a caller
 * keeps its per-row refusals. A row the transaction already holds is taken again as a
 * no-op.
 *
 * The caller passes only dates it will write into. A date it will not write creates a
 * period row here, and a creation is audited.
 */
export async function lockLegacyPeriods(tx: DbTx, tenantId: string, dates: readonly Date[]): Promise<void> {
  const firstDateOf = new Map<string, Date>();
  for (const date of dates) {
    const month = istMonthKey(date);
    if (!firstDateOf.has(month)) firstDateOf.set(month, date);
  }

  const held: HeldPeriod[] = [];
  for (const month of [...firstDateOf.keys()].sort()) {
    const date = firstDateOf.get(month);
    if (date) held.push(await holdPeriodRow(tx, tenantId, date));
  }
  await auditOpenedPeriods(tx, held);
}
