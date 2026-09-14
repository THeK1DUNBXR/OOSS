/**
 * Technology — service desk (docs/plan/cio.md, workstream D).
 *
 * Pure arithmetic and the lifecycle machine a ticket's transitions are
 * checked against. Nothing here touches a database: `dueFrom` is the SLA
 * clock's due-time arithmetic, `slaAttainment` and `medianMinutes` are the
 * summary's own arithmetic, tested without a DB the same way the compliance
 * calendar's `nextDueDates` is.
 */

import { createMachine, type Machine } from '../hr.js';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const IT_TICKET_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type ItTicketPriority = (typeof IT_TICKET_PRIORITIES)[number];

export const IT_TICKET_CATEGORIES = ['incident', 'request', 'access', 'question'] as const;
export type ItTicketCategory = (typeof IT_TICKET_CATEGORIES)[number];

export const IT_KNOWLEDGE_STATUSES = ['draft', 'published', 'retired'] as const;
export type ItKnowledgeStatus = (typeof IT_KNOWLEDGE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Ticket lifecycle
// ---------------------------------------------------------------------------

export type ItTicketStatus = 'new' | 'triaged' | 'in_progress' | 'waiting' | 'resolved' | 'closed';

export type ItTicketEvent =
  | 'TRIAGE'
  | 'START'
  | 'WAIT'
  | 'RESUME'
  | 'RESOLVE'
  | 'CLOSE'
  | 'REOPEN';

/** `new -> triaged -> in_progress -> waiting -> resolved -> closed`, with
 * `REOPEN` taking a resolved ticket back to `in_progress` (the plan's
 * "reopened from resolved" is this event, not a seventh state — a reopened
 * ticket is simply back in progress). `closed` is terminal: nothing reopens
 * a closed ticket, a new one is raised instead. */
export const ticketMachine: Machine<ItTicketStatus, ItTicketEvent> = createMachine<ItTicketStatus, ItTicketEvent>(
  'ItTicket',
  {
    new: { TRIAGE: 'triaged' },
    triaged: { START: 'in_progress' },
    in_progress: { WAIT: 'waiting', RESOLVE: 'resolved' },
    waiting: { RESUME: 'in_progress', RESOLVE: 'resolved' },
    resolved: { CLOSE: 'closed', REOPEN: 'in_progress' },
    closed: {},
  },
);

export const TICKET_EVENT_VERB: Record<ItTicketEvent, string> = {
  TRIAGE: 'triaged',
  START: 'started',
  WAIT: 'waiting',
  RESUME: 'resumed',
  RESOLVE: 'resolved',
  CLOSE: 'closed',
  REOPEN: 'reopened',
};

// ---------------------------------------------------------------------------
// SLA due-date arithmetic
// ---------------------------------------------------------------------------

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;
/** India Standard Time, UTC+5:30, fixed — no DST. */
const IST_OFFSET_MIN = 330;
const BUSINESS_START_MIN = 9 * 60;
const BUSINESS_END_MIN = 18 * 60;

function toIst(d: Date): { day: number; minute: number } {
  const istMs = d.getTime() + IST_OFFSET_MIN * MS_PER_MIN;
  const day = Math.floor(istMs / MS_PER_DAY);
  const minute = Math.floor((istMs - day * MS_PER_DAY) / MS_PER_MIN);
  return { day, minute };
}

function fromIst(day: number, minute: number): Date {
  const istMs = day * MS_PER_DAY + minute * MS_PER_MIN;
  return new Date(istMs - IST_OFFSET_MIN * MS_PER_MIN);
}

/** Sunday=0 .. Saturday=6, in the same shifted timeline `toIst`/`fromIst` use. */
function dayOfWeek(day: number): number {
  return new Date(day * MS_PER_DAY).getUTCDay();
}

function isWeekend(day: number): boolean {
  const dow = dayOfWeek(day);
  return dow === 0 || dow === 6;
}

/** The first business day on or after `day`, at 09:00. */
function atOrNextBusinessStart(day: number): { day: number; minute: number } {
  let d = day;
  while (isWeekend(d)) d += 1;
  return { day: d, minute: BUSINESS_START_MIN };
}

/**
 * The due time `minutes` after `createdAt`. With `businessHoursOnly` false
 * this is plain calendar arithmetic; true, it counts only Mon-Fri 09:00-18:00
 * IST — a ticket raised at 17:30 with a 4-hour budget is due late the next
 * business day, not at 21:30 the same evening.
 */
export function dueFrom(createdAt: Date, minutes: number, businessHoursOnly: boolean): Date {
  if (!businessHoursOnly) return new Date(createdAt.getTime() + minutes * MS_PER_MIN);

  let { day, minute } = toIst(createdAt);

  if (isWeekend(day)) {
    ({ day, minute } = atOrNextBusinessStart(day));
  } else if (minute < BUSINESS_START_MIN) {
    minute = BUSINESS_START_MIN;
  } else if (minute >= BUSINESS_END_MIN) {
    ({ day, minute } = atOrNextBusinessStart(day + 1));
  }

  let remaining = minutes;
  while (remaining > 0) {
    const availableToday = BUSINESS_END_MIN - minute;
    if (remaining <= availableToday) {
      minute += remaining;
      remaining = 0;
    } else {
      remaining -= availableToday;
      ({ day, minute } = atOrNextBusinessStart(day + 1));
    }
  }

  return fromIst(day, minute);
}

// ---------------------------------------------------------------------------
// Summary arithmetic
// ---------------------------------------------------------------------------

export interface SlaAttainmentRow {
  met: boolean;
}

/** The share of `rows` that met their clock, as a percentage rounded to one
 * decimal place — `null` when there is nothing to measure (Principle 6: "not
 * yet measured" is distinct from "100%"). */
export function slaAttainment(rows: SlaAttainmentRow[]): number | null {
  if (rows.length === 0) return null;
  const met = rows.filter((r) => r.met).length;
  return Math.round((met / rows.length) * 1000) / 10;
}

/** The median of a set of minute values, or `null` for an empty set. */
export function medianMinutes(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Backlog age buckets, in whole days from `now`, over a set of creation
 * timestamps still open. Pure — the caller filters to open tickets first. */
export function backlogAgeBuckets(createdAts: Date[], now: Date): { d0_1: number; d2_7: number; d8_30: number; d30plus: number } {
  const buckets = { d0_1: 0, d2_7: 0, d8_30: 0, d30plus: 0 };
  for (const createdAt of createdAts) {
    const ageDays = Math.floor((now.getTime() - createdAt.getTime()) / MS_PER_DAY);
    if (ageDays <= 1) buckets.d0_1 += 1;
    else if (ageDays <= 7) buckets.d2_7 += 1;
    else if (ageDays <= 30) buckets.d8_30 += 1;
    else buckets.d30plus += 1;
  }
  return buckets;
}
