/**
 * Account recovery for a locked-out employee (ORDERED-PLAN Wave 6).
 *
 * One holder recovers the sign-in, and the one-time password is shown to them and
 * nowhere else: the IT admin once onboarding names one, otherwise the founder
 * (DECISIONS round 23 c, C-015). `recoveryHolder` resolves who that is. No code
 * goes to a phone, an inbox or any other channel the employee could lose or have
 * taken: the owner chose this over SMS because a SIM swap would hand the sign-in
 * to whoever holds the number (DECISIONS round 22 item e). This module has no
 * SMS, phone or messaging path, and a test holds it to that.
 *
 * The recoverer learns the password, so the recoverer may recover only an
 * account whose roles they could assign themselves. A recovered password is
 * one-time: the sign-in must change it before anything else works
 * (`mustChangePassword`, enforced in lib/http.ts).
 *
 * The checks run before the transaction, because the role guard reads through
 * the scoped client, which refuses to run inside one. The write itself is one
 * governed transaction in the order CLAUDE.md rule 5 gives: the credential
 * change through `tx`, then `auditWrite` and `emit` through the same `tx`. A
 * refusal throws before any write, so it leaves the account as it was.
 */

import { EVENTS } from '@kaizen/shared';
import { assertCan } from '../platform/permissions.js';
import { assertCanAssignRole } from '../platform/roleAssignment.js';
import { currentAuth } from '../platform/context.js';
import { auditWrite } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { ApiError } from '../platform/errors.js';
import { governedWrite } from '../platform/governedWrite.js';
import { prisma } from '../platform/db.js';
import { principalHoldsOtherEntities, recoverSignIn } from '../lib/auth.js';
import { FOUNDER_DUTY, resolveDutyHolder } from './statutory.js';
import { verifyTotp } from './compliance/corporate/totp.js';

/** The reason must say something: twenty non-whitespace characters, not twenty characters of padding. */
export const RECOVERY_REASON_MIN_CHARS = 20;

/**
 * The duty that names the internal IT admin. It is a tenant duty with one holder at
 * a time, as FOUNDER_DUTY is, so naming the admin is an assignment and handing it
 * over is an end followed by an assign. Nothing in onboarding names it yet, so until
 * something does, `recoveryHolder` falls back to the founder.
 */
export const IT_ADMIN_DUTY = 'it_admin';

export type RecoveryHolderKind = 'it_admin' | 'founder';

/**
 * Who may recover a sign-in in the tenant of the request: the IT admin once one is
 * named, otherwise the founder. Read from the duties, never from a grant or a role
 * slug, so someone who holds account_recovery:approve but was not named is not the
 * holder. Null when neither duty has a holder.
 */
export async function recoveryHolder(
  at: Date = new Date(),
): Promise<{ kind: RecoveryHolderKind; partyId: string } | null> {
  const itAdmin = await resolveDutyHolder(IT_ADMIN_DUTY, at);
  if (itAdmin) return { kind: 'it_admin', partyId: itAdmin.partyId };
  const founder = await resolveDutyHolder(FOUNDER_DUTY, at);
  return founder ? { kind: 'founder', partyId: founder.partyId } : null;
}

/**
 * The `chairman` role is how a founder account is recognised when it is the
 * target, which is a different question from who the holder is. The holder is the
 * founder duty's holder, and the founder duty can move to another person at
 * onboarding, so the holder is never read from this slug.
 *
 * A founder account is still refused as a target. The IT admin could otherwise
 * take over the company's top sign-in, which is the SIM-swap risk the owner chose
 * this path to avoid, so a founder account is recovered by the operator.
 */
const FOUNDER_ROLE = 'chairman';

export interface RecoverAccountInput {
  /** The per-entity `User` row to recover. Resolved inside the caller's tenant; another tenant's row is a 404. */
  userId: string;
  reason: string;
  /** Clears the TOTP enrolment, so the account signs in with the password alone until it re-enrols. */
  resetMfa?: boolean;
  /** A current TOTP code from the recoverer's own authenticator, required when the recoverer has MFA enabled. */
  totpCode?: string;
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

  // The grant above says the caller may recover; the holder check says the caller is the
  // person the company named to do it. Both must hold, so a grant held by someone else
  // does not make them a recoverer.
  const holder = await recoveryHolder();
  if (!holder) {
    throw new ApiError(
      422,
      'UNPROCESSABLE',
      'No founder is named for this tenant, so no one can recover a sign-in here. The founder duty is set at bootstrap.',
      { reasonCode: 'recovery_holder_not_set' },
    );
  }
  if (!auth.partyId || auth.partyId !== holder.partyId) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      holder.kind === 'it_admin'
        ? 'Only the IT admin named at onboarding can recover a sign-in in this company.'
        : 'Only the founder can recover a sign-in until onboarding names an IT admin.',
      { reasonCode: 'recovery_holder_only' },
    );
  }

  if (input.userId === auth.userId) {
    throw ApiError.forbidden('You cannot recover your own sign-in. The recovery holder recovers it for you.');
  }

  const reason = input.reason.trim();
  if (reason.replace(/\s/g, '').length < RECOVERY_REASON_MIN_CHARS) {
    throw ApiError.unprocessable(
      `Say why the sign-in needs recovering, in at least ${RECOVERY_REASON_MIN_CHARS} characters. The reason is kept in the audit log.`,
    );
  }

  if (!auth.userId) {
    throw ApiError.forbidden('A sign-in can only be recovered by a person, not by a system or agent identity.');
  }
  const caller = await prisma.user.findFirst({ where: { id: auth.userId, tenantId: auth.tenantId } });
  // A recoverer who has a second factor proves it now, so a stolen session alone
  // cannot recover accounts. A recoverer without one may still recover: this is
  // the interim default, pending an owner question on enrolment.
  if (caller?.mfaEnabledAt) {
    const code = input.totpCode;
    if (!code || !caller.mfaSecret || !verifyTotp(caller.mfaSecret, code)) {
      throw ApiError.unauthorized('Enter the current code from your authenticator app to confirm this recovery.');
    }
  }

  // Principal is read through the relation only: its direct use is confined to lib/auth.ts.
  const target = await prisma.user.findFirst({
    where: { id: input.userId, tenantId: auth.tenantId },
    include: { principal: { select: { status: true } } },
  });
  if (!target) throw ApiError.notFound('User');

  if (!target.principalId) {
    throw ApiError.conflict(
      'This account has no sign-in principal, so there is no password to recover. Contact the operator.',
    );
  }
  const principalId = target.principalId;

  const affiliations = await prisma.affiliation.findMany({
    where: { tenantId: auth.tenantId, partyId: target.personId },
  });
  if (affiliations.some((a) => a.roleSlug === FOUNDER_ROLE)) {
    throw ApiError.forbidden(
      'A founder sign-in cannot be recovered through the app. Use the operator procedure for it.',
    );
  }

  if (target.status !== 'active' || target.principal?.status !== 'active') {
    throw ApiError.conflict('This sign-in is not active, so it cannot be recovered until it is reactivated.');
  }
  if (!affiliations.some((a) => a.status === 'active')) {
    throw ApiError.conflict(
      'This person no longer holds an active affiliation here, so there is no sign-in to recover.',
    );
  }

  // The password reveals the account, so the recoverer must be able to assign
  // every role the account holds. hr_ops_manager recovers an employee and not a
  // finance_head; the chairman holds every grant and recovers either.
  for (const affiliation of affiliations) {
    if (affiliation.status !== 'active' || !affiliation.roleSlug) continue;
    await assertCanAssignRole({ roleSlug: affiliation.roleSlug, targetPartyId: target.personId });
  }

  if (await principalHoldsOtherEntities(principalId, auth.tenantId)) {
    // Interim default, pending an owner question (see the account-recovery PR):
    // the credential is shared across entities, so one entity's recovery would
    // change and end sessions in another. The message does not say which entity.
    throw ApiError.conflict(
      'This sign-in is shared with another entity, so it cannot be recovered from this one. Use the operator procedure.',
    );
  }

  return governedWrite(async (tx) => {
    // Re-read inside the transaction: the checks above ran outside it, and the
    // write must act on the row as it is now.
    const current = await tx.user.findFirst({
      where: { id: target.id, tenantId: auth.tenantId, principalId, status: 'active' },
    });
    if (!current) throw ApiError.conflict('This sign-in changed while it was being recovered. Try again.');

    const { password, sessionsRevoked } = await recoverSignIn(tx, {
      userId: current.id,
      principalId,
      resetMfa,
      now: new Date(),
    });

    await auditWrite({
      tx,
      action: 'update',
      subjectType: 'user',
      subjectId: current.id,
      meta: { kind: 'account_recovery', reason, resetMfa, sessionsRevoked, holder: holder.kind },
    });

    await emit({
      tx,
      name: EVENTS.ACCOUNT_RECOVERED,
      subject: { entityType: 'user', entityId: current.id },
      reason: { note: reason },
      newState: { resetMfa, sessionsRevoked },
    });

    return { userId: current.id, email: current.email, password, mfaReset: resetMfa, sessionsRevoked };
  });
}
