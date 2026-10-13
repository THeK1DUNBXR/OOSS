/**
 * FX-32: an authority magnitude is compared with its ceiling at paise precision
 * (archive/FIXES.md row FX-32; agents/index.ts HOW MUCH check; platform/permissions.ts
 * resolveAuthorityCeiling). The magnitude and the ceiling were floats, so the
 * comparison was a float comparison.
 *
 * Real Postgres, through propose(), the agent's own gate. The grant is written
 * for the forecast agent's principal, with a class no other test uses.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { propose } from '../agents/index.js';
import { unscopedPrisma } from '../platform/db.js';
import { asUser, expectReject, tenantId } from './helpers.js';

const AUTHORITY_CLASS = `fx32_${randomUUID().slice(0, 8)}`;
let agentId: string;
let opportunityId: string;

beforeAll(async () => {
  const TENANT = await tenantId();
  const agent = await unscopedPrisma.agentPrincipal.findFirstOrThrow({
    where: { tenantId: TENANT, agentKey: 'agent.forecast' },
  });
  agentId = agent.id;
  const opportunity = await unscopedPrisma.opportunity.findFirstOrThrow({ where: { tenantId: TENANT } });
  opportunityId = opportunity.id;

  // A ceiling of exactly 0.30, stored at paise precision as the column holds it.
  await unscopedPrisma.authorityGrant.create({
    data: {
      tenantId: TENANT,
      principalType: 'agent',
      principalId: agent.id,
      authorityClass: AUTHORITY_CLASS,
      ceilingValueMinor: 30n,
      currency: 'INR',
      status: 'active',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
    },
  });
});

/** The forecast agent proposes a stage change, with a magnitude of the given class. */
function proposeWith(value: unknown) {
  return asUser('chairman@kaizen.co.in', () =>
    propose({
      agentKey: 'agent.forecast',
      tool: 'tool.crm.suggest_forecast_category',
      action: 'opportunity.suggest_forecast',
      subjectType: 'opportunity',
      subjectId: opportunityId,
      proposal: { to: 'commit' },
      rationale: 'FX-32 boundary probe.',
      magnitude: { authorityClass: AUTHORITY_CLASS, value: value as bigint },
    }),
  );
}

describe('FX-32: the HOW MUCH gate compares paise, and refuses anything that is not paise', () => {
  it('a magnitude exactly at the ceiling is inside it', async () => {
    const result = await proposeWith(30n);
    expect(result.blockedReason ?? '').not.toMatch(/shortfall/i);
  });

  it('one paisa over the ceiling is a shortfall', async () => {
    const result = await proposeWith(31n);
    expect(result.state).toBe('blocked');
    expect(result.blockedReason).toMatch(/Authority shortfall: 0\.31 exceeds/);
  });

  it('a float magnitude is refused, not compared (0.1 + 0.2 is not 0.30 in binary)', async () => {
    const refused = await expectReject(() => proposeWith(0.1 + 0.2));
    expect(refused.status).toBe(400);
    expect(refused.message).toMatch(/bigint paise/);
  });

  it('the agent row the boundary ran against is the one the grant names', async () => {
    const grant = await unscopedPrisma.authorityGrant.findFirstOrThrow({
      where: { authorityClass: AUTHORITY_CLASS, principalId: agentId },
    });
    expect(grant.ceilingValueMinor).toBe(30n);
  });
});
