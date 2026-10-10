/**
 * Two humans deciding the same AI proposal at once. Mirrors approvalRaces.test.ts:
 * exactly one decision wins, the loser leaves no audit row, and the human of
 * record is the winner.
 */
import { describe, expect, it } from 'vitest';
import { decideAgentAction, propose } from '../agents/index.js';
import { prisma } from '../platform/db.js';
import { asUser, principalFor, unscopedPrisma } from './helpers.js';

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
      rationale: 'Concurrent decide probe.',
    });
  });
  return result.actionId;
}

describe('concurrent decisions on one agent action', () => {
  it('simultaneous accept and reject on each proposal: exactly one wins, one audit row, humanActorId is the winner', async () => {
    const actionIds = await Promise.all(Array.from({ length: 6 }, () => proposeForecast()));

    const attempts = actionIds.flatMap((id) => [
      asUser('chairman@kaizen.co.in', () => decideAgentAction(id, true, 'race accept')),
      asUser('chairman@kaizen.co.in', () => decideAgentAction(id, false, 'race reject')),
    ]);
    const results = await Promise.allSettled(attempts);
    const chairman = await principalFor('chairman@kaizen.co.in');

    for (let k = 0; k < actionIds.length; k += 1) {
      const pair = [results[2 * k], results[2 * k + 1]];
      const won = pair.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const lost = pair.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0] as { status?: number }).status).toBe(409);

      const row = await unscopedPrisma.agentAction.findFirstOrThrow({ where: { id: actionIds[k] } });
      expect(row.state).toBe(won[0].state);
      expect(row.humanActorId).toBe(chairman.partyId);

      const audits = await unscopedPrisma.auditRecord.findMany({
        where: { subjectType: 'agent_action', subjectId: actionIds[k] },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].actorId).toBe(chairman.partyId);
    }
  });
});
