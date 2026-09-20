/**
 * P4 — the durable, hash-chained event bus.
 *
 * `emit()` constructs the full envelope, computes `integrity.hash` from the
 * event's serialisation plus `integrity.prevHash`, and writes durably before
 * returning. Subscribers are then invoked; a handler's third failure writes to
 * durable dead-letter storage rather than only logging, so a process restart
 * does not lose an in-flight retry.
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
import { getContext, currentAuth, requireContext } from './context.js';

const MAX_ATTEMPTS = 3;

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
}

export type Subscriber = (event: EventEnvelope) => Promise<void> | void;

interface Registration {
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

export function subscriberCount(eventName: string): number {
  return registry.get(eventName)?.length ?? 0;
}

export function clearSubscribers(): void {
  registry.clear();
}

/**
 * Computes the chain hash. The serialisation deliberately excludes the hash
 * itself and includes prevHash, so any tampering with an earlier event breaks
 * every subsequent link.
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
async function appendToChain(
  tenantId: string,
  body: Record<string, unknown>,
  build: (prevHash: string | null, hash: string) => { data: Record<string, unknown> },
): Promise<{ record: { id: string }; prevHash: string | null; hash: string }> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < CHAIN_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx: DbTx) => {
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
          const hash = computeHash(body, prevHash);
          const record = await tx.eventRecord.create(
            build(prevHash, hash) as Parameters<typeof tx.eventRecord.create>[0],
          );
          return { record, prevHash, hash };
        },
        // READ COMMITTED, deliberately, *because* of the lock above.
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
 * Publishes one event. The durable write happens first; subscriber dispatch
 * follows and never blocks the originating request from having succeeded.
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

  // Computed inside the retry loop below: the head can move between the read
  // and the insert, and that is the race this used to lose.

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
    subject: input.subject,
    related: input.related ?? [],
    previousState: input.previousState ?? null,
    newState: input.newState ?? null,
    reason: input.reason ?? null,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
  };

  // hash depends on prevHash, so both are computed per attempt.

  const impact: EventImpact = {
    domains: input.impact?.domains ?? [input.name.split('.')[1] ?? 'crm'],
    severity: input.severity ?? input.impact?.severity ?? null,
    materiality: input.impact?.materiality ?? null,
  };

  const { record, prevHash, hash } = await appendToChain(auth.tenantId, body as Record<string, unknown>, (prevHash, hash) => ({
    data: {
      tenantId: auth.tenantId,
      eventId,
      eventName: input.name,
      eventVersion: 1,
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
        channel: input.channel ?? (auth.principalType === 'system' ? 'scheduler' : 'api'),
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
      prevHash,
      hash,
    },
  }));

  // Dual-publish during the migration window: both writes share the same
  // eventId and correlationId, so they are recognisable as the same fact under
  // two names.
  const legacyName = CANONICAL_TO_LEGACY[input.name];
  if (input.dualPublish && legacyName) {
    await prisma.eventRecord.create({
      data: {
        ...stripId(record),
        eventName: legacyName,
        legacyName,
        prevHash: hash,
        hash: computeHash({ ...body, eventName: legacyName }, hash),
      } as never,
    });
  }

  const envelope: EventEnvelope = {
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
      channel: input.channel ?? (auth.principalType === 'system' ? 'scheduler' : 'api'),
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
  };

  if (captureEvents) emittedEvents.push(envelope);

  await dispatch(envelope, record.id);
  return envelope;
}

function stripId(record: Record<string, unknown>) {
  const { id, ...rest } = record;
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

async function dispatch(envelope: EventEnvelope, eventRecordId: string): Promise<void> {
  const subs = registry.get(envelope.eventName) ?? [];
  for (const sub of subs) {
    let attempt = 0;
    let lastError: unknown = null;
    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      try {
        // Handlers run with the causation chain extended, so anything they emit
        // points back at the event that caused it.
        const ctx = getContext();
        const prevCausation = ctx?.causationId ?? null;
        if (ctx) ctx.causationId = envelope.eventId;
        try {
          await sub.handler(envelope);
        } finally {
          if (ctx) ctx.causationId = prevCausation;
        }
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) {
      await prisma.eventDeadLetter.create({
        data: {
          tenantId: envelope.tenantId,
          eventRecordId,
          eventName: envelope.eventName,
          subscriberKey: sub.key,
          attempts: MAX_ATTEMPTS,
          lastError: lastError instanceof Error ? lastError.message : String(lastError),
          payload: envelope as never,
        },
      });
    }
  }
}

/**
 * Walks a tenant's chain and reports the first discontinuity. The platform
 * alerts on chain-continuity failure per tenant rather than merely logging it.
 */
export async function verifyChain(tenantId: string, limit = 5000): Promise<{
  valid: boolean;
  checked: number;
  brokenAt: string | null;
}> {
  // Deliberately the unscoped client: the tenant is supplied explicitly and
  // the point of the walk is to be independent of the request context that
  // wrote the chain, so an auditor can verify it out of band.
  const events = await unscopedPrisma.eventRecord.findMany({
    where: { tenantId, legacyName: null },
    // By sequence, for the same reason the append reads the head that way:
    // several records share a millisecond, so `recordedAt asc` walks them in an
    // arbitrary order and reports a perfectly sound chain as broken. The
    // verifier had the same ambiguity as the writer, and it is worse here —
    // a false "tamper detected" on an audit trail is not a small bug.
    orderBy: { seq: 'asc' },
    take: limit,
    select: { eventId: true, prevHash: true, hash: true },
  });

  let expectedPrev: string | null = null;
  for (const e of events) {
    if (e.prevHash !== expectedPrev) {
      return { valid: false, checked: events.length, brokenAt: e.eventId };
    }
    expectedPrev = e.hash;
  }
  return { valid: true, checked: events.length, brokenAt: null };
}
