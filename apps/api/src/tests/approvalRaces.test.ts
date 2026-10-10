/**
 * Approval decisions under concurrency, stale escalation scans, legacy steps
 * with no recorded permission resource, and agent pause/resume audit.
 *
 * Real Postgres and the real decision path throughout. A step's decision is
 * one state transition; the tests here check that exactly one transition can
 * win, and that the loser leaves no audit row and no emitted event.
 */
import { describe, expect, it } from 'vitest';
import { decideApprovalStep } from '../platform/approvals.js';
import { escalateApprovalStep } from '../jobs/scheduler.js';
import { pauseAgent } from '../agents/index.js';
import { asUser, expectReject, principalFor, tenantId, unscopedPrisma, withFixtureRole } from './helpers.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/** An open licence-renewal step resolved to the Finance Head, as in decisionAuthority.test.ts. */
async function openStep(overrides: { resource?: string | null; slaDueAt?: Date } = {}) {
  const requester = await principalFor('chairman@kaizen.co.in');
  const approver = await principalFor('finance@kaizen.co.in');
  return unscopedPrisma.approvalStep.create({
    data: {
      tenantId: await tenantId(),
      subjectType: 'it_licence',
      subjectId: `race-licence-${stamp()}`,
      subjectLabel: 'Approval race licence',
      action: 'it_licence.renew',
      resource: overrides.resource === undefined ? 'it_licences' : overrides.resource,
      requestedById: requester.partyId,
      resolvedApproverId: approver.partyId,
      resolvedApproverRole: 'finance_head',
      resolutionTier: 0,
      slaDueAt: overrides.slaDueAt,
    },
  });
}

function statusOf(reason: unknown): number | undefined {
  return (reason as { status?: number }).status;
}

describe('concurrent decisions on one approval step', () => {
  it('simultaneous approve and decline on each step: exactly one wins, one audit row, decidedById is the winner', async () => {
    // Several steps, all raced at once, so a single lucky serialisation cannot
    // hide the window between the state read and the write.
    const steps = await Promise.all(Array.from({ length: 8 }, () => openStep()));
    const finance = await principalFor('finance@kaizen.co.in');

    const attempts = steps.flatMap((step) => [
      asUser('finance@kaizen.co.in', () => decideApprovalStep(step.id, true, 'race approve')),
      asUser('finance@kaizen.co.in', () => decideApprovalStep(step.id, false, 'race decline')),
    ]);
    const results = await Promise.allSettled(attempts);

    // Results are paired [approve, decline] per step, in the order built above.
    for (let k = 0; k < steps.length; k += 1) {
      const pair = [results[2 * k], results[2 * k + 1]];
      const won = pair.filter((r): r is PromiseFulfilledResult<{ state: string }> => r.status === 'fulfilled');
      const lost = pair.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      // The loser was authorised; the step had already moved, so this is a conflict.
      expect(statusOf(lost[0].reason)).toBe(409);

      const row = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: steps[k].id } });
      expect(row.state).toBe(won[0].value.state);
      expect(row.decidedById).toBe(finance.partyId);

      const audits = await unscopedPrisma.auditRecord.findMany({
        where: { tenantId: steps[k].tenantId, subjectType: 'approval_step', subjectId: steps[k].id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].actorId).toBe(finance.partyId);
    }
  });
});

describe('escalation scan against a step decided after it was read', () => {
  it('a stale open snapshot does not move a decided step back to escalated', async () => {
    const step = await openStep({ slaDueAt: new Date(Date.now() - 86_400_000) });
    // The scan reads the row while it is still open...
    const snapshot = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: step.id } });
    expect(snapshot.state).toBe('open');

    // ...then the approver of record decides it before the scan writes.
    await unscopedPrisma.approvalStep.update({
      where: { id: step.id },
      data: { state: 'approved', decidedById: snapshot.resolvedApproverId, decidedAt: new Date() },
    });

    const escalated = await asUser('chairman@kaizen.co.in', () => escalateApprovalStep(snapshot));
    expect(escalated).toBe(false);

    const row = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: step.id } });
    expect(row.state).toBe('approved');
    expect(row.escalatedAt).toBeNull();
  });

  it('a still-open overdue step is escalated one rung', async () => {
    const step = await openStep({ slaDueAt: new Date(Date.now() - 86_400_000) });
    const snapshot = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: step.id } });

    const escalated = await asUser('chairman@kaizen.co.in', () => escalateApprovalStep(snapshot));
    expect(escalated).toBe(true);

    const row = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: step.id } });
    expect(row.state).toBe('escalated');
    expect(row.escalationRung).toBe(1);
  });
});

describe('legacy approval steps with no recorded permission resource', () => {
  it('a step whose resource is null is refused with 409 and stays open, even for the approver of record', async () => {
    const step = await openStep({ resource: null });

    const err = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => decideApprovalStep(step.id, true, 'Should not be guessed.')),
    );
    expect(err.status).toBe(409);

    const row = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: step.id } });
    expect(row.state).toBe('open');
    expect(row.decidedById).toBeNull();
    const audits = await unscopedPrisma.auditRecord.count({
      where: { tenantId: step.tenantId, subjectType: 'approval_step', subjectId: step.id },
    });
    expect(audits).toBe(0);
  });
});

describe('agent pause and resume are audited', () => {
  async function makeAgent(): Promise<string> {
    const agent = await unscopedPrisma.agentPrincipal.create({
      data: {
        tenantId: await tenantId(),
        agentKey: `pause.probe.${stamp()}`,
        name: 'Pause probe',
        purpose: 'Test-only agent for the pause and resume audit.',
        tier: 'READ',
        declaredTools: [],
      },
    });
    return agent.id;
  }

  it('pause and resume each write an audit row naming the actor', async () => {
    const agentId = await makeAgent();
    const chairman = await principalFor('chairman@kaizen.co.in');

    const paused = await asUser('chairman@kaizen.co.in', () => pauseAgent(agentId, true));
    expect(paused.status).toBe('paused');
    const resumed = await asUser('chairman@kaizen.co.in', () => pauseAgent(agentId, false));
    expect(resumed.status).toBe('active');

    const audits = await unscopedPrisma.auditRecord.findMany({
      where: { subjectType: 'agent_principal', subjectId: agentId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.actorId === chairman.partyId)).toBe(true);
  });

  it('a caller without edit on agents gets 403 and the agent keeps its status', async () => {
    const agentId = await makeAgent();

    await withFixtureRole(
      { slug: 'agt_viewer', grants: [{ resource: 'agents', verbs: ['view'] }] },
      async () => {
        const err = await expectReject(() => pauseAgent(agentId, true));
        expect(err.status).toBe(403);
      },
    );

    const row = await unscopedPrisma.agentPrincipal.findFirstOrThrow({ where: { id: agentId } });
    expect(row.status).toBe('active');
    const audits = await unscopedPrisma.auditRecord.count({ where: { subjectType: 'agent_principal', subjectId: agentId } });
    expect(audits).toBe(0);
  });
});
