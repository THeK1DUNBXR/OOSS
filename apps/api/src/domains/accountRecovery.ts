/**
 * Account recovery for a locked-out employee (ORDERED-PLAN Wave 6).
 *
 * The founder or the IT desk recovers the sign-in, and the one-time password is
 * shown to them and nowhere else. No code goes to a phone, an inbox or any other
 * channel the employee could lose or have taken: the owner chose this over SMS
 * because a SIM swap would hand the sign-in to whoever holds the number
 * (DECISIONS round 22 item e). This module has no SMS, phone or messaging path,
 * and a test holds it to that.
 *
 * One governed write, in the order CLAUDE.md rule 5 gives: `assertCan`, then the
 * credential change through `tx`, then `auditWrite` and `emit` through the same
 * `tx`. A refusal throws before any write, so it leaves the account as it was.
 */

import { EVENTS } from '@kaizen/shared';
import { assertCan } from '../platform/permissions.js';
import { currentAuth } from '../platform/context.js';
import { auditWrite } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { ApiError } from '../platform/errors.js';
import { governedWrite } from '../platform/governedWrite.js';
import { principalHoldsOtherEntities, recoverSignIn } from '../lib/auth.js';

/** The reason must say something: twenty non-whitespace characters, not twenty characters of padding. */
export const RECOVERY_REASON_MIN_CHARS = 20;

/**
 * The founder is the `chairman` role: the superadmin row the matrix generates
 * from every resource (seed/grants.ts, the chairman block), and the account the
 * install seeds first (seed/bootstrap.ts, FOUNDING_ACCOUNTS). ROLE_SLUGS has no
 * separate founder slug, so this is the one slug that means it.
 *
 * Interim default, pending an owner question. The IT desk can recover any
 * account it is granted over, so letting it recover the founder's would let the
 * desk take over the company's top sign-in, which is the SIM-swap risk the owner
 * chose this path to avoid. Until the owner rules on a founder-only procedure,
 * a founder account is recovered by the operator, outside the app.
 */
const FOUNDER_ROLE = 'chairman';

export interface RecoverAccountInput {
  /** The per-entity `User` row to recover. Resolved inside the caller's tenant; another tenant's row is a 404. */
  userId: string;
  reason: string;
  /** Clears the TOTP enrolment, so the account signs in with the password alone until it re-enrols. */
  resetMfa?: boolean;
}

export interface RecoverAccountResult {
  userId: string;
  email: string;
  /** Shown once to the recoverer, never stored in plain, never in the audit or the event. */
  password: string;
  mfaReset: boolean;
  sessionsRevoked: number;
}

export async function recoverAccount(input: RecoverAccountInput): Promise<RecoverAccountResult> {
  await assertCan({ resource: 'account_recovery', verb: 'approve' });
  const auth = currentAuth();
  const resetMfa = input.resetMfa === true;

  if (input.userId === auth.userId) {
    throw ApiError.forbidden('You cannot recover your own sign-in. The founder or the IT desk recovers it for you.');
  }

  const reason = input.reason.trim();
  if (reason.replace(/\s/g, '').length < RECOVERY_REASON_MIN_CHARS) {
    throw ApiError.unprocessable(
      `Say why the sign-in needs recovering, in at least ${RECOVERY_REASON_MIN_CHARS} characters. The reason is kept in the audit log.`,
    );
  }

  return governedWrite(async (tx) => {
    const target = await tx.user.findFirst({ where: { id: input.userId, tenantId: auth.tenantId } });
    if (!target) throw ApiError.notFound('User');

    if (!target.principalId) {
      throw ApiError.conflict(
        'This account has no sign-in principal, so there is no password to recover. Contact the operator.',
      );
    }

    const affiliations = await tx.affiliation.findMany({
      where: { tenantId: auth.tenantId, partyId: target.personId },
    });
    if (affiliations.some((a) => a.roleSlug === FOUNDER_ROLE)) {
      throw ApiError.forbidden(
        'A founder sign-in cannot be recovered through the app. Use the operator procedure for it.',
      );
    }

    const principal = await tx.principal.findUnique({ where: { id: target.principalId } });
    if (target.status !== 'active' || !principal || principal.status !== 'active') {
      throw ApiError.conflict('This sign-in is not active, so it cannot be recovered until it is reactivated.');
    }
    if (!affiliations.some((a) => a.status === 'active')) {
      throw ApiError.conflict(
        'This person no longer holds an active affiliation here, so there is no sign-in to recover.',
      );
    }

    if (await principalHoldsOtherEntities(target.principalId, auth.tenantId)) {
      // Interim default, pending an owner question (see the account-recovery PR):
      // the credential is shared across entities, so one entity's recovery would
      // change and end sessions in another. The message does not say which entity.
      throw ApiError.conflict(
        'This sign-in is shared with another entity, so it cannot be recovered from this one. Use the operator procedure.',
      );
    }

    const { password, sessionsRevoked } = await recoverSignIn(tx, {
      userId: target.id,
      principalId: target.principalId,
      resetMfa,
      now: new Date(),
    });

    await auditWrite({
      tx,
      action: 'update',
      subjectType: 'user',
      subjectId: target.id,
      meta: { kind: 'account_recovery', reason, resetMfa, sessionsRevoked },
    });

    await emit({
      tx,
      name: EVENTS.ACCOUNT_RECOVERED,
      subject: { entityType: 'user', entityId: target.id },
      reason: { note: reason },
      newState: { resetMfa, sessionsRevoked },
    });

    return { userId: target.id, email: target.email, password, mfaReset: resetMfa, sessionsRevoked };
  });
}
