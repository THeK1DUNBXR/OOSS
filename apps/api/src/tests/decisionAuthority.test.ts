/**
 * Authority over decisions taken on behalf of the organisation.
 *
 * FX-01: `decideApprovalStep` had no `assertCan`, no check that the decider
 * was the step's resolved approver, and no audit row, so any tenant user could
 * approve any open step (platform/approvals.ts:309). These tests drive the
 * real gate and the real evaluator; the only fixture is a role with the grants
 * a test needs.
 */
import { describe, expect, it } from 'vitest';
import { createPolicyDraft, publishPolicy } from '../domains/it/governance.js';
import { decideApprovalStep } from '../platform/approvals.js';
import { decideAgentAction, propose } from '../agents/index.js';
import type { AiTierCode } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { asUser, expectReject, tenantId, unscopedPrisma, withFixtureRole } from './helpers.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/** A self-dealing publish by the chairman opens an approval step to the Finance Head. */
async function openStepToFinanceHead(): Promise<string> {
  const draft = await asUser('chairman@kaizen.co.in', () =>
    createPolicyDraft({ code: `FX01-POL-${stamp()}`, title: 'FX-01 policy', body: 'Body for the FX-01 decision test.' }),
  );
  const gated = await asUser('chairman@kaizen.co.in', () => publishPolicy(draft.id));
  expect(gated.approvalStepId).toBeTruthy();
  const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: gated.approvalStepId! } });
  expect(step.state).toBe('open');
  expect(step.resolvedApproverRole).toBe('finance_head');
  return step.id;
}

describe('FX-01 — approval step decisions require the approve grant and the resolved approver', () => {
  it('a user without the approve grant gets 403 and the step stays open', async () => {
    const stepId = await openStepToFinanceHead();

    // Holds edit on the subject resource but not approve: edit never confers
    // approval authority (platform/approvals.ts, the required_permission gate).
    await withFixtureRole(
      { slug: 'fx01_editor', grants: [{ resource: 'it_policies', verbs: ['view', 'edit'] }] },
      async () => {
        const err = await expectReject(() => decideApprovalStep(stepId, true, 'No grant, should not decide.'));
        expect(err.status).toBe(403);
      },
    );

    const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: stepId } });
    expect(step.state).toBe('open');
    expect(step.decidedById).toBeNull();
  });

  it('a holder of approve who is not the resolved approver gets 403 and the step stays open', async () => {
    const stepId = await openStepToFinanceHead();

    // Holds approve on the resource, is not the requester, and is not the
    // step's resolved approver (the Finance Head). The grant alone is not
    // enough: the decider must be the approver of record.
    await withFixtureRole(
      { slug: 'fx01_approver_other', grants: [{ resource: 'it_policies', verbs: ['view', 'approve'] }] },
      async () => {
        const err = await expectReject(() => decideApprovalStep(stepId, true, 'Not the resolved approver.'));
        expect(err.status).toBe(403);
      },
    );

    const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: stepId } });
    expect(step.state).toBe('open');
    expect(step.decidedById).toBeNull();
  });

  it('the resolved approver decides, and the decision leaves an audit row', async () => {
    const stepId = await openStepToFinanceHead();
    const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: stepId } });

    const decided = await asUser('finance@kaizen.co.in', () =>
      decideApprovalStep(stepId, true, 'Approved for FX-01 test.'),
    );
    expect(decided.state).toBe('approved');
    expect(decided.decidedById).toBe(step.resolvedApproverId);

    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: step.tenantId, subjectType: 'approval_step', subjectId: stepId },
    });
    expect(audit).not.toBeNull();
  });
});

describe('FX-04 — accepting or rejecting an agent proposal requires a grant and leaves an audit row', () => {
  /** A RECOMMEND-tier proposal from the forecast agent, which waits for a human. */
  async function proposeForecast(): Promise<string> {
    const result = await asUser('chairman@kaizen.co.in', async () => {
      const opportunity = await prisma.opportunity.findFirstOrThrow({});
      return propose({
        agentKey: 'agent.forecast',
        tool: 'tool.crm.suggest_forecast_category',
        action: 'opportunity.suggest_forecast',
        subjectType: 'opportunity',
        subjectId: opportunity.id,
        proposal: { to: 'commit' },
        rationale: 'FX-04 test proposal.',
      });
    });
    expect(result.state).toBe('proposed');
    return result.actionId;
  }

  it('a user without the agents approve grant gets 403 and the action stays proposed', async () => {
    const actionId = await proposeForecast();

    await withFixtureRole(
      { slug: 'fx04_reader', grants: [{ resource: 'agents', verbs: ['view', 'edit'] }] },
      async () => {
        const err = await expectReject(() => decideAgentAction(actionId, true, 'Should not execute.'));
        expect(err.status).toBe(403);
      },
    );

    const action = await unscopedPrisma.agentAction.findFirstOrThrow({ where: { id: actionId } });
    expect(action.state).toBe('proposed');
    expect(action.humanActorId).toBeNull();
  });

  it('a granted human accepts the proposal, and the decision leaves an audit row', async () => {
    const actionId = await proposeForecast();

    const updated = await asUser('chairman@kaizen.co.in', () => decideAgentAction(actionId, true, 'Accepted.'));
    expect(updated.state).toBe('executed');

    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { subjectType: 'agent_action', subjectId: actionId },
    });
    expect(audit).not.toBeNull();
  });
});

describe('FX-05 — an action is classified no higher than the agent ceiling', () => {
  it('a READ-ceiling agent calling an AUTONOMOUS touchpoint is clamped to READ and never auto-executes', async () => {
    const tid = await tenantId();
    const agentKey = `fx05.reader.${Date.now()}`;
    const agent = await unscopedPrisma.agentPrincipal.create({
      data: {
        tenantId: tid,
        agentKey,
        name: 'FX-05 reader',
        purpose: 'Test-only READ-ceiling agent declaring an AUTONOMOUS tool.',
        tier: 'READ' satisfies AiTierCode,
        declaredTools: ['tool.crm.route_lead'],
      },
    });

    try {
      const result = await asUser('chairman@kaizen.co.in', () =>
        propose({
          agentKey,
          tool: 'tool.crm.route_lead',
          action: 'lead.route',
          subjectType: 'lead',
          subjectId: 'fx05-subject',
          proposal: {},
          rationale: 'FX-05 probe: READ ceiling, AUTONOMOUS touchpoint.',
        }),
      );
      expect(result.tier).toBe('READ');
      expect(result.state).toBe('proposed');
      expect(result.autoExecuted).toBe(false);
    } finally {
      await unscopedPrisma.agentAction.deleteMany({ where: { agentId: agent.id } });
      await unscopedPrisma.agentPrincipal.delete({ where: { id: agent.id } });
    }
  });
});
