/**
 * Authority over decisions taken on behalf of the organisation.
 *
 * FX-01: `decideApprovalStep` had no `assertCan`, no check that the decider
 * was the step's resolved approver, and no audit row, so any tenant user could
 * approve any open step (platform/approvals.ts:309). These tests drive the
 * real decision path and the real evaluator against real rows. The step is
 * written directly, because the only gate route that opens one to a
 * decidable approver is not reachable from a test with a single chairman.
 */
import { describe, expect, it } from 'vitest';
import { decideApprovalStep } from '../platform/approvals.js';
import { decideAgentAction, propose } from '../agents/index.js';
import type { AiTierCode } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { principalFor, asUser, expectReject, tenantId, unscopedPrisma, withFixtureRole } from './helpers.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/**
 * An open step on the licence-renewal resource, resolved to the Finance Head.
 * finance_head holds it_licences:approve (seed/grants.ts financeHead), so the
 * resolved approver can decide it; nobody else should be able to.
 */
async function openStepResolvedToFinanceHead(): Promise<string> {
  const requester = await principalFor('chairman@kaizen.co.in');
  const approver = await principalFor('finance@kaizen.co.in');
  const step = await unscopedPrisma.approvalStep.create({
    data: {
      tenantId: await tenantId(),
      subjectType: 'it_licence',
      subjectId: `fx01-licence-${stamp()}`,
      subjectLabel: 'FX-01 licence renewal',
      action: 'it_licence.renew',
      resource: 'it_licences',
      requestedById: requester.partyId,
      resolvedApproverId: approver.partyId,
      resolvedApproverRole: 'finance_head',
      resolutionTier: 0,
    },
  });
  return step.id;
}

describe('FX-01 — approval step decisions require the approve grant and the resolved approver', () => {
  it('a user without the approve grant gets 403 and the step stays open', async () => {
    const stepId = await openStepResolvedToFinanceHead();

    // Holds edit on the subject resource but not approve: edit never confers
    // approval authority (platform/approvals.ts, the required_permission gate).
    await withFixtureRole(
      { slug: 'fx01_editor', grants: [{ resource: 'it_licences', verbs: ['view', 'edit'] }] },
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
    const stepId = await openStepResolvedToFinanceHead();

    // Holds approve on the resource, is not the requester, and is not the
    // step's resolved approver (the Finance Head). The grant alone is not
    // enough: the decider must be the approver of record.
    await withFixtureRole(
      { slug: 'fx01_approver_other', grants: [{ resource: 'it_licences', verbs: ['view', 'approve'] }] },
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
    const stepId = await openStepResolvedToFinanceHead();
    const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: stepId } });

    const decided = await asUser('finance@kaizen.co.in', () =>
      decideApprovalStep(stepId, true, 'Approved for FX-01 test.'),
    );
    expect(decided.state).toBe('approved');
    expect(decided.decidedById).toBe(step.resolvedApproverId);

    const row = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: stepId } });
    expect(row.state).toBe('approved');
    expect(row.decidedById).toBe(step.resolvedApproverId);

    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: step.tenantId, subjectType: 'approval_step', subjectId: stepId },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(step.resolvedApproverId);
    expect(JSON.stringify(audit!.diff)).toContain('approved');
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

    const chairman = await principalFor('chairman@kaizen.co.in');
    const updated = await asUser('chairman@kaizen.co.in', () => decideAgentAction(actionId, true, 'Accepted.'));
    expect(updated.state).toBe('executed');

    const row = await unscopedPrisma.agentAction.findFirstOrThrow({ where: { id: actionId } });
    expect(row.state).toBe('executed');
    expect(row.humanActorId).toBe(chairman.partyId);

    // The proposal writes its own create row; this test is about the decision's row.
    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { subjectType: 'agent_action', subjectId: actionId, action: 'update' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(chairman.partyId);
    expect(JSON.stringify(audit!.diff)).toContain('executed');
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
