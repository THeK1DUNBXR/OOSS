import { prisma } from '../platform/db.js';
import { Prisma } from '@prisma/client';
import { EVENTS, istDateKey } from '@kaizen/shared';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan } from '../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { governedWrite } from '../platform/governedWrite.js';

registerGovernedEntities('cmp_statutory', [
  'statutory_rule',
  'einvoice_submission',
  'payroll_statutory_line',
  'duty_assignment',
]);

export interface StatutoryRuleInput {
  domain: string;
  key: string;
  jurisdiction: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  value: Prisma.InputJsonValue;
  source: string;
}

export async function listStatutoryRules(
  filters: {
    domain?: string;
    key?: string;
    jurisdiction?: string;
  } = {},
) {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'view' });
  return prisma.statutoryRule.findMany({
    where: { tenantId: auth.tenantId, ...filters },
    orderBy: [{ domain: 'asc' }, { key: 'asc' }, { effectiveFrom: 'desc' }],
  });
}

export async function createStatutoryRule(input: StatutoryRuleInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'edit' });
  if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
    throw ApiError.badRequest('effectiveTo must be after effectiveFrom.');
  }
  // No overlap check here. A DRAFT never resolves, so it may cover days an
  // APPROVED rule already covers: that is how next year's rate is staged while
  // this year's open-ended rule is still in force. A collision is refused at
  // approval, against the rows that would then resolve.
  // createdBy is written after the spread so no caller can name another author.
  const row = await prisma.statutoryRule.create({
    data: { tenantId: auth.tenantId, ...input, createdBy: auth.partyId },
  });
  await auditWrite({ action: 'create', subjectType: 'statutory_rule', subjectId: row.id, after: row });
  await emit({
    name: EVENTS.STATUTORY_RULE_DRAFTED,
    subject: { entityType: 'statutory_rule', entityId: row.id },
    newState: { status: 'DRAFT', domain: row.domain, key: row.key, jurisdiction: row.jurisdiction },
    impact: { domains: ['cmp'] },
  });
  return row;
}

/**
 * The duty that approves a statutory rule. The owner has not named the key (round 27,
 * "what was not done"), and onboarding may rename it. It is spelled here once, so a
 * rename moves every holder check with it.
 */
export const STATUTORY_APPROVER_DUTY = 'statutory.approver';

/**
 * The founder duty. Owner ruling, 2026-10-12: "the founder (unless changed during onboarding)"
 * holds the statutory approver duty, and "the founder is end all be all, he can do whatever he
 * wants". The owner then accepted an audited exemption: the founder may approve a rule he wrote,
 * may approve without holding the approver duty, and may name himself to a duty. Each waived
 * check is recorded in the audit row's meta as founderOverride.
 *
 * The exemption never waives the citation rule (an UNVERIFIED source is data, not authority),
 * the audit trail, tenant scope, period close or posted-entry immutability. "Cannot be disabled"
 * is statutory, and a correction is a reversal, not an edit.
 *
 * The founder is whoever holds this duty now. Onboarding may name another holder, so no person
 * is named in code: the seed names the owner account's person once, when no founder exists.
 */
export const FOUNDER_DUTY = 'founder';

/** The checks the founder exemption waived on one write, recorded as founderOverride in the audit meta. */
export type FounderOverride =
  'author_is_approver' | 'not_duty_holder' | 'self_assignment' | 'not_resolved_approver' | 'payment_second_approver';

/** True when the caller holds the founder duty at the instant. Read from the duty, never from a name. */
export async function isFounder(at: Date = new Date()): Promise<boolean> {
  const auth = currentAuth();
  if (!auth.partyId) return false;
  const holder = await resolveDutyHolder(FOUNDER_DUTY, at);
  return holder?.partyId === auth.partyId;
}

const DUTY_KEY = /^[a-z][a-z0-9_.]{2,63}$/;

function isExclusionViolation(err: unknown): boolean {
  return /23P01|exclusion/i.test(String((err as Error)?.message ?? err));
}

/**
 * The holder of a duty at an instant, in the tenant of the request. The tenant is read
 * from the context, never from an argument, so a caller cannot ask about another
 * tenant's holder by naming it.
 *
 * Instants, not IST dates: a holder changes hands at a moment, and the approval that
 * happens in that moment must see the holder then.
 */
export async function resolveDutyHolder(dutyKey: string, at: Date = new Date()) {
  const auth = currentAuth();
  return prisma.dutyAssignment.findFirst({
    where: {
      tenantId: auth.tenantId,
      dutyKey,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
}

export interface DutyAssignmentInput {
  dutyKey: string;
  partyId: string;
  effectiveFrom?: Date;
}

/**
 * Names a person as the holder of a duty from an instant. Refused with 409 if another
 * holder already covers any part of that period: the database has the last word, and
 * handing a duty over is an end followed by an assign, not an overlap.
 *
 * Granting a duty is granting authority, so it is governed by the verb that governs
 * granting access today (access_assignments approve, as sod.ts uses for overrides).
 */
export async function assignDuty(input: DutyAssignmentInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'access_assignments', verb: 'approve' });
  if (!DUTY_KEY.test(input.dutyKey)) {
    throw ApiError.badRequest('A duty key is lower-case letters, digits, dots or underscores, starting with a letter.');
  }
  const assignedBy = auth.partyId;
  if (!assignedBy) throw ApiError.forbidden('Only a person can assign a duty.');
  const at = new Date();
  const callerIsFounder = await isFounder(at);
  const founderOverride: FounderOverride[] = [];
  // The founder duty is assigned and ended only by the current founder, whatever verbs the
  // caller holds (owner ruling, 2026-10-12). With no founder yet, nothing can be assigned here:
  // the founder is named at bootstrap, and this refusal says so.
  if (input.dutyKey === FOUNDER_DUTY) {
    if (!(await resolveDutyHolder(FOUNDER_DUTY, at))) {
      throw new ApiError(
        422,
        'UNPROCESSABLE',
        'No founder is named for this tenant. The founder duty is set at bootstrap, from the owner account.',
        { reasonCode: 'founder_not_set' },
      );
    }
    if (!callerIsFounder) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the current founder can assign or end the founder duty.', {
        reasonCode: 'founder_only',
      });
    }
  }
  // Granting yourself a duty is not a check. The person who grants the authority and the
  // person who exercises it would be one, which is the maker-checker failure the statutory
  // approver duty exists to prevent. Refused for every duty, because the reasoning holds for
  // any duty that approves or releases something. The founder is exempt by the owner's ruling
  // ("the founder is end all be all"), and the exemption is audited as self_assignment.
  if (input.partyId === assignedBy) {
    if (!callerIsFounder) {
      throw new ApiError(403, 'FORBIDDEN', 'A person cannot name themselves to a duty they would then exercise.', {
        reasonCode: 'duty_self_assignment',
      });
    }
    founderOverride.push('self_assignment');
  }
  const person = await prisma.person.findFirst({ where: { id: input.partyId } });
  if (!person) throw ApiError.notFound('Person');
  const effectiveFrom = input.effectiveFrom ?? at;
  try {
    return await governedWrite(async (tx) => {
      const row = await tx.dutyAssignment.create({
        data: { tenantId: auth.tenantId, dutyKey: input.dutyKey, partyId: input.partyId, effectiveFrom, assignedBy },
      });
      await auditWrite({
        action: 'create',
        subjectType: 'duty_assignment',
        subjectId: row.id,
        after: row,
        ...(founderOverride.length > 0 ? { meta: { founderOverride } } : {}),
        tx,
      });
      await emit({
        name: EVENTS.DUTY_ASSIGNED,
        subject: { entityType: 'duty_assignment', entityId: row.id },
        newState: { dutyKey: row.dutyKey, partyId: row.partyId, effectiveFrom: row.effectiveFrom.toISOString() },
        impact: { domains: ['cmp'] },
        tx,
      });
      return row;
    });
  } catch (err) {
    if (isExclusionViolation(err)) {
      throw ApiError.conflict(`${input.dutyKey} already has a holder over that period. End the current holder first.`);
    }
    throw err;
  }
}

/**
 * Who holds a duty now, for a caller who may see access assignments. The holder is
 * the approver of statutory rules, so reading it is access-governed like any other
 * access record. resolveDutyHolder stays unchecked, because approval calls it.
 */
export async function getDutyHolder(dutyKey: string, at: Date = new Date()) {
  await assertCan({ resource: 'access_assignments', verb: 'view' });
  return resolveDutyHolder(dutyKey, at);
}

/**
 * Ends the current holder of a duty, from now. The row is kept as history. A holder
 * whose start has not yet arrived cannot be ended (the end would precede the start):
 * there is no delete, so such a row stands until its start passes and is then ended.
 */
export async function endDuty(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'access_assignments', verb: 'approve' });
  const endedBy = auth.partyId;
  if (!endedBy) throw ApiError.forbidden('Only a person can end a duty.');
  const row = await prisma.dutyAssignment.findFirst({ where: { id } });
  if (!row) throw ApiError.notFound('Duty assignment');
  // Checked before the row's state, so no caller learns more about the founder row than that it
  // is refused. Only the current founder ends the founder duty.
  if (row.dutyKey === FOUNDER_DUTY && !(await isFounder())) {
    throw new ApiError(403, 'FORBIDDEN', 'Only the current founder can assign or end the founder duty.', {
      reasonCode: 'founder_only',
    });
  }
  if (row.effectiveTo) throw ApiError.conflict('This duty assignment has already ended.');
  const at = new Date();
  if (at <= row.effectiveFrom) {
    throw ApiError.unprocessable('This assignment has not started yet, so it cannot be ended before it begins.', {
      reasonCode: 'duty_not_yet_started',
    });
  }
  return governedWrite(async (tx) => {
    const next = await tx.dutyAssignment.update({ where: { id }, data: { effectiveTo: at, endedBy } });
    await auditWrite({
      action: 'update',
      subjectType: 'duty_assignment',
      subjectId: id,
      before: { effectiveTo: null },
      after: { effectiveTo: at, endedBy },
      tx,
    });
    await emit({
      name: EVENTS.DUTY_ENDED,
      subject: { entityType: 'duty_assignment', entityId: id },
      previousState: { dutyKey: row.dutyKey, partyId: row.partyId },
      newState: { dutyKey: row.dutyKey, partyId: row.partyId, effectiveTo: at.toISOString() },
      impact: { domains: ['cmp'] },
      tx,
    });
    return next;
  });
}

/**
 * Thrown instead of falling back to a constant. A missing statutory parameter
 * is a stop, because a silent default is a wrong payslip that surfaces later as
 * a notice.
 */
export class StatutoryRuleNotFoundError extends ApiError {
  constructor(
    readonly key: string,
    readonly jurisdiction: string,
    readonly onDate: string,
  ) {
    super(
      422,
      'UNPROCESSABLE',
      `No APPROVED statutory rule for ${key} in ${jurisdiction} covers ${onDate} (IST). Statutory features are awaiting the accountant's setup.`,
      { reasonCode: 'statutory_rule_not_approved', key, jurisdiction, onDate },
    );
    this.name = 'StatutoryRuleNotFoundError';
  }
}

/**
 * The APPROVED rule in force on the IST date of `at`. DRAFT and HOLD rows are
 * never returned, even when their dates cover `at`: a parameter that has not
 * been signed off must not change a calculation.
 *
 * Reads tenant rows only. Platform pack rows (tenantId NULL) need an explicit
 * decision about reading outside the scoped client, which injects the tenant
 * into every query (platform/db.ts), so they are not resolved here yet.
 */
export async function ruleAt(domain: string, key: string, jurisdiction: string, at: Date) {
  const auth = currentAuth();
  const onDate = istDateKey(at);
  const day = new Date(`${onDate}T00:00:00.000Z`);
  // domain is part of the identity: the same key and jurisdiction may exist in two
  // domains, and resolving without it returns whichever row sorts first.
  const row = await prisma.statutoryRule.findFirst({
    where: {
      tenantId: auth.tenantId,
      domain,
      key,
      jurisdiction,
      status: 'APPROVED',
      effectiveFrom: { lte: day },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: day } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!row) throw new StatutoryRuleNotFoundError(key, jurisdiction, onDate);
  return row;
}

/**
 * An integer field of an APPROVED rule's value, read as written. The seed and the
 * approval form store integers as strings, as amountMinor does, because a JSON number is
 * a float waiting to happen. Any other shape is refused rather than coerced: a value that
 * cannot be read is a stop, the same as a missing rule.
 */
export function ruleIntegerField(value: Prisma.JsonValue, field: string, key: string): bigint {
  const raw =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, Prisma.JsonValue>)[field]
      : undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw ApiError.unprocessable(`Statutory rule ${key} has no integer ${field}.`, {
      reasonCode: 'statutory_rule_malformed',
      key,
      field,
    });
  }
  return BigInt(raw);
}

const UNVERIFIED = 'UNVERIFIED:';

/**
 * The source an approved rule carries. An UNVERIFIED rule needs a replacement citation
 * that is not itself UNVERIFIED. A verified rule takes none.
 */
function approvalSource(current: string, replacement: string | undefined): string {
  if (!current.startsWith(UNVERIFIED)) {
    if (replacement !== undefined) {
      throw ApiError.unprocessable('A replacement source is accepted only for a rule whose source is UNVERIFIED.', {
        reasonCode: 'source_replacement_not_needed',
      });
    }
    return current;
  }
  const next = replacement?.trim() ?? '';
  if (!next) {
    throw ApiError.unprocessable(
      "This rule's source is UNVERIFIED. Supply the citation it should carry before it is approved.",
      { reasonCode: 'source_unverified' },
    );
  }
  if (next.startsWith(UNVERIFIED)) {
    throw ApiError.unprocessable('A replacement source cannot itself be UNVERIFIED.', {
      reasonCode: 'source_unverified',
    });
  }
  return next;
}

/**
 * Makes a DRAFT or HELD rule resolvable. Four things are checked, and their order
 * is the control:
 *
 * - The approver must not be the author. One person typing a rate and
 *   accepting it is not a check. A row with no recorded author cannot be shown
 *   to pass it, so it is refused too. The founder may approve a rule he wrote
 *   (founderOverride author_is_approver).
 * - The approver must hold the statutory approver duty at this instant. A tenant
 *   with no holder approves nothing (422, awaiting setup); a holder who is not the
 *   caller is refused (403). The holder is resolved, never named in code. The
 *   founder may approve without holding it (founderOverride not_duty_holder).
 * - A row whose citation is UNVERIFIED takes a verified replacement, or stays DRAFT.
 * - An open-ended APPROVED rule for the same series ends the day this one
 *   begins. That makes "next year's rate" a switch rather than an overlap.
 *   It is the only automatic change to another row, and it happens only when
 *   the new rule is open-ended: a bounded rule closing an open rule would leave
 *   a gap after its own end date, so that case is left to the constraint.
 * - The exclusion constraint has the last word. A rule that overlaps an
 *   APPROVED one is refused by the database, and that surfaces as a conflict.
 */
export async function approveStatutoryRule(id: string, opts: { source?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'approve' });

  const row = await prisma.statutoryRule.findFirst({ where: { id } });
  if (!row) throw ApiError.notFound('Statutory rule');
  if (row.status === 'APPROVED') throw ApiError.conflict('This statutory rule is already APPROVED.');
  if (!row.createdBy) {
    throw ApiError.forbidden(
      'This rule has no recorded author, so maker and checker cannot be shown to differ. Re-enter it.',
    );
  }
  // The approver is whoever holds the statutory approver duty at this instant (round 27 c).
  // No holder means no approver exists yet, so nothing becomes APPROVED: the refusal says
  // so, and names the setup rather than a person. A holder who is not the caller is a 403.
  //
  // The founder is exempt from the author check and from the holder check (owner ruling,
  // 2026-10-12: "great, audited exemption it is"). Each check waived is recorded in the audit
  // meta as founderOverride. The citation rule below is not waived by it.
  const approvedAt = new Date();
  const approverId = auth.partyId;
  const founder = await isFounder(approvedAt);
  const founderOverride: FounderOverride[] = [];
  if (row.createdBy === approverId) {
    if (!founder) throw ApiError.forbidden('The author of a statutory rule cannot approve it.');
    founderOverride.push('author_is_approver');
  }
  const holder = await resolveDutyHolder(STATUTORY_APPROVER_DUTY, approvedAt);
  if (founder) {
    if (!holder || holder.partyId !== approverId) founderOverride.push('not_duty_holder');
  } else {
    if (!holder) {
      throw new ApiError(
        422,
        'UNPROCESSABLE',
        "No one holds the statutory approver duty for this tenant, so this rule is awaiting the accountant's setup.",
        { reasonCode: 'statutory_approver_not_set' },
      );
    }
    if (!approverId || holder.partyId !== approverId) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the current statutory approver can approve a statutory rule.', {
        reasonCode: 'not_statutory_approver',
      });
    }
  }
  // A rule whose citation is UNVERIFIED (the seeds are, see seed/compliance/statutory.ts)
  // is approved only with a verified citation supplied now, which is audited beside the
  // old one. A verified rule takes no replacement: changing a citation is a new decision.
  const source = approvalSource(row.source, opts.source);
  // One transaction for the whole approval: the rule, the supersession of the
  // rule it replaces, their audit rows and the event. A failure in any of them
  // must not leave an APPROVED rule with no record of who approved it.
  let approved: typeof row;
  try {
    approved = await governedWrite(async (tx) => {
      let prior: typeof row | null = null;
      if (row.effectiveTo === null) {
        prior = await tx.statutoryRule.findFirst({
          where: {
            tenantId: row.tenantId,
            domain: row.domain,
            key: row.key,
            jurisdiction: row.jurisdiction,
            status: 'APPROVED',
            effectiveTo: null,
            effectiveFrom: { lt: row.effectiveFrom },
          },
        });
        if (prior) {
          await tx.statutoryRule.update({ where: { id: prior.id }, data: { effectiveTo: row.effectiveFrom } });
          await auditWrite({
            action: 'update',
            subjectType: 'statutory_rule',
            subjectId: prior.id,
            before: { effectiveTo: prior.effectiveTo },
            after: { effectiveTo: row.effectiveFrom },
            tx,
          });
        }
      }
      const next = await tx.statutoryRule.update({
        where: { id },
        data: { status: 'APPROVED', approvedBy: approverId, approvedAt, source },
      });
      // The record names the approver as resolved (not as typed), the time, and the rule
      // version: enough to show, years later, which rate a payslip was computed under.
      // value is copied rather than hashed: a JSON hash depends on key order.
      await auditWrite({
        action: 'update',
        subjectType: 'statutory_rule',
        subjectId: id,
        before: { status: row.status, approvedBy: row.approvedBy, approvedAt: row.approvedAt, source: row.source },
        after: { status: 'APPROVED', approvedBy: approverId, approvedAt, source },
        meta: {
          // The duty the approver held, or null when the founder approved without holding it. A
          // holder who is someone else is not named here: the row would read as their approval.
          approver:
            holder && holder.partyId === approverId
              ? { partyId: holder.partyId, dutyKey: holder.dutyKey, dutyAssignmentId: holder.id }
              : null,
          ruleVersion: {
            id,
            domain: row.domain,
            key: row.key,
            jurisdiction: row.jurisdiction,
            effectiveFrom: row.effectiveFrom,
            effectiveTo: row.effectiveTo,
            value: row.value,
          },
          ...(founderOverride.length > 0 ? { founderOverride } : {}),
        },
        tx,
      });
      await emit({
        name: EVENTS.STATUTORY_RULE_APPROVED,
        subject: { entityType: 'statutory_rule', entityId: id },
        previousState: { status: row.status },
        newState: { status: 'APPROVED', domain: row.domain, key: row.key, jurisdiction: row.jurisdiction },
        impact: { domains: ['cmp'] },
        tx,
      });
      return next;
    });
  } catch (err) {
    if (isExclusionViolation(err)) {
      throw ApiError.conflict('This rule overlaps an APPROVED rule for the same domain, key and jurisdiction.');
    }
    throw err;
  }
  return approved;
}

/**
 * Takes an APPROVED rule out of use. It stops resolving at once, and ruleAt then
 * refuses rather than falling back to an older row: a gap is a visible stop, a
 * silent fallback is a wrong payslip.
 *
 * The approval fields are cleared because the database refuses a non-APPROVED row
 * that still names an approver. The audit record keeps who approved it.
 */
export async function holdStatutoryRule(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'edit' });

  const row = await prisma.statutoryRule.findFirst({ where: { id } });
  if (!row) throw ApiError.notFound('Statutory rule');
  if (row.status !== 'APPROVED') throw ApiError.conflict('Only an APPROVED rule can be held.');

  // A hold that is not on the record is a payroll rule that stays in force
  // with nobody answerable for it, so the row, its audit row and its event
  // share one transaction.
  return governedWrite(async (tx) => {
    const next = await tx.statutoryRule.update({
      where: { id },
      data: { status: 'HOLD', approvedBy: null, approvedAt: null },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'statutory_rule',
      subjectId: id,
      before: { status: 'APPROVED', approvedBy: row.approvedBy, approvedAt: row.approvedAt },
      after: { status: 'HOLD', approvedBy: null, approvedAt: null, heldBy: auth.partyId },
      tx,
    });
    await emit({
      name: EVENTS.STATUTORY_RULE_HELD,
      subject: { entityType: 'statutory_rule', entityId: id },
      previousState: { status: 'APPROVED' },
      newState: { status: 'HOLD', domain: row.domain, key: row.key, jurisdiction: row.jurisdiction },
      impact: { domains: ['cmp'] },
      tx,
    });
    return next;
  });
}
