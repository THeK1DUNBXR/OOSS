/**
 * Phase 0 of the equity portal — identity, entities, portal surface.
 *
 * Requirements named `EQT-IDN-*`, per the phase-0 brief in
 * `docs/plan/equity-portal.md` §6.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_RESOURCES, ROLE_GRANT_MATRIX, parseCell } from '../seed/grants.js';
import { seedBootstrap } from '../seed/bootstrap.js';
import { reconcileTenantKinds } from '../platform/tenantKind.js';
import { navigationFor } from '../domains/surfaces.js';
import { createOrResetSignIn } from '../domains/signIns.js';
import { login, switchEntity } from '../lib/auth.js';
import { newRequestContext, runWithContext } from '../platform/context.js';
import { prisma as scopedPrisma, TenantScopeError } from '../platform/db.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { asPrincipal, asUser, authFor, expectReject, principalFor, tenantId, unscopedPrisma } from './helpers.js';

const NEW_RESOURCES = [
  'cap_table', 'share_classes', 'holders', 'share_ledger', 'certificates',
  'valuations', 'entity_documents', 'board_meetings', 'resolutions',
  'board_documents', 'compliance', 'group', 'holdings',
] as const;

let HOLDING: string;
const cleanupTenantSlugs: string[] = [];
const cleanupPersonIds: string[] = [];

beforeAll(async () => {
  HOLDING = await tenantId();
});

afterAll(async () => {
  // Best-effort: a person/affiliation carries no FK to Tenant in this schema,
  // so only the tenants themselves (and, through them, their Users by
  // cascade) need explicit cleanup — child before parent, because
  // `parentTenantId` is `onDelete: Restrict`.
  for (const id of cleanupPersonIds) {
    await unscopedPrisma.affiliation.deleteMany({ where: { partyId: id } }).catch(() => {});
    await unscopedPrisma.person.deleteMany({ where: { id } }).catch(() => {});
  }
  const tenants = await unscopedPrisma.tenant.findMany({ where: { slug: { in: cleanupTenantSlugs } } });
  const bySlug = new Map(tenants.map((t) => [t.slug, t] as const));
  // Children first.
  for (const t of tenants) {
    if (t.parentTenantId) {
      await unscopedPrisma.exceptionRecord.deleteMany({ where: { tenantId: t.id } }).catch(() => {});
      await unscopedPrisma.tenant.delete({ where: { id: t.id } }).catch(() => {});
    }
  }
  for (const t of tenants) {
    if (!t.parentTenantId) {
      await unscopedPrisma.exceptionRecord.deleteMany({ where: { tenantId: t.id } }).catch(() => {});
      await unscopedPrisma.tenant.delete({ where: { id: t.id } }).catch(() => {});
    }
  }
  void bySlug;
});

describe('EQT-IDN-001 — one principal, two tenants, two users, one password', () => {
  it('a principal with an active affiliation in two tenants logs in with one password and sees both entities', async () => {
    const subSlug = `kaizen-sub-test`;
    cleanupTenantSlugs.push(subSlug);

    // A shareholder sign-in, created in the holding tenant, is the principal
    // this test then gives a second entity to.
    const email = `eqt-idn-001-${Date.now()}@example.test`;
    let personId = '';
    const first = await asUser('chairman@kaizen.co.in', async () => {
      const person = await scopedPrisma.person.create({
        data: {
          tenantId: HOLDING,
          recordCode: await nextRecordCode('PER'),
          fullName: 'Multi-Entity Holder',
          primaryEmail: email,
          primaryEmailNormalised: email,
          source: 'test',
        },
      });
      personId = person.id;
      return createOrResetSignIn({ personId: person.id, roleSlug: 'shareholder', email });
    });
    cleanupPersonIds.push(personId);
    expect(first.password).toBeTruthy();
    expect(first.created).toBe(true);

    // The subsidiary — bootstrapped through the same seedBootstrap the CLI
    // script calls, parametrised rather than duplicated.
    const { tenantId: subTenantId } = await seedBootstrap({ tenantSlug: subSlug, tenantName: 'Kaizen Sub Test', parentTenantSlug: 'kaizen' });

    // The same principal, a second entity: a director affiliation in the
    // subsidiary, under the identical email — this is the fact that makes it
    // one identity rather than two accounts that happen to share a password.
    const principal = await unscopedPrisma.principal.findFirstOrThrow({ where: { email } });
    const subPerson = await unscopedPrisma.person.create({
      data: { tenantId: subTenantId, recordCode: `PER-9999-${Date.now() % 90000}`, fullName: 'Multi-Entity Holder', primaryEmail: email, primaryEmailNormalised: email, source: 'test' },
    });
    cleanupPersonIds.push(subPerson.id);
    await unscopedPrisma.user.create({ data: { tenantId: subTenantId, personId: subPerson.id, email, principalId: principal.id } });
    await unscopedPrisma.affiliation.create({
      data: { tenantId: subTenantId, partyId: subPerson.id, affiliationType: 'director', roleSlug: 'director', status: 'active', primaryFlag: true },
    });

    // Logging in with no tenant named resolves to more than one entity: no
    // token, an entity list, a selection token.
    const ambiguous = await login(email, first.password!);
    if (!('entities' in ambiguous)) throw new Error('Expected an entity list.');
    expect(ambiguous.entities.map((e) => e.tenantId).sort()).toEqual([HOLDING, subTenantId].sort());
    expect(ambiguous.selectionToken).toBeTruthy();

    // The same password resolves cleanly in either tenant when named.
    const inHolding = await login(email, first.password!, 'kaizen');
    const inSub = await login(email, first.password!, subSlug);
    if ('entities' in inHolding || 'entities' in inSub) throw new Error('Expected a single-entity login.');
    expect(inHolding.user.principalId).toBe(inSub.user.principalId);
    expect(inHolding.user.tenantId).toBe(HOLDING);
    expect(inSub.user.tenantId).toBe(subTenantId);
    expect(inSub.user.tenantKind).toBe('subsidiary');
  });
});

describe('EQT-IDN-002 — switch-entity is refused with 404 where the principal holds no active affiliation', () => {
  it('a tenant the principal has no active affiliation in is a 404, never a 403', async () => {
    const otherSlug = `eqt-002-other-${Date.now()}`;
    cleanupTenantSlugs.push(otherSlug);
    const other = await unscopedPrisma.tenant.create({ data: { slug: otherSlug, name: 'Other', status: 'active' } });

    const email = `eqt-idn-002-${Date.now()}@example.test`;
    const principal = await unscopedPrisma.principal.create({ data: { email, passwordHash: 'x' } });

    const rejection = await expectReject(() => switchEntity({ principalId: principal.id }, other.id));
    expect(rejection.status).toBe(404);
  });
});

describe('EQT-IDN-003 — ending the director affiliation makes the next request in that tenant fail', () => {
  it('switch-entity refuses the tenant the instant the affiliation ends, with no deprovisioning step in between', async () => {
    const subSlug = `eqt-003-sub-${Date.now()}`;
    cleanupTenantSlugs.push(subSlug);
    const { tenantId: subTenantId } = await seedBootstrap({ tenantSlug: subSlug, tenantName: 'EQT 003 Sub', parentTenantSlug: 'kaizen' });

    const email = `eqt-idn-003-${Date.now()}@example.test`;
    const principal = await unscopedPrisma.principal.create({ data: { email, passwordHash: 'x' } });
    const person = await unscopedPrisma.person.create({
      data: { tenantId: subTenantId, recordCode: `PER-9998-${Date.now() % 90000}`, fullName: 'Ending Director', primaryEmail: email, primaryEmailNormalised: email, source: 'test' },
    });
    cleanupPersonIds.push(person.id);
    await unscopedPrisma.user.create({ data: { tenantId: subTenantId, personId: person.id, email, principalId: principal.id } });
    const affiliation = await unscopedPrisma.affiliation.create({
      data: { tenantId: subTenantId, partyId: person.id, affiliationType: 'director', roleSlug: 'director', status: 'active', primaryFlag: true },
    });

    // Reachable while active.
    const ok = await switchEntity({ principalId: principal.id }, subTenantId);
    expect(ok.user.tenantId).toBe(subTenantId);

    // Ended — no separate deprovisioning step, the very next request refuses it.
    await unscopedPrisma.affiliation.update({ where: { id: affiliation.id }, data: { status: 'ended' } });
    const rejection = await expectReject(() => switchEntity({ principalId: principal.id }, subTenantId));
    expect(rejection.status).toBe(404);
  });
});

describe('EQT-IDN-004 — a portal archetype sees only portal navigation and an ERP role sees none of it', () => {
  it('the shareholder role (archetype portal) sees only portal_* nodes', async () => {
    const email = `eqt-idn-004-${Date.now()}@example.test`;
    const first = await asUser('chairman@kaizen.co.in', async () => {
      const person = await scopedPrisma.person.create({
        data: { tenantId: HOLDING, recordCode: await nextRecordCode('PER'), fullName: 'Portal Viewer', primaryEmail: email, primaryEmailNormalised: email, source: 'test' },
      });
      cleanupPersonIds.push(person.id);
      return createOrResetSignIn({ personId: person.id, roleSlug: 'shareholder', email });
    });
    expect(first.password).toBeTruthy();

    const p = await principalFor(email);
    const nav = await asPrincipal(authFor(p), () => navigationFor());
    expect(nav.length).toBeGreaterThan(0);
    expect(nav.every((n) => n.key.startsWith('portal_'))).toBe(true);
  });

  it('an ERP role (chairman) sees none of the portal_* nodes', async () => {
    const nav = await asUser('chairman@kaizen.co.in', () => navigationFor());
    expect(nav.some((n) => n.key.startsWith('portal_'))).toBe(false);
  });
});

describe('EQT-IDN-005 — the tenant gate still throws inside the holding tenant when a subsidiary model is read with no scope', () => {
  it('a query naming a subsidiary tenantId in its where clause still throws with no context in scope', async () => {
    await expect(
      runWithContext(newRequestContext({ auth: null }), () => scopedPrisma.person.findMany({ where: { tenantId: HOLDING } as never, take: 1 })),
    ).rejects.toThrow(TenantScopeError);
  });
});

describe('EQT-IDN-006 — the sign-in action returns a password once and only rotates it on reset', () => {
  it('returns a password on first creation, null on a second call, and a new one only on reset', async () => {
    const email = `eqt-idn-006-${Date.now()}@example.test`;
    const first = await asUser('chairman@kaizen.co.in', async () => {
      const person = await scopedPrisma.person.create({
        data: { tenantId: HOLDING, recordCode: await nextRecordCode('PER'), fullName: 'Sign-In Subject', primaryEmail: email, primaryEmailNormalised: email, source: 'test' },
      });
      cleanupPersonIds.push(person.id);
      const result = await createOrResetSignIn({ personId: person.id, roleSlug: 'shareholder', email });
      return { personId: person.id, result };
    });
    expect(first.result.password).toBeTruthy();
    expect(first.result.created).toBe(true);

    const again = await asUser('chairman@kaizen.co.in', () => createOrResetSignIn({ personId: first.personId, roleSlug: 'shareholder', email }));
    expect(again.password).toBeNull();
    expect(again.created).toBe(false);

    const reset = await asUser('chairman@kaizen.co.in', () => createOrResetSignIn({ personId: first.personId, roleSlug: 'shareholder', email, reset: true }));
    expect(reset.password).toBeTruthy();
    expect(reset.password).not.toBe(first.result.password);
  });
});

describe('EQT-IDN-007 — boot grant sync gives every existing role its declared cells for the new resources and nothing else', () => {
  it('ALL_RESOURCES and the shared RESOURCES list agree on the equity resources', async () => {
    const { RESOURCES } = await import('@kaizen/shared');
    for (const r of NEW_RESOURCES) expect(RESOURCES as readonly string[]).toContain(r);
    for (const r of NEW_RESOURCES) expect(ALL_RESOURCES as readonly string[]).toContain(r);
  });

  it('every role holds exactly the cells the matrix declares for the new resources, and no others', async () => {
    for (const [slug, specs] of Object.entries(ROLE_GRANT_MATRIX)) {
      const role = await unscopedPrisma.accessRole.findFirst({ where: { tenantId: HOLDING, slug } });
      expect(role, `role ${slug} should be seeded`).toBeTruthy();
      if (!role) continue;

      const rows = await unscopedPrisma.grant.findMany({ where: { tenantId: HOLDING, roleId: role.id, resource: { in: [...NEW_RESOURCES] } } });

      for (const resource of NEW_RESOURCES) {
        // A resource can carry two cells at two different scopes (`view@all`
        // beside `edit@own`, say) — each becomes its own grant row, so both
        // sides are compared per scope rather than picking the first match.
        const parsedCells = specs.filter((s) => s.resource === resource).map((s) => parseCell(s.cell)).filter((p): p is NonNullable<typeof p> => p !== null);
        const dbRows = rows.filter((r) => r.resource === resource);

        if (parsedCells.length === 0) {
          expect(dbRows, `${slug} should hold no grant row for ${resource}`).toHaveLength(0);
          continue;
        }

        expect(dbRows, `${slug} should hold exactly ${parsedCells.length} grant row(s) for ${resource}`).toHaveLength(parsedCells.length);
        for (const parsed of parsedCells) {
          const row = dbRows.find((r) => r.scope === parsed.scope);
          expect(row, `${slug} should hold a grant row for ${resource}@${parsed.scope}`).toBeTruthy();
          expect(new Set(row!.verbs)).toEqual(new Set(parsed.verbs));
        }
      }
    }
  });
});

describe('EQT-IDN-008 — a tenant that gains a subsidiary becomes a holding and the small-company notice is raised once', () => {
  it('reconcileTenantKinds flips both tenants and raises EX-EQT-001 exactly once each', async () => {
    const parentSlug = `eqt-008-parent-${Date.now()}`;
    const childSlug = `eqt-008-child-${Date.now()}`;
    cleanupTenantSlugs.push(childSlug, parentSlug);

    const { tenantId: parentId } = await seedBootstrap({ tenantSlug: parentSlug, tenantName: 'EQT 008 Parent' });
    const parentBefore = await unscopedPrisma.tenant.findFirstOrThrow({ where: { id: parentId } });
    expect(parentBefore.kind).toBe('standalone');

    const { tenantId: childId } = await seedBootstrap({ tenantSlug: childSlug, tenantName: 'EQT 008 Child', parentTenantSlug: parentSlug });

    const parentAfter = await unscopedPrisma.tenant.findFirstOrThrow({ where: { id: parentId } });
    const childAfter = await unscopedPrisma.tenant.findFirstOrThrow({ where: { id: childId } });
    expect(parentAfter.kind).toBe('holding');
    expect(childAfter.kind).toBe('subsidiary');

    const parentExceptions = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: parentId, code: 'EX-EQT-001' } });
    const childExceptions = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: childId, code: 'EX-EQT-001' } });
    expect(parentExceptions).toHaveLength(1);
    expect(childExceptions).toHaveLength(1);

    // Running reconciliation again raises nothing new — it fires once.
    await reconcileTenantKinds();
    const parentExceptionsAgain = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: parentId, code: 'EX-EQT-001' } });
    expect(parentExceptionsAgain).toHaveLength(1);
  });
});
