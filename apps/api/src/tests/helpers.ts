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

export { prisma, unscopedPrisma };
