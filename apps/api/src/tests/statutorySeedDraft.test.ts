/**
 * G10 check (c)(3): every seed row is DRAFT. The normal test database seed (the
 * one scripts/test-db.sh and the CI api job run) writes the statutory pack, and no
 * row it wrote may be APPROVED. Approval is a person's act at runtime, after the
 * tenant has a holder of the statutory approver duty. A seed that approves a row
 * would skip that act for every tenant it reaches.
 *
 * Read with the owner client, as the seed writes it, so row-level security does not
 * hide rows from the check. The count must be above zero first: a check over an
 * empty set passes for no reason.
 */

import { describe, expect, it } from 'vitest';
import { unscopedPrisma } from '../platform/db.js';
import { SEED_CREATED_BY } from '../seed/compliance/statutory.js';

describe('the statutory seed is DRAFT (G10 c(3))', () => {
  it('the normal seed wrote statutory rows under the seed marker, and none of them is APPROVED', async () => {
    const seeded = await unscopedPrisma.statutoryRule.count({ where: { createdBy: SEED_CREATED_BY } });
    expect(seeded).toBeGreaterThan(0);

    const approved = await unscopedPrisma.statutoryRule.count({
      where: { createdBy: SEED_CREATED_BY, status: 'APPROVED' },
    });
    expect(approved).toBe(0);
  });
});
