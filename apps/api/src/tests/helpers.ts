/**
 * Test harness.
 *
 * Every test runs inside a real request context against a real database, so the
 * tenant gate, the five-axis evaluator and the event chain are all exercised
 * rather than mocked. A mocked permission check proves nothing about the one
 * that runs in production.
 */

import { unscopedPrisma, prisma } from '../platform/db.js';
import { newRequestContext, runWithContext, type AuthContext } from '../platform/context.js';
import { invalidateGrantCache } from '../platform/permissions.js';
import { registerSubscribers } from '../events/handlers.js';
import { ROLE_CLASSIFICATION_CEILING, type SensitivityClass } from '@kaizen/shared';

export interface TestPrincipal {
  tenantId: string;
  partyId: string;
  userId: string;
  affiliationId: string;
  roleSlug: string;
  branch: string | null;
}

let subscribersRegistered = false;

export async function tenantId(slug = 'kaizen'): Promise<string> {
  const t = await unscopedPrisma.tenant.findFirstOrThrow({ where: { slug } });
  return t.id;
}

export async function principalFor(email: string): Promise<TestPrincipal> {
  const user = await unscopedPrisma.user.findFirstOrThrow({
    where: { email },
    include: { person: true },
  });
  const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
    where: { partyId: user.personId, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return {
    tenantId: user.tenantId,
    partyId: user.personId,
    userId: user.id,
    affiliationId: affiliation.id,
    roleSlug: affiliation.roleSlug ?? 'sales',
    branch: user.branch,
  };
}

export function authFor(p: TestPrincipal, overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    tenantId: p.tenantId,
    principalType: 'human',
    partyId: p.partyId,
    userId: p.userId,
    agentId: null,
    onBehalfOfPartyId: null,
    affiliationId: p.affiliationId,
    roleSlug: p.roleSlug,
    branch: p.branch,
    orgUnitId: null,
    classificationCeiling: (ROLE_CLASSIFICATION_CEILING[p.roleSlug] ?? 'internal') as SensitivityClass,
    purpose: 'operational',
    consentCodes: [],
    stepUpVerified: true,
    ...overrides,
  };
}

/** Runs `fn` as the given account, inside a fresh request context. */
export async function asUser<T>(email: string, fn: (p: TestPrincipal) => Promise<T>): Promise<T> {
  if (!subscribersRegistered) {
    registerSubscribers();
    subscribersRegistered = true;
  }
  invalidateGrantCache();
  const p = await principalFor(email);
  // Awaited *inside* the context: a Prisma promise is lazy, so returning it
  // unawaited would run the query after the async scope had already exited.
  return runWithContext(newRequestContext({ auth: authFor(p) }), async () => await fn(p));
}

/** Runs `fn` with an explicitly constructed principal — used for agent and cross-tenant cases. */
export async function asPrincipal<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> {
  invalidateGrantCache();
  return runWithContext(newRequestContext({ auth }), async () => await fn());
}

/** Asserts that `fn` rejects, and returns the error for inspection. */
export async function expectReject(fn: () => Promise<unknown>): Promise<{ code?: string; message: string; status?: number }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { code?: string; message: string; status?: number };
    return { code: e.code, message: e.message, status: e.status };
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

/**
 * A role that exists only for the duration of a test.
 *
 * The product ships three roles, and several of the permission engine's
 * mechanisms no longer have a product role that demonstrates them: nothing
 * carries `own_or_unowned`, every role's classification ceiling is
 * `regulated`, and no role holds `edit` on an agreement without `approve`.
 *
 * Deleting those tests would be the wrong trade. The mechanisms are still in
 * the evaluator, still reachable the moment a tenant writes its own grant row,
 * and an untested authorisation path is exactly the kind of thing that rots.
 * So the suite builds the principal it needs: a role, its grants, a person and
 * a user, torn down after the assertion.
 *
 * This is also the honest statement of what the matrix is. Roles are data. A
 * tenant that wants a narrow counsellor role writes one, and it will behave
 * the way these tests say it behaves.
 */
export async function withFixtureRole<T>(
  spec: {
    slug?: string;
    classificationCeiling?: SensitivityClass;
    grants: Array<{ resource: string; verbs: string[]; scope?: string; scopeResolver?: string }>;
    branch?: string;
  },
  fn: (p: TestPrincipal) => Promise<T>,
): Promise<T> {
  const tid = await tenantId();
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const slug = `${spec.slug ?? 'fixture'}_${stamp}`;
  const email = `${slug}@fixture.test`;

  const role = await unscopedPrisma.accessRole.create({
    data: {
      tenantId: tid,
      slug,
      name: `Fixture ${slug}`,
      description: 'Created by the acceptance suite. Not a product role.',
      archetype: 'workspace',
      classificationCeiling: spec.classificationCeiling ?? 'internal',
      isSystem: false,
    },
  });

  for (const g of spec.grants) {
    await unscopedPrisma.grant.create({
      data: {
        tenantId: tid,
        principalType: 'role',
        roleId: role.id,
        resource: g.resource,
        verbs: g.verbs,
        scope: g.scope ?? 'all',
        scopeResolver: g.scopeResolver ?? null,
      },
    });
  }

  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-FIXTURE-${stamp}`,
      fullName: `Fixture ${slug}`,
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  const affiliation = await unscopedPrisma.affiliation.create({
    data: {
      tenantId: tid,
      partyId: person.id,
      affiliationType: 'employee',
      counterpartyName: 'Fixture',
      roleSlug: slug,
      primaryFlag: true,
      status: 'active',
      branch: spec.branch ?? 'Chennai',
    },
  });
  const user = await unscopedPrisma.user.create({
    data: { tenantId: tid, personId: person.id, email, passwordHash: 'not-a-login', branch: spec.branch ?? 'Chennai' },
  });

  const principal: TestPrincipal = {
    tenantId: tid,
    partyId: person.id,
    userId: user.id,
    affiliationId: affiliation.id,
    roleSlug: slug,
    branch: spec.branch ?? 'Chennai',
  };

  if (!subscribersRegistered) {
    registerSubscribers();
    subscribersRegistered = true;
  }
  invalidateGrantCache();

  const auth = authFor(principal, {
    classificationCeiling: spec.classificationCeiling ?? 'internal',
  });

  try {
    return await runWithContext(newRequestContext({ auth }), async () => await fn(principal));
  } finally {
    // Torn down so a second run of the suite does not accumulate roles, and so
    // the grant reconciler never sees a row the matrix does not declare.
    await unscopedPrisma.grant.deleteMany({ where: { roleId: role.id } });
    await unscopedPrisma.affiliation.delete({ where: { id: affiliation.id } });
    await unscopedPrisma.user.delete({ where: { id: user.id } });
    await unscopedPrisma.accessRole.delete({ where: { id: role.id } });
    invalidateGrantCache();
  }
}

export { prisma, unscopedPrisma };
