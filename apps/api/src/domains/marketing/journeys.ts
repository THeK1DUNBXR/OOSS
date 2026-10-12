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
import type { Prisma } from '@prisma/client';
import {
  EVENTS,
  JOURNEY_TRANSITIONS,
  type AudienceCondition,
  type JourneyStatus,
  type JourneyStep,
} from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { governedWrite } from '../../platform/governedWrite.js';
import { assertCan } from '../../platform/permissions.js';
import { raiseException } from '../../platform/exceptions.js';
import { eligibleForChannel } from './preferences.js';
import { createSend, requestSend, dispatchSend } from './messaging.js';

// ============================================================================
// Types & schemas
// ============================================================================

registerGovernedEntities('mkt', ['marketing_journey', 'marketing_journey_run']);

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
function evaluateCondition(
  entity: Record<string, unknown>,
  rule: { all?: AudienceCondition[]; any?: AudienceCondition[] },
): boolean {
  if (rule.all && rule.all.length > 0) return rule.all.every((c) => evaluateOne(entity, c));
  if (rule.any && rule.any.length > 0) return rule.any.some((c) => evaluateOne(entity, c));
  return true;
}

function evaluateOne(
  entity: Record<string, unknown>,
  condition: { field: string; op: string; value?: unknown },
): boolean {
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
  await auditWrite({
    action: 'create',
    subjectType: 'marketing_journey',
    subjectId: journey.id,
    after: { recordCode, triggerKind: parsed.triggerKind },
  });
  return toJourneyView(journey);
}

export async function listJourneys(): Promise<JourneyView[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_journeys', verb: 'view' });
  const rows = await prisma.marketingJourney.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toJourneyView);
}

export async function loadJourney(id: string): Promise<JourneyView & { runCounts: Record<string, number> }> {
  await assertCan({ resource: 'marketing_journeys', verb: 'view' });
  const journey = await requireJourney(id);
  const grouped = await prisma.marketingJourneyRun.groupBy({
    by: ['status'],
    where: { journeyId: id, tenantId: journey.tenantId },
    _count: { _all: true },
  });
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
  const updated = await governedWrite(async (tx) => {
    const row = await tx.marketingJourney.update({
      where: { id },
      data: {
        name: data.name ?? journey.name,
        triggerKind: data.triggerKind ?? journey.triggerKind,
        steps: (steps as never) ?? journey.steps,
        updatedById: auth.partyId,
      },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'marketing_journey',
      subjectId: id,
      before: { name: journey.name, triggerKind: journey.triggerKind },
      after: { name: row.name, triggerKind: row.triggerKind },
      tx,
    });
    await emit({
      name: EVENTS.MKT_JOURNEY_UPDATED,
      subject: { entityType: 'marketing_journey', entityId: id, recordCode: journey.recordCode },
      previousState: { name: journey.name },
      newState: { name: row.name },
      tx,
    });
    return row;
  });
  return toJourneyView(updated);
}

async function transitionJourney(id: string, to: JourneyStatus, eventName: string): Promise<JourneyView> {
  const auth = currentAuth();
  const journey = await requireJourney(id);
  if (!JOURNEY_TRANSITIONS[journey.status as JourneyStatus]?.includes(to)) {
    throw ApiError.unprocessable(`Cannot move a journey from '${journey.status}' to '${to}'.`);
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.marketingJourney.update({
      where: { id },
      data: { status: to, updatedById: auth.partyId },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'marketing_journey',
      subjectId: id,
      before: { status: journey.status },
      after: { status: to },
      tx,
    });
    await emit({
      name: eventName,
      subject: { entityType: 'marketing_journey', entityId: id, recordCode: journey.recordCode },
      previousState: { status: journey.status },
      newState: { status: to },
      tx,
    });
    return row;
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
  const run = await prisma.$transaction(async (tx) => {
    const recordCode = await nextRecordCode('JRN', new Date(), tx);
    const created = await tx.marketingJourneyRun.create({
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
    await auditWrite({
      action: 'create',
      subjectType: 'marketing_journey_run',
      subjectId: created.id,
      after: { journeyId, personId, currentStep: 0, status: 'active' },
      tx,
    });
    await emit({
      name: EVENTS.MKT_JOURNEY_RUN_STARTED,
      subject: { entityType: 'marketing_journey_run', entityId: created.id, recordCode },
      related: [
        { relation: 'journey', entityType: 'marketing_journey', entityId: journeyId },
        { relation: 'person', entityType: 'person', entityId: personId },
      ],
      newState: { currentStep: 0, nextAt: nextAt?.toISOString() ?? null },
      tx,
    });
    return created;
  });
  return toRunView(run);
}

/**
 * A run's state change, its audit row and its event, committed together, so a
 * run never moves without the event that says it moved. Each call is its own
 * transaction: a tick over many due runs must not hold one lock across all of them.
 */
async function commitRunChange(change: {
  runId: string;
  before: Record<string, unknown>;
  data: Prisma.MarketingJourneyRunUncheckedUpdateInput;
  eventName: string;
  newState: Record<string, unknown>;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.marketingJourneyRun.update({ where: { id: change.runId }, data: change.data });
    await auditWrite({
      action: 'update',
      subjectType: 'marketing_journey_run',
      subjectId: change.runId,
      before: change.before,
      after: change.newState,
      tx,
    });
    await emit({
      name: change.eventName,
      subject: { entityType: 'marketing_journey_run', entityId: change.runId },
      newState: change.newState,
      tx,
    });
  });
}

export async function exitRun(runId: string, reason: string): Promise<JourneyRunView> {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_journeys', verb: 'edit' });
  const run = await prisma.marketingJourneyRun.findFirst({ where: { id: runId, tenantId: auth.tenantId } });
  if (!run) throw ApiError.notFound('Journey run');
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.marketingJourneyRun.update({
      where: { id: runId },
      data: { status: 'exited', exitedReason: reason },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'marketing_journey_run',
      subjectId: runId,
      before: { status: run.status },
      after: { status: 'exited', exitedReason: reason },
      tx,
    });
    await emit({
      name: EVENTS.MKT_JOURNEY_RUN_EXITED,
      subject: { entityType: 'marketing_journey_run', entityId: runId },
      newState: { status: 'exited', exitedReason: reason },
      tx,
    });
    return row;
  });
  return toRunView(updated);
}

/**
 * A run's conditional change: the update, its audit row and its event commit in
 * one transaction, and only if no other tick has moved the run since this one
 * read it. The guard is the step this tick read, so an overlapping tick that got
 * there first matches nothing and writes nothing, and each event is written once.
 * Returns false when the claim was lost.
 */
async function claimRunChange(
  run: { id: string; status: string; currentStep: number },
  tenantId: string,
  change: {
    data: Prisma.MarketingJourneyRunUncheckedUpdateManyInput;
    before: Record<string, unknown>;
    eventName: string;
    newState: Record<string, unknown>;
  },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.marketingJourneyRun.updateMany({
      where: { id: run.id, tenantId, status: 'active', currentStep: run.currentStep },
      data: change.data,
    });
    if (count === 0) return false;
    await auditWrite({
      action: 'update',
      subjectType: 'marketing_journey_run',
      subjectId: run.id,
      before: change.before,
      after: change.newState,
      tx,
    });
    await emit({
      name: change.eventName,
      subject: { entityType: 'marketing_journey_run', entityId: run.id },
      newState: change.newState,
      tx,
    });
    return true;
  });
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
      const won = await claimRunChange(run, auth.tenantId, {
        data: { status: 'completed', nextAt: null },
        before: { status: run.status },
        eventName: EVENTS.MKT_JOURNEY_RUN_COMPLETED,
        newState: { status: 'completed' },
      });
      if (!won) continue;
      completed += 1;
      continue;
    }

    if (step.condition) {
      const person = await prisma.person.findFirst({ where: { id: run.personId, tenantId: auth.tenantId } });
      const lead = await prisma.lead.findFirst({
        where: { tenantId: auth.tenantId, personId: run.personId },
        orderBy: { createdAt: 'desc' },
      });
      const entity: Record<string, unknown> = { ...(person ?? {}), ...(lead ?? {}) };
      if (!evaluateCondition(entity, step.condition)) {
        const won = await claimRunChange(run, auth.tenantId, {
          data: { status: 'exited', exitedReason: 'condition_not_met', nextAt: null },
          before: { status: run.status },
          eventName: EVENTS.MKT_JOURNEY_RUN_EXITED,
          newState: { status: 'exited', exitedReason: 'condition_not_met' },
        });
        if (!won) continue;
        exited += 1;
        continue;
      }
    }

    const { eligible } = await eligibleForChannel([run.personId], step.channelKey);
    if (eligible.length === 0) {
      const won = await claimRunChange(run, auth.tenantId, {
        data: { status: 'exited', exitedReason: 'no_consent', nextAt: null },
        before: { status: run.status },
        eventName: EVENTS.MKT_JOURNEY_RUN_EXITED,
        newState: { status: 'exited', exitedReason: 'no_consent' },
      });
      if (!won) continue;
      exited += 1;
      continue;
    }

    // Advance the run past this step before sending, and only if no other tick
    // has done so. Advancing after the send let a retry, or an overlapping tick,
    // read the same step as due and send it again. The trade-off is explicit:
    // a crash between this claim and the send skips the step rather than
    // duplicating it, because a repeated customer message is the worse failure.
    const nextStep = steps[run.currentStep + 1];
    const nextAt = nextStep ? new Date(Date.now() + nextStep.delayDays * 86_400_000) : null;
    const nextStatus = nextStep ? 'active' : 'completed';

    const won = await claimRunChange(run, auth.tenantId, {
      data: { currentStep: run.currentStep + 1, nextAt, status: nextStatus },
      before: { status: run.status, currentStep: run.currentStep },
      eventName: nextStep ? EVENTS.MKT_JOURNEY_RUN_ADVANCED : EVENTS.MKT_JOURNEY_RUN_COMPLETED,
      newState: { currentStep: run.currentStep + 1, nextAt: nextAt?.toISOString() ?? null, status: nextStatus },
    });
    if (!won) continue;

    try {
      const send = await createSend({
        templateId: step.templateId,
        channelKey: step.channelKey,
        personIds: [run.personId],
      });
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
      // Unguarded: the claim above already moved the step, so the run is the
      // one this tick advanced and it is exited here.
      await commitRunChange({
        runId: run.id,
        before: { status: run.status },
        data: { status: 'exited', exitedReason: 'send_failed', nextAt: null },
        eventName: EVENTS.MKT_JOURNEY_RUN_EXITED,
        newState: { status: 'exited', exitedReason: 'send_failed' },
      });
      exited += 1;
      continue;
    }

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
  const journeys = await prisma.marketingJourney.findMany({
    where: { tenantId: auth.tenantId, triggerKind, status: 'active' },
  });
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
