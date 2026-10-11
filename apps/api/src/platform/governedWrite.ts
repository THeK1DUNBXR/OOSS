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
 */

import { prisma, type DbTx } from './db.js';

export async function governedWrite<T>(work: (tx: DbTx) => Promise<T>): Promise<T> {
  return prisma.$transaction((tx) => work(tx));
}
