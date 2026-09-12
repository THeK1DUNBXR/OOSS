/**
 * The races the rest of the suite cannot see.
 *
 * The existing 397 tests are serial by construction, and correctly so —
 * gaplessness and chain continuity are claims about ordering, and a parallel
 * runner would be asserting something else. The consequence is that every
 * concurrency defect in this codebase was invisible to it.
 *
 * These deliberately do the opposite: fire real concurrent work against a real
 * Postgres and assert the invariant still holds.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { asSystem } from '../platform/context.js';
import { emit, verifyChain } from '../platform/eventBus.js';
import { prisma } from '../platform/db.js';
import { tenantId } from './helpers.js';

let tid: string;

beforeAll(async () => {
  tid = await tenantId();
});

describe('the event hash chain under concurrency', () => {
  it('survives many emissions arriving together', async () => {
    // The defect: the head was read with an unlocked `findFirst` and the insert
    // happened later, outside any transaction. Two emits in one tenant both
    // read head H and both wrote `prevHash: H`, forking the chain — and
    // `verifyChain` then reported it permanently broken, with no way back.
    //
    // Against the old code this fails: the fork happens within the first few
    // concurrent pairs and the chain never recovers.
    const N = 40;

    await asSystem(tid, async () => {
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          emit({
            name: EVENTS.PERSON_CREATED,
            subject: { entityType: 'person', entityId: `concurrency-probe-${i}` },
            newState: { probe: i },
            impact: { domains: ['crm'] },
          }),
        ),
      );
    });

    const result = await asSystem(tid, () => verifyChain(tid));
    expect(result.brokenAt).toBeNull();
    expect(result.valid).toBe(true);
  });

  it('gives every record a distinct predecessor', async () => {
    // The constraint that makes the fork impossible rather than unlikely.
    // Two records sharing a `prevHash` is precisely what a fork looks like.
    const rows = await asSystem(tid, async () =>
      prisma.eventRecord.findMany({
        where: { tenantId: tid, prevHash: { not: null } },
        select: { prevHash: true },
      }),
    );
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const r of rows) {
      const key = r.prevHash as string;
      if (seen.has(key)) duplicated.push(key);
      seen.add(key);
    }
    expect(duplicated).toEqual([]);
  });
});
