/**
 * FX-22 — every capability write leaves an audit row.
 *
 * skill, evidence and the claim writes in domains/capability.ts used to commit
 * with no auditWrite at all, so the skills directory and the claims behind
 * staffing and pay could change with no trace of who changed them. Each write
 * below is checked against the AuditRecord it should now leave.
 */

import { describe, expect, it } from 'vitest';
import { addEvidence, assertClaim, changeClaimState, createSkill, recordContradiction } from '../domains/capability.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

async function auditFor(subjectType: string, subjectId: string) {
  return unscopedPrisma.auditRecord.findMany({ where: { subjectType, subjectId } });
}

describe('capability writes are audited [FX-22]', () => {
  it('createSkill writes a skill audit row', async () => {
    const skill = await asUser('hr@kaizen.co.in', () => createSkill({ name: `W1C audit skill ${stamp()}` }));
    const rows = await auditFor('skill', skill.id);
    expect(rows.map((r) => r.action)).toContain('create');
  });

  it('assertClaim writes a capability_claim audit row', async () => {
    const tid = await tenantId();
    const arun = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'arun@kaizen.co.in' } });
    const skill = await unscopedPrisma.skill.create({ data: { tenantId: tid, name: `W1C claim skill ${stamp()}` } });
    const claim = await asUser('hr@kaizen.co.in', () =>
      assertClaim({ partyId: arun.personId, skillId: skill.id, tier: 'claimed' }),
    );
    const rows = await auditFor('capability_claim', claim.id);
    expect(rows.map((r) => r.action)).toContain('create');
  });

  it('addEvidence writes an evidence audit row', async () => {
    const tid = await tenantId();
    const arun = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'arun@kaizen.co.in' } });
    const skill = await unscopedPrisma.skill.create({ data: { tenantId: tid, name: `W1C evidence skill ${stamp()}` } });
    const claim = await asUser('hr@kaizen.co.in', () =>
      assertClaim({ partyId: arun.personId, skillId: skill.id, tier: 'claimed' }),
    );
    const evidence = await asUser('hr@kaizen.co.in', () =>
      addEvidence(claim.id, { description: 'Delivered the Q2 cohort' }),
    );
    const rows = await auditFor('evidence', evidence.id);
    expect(rows.map((r) => r.action)).toContain('create');
  });

  it('recordContradiction writes a capability_claim audit row', async () => {
    const tid = await tenantId();
    const arun = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'arun@kaizen.co.in' } });
    const skill = await unscopedPrisma.skill.create({ data: { tenantId: tid, name: `W1C contra skill ${stamp()}` } });
    const claim = await asUser('hr@kaizen.co.in', () =>
      assertClaim({ partyId: arun.personId, skillId: skill.id, tier: 'claimed' }),
    );
    await asUser('hr@kaizen.co.in', () =>
      recordContradiction(claim.id, { type: 'level_conflict', score: 0.9, detail: 'Two sources disagree' }),
    );
    const rows = await auditFor('capability_claim', claim.id);
    expect(rows.map((r) => r.action)).toContain('update');
  });

  it('changeClaimState writes a capability_claim audit row', async () => {
    const tid = await tenantId();
    const arun = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'arun@kaizen.co.in' } });
    const skill = await unscopedPrisma.skill.create({ data: { tenantId: tid, name: `W1C state skill ${stamp()}` } });
    const claim = await asUser('hr@kaizen.co.in', () =>
      assertClaim({ partyId: arun.personId, skillId: skill.id, tier: 'assessed' }),
    );
    await asUser('hr@kaizen.co.in', () => changeClaimState(claim.id, 'contradicted', 'Assessor retracted the score'));
    const rows = await auditFor('capability_claim', claim.id);
    expect(rows.map((r) => r.action)).toContain('update');
  });
});
