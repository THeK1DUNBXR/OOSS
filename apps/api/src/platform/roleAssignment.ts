/**
 * Who may name which access role.
 *
 * An affiliation's roleSlug is the role the evaluator reads for that person, so
 * naming a role is granting its access. Every path that sets or changes a
 * roleSlug runs assertCanAssignRole before it writes anything, and a refusal
 * leaves the database as it was.
 *
 * This is the interim rule, until the Wave 6 placement model replaces it:
 *  1. Nobody assigns a role to their own party. Without this, an assigner who
 *     holds people:assign names chairman for themselves and becomes the
 *     superadmin (chairman holds every resource, grants.ts:188).
 *  2. An assigner may name a role only if every grant of that role is covered
 *     by the assigner's own effective grants: same resource and verb, a scope
 *     at least as broad, and no resolver or condition the assigner lacks.
 *     Coverage is checked per verb, so a role cannot widen one verb by riding
 *     on another the assigner holds.
 */

import type { Scope, Verb } from '@kaizen/shared';
import { prisma } from './db.js';
import { currentAuth, type AuthContext } from './context.js';
import { ApiError } from './errors.js';
import { resolveGrants, type ResolvedGrant } from './permissions.js';

export type GrantShape = Pick<ResolvedGrant, 'resource' | 'verbs' | 'scope' | 'scopeResolver' | 'conditions'>;

export interface GrantGap {
  resource: string;
  verb: Verb;
  scope: Scope;
  scopeResolver: string | null;
}

// Mirrors scopeRank in permissions.ts. Kept local rather than exported from the
// evaluator, which must not be reshaped for this check.
const SCOPE_RANK: Record<Scope, number> = { own: 0, own_or_unowned: 1, all: 2 };

/** The grants a role confers, read as resolveGrants reads them: effective now only. Null when the tenant has no such role. */
export async function grantsOfRole(tenantId: string, roleSlug: string): Promise<GrantShape[] | null> {
  const role = await prisma.accessRole.findFirst({ where: { tenantId, slug: roleSlug }, select: { id: true } });
  if (!role) return null;
  const now = new Date();
  const rows = await prisma.grant.findMany({
    where: { tenantId, roleId: role.id, effectiveFrom: { lte: now } },
  });
  return rows
    .filter((g) => !g.effectiveTo || g.effectiveTo > now)
    .map((g) => ({
      resource: g.resource,
      verbs: g.verbs as Verb[],
      scope: g.scope as Scope,
      scopeResolver: g.scopeResolver,
      conditions: (g.conditions as Record<string, unknown>) ?? {},
    }));
}

/**
 * Pure: the verb-level grants in `target` that `held` does not cover. Empty
 * means the assigner may name the role.
 *
 * A held grant with a scopeResolver covers only a target with the same
 * resolver, because a resolver narrows the rows it reaches. A held grant with
 * conditions covers only a target with the same conditions, for the same reason.
 */
export function uncoveredGrants(target: GrantShape[], held: GrantShape[]): GrantGap[] {
  const gaps: GrantGap[] = [];
  for (const g of target) {
    for (const verb of g.verbs) {
      const covered = held.some(
        (h) =>
          h.resource === g.resource &&
          h.verbs.includes(verb) &&
          SCOPE_RANK[h.scope] >= SCOPE_RANK[g.scope] &&
          (h.scopeResolver === null || h.scopeResolver === g.scopeResolver) &&
          conditionsWithin(h.conditions, g.conditions),
      );
      if (!covered) gaps.push({ resource: g.resource, verb, scope: g.scope, scopeResolver: g.scopeResolver });
    }
  }
  return gaps;
}

function conditionsWithin(held: Record<string, unknown>, wanted: Record<string, unknown>): boolean {
  if (Object.keys(held).length === 0) return true;
  return stableJson(held) === stableJson(wanted);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export interface RoleAssignment {
  roleSlug: string;
  /** The party the role will attach to. Omit only when the check runs before that party exists. */
  targetPartyId?: string | null;
}

/**
 * Throws 403 when the current caller may not name this role for this party,
 * and 422 when the tenant has no such role. Call before any write that sets or
 * reactivates the affiliation carrying the role.
 */
export async function assertCanAssignRole(input: RoleAssignment, auth: AuthContext = currentAuth()): Promise<void> {
  // The system principal is trusted for scheduled work, as evaluate() trusts it.
  if (auth.principalType === 'system') return;

  if (input.targetPartyId && auth.partyId && input.targetPartyId === auth.partyId) {
    throw ApiError.forbidden(
      `A role cannot be assigned to your own party. Someone else with the authority to assign '${input.roleSlug}' must do it.`,
    );
  }

  const target = await grantsOfRole(auth.tenantId, input.roleSlug);
  if (!target) throw ApiError.unprocessable(`Access role '${input.roleSlug}' is not defined for this tenant.`);

  const gaps = uncoveredGrants(target, await resolveGrants(auth));
  if (gaps.length > 0) {
    const named = gaps
      .slice(0, 3)
      .map((g) => `${g.resource}:${g.verb}@${g.scope}`)
      .join(', ');
    const more = gaps.length > 3 ? ` and ${gaps.length - 3} more` : '';
    throw ApiError.forbidden(
      `'${input.roleSlug}' confers ${named}${more}, which your own grants do not cover. You cannot assign a role broader than your own.`,
    );
  }
}
