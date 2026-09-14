/**
 * HCM — recruiting (docs/hcm/recruiting.md).
 *
 * A full ATS built on top of the existing Requisition/Application machines
 * (`../hiring.js`) rather than a parallel copy of them: every model here
 * hangs off a `requisitionId` or `applicationId` and nothing re-derives the
 * candidate funnel `hiring.ts` already computes. The candidate is a Person —
 * `findOrCreatePerson` (`../identity.js`) is the only way one is created here,
 * exactly as it is everywhere else a human enters the system.
 */

import {
  EVENTS,
  jobPostingMachine,
  offerMachine,
  JOB_POSTING_EVENT_VERB,
  OFFER_EVENT_VERB,
  timeToHireDays,
  meanTimeToHireDays,
  offerAcceptanceRate,
  sourceEffectiveness,
  taskDueDate,
  type JobPostingState,
  type JobPostingEvent,
  type OfferState,
  type OfferEvent,
} from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, assertScopeAll, canSeeMoney, scopeFor } from '../../platform/permissions.js';
import { transition } from '../../platform/lifecycle.js';
import { auditWrite } from '../../platform/audit.js';
import { findOrCreatePerson, type PersonInput } from '../identity.js';
import { joinFromApplication, transitionApplication } from '../hiring.js';

function slugify(title: string, stamp: string): string {
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${stamp}`;
}

// ---------------------------------------------------------------------------
// Job postings
// ---------------------------------------------------------------------------

export async function listJobPostings(filter: { status?: string; requisitionId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'job_postings', verb: 'view' });
  return prisma.jobPosting.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.requisitionId ? { requisitionId: filter.requisitionId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createJobPosting(input: {
  requisitionId: string;
  title: string;
  description: string;
  channel?: 'internal' | 'external' | 'referral';
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'job_postings', verb: 'create' });

  const requisition = await prisma.requisition.findFirst({ where: { id: input.requisitionId, tenantId: auth.tenantId } });
  if (!requisition) throw ApiError.notFound('Requisition');

  const recordCode = await nextRecordCode('JPST');
  const posting = await prisma.jobPosting.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      requisitionId: input.requisitionId,
      title: input.title,
      description: input.description,
      channel: input.channel ?? 'internal',
      slug: slugify(input.title, recordCode.toLowerCase()),
    },
  });

  await emit({
    name: 'kz.hr.job_posting.created',
    subject: { entityType: 'job_posting', entityId: posting.id, recordCode },
    related: [{ relation: 'against', entityType: 'requisition', entityId: input.requisitionId }],
    newState: { status: 'Draft', title: input.title, channel: posting.channel },
    impact: { domains: ['hr'] },
  });

  return posting;
}

export async function transitionJobPosting(id: string, event: JobPostingEvent, note?: string) {
  const auth = currentAuth();
  const posting = await prisma.jobPosting.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!posting) throw ApiError.notFound('Job posting');

  const result = await transition({
    machine: jobPostingMachine,
    eventObject: 'job_posting',
    verbs: JOB_POSTING_EVENT_VERB,
    resource: 'job_postings',
    subjectType: 'job_posting',
    subjectId: id,
    recordCode: posting.recordCode,
    from: posting.status as JobPostingState,
    event,
    reasonNote: note ?? null,
  });

  return prisma.jobPosting.update({
    where: { id },
    data: {
      status: result.to,
      ...(event === 'PUBLISH' ? { publishedAt: new Date() } : {}),
      ...(event === 'CLOSE' ? { closesAt: new Date() } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Candidates. A CandidateProfile always sits on a resolved Person — the same
// row that becomes the employee's Person row on hire, per `hiring.ts`.
// ---------------------------------------------------------------------------

function maskCandidateMoney<T extends { currentCtc: unknown; expectedCtc: unknown }>(row: T, canSee: boolean): T {
  if (canSee) return row;
  return { ...row, currentCtc: null, expectedCtc: null };
}

export async function listCandidates(filter: { source?: string; q?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'candidates', verb: 'view' });
  const canSee = await canSeeMoney('candidates');

  const rows = await prisma.candidateProfile.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.source ? { source: filter.source } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

  const personIds = rows.map((r) => r.personId);
  const people = await prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, fullName: true, primaryEmail: true, primaryPhone: true, recordCode: true } });
  const byId = new Map(people.map((p) => [p.id, p]));

  const filtered = filter.q
    ? rows.filter((r) => byId.get(r.personId)?.fullName.toLowerCase().includes(filter.q!.toLowerCase()))
    : rows;

  return filtered.map((r) => ({ ...maskCandidateMoney(r, canSee), person: byId.get(r.personId) ?? null }));
}

export async function createCandidate(input: PersonInput & {
  source?: string;
  resumeText?: string;
  currentCtc?: number | null;
  expectedCtc?: number | null;
  noticeDays?: number | null;
  tags?: string[];
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'candidates', verb: 'create' });

  const { person } = await findOrCreatePerson(
    { fullName: input.fullName, primaryPhone: input.primaryPhone, primaryEmail: input.primaryEmail, source: input.source ?? 'recruiting' },
  );

  const existing = await prisma.candidateProfile.findFirst({ where: { tenantId: auth.tenantId, personId: person.id } });
  if (existing) return { ...existing, person };

  const profile = await prisma.candidateProfile.create({
    data: {
      tenantId: auth.tenantId,
      personId: person.id,
      source: input.source ?? 'direct',
      resumeText: input.resumeText ?? null,
      currentCtc: input.currentCtc ?? null,
      expectedCtc: input.expectedCtc ?? null,
      noticeDays: input.noticeDays ?? null,
      tags: input.tags ?? [],
    },
  });

  await emit({
    name: EVENTS.CANDIDATE_CREATED,
    subject: { entityType: 'candidate', entityId: profile.id, recordCode: person.recordCode },
    related: [{ relation: 'is', entityType: 'person', entityId: person.id }],
    newState: { source: profile.source },
    impact: { domains: ['hr'] },
  });

  return { ...profile, person };
}

// ---------------------------------------------------------------------------
// Interview rounds and scorecards
// ---------------------------------------------------------------------------

export async function listInterviewRounds(applicationId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'interviews', verb: 'view' });
  const application = await prisma.application.findFirst({ where: { id: applicationId, tenantId: auth.tenantId } });
  if (!application) throw ApiError.notFound('Application');

  const rows = await prisma.interviewRound.findMany({ where: { tenantId: auth.tenantId, applicationId }, orderBy: { roundNo: 'asc' } });

  // `interviews:V@own` is every employee's self-service grant (they are
  // either the candidate or a roster interviewer) — `assertCan` above passed
  // trivially with no record to narrow against, so the narrowing happens
  // here: an own-scope caller sees only the rounds where they are the
  // candidate or on that round's interviewer roster, never the whole loop for
  // an application that is not theirs.
  const scope = await scopeFor('interviews', 'view');
  if (scope === 'all') return rows;
  if (application.candidatePartyId === auth.partyId) return rows;
  return rows.filter((r) => (r.interviewerPartyIds as unknown as string[]).includes(auth.partyId ?? ''));
}

export async function scheduleInterview(input: {
  applicationId: string;
  roundNo: number;
  kind: 'phone' | 'technical' | 'hr' | 'panel';
  scheduledAt: Date;
  interviewerPartyIds: string[];
  mode?: 'video' | 'onsite' | 'phone';
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'interviews', verb: 'create' });

  const application = await prisma.application.findFirst({ where: { id: input.applicationId, tenantId: auth.tenantId } });
  if (!application) throw ApiError.notFound('Application');
  if (!['Screening', 'Interviewing'].includes(application.status)) {
    throw ApiError.unprocessable(
      `Application ${application.recordCode} is ${application.status}. An interview round is scheduled while the application is being screened or interviewed.`,
    );
  }

  const round = await prisma.interviewRound.create({
    data: {
      tenantId: auth.tenantId,
      applicationId: input.applicationId,
      roundNo: input.roundNo,
      kind: input.kind,
      scheduledAt: input.scheduledAt,
      interviewerPartyIds: input.interviewerPartyIds,
      mode: input.mode ?? 'video',
    },
  });

  await emit({
    name: EVENTS.INTERVIEW_SCHEDULED,
    subject: { entityType: 'interview_round', entityId: round.id },
    related: [{ relation: 'for', entityType: 'application', entityId: input.applicationId }],
    newState: { roundNo: input.roundNo, kind: input.kind, scheduledAt: input.scheduledAt.toISOString() },
    impact: { domains: ['hr'] },
  });

  return round;
}

export async function completeInterview(roundId: string, input: { outcome: 'advance' | 'reject' | 'hold'; status?: 'Completed' | 'Cancelled' | 'NoShow' }) {
  const auth = currentAuth();
  await assertCan({ resource: 'interviews', verb: 'edit' });

  const round = await prisma.interviewRound.findFirst({ where: { id: roundId, tenantId: auth.tenantId } });
  if (!round) throw ApiError.notFound('Interview round');
  if (round.status !== 'Scheduled') throw ApiError.conflict(`This round is already ${round.status}.`);

  const updated = await prisma.interviewRound.update({
    where: { id: roundId },
    data: { status: input.status ?? 'Completed', outcome: input.outcome },
  });

  await emit({
    name: EVENTS.INTERVIEW_COMPLETED,
    subject: { entityType: 'interview_round', entityId: roundId },
    related: [{ relation: 'for', entityType: 'application', entityId: round.applicationId }],
    previousState: { status: round.status },
    newState: { status: updated.status, outcome: input.outcome },
    impact: { domains: ['hr'] },
  });

  return updated;
}

export async function submitScorecard(input: {
  roundId: string;
  competencyScores: Record<string, number>;
  recommendation: 'strong_hire' | 'hire' | 'no_hire' | 'strong_no_hire';
  notes?: string;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'scorecards', verb: 'create' });
  if (!auth.partyId) throw ApiError.forbidden('Only a named person may submit interview feedback.');

  const round = await prisma.interviewRound.findFirst({ where: { id: input.roundId, tenantId: auth.tenantId } });
  if (!round) throw ApiError.notFound('Interview round');

  const roster = round.interviewerPartyIds as unknown as string[];
  if (Array.isArray(roster) && roster.length > 0 && !roster.includes(auth.partyId)) {
    throw ApiError.forbidden('Only an interviewer on this round’s roster may score it.');
  }

  const existing = await prisma.interviewScorecard.findFirst({
    where: { tenantId: auth.tenantId, roundId: input.roundId, interviewerPartyId: auth.partyId },
  });
  if (existing) throw ApiError.conflict('You have already scored this round. A correction is a new round, not an edit of a recorded scorecard.');

  const scorecard = await prisma.interviewScorecard.create({
    data: {
      tenantId: auth.tenantId,
      roundId: input.roundId,
      interviewerPartyId: auth.partyId,
      competencyScores: input.competencyScores,
      recommendation: input.recommendation,
      notes: input.notes ?? null,
    },
  });

  await emit({
    name: EVENTS.SCORECARD_SUBMITTED,
    subject: { entityType: 'interview_scorecard', entityId: scorecard.id },
    related: [{ relation: 'for', entityType: 'interview_round', entityId: input.roundId }],
    newState: { recommendation: input.recommendation },
    owner: { partyId: auth.partyId },
    impact: { domains: ['hr'] },
  });

  return scorecard;
}

export async function listScorecards(roundId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'scorecards', verb: 'view' });
  const round = await prisma.interviewRound.findFirst({ where: { id: roundId, tenantId: auth.tenantId } });
  if (!round) throw ApiError.notFound('Interview round');

  // `scorecards:VC@own` is the interviewer's self-service grant — it lets
  // them file and re-read their own scorecard, never a co-panellist's
  // recommendation. `assertCan` above had no record to narrow against, so an
  // own-scope caller is restricted here to the one row that is theirs.
  const scope = await scopeFor('scorecards', 'view');
  return prisma.interviewScorecard.findMany({
    where: { tenantId: auth.tenantId, roundId, ...(scope === 'all' ? {} : { interviewerPartyId: auth.partyId ?? '__none__' }) },
  });
}

// ---------------------------------------------------------------------------
// Offers. The proposer/approver split is the Self-Dealing Bar: the same
// partyId check `approveSalaryStructure` uses in compliance/payroll.ts.
// ---------------------------------------------------------------------------

function maskOfferMoney<T extends { ctc: unknown }>(row: T, canSee: boolean): T {
  if (canSee) return row;
  return { ...row, ctc: null };
}

export async function listOffers(filter: { applicationId?: string; status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'offers', verb: 'view' });
  const canSee = await canSeeMoney('offers');
  const rows = await prisma.offerLetter.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.applicationId ? { applicationId: filter.applicationId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => maskOfferMoney(r, canSee));
}

export async function createOffer(input: { applicationId: string; ctc: number; joiningDate: Date; validUntil: Date }) {
  const auth = currentAuth();
  await assertCan({ resource: 'offers', verb: 'create' });

  const application = await prisma.application.findFirst({ where: { id: input.applicationId, tenantId: auth.tenantId } });
  if (!application) throw ApiError.notFound('Application');
  if (application.status !== 'Selected') {
    throw ApiError.unprocessable(
      `Application ${application.recordCode} is ${application.status}. An offer is drafted once a candidate reaches Selected.`,
    );
  }

  const recordCode = await nextRecordCode('OFR');
  const offer = await prisma.offerLetter.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      applicationId: input.applicationId,
      ctc: input.ctc,
      joiningDate: input.joiningDate,
      validUntil: input.validUntil,
      proposedByPartyId: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'offer_letter', subjectId: offer.id, after: offer as never });
  return offer;
}

export async function transitionOffer(id: string, event: OfferEvent, input: { note?: string; declineReason?: string } = {}) {
  const auth = currentAuth();
  const offer = await prisma.offerLetter.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!offer) throw ApiError.notFound('Offer letter');

  // The Self-Dealing Bar: the person who proposed the offer may never also
  // approve it, unconditionally, exactly as `approveSalaryStructure` enforces
  // for a compensation revision.
  if (event === 'APPROVE' && offer.proposedByPartyId && offer.proposedByPartyId === auth.partyId) {
    throw ApiError.forbidden(
      'The proposer of an offer cannot also approve it (Self-Dealing Bar).',
      [{ axis: 'WHO', passed: false, reason: 'proposer_is_approver' }],
    );
  }
  if (event === 'DECLINE' && !input.declineReason) {
    throw ApiError.unprocessable('A decline needs a reason — it is what the funnel is answerable from later.');
  }
  if (event === 'ACCEPT' && offer.validUntil.getTime() < Date.now()) {
    throw ApiError.unprocessable(
      `This offer expired on ${offer.validUntil.toISOString().slice(0, 10)} and can no longer be accepted.`,
    );
  }

  const result = await transition({
    machine: offerMachine,
    eventObject: 'offer',
    verbs: OFFER_EVENT_VERB,
    resource: 'offers',
    verb: event === 'APPROVE' || event === 'REJECT' ? 'approve' : 'edit',
    subjectType: 'offer_letter',
    subjectId: id,
    recordCode: offer.recordCode,
    ownerPartyId: offer.proposedByPartyId,
    from: offer.status as OfferState,
    event,
    reasonNote: input.note ?? input.declineReason ?? null,
  });

  // The offer and the underlying application are one fact moving together,
  // not two records somebody has to remember to keep in step: sending an
  // offer is `hiring.ts`'s EXTEND_OFFER, and accepting/declining/rescinding
  // this offer is the matching Application event. Driven BEFORE the offer's
  // own row is persisted below: if the application machine refuses (it is
  // already past the matching state — a stale second offer against an
  // application that moved on, say) the offer transition refuses with it,
  // rather than leaving an offer marked Sent/Accepted/Declined against an
  // application that never followed.
  //
  // RESCIND is the one exception: an offer can be rescinded from Draft or
  // Approved, before it was ever sent, and the application machine has no
  // RESCIND_OFFER transition to take from Selected in that case — there is
  // nothing for the application to follow, so it is a no-op rather than a
  // refusal.
  const applicationEvent: Partial<Record<OfferEvent, 'EXTEND_OFFER' | 'ACCEPT_OFFER' | 'DECLINE_OFFER' | 'RESCIND_OFFER'>> = {
    SEND: 'EXTEND_OFFER',
    ACCEPT: 'ACCEPT_OFFER',
    DECLINE: 'DECLINE_OFFER',
    RESCIND: 'RESCIND_OFFER',
  };
  if (applicationEvent[event]) {
    try {
      await transitionApplication(offer.applicationId, applicationEvent[event]!, {
        note: `Offer ${offer.recordCode} ${OFFER_EVENT_VERB[event]}`,
        rejectionReason: event === 'DECLINE' ? input.declineReason : undefined,
      });
    } catch (err) {
      if (event !== 'RESCIND') throw err;
    }
  }

  const updated = await prisma.offerLetter.update({
    where: { id },
    data: {
      status: result.to,
      ...(event === 'APPROVE' ? { approvedByPartyId: auth.partyId, approvedAt: new Date() } : {}),
      ...(event === 'SEND' ? { sentAt: new Date() } : {}),
      ...(event === 'ACCEPT' || event === 'DECLINE' ? { decidedAt: new Date() } : {}),
      ...(event === 'DECLINE' ? { declineReason: input.declineReason } : {}),
    },
  });

  // The named events the scaffold registered, emitted alongside the generic
  // lifecycle event `transition()` already wrote, so a subscriber keyed to
  // `EVENTS.OFFER_ACCEPTED` etc. does not have to know the transition grammar.
  const named: Partial<Record<OfferEvent, string>> = {
    APPROVE: EVENTS.OFFER_APPROVED,
    SEND: EVENTS.OFFER_SENT,
    ACCEPT: EVENTS.OFFER_ACCEPTED,
    DECLINE: EVENTS.OFFER_DECLINED,
  };
  if (named[event]) {
    await emit({
      name: named[event]!,
      subject: { entityType: 'offer_letter', entityId: id, recordCode: offer.recordCode },
      related: [{ relation: 'for', entityType: 'application', entityId: offer.applicationId }],
      newState: { status: updated.status },
      impact: { domains: ['hr'] },
    });
  }

  return updated;
}

/** Joins the candidate exactly as `hiring.ts` does, then instantiates this employment's onboarding checklist from the active templates. */
export async function joinAndOnboard(
  applicationId: string,
  input: { hireEffectiveDate: Date; legalEntity?: string; noticePeriodDays?: number; branch?: string | null },
) {
  const employment = await joinFromApplication(applicationId, input);
  const tasks = await instantiateOnboardingTasks(employment.id, input.hireEffectiveDate);
  return { employment, tasksCreated: tasks.length };
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

function maskReferralMoney<T extends { bonusAmount: unknown }>(row: T, canSee: boolean): T {
  if (canSee) return row;
  return { ...row, bonusAmount: null };
}

export async function listReferrals(filter: { referrerEmploymentId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'referrals', verb: 'view' });
  const canSee = await canSeeMoney('referrals');

  // `referrals:VC@own` is every employee's self-service grant for the
  // referrals they themselves raised — `assertCan` above had no record to
  // narrow against, so without this an own-scope caller would see every
  // colleague's referral by leaving the filter off.
  const scope = await scopeFor('referrals', 'view');
  const ownEmploymentIds =
    scope === 'all'
      ? null
      : (await prisma.employmentRelationship.findMany({ where: { tenantId: auth.tenantId, personId: auth.partyId ?? '__none__' }, select: { id: true } })).map(
          (e) => e.id,
        );

  const rows = await prisma.referral.findMany({
    where: {
      tenantId: auth.tenantId,
      AND: [
        ...(filter.referrerEmploymentId ? [{ referrerEmploymentId: filter.referrerEmploymentId }] : []),
        ...(ownEmploymentIds ? [{ referrerEmploymentId: { in: ownEmploymentIds } }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => maskReferralMoney(r, canSee));
}

export async function createReferral(input: {
  referrerEmploymentId: string;
  candidate: PersonInput;
  bonusAmount?: number | null;
  applicationId?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'referrals', verb: 'create' });

  const referrer = await prisma.employmentRelationship.findFirst({ where: { id: input.referrerEmploymentId, tenantId: auth.tenantId } });
  if (!referrer) throw ApiError.notFound('Referring employment');

  // `referrals:VC@own` is every employee's self-service grant for raising
  // their own referral — never one filed in a colleague's name. Without this
  // check, `referrerEmploymentId` is caller-supplied and any own-scope holder
  // could credit anyone's employment.
  const scope = await scopeFor('referrals', 'create');
  if (scope !== 'all' && referrer.personId !== auth.partyId) {
    throw ApiError.forbidden('A referral is raised as yourself: the referring employment must be your own.');
  }

  const { person } = await findOrCreatePerson({ ...input.candidate, source: 'referral' });
  if (person.id === referrer.personId) {
    throw ApiError.badRequest('The referrer and the candidate cannot be the same person.');
  }

  const referral = await prisma.referral.create({
    data: {
      tenantId: auth.tenantId,
      referrerEmploymentId: input.referrerEmploymentId,
      candidatePersonId: person.id,
      applicationId: input.applicationId ?? null,
      bonusAmount: input.bonusAmount ?? null,
    },
  });

  await emit({
    name: EVENTS.REFERRAL_SUBMITTED,
    subject: { entityType: 'referral', entityId: referral.id, recordCode: person.recordCode },
    related: [
      { relation: 'by', entityType: 'employment', entityId: input.referrerEmploymentId },
      { relation: 'for', entityType: 'person', entityId: person.id },
    ],
    owner: { partyId: referrer.personId },
    impact: { domains: ['hr'] },
  });

  return referral;
}

const REFERRAL_TRANSITIONS: Record<string, string[]> = {
  Submitted: ['Shortlisted', 'Rejected'],
  Shortlisted: ['Hired', 'Rejected'],
  Hired: ['BonusPaid'],
  BonusPaid: [],
  Rejected: [],
};

export async function updateReferralStatus(id: string, status: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'referrals', verb: 'edit' });
  const referral = await prisma.referral.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!referral) throw ApiError.notFound('Referral');

  if (!REFERRAL_TRANSITIONS[referral.status]?.includes(status)) {
    throw ApiError.unprocessable(
      `A referral ${referral.status} cannot move to ${status}. From here it accepts: ${REFERRAL_TRANSITIONS[referral.status]?.join(', ') || 'nothing — this is final'}.`,
    );
  }

  const updated = await prisma.referral.update({ where: { id }, data: { status } });
  await auditWrite({ action: 'update', subjectType: 'referral', subjectId: id, before: referral, after: updated });
  return updated;
}

// ---------------------------------------------------------------------------
// Background verification
// ---------------------------------------------------------------------------

export async function listBackgroundVerifications(filter: { applicationId?: string; employmentId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'background_verifications', verb: 'view' });
  return prisma.backgroundVerification.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.applicationId ? { applicationId: filter.applicationId } : {}),
      ...(filter.employmentId ? { employmentId: filter.employmentId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createBackgroundVerification(input: {
  applicationId?: string | null;
  employmentId?: string | null;
  vendor: string;
  checks: string[];
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'background_verifications', verb: 'create' });
  if (!input.applicationId && !input.employmentId) {
    throw ApiError.badRequest('A background verification needs either an application or an employment to be run against.');
  }

  return prisma.backgroundVerification.create({
    data: {
      tenantId: auth.tenantId,
      applicationId: input.applicationId ?? null,
      employmentId: input.employmentId ?? null,
      vendor: input.vendor,
      checks: input.checks,
    },
  });
}

export async function updateBackgroundVerification(id: string, input: { status?: 'Pending' | 'InProgress' | 'Completed'; outcome?: 'clear' | 'adverse' | 'pending' }) {
  const auth = currentAuth();
  await assertCan({ resource: 'background_verifications', verb: 'edit' });
  const bgv = await prisma.backgroundVerification.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!bgv) throw ApiError.notFound('Background verification');
  if (bgv.status === 'Completed') {
    throw ApiError.conflict('This background verification is Completed. Its outcome is final — a correction is a new check, not an edit of a closed one.');
  }

  const updated = await prisma.backgroundVerification.update({
    where: { id },
    data: {
      status: input.status ?? bgv.status,
      outcome: input.outcome ?? bgv.outcome,
      ...(input.status === 'Completed' ? { completedAt: new Date() } : {}),
    },
  });

  if (input.status === 'Completed') {
    await emit({
      name: EVENTS.BACKGROUND_VERIFICATION_COMPLETED,
      subject: { entityType: 'background_verification', entityId: id },
      newState: { outcome: updated.outcome },
      impact: { domains: ['hr'] },
    });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Onboarding task templates and instances
// ---------------------------------------------------------------------------

export async function listOnboardingTemplates() {
  const auth = currentAuth();
  await assertCan({ resource: 'onboarding_tasks', verb: 'view' });
  return prisma.onboardingTaskTemplate.findMany({ where: { tenantId: auth.tenantId }, orderBy: { dueOffsetDays: 'asc' } });
}

export async function createOnboardingTemplate(input: { title: string; category?: string; assignee: 'hr' | 'it' | 'manager' | 'employee'; dueOffsetDays?: number }) {
  const auth = currentAuth();
  await assertCan({ resource: 'onboarding_tasks', verb: 'create' });
  return prisma.onboardingTaskTemplate.create({
    data: {
      tenantId: auth.tenantId,
      title: input.title,
      category: input.category ?? 'general',
      assignee: input.assignee,
      dueOffsetDays: input.dueOffsetDays ?? 0,
    },
  });
}

export async function instantiateOnboardingTasks(employmentId: string, hireEffectiveDate: Date) {
  const auth = currentAuth();
  await assertCan({ resource: 'onboarding_tasks', verb: 'create' });

  const employment = await prisma.employmentRelationship.findFirst({ where: { id: employmentId, tenantId: auth.tenantId } });
  if (!employment) throw ApiError.notFound('Employment');

  const already = await prisma.onboardingTask.count({ where: { tenantId: auth.tenantId, employmentId } });
  if (already > 0) return prisma.onboardingTask.findMany({ where: { tenantId: auth.tenantId, employmentId } });

  const templates = await prisma.onboardingTaskTemplate.findMany({ where: { tenantId: auth.tenantId, active: true } });
  const tasks = await prisma.$transaction(
    templates.map((t) =>
      prisma.onboardingTask.create({
        data: {
          tenantId: auth.tenantId,
          employmentId,
          templateId: t.id,
          title: t.title,
          assignee: t.assignee,
          dueDate: taskDueDate(hireEffectiveDate, t.dueOffsetDays),
        },
      }),
    ),
  );

  return tasks;
}

export async function listOnboardingTasks(employmentId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'onboarding_tasks', verb: 'view' });

  // `onboarding_tasks:VE@own` is the joiner's own self-service grant on their
  // own checklist — `assertCan` above had no record to narrow against, so an
  // own-scope caller is restricted here to an employment that is actually
  // theirs, rather than any employment id they happen to know.
  const scope = await scopeFor('onboarding_tasks', 'view');
  if (scope !== 'all') {
    const employment = await prisma.employmentRelationship.findFirst({ where: { id: employmentId, tenantId: auth.tenantId } });
    if (!employment || employment.personId !== auth.partyId) throw ApiError.notFound('Employment');
  }

  return prisma.onboardingTask.findMany({ where: { tenantId: auth.tenantId, employmentId }, orderBy: { dueDate: 'asc' } });
}

export async function completeOnboardingTask(id: string, skip = false) {
  const auth = currentAuth();
  await assertCan({ resource: 'onboarding_tasks', verb: 'edit' });
  const task = await prisma.onboardingTask.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!task) throw ApiError.notFound('Onboarding task');

  // `onboarding_tasks:VE@own` is the joiner's own self-service grant, and
  // only over the tasks their own checklist assigns to them as the employee
  // — never an HR/IT/manager task, and never a colleague's checklist.
  // `assertCan` above had no record to narrow against.
  const scope = await scopeFor('onboarding_tasks', 'edit');
  if (scope !== 'all') {
    const employment = await prisma.employmentRelationship.findFirst({ where: { id: task.employmentId, tenantId: auth.tenantId } });
    if (!employment || employment.personId !== auth.partyId || task.assignee !== 'employee') {
      throw ApiError.notFound('Onboarding task');
    }
  }

  if (task.status !== 'Pending') throw ApiError.conflict(`This task is already ${task.status}.`);

  const updated = await prisma.onboardingTask.update({
    where: { id },
    data: {
      status: skip ? 'Skipped' : 'Done',
      completedAt: new Date(),
      completedByPartyId: auth.partyId,
    },
  });

  if (!skip) {
    await emit({
      name: EVENTS.ONBOARDING_TASK_COMPLETED,
      subject: { entityType: 'onboarding_task', entityId: id },
      related: [{ relation: 'for', entityType: 'employment', entityId: task.employmentId }],
      newState: { status: 'Done' },
      owner: { partyId: auth.partyId },
      impact: { domains: ['hr'] },
    });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Funnel metrics (§9.2.21-style — recruiting's own additions to `hiringFunnel`)
// ---------------------------------------------------------------------------

export async function recruitingFunnel() {
  const auth = currentAuth();
  await assertScopeAll('applications');

  const joined = await prisma.application.findMany({
    where: { tenantId: auth.tenantId, status: 'Joined' },
    select: { createdAt: true, updatedAt: true, candidatePartyId: true },
  });
  const times = joined.map((a) => timeToHireDays(a.createdAt, a.updatedAt));

  const offers = await prisma.offerLetter.groupBy({ by: ['status'], where: { tenantId: auth.tenantId }, _count: { _all: true } });
  const offerCounts: Record<string, number> = {};
  for (const row of offers) offerCounts[row.status] = row._count._all;
  const decided = (offerCounts.Accepted ?? 0) + (offerCounts.Declined ?? 0) + (offerCounts.Rescinded ?? 0);

  // CandidateProfile and Application live in different schema files with no
  // cross-file `@relation`, so the join is done in application code: every
  // candidate's source, matched against whether that person's own
  // applications ever reached Joined.
  const profiles = await prisma.candidateProfile.findMany({ where: { tenantId: auth.tenantId }, select: { personId: true, source: true } });
  const applicationsByPerson = await prisma.application.groupBy({
    by: ['candidatePartyId'],
    where: { tenantId: auth.tenantId, deletedAt: null },
    _count: { _all: true },
  });
  const appCountByPerson = new Map(applicationsByPerson.map((a) => [a.candidatePartyId, a._count._all]));
  const joinedPersonIds = new Set(joined.map((a) => a.candidatePartyId));

  const tallyBySource = new Map<string, { applications: number; hired: number }>();
  for (const p of profiles) {
    const tally = tallyBySource.get(p.source) ?? { applications: 0, hired: 0 };
    tally.applications += appCountByPerson.get(p.personId) ?? 0;
    if (joinedPersonIds.has(p.personId)) tally.hired += 1;
    tallyBySource.set(p.source, tally);
  }

  return {
    meanTimeToHireDays: meanTimeToHireDays(times),
    offerAcceptanceRatePct: offerAcceptanceRate(offerCounts.Accepted ?? 0, decided),
    offersByStatus: offerCounts,
    sourceEffectiveness: sourceEffectiveness(
      [...tallyBySource.entries()].map(([source, t]) => ({ source, ...t })),
    ),
  };
}
