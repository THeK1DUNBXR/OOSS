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

import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient } from '@prisma/client';
import { getContext, maybeTenantId } from './context.js';
import { config } from './config.js';

/**
 * The Postgres setting the row-level-security policies read (FX-51).
 *
 * Every tenant table's policy is `"tenantId" = current_setting('app.tenant_id')`,
 * so a query that reaches the database without this set sees no rows and can
 * write none. The setting is applied with `set_config(..., true)`, which lasts
 * only as long as the enclosing transaction: a pooled connection cannot carry
 * one tenant's setting into the next request. That is why every scoped
 * statement runs inside a transaction that starts by setting it.
 */
const TENANT_SETTING = 'app.tenant_id';

/**
 * True while the current async call is inside a `$transaction` whose tenant
 * setting has already been applied. Ops in that scope run on the transaction
 * and must not open a transaction of their own, or they would leave it.
 */
const insideTenantTransaction = new AsyncLocalStorage<true>();

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

const logLevels: Prisma.LogLevel[] = config.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'];

// The application role. Row-level security applies to it; see rlsGuard.ts for
// the boot check that refuses a role which would bypass it.
const basePrisma = new PrismaClient({ datasourceUrl: config.DATABASE_URL, log: logLevels });

function lowerFirst(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/**
 * Runs one already-scoped operation with the tenant setting applied.
 *
 * Inside a transaction the operation joins that transaction, which set the
 * setting when it began. Outside one, the operation gets a transaction of its
 * own: the setting and the statement must share a transaction or the setting
 * is gone before the statement runs. The statement goes through the unextended
 * delegate, so the scope above is not applied twice.
 */
function runScoped(
  model: string,
  operation: string,
  args: unknown,
  tenantId: string,
  query: (args: unknown) => Promise<unknown>,
): Promise<unknown> {
  if (insideTenantTransaction.getStore()) return query(args);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const delegate = (basePrisma as any)[lowerFirst(model)];
  return basePrisma
    .$transaction([
      basePrisma.$executeRaw`SELECT set_config(${TENANT_SETTING}, ${tenantId}, true)`,
      delegate[operation](args),
    ])
    .then((results) => results[1]);
}

const tenantScoped = basePrisma.$extends({
  name: 'tenantScope',
  query: {
    $allModels: {
      // Typed loosely on purpose: with this many models the generated union
      // of every model's every operation exceeds what the compiler will
      // represent (TS2590). The gate reads only the model name and the
      // where/data shapes, which the loose type still carries.
      async $allOperations({ model, operation, args, query }: {
        model: string;
        operation: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        query: (args: any) => Promise<unknown>;
      }) {
        if (!model || TENANT_EXEMPT_MODELS.has(model)) return query(args);

        const tenantId = maybeTenantId();
        const ctx = getContext();

        // No tenant in scope is always a refusal. There used to be a warn
        // mode here, switched on by an environment variable, that logged the
        // query and ran it unscoped — an off switch on the one gate that stops
        // a tenant reading another tenant's rows. It is gone.
        if (!tenantId) throw new TenantScopeError(model, operation);

        const next = { ...(args as Record<string, any>) };

        if (READ_OPS.has(operation) || UPDATE_OPS.has(operation)) {
          if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
            // A unique lookup cannot take an arbitrary filter, so it is
            // rewritten to a findFirst-shaped scoped query by the caller-facing
            // helpers below. Here we degrade safely: fetch, then verify tenancy.
            // Row-level security has already withheld another tenant's row by
            // the time it reaches here; this check is the second line, kept for
            // the case where the row is returned but its tenant is not selected.
            const result = await runScoped(model, operation, next, tenantId, query);
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

        return runScoped(model, operation, next, tenantId, query);
      },
    },
  },
});

/**
 * Transactions carry the tenant setting. An interactive transaction sets it
 * first and runs its callback inside `insideTenantTransaction`, so the ops it
 * makes do not each open another. A batch array gets the setting as its first
 * element, which is what keeps the batch atomic. Without a tenant in scope the
 * transaction is passed through unchanged: the operations inside it are then
 * refused by the scope gate, and any statement that reached the database would
 * be refused by row-level security.
 */
export const prisma = tenantScoped.$extends({
  name: 'tenantTransaction',
  client: {
    $transaction: ((arg: unknown, options?: unknown) => {
      const tenantId = maybeTenantId();
      if (!tenantId) return tenantScoped.$transaction(arg as never, options as never);

      if (typeof arg === 'function') {
        return tenantScoped.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config(${TENANT_SETTING}, ${tenantId}, true)`;
          return insideTenantTransaction.run(true, () => (arg as (t: unknown) => unknown)(tx));
        }, options as never);
      }

      const setting = tenantScoped.$executeRaw`SELECT set_config(${TENANT_SETTING}, ${tenantId}, true)`;
      return insideTenantTransaction
        .run(true, () => tenantScoped.$transaction([setting, ...(arg as unknown[])] as never, options as never))
        .then((results) => (results as unknown[]).slice(1));
    }) as unknown as typeof tenantScoped.$transaction,
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
 *
 * It connects as UNSCOPED_DATABASE_URL, a role that may bypass row-level
 * security. Without that variable it falls back to the application role, which
 * is safe: row-level security then hides every tenant row from it, so a job
 * that needs cross-tenant reads fails visibly rather than reading everything.
 */
export const unscopedPrisma = new PrismaClient({
  datasourceUrl: config.UNSCOPED_DATABASE_URL ?? config.DATABASE_URL,
  log: logLevels,
});

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
