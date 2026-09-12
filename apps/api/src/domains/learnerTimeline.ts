/**
 * What has gone on with this student.
 *
 * The question has an obvious answer and the platform could not give it.
 * Attendance said whether somebody turned up, on its own screen. DAILY_PROGRESS
 * existed in the schema with no endpoint that wrote to it or read it. Anything
 * that was neither — a question asked after class, a complaint about the trainer,
 * praise worth repeating to the next cohort — had nowhere to go, so it lived in
 * somebody's memory and left with them.
 *
 * This file is the day-by-day record, and it is deliberately one read.
 * Attendance, progress and the four kinds of log entry are separate models
 * because they are separate facts with separate rules, and they are one timeline
 * because that is the only form in which they answer the question. A screen that
 * shows three lists side by side makes the reader do the merge, and the reader
 * does it wrong.
 *
 * Queries and issues open and stay open. That is the second point of the file:
 * a complaint nobody closed is work, and work that is not countable is work that
 * does not get done. Feedback and notes are closed the moment they are written,
 * because there is nothing to do about them.
 */

import {
  EVENTS,
  LEARNER_LOG_KINDS,
  LEARNER_LOG_KINDS_NEEDING_CLOSURE,
  type LearnerLogKind,
  type LearnerLogSeverity,
} from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { ApiError } from '../platform/errors.js';
import { assertCan } from '../platform/permissions.js';
import { auditWrite } from '../platform/audit.js';
import { raiseException } from '../platform/exceptions.js';

/**
 * Loads the enrolment and applies the batch narrowing.
 *
 * The trainer scoping is the grant's `batch_member` resolver, evaluated by the
 * same evaluator as everything else — so a trainer reaches the timelines of the
 * students they teach, and a role that should see all of them says so in the
 * matrix rather than in an `if` here.
 */
async function enrolmentFor(enrollmentId: string, verb: 'view' | 'edit' | 'create') {
  const auth = currentAuth();
  const enrollment = await prisma.enrollment.findFirst({
    where: { id: enrollmentId, tenantId: auth.tenantId },
    include: { cohort: { include: { course: { select: { name: true, code: true } } } } },
  });
  if (!enrollment) throw ApiError.notFound('Enrollment');

  await assertCan({
    resource: 'education',
    verb,
    record: { trainerPartyId: enrollment.cohort.trainerPartyId },
    // A timeline carries complaints and, for a minor, things said about a child.
    // It is not internal-by-default data.
    classification: enrollment.isMinor ? 'restricted' : 'confidential',
  });
  return enrollment;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface LearnerLogInput {
  kind: LearnerLogKind;
  title: string;
  detail?: string | null;
  entryDate?: Date;
  severity?: LearnerLogSeverity | null;
  rating?: number | null;
}

export async function recordLearnerLog(enrollmentId: string, input: LearnerLogInput) {
  const auth = currentAuth();
  const enrollment = await enrolmentFor(enrollmentId, 'create');

  if (!LEARNER_LOG_KINDS.includes(input.kind)) {
    throw ApiError.badRequest(`'${input.kind}' is not a kind of timeline entry. It is a query, feedback, an issue or a note.`);
  }
  if (!input.title.trim()) {
    throw ApiError.badRequest('A timeline entry needs a one-line summary, so the timeline can be read without opening every row.');
  }
  if (input.rating !== undefined && input.rating !== null) {
    if (input.kind !== 'feedback') {
      throw ApiError.badRequest('A rating belongs to feedback. A query or an issue is not scored out of five.');
    }
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw ApiError.badRequest('A rating is a whole number from 1 to 5.');
    }
  }

  const entryDate = input.entryDate ?? new Date();
  // Something recorded as having happened next week is a typo every time, and it
  // sorts to the top of the timeline forever.
  if (entryDate.getTime() > Date.now() + 86_400_000) {
    throw ApiError.badRequest('A timeline entry cannot be dated in the future.');
  }

  // A query and an issue open; feedback and a note are complete as written.
  const needsClosure = LEARNER_LOG_KINDS_NEEDING_CLOSURE.includes(input.kind);

  const log = await prisma.learnerLog.create({
    data: {
      tenantId: auth.tenantId,
      enrollmentId,
      entryDate,
      kind: input.kind,
      title: input.title.trim(),
      detail: input.detail ?? null,
      severity: input.severity ?? (needsClosure ? 'medium' : null),
      rating: input.rating ?? null,
      status: needsClosure ? 'open' : 'resolved',
      resolvedAt: needsClosure ? null : entryDate,
      recordedById: auth.partyId,
    },
  });

  await auditWrite({
    action: 'create',
    subjectType: 'learner_log',
    subjectId: log.id,
    after: { kind: log.kind, title: log.title, enrollment: enrollment.recordCode },
  });

  // A high-severity issue is raised into the attention queue rather than left on
  // a page somebody has to think to open. That is what the exception ladder is
  // for, and a student's complaint is exactly the class of thing that gets lost
  // without it.
  if (input.kind === 'issue' && (input.severity ?? 'medium') === 'high') {
    await raiseException({
      code: 'EX-EDU-002',
      label: 'Learner issue raised',
      severity: 'S3_HIGH_RISK',
      subjectType: 'enrollment',
      subjectId: enrollmentId,
      subjectLabel: enrollment.recordCode,
      domain: 'edu',
      detail: `${log.title} — on ${enrollment.cohort.course.name}, ${enrollment.cohort.name}.`,
      ownerPartyId: enrollment.cohort.trainerPartyId,
      // The fingerprint makes re-recording the same issue idempotent. A second,
      // different complaint on the same student escalates the open exception
      // rather than opening another — which is the ladder's own behaviour and the
      // right one here: a student with two live complaints is one thing somebody
      // has to go and deal with, not two queue entries.
      triggerFingerprint: `learner_issue:${log.id}`,
      ladderRung: 1,
    });
  }

  await emit({
    name: EVENTS.LEARNER_LOG_RECORDED,
    subject: { entityType: 'learner_log', entityId: log.id },
    related: [{ relation: 'about', entityType: 'enrollment', entityId: enrollmentId }],
    // The detail is deliberately not in the event body. An event log is a wider
    // audience than the record, and the body of a complaint is not for it.
    newState: { kind: log.kind, severity: log.severity, status: log.status, rating: log.rating },
    owner: { partyId: enrollment.personId },
    confidentiality: enrollment.isMinor ? 'restricted' : 'internal',
    impact: { domains: ['edu'] },
  });

  return log;
}

export async function resolveLearnerLog(
  logId: string,
  input: { status?: 'in_progress' | 'resolved'; resolutionNote?: string | null },
) {
  const auth = currentAuth();
  const log = await prisma.learnerLog.findFirst({ where: { id: logId, tenantId: auth.tenantId } });
  if (!log) throw ApiError.notFound('Timeline entry');
  await enrolmentFor(log.enrollmentId, 'edit');

  const status = input.status ?? 'resolved';
  if (log.status === 'resolved' && status === 'resolved') return log;

  const updated = await prisma.learnerLog.update({
    where: { id: logId },
    data: {
      status,
      resolutionNote: input.resolutionNote ?? log.resolutionNote,
      ...(status === 'resolved'
        ? { resolvedAt: new Date(), resolvedById: auth.partyId }
        : { resolvedAt: null, resolvedById: null }),
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'learner_log',
    subjectId: logId,
    before: { status: log.status },
    after: { status, resolutionNote: updated.resolutionNote },
  });
  if (status === 'resolved') {
    await emit({
      name: EVENTS.LEARNER_LOG_RESOLVED,
      subject: { entityType: 'learner_log', entityId: logId },
      related: [{ relation: 'about', entityType: 'enrollment', entityId: log.enrollmentId }],
      newState: { kind: log.kind, status },
      impact: { domains: ['edu'] },
    });
  }
  return updated;
}

/**
 * A day's progress on the programme.
 *
 * DAILY_PROGRESS has been in the schema since the beginning with nothing writing
 * to it, which is the same as not existing. One row per student per day: the
 * upsert is on that pair, so correcting a score is a correction rather than a
 * second row disagreeing with the first.
 */
export async function recordDailyProgress(
  enrollmentId: string,
  input: { progressDate?: Date; score?: number | null; note?: string | null },
) {
  const auth = currentAuth();
  const enrollment = await enrolmentFor(enrollmentId, 'edit');
  const progressDate = startOfDay(input.progressDate ?? new Date());

  if (input.score !== undefined && input.score !== null) {
    if (!Number.isInteger(input.score) || input.score < 0 || input.score > 100) {
      throw ApiError.badRequest('A daily score is a whole number from 0 to 100.');
    }
  }

  const existing = await prisma.dailyProgress.findFirst({
    where: { tenantId: auth.tenantId, enrollmentId, progressDate },
  });

  const row = existing
    ? await prisma.dailyProgress.update({
        where: { id: existing.id },
        data: {
          score: input.score ?? existing.score,
          note: input.note ?? existing.note,
          recordedById: auth.partyId,
        },
      })
    : await prisma.dailyProgress.create({
        data: {
          tenantId: auth.tenantId,
          enrollmentId,
          progressDate,
          score: input.score ?? null,
          note: input.note ?? null,
          recordedById: auth.partyId,
        },
      });

  // The enrolment's headline progress is the mean of the scores recorded, never
  // a field somebody keeps up to date by hand — the same rule attendance already
  // follows, for the same reason.
  const scored = await prisma.dailyProgress.findMany({
    where: { tenantId: auth.tenantId, enrollmentId, score: { not: null } },
    select: { score: true },
  });
  if (scored.length) {
    const mean = Math.round(scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length);
    await prisma.enrollment.update({ where: { id: enrollmentId }, data: { progressPct: mean } });
  }

  await emit({
    name: EVENTS.PROGRESS_RECORDED,
    subject: { entityType: 'daily_progress', entityId: row.id },
    related: [{ relation: 'for', entityType: 'enrollment', entityId: enrollmentId }],
    newState: { score: row.score, progressDate: progressDate.toISOString().slice(0, 10) },
    owner: { partyId: enrollment.personId },
    impact: { domains: ['edu'] },
  });

  return row;
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  id: string;
  kind: string;
  at: string;
  day: string;
  title: string;
  detail: string | null;
  status: string | null;
  severity: string | null;
  rating: number | null;
  score: number | null;
  recordedById: string | null;
  recordedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

/**
 * One student, in order, newest first.
 *
 * Merged on the server rather than in the browser: the client cannot be the
 * place the merge lives, because two clients would then merge differently and
 * the answer to "what happened on the 14th" would depend on which screen you
 * asked. The grouping by day is part of the answer rather than a rendering
 * choice — a student's record is read a day at a time.
 */
export async function learnerTimeline(
  enrollmentId: string,
  options: { limit?: number; kinds?: string[] } = {},
) {
  const auth = currentAuth();
  const enrollment = await enrolmentFor(enrollmentId, 'view');
  const wanted = options.kinds?.length ? new Set(options.kinds) : null;
  const take = options.limit ?? 400;

  const [attendance, progress, logs, person] = await Promise.all([
    prisma.attendance.findMany({
      where: { tenantId: auth.tenantId, enrollmentId },
      orderBy: { sessionDate: 'desc' },
      take,
    }),
    prisma.dailyProgress.findMany({
      where: { tenantId: auth.tenantId, enrollmentId },
      orderBy: { progressDate: 'desc' },
      take,
    }),
    prisma.learnerLog.findMany({
      where: { tenantId: auth.tenantId, enrollmentId },
      orderBy: { entryDate: 'desc' },
      take,
    }),
    prisma.person.findFirst({
      where: { id: enrollment.personId },
      select: { id: true, fullName: true, recordCode: true, primaryPhone: true, primaryEmail: true },
    }),
  ]);

  const actorIds = [
    ...new Set(
      [
        ...attendance.map((a) => a.recordedById),
        ...progress.map((p) => p.recordedById),
        ...logs.map((l) => l.recordedById),
        ...logs.map((l) => l.resolvedById),
      ].filter(Boolean) as string[],
    ),
  ];
  const actors = actorIds.length
    ? await prisma.person.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } })
    : [];
  const actorName = new Map(actors.map((a) => [a.id, a.fullName]));

  const entries: TimelineEntry[] = [];

  for (const a of attendance) {
    if (wanted && !wanted.has('attendance')) break;
    entries.push({
      id: `att:${a.id}`,
      kind: 'attendance',
      at: a.sessionDate.toISOString(),
      day: a.sessionDate.toISOString().slice(0, 10),
      title: a.status === 'present' ? 'Present' : a.status === 'late' ? 'Late' : a.status === 'excused' ? 'Excused' : 'Absent',
      detail: a.note,
      status: a.status,
      severity: a.status === 'absent' ? 'medium' : null,
      rating: null,
      score: null,
      recordedById: a.recordedById,
      recordedBy: a.recordedById ? (actorName.get(a.recordedById) ?? null) : null,
      resolvedAt: null,
      resolutionNote: null,
    });
  }

  for (const p of progress) {
    if (wanted && !wanted.has('progress')) break;
    entries.push({
      id: `prg:${p.id}`,
      kind: 'progress',
      at: p.progressDate.toISOString(),
      day: p.progressDate.toISOString().slice(0, 10),
      title: p.score === null ? 'Progress noted' : `Scored ${p.score}%`,
      detail: p.note,
      status: null,
      severity: null,
      rating: null,
      score: p.score,
      recordedById: p.recordedById,
      recordedBy: p.recordedById ? (actorName.get(p.recordedById) ?? null) : null,
      resolvedAt: null,
      resolutionNote: null,
    });
  }

  for (const l of logs) {
    if (wanted && !wanted.has(l.kind)) continue;
    entries.push({
      id: `log:${l.id}`,
      kind: l.kind,
      at: l.entryDate.toISOString(),
      day: l.entryDate.toISOString().slice(0, 10),
      title: l.title,
      detail: l.detail,
      status: l.status,
      severity: l.severity,
      rating: l.rating,
      score: null,
      recordedById: l.recordedById,
      recordedBy: l.recordedById ? (actorName.get(l.recordedById) ?? null) : null,
      resolvedAt: l.resolvedAt?.toISOString() ?? null,
      resolutionNote: l.resolutionNote,
    });
  }

  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const openItems = logs.filter((l) => l.status !== 'resolved');
  const ratings = logs.filter((l) => l.kind === 'feedback' && l.rating !== null);

  // The invoices raised against this student, so "have they paid" is answered on
  // the same page as "are they turning up". The two questions are asked together
  // and used to live on screens that did not know about each other.
  const invoices = person
    ? await prisma.invoice.findMany({
        where: { tenantId: auth.tenantId, deletedAt: null, personId: person.id },
        include: { lines: true, receipts: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
    : [];

  return {
    enrollment: {
      id: enrollment.id,
      recordCode: enrollment.recordCode,
      status: enrollment.status,
      progressPct: enrollment.progressPct,
      attendancePct: enrollment.attendancePct,
      atRisk: enrollment.atRisk,
      isMinor: enrollment.isMinor,
      enrolledAt: enrollment.enrolledAt?.toISOString() ?? null,
      completedAt: enrollment.completedAt?.toISOString() ?? null,
      cohortId: enrollment.cohortId,
      cohortName: enrollment.cohort.name,
      courseName: enrollment.cohort.course.name,
      courseCode: enrollment.cohort.course.code,
    },
    student: person
      ? { id: person.id, name: person.fullName, recordCode: person.recordCode, phone: person.primaryPhone, email: person.primaryEmail }
      : null,
    counts: {
      entries: entries.length,
      sessions: attendance.length,
      present: attendance.filter((a) => a.status === 'present' || a.status === 'late').length,
      queries: logs.filter((l) => l.kind === 'query').length,
      feedback: logs.filter((l) => l.kind === 'feedback').length,
      issues: logs.filter((l) => l.kind === 'issue').length,
      openQueries: openItems.filter((l) => l.kind === 'query').length,
      openIssues: openItems.filter((l) => l.kind === 'issue').length,
      meanRating: ratings.length
        ? Math.round((ratings.reduce((s, r) => s + (r.rating ?? 0), 0) / ratings.length) * 10) / 10
        : null,
    },
    /** Everything still open, first, because it is the part that is work. */
    open: openItems.map((l) => ({
      id: l.id,
      kind: l.kind,
      title: l.title,
      severity: l.severity,
      status: l.status,
      raisedOn: l.entryDate.toISOString().slice(0, 10),
      ageDays: Math.floor((Date.now() - l.entryDate.getTime()) / 86_400_000),
    })),
    entries,
    /** Grouped by day, which is how a student's record is read. */
    days: groupByDay(entries),
    invoices: invoices.map((inv) => ({
      id: inv.id,
      recordCode: inv.recordCode ?? inv.draftReference ?? inv.id,
      status: inv.status,
      issuedDate: inv.issuedDate?.toISOString() ?? null,
      payable: num(inv.grandTotal) || inv.lines.reduce((s, l) => s + (num(l.amount) ?? 0), 0),
      allocated: inv.receipts.reduce((s, r) => s + (num(r.allocatedAmount) ?? 0), 0),
      paymentType: inv.paymentType,
      paymentMode: inv.paymentMode,
    })),
  };
}

function groupByDay(entries: TimelineEntry[]) {
  const days = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    days.set(entry.day, [...(days.get(entry.day) ?? []), entry]);
  }
  return [...days.entries()].map(([day, rows]) => ({ day, entries: rows }));
}

/**
 * Everything open across every student a viewer can see.
 *
 * The counterpart to the per-student timeline: a query nobody answered is only
 * work if somebody can find it without knowing which student to look at.
 */
export async function openLearnerItems(filter: { kind?: string; severity?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'education', verb: 'view' });

  const logs = await prisma.learnerLog.findMany({
    where: {
      tenantId: auth.tenantId,
      status: { not: 'resolved' },
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.severity ? { severity: filter.severity } : {}),
    },
    include: {
      enrollment: {
        include: { cohort: { include: { course: { select: { name: true } } } } },
      },
    },
    orderBy: [{ severity: 'asc' }, { entryDate: 'asc' }],
    take: 200,
  });

  const personIds = [...new Set(logs.map((l) => l.enrollment.personId))];
  const people = personIds.length
    ? await prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, fullName: true } })
    : [];
  const nameOf = new Map(people.map((p) => [p.id, p.fullName]));

  return logs.map((l) => ({
    id: l.id,
    kind: l.kind,
    title: l.title,
    detail: l.detail,
    severity: l.severity,
    status: l.status,
    entryDate: l.entryDate.toISOString(),
    ageDays: Math.floor((Date.now() - l.entryDate.getTime()) / 86_400_000),
    enrollmentId: l.enrollmentId,
    enrollmentCode: l.enrollment.recordCode,
    studentName: nameOf.get(l.enrollment.personId) ?? null,
    cohortName: l.enrollment.cohort.name,
    courseName: l.enrollment.cohort.course.name,
    trainerPartyId: l.enrollment.cohort.trainerPartyId,
  }));
}
