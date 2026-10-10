/**
 * Existing tenants converge on the FX-01 IT-policy publish ladder.
 *
 * The seed skips a gate policy whose v1 already exists, so a tenant seeded
 * before FX-01 keeps v1 `['chairman','finance_head']`. A self-dealing IT-policy
 * publish then bumps to finance_head, who holds no it_policies:approve, and the
 * step can never be decided. The reconcile publishes a v2 with the chairman
 * ladder; these tests pin that it routes the bump to the chairman, and that a
 * second run does not write a third version.
 *
 * Serial by construction (vitest.config.ts): the legacy state is set up on the
 * kaizen tenant, which the governance tests share.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';
import { createPolicyDraft, publishPolicy } from '../domains/it/governance.js';
import {
  reconcileApprovalGatePolicies,
  reconcileApprovalGatePoliciesForAllTenants,
} from '../platform/approvalPolicySync.js';

const POLICY_CODE = 'POL-IT-POLICY-PUBLISH';
const LEGACY_LADDER = ['chairman', 'finance_head'];

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/** A drafter publishing their own draft: the Self-Dealing Bar opens a step and names the resolved approver. */
async function selfDealingApproverRole(): Promise<string | null> {
  const draft = await asUser('chairman@kaizen.co.in', () =>
    createPolicyDraft({
      code: `IT-POL-CONV-${stamp()}`,
      title: 'Convergence probe',
      body: 'Body for the convergence probe.',
    }),
  );
  const gated = await asUser('chairman@kaizen.co.in', () => publishPolicy(draft.id));
  expect(gated.applied).toBe(false);
  const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: gated.approvalStepId! } });
  return step.resolvedApproverRole;
}

describe('approval gate convergence for tenants seeded before FX-01', () => {
  let kaizen: string;
  let policyId: string;

  beforeAll(async () => {
    kaizen = await tenantId('kaizen');
    const policy = await unscopedPrisma.policy.findFirstOrThrow({
      where: { tenantId: kaizen, policyCode: POLICY_CODE },
    });
    policyId = policy.id;
    // Rebuild the pre-FX-01 state: no later version, v1 carrying the old ladder.
    await unscopedPrisma.policyVersion.deleteMany({ where: { policyId, version: { gt: 1 } } });
    const v1 = await unscopedPrisma.policyVersion.findFirstOrThrow({ where: { policyId, version: 1 } });
    await unscopedPrisma.policyVersion.update({
      where: { id: v1.id },
      data: { content: { ...(v1.content as Record<string, unknown>), approverResolution: LEGACY_LADDER } },
    });
    await unscopedPrisma.policy.update({ where: { id: policyId }, data: { currentVersionId: v1.id } });
  });

  it('before reconcile, a self-dealing IT-policy publish on a legacy tenant routes to finance_head', async () => {
    expect(await selfDealingApproverRole()).toBe('finance_head');
  });

  it('reconcile publishes v2 with the chairman ladder, and the next publish routes to chairman', async () => {
    const first = await reconcileApprovalGatePolicies(kaizen);
    expect(first.published).toEqual([POLICY_CODE]);

    const latest = await unscopedPrisma.policyVersion.findFirstOrThrow({
      where: { policyId, version: 2 },
    });
    expect((latest.content as { approverResolution: string[] }).approverResolution).toEqual(['chairman']);

    const policy = await unscopedPrisma.policy.findFirstOrThrow({ where: { id: policyId } });
    expect(policy.currentVersionId).toBe(latest.id);

    expect(await selfDealingApproverRole()).toBe('chairman');
  });

  it('running reconcile again creates no further version', async () => {
    const second = await reconcileApprovalGatePolicies(kaizen);
    expect(second.published).toEqual([]);

    const versions = await unscopedPrisma.policyVersion.findMany({ where: { policyId }, orderBy: { version: 'asc' } });
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });
  it('a current-version pointer left on v1 is repaired even though the latest version already has the chairman ladder', async () => {
    const policy = await unscopedPrisma.policy.findFirstOrThrow({ where: { id: policyId } });
    const v1 = await unscopedPrisma.policyVersion.findFirstOrThrow({ where: { policyId, version: 1 } });
    const v2 = await unscopedPrisma.policyVersion.findFirstOrThrow({ where: { policyId, version: 2 } });
    // The state a crash between the version insert and the pointer update leaves behind.
    await unscopedPrisma.policy.update({ where: { id: policy.id }, data: { currentVersionId: v1.id } });

    const repaired = await reconcileApprovalGatePolicies(kaizen);
    expect(repaired.published).toEqual([]);

    const after = await unscopedPrisma.policy.findFirstOrThrow({ where: { id: policy.id } });
    expect(after.currentVersionId).toBe(v2.id);
    expect(await unscopedPrisma.policyVersion.count({ where: { policyId } })).toBe(2);
  });

  it('one tenant that throws does not stop the tenants after it from converging', async () => {
    const stampB = stamp();
    const tenantB = await unscopedPrisma.tenant.create({
      data: { name: 'Convergence probe B', slug: `conv-b-${stampB}` },
    });
    const policyB = await unscopedPrisma.policy.create({
      data: {
        tenantId: tenantB.id,
        policyCode: POLICY_CODE,
        name: 'Technology policy publication',
        kind: 'approval_gate',
      },
    });
    const v1B = await unscopedPrisma.policyVersion.create({
      data: {
        tenantId: tenantB.id,
        policyId: policyB.id,
        version: 1,
        content: {
          requiredPermission: 'it_policies:approve',
          authorityClass: 'it_policy_publish',
          approverResolution: LEGACY_LADDER,
          escalateToTopTierWhen: { strategicValue: 'high', termMonthsOver: 36 },
          selfDealingBar: true,
          excludedRoles: ['system_admin'],
          appliesTo: { principalTypes: ['human'] },
          escalationGraceBusinessDays: 3,
        },
      },
    });
    await unscopedPrisma.policy.update({ where: { id: policyB.id }, data: { currentVersionId: v1B.id } });

    // kaizen is made to throw; the run must report it and still converge tenant B.
    const run = (tenant: string) => {
      if (tenant === kaizen) throw new Error('simulated tenant failure');
      return reconcileApprovalGatePolicies(tenant);
    };
    const summary = await reconcileApprovalGatePoliciesForAllTenants(run);
    expect(summary.failed).toBe(1);

    const latestB = await unscopedPrisma.policyVersion.findFirstOrThrow({
      where: { policyId: policyB.id, version: 2 },
    });
    expect((latestB.content as { approverResolution: string[] }).approverResolution).toEqual(['chairman']);
    const pointerB = await unscopedPrisma.policy.findFirstOrThrow({ where: { id: policyB.id } });
    expect(pointerB.currentVersionId).toBe(latestB.id);
  });
});
