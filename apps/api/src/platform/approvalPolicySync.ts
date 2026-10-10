/**
 * Brings existing tenants' approval-gate ladders up to the declared ones.
 *
 * The seed writes each gate's v1 once and then skips it (seed/bootstrap.ts,
 * the `if (existing) continue` in seedGovernance), so a ladder changed in code
 * never reaches a tenant that was seeded before the change. FX-01 moved
 * POL-IT-POLICY-PUBLISH from ['chairman','finance_head'] to ['chairman'] for
 * the owner decision that IT-policy approvals sit with the chairman alone
 * (docs/plan/cio.md:144). This module carries that change into existing
 * tenants.
 *
 * It never edits a version in place. A ladder change is a new `PolicyVersion`
 * at `max(version) + 1`, which `evaluateApprovalGate` reads as the current
 * one (platform/approvals.ts, loadPolicy). Approval steps already opened under
 * an older version keep the ladder they were opened with: `ApprovalStep` holds
 * the resolved approver, not a pointer to the policy version.
 *
 * It only moves a tenant whose current ladder is exactly the one listed as
 * `from`. A tenant that has set its own ladder keeps it, and the outcome is
 * reported rather than overwritten.
 *
 * Runs once per tenant at boot beside nav and grant sync (server.ts). A second
 * run finds the new version and writes nothing. Two API instances booting at
 * once race on the `(policyId, version)` unique index: one publish wins and
 * the other fails at the insert, before its audit or event.
 */

import { EVENTS } from '@kaizen/shared';
import { prisma, unscopedPrisma } from './db.js';
import { asSystem } from './context.js';
import { assertCan } from './permissions.js';
import { auditWrite } from './audit.js';
import { emit } from './eventBus.js';
import { logger } from './logger.js';

interface LadderConvergence {
  policyCode: string;
  /** The ladder an existing tenant still holds, in order. */
  from: string[];
  /** The ladder the seed now writes for a new tenant (seed/bootstrap.ts gates[]). */
  to: string[];
  /** Why the ladder moved, for the audit row. */
  reason: string;
}

export const LADDER_CONVERGENCES: LadderConvergence[] = [
  {
    policyCode: 'POL-IT-POLICY-PUBLISH',
    from: ['chairman', 'finance_head'],
    to: ['chairman'],
    reason:
      'FX-01: it_policies:approve is held by the chairman alone (docs/plan/cio.md:144); finance_head cannot decide a self-dealing bump',
  },
];

export interface ApprovalPolicySyncResult {
  /** Policy codes that received a new version in this tenant on this run. */
  published: string[];
  /** Policy codes whose current ladder is neither `from` nor `to`; left as the tenant set them. */
  left: string[];
}

/** One tenant's gate ladders brought up to date. Safe to run repeatedly. */
export async function reconcileApprovalGatePolicies(tenantId: string): Promise<ApprovalPolicySyncResult> {
  return asSystem(tenantId, async () => {
    const result: ApprovalPolicySyncResult = { published: [], left: [] };

    for (const c of LADDER_CONVERGENCES) {
      const policy = await prisma.policy.findFirst({ where: { tenantId, policyCode: c.policyCode } });
      if (!policy) continue;

      const current = await prisma.policyVersion.findFirst({
        where: { policyId: policy.id },
        orderBy: { version: 'desc' },
      });
      if (!current) continue;

      const content = current.content as Record<string, unknown> & { approverResolution?: string[] };
      const ladder = content.approverResolution ?? [];
      if (sameLadder(ladder, c.to)) {
        // Converged, but a crash between the version insert and the pointer
        // update leaves the pointer on the old version. Nothing else would
        // ever move it, so the skip repairs it here.
        if (policy.currentVersionId !== current.id) {
          await assertCan({ resource: 'policies', verb: 'edit' });
          await prisma.policy.update({ where: { id: policy.id }, data: { currentVersionId: current.id } });
          await auditWrite({
            action: 'update',
            subjectType: 'policy',
            subjectId: policy.id,
            before: { currentVersionId: policy.currentVersionId },
            after: { currentVersionId: current.id },
            meta: { policyCode: c.policyCode, reason: 'pointer repaired to latest version' },
          });
        }
        continue;
      }
      if (!sameLadder(ladder, c.from)) {
        result.left.push(c.policyCode);
        continue;
      }

      await assertCan({ resource: 'policies', verb: 'edit' });

      // One transaction: the version and the pointer to it land together, so a
      // crash cannot leave the pointer on v1 (the skip above repairs that too).
      const next = await prisma.$transaction(async (tx) => {
        const created = await tx.policyVersion.create({
          data: {
            tenantId,
            policyId: policy.id,
            version: current.version + 1,
            content: { ...content, approverResolution: c.to },
          },
        });
        await tx.policy.update({ where: { id: policy.id }, data: { currentVersionId: created.id } });
        return created;
      });

      await auditWrite({
        action: 'create',
        subjectType: 'policy_version',
        subjectId: next.id,
        before: { version: current.version, approverResolution: ladder },
        after: { version: next.version, approverResolution: c.to },
        meta: { policyCode: c.policyCode, reason: c.reason },
      });
      await emit({
        name: EVENTS.POLICY_VERSION_PUBLISHED,
        subject: { entityType: 'policy_version', entityId: next.id, recordCode: c.policyCode },
        previousState: { version: current.version, approverResolution: ladder },
        newState: { version: next.version, approverResolution: c.to },
        impact: { domains: ['gov'] },
      });

      result.published.push(c.policyCode);
    }

    return result;
  });
}

/**
 * Every tenant, at boot. A tenant that throws is logged with its id and
 * counted in `failed`; the tenants after it still run, so one broken tenant
 * cannot hold back the rest.
 */
export async function reconcileApprovalGatePoliciesForAllTenants(
  run: (tenantId: string) => Promise<ApprovalPolicySyncResult> = reconcileApprovalGatePolicies,
): Promise<{ tenants: number; published: number; failed: number }> {
  const tenants = await unscopedPrisma.tenant.findMany({ select: { id: true } });
  let published = 0;
  let failed = 0;
  for (const t of tenants) {
    try {
      const r = await run(t.id);
      published += r.published.length;
    } catch (error: unknown) {
      failed += 1;
      logger.error({ component: 'boot', tenantId: t.id, err: error }, 'Approval ladder reconcile failed for tenant');
    }
  }
  return { tenants: tenants.length, published, failed };
}

function sameLadder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
