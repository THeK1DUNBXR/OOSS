/**
 * HCM — WS9 engagement: announcements, recognition, pulse surveys, the HR
 * helpdesk and policy acknowledgements (docs/hcm/engagement.md).
 *
 * The confidential-case concealment rule follows the POSH pattern in
 * `domains/compliance/labour.ts` verbatim: a confidential `HrCase` never
 * appears in the general queue or its counts, and reaching it takes a
 * dedicated call the caller must have the grant for — never an inference from
 * a wider listing.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  computeEnps,
  inAudience,
  isHrCaseSlaBreached,
  SURVEY_MIN_SAMPLE,
  validateSurveyAnswers,
  type Audience,
  type AudienceFacts,
  type SurveyAnswer,
  type SurveyQuestion,
} from '@kaizen/shared';
import { prisma, unscopedPrisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, assertScopeAll, scopeFor } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import type { JobResult } from '../../jobs/scheduler.js';

registerGovernedEntities('hcm_engagement', [
  'announcement',
  'recognition',
  'pulse_survey',
  'hr_case',
  'policy_document',
  'exit_interview',
]);

async function hrOpsOwnerId(tenantId: string): Promise<string | null> {
  const affiliation = await unscopedPrisma.affiliation.findFirst({
    where: { tenantId, roleSlug: 'hr_ops_manager', status: 'active' },
    select: { partyId: true },
  });
  return affiliation?.partyId ?? null;
}

/** `ENG:<entity>` sequence — a plain, human-referenced number for the entities that hold no RECORD_TYPE_CODES prefix of their own. */
async function nextEngagementNumber(entity: string): Promise<string> {
  const auth = currentAuth();
  const year = new Date().getUTCFullYear();
  const row = await prisma.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId: auth.tenantId, entityType: `ENG:${entity}`, year } },
    create: { tenantId: auth.tenantId, entityType: `ENG:${entity}`, year, nextSequence: 2 },
    update: { nextSequence: { increment: 1 } },
    select: { nextSequence: true },
  });
  return `${entity}-${year}-${String(row.nextSequence - 1).padStart(5, '0')}`;
}

/**
 * Whether the caller manages this resource (holds `edit`) — the signal used
 * to decide whether a listing shows every row (drafts, closed, superseded
 * included) or only what a reader is meant to see. Deliberately not the same
 * question as "what scope does `view` resolve to": announcements, surveys and
 * policy documents grant an ordinary employee `view` at `all` scope on
 * purpose (a broadcast has no single owner to narrow against), so scope alone
 * cannot tell a reader from a manager here the way it can for `hr_cases` or
 * `recognitions`.
 */
async function managesResource(resource: string): Promise<boolean> {
  return (await scopeFor(resource, 'edit')) !== null;
}

/**
 * Facts about a party used for audience matching — resolved from their
 * active affiliation. Division comes from the affiliation's org unit;
 * location comes from the seat (`Position.location`) the affiliation holds,
 * not from the org unit — an org unit carries no location of its own, so a
 * location-targeted announcement or survey would silently match nobody if
 * this fell back to reading it off the org unit instead.
 */
async function audienceFactsFor(tenantId: string, partyId: string | null): Promise<AudienceFacts> {
  if (!partyId) return {};
  const affiliation = await unscopedPrisma.affiliation.findFirst({
    where: { tenantId, partyId, status: 'active' },
    select: { orgUnitId: true, positionId: true },
  });
  if (!affiliation) return {};
  const [orgUnit, position] = await Promise.all([
    affiliation.orgUnitId
      ? unscopedPrisma.orgUnit.findFirst({ where: { id: affiliation.orgUnitId }, select: { division: true } })
      : null,
    affiliation.positionId
      ? unscopedPrisma.position.findFirst({ where: { id: affiliation.positionId }, select: { location: true } })
      : null,
  ]);
  return {
    orgUnitId: affiliation.orgUnitId ?? null,
    division: orgUnit?.division ?? null,
    location: position?.location ?? null,
  };
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export interface AnnouncementInput {
  title: string;
  body: string;
  audienceType?: 'all' | 'division' | 'org_unit' | 'location';
  audienceDivision?: string | null;
  audienceOrgUnitId?: string | null;
  audienceLocation?: string | null;
  publishAt?: Date;
  expiresAt?: Date | null;
  pinned?: boolean;
  acknowledgementRequired?: boolean;
  publishNow?: boolean;
}

export async function createAnnouncement(input: AnnouncementInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'announcements', verb: 'create' });
  const audienceType = input.audienceType ?? 'all';
  if (audienceType === 'division' && !input.audienceDivision) throw ApiError.badRequest('A division audience needs a division.');
  if (audienceType === 'org_unit' && !input.audienceOrgUnitId) throw ApiError.badRequest('An org-unit audience needs an org unit.');
  if (audienceType === 'location' && !input.audienceLocation) throw ApiError.badRequest('A location audience needs a location.');

  const recordCode = await nextEngagementNumber('ANN');
  const publishAt = input.publishAt ?? new Date();
  const row = await prisma.announcement.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title,
      body: input.body,
      audienceType,
      audienceDivision: input.audienceDivision ?? null,
      audienceOrgUnitId: input.audienceOrgUnitId ?? null,
      audienceLocation: input.audienceLocation ?? null,
      publishAt,
      expiresAt: input.expiresAt ?? null,
      pinned: input.pinned ?? false,
      acknowledgementRequired: input.acknowledgementRequired ?? false,
      status: input.publishNow !== false && publishAt.getTime() <= Date.now() ? 'published' : 'draft',
      createdById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'announcement', subjectId: row.id, after: row as never });
  if (row.status === 'published') await emitAnnouncementPublished(row.id, recordCode);
  return row;
}

async function emitAnnouncementPublished(id: string, recordCode: string) {
  await emit({
    name: 'kz.hr.announcement.published',
    subject: { entityType: 'announcement', entityId: id, recordCode },
    newState: { status: 'published' },
    impact: { domains: ['hr'] },
  });
}

export async function publishAnnouncement(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'announcements', verb: 'edit' });
  const row = await prisma.announcement.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Announcement');
  if (row.status === 'published') return row;
  const updated = await prisma.announcement.update({ where: { id }, data: { status: 'published', publishAt: new Date() } });
  await auditWrite({ action: 'update', subjectType: 'announcement', subjectId: id, before: { status: row.status }, after: { status: 'published' } });
  await emitAnnouncementPublished(id, row.recordCode);
  return updated;
}

export async function withdrawAnnouncement(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'announcements', verb: 'edit' });
  const row = await prisma.announcement.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Announcement');
  const updated = await prisma.announcement.update({ where: { id }, data: { status: 'withdrawn' } });
  await auditWrite({ action: 'update', subjectType: 'announcement', subjectId: id, before: { status: row.status }, after: { status: 'withdrawn' } });
  return updated;
}

/** GET /announcements. HR (all scope) sees every announcement; everyone else sees only what is currently published, unexpired and in their audience. */
export async function listAnnouncements() {
  const auth = currentAuth();
  await assertCan({ resource: 'announcements', verb: 'view' });
  const rows = await prisma.announcement.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: [{ pinned: 'desc' }, { publishAt: 'desc' }],
  });
  if (await managesResource('announcements')) return rows;

  const now = new Date();
  const facts = await audienceFactsFor(auth.tenantId, auth.partyId);
  return rows.filter(
    (r) =>
      r.status === 'published' &&
      r.publishAt.getTime() <= now.getTime() &&
      (!r.expiresAt || r.expiresAt.getTime() > now.getTime()) &&
      inAudience(r as unknown as Audience, facts),
  );
}

export async function acknowledgeAnnouncement(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'announcements', verb: 'view' });
  if (!auth.partyId) throw ApiError.badRequest('No party on this session to acknowledge as.');
  const row = await prisma.announcement.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Announcement');
  if (!row.acknowledgementRequired) throw ApiError.badRequest('This announcement does not require acknowledgement.');
  const ack = await prisma.announcementAck.upsert({
    where: { tenantId_announcementId_partyId: { tenantId: auth.tenantId, announcementId: id, partyId: auth.partyId } },
    create: { tenantId: auth.tenantId, announcementId: id, partyId: auth.partyId },
    update: {},
  });
  return ack;
}

export async function announcementAcks(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'announcements', verb: 'edit' });
  const row = await prisma.announcement.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Announcement');
  const acks = await prisma.announcementAck.findMany({ where: { tenantId: auth.tenantId, announcementId: id } });
  return { announcement: row, acks, ackCount: acks.length };
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

export interface RecognitionInput {
  toPartyId: string;
  badge: string;
  message: string;
  points?: number;
  public?: boolean;
}

export async function giveRecognition(input: RecognitionInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'recognitions', verb: 'create' });
  if (!auth.partyId) throw ApiError.badRequest('No party on this session to give recognition from.');
  if (input.toPartyId === auth.partyId) throw ApiError.badRequest('You cannot give yourself recognition.');
  if (!input.badge.trim() || !input.message.trim()) throw ApiError.badRequest('A badge and a message are both required.');

  const recordCode = await nextEngagementNumber('REC');
  const row = await prisma.recognition.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      fromPartyId: auth.partyId,
      toPartyId: input.toPartyId,
      badge: input.badge,
      message: input.message,
      points: input.points ?? 0,
      public: input.public ?? true,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'recognition', subjectId: row.id, after: row as never });
  await emit({
    name: 'kz.hr.recognition.given',
    subject: { entityType: 'recognition', entityId: row.id, recordCode },
    related: [{ relation: 'recognizes', entityType: 'person', entityId: input.toPartyId }],
    newState: { badge: row.badge, points: row.points },
    impact: { domains: ['hr'] },
  });
  return row;
}

/** GET /recognitions. HR (all scope) sees the full ledger; everyone else sees only recognitions they gave or received. */
export async function listRecognitions() {
  const auth = currentAuth();
  await assertCan({ resource: 'recognitions', verb: 'view' });
  const scope = await scopeFor('recognitions', 'view');
  const where =
    scope === 'all'
      ? { tenantId: auth.tenantId }
      : { tenantId: auth.tenantId, OR: [{ fromPartyId: auth.partyId ?? '__none__' }, { toPartyId: auth.partyId ?? '__none__' }] };
  return prisma.recognition.findMany({ where, orderBy: { createdAt: 'desc' } });
}

/** HR-only aggregate: who has received the most recognition points. An aggregate figure needs an all-scope grant, per `assertScopeAll`. */
export async function recognitionLeaderboard(limit = 10) {
  const auth = currentAuth();
  await assertScopeAll('recognitions', 'view');
  const grouped = await prisma.recognition.groupBy({
    by: ['toPartyId'],
    where: { tenantId: auth.tenantId },
    _sum: { points: true },
    _count: { _all: true },
    orderBy: { _sum: { points: 'desc' } },
    take: limit,
  });
  return grouped.map((g) => ({ toPartyId: g.toPartyId, totalPoints: g._sum.points ?? 0, count: g._count._all }));
}

// ---------------------------------------------------------------------------
// Pulse surveys
// ---------------------------------------------------------------------------

export interface PulseSurveyInput {
  title: string;
  questions: SurveyQuestion[];
  anonymous?: boolean;
  opensAt: Date;
  closesAt: Date;
  audienceType?: 'all' | 'division' | 'org_unit' | 'location';
  audienceDivision?: string | null;
  audienceOrgUnitId?: string | null;
  audienceLocation?: string | null;
}

export async function createPulseSurvey(input: PulseSurveyInput) {
  const auth = currentAuth();
  // Deliberately `edit`, not `create`: an ordinary employee holds `surveys:create`
  // too, but only so `submitSurveyResponse` lets them answer one — defining a
  // company-wide (or audience-wide) survey is a management action, gated the
  // same way `openPulseSurvey`/`closePulseSurvey` already are.
  await assertCan({ resource: 'surveys', verb: 'edit' });
  if (input.questions.length === 0) throw ApiError.badRequest('A survey needs at least one question.');
  if (input.closesAt.getTime() <= input.opensAt.getTime()) throw ApiError.badRequest('closesAt must be after opensAt.');

  const recordCode = await nextEngagementNumber('SUR');
  const row = await prisma.pulseSurvey.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title,
      questions: input.questions as never,
      anonymous: input.anonymous ?? false,
      opensAt: input.opensAt,
      closesAt: input.closesAt,
      audienceType: input.audienceType ?? 'all',
      audienceDivision: input.audienceDivision ?? null,
      audienceOrgUnitId: input.audienceOrgUnitId ?? null,
      audienceLocation: input.audienceLocation ?? null,
      status: input.opensAt.getTime() <= Date.now() ? 'open' : 'draft',
      createdById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'pulse_survey', subjectId: row.id, after: { title: row.title } });
  if (row.status === 'open') await emitSurveyOpened(row.id, recordCode);
  return row;
}

async function emitSurveyOpened(id: string, recordCode: string) {
  await emit({ name: 'kz.hr.survey.opened', subject: { entityType: 'pulse_survey', entityId: id, recordCode }, newState: { status: 'open' } });
}

export async function openPulseSurvey(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'surveys', verb: 'edit' });
  const row = await prisma.pulseSurvey.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Pulse survey');
  if (row.status !== 'draft') throw ApiError.conflict(`Survey is already ${row.status}.`);
  const updated = await prisma.pulseSurvey.update({ where: { id }, data: { status: 'open' } });
  await emitSurveyOpened(id, row.recordCode);
  return updated;
}

export async function closePulseSurvey(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'surveys', verb: 'edit' });
  const row = await prisma.pulseSurvey.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Pulse survey');
  if (row.status !== 'open') throw ApiError.conflict(`Only an open survey can be closed (this one is ${row.status}).`);
  const updated = await prisma.pulseSurvey.update({ where: { id }, data: { status: 'closed' } });
  await auditWrite({ action: 'update', subjectType: 'pulse_survey', subjectId: id, before: { status: row.status }, after: { status: 'closed' } });
  await emit({ name: 'kz.hr.survey.closed', subject: { entityType: 'pulse_survey', entityId: id, recordCode: row.recordCode }, newState: { status: 'closed' } });
  return updated;
}

export async function listPulseSurveys() {
  const auth = currentAuth();
  await assertCan({ resource: 'surveys', verb: 'view' });
  const rows = await prisma.pulseSurvey.findMany({ where: { tenantId: auth.tenantId }, orderBy: { opensAt: 'desc' } });
  if (await managesResource('surveys')) return rows;
  const facts = await audienceFactsFor(auth.tenantId, auth.partyId);
  return rows.filter((r) => r.status !== 'draft' && inAudience(r as unknown as Audience, facts));
}

/**
 * The one-way key that stops a second submission to an anonymous survey.
 * This is stored ONLY in `SurveyResponseDedupe`, a table with no other
 * column and no relation to `SurveyResponse` — so even someone who could
 * enumerate every party id in the tenant and recompute this hash (the salt
 * is a source constant, not a secret) learns only "this person responded",
 * never which row their answers landed in. `SurveyResponse.respondentToken`
 * itself is always a plain random id, uncorrelated with identity.
 */
function dedupeHash(tenantId: string, surveyId: string, partyId: string): string {
  return createHash('sha256').update(`${tenantId}:${surveyId}:${partyId}:kz-anon-survey-dedupe`).digest('hex');
}

async function alreadyRespondedAnonymously(tenantId: string, surveyId: string, partyId: string): Promise<boolean> {
  const existing = await prisma.surveyResponseDedupe.findFirst({
    where: { tenantId, surveyId, dedupeHash: dedupeHash(tenantId, surveyId, partyId) },
    select: { id: true },
  });
  return Boolean(existing);
}

export async function submitSurveyResponse(surveyId: string, employmentRelationshipId: string, answers: SurveyAnswer[]) {
  const auth = currentAuth();
  await assertCan({ resource: 'surveys', verb: 'create' });
  const survey = await prisma.pulseSurvey.findFirst({ where: { id: surveyId, tenantId: auth.tenantId } });
  if (!survey) throw ApiError.notFound('Pulse survey');
  if (survey.status !== 'open') throw ApiError.conflict(`This survey is ${survey.status}, not open.`);
  if (new Date() > survey.closesAt) throw ApiError.conflict('This survey has closed.');
  if (!auth.partyId) throw ApiError.badRequest('No party on this session to respond as.');

  // A survey's audience is enforced on the write, not merely the read — being
  // outside the targeted division/org-unit/location means the id cannot be
  // used to answer it either, the same as it cannot be used to see it.
  if (!(await managesResource('surveys'))) {
    const facts = await audienceFactsFor(auth.tenantId, auth.partyId);
    if (!inAudience(survey as unknown as Audience, facts)) throw ApiError.notFound('Pulse survey');
  }

  const problem = validateSurveyAnswers(survey.questions as unknown as SurveyQuestion[], answers);
  if (problem) throw ApiError.badRequest(problem);

  if (survey.anonymous) {
    if (await alreadyRespondedAnonymously(auth.tenantId, surveyId, auth.partyId)) {
      throw ApiError.conflict('You have already answered this survey.');
    }
    return prisma.$transaction(async (tx) => {
      try {
        await tx.surveyResponseDedupe.create({
          data: { tenantId: auth.tenantId, surveyId, dedupeHash: dedupeHash(auth.tenantId, surveyId, auth.partyId!) },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') throw ApiError.conflict('You have already answered this survey.');
        throw err;
      }
      return tx.surveyResponse.create({
        data: {
          tenantId: auth.tenantId,
          surveyId,
          employmentRelationshipId: null,
          respondentToken: randomUUID(),
          answers: answers as never,
        },
      });
    });
  }

  try {
    return await prisma.surveyResponse.create({
      data: { tenantId: auth.tenantId, surveyId, employmentRelationshipId, respondentToken: null, answers: answers as never },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw ApiError.conflict('You have already answered this survey.');
    }
    throw err;
  }
}

/** HR-only aggregate results — never a per-respondent breakdown, so an anonymous survey stays anonymous and a named one still reads as a summary rather than a transcript. */
export async function pulseSurveyResults(surveyId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'surveys', verb: 'edit' });
  const survey = await prisma.pulseSurvey.findFirst({ where: { id: surveyId, tenantId: auth.tenantId } });
  if (!survey) throw ApiError.notFound('Pulse survey');
  const responses = await prisma.surveyResponse.findMany({ where: { tenantId: auth.tenantId, surveyId } });
  const questions = survey.questions as unknown as SurveyQuestion[];

  const perQuestion = questions.map((q) => {
    const values = responses.map((r) => (r.answers as unknown as SurveyAnswer[]).find((a) => a.questionId === q.id)?.value).filter((v) => v !== undefined);
    if (q.type === 'text') {
      return { questionId: q.id, text: q.text, type: q.type, responses: values.length, answers: values as string[] };
    }
    const numbers = values.map((v) => Number(v));
    if (q.type === 'enps') {
      return { questionId: q.id, text: q.text, type: q.type, ...computeEnps(numbers) };
    }
    const average = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
    return { questionId: q.id, text: q.text, type: q.type, responses: numbers.length, average };
  });

  return { survey, totalResponses: responses.length, questions: perQuestion };
}

/** Open surveys, in the caller's audience, that they have not yet answered — for /me/home. */
export async function pendingSurveysForMe() {
  const auth = currentAuth();
  if (!auth.partyId) return [];
  const scope = await scopeFor('surveys', 'view');
  if (!scope) return [];
  const facts = await audienceFactsFor(auth.tenantId, auth.partyId);
  const employment = await prisma.employmentRelationship.findFirst({ where: { tenantId: auth.tenantId, personId: auth.partyId }, select: { id: true } });

  const open = await prisma.pulseSurvey.findMany({ where: { tenantId: auth.tenantId, status: 'open' } });
  const inMyAudience = open.filter((s) => inAudience(s as unknown as Audience, facts));
  if (inMyAudience.length === 0) return [];

  const answered = await prisma.surveyResponse.findMany({
    where: {
      tenantId: auth.tenantId,
      surveyId: { in: inMyAudience.map((s) => s.id) },
      OR: [
        { employmentRelationshipId: employment?.id ?? '__none__' },
        ...inMyAudience.map((s) => ({ respondentToken: anonymousToken(auth.tenantId, s.id, auth.partyId!) })),
      ],
    },
    select: { surveyId: true },
  });
  const answeredIds = new Set(answered.map((a) => a.surveyId));
  return inMyAudience.filter((s) => !answeredIds.has(s.id));
}

// ---------------------------------------------------------------------------
// HR helpdesk cases — the confidential-grievance concealment pattern
// ---------------------------------------------------------------------------

export const HR_CASE_STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'closed'] as const;
type HrCaseStatus = (typeof HR_CASE_STATUSES)[number];

const HR_CASE_SLA_HOURS: Record<string, number> = {
  urgent: 24,
  high: 48,
  normal: 96,
  low: 168,
};

export interface HrCaseInput {
  category: 'payroll' | 'leave' | 'policy' | 'it' | 'grievance' | 'other';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  subject: string;
  body: string;
  confidential?: boolean;
}

export async function createHrCase(input: HrCaseInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'hr_cases', verb: 'create' });
  if (!auth.partyId) throw ApiError.badRequest('No party on this session to raise a case as.');
  if (!input.subject.trim()) throw ApiError.badRequest('A case needs a subject line.');

  const priority = input.priority ?? 'normal';
  const confidential = input.category === 'grievance' ? true : (input.confidential ?? false);
  const recordCode = await nextRecordCode('CASE');
  const slaDueAt = new Date(Date.now() + (HR_CASE_SLA_HOURS[priority] ?? 96) * 3_600_000);

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.hrCase.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        category: input.category,
        priority,
        subject: input.subject,
        raisedByPartyId: auth.partyId!,
        confidential,
        slaDueAt,
      },
    });
    await tx.hrCaseMessage.create({
      data: { tenantId: auth.tenantId, caseId: created.id, authorPartyId: auth.partyId!, body: input.body },
    });
    return created;
  });

  await auditWrite({ action: 'create', subjectType: 'hr_case', subjectId: row.id, after: { category: row.category, status: row.status } });
  // A confidential case is marked `restricted` on the wire the same way a POSH
  // complaint is — the fact of its existence travels no further than the
  // event bus's own confidentiality classification lets it.
  await emit({
    name: 'kz.hr.hr_case.opened',
    subject: { entityType: 'hr_case', entityId: row.id, recordCode },
    newState: { category: confidential ? 'confidential' : row.category, status: row.status },
    confidentiality: confidential ? 'restricted' : 'internal',
    impact: { domains: ['hr'] },
  });
  return row;
}

/**
 * GET /hr-cases — the general queue. A confidential case is never in it for
 * anyone but the person who raised it, no matter how wide their grant: that is
 * the concealment rule, and it applies before scope even gets a say.
 */
export async function listHrCases() {
  const auth = currentAuth();
  await assertCan({ resource: 'hr_cases', verb: 'view' });
  const scope = await scopeFor('hr_cases', 'view');
  if (scope === 'all') {
    return prisma.hrCase.findMany({ where: { tenantId: auth.tenantId, confidential: false }, orderBy: { createdAt: 'desc' } });
  }
  return prisma.hrCase.findMany({
    where: { tenantId: auth.tenantId, raisedByPartyId: auth.partyId ?? '__none__' },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * GET /hr-cases/confidential — deliberately not folded into `listHrCases`.
 * Reaching it takes the all-scope grant explicitly; there is no inference
 * path from the general queue.
 */
export async function listConfidentialHrCases() {
  const auth = currentAuth();
  await assertScopeAll('hr_cases', 'view');
  return prisma.hrCase.findMany({ where: { tenantId: auth.tenantId, confidential: true }, orderBy: { createdAt: 'desc' } });
}

async function loadVisibleCase(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'hr_cases', verb: 'view' });
  const row = await prisma.hrCase.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('HR case');
  const scope = await scopeFor('hr_cases', 'view');
  const isParty = row.raisedByPartyId === auth.partyId || row.assigneePartyId === auth.partyId;
  // Not-found rather than forbidden for a concealed or out-of-scope case —
  // whether it exists is itself part of what is being withheld.
  if (row.confidential && !isParty && scope !== 'all') throw ApiError.notFound('HR case');
  if (!row.confidential && scope !== 'all' && !isParty) throw ApiError.notFound('HR case');
  return row;
}

export async function getHrCase(id: string) {
  const row = await loadVisibleCase(id);
  const messages = await prisma.hrCaseMessage.findMany({ where: { tenantId: row.tenantId, caseId: id }, orderBy: { createdAt: 'asc' } });
  return { case: row, messages };
}

export async function addHrCaseMessage(id: string, body: string) {
  const auth = currentAuth();
  const row = await loadVisibleCase(id);
  if (!body.trim()) throw ApiError.badRequest('A message needs a body.');
  const message = await prisma.hrCaseMessage.create({
    data: { tenantId: auth.tenantId, caseId: row.id, authorPartyId: auth.partyId ?? 'system', body },
  });
  return message;
}

export async function assignHrCase(id: string, assigneePartyId: string) {
  const auth = currentAuth();
  await assertScopeAll('hr_cases', 'edit');
  const row = await prisma.hrCase.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('HR case');
  const updated = await prisma.hrCase.update({ where: { id }, data: { assigneePartyId, status: row.status === 'open' ? 'in_progress' : row.status } });
  await auditWrite({ action: 'update', subjectType: 'hr_case', subjectId: id, before: { assigneePartyId: row.assigneePartyId }, after: { assigneePartyId } });
  return updated;
}

export async function transitionHrCase(id: string, status: HrCaseStatus, note?: string) {
  const auth = currentAuth();
  if (!HR_CASE_STATUSES.includes(status)) throw ApiError.badRequest(`"${status}" is not an HR case status.`);
  const row = await loadVisibleCase(id);
  await assertCan({ resource: 'hr_cases', verb: 'edit' });
  const scope = await scopeFor('hr_cases', 'edit');
  const isParty = row.raisedByPartyId === auth.partyId || row.assigneePartyId === auth.partyId;
  if (scope !== 'all' && !isParty) throw ApiError.notFound('HR case');

  const data: Record<string, unknown> = { status };
  if (status === 'resolved' && !row.resolvedAt) data.resolvedAt = new Date();
  if (status === 'closed' && !row.closedAt) data.closedAt = new Date();

  const updated = await prisma.hrCase.update({ where: { id }, data });
  if (note?.trim()) await prisma.hrCaseMessage.create({ data: { tenantId: auth.tenantId, caseId: id, authorPartyId: auth.partyId ?? 'system', body: note } });
  await auditWrite({ action: 'update', subjectType: 'hr_case', subjectId: id, before: { status: row.status }, after: { status } });

  if (status === 'resolved' || status === 'closed') {
    await emit({
      name: 'kz.hr.hr_case.resolved',
      subject: { entityType: 'hr_case', entityId: id, recordCode: row.recordCode },
      newState: { status },
      confidentiality: row.confidential ? 'restricted' : 'internal',
      impact: { domains: ['hr'] },
    });
  }
  return updated;
}

/** Daily job — HCM-ENGAGEMENT-*: an open case past its SLA due date raises an exception on the HR ops owner. Runs over every case, confidential included; nothing about a grievance's category leaks into the exception body. */
export async function runHrCaseSlaCheck(): Promise<JobResult> {
  const auth = currentAuth();
  const open = await prisma.hrCase.findMany({ where: { tenantId: auth.tenantId, status: { notIn: ['resolved', 'closed'] } } });
  const breached = open.filter((c) => isHrCaseSlaBreached(c.status, c.slaDueAt));

  for (const c of breached) {
    await raiseException({
      code: 'HCM_HR_CASE_SLA_BREACHED',
      label: 'HR case SLA breached',
      severity: 'S2_WARNING',
      subjectType: 'hr_case',
      subjectId: c.id,
      subjectLabel: c.recordCode,
      domain: 'hr',
      detail: `Case ${c.recordCode} is still ${c.status}, past its SLA due date of ${c.slaDueAt.toISOString().slice(0, 10)}.`,
      ownerPartyId: c.assigneePartyId ?? (await hrOpsOwnerId(auth.tenantId)),
      triggerFingerprint: `hr_case_sla:${c.id}`,
      ladderRung: 1,
    });
    await emit({
      name: 'kz.hr.hr_case.sla_breached_detected',
      subject: { entityType: 'hr_case', entityId: c.id, recordCode: c.recordCode },
      newState: { status: c.status },
      confidentiality: c.confidential ? 'restricted' : 'internal',
      severity: 'S2_WARNING',
      impact: { domains: ['hr'] },
    });
  }
  return { processed: open.length, notified: breached.length, skippedIdempotent: 0, errors: [] };
}

// ---------------------------------------------------------------------------
// Policy documents
// ---------------------------------------------------------------------------

export interface PolicyDocumentInput {
  title: string;
  version: string;
  body: string;
  effectiveFrom: Date;
  acknowledgementRequired?: boolean;
}

export async function createPolicyDocument(input: PolicyDocumentInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'policy_documents', verb: 'create' });
  const recordCode = await nextEngagementNumber('POL');
  const row = await prisma.policyDocument.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title,
      version: input.version,
      body: input.body,
      effectiveFrom: input.effectiveFrom,
      acknowledgementRequired: input.acknowledgementRequired ?? true,
      status: input.effectiveFrom.getTime() <= Date.now() ? 'published' : 'draft',
      createdById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'policy_document', subjectId: row.id, after: { title: row.title, version: row.version } });
  if (row.status === 'published') await emitPolicyPublished(row.id, recordCode);
  return row;
}

async function emitPolicyPublished(id: string, recordCode: string) {
  await emit({ name: 'kz.hr.policy_document.published', subject: { entityType: 'policy_document', entityId: id, recordCode }, newState: { status: 'published' } });
}

export async function publishPolicyDocument(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'policy_documents', verb: 'edit' });
  const row = await prisma.policyDocument.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Policy document');
  // Publishing a new version of the same title supersedes any prior published version.
  await prisma.policyDocument.updateMany({
    where: { tenantId: auth.tenantId, title: row.title, status: 'published', NOT: { id } },
    data: { status: 'superseded' },
  });
  const updated = await prisma.policyDocument.update({ where: { id }, data: { status: 'published' } });
  await auditWrite({ action: 'update', subjectType: 'policy_document', subjectId: id, before: { status: row.status }, after: { status: 'published' } });
  await emitPolicyPublished(id, row.recordCode);
  return updated;
}

export async function listPolicyDocuments() {
  const auth = currentAuth();
  await assertCan({ resource: 'policy_documents', verb: 'view' });
  const rows = await prisma.policyDocument.findMany({ where: { tenantId: auth.tenantId }, orderBy: { effectiveFrom: 'desc' } });
  return (await managesResource('policy_documents')) ? rows : rows.filter((r) => r.status === 'published');
}

export async function acknowledgePolicyDocument(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'policy_documents', verb: 'view' });
  if (!auth.partyId) throw ApiError.badRequest('No party on this session to acknowledge as.');
  const row = await prisma.policyDocument.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Policy document');
  if (row.status !== 'published') throw ApiError.conflict('Only a published policy can be acknowledged.');
  const ack = await prisma.policyAcknowledgement.upsert({
    where: { tenantId_policyDocumentId_partyId: { tenantId: auth.tenantId, policyDocumentId: id, partyId: auth.partyId } },
    create: { tenantId: auth.tenantId, policyDocumentId: id, partyId: auth.partyId },
    update: {},
  });
  await emit({
    name: 'kz.hr.policy_document.acknowledged',
    subject: { entityType: 'policy_document', entityId: id, recordCode: row.recordCode },
    newState: { partyId: auth.partyId },
  });
  return ack;
}

export async function policyAckStatus(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'policy_documents', verb: 'edit' });
  const row = await prisma.policyDocument.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Policy document');
  const acks = await prisma.policyAcknowledgement.findMany({ where: { tenantId: auth.tenantId, policyDocumentId: id } });
  return { policy: row, ackCount: acks.length };
}

/** Published, ack-required policies this caller has not yet acknowledged — for /me/home. */
export async function pendingPolicyAcksForMe() {
  const auth = currentAuth();
  if (!auth.partyId) return [];
  const published = await prisma.policyDocument.findMany({ where: { tenantId: auth.tenantId, status: 'published', acknowledgementRequired: true } });
  if (published.length === 0) return [];
  const acked = await prisma.policyAcknowledgement.findMany({
    where: { tenantId: auth.tenantId, partyId: auth.partyId, policyDocumentId: { in: published.map((p) => p.id) } },
    select: { policyDocumentId: true },
  });
  const ackedIds = new Set(acked.map((a) => a.policyDocumentId));
  return published.filter((p) => !ackedIds.has(p.id));
}

// ---------------------------------------------------------------------------
// Exit interviews
// ---------------------------------------------------------------------------

export interface ExitInterviewInput {
  offboardingId: string;
  employmentRelationshipId: string;
  questionnaire: Array<{ question: string; answer: string }>;
  themes?: string[];
}

export async function createExitInterview(input: ExitInterviewInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'exit_interviews', verb: 'create' });
  const recordCode = await nextEngagementNumber('EXI');
  const row = await prisma.exitInterview.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      offboardingId: input.offboardingId,
      employmentRelationshipId: input.employmentRelationshipId,
      questionnaire: input.questionnaire as never,
      themes: (input.themes ?? []) as never,
      conductedById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'exit_interview', subjectId: row.id, after: { employmentRelationshipId: row.employmentRelationshipId } });
  await emit({
    name: 'kz.hr.exit_interview.completed',
    subject: { entityType: 'exit_interview', entityId: row.id, recordCode },
    newState: { employmentRelationshipId: row.employmentRelationshipId },
    confidentiality: 'confidential',
    impact: { domains: ['hr'] },
  });
  return row;
}

/** HR-only — exit interviews are never visible to the person they are about. */
export async function listExitInterviews() {
  const auth = currentAuth();
  await assertScopeAll('exit_interviews', 'view');
  return prisma.exitInterview.findMany({ where: { tenantId: auth.tenantId }, orderBy: { conductedAt: 'desc' } });
}

/** HR-only aggregate: how often each theme recurs across every exit interview on file. */
export async function exitInterviewThemeSummary() {
  const auth = currentAuth();
  await assertScopeAll('exit_interviews', 'view');
  const rows = await prisma.exitInterview.findMany({ where: { tenantId: auth.tenantId }, select: { themes: true } });
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const theme of row.themes as unknown as string[]) {
      counts.set(theme, (counts.get(theme) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([theme, count]) => ({ theme, count })).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// /me/home
// ---------------------------------------------------------------------------

export async function myEngagementHome() {
  const auth = currentAuth();
  const [announcements, kudos, myCases, pendingAnnouncementAcks, pendingPolicyAcks, surveysToAnswer] = await Promise.all([
    listAnnouncements().catch(() => []),
    prisma.recognition.findMany({
      where: { tenantId: auth.tenantId, toPartyId: auth.partyId ?? '__none__' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.hrCase.findMany({
      where: { tenantId: auth.tenantId, raisedByPartyId: auth.partyId ?? '__none__', status: { notIn: ['resolved', 'closed'] } },
      orderBy: { createdAt: 'desc' },
    }),
    listAnnouncements().then((rows) =>
      filterUnacked(auth.tenantId, auth.partyId, rows.filter((r) => r.acknowledgementRequired)),
    ),
    pendingPolicyAcksForMe(),
    pendingSurveysForMe(),
  ]);

  return {
    announcements: announcements.slice(0, 10),
    kudos,
    openCases: myCases,
    pendingAcknowledgements: { announcements: pendingAnnouncementAcks, policies: pendingPolicyAcks },
    surveysToAnswer,
  };
}

async function filterUnacked<T extends { id: string }>(tenantId: string, partyId: string | null, rows: T[]): Promise<T[]> {
  if (!partyId || rows.length === 0) return [];
  const acked = await prisma.announcementAck.findMany({
    where: { tenantId, partyId, announcementId: { in: rows.map((r) => r.id) } },
    select: { announcementId: true },
  });
  const ackedIds = new Set(acked.map((a) => a.announcementId));
  return rows.filter((r) => !ackedIds.has(r.id));
}
