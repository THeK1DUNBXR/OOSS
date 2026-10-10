import { prisma } from '../platform/db.js';
import { Prisma } from '@prisma/client';
import { istDateKey } from '@kaizen/shared';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan } from '../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';

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
  const overlap = await prisma.statutoryRule.findFirst({
    where: {
      tenantId: auth.tenantId,
      domain: input.domain,
      key: input.key,
      jurisdiction: input.jurisdiction,
      effectiveFrom: { lt: input.effectiveTo ?? new Date('9999-12-31T00:00:00.000Z') },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.effectiveFrom } }],
    },
  });
  if (overlap) throw ApiError.conflict('A statutory rule already covers part of this effective period.');
  const row = await prisma.statutoryRule.create({ data: { tenantId: auth.tenantId, ...input } });
  await auditWrite({ action: 'create', subjectType: 'statutory_rule', subjectId: row.id, after: row });
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
export async function ruleAt(key: string, jurisdiction: string, at: Date) {
  const auth = currentAuth();
  const onDate = istDateKey(at);
  const day = new Date(`${onDate}T00:00:00.000Z`);
  const row = await prisma.statutoryRule.findFirst({
    where: {
      tenantId: auth.tenantId,
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
