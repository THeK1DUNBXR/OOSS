/**
 * Sign-ins for outsiders — a shareholder or board member with no employment
 * here (equity-portal plan §1.10).
 *
 * No invite flow, no one-time code, no email sent by the platform. The
 * chairman or the company secretary creates the sign-in and is shown the
 * password once, exactly the way the founding-account seed already works; the
 * same action resets it. `roleSlug` is validated by a zod enum at the route,
 * which is input validation, not a role-identity check — this function never
 * compares a role slug itself, only the grant `assertCan` resolves.
 */

import { EVENTS } from '@kaizen/shared';
import { assertCan } from '../platform/permissions.js';
import { currentAuth } from '../platform/context.js';
import { prisma } from '../platform/db.js';
import { emit } from '../platform/eventBus.js';
import { auditWrite } from '../platform/audit.js';
import { ApiError } from '../platform/errors.js';
import { ensureSignInPrincipal } from '../lib/auth.js';

export type SignInRole = 'shareholder' | 'director' | 'company_secretary';

export interface CreateSignInInput {
  personId: string;
  roleSlug: SignInRole;
  email: string;
  /** Rotates the password on an existing sign-in instead of leaving it untouched. */
  reset?: boolean;
}

export interface SignInResult {
  email: string;
  /** Set only when a password was actually issued — first creation, or an explicit reset. */
  password: string | null;
  created: boolean;
}

// A shareholder sign-in is created by whoever may add a holder; a director or
// company-secretary sign-in by whoever may call a board meeting — the
// chairman holds both, and so does the company secretary for their own
// colleagues on the board (§1.10, §3.4). A lookup rather than a comparison so
// this reads as a grant declaration, the same shape the grant matrix itself
// takes, and not a role-identity check.
const SIGN_IN_RESOURCE: Record<SignInRole, 'holders' | 'board_meetings'> = {
  shareholder: 'holders',
  director: 'board_meetings',
  company_secretary: 'board_meetings',
};

export async function createOrResetSignIn(input: CreateSignInInput): Promise<SignInResult> {
  await assertCan({ resource: SIGN_IN_RESOURCE[input.roleSlug], verb: 'create' });
  const auth = currentAuth();

  const person = await prisma.person.findFirst({ where: { id: input.personId } });
  if (!person) throw ApiError.notFound('Person');

  const email = input.email.toLowerCase();
  const { principalId, password } = await ensureSignInPrincipal(email, Boolean(input.reset));

  let user = await prisma.user.findFirst({ where: { email } });
  let userCreated = false;
  if (!user) {
    user = await prisma.user.create({ data: { tenantId: auth.tenantId, personId: person.id, email, principalId } });
    userCreated = true;
  } else if (!user.principalId) {
    user = await prisma.user.update({ where: { id: user.id }, data: { principalId } });
  }

  const existingAffiliation = await prisma.affiliation.findFirst({
    where: { partyId: person.id, roleSlug: input.roleSlug, affiliationType: input.roleSlug },
  });
  const affiliation = existingAffiliation
    ? existingAffiliation.status === 'active'
      ? existingAffiliation
      : await prisma.affiliation.update({ where: { id: existingAffiliation.id }, data: { status: 'active' } })
    : await prisma.affiliation.create({
        data: {
          tenantId: auth.tenantId,
          partyId: person.id,
          affiliationType: input.roleSlug,
          roleSlug: input.roleSlug,
          status: 'active',
          primaryFlag: false,
        },
      });

  await auditWrite({
    action: userCreated ? 'create' : 'update',
    subjectType: 'user',
    subjectId: user.id,
    after: { email, roleSlug: input.roleSlug, affiliationId: affiliation.id },
    force: true,
  });

  await emit({
    name: input.reset ? EVENTS.SIGN_IN_RESET : EVENTS.SIGN_IN_CREATED,
    subject: { entityType: 'user', entityId: user.id },
    related: [{ relation: 'holder_or_board_member', entityType: 'person', entityId: person.id }],
    newState: { email, roleSlug: input.roleSlug },
  });

  return { email, password, created: userCreated };
}
