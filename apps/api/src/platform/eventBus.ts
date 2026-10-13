/**
 * P4 — the durable, hash-chained event bus.
 *
 * `emit()` computes `integrity.hash` from the event's serialisation plus
 * `integrity.prevHash`, and writes the chain link and an outbox row in one
 * transaction (FX-24, D-16). Delivery to subscribers is the outbox dispatcher's
 * job (platform/outbox.ts): a failing handler is retried with backoff and
 * dead-lettered after OUTBOX_MAX_ATTEMPTS, and the retry state is in Postgres,
 * so a process restart does not lose it.
 *
 * Reads are never events. A read of confidential or regulated data produces an
 * AUDIT_RECORD instead — a future PR emitting an event for a read is a
 * review-blocking violation.
 */

import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import {
  CANONICAL_TO_LEGACY,
  isCanonicalEventName,
  type EventEnvelope,
  type EventRelatedRef,
  type EventReason,
  type EventImpact,
  type SensitivityClass,
  type SeverityCode,
} from '@kaizen/shared';
import { prisma, unscopedPrisma, type DbTx } from './db.js';
import { config } from './config.js';
import { ApiError } from './errors.js';
import { currentAuth, requireContext } from './context.js';
import { drainOutbox } from './outbox.js';
import { canonicalJson } from './canonicalJson.js';
import { claimAuditRecordFor } from './audit.js';

export interface EmitInput {
  name: string;
  subject: { entityType: string; entityId: string; recordCode?: string | null };
  related?: EventRelatedRef[];
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  reason?: EventReason | null;
  impact?: Partial<EventImpact>;
  owner?: { partyId?: string | null; positionId?: string | null } | null;
  confidentiality?: SensitivityClass;
  retentionClass?: string;
  occurredAt?: Date;
  /** Emits the legacy PascalCase name alongside the canonical one. */
  dualPublish?: boolean;
  severity?: SeverityCode | null;
  channel?: string;
  /**
   * The AuditRecord written for this same write (FX-24 cross-anchor). Left out,
   * emit pairs with the first unclaimed audit row that the same `tx` wrote for
   * this subject (audit.ts `claimAuditRecordFor`). Passed explicitly, it is stored
   * as given and not checked here: `verifyEventAuditAnchors` is where a bad
   * anchor is found.
   */
  auditRecordId?: string | null;
  /**
   * The caller's transaction. When given, the EventRecord and the outbox row
   * are written inside it, so the event commits or vanishes with the business
   * write, and delivery waits for the dispatcher (the transaction has not
   * committed yet, so delivering now could announce a write that then rolls
   * back). Without it, emit opens its own transaction and delivers inline.
   */
  tx?: DbTx;
}

export type Subscriber = (event: EventEnvelope) => Promise<void> | void;

export interface Registration {
  key: string;
  eventName: string;
  handler: Subscriber;
}

const registry = new Map<string, Registration[]>();

/** Test hook: every event emitted in-process, in order. */
export const emittedEvents: EventEnvelope[] = [];
let captureEvents = config.NODE_ENV === 'test';

export function setEventCapture(on: boolean) {
  captureEvents = on;
  if (!on) emittedEvents.length = 0;
}

export function subscribe(eventName: string, key: string, handler: Subscriber): void {
  if (!isCanonicalEventName(eventName)) {
    throw new Error(
      `Subscriber '${key}' registered against a non-canonical event name '${eventName}'. ` +
        'No automation may be authored against a legacy PascalCase name.',
    );
  }
  const list = registry.get(eventName) ?? [];
  if (list.some((r) => r.key === key)) return;
  list.push({ key, eventName, handler });
  registry.set(eventName, list);
}

/** The in-process subscribers for an event, in registration order. Read by the outbox dispatcher. */
export function subscribersFor(eventName: string): Registration[] {
  return registry.get(eventName) ?? [];
}

export function subscriberCount(eventName: string): number {
  return registry.get(eventName)?.length ?? 0;
}

export function clearSubscribers(): void {
  registry.clear();
}

/**
 * Hash version 1, the algorithm every row written before hash version 2 carries.
 * Existing rows are verified with it and never rewritten, so history stays as
 * it was written.
 *
 * Known weakness, kept on purpose for those rows: `JSON.stringify`'s array
 * replacer keeps only the top-level keys and filters nested ones too, so
 * nested content (subject, newState, previousState, related) hashes as `{}`.
 * An edit inside newState does not break a v1 link. Version 2 covers the full
 * body.
 */
export function computeHash(payload: Record<string, unknown>, prevHash: string | null): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256')
    .update(prevHash ?? 'GENESIS')
    .update('|')
    .update(canonical)
    .digest('hex');
}

/**
 * Hash version 2, used by every new row. It covers the full body, nested
 * content included, in the same canonical form the audit chain uses, so that
 * an edit anywhere in a record breaks its link.
 */
export function computeHashV2(payload: Record<string, unknown>, prevHash: string | null): string {
  return createHash('sha256')
    .update(prevHash ?? 'GENESIS')
    .update('|')
    .update(canonicalJson(payload))
    .digest('hex');
}

/** The version every new row is written with. Rows without one are version 1, which is the column default. */
export const CURRENT_HASH_VERSION = 2;

/**
 * Dispatches on the version a row was written with. An unknown version is a
 * broken row: the verifier treats it as a failed link rather than guessing.
 */
export function hashFor(version: number, payload: Record<string, unknown>, prevHash: string | null): string {
  if (version === 1) return computeHash(payload, prevHash);
  if (version === CURRENT_HASH_VERSION) return computeHashV2(payload, prevHash);
  throw new Error(`Unknown event hash version ${version}`);
}

/**
 * The stored columns the chain hash covers. `chainBodyOf` rebuilds the object
 * `emit` hashed from these, so the writer and the verifier share one definition
 * of what is hashed. Keep the two in step: a field added to the body and not
 * here makes every record fail verification.
 */
export interface ChainFields {
  eventId: string;
  eventName: string;
  eventVersion: number;
  tenantId: string;
  occurredAt: Date;
  actorType: string;
  actorPartyId: string | null;
  actorAccessRole: string | null;
  actorAgentId: string | null;
  onBehalfOfPartyId: string | null;
  subjectEntityType: string;
  subjectEntityId: string;
  subjectRecordCode: string | null;
  related: unknown;
  previousState: unknown;
  newState: unknown;
  reason: unknown;
  correlationId: string;
  causationId: string | null;
}

export function chainBodyOf(row: ChainFields): Record<string, unknown> {
  return {
    eventId: row.eventId,
    eventName: row.eventName,
    eventVersion: row.eventVersion,
    tenantId: row.tenantId,
    occurredAt: row.occurredAt.toISOString(),
    actorType: row.actorType,
    actorPartyId: row.actorPartyId,
    actorAccessRole: row.actorAccessRole,
    actorAgentId: row.actorAgentId,
    onBehalfOfPartyId: row.onBehalfOfPartyId,
    subject: { entityType: row.subjectEntityType, entityId: row.subjectEntityId, recordCode: row.subjectRecordCode },
    related: row.related ?? [],
    previousState: row.previousState ?? null,
    newState: row.newState ?? null,
    reason: row.reason ?? null,
    correlationId: row.correlationId,
    causationId: row.causationId,
  };
}

const CHAIN_FIELDS_SELECT = {
  seq: true,
  eventId: true,
  eventName: true,
  eventVersion: true,
  tenantId: true,
  occurredAt: true,
  actorType: true,
  actorPartyId: true,
  actorAccessRole: true,
  actorAgentId: true,
  onBehalfOfPartyId: true,
  subjectEntityType: true,
  subjectEntityId: true,
  subjectRecordCode: true,
  related: true,
  previousState: true,
  newState: true,
  reason: true,
  correlationId: true,
  causationId: true,
  hashVersion: true,
  prevHash: true,
  hash: true,
} as const;

/**
 * Retries left over after the lock. Small on purpose: with the advisory lock
 * below, a conflict should be rare rather than routine.
 */
const CHAIN_RETRIES = 5;

/**
 * Namespace for the per-tenant append lock, so it cannot collide with any other
 * advisory lock this application might take later.
 */
const CHAIN_LOCK_NAMESPACE = 4711;

/**
 * Append one record to the tenant's hash chain, atomically.
 *
 * The head was read with an unlocked `findFirst` and the insert happened later,
 * outside any transaction. Two emits arriving together in one tenant both read
 * head H, both computed `prevHash: H`, and both inserted — a fork. `verifyChain`
 * then reported the chain permanently broken, with no recovery path, and
 * tamper-evidence is the entire point of the design.
 *
 * Two things fix it, and both are needed. A per-tenant advisory lock makes the
 * read-then-insert one operation, so appends queue instead of racing.
 * `@@unique([tenantId, prevHash])` makes a fork impossible at the database
 * rather than merely unlikely in the application, and is what would catch any
 * path that ever bypassed this function. The hash is computed per attempt
 * because a retry must chain onto whatever the head has become.
 */
type EventRecordRow = Awaited<ReturnType<DbTx['eventRecord']['create']>>;

interface Appended<T> {
  record: EventRecordRow;
  prevHash: string | null;
  hash: string;
  extra: T;
}

async function appendToChain<T>(
  tenantId: string,
  body: Record<string, unknown>,
  build: (prevHash: string | null, hash: string) => { data: Record<string, unknown> },
  after: (tx: DbTx, appended: Omit<Appended<T>, 'extra'>) => Promise<T>,
  callerTx?: DbTx,
): Promise<Appended<T>> {
  let lastError: unknown = null;

  const run = async (tx: DbTx): Promise<Appended<T>> => {
    // Queue, rather than collide.
    //
    // Optimistic retry alone is quadratic here: every emit in a tenant
    // contends for one row — the chain head — so in a burst of N, each
    // round admits exactly one writer and the other N-1 all fail and
    // retry. Forty concurrent emits exhausted sixty retries.
    //
    // A transaction-scoped advisory lock makes the append a queue: the
    // second writer waits for the first to commit and then reads a head
    // that is already current. It is released automatically when the
    // transaction ends, including on rollback. The unique constraint
    // stays as the guarantee — this is what stops it being hit.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK_NAMESPACE}::int, hashtext(${tenantId}))`;

    const last = await tx.eventRecord.findFirst({
      where: { tenantId },
      // By sequence, not by timestamp. `recordedAt desc` is ambiguous
      // when several records share a millisecond — and in a fast suite
      // many do — so the "head" could be a record that already had a
      // successor, and the next writer would chain onto the wrong link
      // and collide. A sequence is monotonic by construction.
      orderBy: { seq: 'desc' },
      select: { hash: true },
    });
    const prevHash = last?.hash ?? null;
    const hash = hashFor(CURRENT_HASH_VERSION, body, prevHash);
    const record = await tx.eventRecord.create(build(prevHash, hash) as Parameters<typeof tx.eventRecord.create>[0]);
    // The outbox row (and any legacy dual-publish row) is written here, under
    // the same lock and in the same transaction as the chain link, so a
    // rollback removes the event entirely.
    const extra = await after(tx, { record, prevHash, hash });
    return { record, prevHash, hash, extra };
  };

  // A caller's transaction is not retried here: a failed statement aborts it,
  // so the caller owns the outcome. The advisory lock still queues appenders
  // for as long as that transaction runs, so business transactions that emit
  // should stay short.
  if (callerTx) return run(callerTx);

  for (let attempt = 0; attempt < CHAIN_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        run,
        // READ COMMITTED, deliberately, *because* of the lock above. The plan
        // named SERIALIZABLE here; this is the one place that choice is rejected,
        // and the reason is below.
        //
        // Under SERIALIZABLE the transaction's snapshot is taken when its first
        // statement runs — which is the lock acquisition itself. A writer that
        // then waits its turn still reads the head from before the winner
        // committed, so it computes the same `prevHash` and collides anyway.
        // The lock provides the mutual exclusion; READ COMMITTED is what lets
        // the next writer actually see what the previous one wrote.
        { isolationLevel: 'ReadCommitted' },
      );
    } catch (err) {
      lastError = err;
      // A serialization failure or a unique violation both mean the same thing:
      // somebody else appended first. Recompute against the new head.
      const code = (err as { code?: string })?.code;
      if (code !== 'P2002' && code !== 'P2034' && !/could not serialize/i.test(String(err))) throw err;
      // Jittered, not just growing: a fixed backoff makes two losers collide
      // again on the same schedule, which is how a retry storm sustains itself.
      const base = Math.min(2 * (attempt + 1), 40);
      await new Promise((r) => setTimeout(r, base + Math.random() * base));
    }
  }

  throw lastError instanceof Error
    ? new Error(`Could not append to the event chain after ${CHAIN_RETRIES} attempts: ${lastError.message}`)
    : new Error(`Could not append to the event chain after ${CHAIN_RETRIES} attempts.`);
}

/**
 * Publishes one event. Delivery is at-least-once across crashes, so a handler
 * must be idempotent on eventId.
 *
 * The EventRecord (the hash-chain link) and its outbox row are written in one
 * transaction, so an event exists if and only if the write that caused it
 * committed. Delivery then goes through the outbox (see `drainOutbox`).
 *
 * With the caller's `tx`, nothing is delivered here: the transaction has not
 * committed, and a subscriber must not act on a write that may still roll back.
 * Without it, emit commits its own transaction and makes one delivery attempt
 * before returning, so callers that have not been moved to `tx` still see their
 * subscribers run synchronously. A failed attempt stays in the outbox to retry.
 */
export async function emit(input: EmitInput): Promise<EventEnvelope> {
  if (!isCanonicalEventName(input.name)) {
    throw new Error(`Event name '${input.name}' does not match the kz.<domain>.<entity>.<verb> grammar.`);
  }

  const ctx = requireContext();
  const auth = currentAuth();
  const now = new Date();
  const occurredAt = input.occurredAt ?? now;
  const eventId = ulid();

  // The chain hash covers prevHash, which is only known inside the append
  // transaction, so the envelope is built there, from the head it chained onto.
  const body = {
    eventId,
    eventName: input.name,
    eventVersion: 1,
    tenantId: auth.tenantId,
    occurredAt: occurredAt.toISOString(),
    actorType: auth.principalType,
    actorPartyId: auth.partyId,
    actorAccessRole: auth.roleSlug,
    actorAgentId: auth.agentId,
    onBehalfOfPartyId: auth.onBehalfOfPartyId,
    // Normalised to the same shape `chainBodyOf` rebuilds from the stored row. An
    // undefined recordCode would drop out of the JSON and make the hash disagree
    // with the verifier, which reads it back as null.
    subject: {
      entityType: input.subject.entityType,
      entityId: input.subject.entityId,
      recordCode: input.subject.recordCode ?? null,
    },
    related: input.related ?? [],
    previousState: input.previousState ?? null,
    newState: input.newState ?? null,
    reason: input.reason ?? null,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
  };

  const impact: EventImpact = {
    domains: input.impact?.domains ?? [input.name.split('.')[1] ?? 'crm'],
    severity: input.severity ?? input.impact?.severity ?? null,
    materiality: input.impact?.materiality ?? null,
  };

  const channel = input.channel ?? (auth.principalType === 'system' ? 'scheduler' : 'api');

  const envelopeFor = (prevHash: string | null, hash: string): EventEnvelope => ({
    eventId,
    eventName: input.name,
    eventVersion: 1,
    tenantId: auth.tenantId,
    occurredAt: occurredAt.toISOString(),
    recordedAt: now.toISOString(),
    actor: {
      actorType: auth.principalType,
      partyId: auth.partyId,
      accessRole: auth.roleSlug,
      agentId: auth.agentId,
      onBehalfOfPartyId: auth.onBehalfOfPartyId,
    },
    subject: {
      entityType: input.subject.entityType,
      entityId: input.subject.entityId,
      recordCode: input.subject.recordCode ?? null,
    },
    related: input.related ?? [],
    previousState: input.previousState ?? null,
    newState: input.newState ?? null,
    reason: input.reason ?? null,
    source: {
      system: 'kaizen',
      channel,
      requestId: ctx.requestId,
      integrationId: null,
      ingestBatchId: null,
    },
    impact,
    owner: input.owner ?? null,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    confidentiality: input.confidentiality ?? 'internal',
    retentionClass: input.retentionClass ?? 'standard',
    integrity: { prevHash, hash },
  });

  const legacyName = CANONICAL_TO_LEGACY[input.name];

  // Resolved before the append: a claim is only valid inside the caller's
  // transaction, and an emit without one has no audit row to pair with.
  const auditRecordId =
    input.auditRecordId !== undefined
      ? input.auditRecordId
      : input.tx
        ? claimAuditRecordFor(input.tx, input.subject.entityType, input.subject.entityId)
        : null;

  const appended = await appendToChain<{ outboxId: string; envelope: EventEnvelope }>(
    auth.tenantId,
    body as Record<string, unknown>,
    (prevHash, hash) => ({
      data: {
        tenantId: auth.tenantId,
        eventId,
        eventName: input.name,
        eventVersion: 1,
        auditRecordId,
        occurredAt,
        recordedAt: now,
        actorType: auth.principalType,
        actorPartyId: auth.partyId,
        actorAccessRole: auth.roleSlug,
        actorAgentId: auth.agentId,
        onBehalfOfPartyId: auth.onBehalfOfPartyId,
        subjectEntityType: input.subject.entityType,
        subjectEntityId: input.subject.entityId,
        subjectRecordCode: input.subject.recordCode ?? null,
        related: (input.related ?? []) as never,
        previousState: (input.previousState ?? undefined) as never,
        newState: (input.newState ?? undefined) as never,
        reason: (input.reason ?? undefined) as never,
        source: {
          system: 'kaizen',
          channel,
          requestId: ctx.requestId,
          integrationId: null,
          ingestBatchId: null,
        } as never,
        impactDomains: impact.domains,
        impactSeverity: impact.severity ?? null,
        impactMateriality: (impact.materiality ?? undefined) as never,
        ownerPartyId: input.owner?.partyId ?? null,
        ownerPositionId: input.owner?.positionId ?? null,
        correlationId: ctx.correlationId,
        causationId: ctx.causationId,
        confidentiality: input.confidentiality ?? 'internal',
        retentionClass: input.retentionClass ?? 'standard',
        hashVersion: CURRENT_HASH_VERSION,
        prevHash,
        hash,
      },
    }),
    async (tx, { record, prevHash, hash }) => {
      const envelope = envelopeFor(prevHash, hash);
      const outbox = await tx.outboxEvent.create({
        data: {
          tenantId: auth.tenantId,
          eventRecordId: record.id,
          eventName: input.name,
          payload: envelope as never,
        },
      });
      // Dual-publish during the migration window: both chain records share the
      // eventId and correlationId, so they are recognisable as the same fact
      // under two names. Written here, not after commit, so the legacy name
      // cannot outlive a rolled-back write.
      if (input.dualPublish && legacyName) {
        await tx.eventRecord.create({
          data: {
            ...stripId(record),
            eventName: legacyName,
            legacyName,
            prevHash: hash,
            // The legacy row copies hashVersion from the canonical row, so it is
            // hashed with the same version the verifier will dispatch on.
            hash: hashFor(CURRENT_HASH_VERSION, { ...body, eventName: legacyName }, hash),
          } as never,
        });
      }
      return { outboxId: outbox.id, envelope };
    },
    input.tx,
  );

  const envelope = appended.extra.envelope;
  if (captureEvents) emittedEvents.push(envelope);

  if (!input.tx) {
    await drainOutbox({ tenantId: auth.tenantId, ids: [appended.extra.outboxId] });
  }
  return envelope;
}

/**
 * The legacy row copies the canonical row's fields, but not its identity. `seq`
 * must be dropped too: copied, it ties the canonical row for the head, so the
 * next append chains onto the legacy row's hash and collides with it on every
 * retry (`prevHash` is unique per tenant).
 */
function stripId(record: Record<string, unknown>) {
  const { id: _id, seq: _seq, ...rest } = record;
  return rest;
}

/**
 * The causation-ancestry guard against runaway cross-domain event loops
 * (relevant wherever two modules subscribe to each other's events, as in the
 * CRM<->Finance cycle): a consumer checks whether it is about to re-trigger an
 * event it is itself downstream of, and refuses.
 */
export async function wouldLoop(envelope: EventEnvelope, candidateEventName: string, depth = 12): Promise<boolean> {
  let cursor: string | null = envelope.causationId;
  let steps = 0;
  while (cursor && steps < depth) {
    const parent = await prisma.eventRecord.findFirst({
      where: { eventId: cursor },
      select: { eventName: true, causationId: true },
    });
    if (!parent) return false;
    if (parent.eventName === candidateEventName) return true;
    cursor = parent.causationId;
    steps += 1;
  }
  return false;
}

export interface ChainVerification {
  valid: boolean;
  /** Records examined, in append order, up to and including the first failure. */
  checked: number;
  brokenAt: string | null;
  /**
   * True only when the walk reached the end of the tenant's chain without a
   * failure. A `maxRows` cap that stops the walk early leaves it false, so a
   * caller cannot read "valid" as "the whole trail is intact" from a partial walk.
   */
  complete: boolean;
  /**
   * Set only when a capped walk stopped with `complete: false` and no failure:
   * pass it back as `cursor` to continue after the last row this call checked.
   * `checked` counts this call's rows, not the chain's.
   */
  nextCursor?: string;
}

const VERIFY_PAGE_SIZE = 1000;

/**
 * Walks a tenant's chain, recomputing every record's hash from its stored
 * fields, and reports the first record that fails. The platform alerts on
 * chain-continuity failure per tenant rather than merely logging it.
 *
 * It used to compare linkage only, so an edited record still read as valid. It
 * also stopped at 5,000 rows and said `valid: true` about the rest, and it
 * skipped legacy rows that the append head does chain through.
 */
export async function verifyChain(
  tenantId: string,
  opts: { maxRows?: number; cursor?: string } = {},
): Promise<ChainVerification> {
  // Deliberately the unscoped client: the tenant is supplied explicitly and
  // the point of the walk is to be independent of the request context that
  // wrote the chain, so an auditor can verify it out of band.
  let expectedPrev: string | null = null;
  let cursor: bigint | null = null;
  let checked = 0;

  if (opts.cursor !== undefined) {
    if (!/^\d+$/.test(opts.cursor)) throw ApiError.badRequest('The verification cursor is not valid.');
    cursor = BigInt(opts.cursor);
    // The hash to continue from is the last row of the previous page, and it is
    // read for this tenant only: a cursor minted for another tenant names no row
    // here and is refused, rather than resuming from some other chain's hash.
    const from = await unscopedPrisma.eventRecord.findFirst({
      where: { tenantId, seq: cursor },
      select: { hash: true },
    });
    if (!from) throw ApiError.badRequest('The verification cursor does not belong to this tenant.');
    expectedPrev = from.hash;
  }

  for (;;) {
    const want = opts.maxRows === undefined ? VERIFY_PAGE_SIZE : Math.min(VERIFY_PAGE_SIZE, opts.maxRows - checked);
    if (want <= 0) {
      return {
        valid: true,
        checked,
        brokenAt: null,
        complete: false,
        ...(cursor === null ? {} : { nextCursor: cursor.toString() }),
      };
    }

    // By sequence, for the same reason the append reads the head that way:
    // several records share a millisecond, so `recordedAt asc` walks them in an
    // arbitrary order and reports a perfectly sound chain as broken. A
    // sequence cursor also lets the walk page without skipping records.
    const rows = await unscopedPrisma.eventRecord.findMany({
      where: { tenantId, ...(cursor === null ? {} : { seq: { gt: cursor } }) },
      orderBy: { seq: 'asc' },
      take: want,
      select: CHAIN_FIELDS_SELECT,
    });
    if (rows.length === 0) return { valid: true, checked, brokenAt: null, complete: true };

    for (const row of rows) {
      checked += 1;
      // A row with a version this code does not know is a failed link, not an error
      // that stops the walk: the report should name the row.
      let recomputed: string | null = null;
      try {
        recomputed = hashFor(row.hashVersion, chainBodyOf(row), row.prevHash);
      } catch {
        recomputed = null;
      }
      if (row.prevHash !== expectedPrev || recomputed !== row.hash) {
        return { valid: false, checked, brokenAt: row.eventId, complete: false };
      }
      expectedPrev = row.hash;
    }
    cursor = rows[rows.length - 1].seq;
  }
}

/**
 * The audit actions that change business state. Each of these is a governed
 * write, and a governed write is meant to emit the event that says what it did.
 */
const GOVERNED_WRITE_ACTIONS = ['create', 'update', 'delete', 'merge'];

const ANCHOR_PAGE_SIZE = 1000;

export interface EventAuditAnchorReport {
  /**
   * Events whose anchor names an audit row that does not exist in this tenant
   * (`missing_audit_row`), or one about a different subject (`subject_mismatch`).
   */
  eventsWithoutAudit: Array<{
    eventRecordId: string;
    eventId: string;
    auditRecordId: string;
    reason: 'missing_audit_row' | 'subject_mismatch';
  }>;
  /**
   * Governed-write audit rows no event is anchored to. This includes writes that
   * never emit: most auditWrite calls are not inside a transaction that also
   * emits, so this list is long until the owner says which writes must emit.
   */
  auditWithoutEvent: Array<{
    auditRecordId: string;
    action: string;
    subjectType: string;
    subjectId: string;
  }>;
  checkedEvents: number;
  checkedAudits: number;
}

/**
 * Reports the cross-anchor between the event chain and the audit chain in both
 * directions, for one tenant: an event that points at no audit row for its
 * subject, and a governed-write audit row that no event points at. It is a
 * full walk, paged by sequence like `verifyChain`, and it reads the unscoped
 * client for the same reason: an auditor runs it out of band.
 *
 * It checks the links, not the hashes. The anchor column sits outside the
 * event hash (see the schema note on EventRecord.auditRecordId), so a changed
 * anchor is caught here by its subject, not by `verifyChain`.
 */
export async function verifyEventAuditAnchors(tenantId: string): Promise<EventAuditAnchorReport> {
  const report: EventAuditAnchorReport = {
    eventsWithoutAudit: [],
    auditWithoutEvent: [],
    checkedEvents: 0,
    checkedAudits: 0,
  };

  let cursor: bigint | null = null;
  for (;;) {
    const rows = await unscopedPrisma.eventRecord.findMany({
      where: { tenantId, auditRecordId: { not: null }, ...(cursor === null ? {} : { seq: { gt: cursor } }) },
      orderBy: { seq: 'asc' },
      take: ANCHOR_PAGE_SIZE,
      select: {
        seq: true,
        id: true,
        eventId: true,
        auditRecordId: true,
        subjectEntityType: true,
        subjectEntityId: true,
      },
    });
    if (rows.length === 0) break;

    const auditIds = rows.flatMap((r) => (r.auditRecordId === null ? [] : [r.auditRecordId]));
    const audits = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId, id: { in: auditIds } },
      select: { id: true, subjectType: true, subjectId: true },
    });
    const auditById = new Map(audits.map((a) => [a.id, a]));

    for (const row of rows) {
      report.checkedEvents += 1;
      if (row.auditRecordId === null) continue;
      const audit = auditById.get(row.auditRecordId);
      const base = { eventRecordId: row.id, eventId: row.eventId, auditRecordId: row.auditRecordId };
      if (!audit) {
        report.eventsWithoutAudit.push({ ...base, reason: 'missing_audit_row' });
      } else if (audit.subjectType !== row.subjectEntityType || audit.subjectId !== row.subjectEntityId) {
        report.eventsWithoutAudit.push({ ...base, reason: 'subject_mismatch' });
      }
    }
    cursor = rows[rows.length - 1]!.seq;
  }

  cursor = null;
  for (;;) {
    const rows = await unscopedPrisma.auditRecord.findMany({
      where: {
        tenantId,
        action: { in: GOVERNED_WRITE_ACTIONS },
        NOT: { subjectId: { startsWith: 'bulk:' } },
        ...(cursor === null ? {} : { seq: { gt: cursor } }),
      },
      orderBy: { seq: 'asc' },
      take: ANCHOR_PAGE_SIZE,
      select: { seq: true, id: true, action: true, subjectType: true, subjectId: true },
    });
    if (rows.length === 0) break;

    const anchored = await unscopedPrisma.eventRecord.findMany({
      where: { tenantId, auditRecordId: { in: rows.map((r) => r.id) } },
      select: { auditRecordId: true },
    });
    const anchoredIds = new Set(anchored.map((a) => a.auditRecordId));

    for (const row of rows) {
      report.checkedAudits += 1;
      if (anchoredIds.has(row.id)) continue;
      report.auditWithoutEvent.push({
        auditRecordId: row.id,
        action: row.action,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
      });
    }
    cursor = rows[rows.length - 1]!.seq;
  }

  return report;
}
