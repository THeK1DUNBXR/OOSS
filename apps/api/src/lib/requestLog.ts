/**
 * One line per request, written when the response finishes.
 *
 * The request context is read at finish, not at entry: contextMiddleware
 * resolves the tenant after this middleware has already been entered, and the
 * context object is shared by reference, so the finished line sees the tenant
 * the request actually ran as. A line written at entry would always say
 * tenantId null.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../platform/logger.js';

export function requestLog(log: Logger = defaultLogger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      log.info(
        {
          requestId: req.ctx?.requestId,
          tenantId: req.ctx?.auth?.tenantId ?? null,
          method: req.method,
          // Path only. The query string is where tokens and search terms end up.
          path: req.path,
          status: res.statusCode,
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        },
        'request',
      );
    });
    next();
  };
}
