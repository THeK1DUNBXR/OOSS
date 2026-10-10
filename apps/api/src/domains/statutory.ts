import { prisma } from '../platform/db.js';
import { Prisma } from '@prisma/client';
import { EVENTS, istDateKey } from '@kaizen/shared';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan } from '../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';

registerGovernedEntities('cmp_statutory', ['statutory_rule', 'einvoice_submission', 'payroll_statutory_line']);

export interface StatutoryRuleInput {
  domain: string;
  key: string;
  jurisdiction: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  value: Prisma.InputJsonValue;
  source: string;
}

export async function listStatutoryRules(filters: {
  domain?: string;
  key?: string;
  jurisdiction?: string;
} = {}) {
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
 * Thrown instead of falling back to a constant. A missing statutory parameter
 * is a stop, because a silent default is a wrong payslip that surfaces later as
 * a notice.
 */
export class StatutoryRuleNotFoundError extends Error {
  readonly code = 'STATUTORY_RULE_NOT_FOUND';
  constructor(
    readonly key: string,
    readonly jurisdiction: string,
    readonly onDate: string,
  ) {
    super(`No approved statutory rule for ${key} in ${jurisdiction} effective on ${onDate} (IST).`);
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
 * Makes a DRAFT or HELD rule resolvable. Three things happen, and their order
 * is the control:
 *
 * - The approver must not be the author. One person typing a rate and
 *   accepting it is not a check. A row with no recorded author cannot be shown
 *   to pass it, so it is refused too.
 * - An open-ended APPROVED rule for the same series ends the day this one
 *   begins. That makes "next year's rate" a switch rather than an overlap.
 *   It is the only automatic change to another row, and it happens only when
 *   the new rule is open-ended: a bounded rule closing an open rule would leave
 *   a gap after its own end date, so that case is left to the constraint.
 * - The exclusion constraint has the last word. A rule that overlaps an
 *   APPROVED one is refused by the database, and that surfaces as a conflict.
 */
export async function approveStatutoryRule(id: string) {
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
  if (row.createdBy === auth.partyId) throw ApiError.forbidden('The author of a statutory rule cannot approve it.');

  const approvedAt = new Date();
  let committed: { next: typeof row; prior: typeof row | null };
  try {
    committed = await prisma.$transaction(async (tx) => {
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
        }
      }
      const next = await tx.statutoryRule.update({
        where: { id },
        data: { status: 'APPROVED', approvedBy: auth.partyId, approvedAt },
      });
      await emit({
        name: EVENTS.STATUTORY_RULE_APPROVED,
        subject: { entityType: 'statutory_rule', entityId: id },
        previousState: { status: row.status },
        newState: { status: 'APPROVED', domain: row.domain, key: row.key, jurisdiction: row.jurisdiction },
        impact: { domains: ['cmp'] },
        tx,
      });
      return { next, prior };
    });
  } catch (err) {
    if (/23P01|exclusion/i.test(String((err as Error)?.message ?? err))) {
      throw ApiError.conflict('This rule overlaps an APPROVED rule for the same domain, key and jurisdiction.');
    }
    throw err;
  }
  const { next: approved, prior } = committed;

  // Audit runs after commit: auditWrite opens its own transaction and cannot join
  // this one. A failure here leaves an approved row without its audit record,
  // which is the gap to close by giving auditWrite a `tx` option.
  if (prior) {
    await auditWrite({
      action: 'update',
      subjectType: 'statutory_rule',
      subjectId: prior.id,
      before: { effectiveTo: prior.effectiveTo },
      after: { effectiveTo: row.effectiveFrom },
    });
  }
  await auditWrite({
    action: 'update',
    subjectType: 'statutory_rule',
    subjectId: id,
    before: { status: row.status, approvedBy: row.approvedBy, approvedAt: row.approvedAt },
    after: { status: 'APPROVED', approvedBy: auth.partyId, approvedAt },
  });
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

  const held = await prisma.$transaction(async (tx) => {
    const next = await tx.statutoryRule.update({
      where: { id },
      data: { status: 'HOLD', approvedBy: null, approvedAt: null },
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
  await auditWrite({
    action: 'update',
    subjectType: 'statutory_rule',
    subjectId: id,
    before: { status: 'APPROVED', approvedBy: row.approvedBy, approvedAt: row.approvedAt },
    after: { status: 'HOLD', approvedBy: null, approvedAt: null, heldBy: auth.partyId },
  });
  return held;
}
