/**
 * Marketing automation journeys (MKT-MSG-013 through MKT-MSG-018).
 *
 * A journey is a drip sequence triggered by an event (a lead created, a form
 * submitted, an event registration, an enrolment, or joining an audience).
 * Steps are `[{delayDays, templateId, channelKey, condition?}]`, evaluated in
 * order by `tick()` — the function the scheduled job calls, and the one this
 * module's own trigger hooks (`onLeadCreated` etc) call to enrol immediately.
 */

import { z } from 'zod';
import { EVENTS, JOURNEY_TRANSITIONS, type AudienceCondition, type JourneyStatus, type JourneyStep } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { auditWrite } from '../../platform/audit.js';
import { assertCan } from '../../platform/permissions.js';
import { raiseException } from '../../platform/exceptions.js';
import { eligibleForChannel } from './preferences.js';
import { createSend, requestSend, dispatchSend } from './messaging.js';

// ============================================================================
// Types & schemas
// ============================================================================

export interface JourneyView {
  id: string;
  recordCode: string;
  name: string;
  triggerKind: string;
  status: JourneyStatus;
  steps: JourneyStep[];
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JourneyRunView {
  id: string;
  journeyId: string;
  personId: string;
  currentStep: number;
  status: string;
  nextAt: Date | null;
  startedAt: Date;
  exitedReason: string | null;
}

const AudienceConditionSchema = z.object({
  field: z.string(),
  op: z.string(),
  value: z.unknown().optional(),
});

const JourneyStepSchema = z.object({
  delayDays: z.number().int().min(0),
  templateId: z.string(),
  channelKey: z.enum(['email', 'sms', 'whatsapp']),
  condition: z
    .object({
      all: z.array(AudienceConditionSchema).optional(),
      any: z.array(AudienceConditionSchema).optional(),
    })
    .nullish(),
});

export const JourneyInputSchema = z.object({
  name: z.string().min(1).max(255),
  triggerKind: z.enum(['audience_join', 'lead_created', 'form_submitted', 'event_registered', 'enrolment', 'manual']),
  steps: z.array(JourneyStepSchema).min(1),
});
export type JourneyInput = z.infer<typeof JourneyInputSchema>;

const STUCK_OVERDUE_DAYS = 2;

// ============================================================================
// Helpers
// ============================================================================

function toJourneyView(row: {
  id: string;
  recordCode: string;
  name: string;
  triggerKind: string;
  status: string;
  steps: unknown;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): JourneyView {
  return {
    id: row.id,
    recordCode: row.recordCode,
    name: row.name,
    triggerKind: row.triggerKind,
    status: row.status as JourneyStatus,
    steps: (row.steps as JourneyStep[]) ?? [],
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRunView(row: {
  id: string;
  journeyId: string;
  personId: string;
  currentStep: number;
  status: string;
  nextAt: Date | null;
  startedAt: Date;
  exitedReason: string | null;
}): JourneyRunView {
  return {
    id: row.id,
    journeyId: row.journeyId,
    personId: row.personId,
    currentStep: row.currentStep,
    status: row.status,
    nextAt: row.nextAt,
    startedAt: row.startedAt,
    exitedReason: row.exitedReason,
  };
}

async function requireJourney(id: string) {
  const auth = currentAuth();
  const journey = await prisma.marketingJourney.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!journey) throw ApiError.notFound('Journey');
  return journey;
}

/**
 * A small, closed set of comparisons against a plain field on Person or Lead
 * — deliberately not a rule engine. Matches the AUDIENCE_RULE_OPS vocabulary
 * closely enough for a journey step's gate without importing audiences.ts.
 * `condition` is an AudienceRule: `{all: [...]}` (every condition must match)
 * or `{any: [...]}` (at least one must match).
 */
function evaluateCondition(entity: Record<string, unknown>, rule: { all?: AudienceCondition[]; any?: AudienceCondition[] }): boolean {
  if (rule.all && rule.all.length > 0) return rule.all.every((c) => evaluateOne(entity, c));
  if (rule.any && rule.any.length > 0) return rule.any.some((c) => evaluateOne(entity, c));
  return true;
}

function evaluateOne(entity: Record<string, unknown>, condition: { field: string; op: string; value?: unknown }): boolean {
  const actual = entity[condition.field];
  switch (condition.op) {
    case 'eq':
      return actual === condition.value;
    case 'ne':
      return actual !== condition.value;
    case 'gt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual > condition.value;
    case 'lt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual < condition.value;
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(actual);
    case 'contains':
      return typeof actual === 'string' && typeof condition.value === 'string' && actual.includes(condition.value);
    case 'is_null':
      return actual === null || actual === undefined;
    case 'not_null':
      return actual !== null && actual !== undefined;
    default:
      return true;
  }
}

// ============================================================================
// Journey CRUD
// ============================================================================

export async function createJourney(data: JourneyInput): Promise<JourneyView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_journeys', verb: 'create' });
  const parsed = JourneyInputSchema.parse(data);
  const recordCode = await nextRecordCode('JRN');

  const journey = await prisma.marketingJourney.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: parsed.name,
      triggerKind: parsed.triggerKind,
      steps: parsed.steps as never,
      status: 'draft',
      createdById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'marketing_journey', subjectId: journey.id, after: { recordCode, triggerKind: parsed.triggerKind } });
  return toJourneyView(journey);
}

export async function listJourneys(): Promise<JourneyView[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_journeys', verb: 'view' });
  const rows = await prisma.marketingJourney.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
  return rows.map(toJourneyView);
}

export async function loadJourney(id: string): Promise<JourneyView & { runCounts: Record<string, number> }> {
  await assertCan({ resource: 'marketing_journeys', verb: 'view' });
  const journey = await requireJourney(id);
  const grouped = await prisma.marketingJourneyRun.groupBy({ by: ['status'], where: { journeyId: id, tenantId: journey.tenantId }, _count: { _all: true } });
  const runCounts: Record<string, number> = {};
  for (const g of grouped) runCounts[g.status] = g._count._all;
  return { ...toJourneyView(journey), runCounts };
}

export async function updateJourney(id: string, data: Partial<JourneyInput>): Promise<JourneyView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_journeys', verb: 'edit' });
  const journey = await requireJourney(id);
  if (journey.status !== 'draft' && journey.status !== 'paused') {
    throw ApiError.unprocessable(`Cannot edit a journey while it is '${journey.status}'.`);
  }
  const steps = data.steps ? z.array(JourneyStepSchema).min(1).parse(data.steps) : undefined;
  const updated = await prisma.marketingJourney.update({
    where: { id },
    data: {
      name: data.name ?? journey.name,
      triggerKind: data.triggerKind ?? journey.triggerKind,
      steps: (steps as never) ?? journey.steps,
      updatedById: auth.partyId,
    },
  });
  return toJourneyView(updated);
}

async function transitionJourney(id: string, to: JourneyStatus, eventName: string): Promise<JourneyView> {
  const auth = currentAuth();
  const journey = await requireJourney(id);
  if (!JOURNEY_TRANSITIONS[journey.status as JourneyStatus]?.includes(to)) {
    throw ApiError.unprocessable(`Cannot move a journey from '${journey.status}' to '${to}'.`);
  }
  const updated = await prisma.marketingJourney.update({ where: { id }, data: { status: to, updatedById: auth.partyId } });
  await emit({
    name: eventName,
    subject: { entityType: 'marketing_journey', entityId: id, recordCode: journey.recordCode },
    previousState: { status: journey.status },
    newState: { status: to },
  });
  return toJourneyView(updated);
}

export async function activateJourney(id: string): Promise<JourneyView> {
  await assertCan({ resource: 'marketing_journeys', verb: 'edit' });
  return transitionJourney(id, 'active', EVENTS.MKT_JOURNEY_ACTIVATED);
}

export async function pauseJourney(id: string): Promise<JourneyView> {
  await assertCan({ resource: 'marketing_journeys', verb: 'edit' });
  return transitionJourney(id, 'paused', EVENTS.MKT_JOURNEY_PAUSED);
}

export async function resumeJourney(id: string): Promise<JourneyView> {
  await assertCan({ resource: 'marketing_journeys', verb: 'edit' });
  return transitionJourney(id, 'active', EVENTS.MKT_JOURNEY_ACTIVATED);
}

export async function retireJourney(id: string): Promise<JourneyView> {
  await assertCan({ resource: 'marketing_journeys', verb: 'edit' });
  return transitionJourney(id, 'retired', EVENTS.MKT_JOURNEY_RETIRED);
}

export async function listJourneyRuns(journeyId: string, opts: { status?: string } = {}): Promise<JourneyRunView[]> {
  await assertCan({ resource: 'marketing_journeys', verb: 'view' });
  const journey = await requireJourney(journeyId);
  const rows = await prisma.marketingJourneyRun.findMany({
    where: { journeyId: journey.id, tenantId: journey.tenantId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { startedAt: 'desc' },
  });
  return rows.map(toRunView);
}

// ============================================================================
// Runs
// ============================================================================

export async function enrolPerson(journeyId: string, personId: string): Promise<JourneyRunView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_journeys', verb: 'edit' });
  const journey = await requireJourney(journeyId);
  if (journey.status !== 'active') {
    throw ApiError.unprocessable(`Cannot enrol into a journey that is '${journey.status}', not 'active'.`);
  }

  const existing = await prisma.marketingJourneyRun.findFirst({
    where: { tenantId: auth.tenantId, journeyId, personId, status: 'active' },
  });
  if (existing) return toRunView(existing);

  const steps = (journey.steps as unknown as JourneyStep[]) ?? [];
  const step0 = steps[0];
  const nextAt = step0 ? new Date(Date.now() + step0.delayDays * 86_400_000) : null;
  const recordCode = await nextRecordCode('JRN');

  const run = await prisma.marketingJourneyRun.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      journeyId,
      personId,
      currentStep: 0,
      status: 'active',
      nextAt,
    },
  });
  await emit({
    name: EVENTS.MKT_JOURNEY_RUN_STARTED,
    subject: { entityType: 'marketing_journey_run', entityId: run.id, recordCode },
    related: [{ relation: 'journey', entityType: 'marketing_journey', entityId: journeyId }, { relation: 'person', entityType: 'person', entityId: personId }],
    newState: { currentStep: 0, nextAt: nextAt?.toISOString() ?? null },
  });
  return toRunView(run);
}

export async function exitRun(runId: string, reason: string): Promise<JourneyRunView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_journeys', verb: 'edit' });
  const run = await prisma.marketingJourneyRun.findFirst({ where: { id: runId, tenantId: auth.tenantId } });
  if (!run) throw ApiError.notFound('Journey run');
  const updated = await prisma.marketingJourneyRun.update({
    where: { id: runId },
    data: { status: 'exited', exitedReason: reason },
  });
  await emit({
    name: EVENTS.MKT_JOURNEY_RUN_EXITED,
    subject: { entityType: 'marketing_journey_run', entityId: runId },
    newState: { status: 'exited', exitedReason: reason },
  });
  return toRunView(updated);
}

/** Advances every due run. What the scheduled job calls. */
export async function tick(): Promise<{ advanced: number; completed: number; exited: number }> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_journeys', verb: 'edit' });

  const due = await prisma.marketingJourneyRun.findMany({
    where: { tenantId: auth.tenantId, status: 'active', nextAt: { lte: new Date() } },
    take: 500,
  });

  let advanced = 0;
  let completed = 0;
  let exited = 0;

  for (const run of due) {
    const journey = await prisma.marketingJourney.findFirst({ where: { id: run.journeyId, tenantId: auth.tenantId } });
    if (!journey || journey.status !== 'active') continue;

    const steps = (journey.steps as unknown as JourneyStep[]) ?? [];
    const step = steps[run.currentStep];
    if (!step) {
      await prisma.marketingJourneyRun.update({ where: { id: run.id }, data: { status: 'completed', nextAt: null } });
      await emit({ name: EVENTS.MKT_JOURNEY_RUN_COMPLETED, subject: { entityType: 'marketing_journey_run', entityId: run.id }, newState: { status: 'completed' } });
      completed += 1;
      continue;
    }

    if (step.condition) {
      const person = await prisma.person.findFirst({ where: { id: run.personId, tenantId: auth.tenantId } });
      const lead = await prisma.lead.findFirst({ where: { tenantId: auth.tenantId, personId: run.personId }, orderBy: { createdAt: 'desc' } });
      const entity: Record<string, unknown> = { ...(person ?? {}), ...(lead ?? {}) };
      if (!evaluateCondition(entity, step.condition)) {
        await prisma.marketingJourneyRun.update({ where: { id: run.id }, data: { status: 'exited', exitedReason: 'condition_not_met', nextAt: null } });
        await emit({ name: EVENTS.MKT_JOURNEY_RUN_EXITED, subject: { entityType: 'marketing_journey_run', entityId: run.id }, newState: { status: 'exited', exitedReason: 'condition_not_met' } });
        exited += 1;
        continue;
      }
    }

    const { eligible } = await eligibleForChannel([run.personId], step.channelKey);
    if (eligible.length === 0) {
      await prisma.marketingJourneyRun.update({ where: { id: run.id }, data: { status: 'exited', exitedReason: 'no_consent', nextAt: null } });
      await emit({ name: EVENTS.MKT_JOURNEY_RUN_EXITED, subject: { entityType: 'marketing_journey_run', entityId: run.id }, newState: { status: 'exited', exitedReason: 'no_consent' } });
      exited += 1;
      continue;
    }

    try {
      const send = await createSend({ templateId: step.templateId, channelKey: step.channelKey, personIds: [run.personId] });
      // A one-recipient journey step send skips the approval gate entirely
      // (it is never over the batch-approval threshold) — request then
      // dispatch it in the same tick, exactly like the scheduled job would.
      await requestSend(send.id);
      const requested = await prisma.marketingSend.findFirst({ where: { id: send.id } });
      if (requested?.status === 'queued') {
        await dispatchSend(send.id);
      }
    } catch {
      // A blocked send (unapproved template, unconfigured adapter) exits the
      // run rather than crashing the whole tick batch — the underlying
      // exception (EX-MKT-009/EX-MKT-011) has already been raised by createSend/requestSend.
      await prisma.marketingJourneyRun.update({ where: { id: run.id }, data: { status: 'exited', exitedReason: 'send_failed', nextAt: null } });
      await emit({ name: EVENTS.MKT_JOURNEY_RUN_EXITED, subject: { entityType: 'marketing_journey_run', entityId: run.id }, newState: { status: 'exited', exitedReason: 'send_failed' } });
      exited += 1;
      continue;
    }

    const nextStep = steps[run.currentStep + 1];
    const nextAt = nextStep ? new Date(Date.now() + nextStep.delayDays * 86_400_000) : null;
    const nextStatus = nextStep ? 'active' : 'completed';

    await prisma.marketingJourneyRun.update({
      where: { id: run.id },
      data: { currentStep: run.currentStep + 1, nextAt, status: nextStatus },
    });
    await emit({
      name: nextStep ? EVENTS.MKT_JOURNEY_RUN_ADVANCED : EVENTS.MKT_JOURNEY_RUN_COMPLETED,
      subject: { entityType: 'marketing_journey_run', entityId: run.id },
      newState: { currentStep: run.currentStep + 1, nextAt: nextAt?.toISOString() ?? null, status: nextStatus },
    });
    if (nextStep) advanced += 1;
    else completed += 1;
  }

  return { advanced, completed, exited };
}

/** EX-MKT-015: a run overdue on nextAt by more than 2 days. */
export async function detectStuckRuns(): Promise<number> {
  const auth = currentAuth();
  const cutoff = new Date(Date.now() - STUCK_OVERDUE_DAYS * 86_400_000);
  const stuck = await prisma.marketingJourneyRun.findMany({
    where: { tenantId: auth.tenantId, status: 'active', nextAt: { lt: cutoff } },
    take: 200,
  });
  for (const run of stuck) {
    await raiseException({
      code: 'EX-MKT-015',
      label: 'Journey run stuck (nextAt overdue by 2 days)',
      severity: 'S1_ATTENTION',
      subjectType: 'marketing_journey_run',
      subjectId: run.id,
      subjectLabel: run.recordCode,
      detail: `Run has been overdue on nextAt since ${run.nextAt?.toISOString()}.`,
      triggerFingerprint: `mkt_journey_run_stuck:${run.id}`,
    });
  }
  return stuck.length;
}

// ============================================================================
// Trigger hooks — the integration agent wires these to real events.
// ============================================================================

async function enrolIntoTriggered(triggerKind: string, personId: string): Promise<void> {
  const auth = currentAuth();
  const journeys = await prisma.marketingJourney.findMany({ where: { tenantId: auth.tenantId, triggerKind, status: 'active' } });
  for (const journey of journeys) {
    await enrolPerson(journey.id, personId);
  }
}

export async function onLeadCreated(leadId: string): Promise<void> {
  const auth = currentAuth();
  const lead = await prisma.lead.findFirst({ where: { id: leadId, tenantId: auth.tenantId } });
  if (!lead?.personId) return;
  await enrolIntoTriggered('lead_created', lead.personId);
}

export async function onFormSubmitted(personId: string): Promise<void> {
  await enrolIntoTriggered('form_submitted', personId);
}

export async function onEventRegistered(personId: string): Promise<void> {
  await enrolIntoTriggered('event_registered', personId);
}

export async function onEnrolment(personId: string): Promise<void> {
  await enrolIntoTriggered('enrolment', personId);
}
