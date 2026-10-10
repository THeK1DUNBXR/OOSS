/**
 * Express plumbing: context establishment, error shaping, async handler wrapper.
 */

import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { ROLE_CLASSIFICATION_CEILING, type SensitivityClass } from '@kaizen/shared';
import { unscopedPrisma } from '../platform/db.js';
import { getContext, newRequestContext, runWithContext, type RequestContext } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { TenantScopeError } from '../platform/db.js';
import { liveSessionFor, toAuthContext, verifyToken } from './auth.js';
import { grantedConsentCodes, resolvePurpose } from '../domains/compliance/privacy.js';
import { logger } from '../platform/logger.js';

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
      // A token whose Session is revoked, expired or absent is no credential,
      // whatever its signature and expiry say. Logout takes effect here.
      const session = await liveSessionFor(payload);
      const user = session
        ? await unscopedPrisma.user.findFirst({
            where: { id: payload.userId, status: 'active' },
            select: { id: true, personId: true, tenantId: true, branch: true },
          })
        : null;
      if (session && user) {
        const affiliation = await unscopedPrisma.affiliation.findFirst({
          where: { id: payload.affiliationId, tenantId: user.tenantId, status: 'active' },
        });
        // A revoked affiliation goes dark on the very next query — no
        // deprovisioning job, no session-invalidation step.
        if (affiliation) {
          // A missing role is no role, never a default one. Defaulting it to
          // 'sales' gave the sales seat to every affiliation whose role was
          // never set, so the holder could read what sales can read. With no
          // role there are no grants, and the ceiling is the lowest class.
          const roleSlug = affiliation.roleSlug;
          const role = roleSlug
            ? await unscopedPrisma.accessRole.findFirst({
                where: { tenantId: user.tenantId, slug: roleSlug },
                select: { classificationCeiling: true },
              })
            : null;
          const ceiling = (
            roleSlug ? (role?.classificationCeiling ?? ROLE_CLASSIFICATION_CEILING[roleSlug] ?? 'internal') : 'public'
          ) as SensitivityClass;
          ctx.auth = toAuthContext(
            { ...payload, tenantId: user.tenantId },
            user.personId,
            roleSlug,
            user.branch,
            affiliation.orgUnitId,
            ceiling,
          );
          // The WHY axis's real data: which purposes this person has actually
          // granted consent for, and the purpose this request is bound to —
          // accepted from the client only when the current privacy notice
          // names it, never invented by the header.
          ctx.auth.consentCodes = user.personId ? await grantedConsentCodes(user.tenantId, user.personId) : [];
          ctx.auth.purpose = await resolvePurpose(user.tenantId, req.headers['x-purpose'] as string | undefined);
          ctx.auth.sessionId = session.id;
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

export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction) {
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

  // The full error goes to the log, where the on-call person needs it. The
  // response carries a code and a request id only: a Prisma or driver message
  // names hosts, users and sometimes the values that failed a constraint, and
  // none of that belongs in a body an unauthenticated caller can read.
  const requestId = getContext()?.requestId ?? req.ctx?.requestId;
  const tenantId = req.ctx?.auth?.tenantId ?? null;

  // express.json and express.urlencoded reject a bad body before any route runs,
  // with an error that carries a `type` but is not an ApiError. The caller caused
  // these, so they are 4xx with fixed text. Left to the 500 branch they would
  // page on-call for every client that sends malformed JSON. They are returned
  // here without logging: on Node 22 the parser's message can carry a fragment
  // of the body, which is personal data, and the request line already records
  // the status.
  const errType = typeof err === 'object' && err !== null ? (err as { type?: unknown }).type : undefined;
  if (errType === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'The request body is not valid JSON.', requestId } });
    return;
  }
  if (errType === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.', requestId } });
    return;
  }

  if (err instanceof TenantScopeError) {
    // A query that escaped the tenant gate is a 500 in staging, caught before
    // production cutover — never a silently unscoped result.
    logger.error({ requestId, tenantId, err }, 'query ran outside the tenant gate');
    res.status(500).json({ error: { code: err.code, requestId } });
    return;
  }

  logger.error({ requestId, tenantId, err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', requestId } });
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
