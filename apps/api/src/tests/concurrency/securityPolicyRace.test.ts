/**
 * Two first readers of a tenant's security policy, racing (domains/compliance/corporate/security.ts
 * securityPolicy).
 *
 * securityPolicy creates the row on first read when the tenant has none. Two
 * callers that both see none both try to create it; the unique index on
 * tenantId lets one win and the other is refused with P2002. The loser must
 * behave as if the row had existed: it returns the winner's row, and its
 * rolled-back create leaves no audit row behind. Before the P2002 handling the
 * loser surfaced the unique violation as a 500 (seen first in
 * payoutApprovalRaces, where both approvals reach assertStepUpForApprove).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asUser, booksTenant, unscopedPrisma } from '../helpers.js';
import { securityPolicy } from '../../domains/compliance/corporate/security.js';

describe('two first reads of a tenant with no security policy, racing', () => {
  it('both resolve to the one row, one policy row exists, and one create audit row is written', async () => {
    const f = await booksTenant(`conc-secpol-${randomUUID().slice(0, 8)}`);
    expect(await unscopedPrisma.securityPolicy.count({ where: { tenantId: f.tenantId } })).toBe(0);

    // Eight callers, not two: asUser looks the principal up before each call runs, so
    // two calls often finish one after the other and never meet at the create.
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, () => asUser(f.finance, () => securityPolicy())),
    );

    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map((r) => (r.reason as { code?: string }).code)).toEqual([]);
    const ids = settled.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id);
    for (const id of ids) expect(id).toBe(ids[0]);

    expect(await unscopedPrisma.securityPolicy.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(
      await unscopedPrisma.auditRecord.count({
        where: { tenantId: f.tenantId, subjectType: 'security_policy', subjectId: ids[0], action: 'create' },
      }),
    ).toBe(1);
  });
});
