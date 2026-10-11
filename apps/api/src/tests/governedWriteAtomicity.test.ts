/**
 * A governed write and its audit row and event commit or vanish together.
 *
 * Before this, the domain write committed first and `auditWrite` / `emit` ran
 * afterwards in their own transactions: a failure between them left a changed
 * row with no audit record and no outbox event. These tests make the audit
 * insert fail on purpose (a test-only trigger on audit_records, installed for
 * the length of one call) and check that the domain row is back where it was
 * and that no outbox row was written for the event.
 *
 * Real Postgres and the real decision paths throughout. The trigger is a
 * fault injection, not a mock: the insert really is refused by the database.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { decideApprovalStep } from '../platform/approvals.js';
import { decideAgentAction, propose } from '../agents/index.js';
import { completeTask } from '../domains/tasks.js';
import { prisma } from '../platform/db.js';
import { asUser, principalFor, tenantId, unscopedPrisma } from './helpers.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const INJECTED = 'injected audit failure';

async function refuseAuditInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION w2_refuse_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION '${INJECTED}'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER w2_refuse_audit_insert BEFORE INSERT ON audit_records
     FOR EACH ROW EXECUTE FUNCTION w2_refuse_audit_insert()`,
  );
}

async function restoreAuditInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w2_refuse_audit_insert ON audit_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w2_refuse_audit_insert()`);
}

afterEach(restoreAuditInserts);

async function outboxCount(eventName: string): Promise<number> {
  return unscopedPrisma.outboxEvent.count({ where: { tenantId: await tenantId(), eventName } });
}

async function openApprovalStep() {
  const requester = await principalFor('chairman@kaizen.co.in');
  const approver = await principalFor('finance@kaizen.co.in');
  return unscopedPrisma.approvalStep.create({
    data: {
      tenantId: await tenantId(),
      subjectType: 'it_licence',
      subjectId: `w2-atomic-licence-${stamp()}`,
      subjectLabel: 'Atomicity probe licence',
      action: 'it_licence.renew',
      resource: 'it_licences',
      requestedById: requester.partyId,
      resolvedApproverId: approver.partyId,
      resolvedApproverRole: 'finance_head',
      resolutionTier: 0,
    },
  });
}

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
      rationale: 'Atomicity probe.',
    });
  });
  return result.actionId;
}

describe('governed writes commit with their audit row and event, or not at all', () => {
  it('control: an approval decision with audit available writes the state, the audit row and the outbox event', async () => {
    const step = await openApprovalStep();
    const before = await outboxCount(EVENTS.APPROVAL_STEP_DECIDED);

    await asUser('finance@kaizen.co.in', () => decideApprovalStep(step.id, true, 'control'));

    const after = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: step.id } });
    expect(after.state).toBe('approved');
    expect(await outboxCount(EVENTS.APPROVAL_STEP_DECIDED)).toBe(before + 1);
  });

  it('approval decision: an audit failure rolls back the state change and writes no outbox event', async () => {
    const step = await openApprovalStep();
    const before = await outboxCount(EVENTS.APPROVAL_STEP_DECIDED);

    await refuseAuditInserts();
    await expect(asUser('finance@kaizen.co.in', () => decideApprovalStep(step.id, true, 'injected'))).rejects.toThrow(
      INJECTED,
    );
    await restoreAuditInserts();

    const after = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: step.id } });
    expect(after.state).toBe('open');
    expect(after.decidedById).toBeNull();
    expect(await outboxCount(EVENTS.APPROVAL_STEP_DECIDED)).toBe(before);
  });

  it('task completion: an audit failure leaves the task open and writes no outbox event', async () => {
    const tid = await tenantId();
    const task = await unscopedPrisma.task.create({
      data: { tenantId: tid, recordCode: `TSK-W2-ATOM-${stamp()}`, title: 'Atomicity probe', status: 'open' },
    });
    const before = await outboxCount(EVENTS.TASK_COMPLETED);

    await refuseAuditInserts();
    await expect(asUser('chairman@kaizen.co.in', () => completeTask(task.id))).rejects.toThrow(INJECTED);
    await restoreAuditInserts();

    const after = await unscopedPrisma.task.findFirstOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('open');
    expect(after.completedAt).toBeNull();
    expect(await outboxCount(EVENTS.TASK_COMPLETED)).toBe(before);
  });

  it('agent action decision: an audit failure leaves the proposal proposed and writes no outbox event', async () => {
    const actionId = await proposeForecast();
    const before = await outboxCount(EVENTS.AGENT_ACTION_EXECUTED);

    await refuseAuditInserts();
    await expect(asUser('chairman@kaizen.co.in', () => decideAgentAction(actionId, true, 'injected'))).rejects.toThrow(
      INJECTED,
    );
    await restoreAuditInserts();

    const after = await unscopedPrisma.agentAction.findFirstOrThrow({ where: { id: actionId } });
    expect(after.state).toBe('proposed');
    expect(after.humanActorId).toBeNull();
    expect(await outboxCount(EVENTS.AGENT_ACTION_EXECUTED)).toBe(before);
  });
});
