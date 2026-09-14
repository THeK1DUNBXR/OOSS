/**
 * The board (equity-portal plan §6, phase 3).
 *
 * Meetings, agenda, attendance and the minutes lifecycle with SS-1 timelines;
 * circular resolutions with the s.179(3) meeting-only bar and the interested-
 * director abstention (s.184); a compliance calendar computed from recorded
 * facts, never guessed from an empty register — an empty register reads "No
 * meeting recorded", never "overdue".
 *
 * Every function opens with `assertCan`; only the scoped `prisma` is used.
 * `Resolution.subjectRef` is a free-text placeholder for what the register
 * (phase 1) will later reference by id.
 */

import {
  EVENTS,
  RESOLUTION_SUBJECTS_REQUIRING_MEETING,
  VOTING_BOARD_ROLES,
  quorumFor,
  meetingDemandThreshold,
  type BoardMemberRole,
  type MeetingMode,
  type ResolutionKind,
  type ResolutionSubject,
  type VoteChoice,
} from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite } from '../platform/audit.js';
import { assertCan } from '../platform/permissions.js';

const DAY_MS = 86_400_000;

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / DAY_MS;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

// ---------------------------------------------------------------------------
// Board members
// ---------------------------------------------------------------------------

const DIRECTOR_FAMILY_ROLES: BoardMemberRole[] = ['director', 'independent_director', 'nominee_director'];

export interface AddBoardMemberInput {
  personId: string;
  role: BoardMemberRole;
  din?: string;
  appointedOn: Date;
  nominatedByHolderRef?: string;
}

export async function addBoardMember(input: AddBoardMemberInput) {
  await assertCan({ resource: 'board_meetings', verb: 'create' });
  const auth = currentAuth();

  const person = await prisma.person.findFirst({ where: { id: input.personId } });
  if (!person) throw ApiError.notFound('Person');

  const recordCode = await nextRecordCode('BDM');
  const member = await prisma.boardMember.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      personId: input.personId,
      role: input.role,
      din: input.din ?? null,
      appointedOn: input.appointedOn,
      nominatedByHolderRef: input.nominatedByHolderRef ?? null,
      status: 'active',
    },
  });

  // A board seat in the director family is a fact about the person's
  // relationship to this entity — the same affiliation-on-creation pattern
  // `signIns.ts` uses for a sign-in. This never creates a User or a
  // Principal; that stays the sign-in action's job.
  if (DIRECTOR_FAMILY_ROLES.includes(input.role)) {
    const existing = await prisma.affiliation.findFirst({
      where: { partyId: input.personId, affiliationType: 'director', roleSlug: 'director' },
    });
    if (!existing) {
      await prisma.affiliation.create({
        data: {
          tenantId: auth.tenantId,
          partyId: input.personId,
          affiliationType: 'director',
          roleSlug: 'director',
          status: 'active',
          primaryFlag: false,
        },
      });
    } else if (existing.status !== 'active') {
      await prisma.affiliation.update({ where: { id: existing.id }, data: { status: 'active' } });
    }
  }

  await emit({
    name: EVENTS.BOARD_MEMBER_ADDED,
    subject: { entityType: 'board_member', entityId: member.id, recordCode },
    newState: { personId: input.personId, role: input.role },
  });

  return member;
}

export async function ceaseBoardMember(id: string, ceasedOn: Date = new Date()) {
  await assertCan({ resource: 'board_meetings', verb: 'edit' });
  const member = await prisma.boardMember.findFirst({ where: { id } });
  if (!member) throw ApiError.notFound('Board member');

  const updated = await prisma.boardMember.update({
    where: { id },
    data: { status: 'ceased', ceasedOn },
  });

  await emit({
    name: EVENTS.BOARD_MEMBER_CEASED,
    subject: { entityType: 'board_member', entityId: id, recordCode: member.recordCode },
    previousState: { status: member.status },
    newState: { status: 'ceased', ceasedOn },
  });

  return updated;
}

export interface DeclareInterestsInput {
  interests?: Array<{ entity: string; nature: string; since?: string }>;
  declaredOn?: Date;
}

export async function declareInterests(id: string, input: DeclareInterestsInput) {
  await assertCan({ resource: 'board_meetings', verb: 'edit' });
  const member = await prisma.boardMember.findFirst({ where: { id } });
  if (!member) throw ApiError.notFound('Board member');

  const declaredOn = input.declaredOn ?? new Date();
  const updated = await prisma.boardMember.update({
    where: { id },
    data: {
      interestsDeclaredOn: declaredOn,
      interests: (input.interests ?? []) as never,
    },
  });

  // MBP-1: close whatever annual-declaration item is open for this member.
  await closeOpenComplianceItems({ kind: 'mbp1_annual', relatedType: 'board_member', relatedId: id, resolvedOn: declaredOn, filedRef: null });

  await auditWrite({
    action: 'update',
    subjectType: 'board_member',
    subjectId: id,
    after: { interestsDeclaredOn: declaredOn },
    force: true,
  });

  return updated;
}

export async function listBoardMembers() {
  await assertCan({ resource: 'board_meetings', verb: 'view' });
  const auth = currentAuth();
  const members = await prisma.boardMember.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { appointedOn: 'asc' },
  });
  const people = await prisma.person.findMany({ where: { id: { in: members.map((m) => m.personId) } } });
  const nameById = new Map(people.map((p) => [p.id, p.fullName] as const));
  return members.map((m) => ({ ...m, personName: nameById.get(m.personId) ?? 'Unknown' }));
}

async function activeVotingMemberCount(): Promise<number> {
  const auth = currentAuth();
  return prisma.boardMember.count({
    where: { tenantId: auth.tenantId, status: 'active', role: { in: VOTING_BOARD_ROLES } },
  });
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export interface CallMeetingInput {
  kind: 'board' | 'agm' | 'egm' | 'committee';
  title: string;
  scheduledFor: Date;
  noticeSentOn?: Date;
  mode: MeetingMode;
  venue?: string;
  /** Records the s.173(3) short-notice consent, with the reason it required. */
  shortNoticeConsent?: { reason: string };
}

export async function callMeeting(input: CallMeetingInput) {
  await assertCan({ resource: 'board_meetings', verb: 'create' });
  const auth = currentAuth();

  const profile = await prisma.companyProfile.findFirst({ where: { tenantId: auth.tenantId } });
  const noticeDays = profile?.noticeDays ?? 7;
  const noticeSentOn = input.noticeSentOn ?? new Date();
  const clearDays = daysBetween(noticeSentOn, input.scheduledFor);

  const agenda: Array<{ n: number; title: string; notes?: string }> = [];
  if (clearDays < noticeDays) {
    if (!input.shortNoticeConsent?.reason) {
      throw ApiError.unprocessable(
        `SS-1 requires at least ${noticeDays} clear days' notice before a board meeting. ` +
          `This notice gives ${Math.max(0, Math.floor(clearDays))}. Record short-notice consent with a reason to call it anyway.`,
      );
    }
    agenda.push({
      n: 1,
      title: 'Short-notice consent recorded',
      notes: `Meeting called on short notice (${Math.max(0, Math.floor(clearDays))} of ${noticeDays} clear days). Reason: ${input.shortNoticeConsent.reason}`,
    });
  }

  const quorumRequired = quorumFor(await activeVotingMemberCount());
  const recordCode = await nextRecordCode('BRD');

  const meeting = await prisma.boardMeeting.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      kind: input.kind,
      title: input.title,
      noticeSentOn,
      scheduledFor: input.scheduledFor,
      mode: input.mode,
      venue: input.venue ?? null,
      quorumRequired,
      agenda: agenda as never,
      status: 'called',
    },
  });

  await emit({
    name: EVENTS.MEETING_CALLED,
    subject: { entityType: 'board_meeting', entityId: meeting.id, recordCode },
    newState: { scheduledFor: input.scheduledFor, quorumRequired, shortNotice: clearDays < noticeDays },
  });

  return meeting;
}

async function getMeetingOrThrow(id: string) {
  const meeting = await prisma.boardMeeting.findFirst({ where: { id } });
  if (!meeting) throw ApiError.notFound('Board meeting');
  return meeting;
}

export interface AgendaItemInput {
  n: number;
  title: string;
  notes?: string;
  resolutionId?: string;
}

export async function updateAgenda(meetingId: string, agenda: AgendaItemInput[]) {
  await assertCan({ resource: 'board_meetings', verb: 'edit' });
  await getMeetingOrThrow(meetingId);
  return prisma.boardMeeting.update({ where: { id: meetingId }, data: { agenda: agenda as never } });
}

export interface AttendanceInput {
  boardMemberId: string;
  present: boolean;
  via?: MeetingMode;
}

export async function recordAttendance(meetingId: string, attendees: AttendanceInput[]) {
  await assertCan({ resource: 'board_meetings', verb: 'edit' });
  const meeting = await getMeetingOrThrow(meetingId);

  const presentCount = attendees.filter((a) => a.present).length;
  const quorumMet = presentCount >= meeting.quorumRequired;

  return prisma.boardMeeting.update({
    where: { id: meetingId },
    data: { attendees: attendees as never, quorumMet },
  });
}

export async function markHeld(meetingId: string, heldOn: Date = new Date()) {
  await assertCan({ resource: 'board_meetings', verb: 'edit' });
  const meeting = await getMeetingOrThrow(meetingId);

  if (meeting.quorumMet !== true) {
    throw ApiError.unprocessable(
      'This meeting cannot be marked held: quorum is not recorded as met (s.174). Record attendance meeting the quorum first.',
    );
  }

  const updated = await prisma.boardMeeting.update({
    where: { id: meetingId },
    data: { status: 'held', heldOn },
  });

  await emit({
    name: EVENTS.MEETING_HELD,
    subject: { entityType: 'board_meeting', entityId: meetingId, recordCode: meeting.recordCode },
    newState: { heldOn },
  });

  return updated;
}

export async function draftMinutes(meetingId: string, input: { text: string; documentRef?: string }) {
  await assertCan({ resource: 'board_meetings', verb: 'edit' });
  const meeting = await getMeetingOrThrow(meetingId);
  if (!meeting.heldOn) throw ApiError.unprocessable('Minutes cannot be drafted before the meeting is marked held.');

  return prisma.boardMeeting.update({
    where: { id: meetingId },
    data: {
      status: 'minutes_draft',
      minutesDraftedOn: new Date(),
      minutesText: input.text,
      minutesDocumentRef: input.documentRef ?? meeting.minutesDocumentRef,
    },
  });
}

export async function circulateMinutes(meetingId: string) {
  await assertCan({ resource: 'board_meetings', verb: 'edit' });
  const meeting = await getMeetingOrThrow(meetingId);
  if (!meeting.minutesDraftedOn) throw ApiError.unprocessable('Minutes must be drafted before they can be circulated.');

  const updated = await prisma.boardMeeting.update({
    where: { id: meetingId },
    data: { status: 'minutes_circulated', minutesCirculatedOn: new Date() },
  });

  await emit({
    name: EVENTS.MEETING_MINUTED,
    subject: { entityType: 'board_meeting', entityId: meetingId, recordCode: meeting.recordCode },
    newState: { stage: 'circulated' },
  });

  return updated;
}

export interface EnterMinutesInput {
  late?: boolean;
  reason?: string;
}

export async function enterMinutes(meetingId: string, input: EnterMinutesInput = {}) {
  await assertCan({ resource: 'board_meetings', verb: 'edit' });
  const meeting = await getMeetingOrThrow(meetingId);
  if (!meeting.heldOn) throw ApiError.unprocessable('Minutes cannot be entered before the meeting is marked held.');

  const now = new Date();
  const daysSinceHeld = daysBetween(meeting.heldOn, now);
  const late = daysSinceHeld > 30;

  if (late && !input.late) {
    throw ApiError.unprocessable(
      `SS-1 requires minutes to be entered within 30 days of the meeting; ${Math.floor(daysSinceHeld)} have passed. ` +
        'Pass `late: true` with a reason to record the entry anyway — never silently.',
    );
  }
  if (late && input.late && !input.reason) {
    throw ApiError.badRequest('A late minutes entry needs a reason on record.');
  }

  const updated = await prisma.boardMeeting.update({
    where: { id: meetingId },
    data: { status: 'minutes_entered', minutesEnteredOn: now },
  });

  if (late) {
    await auditWrite({
      action: 'update',
      subjectType: 'board_meeting',
      subjectId: meetingId,
      after: { minutesEnteredOn: now, late: true, daysSinceHeld: Math.floor(daysSinceHeld), reason: input.reason },
      force: true,
    });
  }

  await emit({
    name: EVENTS.MEETING_MINUTED,
    subject: { entityType: 'board_meeting', entityId: meetingId, recordCode: meeting.recordCode },
    newState: { stage: 'entered', late, reason: late ? input.reason : undefined },
  });

  // Minutes entered on time clears the corresponding compliance item.
  await closeOpenComplianceItems({ kind: 'minutes_entry_30d', relatedType: 'board_meeting', relatedId: meetingId, resolvedOn: now, filedRef: late ? `Late: ${input.reason}` : null });

  return updated;
}

export async function signMinutes(meetingId: string, documentRef?: string) {
  await assertCan({ resource: 'board_meetings', verb: 'edit' });
  const meeting = await getMeetingOrThrow(meetingId);
  if (meeting.status !== 'minutes_entered') {
    throw ApiError.unprocessable('Minutes must be entered before they can be signed.');
  }

  return prisma.boardMeeting.update({
    where: { id: meetingId },
    data: {
      status: 'minutes_signed',
      minutesSignedOn: new Date(),
      minutesDocumentRef: documentRef ?? meeting.minutesDocumentRef,
    },
  });
}

export async function cancelMeeting(meetingId: string, reason?: string) {
  await assertCan({ resource: 'board_meetings', verb: 'edit' });
  const meeting = await getMeetingOrThrow(meetingId);

  const updated = await prisma.boardMeeting.update({ where: { id: meetingId }, data: { status: 'cancelled' } });

  await emit({
    name: EVENTS.MEETING_CANCELLED,
    subject: { entityType: 'board_meeting', entityId: meetingId, recordCode: meeting.recordCode },
    newState: { reason: reason ?? null },
  });

  return updated;
}

export async function listMeetings() {
  await assertCan({ resource: 'board_meetings', verb: 'view' });
  const auth = currentAuth();
  return prisma.boardMeeting.findMany({ where: { tenantId: auth.tenantId }, orderBy: { scheduledFor: 'desc' } });
}

export async function meeting(id: string) {
  await assertCan({ resource: 'board_meetings', verb: 'view' });
  return getMeetingOrThrow(id);
}

export interface BoardPackItemInput {
  title: string;
  kind: 'notice' | 'agenda' | 'paper' | 'financial_summary' | 'minutes' | 'resolution' | 'other';
  fileRef: string;
  order?: number;
}

export async function addBoardPackItem(meetingId: string, input: BoardPackItemInput) {
  await assertCan({ resource: 'board_documents', verb: 'create' });
  const auth = currentAuth();
  await getMeetingOrThrow(meetingId);

  return prisma.boardPackItem.create({
    data: {
      tenantId: auth.tenantId,
      meetingId,
      title: input.title,
      kind: input.kind,
      fileRef: input.fileRef,
      addedByPartyId: auth.partyId ?? 'system',
      order: input.order ?? 0,
    },
  });
}

export async function boardPack(meetingId: string) {
  await assertCan({ resource: 'board_documents', verb: 'view' });
  const m = await getMeetingOrThrow(meetingId);
  const [items, resolutions] = await Promise.all([
    prisma.boardPackItem.findMany({ where: { meetingId }, orderBy: { order: 'asc' } }),
    prisma.resolution.findMany({ where: { meetingId } }),
  ]);
  return { meeting: m, items, resolutions };
}

// ---------------------------------------------------------------------------
// Resolutions
// ---------------------------------------------------------------------------

export interface ProposeResolutionInput {
  kind: ResolutionKind;
  subject: ResolutionSubject;
  title: string;
  text: string;
  passedBy: 'meeting' | 'circulation';
  meetingId?: string;
  subjectRef?: string;
}

export async function proposeResolution(input: ProposeResolutionInput) {
  await assertCan({ resource: 'resolutions', verb: 'create' });
  const auth = currentAuth();

  const requiresMeeting = (RESOLUTION_SUBJECTS_REQUIRING_MEETING as ResolutionSubject[]).includes(input.subject);
  if (requiresMeeting && input.passedBy === 'circulation') {
    throw ApiError.unprocessable(
      `A resolution on ${input.subject.replace(/_/g, ' ')} must be passed at a meeting, not by circulation (s.179(3)).`,
    );
  }

  const recordCode = await nextRecordCode('RES');
  const resolution = await prisma.resolution.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      kind: input.kind,
      subject: input.subject,
      title: input.title,
      text: input.text,
      passedBy: input.passedBy,
      meetingId: input.meetingId ?? null,
      requiresMeeting,
      subjectRef: input.subjectRef ?? null,
      proposedByPartyId: auth.partyId ?? 'system',
      outcome: 'draft',
    },
  });

  await emit({
    name: EVENTS.RESOLUTION_PROPOSED,
    subject: { entityType: 'resolution', entityId: resolution.id, recordCode },
    newState: { subject: input.subject, passedBy: input.passedBy, requiresMeeting },
  });

  return resolution;
}

async function getResolutionOrThrow(id: string) {
  const resolution = await prisma.resolution.findFirst({ where: { id } });
  if (!resolution) throw ApiError.notFound('Resolution');
  return resolution;
}

export interface OpenForCirculationInput {
  dispatchProofRef: string;
  votingClosesOn?: Date;
}

export async function openForCirculation(resolutionId: string, input: OpenForCirculationInput) {
  await assertCan({ resource: 'resolutions', verb: 'edit' });
  const resolution = await getResolutionOrThrow(resolutionId);
  if (resolution.passedBy !== 'circulation') {
    throw ApiError.unprocessable('Only a resolution proposed for circulation can be opened for circulation.');
  }
  if (!input.dispatchProofRef) {
    throw ApiError.badRequest('Dispatch proof is required before a circular resolution is opened (s.175).');
  }

  const updated = await prisma.resolution.update({
    where: { id: resolutionId },
    data: {
      outcome: 'open',
      circulatedOn: new Date(),
      dispatchProofRef: input.dispatchProofRef,
      votingClosesOn: input.votingClosesOn ?? null,
    },
  });

  await emit({
    name: EVENTS.RESOLUTION_CIRCULATED,
    subject: { entityType: 'resolution', entityId: resolutionId, recordCode: resolution.recordCode },
    newState: { dispatchProofRef: input.dispatchProofRef },
  });

  return updated;
}

/** True when this board member's declared interests name the resolution's subject. */
function isInterested(member: { interests: unknown }, resolution: { subjectRef: string | null }): boolean {
  if (!resolution.subjectRef) return false;
  const interests = (member.interests as Array<{ entity?: string }>) ?? [];
  return interests.some((i) => i.entity && i.entity.toLowerCase() === resolution.subjectRef!.toLowerCase());
}

export interface CastVoteInput {
  boardMemberId: string;
  choice: VoteChoice;
  /** True when the voter is interested in the subject matter — forces abstention (s.184). */
  interested?: boolean;
  demandsMeeting?: boolean;
}

export async function castVote(resolutionId: string, input: CastVoteInput) {
  await assertCan({ resource: 'resolutions', verb: 'approve' });
  const resolution = await getResolutionOrThrow(resolutionId);
  if (resolution.outcome !== 'open') {
    throw ApiError.unprocessable('This resolution is not open for voting.');
  }

  const member = await prisma.boardMember.findFirst({ where: { id: input.boardMemberId } });
  const abstainedAsInterested = Boolean(input.interested) || (member ? isInterested(member, resolution) : false);
  const choice: VoteChoice = abstainedAsInterested ? 'abstain' : input.choice;

  const vote = await prisma.vote.upsert({
    where: { resolutionId_boardMemberId: { resolutionId, boardMemberId: input.boardMemberId } },
    create: {
      tenantId: currentAuth().tenantId,
      resolutionId,
      boardMemberId: input.boardMemberId,
      choice,
      abstainedAsInterested,
      demandsMeeting: Boolean(input.demandsMeeting),
    },
    update: {
      choice,
      abstainedAsInterested,
      demandsMeeting: Boolean(input.demandsMeeting),
      castAt: new Date(),
    },
  });

  await emit({
    name: EVENTS.VOTE_CAST,
    subject: { entityType: 'vote', entityId: vote.id },
    related: [{ relation: 'resolution', entityType: 'resolution', entityId: resolutionId }],
    newState: { choice, abstainedAsInterested, demandsMeeting: Boolean(input.demandsMeeting) },
  });

  return vote;
}

export async function closeCirculation(resolutionId: string) {
  await assertCan({ resource: 'resolutions', verb: 'edit' });
  const resolution = await getResolutionOrThrow(resolutionId);
  if (resolution.passedBy !== 'circulation' || resolution.outcome !== 'open') {
    throw ApiError.unprocessable('Only an open circular resolution can be closed.');
  }

  const votes = await prisma.vote.findMany({ where: { resolutionId } });
  const memberCount = await activeVotingMemberCount();

  const demandCount = votes.filter((v) => v.demandsMeeting).length;
  const demandThreshold = meetingDemandThreshold(memberCount);

  if (demandCount >= demandThreshold && demandCount > 0) {
    const updated = await prisma.resolution.update({ where: { id: resolutionId }, data: { outcome: 'meeting_demanded' } });
    await emit({
      name: EVENTS.RESOLUTION_FAILED,
      subject: { entityType: 'resolution', entityId: resolutionId, recordCode: resolution.recordCode },
      newState: { outcome: 'meeting_demanded', demandCount, demandThreshold },
    });
    return updated;
  }

  const interestedCount = votes.filter((v) => v.abstainedAsInterested).length;
  const entitled = memberCount - interestedCount;
  const forCount = votes.filter((v) => v.choice === 'for').length;
  const passed = entitled > 0 && forCount > entitled / 2;

  const updated = await prisma.resolution.update({
    where: { id: resolutionId },
    data: { outcome: passed ? 'passed' : 'failed', passedOn: passed ? new Date() : null },
  });

  await emit({
    name: passed ? EVENTS.RESOLUTION_PASSED : EVENTS.RESOLUTION_FAILED,
    subject: { entityType: 'resolution', entityId: resolutionId, recordCode: resolution.recordCode },
    newState: { outcome: updated.outcome, forCount, entitled },
  });

  if (passed && resolution.kind === 'shareholder_special') {
    await raiseMgt14Item(resolution.id, resolution.recordCode, new Date());
  }

  return updated;
}

export interface PassAtMeetingVoteInput {
  boardMemberId: string;
  choice: VoteChoice;
  interested?: boolean;
}

export async function passAtMeeting(resolutionId: string, meetingId: string, votes: PassAtMeetingVoteInput[]) {
  await assertCan({ resource: 'resolutions', verb: 'edit' });
  const resolution = await getResolutionOrThrow(resolutionId);
  const meetingRow = await getMeetingOrThrow(meetingId);

  if (!meetingRow.heldOn) {
    throw ApiError.unprocessable('A resolution can be passed at a meeting only once that meeting has been held.');
  }

  const auth = currentAuth();
  const records: Array<{ choice: string; abstainedAsInterested: boolean }> = [];
  for (const v of votes) {
    const member = await prisma.boardMember.findFirst({ where: { id: v.boardMemberId } });
    const abstainedAsInterested = Boolean(v.interested) || (member ? isInterested(member, resolution) : false);
    const choice: VoteChoice = abstainedAsInterested ? 'abstain' : v.choice;
    const vote = await prisma.vote.upsert({
      where: { resolutionId_boardMemberId: { resolutionId, boardMemberId: v.boardMemberId } },
      create: { tenantId: auth.tenantId, resolutionId, boardMemberId: v.boardMemberId, choice, abstainedAsInterested },
      update: { choice, abstainedAsInterested, castAt: new Date() },
    });
    records.push(vote);
  }

  // s.184: a director marked interested is excluded from the count for this item.
  const counted = records.filter((v) => !v.abstainedAsInterested);
  const forCount = counted.filter((v) => v.choice === 'for').length;
  const againstCount = counted.filter((v) => v.choice === 'against').length;
  const passed = forCount > againstCount;

  const updated = await prisma.resolution.update({
    where: { id: resolutionId },
    data: {
      outcome: passed ? 'passed' : 'failed',
      passedOn: passed ? new Date() : null,
      meetingId,
      passedBy: 'meeting',
    },
  });

  await emit({
    name: passed ? EVENTS.RESOLUTION_PASSED : EVENTS.RESOLUTION_FAILED,
    subject: { entityType: 'resolution', entityId: resolutionId, recordCode: resolution.recordCode },
    newState: { outcome: updated.outcome, forCount, againstCount, meetingId },
  });

  if (passed && resolution.kind === 'shareholder_special') {
    await raiseMgt14Item(resolution.id, resolution.recordCode, new Date());
  }

  return updated;
}

export async function withdraw(resolutionId: string) {
  await assertCan({ resource: 'resolutions', verb: 'edit' });
  const resolution = await getResolutionOrThrow(resolutionId);
  if (!['draft', 'open'].includes(resolution.outcome)) {
    throw ApiError.unprocessable('Only a draft or open resolution can be withdrawn.');
  }

  const updated = await prisma.resolution.update({ where: { id: resolutionId }, data: { outcome: 'withdrawn' } });

  await emit({
    name: EVENTS.RESOLUTION_WITHDRAWN,
    subject: { entityType: 'resolution', entityId: resolutionId, recordCode: resolution.recordCode },
    newState: { outcome: 'withdrawn' },
  });

  return updated;
}

export async function recordMgt14(resolutionId: string, srn: string, filedOn: Date) {
  await assertCan({ resource: 'resolutions', verb: 'edit' });
  const resolution = await getResolutionOrThrow(resolutionId);

  const updated = await prisma.resolution.update({
    where: { id: resolutionId },
    data: { mgt14Srn: srn, mgt14FiledOn: filedOn },
  });

  await closeOpenComplianceItems({ kind: 'mgt14_30d', relatedType: 'resolution', relatedId: resolutionId, resolvedOn: filedOn, filedRef: srn });

  await auditWrite({
    action: 'update',
    subjectType: 'resolution',
    subjectId: resolutionId,
    after: { mgt14Srn: srn, mgt14FiledOn: filedOn },
    force: true,
  });

  return updated;
}

export async function listResolutions(filter: { outcome?: string; meetingId?: string } = {}) {
  await assertCan({ resource: 'resolutions', verb: 'view' });
  const auth = currentAuth();
  const resolutions = await prisma.resolution.findMany({
    where: { tenantId: auth.tenantId, ...(filter.outcome ? { outcome: filter.outcome } : {}), ...(filter.meetingId ? { meetingId: filter.meetingId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  const votes = await prisma.vote.findMany({ where: { resolutionId: { in: resolutions.map((r) => r.id) } } });
  const votesByResolution = new Map<string, typeof votes>();
  for (const v of votes) votesByResolution.set(v.resolutionId, [...(votesByResolution.get(v.resolutionId) ?? []), v]);
  return resolutions.map((r) => ({ ...r, votes: votesByResolution.get(r.id) ?? [] }));
}

export async function resolution(id: string) {
  await assertCan({ resource: 'resolutions', verb: 'view' });
  const r = await getResolutionOrThrow(id);
  const votes = await prisma.vote.findMany({ where: { resolutionId: id } });
  return { ...r, votes };
}

async function raiseMgt14Item(resolutionId: string, resolutionRecordCode: string, passedOn: Date) {
  await raiseComplianceItem({
    kind: 'mgt14_30d',
    title: `File MGT-14 for ${resolutionRecordCode}`,
    basis: 's.117/MGT-14: a special resolution must be filed within 30 days of passing.',
    dueOn: addDays(passedOn, 30),
    relatedType: 'resolution',
    relatedId: resolutionId,
  });
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

export async function complianceCalendar() {
  await assertCan({ resource: 'compliance', verb: 'view' });
  const auth = currentAuth();
  const items = await prisma.complianceItem.findMany({ where: { tenantId: auth.tenantId }, orderBy: { dueOn: 'asc' } });
  const now = new Date();
  return items.map((i) => ({ ...i, overdue: i.status === 'open' && i.dueOn < now }));
}

export interface ResolveComplianceItemInput {
  filedRef?: string;
  waived?: boolean;
  reason?: string;
}

export async function resolveComplianceItem(id: string, input: ResolveComplianceItemInput) {
  await assertCan({ resource: 'compliance', verb: 'edit' });
  const item = await prisma.complianceItem.findFirst({ where: { id } });
  if (!item) throw ApiError.notFound('Compliance item');
  if (input.waived && !input.reason) {
    throw ApiError.badRequest('Waiving a compliance item needs a reason on record.');
  }

  const updated = await prisma.complianceItem.update({
    where: { id },
    data: {
      status: input.waived ? 'waived' : 'done',
      resolvedOn: new Date(),
      filedRef: input.waived ? (input.reason ?? null) : (input.filedRef ?? item.filedRef),
    },
  });

  await emit({
    name: EVENTS.COMPLIANCE_ITEM_RESOLVED,
    subject: { entityType: 'compliance_item', entityId: id, recordCode: item.recordCode },
    newState: { status: updated.status },
  });

  return updated;
}

async function closeOpenComplianceItems(input: { kind: string; relatedType: string; relatedId: string; resolvedOn: Date; filedRef: string | null }) {
  const auth = currentAuth();
  const open = await prisma.complianceItem.findMany({
    where: { tenantId: auth.tenantId, kind: input.kind, relatedType: input.relatedType, relatedId: input.relatedId, status: 'open' },
  });
  for (const item of open) {
    await prisma.complianceItem.update({
      where: { id: item.id },
      data: { status: 'done', resolvedOn: input.resolvedOn, filedRef: input.filedRef ?? item.filedRef },
    });
    await emit({
      name: EVENTS.COMPLIANCE_ITEM_RESOLVED,
      subject: { entityType: 'compliance_item', entityId: item.id, recordCode: item.recordCode },
      newState: { status: 'done' },
    });
  }
}

interface RaiseComplianceItemInput {
  kind: string;
  title: string;
  basis: string;
  dueOn: Date;
  relatedType: string;
  relatedId: string;
}

/** Idempotent: the same (kind, relatedType, relatedId, dueOn) tuple writes once, ever. */
async function raiseComplianceItem(input: RaiseComplianceItemInput): Promise<void> {
  const auth = currentAuth();
  const existing = await prisma.complianceItem.findFirst({
    where: { tenantId: auth.tenantId, kind: input.kind, relatedType: input.relatedType, relatedId: input.relatedId, dueOn: input.dueOn },
  });
  if (existing) return;

  const recordCode = await nextRecordCode('CPL');
  const item = await prisma.complianceItem.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      kind: input.kind,
      title: input.title,
      basis: input.basis,
      dueOn: input.dueOn,
      relatedType: input.relatedType,
      relatedId: input.relatedId,
      raisedByJob: true,
    },
  });

  await emit({
    name: EVENTS.COMPLIANCE_ITEM_RAISED,
    subject: { entityType: 'compliance_item', entityId: item.id, recordCode },
    newState: { kind: input.kind, dueOn: input.dueOn },
  });
}

// ---------------------------------------------------------------------------
// The daily compliance job. Runs inside `asSystem(tenantId, …)` from the
// scheduler, so `currentAuth().tenantId` is already the tenant being swept.
// ---------------------------------------------------------------------------

export async function runBoardComplianceJob(): Promise<number> {
  const auth = currentAuth();
  const profile = await prisma.companyProfile.findFirst({ where: { tenantId: auth.tenantId } });
  let raised = 0;

  raised += await sweepMeetingGap(profile);
  raised += await sweepMinutesTimelines();
  raised += await sweepMbp1(profile);
  raised += await sweepAgmDue(profile);
  raised += await sweepMgt14();

  return raised;
}

async function sweepMeetingGap(profile: { isSmallCompany: boolean | null; incorporatedOn: Date | null } | null): Promise<number> {
  const auth = currentAuth();
  const lastHeld = await prisma.boardMeeting.findFirst({
    where: { tenantId: auth.tenantId, kind: 'board', heldOn: { not: null } },
    orderBy: { heldOn: 'desc' },
  });

  if (!lastHeld) {
    // Say what is known: with no meeting recorded and no incorporation date on
    // file, there is nothing to compute a due date from — never a fabricated
    // "overdue".
    if (!profile?.incorporatedOn) return 0;
    await raiseComplianceItem({
      kind: 'board_first_meeting',
      title: 'Hold the first board meeting',
      basis: 's.173: the first board meeting is due within 30 days of incorporation.',
      dueOn: addDays(profile.incorporatedOn, 30),
      relatedType: 'tenant',
      relatedId: auth.tenantId,
    });
    return 1;
  }

  const isSmall = profile?.isSmallCompany === true;
  if (isSmall) {
    await raiseComplianceItem({
      kind: 'board_meeting_gap',
      title: 'Hold the next half-yearly board meeting',
      basis: 'SS-1 (small company): at least one board meeting every half-year, with at least 90 days between meetings.',
      dueOn: addDays(lastHeld.heldOn!, 180),
      relatedType: 'tenant',
      relatedId: auth.tenantId,
    });
  } else {
    await raiseComplianceItem({
      kind: 'board_meeting_gap',
      title: 'Hold the next board meeting',
      basis: 'SS-1/s.173: no more than 120 days between two board meetings.',
      dueOn: addDays(lastHeld.heldOn!, 120),
      relatedType: 'tenant',
      relatedId: auth.tenantId,
    });
  }
  return 1;
}

async function sweepMinutesTimelines(): Promise<number> {
  const auth = currentAuth();
  const held = await prisma.boardMeeting.findMany({ where: { tenantId: auth.tenantId, heldOn: { not: null } } });
  let raised = 0;
  for (const m of held) {
    if (!m.minutesDraftedOn) {
      await raiseComplianceItem({
        kind: 'minutes_draft_15d',
        title: `Draft minutes for ${m.recordCode}`,
        basis: 'SS-1: draft minutes are due within 15 days of the meeting.',
        dueOn: addDays(m.heldOn!, 15),
        relatedType: 'board_meeting',
        relatedId: m.id,
      });
      raised += 1;
    }
    if (!m.minutesEnteredOn) {
      await raiseComplianceItem({
        kind: 'minutes_entry_30d',
        title: `Enter minutes for ${m.recordCode}`,
        basis: 'SS-1/s.118: minutes must be entered in the book within 30 days of the meeting.',
        dueOn: addDays(m.heldOn!, 30),
        relatedType: 'board_meeting',
        relatedId: m.id,
      });
      raised += 1;
    }
  }
  return raised;
}

function financialYearWindow(fyEnd: Date, at: Date): { start: Date; end: Date } {
  // fyEnd carries only month/day meaningfully; the FY containing `at` ends at
  // the next occurrence of that month/day on or after `at`.
  const end = new Date(Date.UTC(at.getUTCFullYear(), fyEnd.getUTCMonth(), fyEnd.getUTCDate()));
  if (end < at) end.setUTCFullYear(end.getUTCFullYear() + 1);
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  start.setUTCDate(start.getUTCDate() + 1);
  return { start, end };
}

async function sweepMbp1(profile: { financialYearEnd: Date | null } | null): Promise<number> {
  const auth = currentAuth();
  const now = new Date();
  const fyEnd = profile?.financialYearEnd ?? new Date(Date.UTC(now.getUTCFullYear(), 2, 31)); // 31 March fallback
  const { start, end } = financialYearWindow(fyEnd, now);

  const members = await prisma.boardMember.findMany({
    where: { tenantId: auth.tenantId, status: 'active', role: { in: VOTING_BOARD_ROLES } },
  });

  let raised = 0;
  for (const m of members) {
    const declaredThisFy = m.interestsDeclaredOn && m.interestsDeclaredOn >= start && m.interestsDeclaredOn <= end;
    if (declaredThisFy) continue;
    await raiseComplianceItem({
      kind: 'mbp1_annual',
      title: `Annual interest declaration for ${m.recordCode}`,
      basis: 's.184/MBP-1: every director declares their interests once each financial year.',
      dueOn: end,
      relatedType: 'board_member',
      relatedId: m.id,
    });
    raised += 1;
  }
  return raised;
}

async function sweepAgmDue(profile: { financialYearEnd: Date | null; incorporatedOn: Date | null } | null): Promise<number> {
  if (!profile?.financialYearEnd) return 0;
  const auth = currentAuth();
  const now = new Date();
  const { start, end: fyEnd } = financialYearWindow(profile.financialYearEnd, now);

  const heldAgm = await prisma.boardMeeting.findFirst({
    where: { tenantId: auth.tenantId, kind: 'agm', heldOn: { gte: start, lte: fyEnd } },
  });
  if (heldAgm) return 0;

  const isFirstFy = profile.incorporatedOn ? profile.incorporatedOn >= start && profile.incorporatedOn <= fyEnd : false;
  const monthsAllowed = isFirstFy ? 9 : 6;
  const dueOn = new Date(fyEnd);
  dueOn.setUTCMonth(dueOn.getUTCMonth() + monthsAllowed);

  await raiseComplianceItem({
    kind: 'agm_due',
    title: 'Hold the annual general meeting',
    basis: `s.96: the AGM is due within ${monthsAllowed} months of the financial year end.`,
    dueOn,
    relatedType: 'tenant',
    relatedId: auth.tenantId,
  });
  return 1;
}

async function sweepMgt14(): Promise<number> {
  const auth = currentAuth();
  const resolutions = await prisma.resolution.findMany({
    where: { tenantId: auth.tenantId, kind: 'shareholder_special', outcome: 'passed', mgt14FiledOn: null, passedOn: { not: null } },
  });
  let raised = 0;
  for (const r of resolutions) {
    await raiseMgt14Item(r.id, r.recordCode, r.passedOn!);
    raised += 1;
  }
  return raised;
}
