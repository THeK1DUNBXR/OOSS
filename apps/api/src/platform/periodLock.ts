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
 *   0. the tenant's period-row advisory lock (lockPeriodRows), taken only by a path
 *      that is about to create a period row, and by a close or reopen, always before
 *      any period row lock in the transaction;
 *   1. the accounting period rows (this file). A caller that writes more than one
 *      month takes all of them first, in ascending month order (lockLegacyPeriods);
 *   2. the record sequence row (nextRecordCode);
 *   3. the Transaction and ledger rows;
 *   4. the audit and event advisory locks (auditWrite, emit), last.
 * The close takes 0, 1, then 4, and no other lock. No close path takes a source row
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

/**
 * A period row the transaction holds FOR SHARE. `created` says this call made the row.
 * `id` is null for a month with no row under a closed later month: it is closed by the
 * order rule, and no row is made for it (holdPeriodRow).
 */
interface HeldPeriod {
  id: string | null;
  status: string;
  period: string;
  fy: string;
  created: boolean;
}

/**
 * The tenant's period-row advisory lock. A close and a reopen take it before their
 * period row locks, and a path that is about to create a period row takes it before
 * the insert.
 *
 * The race it closes: a creation inserts an uncommitted row, and under READ COMMITTED
 * a close's FOR UPDATE on the rows up to its month cannot see that row. Without this
 * lock, a write that creates February (no row yet) and a close of March can interleave.
 * The creation reads "no closed later month" while March is still open, March's close
 * locks the rows it can see and closes March, and the creation then commits February
 * open beneath a closed March. March's frozen snapshot would then be missing an open
 * month under it, which is the EX-LED-001 break the order rule exists to prevent. With
 * the lock the two serialise: the creation waits for the close to commit, then reads the
 * latest closed month again and refuses.
 *
 * Lock order is this lock first, then the period rows, everywhere. A transaction that
 * already holds a period row FOR SHARE must not take this lock after it: a close that
 * holds the lock and waits on that row, and a creation that holds the row and waits on
 * the lock, form a cycle Postgres breaks with 40P01. lockLegacyPeriods therefore takes
 * the lock before its first row whenever one of its months has no row yet.
 *
 * Keyed per tenant. Two tenants whose hashes collide queue behind each other; that is
 * slower, never unsafe.
 */
export async function lockPeriodRows(tx: DbTx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cmp_accounting_periods:' || ${tenantId}))`;
}

async function selectHeldRow(
  tx: DbTx,
  tenantId: string,
  period: string,
): Promise<{ id: string; status: string } | undefined> {
  const [row] = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status" FROM "cmp_accounting_periods"
    WHERE "tenantId" = ${tenantId} AND "period" = ${period}
    FOR SHARE`;
  return row;
}

/**
 * Takes the IST month's period row FOR SHARE in `tx`, creating the row first if the
 * month has none. It takes no audit or event lock and refuses nothing: the caller
 * decides what the status allows, and writes the creation's audit row only after
 * every period row it needs is held (auditOpenedPeriods).
 *
 * A row that exists is held without the advisory lock (lockPeriodRows): posting into an
 * open month does not queue behind a close of a later one. Only the creation path takes
 * it, and it looks again under the lock, since another transaction may have created the
 * row or closed a later month while this one waited.
 *
 * A month with no row under a closed later month counts as closed (the order rule),
 * and no row is created for it. A row created there would be open beneath a closed
 * month, and the order rule has no way to see it until the month is reopened.
 */
async function holdPeriodRow(tx: DbTx, tenantId: string, date: Date): Promise<HeldPeriod> {
  const period = istMonthKey(date);
  const fy = financialYearOf(date);
  let row = await selectHeldRow(tx, tenantId, period);
  let created = false;
  if (!row) {
    await lockPeriodRows(tx, tenantId);
    row = await selectHeldRow(tx, tenantId, period);
    if (!row) {
      const [laterClosed] = await tx.$queryRaw<Array<{ period: string }>>`
        SELECT "period" FROM "cmp_accounting_periods"
        WHERE "tenantId" = ${tenantId} AND "period" > ${period} AND "status" = 'closed'
        LIMIT 1`;
      if (laterClosed) return { id: null, status: 'closed', period, fy, created: false };
      const made = await tx.accountingPeriod.createMany({
        data: [{ tenantId, period, fy, status: 'open' }],
        skipDuplicates: true,
      });
      created = made.count > 0;
      row = await selectHeldRow(tx, tenantId, period);
    }
  }
  if (!row) throw ApiError.unprocessable(`No accounting period is open for ${period}.`);
  return { id: row.id, status: row.status, period, fy, created };
}

/** The audit and event rows for periods this call created. They take the advisory locks, so they come after every period row. */
async function auditOpenedPeriods(tx: DbTx, held: HeldPeriod[]): Promise<void> {
  for (const h of held) {
    if (!h.created || h.id === null) continue;
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

  if (held.id === null || !POSTABLE_PERIOD_STATUSES.includes(held.status)) {
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

  const months = [...firstDateOf.keys()].sort();
  // A row, once it exists, is never deleted, so a month found with its row here still has
  // it when it is held below. When a month has no row, the advisory lock comes before the
  // first row is held FOR SHARE, which is the order lockPeriodRows requires.
  const present = await tx.accountingPeriod.findMany({
    where: { tenantId, period: { in: months } },
    select: { period: true },
  });
  if (present.length < months.length) await lockPeriodRows(tx, tenantId);

  const held: HeldPeriod[] = [];
  for (const month of months) {
    const date = firstDateOf.get(month);
    if (date) held.push(await holdPeriodRow(tx, tenantId, date));
  }
  await auditOpenedPeriods(tx, held);
}
