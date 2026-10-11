/**
 * Technology — service desk (docs/plan/cio.md, workstream D).
 *
 * `ExceptionRecord` is what the system raises against itself; `ItTicket` is
 * what a person raises. A ticket's SLA clocks are stamped once, at triage,
 * from the `ItSlaPolicy` row in force on the ticket's OWN creation date —
 * never today's table (IT-SLA-001), and never recomputed by a later
 * transition. Visibility follows the plan's own mapping: an employee's
 * `VC@own` grant narrows a ticket list to `requesterPartyId`, widened to
 * also include a ticket `assigneePartyId` points at them — the five-axis
 * evaluator's generic WHERE axis only narrows on one field, so this file
 * does the OR itself rather than pretending a single scope field covers it.
 */

import {
  EVENTS,
  IT_DOMAIN,
  dueFrom,
  medianMinutes,
  slaAttainment,
  backlogAgeBuckets,
  ticketMachine,
  TICKET_EVENT_VERB,
  IT_TICKET_PRIORITIES,
  IT_TICKET_CATEGORIES,
  IT_KNOWLEDGE_STATUSES,
  type ItTicketEvent,
  type ItTicketStatus,
  type ItTicketPriority,
  type ItTicketCategory,
  type ItKnowledgeStatus,
  type Resource,
} from '@kaizen/shared';

// `Resource` (packages/shared/src/permissions.ts) is the platform's shared
// literal union and does not yet carry the `it_*` resources any technology
// workstream uses — a gap in a file this workstream does not own (see the
// final report's "proposed edits" section for the exact diff). `transition()`
// (apps/api/src/platform/lifecycle.ts) types its `resource` field against
// that union, so every workstream that drives a lifecycle machine through it
// needs this same local cast until the shared file is updated.
const TICKETS_RESOURCE = 'it_tickets' as unknown as Resource;
// Without these two, transition() files a ticket under kz.hr.ticket.* and
// stamps its impact as `hr`, so IT subscribers never see the transition.
const TICKET_EVENT_PREFIX = 'kz.it';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, assertScopeAll, matchNothing, scopeFor } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';
import { transition, transitionInTx, availableTransitions } from '../../platform/lifecycle.js';

registerGovernedEntities('it', ['it_ticket', 'it_ticket_comment', 'it_knowledge_article', 'it_sla_policy']);

/** The role whose active affiliation runs the desk — the exception owner
 * for a ticket nobody is assigned to. Data, never a role-slug branch in the
 * logic that consumes it (`runServicedeskJob` reads the return value and
 * never branches on the slug). */
const DESK_OWNER_ROLE_SLUG = 'hr_ops_manager';

export async function resolveDeskOwnerPartyId(): Promise<string | null> {
  const auth = currentAuth();
  const affiliation = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, roleSlug: DESK_OWNER_ROLE_SLUG, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return affiliation?.partyId ?? null;
}

async function namesFor(partyIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const auth = currentAuth();
  const ids = [...new Set(partyIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const people = await prisma.person.findMany({
    where: { id: { in: ids }, tenantId: auth.tenantId },
    select: { id: true, fullName: true },
  });
  return new Map(people.map((p) => [p.id, p.fullName]));
}

// ---------------------------------------------------------------------------
// SLA policies
// ---------------------------------------------------------------------------

export async function listSlaPolicies() {
  const auth = currentAuth();
  await assertCan({ resource: 'it_sla_policies', verb: 'view' });
  return prisma.itSlaPolicy.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: [{ priority: 'asc' }, { effectiveFrom: 'desc' }],
  });
}

export interface SetSlaPolicyInput {
  priority: ItTicketPriority;
  responseMinutes: number;
  resolutionMinutes: number;
  businessHoursOnly?: boolean;
  effectiveFrom?: Date;
  note?: string | null;
}

/** A new dated row, never an edit of an old one — the way statutory rates
 * are versioned (Principle 4). A ticket already triaged under the old row
 * keeps the due times it was stamped with. */
export async function setSlaPolicy(input: SetSlaPolicyInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_sla_policies', verb: 'create' });

  if (!IT_TICKET_PRIORITIES.includes(input.priority)) {
    throw ApiError.badRequest(`Priority must be one of ${IT_TICKET_PRIORITIES.join(', ')}.`);
  }
  if (input.responseMinutes <= 0 || input.resolutionMinutes <= 0) {
    throw ApiError.badRequest('Response and resolution minutes must both be positive.');
  }

  const policy = await prisma.itSlaPolicy.create({
    data: {
      tenantId: auth.tenantId,
      priority: input.priority,
      responseMinutes: input.responseMinutes,
      resolutionMinutes: input.resolutionMinutes,
      businessHoursOnly: input.businessHoursOnly ?? true,
      effectiveFrom: input.effectiveFrom ?? new Date(),
      note: input.note ?? null,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_sla_policy', subjectId: policy.id, after: policy });
  return policy;
}

async function slaPolicyInForce(priority: string, asOf: Date) {
  const auth = currentAuth();
  return prisma.itSlaPolicy.findFirst({
    where: { tenantId: auth.tenantId, priority, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Ticket visibility
// ---------------------------------------------------------------------------

interface TicketLike {
  requesterPartyId: string;
  assigneePartyId: string | null;
}

/** The WHERE fragment for a ticket list: everything for an `all`-scope
 * grant, otherwise tickets the caller raised OR is assigned to. */
async function ticketVisibilityWhere(): Promise<Record<string, unknown>> {
  const auth = currentAuth();
  const scope = await scopeFor('it_tickets', 'view');
  if (scope === null) return matchNothing('requesterPartyId');
  if (scope === 'all') return {};
  return { OR: [{ requesterPartyId: auth.partyId! }, { assigneePartyId: auth.partyId }] };
}

/** The same narrowing, applied to one already-fetched ticket. */
async function assertTicketVisible(ticket: TicketLike): Promise<void> {
  const auth = currentAuth();
  await assertCan({ resource: 'it_tickets', verb: 'view' });
  const scope = await scopeFor('it_tickets', 'view');
  if (scope === 'all') return;
  if (ticket.requesterPartyId === auth.partyId) return;
  if (ticket.assigneePartyId && ticket.assigneePartyId === auth.partyId) return;
  throw ApiError.forbidden(
    'This ticket is outside your scope — you may see tickets you raised, or that are assigned to you.',
  );
}

/** Whether the caller holds a desk role (an `edit` grant on tickets),
 * as opposed to a requester who only holds `view`/`create` at `own` scope. */
async function isDeskStaff(): Promise<boolean> {
  return (await scopeFor('it_tickets', 'edit')) !== null;
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export interface CreateTicketInput {
  category: ItTicketCategory;
  subject: string;
  description: string;
  assetId?: string | null;
  applicationId?: string | null;
  /** Only honoured for a caller holding `all` scope on tickets — a desk
   * role logging a call on somebody's behalf. Anyone else raises their own. */
  requesterPartyId?: string | null;
}

export async function createTicket(input: CreateTicketInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_tickets', verb: 'create' });

  if (!IT_TICKET_CATEGORIES.includes(input.category)) {
    throw ApiError.badRequest(`Category must be one of ${IT_TICKET_CATEGORIES.join(', ')}.`);
  }
  if (!input.subject?.trim() || !input.description?.trim()) {
    throw ApiError.badRequest('A ticket needs a subject and a description.');
  }

  let requesterPartyId = auth.partyId!;
  if (input.requesterPartyId && input.requesterPartyId !== auth.partyId) {
    const scope = await scopeFor('it_tickets', 'create');
    if (scope !== 'all') {
      throw ApiError.forbidden("Only a desk role may raise a ticket on someone else's behalf.");
    }
    requesterPartyId = input.requesterPartyId;
  }

  const recordCode = await nextRecordCode('TKT');
  const ticket = await prisma.$transaction(async (tx) => {
    const ticket = await tx.itTicket.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        requesterPartyId,
        category: input.category,
        subject: input.subject.trim(),
        description: input.description.trim(),
        assetId: input.assetId ?? null,
        applicationId: input.applicationId ?? null,
        status: 'new',
      },
    });

    await auditWrite({
      action: 'create',
      subjectType: 'it_ticket',
      subjectId: ticket.id,
      after: { recordCode, category: input.category },
      tx,
    });
    await emit({
      name: EVENTS.IT_TICKET_RAISED,
      subject: { entityType: 'it_ticket', entityId: ticket.id, recordCode },
      newState: { status: 'new', category: input.category },
      owner: { partyId: requesterPartyId },
      impact: { domains: [IT_DOMAIN] },
      tx,
    });
    return ticket;
  });

  return ticket;
}

export interface TicketFilter {
  tab?: 'mine' | 'unassigned' | 'open' | 'breached' | 'all';
  status?: string;
  priority?: string;
}

export async function listTickets(filter: TicketFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_tickets', verb: 'view' });

  const conditions: Record<string, unknown>[] = [{ tenantId: auth.tenantId }, await ticketVisibilityWhere()];
  if (filter.priority) conditions.push({ priority: filter.priority });
  if (filter.status) conditions.push({ status: filter.status });

  switch (filter.tab) {
    case 'mine':
      conditions.push({ OR: [{ requesterPartyId: auth.partyId }, { assigneePartyId: auth.partyId }] });
      break;
    case 'unassigned':
      conditions.push({ assigneePartyId: null, status: { notIn: ['closed'] } });
      break;
    case 'open':
      conditions.push({ status: { notIn: ['resolved', 'closed'] } });
      break;
    case 'breached':
      conditions.push({ slaBreachNotified: { hasSome: ['response', 'resolution'] } });
      break;
    default:
      break;
  }

  const rows = await prisma.itTicket.findMany({ where: { AND: conditions }, orderBy: { createdAt: 'desc' } });
  const names = await namesFor(rows.flatMap((r) => [r.requesterPartyId, r.assigneePartyId]));

  return rows.map((t) => ({
    ...t,
    requesterName: names.get(t.requesterPartyId) ?? t.requesterPartyId,
    assigneeName: t.assigneePartyId ? (names.get(t.assigneePartyId) ?? t.assigneePartyId) : null,
    availableTransitions: availableTransitions(ticketMachine, t.status as ItTicketStatus),
  }));
}

export async function getTicket(id: string) {
  const auth = currentAuth();
  const ticket = await prisma.itTicket.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { comments: { orderBy: { createdAt: 'asc' } } },
  });
  if (!ticket) throw ApiError.notFound('Ticket');
  await assertTicketVisible(ticket);

  const deskStaff = await isDeskStaff();
  const visibleComments = ticket.comments.filter((c) => deskStaff || !c.internal || c.authorPartyId === auth.partyId);
  const names = await namesFor([
    ticket.requesterPartyId,
    ticket.assigneePartyId,
    ...visibleComments.map((c) => c.authorPartyId),
  ]);

  return {
    ...ticket,
    comments: visibleComments.map((c) => ({ ...c, authorName: names.get(c.authorPartyId) ?? c.authorPartyId })),
    requesterName: names.get(ticket.requesterPartyId) ?? ticket.requesterPartyId,
    assigneeName: ticket.assigneePartyId ? (names.get(ticket.assigneePartyId) ?? ticket.assigneePartyId) : null,
    availableTransitions: availableTransitions(ticketMachine, ticket.status as ItTicketStatus),
    canRate:
      ticket.requesterPartyId === auth.partyId &&
      ['resolved', 'closed'].includes(ticket.status) &&
      ticket.satisfaction === null,
  };
}

export interface TriageInput {
  priority: ItTicketPriority;
  category?: ItTicketCategory;
}

/**
 * Sets priority (and optionally re-categorises) and stamps the SLA clocks
 * from the policy in force ON THE TICKET'S CREATION DATE — IT-SLA-001. Only
 * legal from `new`: triage happens once, the way a filing is a snapshot
 * once made.
 */
export async function triageTicket(id: string, input: TriageInput) {
  const auth = currentAuth();
  const ticket = await prisma.itTicket.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!ticket) throw ApiError.notFound('Ticket');

  if (!IT_TICKET_PRIORITIES.includes(input.priority)) {
    throw ApiError.badRequest(`Priority must be one of ${IT_TICKET_PRIORITIES.join(', ')}.`);
  }

  const policy = await slaPolicyInForce(input.priority, ticket.createdAt);
  if (!policy) {
    throw ApiError.badRequest(
      `No SLA policy is in force for ${input.priority} as of ${ticket.createdAt.toISOString().slice(0, 10)} — set one before triaging.`,
    );
  }

  const respondDueAt = dueFrom(ticket.createdAt, policy.responseMinutes, policy.businessHoursOnly);
  const resolveDueAt = dueFrom(ticket.createdAt, policy.resolutionMinutes, policy.businessHoursOnly);

  const result = await transition({
    machine: ticketMachine,
    eventObject: 'ticket',
    verbs: TICKET_EVENT_VERB,
    resource: TICKETS_RESOURCE,
    verb: 'edit',
    subjectType: 'it_ticket',
    subjectId: id,
    recordCode: ticket.recordCode,
    ownerPartyId: ticket.assigneePartyId ?? ticket.requesterPartyId,
    from: ticket.status as ItTicketStatus,
    event: 'TRIAGE',
    detail: { priority: input.priority, respondDueAt, resolveDueAt },
    eventPrefix: TICKET_EVENT_PREFIX,
    impactDomain: IT_DOMAIN,
  });

  const updated = await prisma.itTicket.update({
    where: { id },
    data: {
      status: result.to,
      priority: input.priority,
      category: input.category ?? ticket.category,
      respondDueAt,
      resolveDueAt,
    },
  });

  return updated;
}

export async function assignTicket(id: string, assigneePartyId: string) {
  const auth = currentAuth();
  const ticket = await prisma.itTicket.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!ticket) throw ApiError.notFound('Ticket');
  await assertCan({
    resource: 'it_tickets',
    verb: 'edit',
    record: { ownerPartyId: ticket.requesterPartyId, assigneePartyId: ticket.assigneePartyId },
  });

  const person = await prisma.person.findFirst({ where: { id: assigneePartyId, tenantId: auth.tenantId } });
  if (!person) throw ApiError.badRequest('The assignee must be a known person.');

  const updated = await prisma.$transaction(async (tx) => {
    const updated = await tx.itTicket.update({ where: { id }, data: { assigneePartyId } });

    await auditWrite({
      action: 'update',
      subjectType: 'it_ticket',
      subjectId: id,
      before: { assigneePartyId: ticket.assigneePartyId },
      after: { assigneePartyId },
      tx,
    });
    await emit({
      name: EVENTS.IT_TICKET_ASSIGNED,
      subject: { entityType: 'it_ticket', entityId: id, recordCode: ticket.recordCode },
      newState: { assigneePartyId },
      owner: { partyId: assigneePartyId },
      impact: { domains: [IT_DOMAIN] },
      tx,
    });
    return updated;
  });

  return updated;
}

export async function transitionTicket(id: string, event: ItTicketEvent, note?: string) {
  const auth = currentAuth();
  const ticket = await prisma.itTicket.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!ticket) throw ApiError.notFound('Ticket');

  const now = new Date();
  const detail: Record<string, unknown> = {};
  if (event === 'RESOLVE') detail.resolvedAt = now;
  if (event === 'CLOSE') detail.closedAt = now;
  if (event === 'REOPEN') detail.reopened = true;
  if (event === 'WAIT') detail.waitingSince = now;
  if (event === 'START' && !ticket.firstRespondedAt) detail.firstRespondedAt = now;

  // One transaction for the status, its audit row and both events. The summary
  // event is a distinct name for the same transition, so it sits after the
  // transition's own event and after the audit row, as governedWrite.ts orders it.
  const { value: updated } = await transitionInTx(
    {
      machine: ticketMachine,
      eventObject: 'ticket',
      verbs: TICKET_EVENT_VERB,
      resource: TICKETS_RESOURCE,
      verb: 'edit',
      subjectType: 'it_ticket',
      subjectId: id,
      recordCode: ticket.recordCode,
      ownerPartyId: ticket.assigneePartyId ?? ticket.requesterPartyId,
      from: ticket.status as ItTicketStatus,
      event,
      detail,
      reasonNote: note ?? null,
      eventPrefix: TICKET_EVENT_PREFIX,
      impactDomain: IT_DOMAIN,
    },
    {
      write: (tx, to) => {
        const data: Record<string, unknown> = { status: to };
        if (event === 'RESOLVE') data.resolvedAt = now;
        if (event === 'CLOSE') data.closedAt = now;
        if (event === 'REOPEN') {
          data.resolvedAt = null;
          data.closedAt = null;
          data.satisfaction = null;
        }
        if (event === 'WAIT') data.waitingSince = now;
        if (event === 'RESUME') data.waitingSince = null;
        if (event === 'START' && !ticket.firstRespondedAt) data.firstRespondedAt = now;
        return tx.itTicket.update({ where: { id }, data });
      },
      alsoEmit: async (tx, to) => {
        await emit({
          name: EVENTS.IT_TICKET_TRANSITIONED,
          subject: { entityType: 'it_ticket', entityId: id, recordCode: ticket.recordCode },
          previousState: { status: ticket.status },
          newState: { status: to },
          impact: { domains: [IT_DOMAIN] },
          tx,
        });
      },
    },
  );

  return updated;
}

export interface AddCommentInput {
  body: string;
  internal?: boolean;
}

export async function addComment(ticketId: string, input: AddCommentInput) {
  const auth = currentAuth();
  const ticket = await prisma.itTicket.findFirst({ where: { id: ticketId, tenantId: auth.tenantId } });
  if (!ticket) throw ApiError.notFound('Ticket');
  if (!input.body?.trim()) throw ApiError.badRequest('A comment needs a body.');

  await assertCan({ resource: 'it_tickets', verb: 'create' });
  const scope = await scopeFor('it_tickets', 'view');
  if (scope !== 'all' && ticket.requesterPartyId !== auth.partyId && ticket.assigneePartyId !== auth.partyId) {
    throw ApiError.forbidden('This ticket is outside your scope.');
  }

  const internal = Boolean(input.internal);
  if (internal) {
    // Internal notes are desk conversation, not shown to the requester —
    // restricted to whoever holds edit on tickets.
    await assertCan({ resource: 'it_tickets', verb: 'edit' });
  }

  const comment = await prisma.itTicketComment.create({
    data: {
      tenantId: auth.tenantId,
      ticketId,
      body: input.body.trim(),
      internal,
      authorPartyId: auth.partyId!,
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'it_ticket_comment',
    subjectId: comment.id,
    after: { ticketId, internal },
  });

  return comment;
}

/** Set once by the requester, on a resolved (or closed) ticket only. */
export async function rateTicket(id: string, satisfaction: number) {
  const auth = currentAuth();
  const ticket = await prisma.itTicket.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!ticket) throw ApiError.notFound('Ticket');
  await assertCan({ resource: 'it_tickets', verb: 'view' });

  if (ticket.requesterPartyId !== auth.partyId) {
    throw ApiError.forbidden('Only the person who raised this ticket may rate it.');
  }
  if (!['resolved', 'closed'].includes(ticket.status)) {
    throw ApiError.unprocessable(
      `${ticket.recordCode ?? ticket.id} is ${ticket.status}; only a resolved or closed ticket can be rated.`,
    );
  }
  if (ticket.satisfaction !== null) {
    throw ApiError.conflict('This ticket already carries a satisfaction rating — it is set once.');
  }
  if (!Number.isInteger(satisfaction) || satisfaction < 1 || satisfaction > 5) {
    throw ApiError.badRequest('Satisfaction is a whole number from 1 to 5.');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updated = await tx.itTicket.update({ where: { id }, data: { satisfaction } });

    await auditWrite({ action: 'update', subjectType: 'it_ticket', subjectId: id, after: { satisfaction }, tx });
    await emit({
      name: EVENTS.IT_TICKET_RATED,
      subject: { entityType: 'it_ticket', entityId: id, recordCode: ticket.recordCode },
      newState: { satisfaction },
      impact: { domains: [IT_DOMAIN] },
      tx,
    });
    return updated;
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export async function listKnowledge(filter: { status?: string; applicationId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_knowledge', verb: 'view' });
  const canManage = (await scopeFor('it_knowledge', 'edit')) !== null;

  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (filter.applicationId) where.applicationId = filter.applicationId;
  where.status = canManage && filter.status ? filter.status : canManage ? undefined : 'published';
  if (where.status === undefined) delete where.status;

  return prisma.itKnowledgeArticle.findMany({ where, orderBy: { updatedAt: 'desc' } });
}

export async function getKnowledgeArticle(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_knowledge', verb: 'view' });
  const article = await prisma.itKnowledgeArticle.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!article) throw ApiError.notFound('Knowledge article');

  const canManage = (await scopeFor('it_knowledge', 'edit')) !== null;
  if (article.status !== 'published' && !canManage) throw ApiError.notFound('Knowledge article');

  return article;
}

export interface CreateKnowledgeInput {
  title: string;
  body: string;
  applicationId?: string | null;
}

export async function createKnowledgeArticle(input: CreateKnowledgeInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_knowledge', verb: 'create' });
  if (!input.title?.trim() || !input.body?.trim()) throw ApiError.badRequest('An article needs a title and a body.');

  const recordCode = await nextRecordCode('KBA');
  const article = await prisma.itKnowledgeArticle.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title.trim(),
      body: input.body.trim(),
      applicationId: input.applicationId ?? null,
      status: 'draft',
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'it_knowledge_article',
    subjectId: article.id,
    after: { recordCode },
  });
  return article;
}

export async function publishKnowledgeArticle(id: string) {
  const auth = currentAuth();
  const article = await prisma.itKnowledgeArticle.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!article) throw ApiError.notFound('Knowledge article');
  await assertCan({ resource: 'it_knowledge', verb: 'edit' });

  if (article.status === 'published') throw ApiError.conflict('Already published.');

  const updated = await prisma.$transaction(async (tx) => {
    const updated = await tx.itKnowledgeArticle.update({
      where: { id },
      data: { status: 'published', publishedAt: new Date() },
    });

    await auditWrite({
      action: 'update',
      subjectType: 'it_knowledge_article',
      subjectId: id,
      before: { status: article.status },
      after: { status: 'published' },
      tx,
    });
    await emit({
      name: EVENTS.IT_KNOWLEDGE_PUBLISHED,
      subject: { entityType: 'it_knowledge_article', entityId: id, recordCode: article.recordCode },
      newState: { status: 'published' },
      impact: { domains: [IT_DOMAIN] },
      tx,
    });
    return updated;
  });

  return updated;
}

/** A lightweight interaction, not a governed edit — anyone who can see the
 * article may say it helped. Not one-per-person (no session-level dedupe is
 * asked of it): a plain counter, and the screen says so. */
export async function markKnowledgeHelpful(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_knowledge', verb: 'view' });
  const article = await prisma.itKnowledgeArticle.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!article) throw ApiError.notFound('Knowledge article');
  if (article.status !== 'published') throw ApiError.unprocessable('Only a published article can be marked helpful.');

  return prisma.itKnowledgeArticle.update({ where: { id }, data: { helpfulCount: { increment: 1 } } });
}

// ---------------------------------------------------------------------------
// My IT
// ---------------------------------------------------------------------------

export async function myIt() {
  const auth = currentAuth();
  await assertCan({ resource: 'it_tickets', verb: 'view' });

  const tickets = await prisma.itTicket.findMany({
    where: { tenantId: auth.tenantId, OR: [{ requesterPartyId: auth.partyId! }, { assigneePartyId: auth.partyId }] },
    orderBy: { createdAt: 'desc' },
  });

  return {
    tickets: tickets.map((t) => ({
      ...t,
      availableTransitions: availableTransitions(ticketMachine, t.status as ItTicketStatus),
    })),
    // Governance (policy acknowledgements) and assets (workstream A) land in
    // their own files; My IT's web page reads /it/policies/awaiting and
    // /it/assets/mine directly once they exist, rendering "Nothing here
    // yet" until then rather than this endpoint reaching into files it does
    // not own.
    policiesAwaiting: [] as unknown[],
    assets: [] as unknown[],
    note: 'Policies awaiting acknowledgement and your assigned assets are read from the governance and assets workstreams directly; this composite only carries your tickets.',
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const OPEN_STATUSES = ['new', 'triaged', 'in_progress', 'waiting'] as const;

/**
 * Fleet-wide figures — open by priority, SLA attainment, backlog age and so
 * on are statements about every ticket, not just the caller's own. An
 * `own`-scope grant (the employee row) cannot be handed this: `V@own` was
 * meant to narrow a list to the caller's rows, and a company-wide SLA
 * attainment percentage is not narrowable row by row (the same reasoning
 * `assertScopeAll` exists for — see its own doc comment in
 * `platform/permissions.ts`). So this asks for `all` scope outright rather
 * than merely the `view` verb.
 */
export async function summary() {
  const auth = currentAuth();
  await assertScopeAll('it_tickets', 'view');

  const total = await prisma.itTicket.count({ where: { tenantId: auth.tenantId } });
  const knowledgePublished = await prisma.itKnowledgeArticle.count({
    where: { tenantId: auth.tenantId, status: 'published' },
  });

  if (total === 0) {
    return {
      notYetMeasured: true,
      openByPriority: { P1: 0, P2: 0, P3: 0, P4: 0, none: 0 },
      unassigned: 0,
      breached: 0,
      slaAttainment: { response: null as number | null, resolution: null as number | null },
      medianResolveMinutes: null as number | null,
      backlogAge: { d0_1: 0, d2_7: 0, d8_30: 0, d30plus: 0 },
      satisfactionAverage: null as number | null,
      knowledgePublished,
    };
  }

  const now = new Date();
  const openRows = await prisma.itTicket.findMany({
    where: { tenantId: auth.tenantId, status: { in: [...OPEN_STATUSES] } },
    select: { priority: true, assigneePartyId: true, createdAt: true, slaBreachNotified: true },
  });

  const openByPriority = { P1: 0, P2: 0, P3: 0, P4: 0, none: 0 };
  let unassigned = 0;
  let breached = 0;
  for (const r of openRows) {
    if (r.priority && r.priority in openByPriority) openByPriority[r.priority as ItTicketPriority] += 1;
    else openByPriority.none += 1;
    if (!r.assigneePartyId) unassigned += 1;
    if (r.slaBreachNotified.length > 0) breached += 1;
  }

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const closedThisMonth = await prisma.itTicket.findMany({
    where: {
      tenantId: auth.tenantId,
      status: { in: ['resolved', 'closed'] },
      resolvedAt: { gte: monthStart },
      respondDueAt: { not: null },
    },
    select: { firstRespondedAt: true, respondDueAt: true, resolvedAt: true, resolveDueAt: true },
  });

  const responseAttainment = slaAttainment(
    closedThisMonth
      .filter((t) => t.respondDueAt)
      .map((t) => ({ met: Boolean(t.firstRespondedAt && t.respondDueAt && t.firstRespondedAt <= t.respondDueAt) })),
  );
  const resolutionAttainment = slaAttainment(
    closedThisMonth
      .filter((t) => t.resolveDueAt)
      .map((t) => ({ met: Boolean(t.resolvedAt && t.resolveDueAt && t.resolvedAt <= t.resolveDueAt) })),
  );

  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
  const resolvedLast30 = await prisma.itTicket.findMany({
    where: { tenantId: auth.tenantId, resolvedAt: { gte: thirtyDaysAgo, not: null } },
    select: { createdAt: true, resolvedAt: true },
  });
  const resolveMinutes = resolvedLast30
    .filter((t) => t.resolvedAt)
    .map((t) => (t.resolvedAt!.getTime() - t.createdAt.getTime()) / 60_000);

  const backlogAge = backlogAgeBuckets(
    openRows.map((r) => r.createdAt),
    now,
  );

  const rated = await prisma.itTicket.findMany({
    where: { tenantId: auth.tenantId, satisfaction: { not: null } },
    select: { satisfaction: true },
  });
  const satisfactionAverage = rated.length
    ? Math.round((rated.reduce((sum, t) => sum + (t.satisfaction ?? 0), 0) / rated.length) * 10) / 10
    : null;

  return {
    notYetMeasured: false,
    openByPriority,
    unassigned,
    breached,
    slaAttainment: { response: responseAttainment, resolution: resolutionAttainment },
    medianResolveMinutes: medianMinutes(resolveMinutes),
    backlogAge,
    satisfactionAverage,
    knowledgePublished,
  };
}

export { IT_KNOWLEDGE_STATUSES };
