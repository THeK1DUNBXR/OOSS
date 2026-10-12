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
 *   1. the accounting period row (this file);
 *   2. the record sequence row (nextRecordCode);
 *   3. the Transaction and ledger rows;
 *   4. the audit and event advisory locks (auditWrite, emit), last.
 * The close takes 1, then 4, and no other lock. No close path takes a source row
 * (invoice, refund), so a caller may take its source row before 1, as payRefund
 * does, without a cycle.
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
 * Takes the IST month's period row FOR SHARE in `tx` and refuses unless the month
 * is postable. Call it before the first write in the transaction. Returns the
 * period's id.
 */
export async function lockLegacyPeriod(tx: DbTx, tenantId: string, date: Date): Promise<string> {
  const period = istMonthKey(date);
  const created = await tx.accountingPeriod.createMany({
    data: [{ tenantId, period, fy: financialYearOf(date), status: 'open' }],
    skipDuplicates: true,
  });
  const [row] = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status" FROM "cmp_accounting_periods"
    WHERE "tenantId" = ${tenantId} AND "period" = ${period}
    FOR SHARE`;
  if (!row) throw ApiError.unprocessable(`No accounting period is open for ${period}.`);

  if (created.count > 0) {
    await auditWrite({
      action: 'create',
      subjectType: 'accounting_period',
      subjectId: row.id,
      after: { period, status: 'open' },
      tx,
    });
    await emit({
      name: EVENTS.ACCOUNTING_PERIOD_OPENED,
      subject: { entityType: 'accounting_period', entityId: row.id },
      newState: { period, status: 'open' },
      impact: { domains: ['fin'] },
      confidentiality: 'confidential',
      tx,
    });
  }

  if (!POSTABLE_PERIOD_STATUSES.includes(row.status)) {
    throw ApiError.unprocessable(
      row.status === 'closing'
        ? `${period} is a closing accounting period: its close has been requested and not yet approved. It takes no entries until the close completes.`
        : `${period} is a ${row.status} accounting period. It takes no entries.`,
      { period, status: row.status, reasonCode: 'accounting_period_closed' },
    );
  }
  return row.id;
}
