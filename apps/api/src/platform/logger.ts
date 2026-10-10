/**
 * The process logger. Every line goes through an allowlist.
 *
 * The filter keeps only the field names listed in SAFE_FIELDS and drops every
 * other key from a log object. A denylist ("redact password, token, ...") fails
 * open: the first new field someone names `pw`, `ssn` or `bankAccount` reaches
 * the log. An allowlist fails closed, so a field has to be argued for here
 * before it is written anywhere.
 */

import pino, { type DestinationStream, type Logger } from 'pino';
import { config } from './config.js';

export const SAFE_FIELDS: ReadonlySet<string> = new Set([
  // Set by pino itself or by the base bindings below.
  'level',
  'time',
  'service',
  'msg',
  // Correlation. Every request line carries both (CLAUDE.md rule 6).
  'requestId',
  'correlationId',
  'tenantId',
  // Request shape. The path, never the query string: query strings carry
  // tokens and search terms.
  'method',
  'path',
  'status',
  'durationMs',
  // Errors. The whole error is logged server-side on purpose (Phase 0.3);
  // the HTTP response is what must stay generic.
  'err',
  // Which subsystem a process-level line came from (boot, scheduler, ...).
  'component',
]);

/** Exported so the rule can be tested without writing a log file. */
export function allowlistFields(obj: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (SAFE_FIELDS.has(key)) kept[key] = obj[key];
  }
  return kept;
}

export interface LoggerOptions {
  destination?: DestinationStream;
  level?: string;
}

export function createLogger({ destination, level = 'info' }: LoggerOptions = {}): Logger {
  const options = {
    level,
    base: { service: 'kaizen-api' },
    formatters: {
      log: allowlistFields,
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

// Silent under test so the suite's output stays readable; the hardening tests
// build their own logger over a capturing stream rather than reading this one.
export const logger = createLogger({ level: config.NODE_ENV === 'test' ? 'silent' : 'info' });
