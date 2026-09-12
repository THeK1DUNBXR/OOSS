/**
 * Request-scoped context.
 *
 * `ctx.auth.tenantId` is resolved from the user record at session creation —
 * never from a request parameter or header. That closes the class of
 * vulnerability where a client-supplied tenant identifier could be spoofed.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ulid } from 'ulid';
import type { SensitivityClass } from '@kaizen/shared';

export type PrincipalType = 'human' | 'agent' | 'system' | 'integration';

export interface AuthContext {
  tenantId: string;
  principalType: PrincipalType;
  /** The Person id behind a human principal. */
  partyId: string | null;
  userId: string | null;
  agentId: string | null;
  /** When an agent acts for a person it carries this, and is never assigned a role. */
  onBehalfOfPartyId: string | null;
  affiliationId: string | null;
  roleSlug: string | null;
  branch: string | null;
  orgUnitId: string | null;
  classificationCeiling: SensitivityClass;
  /** The WHY axis — the purpose this access is bound to. */
  purpose: string | null;
  consentCodes: string[];
  /** True only for a step-up-authenticated session. */
  stepUpVerified: boolean;
}

export interface RequestContext {
  requestId: string;
  correlationId: string;
  causationId: string | null;
  auth: AuthContext | null;
  /**
   * When true the tenant-scope guard logs a query it would have rejected
   * instead of blocking it. Used for the one-release warn-mode bake before the
   * enforce-mode flip.
   */
  startedAt: number;
  /** Collected during a request and flushed after the response is sent. */
  deferredEffects: Array<() => Promise<void>>;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requireContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      'No request context in scope. Every data access must run inside runWithContext — ' +
        'there is no silent fallback to an unscoped query anywhere in the read or write path.',
    );
  }
  return ctx;
}

export function currentAuth(): AuthContext {
  const ctx = requireContext();
  if (!ctx.auth) throw new Error('No authenticated principal in scope.');
  return ctx.auth;
}

export function currentTenantId(): string {
  return currentAuth().tenantId;
}

/** Optional tenant, for paths (login, health) that legitimately run unauthenticated. */
export function maybeTenantId(): string | null {
  return storage.getStore()?.auth?.tenantId ?? null;
}

export function newRequestContext(partial: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: partial.requestId ?? ulid(),
    correlationId: partial.correlationId ?? ulid(),
    causationId: partial.causationId ?? null,
    auth: partial.auth ?? null,
    startedAt: Date.now(),
    deferredEffects: partial.deferredEffects ?? [],
  };
}

/**
 * The SYSTEM_PRINCIPAL — the only principal that may act with no
 * `on_behalf_of`. Scheduled jobs run as this, per tenant per run: a job that
 * iterates "all MoUs expiring in 30 days" does so once per tenant, never once
 * globally.
 */
export function systemContext(tenantId: string, purpose = 'scheduled_automation'): RequestContext {
  return newRequestContext({
    auth: {
      tenantId,
      principalType: 'system',
      partyId: null,
      userId: null,
      agentId: null,
      onBehalfOfPartyId: null,
      affiliationId: null,
      roleSlug: 'system',
      branch: null,
      orgUnitId: null,
      classificationCeiling: 'regulated',
      purpose,
      consentCodes: [],
      stepUpVerified: true,
    },
  });
}

export function agentContext(
  tenantId: string,
  agentId: string,
  onBehalfOfPartyId: string | null = null,
  purpose = 'agent_action',
): RequestContext {
  return newRequestContext({
    auth: {
      tenantId,
      principalType: 'agent',
      partyId: null,
      userId: null,
      agentId,
      onBehalfOfPartyId,
      // An AGENT_PRINCIPAL is never assigned a role — it is bound to its own
      // AUTHORITY_GRANT.
      affiliationId: null,
      roleSlug: null,
      branch: null,
      orgUnitId: null,
      classificationCeiling: 'internal',
      purpose,
      consentCodes: [],
      stepUpVerified: false,
    },
  });
}

/** Runs `fn` with a fresh system context for the given tenant. */
export async function asSystem<T>(tenantId: string, fn: () => Promise<T>, purpose?: string): Promise<T> {
  return runWithContext(systemContext(tenantId, purpose), fn);
}
