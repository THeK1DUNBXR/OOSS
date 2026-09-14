/**
 * Board minutes — a meeting and its resolutions, distinct from `Decision`
 * (business governance) on purpose: a board resolution is a statutory
 * record, and once its meeting is `recorded` it is immutable (CMP-COR-003).
 * A correction is a new resolution referencing the one it corrects.
 */

import type { BoardMeetingKind, BoardResolutionKind } from '@kaizen/shared';
import { prisma } from '../../../platform/db.js';
import { currentAuth } from '../../../platform/context.js';
import { ApiError } from '../../../platform/errors.js';
import { assertCan } from '../../../platform/permissions.js';
import { auditWrite } from '../../../platform/audit.js';
import { nextCorporateCode } from './codes.js';

export async function listBoardMeetings() {
  await assertCan({ resource: 'board_resolutions', verb: 'view' });
  const auth = currentAuth();
  return prisma.complianceBoardMeeting.findMany({
    where: { tenantId: auth.tenantId },
    include: { resolutions: { orderBy: { number: 'asc' } } },
    orderBy: { heldOn: 'desc' },
  });
}

export async function getBoardMeeting(id: string) {
  await assertCan({ resource: 'board_resolutions', verb: 'view' });
  const auth = currentAuth();
  const meeting = await prisma.complianceBoardMeeting.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { resolutions: { orderBy: { number: 'asc' } } },
  });
  if (!meeting) throw ApiError.notFound('Board meeting');
  return meeting;
}

export async function createBoardMeeting(input: {
  kind: BoardMeetingKind;
  heldOn: Date;
  noticeOn?: Date | null;
  quorum?: string | null;
  attendees?: unknown[];
}) {
  await assertCan({ resource: 'board_resolutions', verb: 'create' });
  const auth = currentAuth();
  const recordCode = await nextCorporateCode('BM');
  const meeting = await prisma.complianceBoardMeeting.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      kind: input.kind,
      heldOn: input.heldOn,
      noticeOn: input.noticeOn ?? null,
      quorum: input.quorum ?? null,
      attendees: (input.attendees ?? []) as never,
      status: 'draft',
      createdById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'board_meeting', subjectId: meeting.id, after: { recordCode, kind: input.kind } });
  return meeting;
}

/** Draft-only: minutes are the working text until the meeting is recorded. */
export async function updateBoardMeetingMinutes(id: string, minutes: string) {
  await assertCan({ resource: 'board_resolutions', verb: 'edit' });
  const auth = currentAuth();
  const meeting = await prisma.complianceBoardMeeting.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!meeting) throw ApiError.notFound('Board meeting');
  if (meeting.status !== 'draft') {
    throw ApiError.unprocessable('Minutes are only editable while the meeting is a draft. A recorded meeting is final — add a resolution instead.');
  }
  const updated = await prisma.complianceBoardMeeting.update({ where: { id }, data: { minutes } });
  await auditWrite({ action: 'update', subjectType: 'board_meeting', subjectId: id, before: { minutes: meeting.minutes }, after: { minutes } });
  return updated;
}

/** CMP-COR-003: once recorded, a meeting's resolutions are final — recording is one-way. */
export async function recordBoardMeeting(id: string) {
  await assertCan({ resource: 'board_resolutions', verb: 'edit' });
  const auth = currentAuth();
  const meeting = await prisma.complianceBoardMeeting.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!meeting) throw ApiError.notFound('Board meeting');
  if (meeting.status === 'recorded') return meeting;

  const updated = await prisma.complianceBoardMeeting.update({ where: { id }, data: { status: 'recorded' } });
  await auditWrite({ action: 'update', subjectType: 'board_meeting', subjectId: id, before: { status: 'draft' }, after: { status: 'recorded' } });
  return updated;
}

/**
 * Adds a resolution. Permitted any time before the meeting is recorded, and
 * afterwards only as a correction — `correctsId` naming the resolution it
 * corrects, which itself must belong to a recorded meeting (a correction to
 * a draft resolution is just an edit, made directly).
 */
export async function addBoardResolution(input: {
  meetingId: string;
  subject: string;
  text: string;
  kind: BoardResolutionKind;
  passedOn: Date;
  correctsId?: string | null;
}) {
  await assertCan({ resource: 'board_resolutions', verb: 'create' });
  const auth = currentAuth();
  const meeting = await prisma.complianceBoardMeeting.findFirst({ where: { id: input.meetingId, tenantId: auth.tenantId } });
  if (!meeting) throw ApiError.notFound('Board meeting');

  if (meeting.status === 'recorded' && !input.correctsId) {
    throw ApiError.unprocessable('This meeting is recorded. A new resolution against it must name the resolution it corrects (correctsId) — a recorded meeting\'s resolutions are immutable.');
  }

  if (input.correctsId) {
    const corrected = await prisma.complianceBoardResolution.findFirst({ where: { id: input.correctsId, tenantId: auth.tenantId } });
    if (!corrected) throw ApiError.notFound('Resolution to correct');
  }

  const last = await prisma.complianceBoardResolution.findFirst({
    where: { tenantId: auth.tenantId, meetingId: input.meetingId },
    orderBy: { number: 'desc' },
  });
  const number = (last?.number ?? 0) + 1;
  const recordCode = await nextCorporateCode('BR');

  const resolution = await prisma.complianceBoardResolution.create({
    data: {
      tenantId: auth.tenantId,
      meetingId: input.meetingId,
      recordCode,
      number,
      subject: input.subject,
      text: input.text,
      kind: input.kind,
      passedOn: input.passedOn,
      correctsId: input.correctsId ?? null,
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'board_resolution', subjectId: resolution.id, after: { recordCode, meetingId: input.meetingId, number } });
  return resolution;
}
