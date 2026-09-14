/**
 * HCM — learning (docs/hcm/learning.md). Mounted at /api/hcm/learning.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str, bool } from '../../lib/http.js';
import {
  listPrograms, getProgram, createProgram, setProgramActive,
  listSessions, createSession, setSessionStatus,
  listEnrollments, nominate, approveEnrollment, rejectEnrollment, markAttendance, completeEnrollment,
  listCertifications, addCertification, verifyCertification, runCertificationExpiryLadder,
  listMandatoryRules, createMandatoryRule, mandatoryComplianceStatus, runMandatoryTrainingOverdueCheck,
  listIdps, createIdp, updateIdp,
  listBudgets, createBudget,
} from '../../domains/hcm/learning.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'learning', ready: true })));

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

router.get('/programs', handler(async (req) => listPrograms(bool(req.query.activeOnly))));
router.get('/programs/:id', handler(async (req) => getProgram(req.params.id)));

router.post(
  '/programs',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        kind: z.enum(['classroom', 'online', 'certification', 'mandatory']),
        provider: z.string().nullish(),
        durationHours: z.number().nonnegative().nullish(),
        cost: z.number().nonnegative().optional(),
        skillIds: z.array(z.string()).optional(),
        validityMonths: z.number().int().positive().nullish(),
      })
      .parse(req.body);
    return createProgram(body);
  }),
);

router.patch(
  '/programs/:id',
  handler(async (req) => {
    const body = z.object({ isActive: z.boolean() }).parse(req.body);
    return setProgramActive(req.params.id, body.isActive);
  }),
);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

router.get('/sessions', handler(async (req) => listSessions(str(req.query.programId))));

router.post(
  '/sessions',
  handler(async (req) => {
    const body = z
      .object({
        programId: z.string().min(1),
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date(),
        trainer: z.string().nullish(),
        seats: z.number().int().nonnegative().optional(),
        location: z.string().nullish(),
        link: z.string().nullish(),
      })
      .parse(req.body);
    return createSession(body);
  }),
);

router.post(
  '/sessions/:id/status',
  handler(async (req) => {
    const body = z.object({ status: z.enum(['completed', 'cancelled']) }).parse(req.body);
    return setSessionStatus(req.params.id, body.status);
  }),
);

// ---------------------------------------------------------------------------
// Enrollments
// ---------------------------------------------------------------------------

router.get(
  '/enrollments',
  handler(async (req) => listEnrollments({ sessionId: str(req.query.sessionId), employmentRelationshipId: str(req.query.employmentRelationshipId) })),
);

router.post(
  '/enrollments',
  handler(async (req) => {
    const body = z.object({ sessionId: z.string().min(1), employmentRelationshipId: z.string().min(1) }).parse(req.body);
    return nominate(body);
  }),
);

router.post('/enrollments/:id/approve', handler(async (req) => approveEnrollment(req.params.id)));

router.post(
  '/enrollments/:id/reject',
  handler(async (req) => {
    const body = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    return rejectEnrollment(req.params.id, body.note);
  }),
);

router.post(
  '/enrollments/:id/attendance',
  handler(async (req) => {
    const body = z.object({ attended: z.boolean() }).parse(req.body);
    return markAttendance(req.params.id, body.attended);
  }),
);

router.post(
  '/enrollments/:id/complete',
  handler(async (req) => {
    const body = z.object({ score: z.number().nullish(), feedback: z.string().nullish() }).parse(req.body ?? {});
    return completeEnrollment(req.params.id, body);
  }),
);

// ---------------------------------------------------------------------------
// Certifications
// ---------------------------------------------------------------------------

router.get('/certifications', handler(async (req) => listCertifications(str(req.query.employmentRelationshipId))));

router.post(
  '/certifications',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string().min(1),
        name: z.string().min(1),
        issuer: z.string().nullish(),
        issuedOn: z.coerce.date(),
        expiresOn: z.coerce.date().nullish(),
        documentRef: z.string().nullish(),
      })
      .parse(req.body);
    return addCertification(body);
  }),
);

router.post('/certifications/:id/verify', handler(async (req) => verifyCertification(req.params.id)));
router.post('/certifications/expiry-check', handler(async () => runCertificationExpiryLadder()));

// ---------------------------------------------------------------------------
// Mandatory training
// ---------------------------------------------------------------------------

router.get('/mandatory-rules', handler(async () => listMandatoryRules()));

router.post(
  '/mandatory-rules',
  handler(async (req) => {
    const body = z
      .object({
        programId: z.string().min(1),
        dueWithinDaysOfJoin: z.number().int().nonnegative().nullish(),
        recurrenceMonths: z.number().int().positive().nullish(),
      })
      .parse(req.body);
    return createMandatoryRule(body);
  }),
);

router.get('/mandatory-status', handler(async () => mandatoryComplianceStatus()));
router.post('/mandatory-rules/overdue-check', handler(async () => runMandatoryTrainingOverdueCheck()));

// ---------------------------------------------------------------------------
// IDPs
// ---------------------------------------------------------------------------

router.get('/idps', handler(async (req) => listIdps(str(req.query.employmentRelationshipId))));

router.post(
  '/idps',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string().min(1),
        goals: z.unknown(),
        mentorId: z.string().nullish(),
        reviewDate: z.coerce.date().nullish(),
      })
      .parse(req.body);
    return createIdp({ ...body, goals: body.goals ?? {} });
  }),
);

router.patch(
  '/idps/:id',
  handler(async (req) => {
    const body = z
      .object({
        goals: z.unknown().optional(),
        mentorId: z.string().nullish(),
        reviewDate: z.coerce.date().nullish(),
        status: z.enum(['active', 'closed']).optional(),
      })
      .parse(req.body);
    return updateIdp(req.params.id, body);
  }),
);

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

router.get('/budgets', handler(async (req) => listBudgets(str(req.query.fy))));

router.post(
  '/budgets',
  handler(async (req) => {
    const body = z.object({ fy: z.string().min(1), division: z.string().nullish(), amount: z.number().nonnegative() }).parse(req.body);
    return createBudget(body);
  }),
);

export default router;
