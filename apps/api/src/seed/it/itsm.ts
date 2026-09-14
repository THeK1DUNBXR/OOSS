/**
 * Technology — incidents, problems and changes seed (docs/plan/cio.md,
 * workstream E). Idempotent: every write here is an upsert, safe to re-run.
 *
 * Three things:
 *  1. The dated `ItItsmPolicy` row — stale-commander minutes, review-overdue
 *     days, which severities require a review (Principle 4: never a constant
 *     in job code).
 *  2. A version 2 of `POL-IT-CHANGE-APPROVAL` naming the real approver chain
 *     for a change (`hr_ops_manager` — the Operations Head, who actually
 *     holds `it_changes:approve` — escalating to `chairman`). Bootstrap
 *     seeds all eight approval-gate policies with one generic legacy-role
 *     placeholder version; `evaluateApprovalGate`'s `loadPolicy` always reads
 *     the highest version number, so this is picked up automatically without
 *     touching bootstrap's own file.
 *
 * No `AuthorityGrant` ceiling is needed for the ordinary (non-self-dealing)
 * path: `evaluateApprovalGate`'s "actor is the resolved-tier approver" rule
 * already permits a `hr_ops_manager` actor directly once tier 0 of
 * `APPROVER_CHAIN` names that role — and seeding one here would race
 * `seedFoundingAccounts`, which bootstrap calls straight after this, before
 * any `hr_ops_manager` affiliation exists to grant it to.
 */

import { unscopedPrisma } from '../../platform/db.js';
import { currentTenantId } from '../../platform/context.js';

const POLICY_CODE = 'POL-IT-CHANGE-APPROVAL';
const AUTHORITY_CLASS = 'it_change_approval';
const APPROVER_CHAIN = ['hr_ops_manager', 'chairman'];

export async function seedItsm(): Promise<void> {
  const tenantId = currentTenantId();

  await unscopedPrisma.itItsmPolicy.upsert({
    where: { tenantId },
    create: {
      tenantId,
      staleMinutes: 60,
      reviewOverdueDays: 5,
      reviewRequiredSeverities: ['sev1', 'sev2'],
    },
    update: {
      staleMinutes: 60,
      reviewOverdueDays: 5,
      reviewRequiredSeverities: ['sev1', 'sev2'],
    },
  });

  const policy = await unscopedPrisma.policy.findFirst({ where: { tenantId, policyCode: POLICY_CODE } });
  if (policy) {
    const v2 = await unscopedPrisma.policyVersion.findFirst({ where: { policyId: policy.id, version: 2 } });
    if (!v2) {
      const created = await unscopedPrisma.policyVersion.create({
        data: {
          tenantId,
          policyId: policy.id,
          version: 2,
          content: {
            requiredPermission: 'it_changes:approve',
            authorityClass: AUTHORITY_CLASS,
            approverResolution: APPROVER_CHAIN,
            escalateToTopTierWhen: { strategicValue: 'high', termMonthsOver: 36 },
            selfDealingBar: true,
            excludedRoles: [],
            appliesTo: { principalTypes: ['human'] },
            escalationGraceBusinessDays: 3,
          },
        },
      });
      await unscopedPrisma.policy.update({ where: { id: policy.id }, data: { currentVersionId: created.id } });
    }
  }
}
