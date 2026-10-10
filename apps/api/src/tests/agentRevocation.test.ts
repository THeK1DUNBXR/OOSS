/**
 * Revoking an authority grant is the Chairman's kill-switch: it takes every
 * automation and agent relying on the grant dark. The service must check the
 * grants edit verb itself, not rely on the route, and must leave an audit row
 * naming the actor (CLAUDE.md rule 5).
 */
import { describe, expect, it } from 'vitest';
import { revokeAuthority } from '../agents/index.js';
import { asUser, expectReject, principalFor, tenantId, unscopedPrisma, withFixtureRole } from './helpers.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function makeGrant(): Promise<string> {
  const chairman = await principalFor('chairman@kaizen.co.in');
  const grant = await unscopedPrisma.authorityGrant.create({
    data: {
      tenantId: await tenantId(),
      principalType: 'human',
      principalId: chairman.partyId,
      principalLabel: `revoke probe ${stamp()}`,
      authorityClass: 'agent_draft',
      status: 'active',
    },
  });
  return grant.id;
}

describe('revoking an authority grant is granted and audited', () => {
  it('a caller without edit on grants gets 403 and the grant stays active', async () => {
    const grantId = await makeGrant();

    await withFixtureRole({ slug: 'rev_viewer', grants: [{ resource: 'grants', verbs: ['view'] }] }, async () => {
      const err = await expectReject(() => revokeAuthority(grantId, 'Should not be revoked.'));
      expect(err.status).toBe(403);
    });

    const row = await unscopedPrisma.authorityGrant.findFirstOrThrow({ where: { id: grantId } });
    expect(row.status).toBe('active');
    expect(row.revokedAt).toBeNull();
    const audits = await unscopedPrisma.auditRecord.count({ where: { subjectType: 'authority_grant', subjectId: grantId } });
    expect(audits).toBe(0);
  });

  it('a granted caller revokes the grant and the audit row names the actor', async () => {
    const grantId = await makeGrant();
    const chairman = await principalFor('chairman@kaizen.co.in');

    await asUser('chairman@kaizen.co.in', () => revokeAuthority(grantId, 'Kill-switch test.'));

    const row = await unscopedPrisma.authorityGrant.findFirstOrThrow({ where: { id: grantId } });
    expect(row.status).toBe('revoked');
    const audits = await unscopedPrisma.auditRecord.findMany({ where: { subjectType: 'authority_grant', subjectId: grantId } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(chairman.partyId);
  });
});
