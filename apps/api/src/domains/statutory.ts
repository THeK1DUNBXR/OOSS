import { prisma } from '../platform/db.js';
import { Prisma } from '@prisma/client';
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

/** Resolves the tenant's rule in force on a date. Missing rules fail closed. */
export async function statutoryRuleAt(domain: string, key: string, jurisdiction: string, at: Date) {
  const auth = currentAuth();
  const row = await prisma.statutoryRule.findFirst({
    where: {
      tenantId: auth.tenantId,
      domain,
      key,
      jurisdiction,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!row) throw ApiError.unprocessable(`No statutory rule is effective for ${domain}/${key} in ${jurisdiction}.`);
  return row;
}
