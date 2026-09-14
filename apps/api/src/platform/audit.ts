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

import { createHash } from 'node:crypto';
import { prisma, unscopedPrisma } from './db.js';
import { currentAuth, getContext } from './context.js';
import { assertCan } from './permissions.js';

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
    if (JSON.stringify(from) !== JSON.stringify(to)) diff[key] = { from: normalise(from), to: normalise(to) };
  }
  return diff;
}

function normalise(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && 'toString' in v && v.constructor?.name === 'Decimal') return Number(v.toString());
  return v;
}

// ---------------------------------------------------------------------------
// Tamper evidence (workstream D, docs/plan/compliance.md) — a hash chain on
// AuditRecord matching EventRecord's (`eventBus.ts` computeHash/verifyChain),
// with two differences forced by AuditRecord's shape: every write, not only
// governed-entity ones, still lands a row (reads and exports do), so the
// chain link lives here rather than at the call site; and the hash is
// recomputed at verify time rather than only walked, so a row whose content
// was altered without a matching hash edit is still caught.
// ---------------------------------------------------------------------------

/** Deep-sorts object keys so the hash is independent of how a JSON column happens to have stored them. */
function sortDeep(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    // A Decimal (or anything else with its own JSON representation) is
    // serialised through that representation rather than walked as a plain
    // object — walking a Decimal's own keys would silently produce `{}`.
    const toJSON = (v as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === 'function') return sortDeep(toJSON.call(v));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortDeep((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function canonicalJson(v: unknown): string {
  return JSON.stringify(sortDeep(v));
}

export function computeAuditHash(payload: Record<string, unknown>, prevHash: string | null): string {
  return createHash('sha256')
    .update(prevHash ?? 'GENESIS')
    .update('|')
    .update(canonicalJson(payload))
    .digest('hex');
}

function hashPayloadOf(row: {
  tenantId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  actorId: string | null;
  diff: unknown;
  timestamp: Date;
}): Record<string, unknown> {
  return {
    tenantId: row.tenantId,
    action: row.action,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    actorId: row.actorId,
    diff: row.diff ?? null,
    timestamp: row.timestamp.toISOString(),
  };
}

/**
 * Creates one AuditRecord chained to the tenant's previous one. Serialised per
 * tenant with a session-level advisory lock inside the transaction — two
 * concurrent writes for the same tenant queue rather than race for "the
 * latest hash".
 */
export async function createChainedAuditRecord(
  data: Omit<Parameters<typeof prisma.auditRecord.create>[0]['data'], 'hash' | 'prevHash' | 'timestamp'>,
): Promise<void> {
  const tenantId = (data as { tenantId: string }).tenantId;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;
    const last = await tx.auditRecord.findFirst({
      where: { tenantId, hash: { not: null } },
      orderBy: { timestamp: 'desc' },
      select: { hash: true },
    });
    const prevHash = last?.hash ?? null;
    const timestamp = new Date();
    const hash = computeAuditHash(
      hashPayloadOf({
        tenantId,
        action: (data as { action: string }).action,
        subjectType: (data as { subjectType: string }).subjectType,
        subjectId: (data as { subjectId: string }).subjectId,
        actorId: (data as { actorId: string | null }).actorId ?? null,
        diff: (data as { diff?: unknown }).diff,
        timestamp,
      }),
      prevHash,
    );
    await tx.auditRecord.create({ data: { ...(data as object), timestamp, prevHash, hash } as never });
  });
}

/**
 * Walks a tenant's AuditRecord chain from the outside and recomputes each
 * row's hash from its own stored content, rather than only checking that
 * consecutive hashes line up — so a row edited directly (its diff changed but
 * its hash left alone) is caught, not only a row whose hash was corrupted.
 * Rows written before hashing existed (`hash` null) are skipped, not counted
 * as broken; run `chainUnhashedAuditRecords` to bring them into the chain.
 */
export async function verifyAuditChain(
  tenantId: string,
  limit = 10_000,
): Promise<{ ok: boolean; checked: number; brokenAt: string | null }> {
  await assertCan({ resource: 'audit', verb: 'view' });
  const rows = await unscopedPrisma.auditRecord.findMany({
    where: { tenantId },
    orderBy: { timestamp: 'asc' },
    take: limit,
  });

  let expectedPrev: string | null = null;
  let checked = 0;
  for (const row of rows) {
    if (!row.hash) continue;
    checked += 1;
    const expectedHash = computeAuditHash(
      hashPayloadOf({
        tenantId: row.tenantId,
        action: row.action,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        actorId: row.actorId,
        diff: row.diff,
        timestamp: row.timestamp,
      }),
      row.prevHash,
    );
    if (row.prevHash !== expectedPrev || row.hash !== expectedHash) {
      return { ok: false, checked, brokenAt: row.id };
    }
    expectedPrev = row.hash;
  }
  return { ok: true, checked, brokenAt: null };
}

/**
 * Brings pre-existing null-hash rows into the chain, in timestamp order,
 * continuing from whatever the chain's current head is. Idempotent: a row
 * that already has a hash is left untouched.
 */
export async function chainUnhashedAuditRecords(tenantId: string): Promise<number> {
  const unhashed = await unscopedPrisma.auditRecord.findMany({
    where: { tenantId, hash: null },
    orderBy: { timestamp: 'asc' },
  });
  if (unhashed.length === 0) return 0;

  const head = await unscopedPrisma.auditRecord.findFirst({
    where: { tenantId, hash: { not: null } },
    orderBy: { timestamp: 'desc' },
    select: { hash: true },
  });
  let prevHash = head?.hash ?? null;

  for (const row of unhashed) {
    const hash = computeAuditHash(hashPayloadOf(row), prevHash);
    await unscopedPrisma.auditRecord.update({ where: { id: row.id }, data: { prevHash, hash } });
    prevHash = hash;
  }
  return unhashed.length;
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

  await createChainedAuditRecord({
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
  await createChainedAuditRecord({
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
  });
}

/** Bulk export is the one read that has always been audited. */
export async function auditExport(subjectType: string, scope: string, recordCount: number): Promise<void> {
  const auth = currentAuth();
  await createChainedAuditRecord({
    tenantId: auth.tenantId,
    action: 'export',
    subjectType,
    subjectId: 'bulk',
    actorType: auth.principalType,
    actorId: auth.partyId,
    actorLabel: auth.roleSlug,
    meta: { scope, recordCount } as never,
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
  await createChainedAuditRecord({
    tenantId: auth.tenantId,
    action: 'update',
    subjectType,
    subjectId: `bulk:${operation}`,
    actorType: auth.principalType,
    actorId: auth.partyId,
    actorLabel: auth.roleSlug,
    meta: { ...meta, operation, requestId: ctx?.requestId } as never,
  });
}
