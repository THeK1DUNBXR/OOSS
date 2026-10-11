/**
 * Who may be given an open row (SPINE-CONTRACT 1.7).
 *
 * The handover gate reads a leaver's open rows under FOR UPDATE, inside the
 * transaction that moves them out. A row given to that person by a concurrent
 * write would sit outside the check. So every write that makes a person the
 * owner of a row takes a FOR SHARE lock on that person first. The exit holds
 * FOR UPDATE on the leaver until it commits, so the assignment waits, then reads
 * the committed status and refuses. The lock is taken before any audit or event
 * in that transaction, the same order the exit uses.
 */
import { Prisma, type DbTx } from '../platform/db.js';
import { ApiError } from '../platform/errors.js';

export type PartyStatus = 'active' | 'leaving' | 'exited';

const ACTIVE_EMPLOYMENT = ['Active', 'OnLeave', 'Suspended', 'PendingHire'];
const LEAVING_EMPLOYMENT = ['NoticePeriod', 'Absconded'];
const EXITED_EMPLOYMENT = ['Terminated', 'Alumni', 'NoShow', 'OfferRescinded'];
/** An offboarding that has reached one of these has been completed, and its access revoked. */
const CLOSED_OFFBOARDING = ['FFSettlementCompleted', 'ClosedArchived'];

/**
 * A party with no employment at all (a founder, a partner, a contractor) is
 * active: the exit rules are about employment, and a row can be owned by anyone
 * the tenant knows. `leaving` is an exit in progress, `exited` one that is over,
 * and an active employment anywhere makes a rehired person active again.
 */
export async function partyStatus(tx: DbTx, tenantId: string, partyId: string): Promise<PartyStatus> {
  const employments = await tx.employmentRelationship.findMany({
    where: { tenantId, personId: partyId },
    select: { id: true, status: true },
  });
  if (employments.some((e) => ACTIVE_EMPLOYMENT.includes(e.status))) return 'active';

  const offboardings =
    employments.length === 0
      ? []
      : await tx.offboarding.findMany({
          where: { tenantId, employmentRelationshipId: { in: employments.map((e) => e.id) } },
          select: { status: true },
        });
  if (
    employments.some((e) => LEAVING_EMPLOYMENT.includes(e.status)) ||
    offboardings.some((o) => !CLOSED_OFFBOARDING.includes(o.status))
  ) {
    return 'leaving';
  }
  if (
    employments.some((e) => EXITED_EMPLOYMENT.includes(e.status)) ||
    offboardings.some((o) => CLOSED_OFFBOARDING.includes(o.status))
  ) {
    return 'exited';
  }
  return 'active';
}

/**
 * Locks the party for the rest of the caller's transaction and refuses a party
 * who is leaving or has left. Call it first in the transaction that assigns, before
 * any audit row or event, so the lock order matches the exit's.
 */
export async function lockAssignableParty(tx: DbTx, tenantId: string, partyId: string): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM people WHERE id = ${partyId} AND "tenantId" = ${tenantId} AND "deletedAt" IS NULL FOR SHARE`,
  );
  if (locked.length === 0) throw ApiError.notFound('Person');
  const status = await partyStatus(tx, tenantId, partyId);
  if (status !== 'active') {
    throw ApiError.unprocessable(
      `This person is ${status === 'leaving' ? 'leaving' : 'no longer with the company'}, so cannot be given new open rows.`,
    );
  }
}
