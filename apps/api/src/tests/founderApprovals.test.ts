/**
 * The founder exemption at the three approval sites that are not the statutory rule
 * (owner ruling, 2026-10-12): "The founder is end all be all, he can do whatever he wants."
 *
 * The founder is exempt from maker-checker and segregation of duties: the Self-Dealing Bar on
 * decide (platform/approvals.ts decideApprovalStep), the routing check on decide (the same
 * function), the refund requester-is-approver check (compliance/corporate/refunds.ts approveRefund)
 * and the salary-structure proposer-is-approver check (compliance/payroll.ts approveSalaryStructure).
 * Each waived check is recorded in the audit row's meta as founderOverride.
 *
 * Not waived, and asserted here: an AI principal deciding, the approve grant itself, and the
 * open-time reroute (a founder-requested step still routes to someone else).
 *
 * The founder is the seeded OWNER account's person (chairman@kaizen.co.in). The non-founder
 * cases are fixture principals. Real Postgres, no mocks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApprovalStep } from '../platform/approvals.js';
import { approveRefund } from '../domains/compliance/corporate/refunds.js';
import { approveSalaryStructure } from '../domains/compliance/payroll.js';
import { seedFounderDuty } from '../seed/compliance/statutory.js';
import {
  asPrincipal,
  asUser,
  authFor,
  expectReject,
  principalFor,
  tenantId,
  unscopedPrisma,
  withFixtureRole,
} from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const REQUESTER = 'hr@kaizen.co.in';
const OTHER_APPROVER = 'finance@kaizen.co.in';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

let tid: string;

async function auditFor(subjectType: string, subjectId: string, action: 'create' | 'update') {
  const row = await unscopedPrisma.auditRecord.findFirst({
    where: { subjectType, subjectId, action },
    orderBy: { seq: 'desc' },
  });
  if (!row) throw new Error(`No ${action} audit row for ${subjectType} ${subjectId}.`);
  return row;
}

/** An open approval step on it_licences, resolved as the caller names it. */
async function openStep(opts: { requestedById: string; resolvedApproverId: string; resolvedApproverRole: string }) {
  const step = await unscopedPrisma.approvalStep.create({
    data: {
      tenantId: tid,
      subjectType: 'it_licence',
      subjectId: `fa-licence-${stamp()}`,
      subjectLabel: 'Founder exemption licence renewal',
      action: 'it_licence.renew',
      resource: 'it_licences',
      requestedById: opts.requestedById,
      resolvedApproverId: opts.resolvedApproverId,
      resolvedApproverRole: opts.resolvedApproverRole,
      resolutionTier: 0,
    },
  });
  return step.id;
}

beforeAll(async () => {
  tid = await tenantId();
  // The founder is in place before the tests run (the seed assigns it when none is current).
  const owner = await asUser(CHAIRMAN, async (c) => c.partyId);
  await asUser(CHAIRMAN, () => seedFounderDuty(owner, 'chairman'));
});

afterAll(async () => {
  await unscopedPrisma.approvalStep.deleteMany({ where: { tenantId: tid, subjectId: { startsWith: 'fa-licence-' } } });
});

describe('decideApprovalStep: the founder exemption on the Self-Dealing Bar and the routing check', () => {
  it('(a) the founder deciding his own request succeeds, and the audit meta names author_is_approver', async () => {
    const founder = await principalFor(CHAIRMAN);
    const stepId = await openStep({
      requestedById: founder.partyId,
      resolvedApproverId: founder.partyId,
      resolvedApproverRole: founder.roleSlug,
    });

    const decided = await asUser(CHAIRMAN, () => decideApprovalStep(stepId, true, 'Founder approves own request.'));
    expect(decided.state).toBe('approved');
    expect(decided.decidedById).toBe(founder.partyId);

    const meta = (await auditFor('approval_step', stepId, 'update')).meta as Record<string, unknown>;
    expect(meta.founderOverride).toEqual(['author_is_approver']);
  });

  it('(b) a non-founder deciding his own request is still refused with the same error, and the step stays open', async () => {
    await withFixtureRole(
      { slug: 'fa_self_decider', grants: [{ resource: 'it_licences', verbs: ['view', 'approve'] }] },
      async (p) => {
        const stepId = await openStep({
          requestedById: p.partyId,
          resolvedApproverId: p.partyId,
          resolvedApproverRole: p.roleSlug,
        });
        const err = await expectReject(() => asPrincipal(authFor(p), () => decideApprovalStep(stepId, true, 'Self.')));
        expect(err.status).toBe(403);
        expect(err.message).toBe('The Self-Dealing Bar is unconditional: a requester may never approve their own step.');

        const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: stepId } });
        expect(step.state).toBe('open');
      },
    );
  });

  it('(c) the founder deciding a step routed to someone else succeeds, and the audit meta names not_resolved_approver', async () => {
    const requester = await principalFor(REQUESTER);
    const other = await principalFor(OTHER_APPROVER);
    const stepId = await openStep({
      requestedById: requester.partyId,
      resolvedApproverId: other.partyId,
      resolvedApproverRole: other.roleSlug,
    });

    const decided = await asUser(CHAIRMAN, () => decideApprovalStep(stepId, false, 'Founder declines.'));
    expect(decided.state).toBe('declined');
    expect(decided.decidedById).not.toBe(other.partyId);

    const meta = (await auditFor('approval_step', stepId, 'update')).meta as Record<string, unknown>;
    expect(meta.founderOverride).toEqual(['not_resolved_approver']);
  });

  it('(c) a non-founder with the approve grant deciding a step routed to someone else is still refused', async () => {
    const requester = await principalFor(REQUESTER);
    const other = await principalFor(OTHER_APPROVER);
    const stepId = await openStep({
      requestedById: requester.partyId,
      resolvedApproverId: other.partyId,
      resolvedApproverRole: other.roleSlug,
    });

    await withFixtureRole(
      { slug: 'fa_not_routed', grants: [{ resource: 'it_licences', verbs: ['view', 'approve'] }] },
      async (p) => {
        const err = await expectReject(() => asPrincipal(authFor(p), () => decideApprovalStep(stepId, true, 'Not mine.')));
        expect(err.status).toBe(403);
        expect(err.message).toMatch(/only that approver of record may decide it/);
      },
    );

    const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: stepId } });
    expect(step.state).toBe('open');
  });

  it('(d) an agent principal is refused even when the agent acts under the founder party', async () => {
    const requester = await principalFor(REQUESTER);
    const founder = await principalFor(CHAIRMAN);
    const stepId = await openStep({
      requestedById: requester.partyId,
      resolvedApproverId: founder.partyId,
      resolvedApproverRole: founder.roleSlug,
    });

    const agentAsFounder = authFor(founder, { principalType: 'agent', agentId: 'fa-test-agent' });
    const err = await expectReject(() => asPrincipal(agentAsFounder, () => decideApprovalStep(stepId, true, 'Agent.')));
    expect(err.status).toBe(403);
    expect(err.message).toBe('An AI principal may never decide an approval step.');

    const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: stepId } });
    expect(step.state).toBe('open');
  });
});

describe('approveRefund: the founder exemption on requester-is-approver', () => {
  /** The chairman holds refunds:approve and is named in the MFA policy; enrol it for the call, then put it back. */
  async function withChairmanMfa<T>(fn: () => Promise<T>): Promise<T> {
    const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email: CHAIRMAN, tenantId: tid } });
    const before = { mfaSecret: user.mfaSecret, mfaEnabledAt: user.mfaEnabledAt };
    await unscopedPrisma.user.update({ where: { id: user.id }, data: { mfaEnabledAt: new Date() } });
    try {
      return await fn();
    } finally {
      await unscopedPrisma.user.update({ where: { id: user.id }, data: before });
    }
  }

  async function requestedRefund(requestedById: string) {
    return unscopedPrisma.refund.create({
      data: {
        tenantId: tid,
        recordCode: `FA-REF-${stamp()}`,
        receiptId: `REC-fa-${stamp()}`,
        amount: 500,
        reason: 'Founder exemption fixture',
        status: 'requested',
        requestedById,
      },
    });
  }

  it('(a) the founder approving his own refund succeeds, and the audit meta names author_is_approver', async () => {
    const founder = await principalFor(CHAIRMAN);
    const refund = await requestedRefund(founder.partyId);

    const approved = await withChairmanMfa(() => asUser(CHAIRMAN, () => approveRefund(refund.id)));
    expect(approved.status).toBe('approved');
    expect(approved.approvedById).toBe(founder.partyId);

    const meta = (await auditFor('refund', refund.id, 'update')).meta as Record<string, unknown>;
    expect(meta.founderOverride).toEqual(['author_is_approver']);
  });

  it('(b) a non-founder approving his own refund is still refused with the same error', async () => {
    await withFixtureRole({ slug: 'fa_refund_self', grants: [{ resource: 'refunds', verbs: ['view', 'approve'] }] }, async (p) => {
      const refund = await requestedRefund(p.partyId);
      const err = await expectReject(() => asPrincipal(authFor(p), () => approveRefund(refund.id)));
      expect(err.status).toBe(403);
      expect(err.message).toBe('The person who requested a refund cannot also approve it.');

      const after = await unscopedPrisma.refund.findFirstOrThrow({ where: { id: refund.id } });
      expect(after.status).toBe('requested');
    });
  });
});

describe('approveSalaryStructure: the founder exemption on proposer-is-approver', () => {
  async function proposedStructure(proposedById: string) {
    return unscopedPrisma.salaryStructure.create({
      data: {
        tenantId: tid,
        employmentRelationshipId: `fa-emp-${stamp()}`,
        effectiveFrom: new Date('2026-04-01T00:00:00.000Z'),
        ctcAnnual: 300000,
        basic: 15000,
        hra: 6000,
        specialAllowance: 4000,
        status: 'Proposed',
        proposedById,
      },
    });
  }

  it('(a) the founder approving a structure he proposed succeeds, and the audit meta names author_is_approver', async () => {
    const founder = await principalFor(CHAIRMAN);
    const structure = await proposedStructure(founder.partyId);

    const approved = await asUser(CHAIRMAN, () => approveSalaryStructure(structure.id));
    expect(approved.status).toBe('Approved');
    expect(approved.approvedById).toBe(founder.partyId);

    const meta = (await auditFor('salary_structure', structure.id, 'update')).meta as Record<string, unknown>;
    expect(meta.founderOverride).toEqual(['author_is_approver']);
  });

  it('(b) a non-founder approving a structure he proposed is still refused with the same error', async () => {
    await withFixtureRole(
      { slug: 'fa_salary_self', grants: [{ resource: 'salary_structures', verbs: ['view', 'approve'] }] },
      async (p) => {
        const structure = await proposedStructure(p.partyId);
        const err = await expectReject(() => asPrincipal(authFor(p), () => approveSalaryStructure(structure.id)));
        expect(err.status).toBe(403);
        expect(err.message).toMatch(/Self-Dealing Bar/);

        const after = await unscopedPrisma.salaryStructure.findFirstOrThrow({ where: { id: structure.id } });
        expect(after.status).toBe('Proposed');
      },
    );
  });
});
