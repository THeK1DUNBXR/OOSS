/**
 * Lifecycle transitions.
 *
 * Canon §14.3 draws eleven state machines, and every one of them needs the
 * same five things to happen in the same order: check the grant, ask the
 * machine, write the row, publish the transition under its own past-tense
 * name, and audit it. Written out per transition that is roughly ninety
 * near-identical blocks, and the interesting part — which is that they are all
 * the same — disappears into the repetition. It also makes it easy for one of
 * them to quietly skip the event or the audit.
 *
 * So it is written once. A domain service says which machine, which record and
 * which event; this decides whether it may happen and records that it did.
 */

import type { Machine } from '@kaizen/shared';
import { hrTransitionEvent } from '@kaizen/shared';
import { currentAuth } from './context.js';
import { emit } from './eventBus.js';
import { auditWrite } from './audit.js';
import { assertCan } from './permissions.js';
import { ApiError } from './errors.js';
import { governedWrite } from './governedWrite.js';
import type { DbTx } from './db.js';
import type { Resource, Verb } from '@kaizen/shared';

export interface TransitionInput<S extends string, E extends string> {
  machine: Machine<S, E>;
  /** The event-name object segment: `<eventPrefix>.<object>.<verb>`. */
  eventObject: string;
  /**
   * The event-name domain prefix. Defaults to `kz.hr`, the namespace this
   * helper was written for; the technology module passes `kz.it` so a ticket
   * or a change is not filed under people events.
   */
  eventPrefix?: string;
  /** The `impact.domains` entry the event carries. Defaults to `hr`. */
  impactDomain?: string;
  /** Past-tense verb per transition, from the machine's own verb map. */
  verbs: Record<E, string>;

  resource: Resource;
  /** Most transitions are an edit; approvals are their own verb. */
  verb?: Verb;

  subjectType: string;
  subjectId: string;
  recordCode?: string | null;
  /** Whose record it is, for the scope axis. */
  ownerPartyId?: string | null;

  from: S;
  event: E;
  /** Extra facts to carry in the event's newState, beyond the status change. */
  detail?: Record<string, unknown>;
  related?: Array<{ relation: string; entityType: string; entityId: string }>;
  reasonNote?: string | null;
}

export interface TransitionResult<S extends string> {
  from: S;
  to: S;
  eventName: string;
}

/**
 * Runs one transition. Returns the new state for the caller to persist —
 * persistence stays with the domain service because only it knows what else
 * moves in the same write (a leave approval also posts a hold, a hire also
 * opens an onboarding).
 *
 * The permission check happens before the machine is consulted, so a principal
 * who may not act on the record is told that, rather than being told their
 * transition is invalid — which would leak what state the record is in.
 */
export async function transition<S extends string, E extends string>(
  input: TransitionInput<S, E>,
): Promise<TransitionResult<S>> {
  const decided = await decide(input);
  await recordTransition(input, decided.to, decided.eventName);
  return decided;
}

/**
 * The transaction-aware form of `transition`, for a caller that persists its
 * status change itself and needs that change, its audit row and its event to
 * commit together.
 *
 * `transition()` audits and emits before the caller's write runs, so a refused
 * write left an audit row and an event for a change that never happened
 * (commit 64c868c's probe). Here the grant check and the machine check still
 * come first, outside the transaction, for the reason given on `transition`.
 * Inside it the order is the one governedWrite.ts documents: `write`, then
 * the transition's `auditWrite`, then its `emit`, then `after`. The audit lock
 * is taken before the event lock, so the order is not cosmetic.
 *
 * `write` may audit a row of its own, but it must not emit before the
 * transition does: the first governed call in a transaction takes the audit
 * lock, and an emit ahead of any audit would take the event lock first.
 *
 * `alsoEmit` is for a further event that describes this same transition under
 * another name (a summary). It runs after the transition's own event so that it
 * too follows the audit row.
 *
 * `after` is the work that follows the transition: a letter it issues, an
 * exception it raises, a hook it runs. Each of those needs the same transaction,
 * or a refusal leaves the status changed with the consequence missing (the
 * offboarding archived with no relieving letter; the employee Absconded with no
 * EX-HR-001 to act on). It runs after `alsoEmit`, with the value `write`
 * returned, so anything it audits or emits follows the transition's audit row.
 */
export async function transitionInTx<S extends string, E extends string, T>(
  input: TransitionInput<S, E>,
  options: {
    write: (tx: DbTx, to: S) => Promise<T>;
    alsoEmit?: (tx: DbTx, to: S) => Promise<void>;
    after?: (tx: DbTx, to: S, value: T) => Promise<void>;
  },
): Promise<{ result: TransitionResult<S>; value: T }> {
  const decided = await decide(input);
  return governedWrite((tx) => applyDecided(tx, input, decided, options));
}

/**
 * Writes a transition that `decide` has already approved, inside the caller's
 * transaction. For a caller that opens the transaction itself and has more than
 * one transition to write in it (an offer accepted and its application moved):
 * the grant check reads on the scoped client, which throws inside a transaction
 * it did not open, so it runs first, through `decide`, outside.
 */
export async function applyDecided<S extends string, E extends string, T>(
  tx: DbTx,
  input: TransitionInput<S, E>,
  decided: TransitionResult<S>,
  options: {
    write: (tx: DbTx, to: S) => Promise<T>;
    alsoEmit?: (tx: DbTx, to: S) => Promise<void>;
    after?: (tx: DbTx, to: S, value: T) => Promise<void>;
  },
): Promise<{ result: TransitionResult<S>; value: T }> {
  const value = await options.write(tx, decided.to);
  await recordTransition(input, decided.to, decided.eventName, tx);
  if (options.alsoEmit) await options.alsoEmit(tx, decided.to);
  if (options.after) await options.after(tx, decided.to, value);
  return { result: decided, value };
}

/** The grant check, then the machine. Shared by both forms so they cannot disagree. */
export async function decide<S extends string, E extends string>(
  input: TransitionInput<S, E>,
): Promise<TransitionResult<S>> {
  await assertCan({
    resource: input.resource,
    verb: input.verb ?? 'edit',
    record: { ownerPartyId: input.ownerPartyId ?? null },
  });

  if (!input.machine.can(input.from, input.event)) {
    throw ApiError.unprocessable(
      `${input.machine.name} is ${input.from}; ${input.event} is not one of its transitions. ` +
        `From here it accepts: ${input.machine.allowedEvents(input.from).join(', ') || 'nothing — this is a terminal state'}.`,
    );
  }

  const to = input.machine.apply(input.from, input.event);
  const eventName = input.eventPrefix
    ? `${input.eventPrefix}.${input.eventObject}.${input.verbs[input.event]}`
    : hrTransitionEvent(input.eventObject, input.verbs[input.event]);
  return { from: input.from, to, eventName };
}

/**
 * Audit before emit, so that a refused audit (an unregistered subject throws)
 * stops the transition before any event is published. Emitting first let
 * subscribers act on a transition that then failed to be recorded.
 */
async function recordTransition<S extends string, E extends string>(
  input: TransitionInput<S, E>,
  to: S,
  eventName: string,
  tx?: DbTx,
): Promise<void> {
  await auditWrite({
    action: 'update',
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    before: { status: input.from },
    after: { status: to, ...input.detail },
    meta: { transition: input.event, machine: input.machine.name },
    tx,
  });

  await emit({
    name: eventName,
    subject: { entityType: input.subjectType, entityId: input.subjectId, recordCode: input.recordCode },
    related: input.related,
    previousState: { status: input.from },
    newState: { status: to, ...input.detail },
    reason: input.reasonNote ? { reasonCode: input.event, note: input.reasonNote } : null,
    owner: { partyId: input.ownerPartyId ?? null },
    impact: { domains: [input.impactDomain ?? 'hr'] },
    tx,
  });
}

/**
 * What a surface should render as available actions. Filtered by the machine
 * only — the grant check still happens on the way in, because a button the
 * viewer cannot press is a different problem from a transition that does not
 * exist.
 */
export function availableTransitions<S extends string, E extends string>(machine: Machine<S, E>, state: S): E[] {
  return machine.allowedEvents(state);
}

/** Guards a mutation on a record whose machine has reached a terminal state. */
export function assertNotTerminal<S extends string, E extends string>(
  machine: Machine<S, E>,
  state: S,
  what: string,
): void {
  if (machine.isTerminal(state)) {
    throw ApiError.unprocessable(`${what} is ${state}, which is final. Nothing further can be recorded against it.`);
  }
}
