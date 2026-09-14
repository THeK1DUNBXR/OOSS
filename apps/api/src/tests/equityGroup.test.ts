/**
 * Phase 2 of the equity portal — the group.
 *
 * Requirements named `EQT-GRP-*`, per the phase-2 brief in
 * `docs/plan/equity-portal.md` §6. `EQT-GRP-004` extends `EQT-REG-008`
 * (the one-hop s.19 case, in `equityRegister.test.ts`) to a two-hop chain
 * rather than duplicating it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIVISIONS, DIVISION_LABELS, GROUP_LABELS, computeLookThrough, type LookThroughDirectRow, type LookThroughEdge } from '@kaizen/shared';
import { seedBootstrap } from '../seed/bootstrap.js';
import { createHolder } from '../domains/equity.js';
import { recordTransaction, createAccount } from '../domains/books.js';
import {
  publishEntitySnapshot, groupStructure, groupHolders, groupFinancials,
  groupCompliance, entitySnapshotView,
} from '../domains/group.js';
import { switchEntity } from '../lib/auth.js';
import {
  asPrincipal, asUser, authFor, expectReject, tenantId, unscopedPrisma,
  type TestPrincipal,
} from './helpers.js';

let HOLDING: string;
const cleanupTenantSlugs: string[] = [];

/** A principal built from a tenant's own founding accounts — never resolved by `asUser`, which has no tenant to disambiguate a shared email against. */
async function principalInTenant(tid: string, email: string): Promise<TestPrincipal> {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { tenantId: tid, email } });
  const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
    where: { tenantId: tid, partyId: user.personId, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return {
    tenantId: tid,
    partyId: user.personId,
    userId: user.id,
    affiliationId: affiliation.id,
    roleSlug: affiliation.roleSlug ?? 'chairman',
    branch: user.branch,
  };
}

async function asTenantUser<T>(tid: string, email: string, fn: () => Promise<T>): Promise<T> {
  const p = await principalInTenant(tid, email);
  return asPrincipal(authFor(p), fn);
}

async function cleanupSnapshotsFor(sourceTenantId: string) {
  await unscopedPrisma.entitySnapshot.deleteMany({ where: { sourceTenantId } }).catch(() => {});
  await unscopedPrisma.entitySnapshotHistory.deleteMany({ where: { sourceTenantId } }).catch(() => {});
}

beforeAll(async () => {
  HOLDING = await tenantId();
});

afterAll(async () => {
  // Snapshots live under the PARENT's tenantId, keyed by `sourceTenantId` —
  // deleting the source tenant below does not cascade to them, so they are
  // cleaned up explicitly, or the holding's own group screen would carry
  // this file's fixtures into every other test that reads it.
  const tenants = await unscopedPrisma.tenant.findMany({ where: { slug: { in: cleanupTenantSlugs } } });
  for (const t of tenants) await cleanupSnapshotsFor(t.id);

  const bySlug = new Map(tenants.map((t) => [t.slug, t] as const));
  const ordered = [...cleanupTenantSlugs].reverse(); // children (created later) before parents
  for (const slug of ordered) {
    const t = bySlug.get(slug);
    if (!t) continue;
    await unscopedPrisma.exceptionRecord.deleteMany({ where: { tenantId: t.id } }).catch(() => {});
    await unscopedPrisma.tenant.delete({ where: { id: t.id } }).catch(() => {});
  }
});

describe('EQT-GRP-001 — the group screen reads only snapshots: group.ts uses no unscoped client outside the publisher', () => {
  it('every `unscopedPrisma` reference in domains/group.ts falls between the publisher markers', () => {
    const path = fileURLToPath(new URL('../domains/group.ts', import.meta.url));
    const lines = readFileSync(path, 'utf8').split('\n');

    const start = lines.findIndex((l) => l.includes('==== Publisher ===='));
    const end = lines.findIndex((l) => l.includes('==== End publisher ===='));
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const offenders: number[] = [];
    lines.forEach((line, i) => {
      if (!line.includes('unscopedPrisma')) return;
      if (i > start && i < end) return; // inside the publisher — legitimate
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) return; // a comment mentioning it, not a call
      offenders.push(i + 1);
    });
    expect(offenders, `unscopedPrisma used outside the publisher at line(s) ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('EQT-GRP-002 — look-through arithmetic on the worked example (60% × 70% + 5% = 47%)', () => {
  it('a founder holding 60% of the holding and 5% direct in a subsidiary the holding owns 70% of comes to 47%', () => {
    const direct: LookThroughDirectRow[] = [
      { entityId: 'holding', holderKey: 'founder@example.test', issuedPct: 60, fullyDilutedPct: 60, matchedBy: 'email' },
      { entityId: 'sub', holderKey: 'founder@example.test', issuedPct: 5, fullyDilutedPct: 5, matchedBy: 'email' },
    ];
    const edges: LookThroughEdge[] = [
      { parentEntityId: 'holding', childEntityId: 'sub', issuedPct: 70, fullyDilutedPct: 70 },
    ];

    const rows = computeLookThrough(direct, edges);
    const founderInSub = rows.find((r) => r.entityId === 'sub' && r.holderKey === 'founder@example.test');
    expect(founderInSub?.issuedPct).toBe(47);
    expect(founderInSub?.fullyDilutedPct).toBe(47);

    const founderInHolding = rows.find((r) => r.entityId === 'holding' && r.holderKey === 'founder@example.test');
    expect(founderInHolding?.issuedPct).toBe(60);
  });

  it('refuses a cycle rather than computing it', () => {
    const edges: LookThroughEdge[] = [
      { parentEntityId: 'a', childEntityId: 'b', issuedPct: 50, fullyDilutedPct: 50 },
      { parentEntityId: 'b', childEntityId: 'a', issuedPct: 50, fullyDilutedPct: 50 },
    ];
    expect(() => computeLookThrough([], edges)).toThrow(/cycle/);
  });
});

describe('EQT-GRP-003 — a stale snapshot is labelled with its age and never blended into a fresher one', () => {
  it('a snapshot published over 24h ago is flagged stale, and its figures stay its own', async () => {
    const subSlug = `eqt-grp-003-${Date.now()}`;
    cleanupTenantSlugs.push(subSlug);
    const { tenantId: subId } = await seedBootstrap({ tenantSlug: subSlug, tenantName: 'EQT-GRP-003 Sub', parentTenantSlug: 'kaizen' });

    const before = await publishEntitySnapshot(subId);
    expect(before.published).toBe(true);

    // Fresh — not yet stale.
    const freshCompliance = await asUser('chairman@kaizen.co.in', () => groupCompliance());
    const freshRow = freshCompliance.rows.find((r) => r.tenantId === subId);
    expect(freshRow?.stale).toBe(false);

    // Back-date the publish so it reads as 25 hours old.
    await unscopedPrisma.entitySnapshot.updateMany({
      where: { tenantId: HOLDING, sourceTenantId: subId },
      data: { publishedAt: new Date(Date.now() - 25 * 3600 * 1000) },
    });

    const staleCompliance = await asUser('chairman@kaizen.co.in', () => groupCompliance());
    const staleRow = staleCompliance.rows.find((r) => r.tenantId === subId);
    expect(staleRow?.stale).toBe(true);
    expect(staleRow?.staleSeconds).toBeGreaterThan(24 * 3600);

    // Never blended: the structure and financials still carry this entity as
    // its own row, distinct from the holding's own figures and from any
    // other snapshot, rather than folding its age into a combined figure.
    const structure = await asUser('chairman@kaizen.co.in', () => groupStructure());
    const node = structure.nodes.find((n) => n.tenantId === subId);
    expect(node?.stale).toBe(true);
    expect(node?.tenantId).not.toBe(HOLDING);

    const financials = await asUser('chairman@kaizen.co.in', () => groupFinancials());
    const entityRow = financials.entities.find((e) => e.tenantId === subId);
    const holdingRow = financials.entities.find((e) => e.tenantId === HOLDING);
    expect(entityRow).toBeTruthy();
    expect(holdingRow).toBeTruthy();
    // Two distinct rows, not one figure the stale entity's age got folded into.
    expect(entityRow).not.toBe(holdingRow);
  });
});

describe('EQT-GRP-004 — a grandchild cannot be recorded as a holder in the top holding\'s register (s.19, multi-hop)', () => {
  it('walking two hops up still finds the ancestor and refuses the holder', async () => {
    const parentSlug = `eqt-grp-004-parent-${Date.now()}`;
    const childSlug = `eqt-grp-004-child-${Date.now()}`;
    cleanupTenantSlugs.push(parentSlug, childSlug);

    const { tenantId: parentId } = await seedBootstrap({ tenantSlug: parentSlug, tenantName: 'EQT-GRP-004 Parent', parentTenantSlug: 'kaizen' });
    const { tenantId: childId } = await seedBootstrap({ tenantSlug: childSlug, tenantName: 'EQT-GRP-004 Child', parentTenantSlug: parentSlug });

    // In the TOP holding's own register, a holder said to be "held by" the
    // grandchild two levels down is refused — the walk from `heldByTenantId`
    // up through its own parent chain reaches `kaizen` at the second hop.
    const rejection = await expectReject(() =>
      asUser('chairman@kaizen.co.in', () => createHolder({ kind: 'entity', heldByTenantId: childId, residency: 'resident' })),
    );
    expect(rejection.status).toBe(422);

    // The other direction — the top holding recorded as a holder in the
    // grandchild's OWN register — is the ordinary, legitimate case: a
    // holding owns shares in a grand-subsidiary two layers down.
    const legitimate = await asTenantUser(childId, 'chairman@kaizen.co.in', () =>
      createHolder({ kind: 'entity', heldByTenantId: HOLDING, residency: 'resident' }),
    );
    expect(legitimate.heldByTenantId).toBe(HOLDING);
  });
});

describe('EQT-GRP-005 — a chairman without an affiliation in a subsidiary sees its snapshot on the group screen and cannot switch into it', () => {
  it('the snapshot is readable from the holding; switch-entity into the subsidiary is a 404', async () => {
    const subSlug = `eqt-grp-005-${Date.now()}`;
    cleanupTenantSlugs.push(subSlug);
    const { tenantId: subId } = await seedBootstrap({ tenantSlug: subSlug, tenantName: 'EQT-GRP-005 Sub', parentTenantSlug: 'kaizen' });

    // The chairman is auto-affiliated in every freshly bootstrapped tenant
    // that reuses the same founding email — end that affiliation so this
    // test starts from the premise the requirement names: no relationship
    // in the subsidiary at all.
    const chairmanUser = await unscopedPrisma.user.findFirstOrThrow({ where: { tenantId: subId, email: 'chairman@kaizen.co.in' } });
    await unscopedPrisma.affiliation.updateMany({
      where: { tenantId: subId, partyId: chairmanUser.personId, status: 'active' },
      data: { status: 'ended' },
    });

    const published = await publishEntitySnapshot(subId);
    expect(published.published).toBe(true);

    // Sees it — the group screen reads the holding's own snapshot row, not
    // the subsidiary's tables.
    const view = await asUser('chairman@kaizen.co.in', () => entitySnapshotView(subId));
    expect(view.sourceTenantId).toBe(subId);
    const structure = await asUser('chairman@kaizen.co.in', () => groupStructure());
    expect(structure.nodes.some((n) => n.tenantId === subId)).toBe(true);

    // Cannot switch into it: no active affiliation there at all.
    const principal = await unscopedPrisma.principal.findFirstOrThrow({ where: { email: 'chairman@kaizen.co.in' } });
    const rejection = await expectReject(() => switchEntity({ principalId: principal.id }, subId));
    expect(rejection.status).toBe(404);
  });
});

describe('EQT-GRP-006 — a group total is labelled before inter-company eliminations and lists the inter-company amounts', () => {
  it('groupFinancials carries the exact heading and the recorded inter-company totals', async () => {
    const subSlug = `eqt-grp-006-${Date.now()}`;
    cleanupTenantSlugs.push(subSlug);
    const { tenantId: subId } = await seedBootstrap({ tenantSlug: subSlug, tenantName: 'EQT-GRP-006 Sub', parentTenantSlug: 'kaizen' });

    const account = await asTenantUser(subId, 'chairman@kaizen.co.in', () =>
      createAccount({ name: `EQT-GRP-006 Account ${Date.now()}`, accountType: 'bank' }),
    );

    const rejectedOutOfGroup = await expectReject(() =>
      asTenantUser(subId, 'chairman@kaizen.co.in', () =>
        recordTransaction({
          txnDate: new Date(),
          direction: 'out',
          amount: 1_000,
          accountId: account.id,
          intercompanyTenantId: 'not-a-real-tenant-id',
        }),
      ),
    );
    expect(rejectedOutOfGroup.status).toBe(422);

    await asTenantUser(subId, 'chairman@kaizen.co.in', () =>
      recordTransaction({
        txnDate: new Date(),
        direction: 'out',
        amount: 12_345,
        accountId: account.id,
        intercompanyTenantId: HOLDING, // the parent — a legitimate group counterparty
        note: 'Services invoiced to the holding',
      }),
    );

    const published = await publishEntitySnapshot(subId);
    expect(published.published).toBe(true);

    const financials = await asUser('chairman@kaizen.co.in', () => groupFinancials());
    expect(financials.totalLabel).toBe(GROUP_LABELS.totalBeforeEliminations);
    expect(financials.totalLabel).toBe('Group total before inter-company eliminations');

    const subRow = financials.entities.find((e) => e.tenantId === subId);
    expect(subRow?.intercompanyOut).toBe(12_345);
  });
});

describe('EQT-GRP-007 — an unincorporated division appears on the structure chart until a tenant claims it', () => {
  it('a division with no subsidiary snapshot reads "not yet incorporated", and stops once one publishes', async () => {
    const softwareSlug = `eqt-grp-007-software-${Date.now()}`;
    cleanupTenantSlugs.push(softwareSlug);

    const beforeStructure = await asUser('chairman@kaizen.co.in', () => groupStructure());
    const softwareBefore = beforeStructure.nodes.find((n) => n.originDivision === 'software' && n.tenantId === null);
    expect(softwareBefore?.badge).toBe('not_yet_incorporated');
    expect(softwareBefore?.name).toBe(DIVISION_LABELS.software);

    const { tenantId: softwareId } = await seedBootstrap({
      tenantSlug: softwareSlug,
      tenantName: 'EQT-GRP-007 Software',
      parentTenantSlug: 'kaizen',
      originDivision: 'software',
    });
    const published = await publishEntitySnapshot(softwareId);
    expect(published.published).toBe(true);

    const afterStructure = await asUser('chairman@kaizen.co.in', () => groupStructure());
    // Claimed — no longer a "not yet incorporated" placeholder for software.
    expect(afterStructure.nodes.some((n) => n.originDivision === 'software' && n.tenantId === null)).toBe(false);
    expect(afterStructure.nodes.some((n) => n.tenantId === softwareId)).toBe(true);

    // A division nobody has incorporated yet is still unclaimed, and never
    // silently invented as `undefined` — every `DIVISIONS` value but `shared`
    // is accounted for, one way or the other.
    const stillOpen = DIVISIONS.filter((d) => d !== 'shared' && d !== 'software');
    for (const division of stillOpen) {
      expect(afterStructure.nodes.some((n) => n.originDivision === division && n.tenantId === null)).toBe(true);
    }
  });
});

describe('EQT-GRP-008 — group.ts calls no service code that compares a role slug', () => {
  it('has no literal role-slug comparison', () => {
    const path = fileURLToPath(new URL('../domains/group.ts', import.meta.url));
    const text = readFileSync(path, 'utf8');
    expect(/roleSlug\s*[=!]==\s*['"]/.test(text)).toBe(false);
  });
});
