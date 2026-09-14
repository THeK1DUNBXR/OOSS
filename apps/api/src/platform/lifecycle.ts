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

  await emit({
    name: eventName,
    subject: { entityType: input.subjectType, entityId: input.subjectId, recordCode: input.recordCode },
    related: input.related,
    previousState: { status: input.from },
    newState: { status: to, ...input.detail },
    reason: input.reasonNote ? { reasonCode: input.event, note: input.reasonNote } : null,
    owner: { partyId: input.ownerPartyId ?? null },
    impact: { domains: [input.impactDomain ?? 'hr'] },
  });

  await auditWrite({
    action: 'update',
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    before: { status: input.from },
    after: { status: to, ...input.detail },
    meta: { transition: input.event, machine: input.machine.name },
    force: true,
  });

  return { from: input.from, to, eventName };
}

/**
 * What a surface should render as available actions. Filtered by the machine
 * only — the grant check still happens on the way in, because a button the
 * viewer cannot press is a different problem from a transition that does not
 * exist.
 */
export function availableTransitions<S extends string, E extends string>(
  machine: Machine<S, E>,
  state: S,
): E[] {
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
