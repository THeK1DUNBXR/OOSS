/**
 * Binding a people-domain read to the person it is about.
 *
 * Almost every HR read is addressed by an employment relationship id:
 * `leaveBalances(employmentId)`, `attendanceForPeriod(employmentId, period)`,
 * `currentCompensation(employmentId)`. Each of them used to assert the grant
 * and then trust the id — which was survivable only because every role that
 * held the grant held it at `all` scope.
 *
 * With an `employee` role that holds `leave:VCE@own`, an employment id becomes
 * a side door: the coarse assertion passes, because with no record to narrow
 * against the evaluator can only answer "may this person read leave at all",
 * and the caller receives a colleague's leave ledger. The same shape reaches
 * salary, attendance and goals.
 *
 * This resolves the id to the person it belongs to and asks the evaluator the
 * question it can actually answer. There is one of these rather than one check
 * per service, because thirty near-identical checks is thirty chances to
 * forget the thirty-first.
 */

import { prisma } from './db.js';
import { currentAuth } from './context.js';
import { assertCan, scopeFor } from './permissions.js';
import { ApiError } from './errors.js';
import type { Verb } from '@kaizen/shared';

/**
 * Asserts the caller may reach a record about the person holding this
 * employment relationship.
 *
 * Not-found rather than forbidden when the caller is narrowed: whether a
 * colleague has a leave ledger, a disciplinary note or a pay record is itself
 * part of what is being withheld, and a 403 confirms the id is real.
 */
export async function assertEmploymentVisible(
  resource: string,
  employmentRelationshipId: string,
  verb: Verb = 'view',
): Promise<{ personId: string }> {
  const auth = currentAuth();
  await assertCan({ resource, verb });

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: employmentRelationshipId, tenantId: auth.tenantId },
    select: { personId: true },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const scope = await scopeFor(resource, verb);
  if (scope !== 'all' && employment.personId !== auth.partyId) {
    throw ApiError.notFound('Employment relationship');
  }

  return employment;
}

/**
 * The `where` fragment that narrows a list of employment-addressed rows to the
 * caller's own, for endpoints that take no id at all.
 *
 * Returns `{}` on an all-scope grant so the common path stays free, and a
 * nested filter on the relationship otherwise.
 */
export async function employmentVisibilityWhere(
  resource: string,
  verb: Verb = 'view',
): Promise<Record<string, unknown>> {
  const auth = currentAuth();
  const scope = await scopeFor(resource, verb);
  if (scope === 'all') return {};
  return { employmentRelationship: { personId: auth.partyId } };
}
