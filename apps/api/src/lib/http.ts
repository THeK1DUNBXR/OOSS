/**
 * Express plumbing: context establishment, error shaping, async handler wrapper.
 */

import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { ROLE_CLASSIFICATION_CEILING, type SensitivityClass } from '@kaizen/shared';
import { unscopedPrisma } from '../platform/db.js';
import { newRequestContext, runWithContext, type RequestContext } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { TenantScopeError } from '../platform/db.js';
import { toAuthContext, verifyToken } from './auth.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: RequestContext;
    }
  }
}

/**
 * Establishes the request context. `tenantId` is resolved from the session
 * token's user record — never from a request parameter or header.
 */
export async function contextMiddleware(req: Request, res: Response, next: NextFunction) {
  const ctx = newRequestContext({ correlationId: (req.headers['x-correlation-id'] as string) || undefined });
  req.ctx = ctx;
  res.setHeader('x-request-id', ctx.requestId);

  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(header.slice(7));
      const user = await unscopedPrisma.user.findFirst({
        where: { id: payload.userId, status: 'active' },
        select: { id: true, personId: true, tenantId: true, branch: true },
      });
      if (user) {
        const affiliation = await unscopedPrisma.affiliation.findFirst({
          where: { id: payload.affiliationId, tenantId: user.tenantId, status: 'active' },
        });
        // A revoked affiliation goes dark on the very next query — no
        // deprovisioning job, no session-invalidation step.
        if (affiliation) {
          const roleSlug = affiliation.roleSlug ?? 'sales';
          const role = await unscopedPrisma.accessRole.findFirst({
            where: { tenantId: user.tenantId, slug: roleSlug },
            select: { classificationCeiling: true },
          });
          const ceiling = (role?.classificationCeiling ?? ROLE_CLASSIFICATION_CEILING[roleSlug] ?? 'internal') as SensitivityClass;
          ctx.auth = toAuthContext(
            { ...payload, tenantId: user.tenantId },
            user.personId,
            roleSlug,
            user.branch,
            affiliation.orgUnitId,
            ceiling,
          );
        }
      }
    } catch {
      // An invalid token leaves the context unauthenticated; the route's own
      // requireAuth decides whether that is acceptable.
    }
  }

  runWithContext(ctx, () => next());
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.ctx?.auth) return next(ApiError.unauthorized());
  next();
}

/** Wraps an async handler so a rejection reaches the error middleware. */
export function handler(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    const ctx = req.ctx;
    const run = async () => {
      try {
        const result = await fn(req, res);
        if (!res.headersSent && result !== undefined) res.json(result);
      } catch (err) {
        next(err);
      }
    };
    if (ctx) runWithContext(ctx, run);
    else void run();
  };
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    const details = err.details as { candidates?: unknown[]; axes?: unknown[] } | undefined;
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        ...(details?.candidates ? { candidates: details.candidates } : {}),
        ...(details?.axes ? { axes: details.axes } : {}),
      },
    });
    return;
  }

  if (err instanceof TenantScopeError) {
    // A query that escaped the tenant gate is a 500 in staging, caught before
    // production cutover — never a silently unscoped result.
    console.error('[tenant-scope]', err.message);
    res.status(500).json({ error: { code: err.code, message: err.message } });
    return;
  }

  const message = err instanceof Error ? err.message : 'Unexpected error';
  console.error('[error]', err);
  res.status(500).json({ error: { code: 'INTERNAL', message } });
}

export function parsePaging(req: Request) {
  const page = Math.max(Number(req.query.page ?? 1) || 1, 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize ?? 50) || 50, 1), 200);
  return { page, pageSize };
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

export function bool(v: unknown): boolean | undefined {
  if (v === 'true' || v === true) return true;
  if (v === 'false' || v === false) return false;
  return undefined;
}

export function date(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function numeric(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}
