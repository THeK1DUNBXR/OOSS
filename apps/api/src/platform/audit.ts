/**
 * The audit log (CRM-FOUND-006).
 *
 * Append-only, with no update or delete path. Write-audit for every governed
 * entity; read-audit for `regulated` fields only, preserving the original
 * performance-driven design for the common case ("reads never audited") exactly
 * where it was correct.
 *
 * A read of confidential or regulated data produces an AUDIT_RECORD, never an
 * event — reads are explicitly kept out of the event stream even as they gain
 * audit coverage.
 */

import { prisma } from './db.js';
import { currentAuth, getContext } from './context.js';

export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'merge',
  'export',
  'login',
  'permission_change',
  'read',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * GOVERNED_ENTITIES is a per-domain-extensible registry, not a flat CRM-only
 * array: CRM keeps its 12-entity contribution, other domains contribute theirs,
 * and the union is what the write path checks against.
 */
const governedRegistry = new Map<string, Set<string>>();

export function registerGovernedEntities(domain: string, entities: string[]): void {
  const existing = governedRegistry.get(domain) ?? new Set<string>();
  for (const e of entities) existing.add(e);
  governedRegistry.set(domain, existing);
}

export function governedEntities(): string[] {
  const union = new Set<string>();
  for (const set of governedRegistry.values()) for (const e of set) union.add(e);
  return [...union].sort();
}

export function isGoverned(entityType: string): boolean {
  for (const set of governedRegistry.values()) if (set.has(entityType)) return true;
  return false;
}

// CRM's original 12-entity contribution, preserved verbatim.
registerGovernedEntities('crm', [
  'person',
  'organization',
  'institution',
  'relationship',
  'lead',
  'opportunity',
  'mou',
  'student',
  'enrollment',
  'payment',
  'user',
  'role',
]);

// Extended by this handoff.
registerGovernedEntities('crm', [
  'document',
  'interaction',
  'pipeline_definition',
  'pipeline_stage',
  'pipeline_transition',
  'offering',
  'price_book_entry',
  'win_loss_review',
  'territory',
  'routing_rule',
  'account',
  'institution_profile',
]);
registerGovernedEntities('pct', ['contract', 'partner_agreement', 'proposal', 'quote']);
registerGovernedEntities('gov', ['policy', 'policy_version', 'grant', 'authority_grant', 'decision', 'delegation']);
registerGovernedEntities('fin', ['invoice', 'receipt', 'credit_note', 'fee_instalment']);
// Added with invoicing and the returns: the company's own registration, which
// every invoice is printed from, and a filed return, which is a statement to
// the government. Both are things somebody will one day have to prove who
// changed and when.
registerGovernedEntities('fin', ['company_profile', 'gst_filing', 'invoice_line', 'final_invoice']);
// The catalogue is a price list, so a change to it is a change to what
// customers are charged; and a student's timeline carries complaints, which is
// the last place an untraceable edit belongs.
registerGovernedEntities('edu', ['course', 'cohort', 'learner_log']);

/** Fields dropped from every diff — noise, never signal. */
const NOISE_FIELDS = new Set(['updatedAt', 'createdAt', 'id', 'tenantId', '__v']);

export function diffForAudit(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (NOISE_FIELDS.has(key)) continue;
    const from = before?.[key];
    const to = after?.[key];
    if (stableStringify(from) !== stableStringify(to)) diff[key] = { from: normalise(from), to: normalise(to) };
  }
  return diff;
}

/**
 * `JSON.stringify` throws on a bigint (`ShareTransaction.distinctiveFrom`
 * and its neighbours are the first bigint columns this platform has), so
 * comparison — not only storage — has to go through a replacer that stands
 * one in for a string, or writing an audit record for any row carrying one
 * throws before the write it is meant to record ever happens.
 */
function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

function normalise(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v && typeof v === 'object' && 'toString' in v && v.constructor?.name === 'Decimal') return Number(v.toString());
  return v;
}

export interface AuditWriteInput {
  action: AuditAction;
  subjectType: string;
  subjectId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
  /** Forces the record even if the entity is not on the governed registry. */
  force?: boolean;
}

export async function auditWrite(input: AuditWriteInput): Promise<void> {
  if (!input.force && !isGoverned(input.subjectType)) return;
  const auth = currentAuth();
  const diff = input.action === 'update' ? diffForAudit(input.before ?? null, input.after ?? null) : null;

  await prisma.auditRecord.create({
    data: {
      tenantId: auth.tenantId,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      actorType: auth.principalType,
      actorId: auth.partyId,
      actorLabel: auth.roleSlug,
      actorAgentId: auth.agentId,
      diff: (diff ?? input.after ?? undefined) as never,
      meta: (input.meta ?? undefined) as never,
    },
  });
}

/**
 * Fires whenever a query result includes at least one `regulated` field for the
 * requesting principal's context. Logs field names only, never values. A
 * projection that excludes the regulated field from its output produces no
 * record — the hook inspects the outgoing response shape, not the schema.
 */
export async function auditRegulatedRead(
  subjectType: string,
  subjectId: string,
  fieldsRead: string[],
): Promise<void> {
  if (fieldsRead.length === 0) return;
  const auth = currentAuth();
  await prisma.auditRecord.create({
    data: {
      tenantId: auth.tenantId,
      action: 'read',
      subjectType,
      subjectId,
      actorType: auth.principalType,
      actorId: auth.partyId,
      actorLabel: auth.roleSlug,
      // An AI agent's read of a regulated field is read-audited exactly as a
      // human's would be — no special-casing for AI principals.
      actorAgentId: auth.agentId,
      fieldsRead,
    },
  });
}

/** Bulk export is the one read that has always been audited. */
export async function auditExport(subjectType: string, scope: string, recordCount: number): Promise<void> {
  const auth = currentAuth();
  await prisma.auditRecord.create({
    data: {
      tenantId: auth.tenantId,
      action: 'export',
      subjectType,
      subjectId: 'bulk',
      actorType: auth.principalType,
      actorId: auth.partyId,
      actorLabel: auth.roleSlug,
      meta: { scope, recordCount } as never,
    },
  });
}

/** A bulk operation (a migration batch, a backfill) is audited as one traceable event. */
export async function auditBulkOperation(
  subjectType: string,
  operation: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const auth = currentAuth();
  const ctx = getContext();
  await prisma.auditRecord.create({
    data: {
      tenantId: auth.tenantId,
      action: 'update',
      subjectType,
      subjectId: `bulk:${operation}`,
      actorType: auth.principalType,
      actorId: auth.partyId,
      actorLabel: auth.roleSlug,
      meta: { ...meta, operation, requestId: ctx?.requestId } as never,
    },
  });
}
