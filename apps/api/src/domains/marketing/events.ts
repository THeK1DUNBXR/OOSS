/**
 * Marketing events & registrations (MKT-EVT-001 through MKT-EVT-004, and the
 * event-domain slice of MKT-GOV/MKT-CAP).
 *
 * A MarketingEvent (seminar/webinar/open day/etc — not a P4 event-fabric
 * event) moves along a fixed state machine: planned → open → closed → live →
 * completed, with cancelled reachable from any non-terminal state.
 * `MARKETING_EVENT_TRANSITIONS` in `@kaizen/shared` is the single source of
 * truth for which moves are legal; this file never re-derives the graph.
 *
 * Registration creates a `MarketingTouchpoint` (kind `visit`) and, on
 * check-in, a second one (kind `event_attend`) — the attribution log a lead's
 * eventual score reads from. Identity resolution for an inline person always
 * goes through `findOrCreatePerson`; no code path here constructs a Person.
 */

import {
  EVENTS,
  MARKETING_EVENT_TRANSITIONS,
  REGISTRATION_STATUSES,
  type MarketingEventStatus,
  type RegistrationStatus,
  type Vertical,
} from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { raiseException } from '../../platform/exceptions.js';
import { findOrCreatePerson, type PersonInput } from '../identity.js';
import { logInteraction } from '../interactions.js';
import { createLead } from '../leads.js';

// ---------------------------------------------------------------------------
// A marketing `division` (software/skill/education/shared) is not the same
// vocabulary as a CRM `Vertical` — leads always need the latter. This is the
// one declared mapping between the two; nothing else in this file re-derives it.
// ---------------------------------------------------------------------------
const DIVISION_TO_VERTICAL: Record<string, Vertical> = {
  education: 'education',
  skill: 'corporate_training',
  software: 'software_ai',
  shared: 'other',
};

export interface EventInput {
  name: string;
  kind: string;
  campaignId?: string | null;
  institutionId?: string | null;
  venue?: string | null;
  isOnline?: boolean;
  startAt: Date;
  endAt?: Date | null;
  capacity?: number | null;
  costPlanned?: number | null;
  division?: string;
}

async function assertInstitution(institutionId: string, tenantId: string): Promise<void> {
  const org = await prisma.organization.findFirst({ where: { id: institutionId, tenantId, deletedAt: null } });
  if (!org) throw ApiError.notFound('Institution');
  if (org.kind !== 'institution') {
    throw ApiError.badRequest(`${org.name} is recorded as an organisation, not an institution. Only an institution may host a marketing event.`);
  }
}

async function assertCampaign(campaignId: string, tenantId: string): Promise<void> {
  const campaign = await prisma.marketingCampaign.findFirst({ where: { id: campaignId, tenantId, deletedAt: null } });
  if (!campaign) throw ApiError.notFound('Campaign');
}

export async function createEvent(input: EventInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_events', verb: 'create' });

  if (input.institutionId) await assertInstitution(input.institutionId, auth.tenantId);
  if (input.campaignId) await assertCampaign(input.campaignId, auth.tenantId);

  const recordCode = await nextRecordCode('EVT');
  const event = await prisma.marketingEvent.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: input.name,
      kind: input.kind,
      campaignId: input.campaignId ?? null,
      institutionId: input.institutionId ?? null,
      venue: input.venue ?? null,
      isOnline: input.isOnline ?? false,
      startAt: input.startAt,
      endAt: input.endAt ?? null,
      capacity: input.capacity ?? null,
      costPlanned: input.costPlanned ?? 0,
      division: input.division ?? 'education',
      createdById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.MKT_EVENT_CREATED,
    subject: { entityType: 'marketing_event', entityId: event.id, recordCode },
    newState: { status: event.status, name: event.name },
  });

  return event;
}

export interface EventListFilters {
  status?: string;
  campaignId?: string;
  division?: string;
  from?: Date;
  to?: Date;
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function listEvents(filters: EventListFilters = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_events', verb: 'view' });

  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 50, 200);

  const where: Record<string, unknown> = {
    tenantId: auth.tenantId,
    deletedAt: null,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
    ...(filters.division ? { division: filters.division } : {}),
    ...(filters.q ? { name: { contains: filters.q, mode: 'insensitive' } } : {}),
    ...(filters.from || filters.to
      ? { startAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.marketingEvent.findMany({
      where: where as never,
      orderBy: { startAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.marketingEvent.count({ where: where as never }),
  ]);

  return { items, total, page, pageSize };
}

async function registrationCounts(eventId: string) {
  const auth = currentAuth();
  const rows = await prisma.marketingEventRegistration.groupBy({
    by: ['status'],
    where: { tenantId: auth.tenantId, eventId },
    _count: { _all: true },
  });
  const counts: Record<RegistrationStatus, number> = {
    registered: 0,
    confirmed: 0,
    attended: 0,
    no_show: 0,
    cancelled: 0,
  };
  for (const r of rows) counts[r.status as RegistrationStatus] = r._count._all;
  return counts;
}

export async function loadEvent(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_events', verb: 'view' });

  const event = await prisma.marketingEvent.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!event) throw ApiError.notFound('Event');

  const counts = await registrationCounts(id);
  const registered = counts.registered + counts.confirmed + counts.attended + counts.no_show;
  const attended = counts.attended;

  // Not measured while nobody has attended — a per-head cost with a zero
  // denominator is not a number, it is a false zero.
  const costActual = num(event.costActual) ?? 0;
  const costPerAttendee = attended > 0 ? costActual / attended : null;

  return {
    ...event,
    costPlanned: num(event.costPlanned),
    costActual,
    registrations: { registered, confirmed: counts.confirmed, attended, noShow: counts.no_show, cancelled: counts.cancelled },
    costPerAttendee,
    costPerAttendeeMeasured: attended > 0,
  };
}

export async function updateEvent(id: string, patch: Partial<EventInput>) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_events', verb: 'edit' });

  const event = await prisma.marketingEvent.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!event) throw ApiError.notFound('Event');
  if (['completed', 'cancelled'].includes(event.status)) {
    throw ApiError.conflict(`Cannot edit a ${event.status} event.`);
  }

  if (patch.institutionId) await assertInstitution(patch.institutionId, auth.tenantId);
  if (patch.campaignId) await assertCampaign(patch.campaignId, auth.tenantId);

  const updated = await prisma.marketingEvent.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.campaignId !== undefined ? { campaignId: patch.campaignId } : {}),
      ...(patch.institutionId !== undefined ? { institutionId: patch.institutionId } : {}),
      ...(patch.venue !== undefined ? { venue: patch.venue } : {}),
      ...(patch.isOnline !== undefined ? { isOnline: patch.isOnline } : {}),
      ...(patch.startAt !== undefined ? { startAt: patch.startAt } : {}),
      ...(patch.endAt !== undefined ? { endAt: patch.endAt } : {}),
      ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
      ...(patch.costPlanned !== undefined ? { costPlanned: patch.costPlanned } : {}),
      ...(patch.division !== undefined ? { division: patch.division } : {}),
      updatedById: auth.partyId,
    },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

async function transitionEvent(id: string, to: MarketingEventStatus, eventName: string | null) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_events', verb: 'edit' });

  const event = await prisma.marketingEvent.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!event) throw ApiError.notFound('Event');

  const from = event.status as MarketingEventStatus;
  const allowed = MARKETING_EVENT_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw ApiError.unprocessable(`Cannot move a ${from} event to ${to}. Allowed: ${allowed.join(', ') || 'none'}.`);
  }

  const updated = await prisma.marketingEvent.update({
    where: { id },
    data: { status: to, updatedById: auth.partyId },
  });

  // No canonical kz.mkt.event.live exists in the fixed vocabulary — closed→live
  // is a real, permitted transition that simply carries no dedicated event.
  if (eventName) {
    await emit({
      name: eventName,
      subject: { entityType: 'marketing_event', entityId: id, recordCode: event.recordCode },
      previousState: { status: from },
      newState: { status: to },
    });
  }

  return updated;
}

export const openEvent = (id: string) => transitionEvent(id, 'open', EVENTS.MKT_EVENT_OPENED);
export const closeEvent = (id: string) => transitionEvent(id, 'closed', EVENTS.MKT_EVENT_CLOSED);
export const startEvent = (id: string) => transitionEvent(id, 'live', null);
export const completeEvent = (id: string) => transitionEvent(id, 'completed', EVENTS.MKT_EVENT_COMPLETED);

export async function cancelEvent(id: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_events', verb: 'edit' });
  const event = await prisma.marketingEvent.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!event) throw ApiError.notFound('Event');

  const from = event.status as MarketingEventStatus;
  const allowed = MARKETING_EVENT_TRANSITIONS[from] ?? [];
  if (!allowed.includes('cancelled')) {
    throw ApiError.unprocessable(`A ${from} event cannot be cancelled.`);
  }

  const updated = await prisma.marketingEvent.update({
    where: { id },
    data: { status: 'cancelled', updatedById: auth.partyId },
  });

  await emit({
    name: EVENTS.MKT_EVENT_CANCELLED,
    subject: { entityType: 'marketing_event', entityId: id, recordCode: event.recordCode },
    previousState: { status: from },
    newState: { status: 'cancelled' },
    reason: { reasonCode: 'cancelled', note: reason },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export interface RegisterInput {
  personId?: string;
  person?: PersonInput;
  source?: string;
}

async function recordTouchpointRow(input: {
  personId: string;
  leadId?: string | null;
  campaignId?: string | null;
  channelKey: string;
  touchKind: string;
  sourceRef?: string | null;
}) {
  const auth = currentAuth();
  // Touchpoints are immutable, append-only rows — no update path exists for
  // one once written, by design (MKT-CAP-004).
  return prisma.marketingTouchpoint.create({
    data: {
      tenantId: auth.tenantId,
      personId: input.personId,
      leadId: input.leadId ?? null,
      campaignId: input.campaignId ?? null,
      channelKey: input.channelKey,
      touchKind: input.touchKind,
      occurredAt: new Date(),
      utm: {},
      sourceRef: input.sourceRef ?? null,
    },
  });
}

export async function registerForEvent(eventId: string, input: RegisterInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_events', verb: 'edit' });

  const event = await prisma.marketingEvent.findFirst({ where: { id: eventId, tenantId: auth.tenantId, deletedAt: null } });
  if (!event) throw ApiError.notFound('Event');
  if (event.status !== 'open') {
    throw ApiError.conflict(`Registration is only accepted while an event is open (currently ${event.status}).`);
  }

  let personId = input.personId ?? null;
  if (!personId && input.person) {
    const resolved = await findOrCreatePerson(input.person);
    personId = resolved.person.id;
  }
  if (!personId) throw ApiError.badRequest('A registration requires personId or an inline person.');

  const existing = await prisma.marketingEventRegistration.findFirst({
    where: { tenantId: auth.tenantId, eventId, personId, status: { not: 'cancelled' } },
  });
  if (existing) throw ApiError.conflict('This person is already registered for this event.');

  if (event.capacity != null) {
    const activeCount = await prisma.marketingEventRegistration.count({
      where: { tenantId: auth.tenantId, eventId, status: { not: 'cancelled' } },
    });
    if (activeCount >= event.capacity) {
      throw ApiError.conflict('This event is at capacity.');
    }
  }

  const recordCode = await nextRecordCode('EVT');
  const registration = await prisma.marketingEventRegistration.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      eventId,
      personId,
      source: input.source ?? 'manual',
      createdById: auth.partyId,
    },
  });

  await recordTouchpointRow({
    personId,
    campaignId: event.campaignId,
    channelKey: 'event',
    touchKind: 'visit',
    sourceRef: event.recordCode,
  });

  await emit({
    name: EVENTS.MKT_EVENT_REGISTERED,
    subject: { entityType: 'marketing_event_registration', entityId: registration.id, recordCode },
    related: [
      { relation: 'event', entityType: 'marketing_event', entityId: eventId },
      { relation: 'registrant', entityType: 'person', entityId: personId },
    ],
    newState: { status: registration.status },
  });

  return registration;
}

export async function listEventRegistrations(eventId: string, status?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_events', verb: 'view' });
  return prisma.marketingEventRegistration.findMany({
    where: { tenantId: auth.tenantId, eventId, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

async function loadRegistration(registrationId: string) {
  const auth = currentAuth();
  const registration = await prisma.marketingEventRegistration.findFirst({
    where: { id: registrationId, tenantId: auth.tenantId },
  });
  if (!registration) throw ApiError.notFound('Registration');
  return registration;
}

const REGISTRATION_TRANSITIONS: Record<RegistrationStatus, RegistrationStatus[]> = {
  registered: ['confirmed', 'attended', 'no_show', 'cancelled'],
  confirmed: ['attended', 'no_show', 'cancelled'],
  attended: [],
  no_show: ['cancelled'],
  cancelled: [],
};

async function transitionRegistration(registrationId: string, to: RegistrationStatus) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_events', verb: 'edit' });
  const registration = await loadRegistration(registrationId);
  const from = registration.status as RegistrationStatus;
  const allowed = REGISTRATION_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw ApiError.unprocessable(`Cannot move a ${from} registration to ${to}.`);
  }
  return { registration, from };
}

export async function confirmRegistration(registrationId: string) {
  const { registration } = await transitionRegistration(registrationId, 'confirmed');
  return prisma.marketingEventRegistration.update({ where: { id: registration.id }, data: { status: 'confirmed' } });
}

export async function checkInRegistration(registrationId: string) {
  const { registration } = await transitionRegistration(registrationId, 'attended');
  const updated = await prisma.marketingEventRegistration.update({
    where: { id: registration.id },
    data: { status: 'attended', checkedInAt: new Date() },
  });

  const event = await prisma.marketingEvent.findFirst({ where: { id: registration.eventId } });
  await recordTouchpointRow({
    personId: registration.personId,
    leadId: registration.leadId,
    campaignId: event?.campaignId ?? null,
    channelKey: 'event',
    touchKind: 'event_attend',
    sourceRef: event?.recordCode ?? null,
  });

  await emit({
    name: EVENTS.MKT_EVENT_ATTENDED,
    subject: { entityType: 'marketing_event_registration', entityId: registration.id, recordCode: registration.recordCode },
    related: [{ relation: 'registrant', entityType: 'person', entityId: registration.personId }],
    newState: { status: 'attended', checkedInAt: updated.checkedInAt },
  });

  return updated;
}

export async function markNoShow(registrationId: string) {
  const { registration } = await transitionRegistration(registrationId, 'no_show');
  const updated = await prisma.marketingEventRegistration.update({ where: { id: registration.id }, data: { status: 'no_show' } });
  await emit({
    name: EVENTS.MKT_EVENT_NO_SHOW,
    subject: { entityType: 'marketing_event_registration', entityId: registration.id, recordCode: registration.recordCode },
    newState: { status: 'no_show' },
  });
  return updated;
}

export async function cancelRegistration(registrationId: string) {
  const { registration, from } = await transitionRegistration(registrationId, 'cancelled');
  const updated = await prisma.marketingEventRegistration.update({ where: { id: registration.id }, data: { status: 'cancelled' } });
  await emit({
    name: EVENTS.MKT_EVENT_CANCELLED,
    subject: { entityType: 'marketing_event_registration', entityId: registration.id, recordCode: registration.recordCode },
    previousState: { status: from },
    newState: { status: 'cancelled' },
  });
  return updated;
}

export async function followUpRegistration(registrationId: string, done: boolean, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_events', verb: 'edit' });
  const registration = await loadRegistration(registrationId);

  const updated = await prisma.marketingEventRegistration.update({
    where: { id: registration.id },
    data: { followUpDone: done },
  });

  if (done) {
    await logInteraction({
      interactionType: 'meeting',
      direction: 'outbound',
      occurredAt: new Date(),
      relatedReferences: [
        { contextCode: 'mkt', entityType: 'person', entityId: registration.personId },
        ...(registration.leadId ? [{ contextCode: 'crm', entityType: 'lead', entityId: registration.leadId }] : []),
      ],
      subject: 'Event follow-up',
      notes: note ?? null,
      outcome: 'followed_up',
    });
  }

  return updated;
}

/**
 * Creates a lead for every attended registration that does not already carry
 * one (MKT-EVT). The lead's source is 'event', sourceDetail carries the
 * event's own recordCode, and campaignId/channelKey are backfilled onto the
 * Lead row after createLead returns, since LeadInput has no such fields.
 */
export async function convertAttendees(eventId: string): Promise<{ created: number }> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_events', verb: 'edit' });

  const event = await prisma.marketingEvent.findFirst({ where: { id: eventId, tenantId: auth.tenantId, deletedAt: null } });
  if (!event) throw ApiError.notFound('Event');

  const candidates = await prisma.marketingEventRegistration.findMany({
    where: { tenantId: auth.tenantId, eventId, status: 'attended', leadId: null },
  });

  const vertical = DIVISION_TO_VERTICAL[event.division] ?? 'other';
  let created = 0;

  for (const registration of candidates) {
    const person = await prisma.person.findFirst({ where: { id: registration.personId } });
    if (!person) continue;

    const lead = await createLead({
      title: `${event.name} attendee — ${person.fullName}`,
      personId: registration.personId,
      vertical,
      source: 'event',
      sourceDetail: event.recordCode,
    });

    await prisma.lead.update({
      where: { id: lead.id },
      data: { campaignId: event.campaignId ?? null, channelKey: 'event' },
    });

    await prisma.marketingEventRegistration.update({
      where: { id: registration.id },
      data: { leadId: lead.id },
    });

    await recordTouchpointRow({
      personId: registration.personId,
      leadId: lead.id,
      campaignId: event.campaignId,
      channelKey: 'event',
      touchKind: 'event_attend',
      sourceRef: event.recordCode,
    });

    created += 1;
  }

  return { created };
}

export async function exportRegistrations(eventId: string): Promise<string> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_events', verb: 'export' });

  const registrations = await prisma.marketingEventRegistration.findMany({
    where: { tenantId: auth.tenantId, eventId },
    orderBy: { createdAt: 'asc' },
  });
  const people = await prisma.person.findMany({
    where: { id: { in: [...new Set(registrations.map((r) => r.personId))] } },
    select: { id: true, fullName: true, primaryPhone: true, primaryEmail: true },
  });
  const byId = new Map(people.map((p) => [p.id, p]));

  const header = ['recordCode', 'fullName', 'phone', 'email', 'status', 'source', 'checkedInAt', 'followUpDone'];
  const rows = registrations.map((r) => {
    const p = byId.get(r.personId);
    return [
      r.recordCode,
      p?.fullName ?? '',
      p?.primaryPhone ?? '',
      p?.primaryEmail ?? '',
      r.status,
      r.source,
      r.checkedInAt ? r.checkedInAt.toISOString() : '',
      String(r.followUpDone),
    ];
  });

  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * EX-MKT-008: a completed event with attended registrations whose follow-up
 * is still outstanding, more than 3 days after completion.
 */
export async function detectFollowUpsOutstanding(thresholdDays = 3): Promise<number> {
  const auth = currentAuth();
  const cutoff = new Date(Date.now() - thresholdDays * 86_400_000);

  const events = await prisma.marketingEvent.findMany({
    where: { tenantId: auth.tenantId, status: 'completed', updatedAt: { lt: cutoff } },
    take: 200,
  });

  let raised = 0;
  for (const event of events) {
    const outstanding = await prisma.marketingEventRegistration.findMany({
      where: { tenantId: auth.tenantId, eventId: event.id, status: 'attended', followUpDone: false },
    });
    if (outstanding.length === 0) continue;

    await raiseException({
      code: 'EX-MKT-008',
      label: 'Event completed with follow-ups outstanding',
      severity: 'S1_ATTENTION',
      subjectType: 'marketing_event',
      subjectId: event.id,
      subjectLabel: `${event.recordCode} — ${event.name}`,
      domain: 'mkt',
      detail: `${outstanding.length} attendee(s) have not been followed up, more than ${thresholdDays} days after completion.`,
      ownerPartyId: event.createdById,
      triggerFingerprint: `mkt_event_followup:${thresholdDays}`,
      ladderRung: 1,
    });
    raised += 1;
  }

  return raised;
}

export interface EventView {
  id: string;
  recordCode: string;
  name: string;
  kind: string;
  startAt: Date;
  endAt: Date | null;
  status: MarketingEventStatus;
}

export { REGISTRATION_STATUSES };
