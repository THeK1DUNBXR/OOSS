/**
 * FX-24 / D-16 — the transactional outbox dispatcher.
 *
 * `emit()` writes an outbox row in the same transaction as the EventRecord, so
 * a committed event survives a crash before delivery, and a rolled-back write
 * delivers nothing. This module moves committed rows to the in-process
 * subscribers.
 *
 * Claim, deliver, settle. The claim is one UPDATE over rows picked FOR UPDATE
 * SKIP LOCKED; it also pushes nextAttemptAt forward as a lease, so a second
 * dispatcher skips the row while the first is working on it. The handler runs
 * outside any transaction, and the outcome is recorded afterwards. If the
 * process dies mid-delivery the lease expires and the row is retried, so
 * delivery is at-least-once across crashes. `deliveredTo` stops that retry from
 * re-firing a subscriber that already succeeded on this row.
 */

import { Prisma } from '@prisma/client';
import { isCanonicalEventName, type EventEnvelope } from '@kaizen/shared';
import { prisma, unscopedPrisma } from './db.js';
import { asSystem, getContext, maybeTenantId } from './context.js';
import { subscribersFor, type Registration } from './eventBus.js';
import { logger } from './logger.js';

/**
 * Deliveries attempted before a row is dead-lettered. With backoff from 30s to
 * an hour, eight attempts cover roughly an hour of a subscriber being down,
 * which is long enough to ride out a database restart or a bad deploy.
 */
export const OUTBOX_MAX_ATTEMPTS = 8;

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/**
 * How long a claimed row is hidden from other dispatchers. It must outlast a
 * normal delivery; if it does not, a slow handler gets delivered twice, and
 * `deliveredTo` only prevents that for subscribers that have already finished.
 */
const LEASE_MS = 5 * 60_000;
const BATCH_SIZE = 50;

export interface DrainOptions {
  /** Required: a dispatcher never works across tenants (CLAUDE.md rule 6). */
  tenantId: string;
  /** Defaults to the current instant. Tests pass a later one to skip backoff. */
  now?: Date;
  /** Restrict the drain to these outbox rows, e.g. the one a non-transactional emit just wrote. */
  ids?: string[];
}

export interface DrainResult {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

interface OutboxRow {
  id: string;
  tenantId: string;
  eventRecordId: string;
  eventName: string;
  payload: unknown;
  attempts: number;
  deliveredTo: string[];
}

interface Failure {
  key: string;
  error: string;
}

/**
 * Delivers every committed, due outbox row for one tenant and settles it.
 * Never throws for a handler failure: a failing subscriber is a row to retry,
 * not a reason to abort the drain for everyone behind it.
 */
export async function drainOutbox(opts: DrainOptions): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const run = async (): Promise<DrainResult> => {
    const result: DrainResult = { claimed: 0, delivered: 0, retried: 0, dead: 0 };
    // Prisma.join refuses an empty list, and an empty id list means nothing to do.
    if (opts.ids && opts.ids.length === 0) return result;
    // Terminates because every row it settles is left either not pending or
    // due only after `now`, and `now` does not move during the drain.
    for (;;) {
      const rows = await claimBatch(opts.tenantId, now, opts.ids);
      if (rows.length === 0) return result;
      for (const row of rows) {
        result.claimed += 1;
        result[await deliverRow(row, now)] += 1;
      }
    }
  };
  // The handlers run with the caller's context when it is already this tenant,
  // as they did when delivery was inline. Otherwise a system context scoped to
  // the tenant, so the dispatcher can still reach a tenant-scoped client.
  return maybeTenantId() === opts.tenantId ? run() : asSystem(opts.tenantId, run);
}

export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

async function claimBatch(tenantId: string, now: Date, ids?: string[]): Promise<OutboxRow[]> {
  const idFilter = ids ? Prisma.sql`AND id IN (${Prisma.join(ids)})` : Prisma.empty;
  const lease = new Date(now.getTime() + LEASE_MS);
  // Raw SQL bypasses the tenant extension, so the tenant predicate is written
  // out here rather than trusted to it. It also runs inside a transaction: row
  // level security reads the tenant setting, and only a transaction carries it.
  return prisma.$transaction(
    (tx) => tx.$queryRaw<OutboxRow[]>`
    UPDATE outbox_events
       SET "nextAttemptAt" = ${lease}, attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM outbox_events
        WHERE "tenantId" = ${tenantId}
          AND state = 'pending'
          AND "nextAttemptAt" <= ${now}
          ${idFilter}
        ORDER BY "createdAt", id
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, "tenantId", "eventRecordId", "eventName", payload, attempts, "deliveredTo"`,
  );
}

async function deliverRow(row: OutboxRow, now: Date): Promise<'delivered' | 'retried' | 'dead'> {
  const envelope = row.payload as unknown as EventEnvelope;
  const done = new Set(row.deliveredTo);
  const failures: Failure[] = [];

  // A name that fails the grammar will not start passing on a later attempt,
  // so it is dead on the first claim rather than retried to the limit.
  const permanent = !isCanonicalEventName(row.eventName);
  if (permanent) {
    failures.push({
      key: '(grammar)',
      error: `Event name '${row.eventName}' does not match the kz.<domain>.<entity>.<verb> grammar.`,
    });
  } else {
    for (const sub of subscribersFor(row.eventName)) {
      if (done.has(sub.key)) continue;
      try {
        await invoke(sub, envelope);
        done.add(sub.key);
      } catch (err) {
        failures.push({ key: sub.key, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const deliveredTo = [...done];

  if (failures.length === 0) {
    await prisma.outboxEvent.update({
      where: { id: row.id },
      data: { state: 'dispatched', dispatchedAt: now, deliveredTo, lastError: null },
    });
    return 'delivered';
  }

  const lastError = failures.map((f) => `${f.key}: ${f.error}`).join('; ');

  if (permanent || row.attempts >= OUTBOX_MAX_ATTEMPTS) {
    await prisma.outboxEvent.update({
      where: { id: row.id },
      data: { state: 'dead', deliveredTo, lastError },
    });
    // Also written to the dead-letter table the admin view and health domain
    // read, one row per failed subscriber, so existing surfaces keep working.
    for (const f of failures) {
      await prisma.eventDeadLetter.create({
        data: {
          tenantId: row.tenantId,
          eventRecordId: row.eventRecordId,
          eventName: row.eventName,
          subscriberKey: f.key,
          attempts: row.attempts,
          lastError: f.error,
          payload: envelope as never,
        },
      });
    }
    return 'dead';
  }

  await prisma.outboxEvent.update({
    where: { id: row.id },
    data: {
      state: 'pending',
      deliveredTo,
      lastError,
      nextAttemptAt: new Date(now.getTime() + backoffMs(row.attempts)),
    },
  });
  return 'retried';
}

/**
 * Handlers run with the causation chain extended, so anything they emit points
 * back at the event that caused it.
 */
async function invoke(sub: Registration, envelope: EventEnvelope): Promise<void> {
  const ctx = getContext();
  const prevCausation = ctx?.causationId ?? null;
  if (ctx) ctx.causationId = envelope.eventId;
  try {
    await sub.handler(envelope);
  } finally {
    if (ctx) ctx.causationId = prevCausation;
  }
}

/**
 * Lists the tenants that have a due row, then drains each one under its own
 * tenant context. The tenant list is the only unscoped read here and it
 * selects ids alone; every row is read and settled through the scoped drain,
 * so one tenant's failure is logged against that tenant and does not stop the
 * others (CLAUDE.md rule 6: no cross-tenant drain).
 */
export async function dispatchDueOutbox(now: Date = new Date()): Promise<void> {
  const due = await unscopedPrisma.$queryRaw<{ tenantId: string }[]>`
    SELECT DISTINCT "tenantId" FROM outbox_events
     WHERE state = 'pending' AND "nextAttemptAt" <= ${now}`;
  for (const { tenantId } of due) {
    try {
      await drainOutbox({ tenantId });
    } catch (err) {
      logger.error({ component: 'outbox', tenantId, err }, 'outbox drain failed for tenant');
    }
  }
}

let dispatcher: ReturnType<typeof setInterval> | null = null;
let dispatching = false;

/**
 * The retry loop for failed deliveries. A failed inline delivery is left
 * pending behind its backoff, and only this loop (or a drain) picks it up.
 * It is a fixed-interval loop, not a scheduler job, so a retry is not held to
 * the job runner's one-minute resolution.
 */
export function startOutboxDispatcher({ intervalMs = 5_000 }: { intervalMs?: number } = {}): void {
  if (dispatcher) return;
  const tick = async () => {
    // A tick that runs long must not overlap the next one and claim the same
    // rows twice. The lease already prevents that; this avoids the wasted work.
    if (dispatching) return;
    dispatching = true;
    try {
      await dispatchDueOutbox();
    } catch (err) {
      logger.error({ component: 'outbox', err }, 'outbox dispatch tick failed');
    } finally {
      dispatching = false;
    }
  };
  dispatcher = setInterval(() => void tick(), intervalMs);
}

export function stopOutboxDispatcher(): void {
  if (dispatcher) clearInterval(dispatcher);
  dispatcher = null;
}
