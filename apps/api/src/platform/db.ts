/**
 * The tenant-scope gate (CRM-FOUND-001).
 *
 * Tenant scoping is evaluated BEFORE the five-axis formula runs — it is not one
 * of the five axes, it is the gate a request must clear before
 * WHO/WHERE/WHAT/HOW MUCH/WHY are evaluated at all. A cross-tenant request
 * never reaches five-axis evaluation; it fails at the isolation gate with a 404,
 * never a 403 (a deliberately weaker information leak than confirming a record
 * exists in another tenant).
 *
 * The extension below injects `tenantId` into every read and write from
 * `ctx.auth.tenantId`. A query with no tenant context in scope throws rather
 * than running unscoped. No role bypasses this in application code, including
 * the chairman included — a genuine cross-tenant operation goes through the explicit,
 * separately-audited SYSTEM_PRINCIPAL path.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { getContext, maybeTenantId } from './context.js';

/**
 * Models that legitimately have no tenant key.
 *
 * `Principal` joins `Tenant` here: a person's credential and login are cross-
 * tenant by nature — one email, one password, however many tenants they hold
 * a `User` row in — so a `tenantId` on it would be meaningless (whose?) rather
 * than merely inconvenient. Its use stays confined to `lib/auth.ts`,
 * `lib/http.ts` and the seed, which are the only places identity is resolved
 * before a tenant is.
 */
const TENANT_EXEMPT_MODELS = new Set<string>(['Tenant', 'Principal']);

/** Operations whose `where` clause we scope. */
const READ_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

const UPDATE_OPS = new Set(['update', 'updateMany', 'delete', 'deleteMany', 'upsert']);

const CREATE_OPS = new Set(['create', 'createMany', 'upsert']);

export class TenantScopeError extends Error {
  readonly code = 'TENANT_SCOPE_MISSING';
  constructor(model: string, operation: string) {
    super(
      `Query on ${model}.${operation} ran with no tenant context in scope. ` +
        'Every data access must resolve a tenant before it reaches the database.',
    );
  }
}

/** Records unscoped queries during warn mode so unmigrated code paths surface. */
export const tenantWarnLog: Array<{ model: string; operation: string; at: string }> = [];

function scopeWhere(where: unknown, tenantId: string): Record<string, unknown> {
  const base = (where && typeof where === 'object' ? (where as Record<string, unknown>) : {}) ?? {};
  return { ...base, tenantId };
}

function applyTenantToData(data: unknown, tenantId: string): unknown {
  if (Array.isArray(data)) return data.map((d) => applyTenantToData(d, tenantId));
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (record.tenantId === undefined) return { ...record, tenantId };
  }
  return data;
}

const basePrisma = new PrismaClient({
  log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

export const prisma = basePrisma.$extends({
  name: 'tenantScope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!model || TENANT_EXEMPT_MODELS.has(model)) return query(args);

        const tenantId = maybeTenantId();
        const ctx = getContext();

        if (!tenantId) {
          if (ctx?.tenantWarnMode) {
            // Warn mode: log the query we would have rejected, but let it run —
            // one release cycle to surface unmigrated code paths.
            tenantWarnLog.push({ model, operation, at: new Date().toISOString() });
            return query(args);
          }
          throw new TenantScopeError(model, operation);
        }

        const next = { ...(args as Record<string, any>) };

        if (READ_OPS.has(operation) || UPDATE_OPS.has(operation)) {
          if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
            // A unique lookup cannot take an arbitrary filter, so it is
            // rewritten to a findFirst-shaped scoped query by the caller-facing
            // helpers below. Here we degrade safely: fetch, then verify tenancy.
            const result = await query(next);
            if (result && typeof result === 'object' && 'tenantId' in (result as any)) {
              if ((result as any).tenantId !== tenantId) return null;
            }
            return result;
          }
          if (operation === 'upsert') {
            next.where = scopeWhere(next.where, tenantId);
            next.create = applyTenantToData(next.create, tenantId);
          } else {
            next.where = scopeWhere(next.where, tenantId);
          }
        }

        if (CREATE_OPS.has(operation) && operation !== 'upsert') {
          next.data = applyTenantToData(next.data, tenantId);
        }

        if (operation === 'update' || operation === 'updateMany') {
          // A write must never be able to move a row into another tenant.
          if (next.data && typeof next.data === 'object' && 'tenantId' in next.data) {
            delete (next.data as Record<string, unknown>).tenantId;
          }
        }

        return query(next);
      },
    },
  },
});

export type Db = typeof prisma;

/**
 * The client handed to an interactive transaction callback.
 *
 * `Prisma.TransactionClient` describes the *unextended* client, so it does not
 * match what `$transaction` yields here — the tenant-scope guard is an
 * extension, and it is precisely the thing a transaction must not lose. Any
 * helper that takes a `tx` parameter should take this.
 */
export type DbTx = Omit<Db, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/**
 * A raw, unscoped client. Reachable only from the seed script and the
 * separately-audited platform-support path — never from request-scoped code.
 */
export const unscopedPrisma = basePrisma;

export { Prisma };

/** Decimal-safe number coercion for API payloads. */
export function num(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value.toString());
}

export function dec(value: number | null | undefined): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  return new Prisma.Decimal(value);
}
