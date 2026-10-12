/**
 * The rules that decide whether an access assignment may be confirmed, and when a
 * non-employee's access must end (ACCESS-MODEL-PLAN s.7; P11-DESIGN O7, O8, O12).
 *
 * Pure: no database and no request context, so the rules can be read and tested
 * as the single statement of what a confirmer may do. The commands in
 * assignments.ts load the facts and ask these functions.
 */

import { istDateKey, istEndOfDay } from '@kaizen/shared';

export const IDENTITY_TYPES = ['employee', 'founder', 'non_employee'] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

export const REACHES = ['own', 'team', 'unit', 'vertical', 'company'] as const;
export type Reach = (typeof REACHES)[number];

/**
 * The duty vocabulary and whether each duty is sensitive. A sensitive duty needs
 * the founder to confirm (AMP s.2.3, s.7). The sensitivity is read from here, not
 * from the caller, so the person answering the questionnaire cannot lower it.
 */
export const DUTY_SENSITIVITY: Readonly<Record<string, boolean>> = {
  approve_payments: true,
  run_payroll: true,
  approve_payroll: true,
  manage_bank: true,
  manage_users: true,
  company_wide_data: true,
  approve_leave: false,
};

export interface PlacementFact {
  verticalCode: string;
  reach: Reach;
}

export interface ConfirmContext {
  /** The person the assignment is for. */
  subjectPersonId: string;
  /** The person who suggested it (the answerer). */
  answererPersonId: string;
  /** The person asking to confirm. */
  confirmerPersonId: string;
  placements: PlacementFact[];
  hasSensitiveDuty: boolean;
  /**
   * What the confirmer already holds, from its own confirmed placements. `company`
   * is the founder's reach; `verticalCodes` are the verticals it heads.
   */
  confirmerReach: { company: boolean; verticalCodes: string[] };
  /**
   * True when a person other than the subject, the confirmer and the answerer could
   * confirm this assignment under these rules. Computed from tenant data by the
   * command; it is what makes the founder's sole-confirmer exception available.
   */
  otherEligibleConfirmerExists: boolean;
  /**
   * The reason the founder gives for confirming an assignment they answered. Null or
   * blank when none is given. A reason is only accepted when the exception applies.
   */
  soleConfirmerReason: string | null;
}

export type ConfirmRule =
  'self' | 'answerer' | 'founder_required' | 'vertical_head_required' | 'sole_confirmer_reason_not_needed';

/** A reason was given, meaning it is not null and not blank after trimming. */
function reasonGiven(reason: string | null): boolean {
  return reason !== null && reason.trim() !== '';
}

/**
 * Whether the founder's sole-confirmer exception covers this confirmation (owner
 * answer O7). All four must hold: the confirmer answered the assignment; the
 * confirmer has company reach (the founder); no other eligible confirmer exists; a
 * non-blank reason is given. The exception never covers the subject: a founder
 * confirming their own access is refused whatever the reason.
 */
export function soleConfirmerExceptionApplies(ctx: ConfirmContext): boolean {
  return (
    ctx.confirmerPersonId === ctx.answererPersonId &&
    ctx.confirmerPersonId !== ctx.subjectPersonId &&
    ctx.confirmerReach.company &&
    !ctx.otherEligibleConfirmerExists &&
    reasonGiven(ctx.soleConfirmerReason)
  );
}

export interface ConfirmViolation {
  rule: ConfirmRule;
  verticalCode?: string;
}

/**
 * Every rule the confirmer breaks, empty when it may confirm.
 *
 * Nobody confirms their own access, and that is never excepted. The answerer does
 * not confirm what they answered, with one exception (owner answer O7): the founder,
 * when no other eligible confirmer exists, may confirm it with a reason, which is
 * logged. A reason given where the exception does not apply is refused, so a reason
 * nobody needed is not silently accepted. A Head placement and a sensitive duty need
 * the founder (O12). Any other placement needs the Head of its vertical, or the founder.
 */
export function checkConfirmRules(ctx: ConfirmContext): ConfirmViolation[] {
  const out: ConfirmViolation[] = [];
  const exception = soleConfirmerExceptionApplies(ctx);
  if (ctx.confirmerPersonId === ctx.subjectPersonId) out.push({ rule: 'self' });
  if (ctx.confirmerPersonId === ctx.answererPersonId && !exception) out.push({ rule: 'answerer' });
  if (reasonGiven(ctx.soleConfirmerReason) && !exception) out.push({ rule: 'sole_confirmer_reason_not_needed' });

  const founderOnly =
    ctx.hasSensitiveDuty || ctx.placements.some((p) => p.reach === 'vertical' || p.reach === 'company');
  if (founderOnly && !ctx.confirmerReach.company) out.push({ rule: 'founder_required' });

  if (ctx.confirmerReach.company) return out;
  for (const p of ctx.placements) {
    if (p.reach === 'vertical' || p.reach === 'company') continue;
    if (!ctx.confirmerReach.verticalCodes.includes(p.verticalCode)) {
      out.push({ rule: 'vertical_head_required', verticalCode: p.verticalCode });
    }
  }
  return out;
}

/**
 * Whether an expiry is allowed. Only a non-employee has one, and it must fall on or
 * before the last moment of the IST day twelve months after `from`. The IST day is
 * taken from the instant (CLAUDE.md rule 3), so 00:30 IST on 12 October counts as
 * the 12th, not the 11th.
 */
export function expiryWithinCap(identityType: IdentityType, from: Date, expiresAt: Date | null): boolean {
  if (identityType !== 'non_employee') return true;
  if (expiresAt === null) return false;
  const [year, month, day] = istDateKey(from).split('-').map(Number) as [number, number, number];
  return expiresAt.getTime() <= istEndOfDay(year + 1, month, day).getTime();
}
