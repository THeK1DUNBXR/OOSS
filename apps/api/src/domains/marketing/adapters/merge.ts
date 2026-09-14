/**
 * Safe `{{merge.field}}` renderer for marketing templates.
 *
 * Deliberately NOT a template engine: no expressions, no conditionals, no
 * code execution. A field is a dotted path (`person.firstName`) resolved
 * against a plain data object by property lookup only — nothing is ever
 * `eval`'d or `Function`-constructed. An unknown or unresolvable field
 * renders as an empty string and is reported in `missing[]` so the caller
 * (a send preview, or a pre-send validation) can warn before anything goes
 * out, per AI-MKT-002's "never auto-sent" boundary and EX-MKT constraints
 * around bad sends.
 */

import type { RenderedMessage } from './types.js';

const FIELD_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function resolvePath(data: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = data;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return '';
  return String(value);
}

/** All distinct `{{field}}` references in a template body, in first-seen order. */
export function extractMergeFields(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of body.matchAll(FIELD_PATTERN)) {
    const field = match[1];
    if (!seen.has(field)) {
      seen.add(field);
      out.push(field);
    }
  }
  return out;
}

function renderOne(
  template: string,
  mergeData: Record<string, unknown>,
  missing: Set<string>,
  escape: boolean,
): string {
  return template.replace(FIELD_PATTERN, (_whole, field: string) => {
    const value = resolvePath(mergeData, field);
    if (value === undefined || value === null) {
      missing.add(field);
      return '';
    }
    const rendered = stringifyValue(value);
    return escape ? escapeHtml(rendered) : rendered;
  });
}

/**
 * Renders `body` (and optionally `subject`) against `mergeData`. `escape`
 * defaults to false (SMS/WhatsApp are plain text); email sending should pass
 * `escape: true` for the body.
 */
export function renderMergeFields(
  body: string,
  subject: string | undefined,
  mergeData: Record<string, unknown>,
  opts: { escape?: boolean } = {},
): RenderedMessage {
  const missing = new Set<string>();
  const escape = opts.escape ?? false;
  const renderedBody = renderOne(body, mergeData, missing, escape);
  // Subject lines are never HTML-escaped even for email — they render as
  // plain text in mail clients' subject fields.
  const renderedSubject = subject === undefined ? undefined : renderOne(subject, mergeData, missing, false);
  return { body: renderedBody, subject: renderedSubject, missing: Array.from(missing) };
}
