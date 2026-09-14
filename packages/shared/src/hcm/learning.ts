/**
 * HCM — learning (docs/hcm/learning.md).
 *
 * Pure computation only: nothing here touches the database or the request
 * context. The domain layer (apps/api/src/domains/hcm/learning.ts) is the
 * thin, testable seam around these functions.
 */

import { HrRuleViolationError } from '../hr.js';

export const HCM_LEARNING_MODULE = 'learning' as const;

export type TrainingProgramKind = 'classroom' | 'online' | 'certification' | 'mandatory';
export const TRAINING_PROGRAM_KINDS: TrainingProgramKind[] = ['classroom', 'online', 'certification', 'mandatory'];

export type TrainingEnrollmentStatus =
  | 'nominated'
  | 'approved'
  | 'attended'
  | 'completed'
  | 'no_show'
  | 'rejected';

/**
 * The enrollment lifecycle: nominated → approved → attended → completed, with
 * a `rejected` or `no_show` exit. There is no route directly from `nominated`
 * to `completed` — attendance and approval are each a fact somebody has to
 * assert, not something completion implies retroactively.
 */
export const ENROLLMENT_TRANSITIONS: Record<TrainingEnrollmentStatus, TrainingEnrollmentStatus[]> = {
  nominated: ['approved', 'rejected'],
  approved: ['attended', 'no_show'],
  attended: ['completed'],
  completed: [],
  no_show: [],
  rejected: [],
};

export function canTransitionEnrollment(from: TrainingEnrollmentStatus, to: TrainingEnrollmentStatus): boolean {
  return ENROLLMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertEnrollmentTransition(from: TrainingEnrollmentStatus, to: TrainingEnrollmentStatus): void {
  if (!canTransitionEnrollment(from, to)) {
    throw new HrRuleViolationError(
      `A training enrollment cannot move from "${from}" to "${to}". Valid next steps from "${from}": ` +
        `${ENROLLMENT_TRANSITIONS[from]?.join(', ') || 'none — this is a terminal state'}.`,
    );
  }
}

/**
 * The Self-Dealing Bar for a nomination: the person who approves it must not
 * be the person nominated, nor the person who raised the nomination. Both
 * checks matter — a self-nomination approved by oneself, and a manager
 * approving a nomination they raised for themselves under someone else's
 * name, are the same failure.
 */
export function assertEnrollmentApprovalAllowed(input: {
  approverPartyId: string;
  nomineePersonId: string;
  nominatedByPartyId: string | null;
}): void {
  if (input.approverPartyId === input.nomineePersonId) {
    throw new HrRuleViolationError('A nomination cannot be approved by the person nominated [Self-Dealing Bar].');
  }
  if (input.nominatedByPartyId && input.approverPartyId === input.nominatedByPartyId) {
    throw new HrRuleViolationError('A nomination cannot be approved by the person who raised it [Self-Dealing Bar].');
  }
}

/** A certification cannot be verified by the person it was issued to. */
export function assertCertificationVerificationAllowed(input: {
  verifierPartyId: string;
  holderPersonId: string;
}): void {
  if (input.verifierPartyId === input.holderPersonId) {
    throw new HrRuleViolationError('A certification cannot be self-verified [Self-Dealing Bar].');
  }
}

/** A certification's expiry date, from the program's validity window. Null means it never expires. */
export function certificationExpiryFrom(issuedOn: Date, validityMonths: number | null | undefined): Date | null {
  if (!validityMonths) return null;
  const d = new Date(issuedOn);
  d.setUTCMonth(d.getUTCMonth() + validityMonths);
  return d;
}

export interface ExpiryRung {
  days: number;
  severity: 'S2_WARNING' | 'S3_HIGH_RISK' | 'S4_CRITICAL';
}

/**
 * The certification expiry ladder: 90/30/7 days out, each rung raising a
 * sharper exception than the last. Sorted descending — the job walks it in
 * this order and stops at the first rung the certificate has actually
 * reached, so a certificate 10 days from expiry raises the 7-day rung, not
 * the 90-day one it also technically crossed weeks ago.
 */
export const CERTIFICATION_EXPIRY_LADDER: ExpiryRung[] = [
  { days: 90, severity: 'S2_WARNING' },
  { days: 30, severity: 'S3_HIGH_RISK' },
  { days: 7, severity: 'S4_CRITICAL' },
];

/** The nearest rung an expiry has reached as of `asOf`, or null if it is more than 90 days out (or already handled). */
export function expiryRungReached(expiresOn: Date, asOf: Date): ExpiryRung | null {
  const daysLeft = Math.ceil((expiresOn.getTime() - asOf.getTime()) / 86_400_000);
  let reached: ExpiryRung | null = null;
  for (const rung of CERTIFICATION_EXPIRY_LADDER) {
    if (daysLeft <= rung.days) reached = rung;
  }
  return reached;
}

/** True once a certification has lapsed as of `asOf`. */
export function isCertificationExpired(expiresOn: Date | null, asOf: Date): boolean {
  return Boolean(expiresOn && expiresOn.getTime() <= asOf.getTime());
}

/** When a mandatory training rule's clock starts counting from someone's join date. */
export function mandatoryTrainingDueDate(hireEffectiveDate: Date, dueWithinDaysOfJoin: number | null | undefined): Date | null {
  if (dueWithinDaysOfJoin == null) return null;
  return new Date(hireEffectiveDate.getTime() + dueWithinDaysOfJoin * 86_400_000);
}

/** The next occurrence a recurring mandatory course is due, from the last completion. */
export function nextRecurrenceDue(lastCompletedAt: Date, recurrenceMonths: number | null | undefined): Date | null {
  if (!recurrenceMonths) return null;
  const d = new Date(lastCompletedAt);
  d.setUTCMonth(d.getUTCMonth() + recurrenceMonths);
  return d;
}

export function isMandatoryTrainingOverdue(dueDate: Date | null, asOf: Date): boolean {
  return Boolean(dueDate && dueDate.getTime() < asOf.getTime());
}

/** Budget utilisation as a 0-100 percentage, capped for display; null when there is no budget to divide by. */
export function budgetUtilisationPercent(amount: number, spent: number): number | null {
  if (amount <= 0) return null;
  return Math.round((spent / amount) * 1000) / 10;
}
