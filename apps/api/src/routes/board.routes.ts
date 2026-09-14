/**
 * Board routes (equity-portal plan §6, phase 3). Thin zod → domain.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  BOARD_MEMBER_ROLES,
  BOARD_PACK_ITEM_KINDS,
  MEETING_KINDS,
  MEETING_MODES,
  RESOLUTION_KINDS,
  RESOLUTION_SUBJECTS,
  VOTE_CHOICES,
} from '@kaizen/shared';
import { handler } from '../lib/http.js';
import {
  addBoardMember,
  ceaseBoardMember,
  declareInterests,
  listBoardMembers,
  callMeeting,
  updateAgenda,
  recordAttendance,
  markHeld,
  draftMinutes,
  circulateMinutes,
  enterMinutes,
  signMinutes,
  cancelMeeting,
  listMeetings,
  meeting,
  addBoardPackItem,
  boardPack,
  proposeResolution,
  openForCirculation,
  castVote,
  closeCirculation,
  passAtMeeting,
  withdraw,
  recordMgt14,
  listResolutions,
  resolution,
  complianceCalendar,
  resolveComplianceItem,
} from '../domains/board.js';

const router = Router();

// --- Members ---------------------------------------------------------------

router.get('/members', handler(async () => ({ items: await listBoardMembers() })));

router.post(
  '/members',
  handler(async (req) => {
    const body = z
      .object({
        personId: z.string(),
        role: z.enum(BOARD_MEMBER_ROLES),
        din: z.string().optional(),
        appointedOn: z.coerce.date(),
        nominatedByHolderRef: z.string().optional(),
      })
      .parse(req.body);
    return addBoardMember(body);
  }),
);

router.post(
  '/members/:id/cease',
  handler(async (req) => {
    const body = z.object({ ceasedOn: z.coerce.date().optional() }).parse(req.body ?? {});
    return ceaseBoardMember(req.params.id, body.ceasedOn);
  }),
);

router.post(
  '/members/:id/interests',
  handler(async (req) => {
    const body = z
      .object({
        interests: z.array(z.object({ entity: z.string(), nature: z.string(), since: z.string().optional() })).optional(),
        declaredOn: z.coerce.date().optional(),
      })
      .parse(req.body ?? {});
    return declareInterests(req.params.id, body);
  }),
);

// --- Meetings ----------------------------------------------------------------

router.get('/meetings', handler(async () => ({ items: await listMeetings() })));

router.post(
  '/meetings',
  handler(async (req) => {
    const body = z
      .object({
        kind: z.enum(MEETING_KINDS),
        title: z.string(),
        scheduledFor: z.coerce.date(),
        noticeSentOn: z.coerce.date().optional(),
        mode: z.enum(MEETING_MODES),
        venue: z.string().optional(),
        shortNoticeConsent: z.object({ reason: z.string() }).optional(),
      })
      .parse(req.body);
    return callMeeting(body);
  }),
);

router.get('/meetings/:id', handler(async (req) => meeting(req.params.id)));

router.post(
  '/meetings/:id/agenda',
  handler(async (req) => {
    const body = z
      .array(z.object({ n: z.number(), title: z.string(), notes: z.string().optional(), resolutionId: z.string().optional() }))
      .parse((req.body as { agenda?: unknown }).agenda ?? req.body);
    return updateAgenda(req.params.id, body);
  }),
);

router.post(
  '/meetings/:id/attendance',
  handler(async (req) => {
    const body = z
      .array(z.object({ boardMemberId: z.string(), present: z.boolean(), via: z.enum(MEETING_MODES).optional() }))
      .parse((req.body as { attendees?: unknown }).attendees ?? req.body);
    return recordAttendance(req.params.id, body);
  }),
);

router.post(
  '/meetings/:id/held',
  handler(async (req) => {
    const body = z.object({ heldOn: z.coerce.date().optional() }).parse(req.body ?? {});
    return markHeld(req.params.id, body.heldOn);
  }),
);

router.post(
  '/meetings/:id/minutes/draft',
  handler(async (req) => {
    const body = z.object({ text: z.string(), documentRef: z.string().optional() }).parse(req.body);
    return draftMinutes(req.params.id, body);
  }),
);

router.post('/meetings/:id/minutes/circulate', handler(async (req) => circulateMinutes(req.params.id)));

router.post(
  '/meetings/:id/minutes/enter',
  handler(async (req) => {
    const body = z.object({ late: z.boolean().optional(), reason: z.string().optional() }).parse(req.body ?? {});
    return enterMinutes(req.params.id, body);
  }),
);

router.post(
  '/meetings/:id/minutes/sign',
  handler(async (req) => {
    const body = z.object({ documentRef: z.string().optional() }).parse(req.body ?? {});
    return signMinutes(req.params.id, body.documentRef);
  }),
);

router.post(
  '/meetings/:id/cancel',
  handler(async (req) => {
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    return cancelMeeting(req.params.id, body.reason);
  }),
);

router.post(
  '/meetings/:id/pack',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string(),
        kind: z.enum(BOARD_PACK_ITEM_KINDS),
        fileRef: z.string(),
        order: z.number().optional(),
      })
      .parse(req.body);
    return addBoardPackItem(req.params.id, body);
  }),
);

router.get('/meetings/:id/pack', handler(async (req) => boardPack(req.params.id)));

// --- Resolutions -------------------------------------------------------------

router.get(
  '/resolutions',
  handler(async (req) => ({
    items: await listResolutions({
      outcome: typeof req.query.outcome === 'string' ? req.query.outcome : undefined,
      meetingId: typeof req.query.meetingId === 'string' ? req.query.meetingId : undefined,
    }),
  })),
);

router.post(
  '/resolutions',
  handler(async (req) => {
    const body = z
      .object({
        kind: z.enum(RESOLUTION_KINDS),
        subject: z.enum(RESOLUTION_SUBJECTS),
        title: z.string(),
        text: z.string(),
        passedBy: z.enum(['meeting', 'circulation']),
        meetingId: z.string().optional(),
        subjectRef: z.string().optional(),
      })
      .parse(req.body);
    return proposeResolution(body);
  }),
);

router.get('/resolutions/:id', handler(async (req) => resolution(req.params.id)));

router.post(
  '/resolutions/:id/circulate',
  handler(async (req) => {
    const body = z.object({ dispatchProofRef: z.string(), votingClosesOn: z.coerce.date().optional() }).parse(req.body);
    return openForCirculation(req.params.id, body);
  }),
);

router.post(
  '/resolutions/:id/vote',
  handler(async (req) => {
    const body = z
      .object({
        boardMemberId: z.string(),
        choice: z.enum(VOTE_CHOICES),
        interested: z.boolean().optional(),
        demandsMeeting: z.boolean().optional(),
      })
      .parse(req.body);
    return castVote(req.params.id, body);
  }),
);

router.post('/resolutions/:id/close', handler(async (req) => closeCirculation(req.params.id)));

router.post(
  '/resolutions/:id/pass',
  handler(async (req) => {
    const body = z
      .object({
        meetingId: z.string(),
        votes: z.array(z.object({ boardMemberId: z.string(), choice: z.enum(VOTE_CHOICES), interested: z.boolean().optional() })),
      })
      .parse(req.body);
    return passAtMeeting(req.params.id, body.meetingId, body.votes);
  }),
);

router.post('/resolutions/:id/withdraw', handler(async (req) => withdraw(req.params.id)));

router.post(
  '/resolutions/:id/mgt14',
  handler(async (req) => {
    const body = z.object({ srn: z.string(), filedOn: z.coerce.date() }).parse(req.body);
    return recordMgt14(req.params.id, body.srn, body.filedOn);
  }),
);

// --- Compliance ----------------------------------------------------------------

router.get('/compliance', handler(async () => ({ items: await complianceCalendar() })));

router.post(
  '/compliance/:id/resolve',
  handler(async (req) => {
    const body = z.object({ filedRef: z.string().optional(), waived: z.boolean().optional(), reason: z.string().optional() }).parse(req.body ?? {});
    return resolveComplianceItem(req.params.id, body);
  }),
);

export default router;
