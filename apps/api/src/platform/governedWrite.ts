/**
 * The write path of CLAUDE.md rule 5 as one transaction.
 *
 * Callers do the permission checks first, outside the transaction: `assertCan`
 * may need a row loaded before it can be checked (the resource of an approval
 * step, the owner of a task), and a refused caller should learn nothing from
 * a transaction it never needed to open. Inside `work`, in this order:
 *
 *   1. the domain write, through `tx` only
 *   2. `auditWrite({ ..., tx })`
 *   3. `emit({ ..., tx })`
 *
 * The order is not cosmetic. Audit and event both append to a per-tenant hash
 * chain under a transaction-scoped advisory lock (audit.ts, eventBus.ts). Every
 * governed write takes the audit lock before the event lock; a transaction that
 * took them the other way round could wait on a concurrent one that holds the
 * other, and Postgres would abort one of them.
 *
 * Inside `work`, use `tx` for every statement. The scoped client (`prisma`)
 * throws there (db.ts refuseOuterClientInTransaction): it would read zero rows
 * under row-level security rather than the rows this transaction just wrote.
 *
 * A write that queues on a row lock behind many others must be allowed to wait
 * for a connection rather than fail with a 500. Prisma's default interactive-
 * transaction maxWait is 2 s; under a burst the tail of the queue waits longer
 * than that and is refused with P2028 while the lock holders are still working.
 * Callers that serialise on a hot row pass a longer maxWait.
 */

import { prisma, type DbTx } from './db.js';

export async function governedWrite<T>(
  work: (tx: DbTx) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  return prisma.$transaction((tx) => work(tx), options);
}
