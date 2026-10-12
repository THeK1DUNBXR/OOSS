/**
 * The process logger. Every line goes through an allowlist.
 *
 * The filter keeps only the field names listed in SAFE_FIELDS and drops every
 * other key from a log object. A denylist ("redact password, token, ...") fails
 * open: the first new field someone names `pw`, `ssn` or `bankAccount` reaches
 * the log. An allowlist fails closed, so a field has to be argued for here
 * before it is written anywhere.
 */

import pino, { type Bindings, type ChildLoggerOptions, type DestinationStream, type Logger } from 'pino';
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
  // Request shape. The route pattern, never the raw path: public routes carry
  // a form token and a webhook endpoint token in the path, and a query string
  // carries tokens and search terms.
  'method',
  'route',
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

/**
 * An error keeps its type, message, stack and a string code, and nothing else.
 * pino's own serializer copies every enumerable property of the error onto the
 * output, and `err` is on the allowlist as a whole, so a property an error was
 * built with would reach the log past the field filter. An error built from a
 * record (`Object.assign(new Error(), { guardianPhone })`) is the case this closes.
 * The message is not scanned: a driver message that quotes a value is still a
 * value in the log, and no field-name rule can see it.
 */
export function serialiseError(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return err;
  const e = err as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
  if (typeof e.message !== 'string') return { type: 'NonError' };
  return {
    type: typeof e.name === 'string' ? e.name : 'Error',
    message: e.message,
    stack: typeof e.stack === 'string' ? e.stack : undefined,
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
  };
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
      err: serialiseError,
    },
  };
  const root = destination ? pino(options, destination) : pino(options);
  // pino 10 writes a child's bindings outside `formatters.log`, and runs
  // `formatters.bindings` on the base only. Without this a logger.child({ pan })
  // would put the value on every line of the child. Nested children inherit the
  // wrapped method from their parent.
  const rawChild = root.child.bind(root);
  root.child = ((bindings: Bindings, opts?: ChildLoggerOptions) =>
    rawChild(allowlistFields(bindings), opts)) as Logger['child'];
  return root;
}

// Silent under test so the suite's output stays readable; the hardening tests
// build their own logger over a capturing stream rather than reading this one.
export const logger = createLogger({ level: config.NODE_ENV === 'test' ? 'silent' : 'info' });
