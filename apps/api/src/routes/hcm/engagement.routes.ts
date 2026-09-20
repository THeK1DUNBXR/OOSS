/**
 * HCM — WS9 engagement (docs/hcm/engagement.md). Mounted at /api/hcm/engagement.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler } from '../../lib/http.js';
import {
  createAnnouncement,
  publishAnnouncement,
  withdrawAnnouncement,
  listAnnouncements,
  acknowledgeAnnouncement,
  announcementAcks,
  giveRecognition,
  listRecognitions,
  recognitionLeaderboard,
  createPulseSurvey,
  openPulseSurvey,
  closePulseSurvey,
  listPulseSurveys,
  submitSurveyResponse,
  pulseSurveyResults,
  createHrCase,
  listHrCases,
  listConfidentialHrCases,
  getHrCase,
  addHrCaseMessage,
  assignHrCase,
  transitionHrCase,
  createPolicyDocument,
  publishPolicyDocument,
  listPolicyDocuments,
  acknowledgePolicyDocument,
  policyAckStatus,
  createExitInterview,
  listExitInterviews,
  exitInterviewThemeSummary,
  myEngagementHome,
} from '../../domains/hcm/engagement.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'engagement', ready: true })));

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

const audienceSchema = z.object({
  audienceType: z.enum(['all', 'division', 'org_unit', 'location']).optional(),
  audienceDivision: z.string().nullish(),
  audienceOrgUnitId: z.string().nullish(),
  audienceLocation: z.string().nullish(),
});

router.get('/announcements', handler(async () => listAnnouncements()));

router.post(
  '/announcements',
  handler(async (req) => {
    const body = audienceSchema
      .extend({
        title: z.string().min(1),
        body: z.string().min(1),
        publishAt: z.coerce.date().optional(),
        expiresAt: z.coerce.date().nullish(),
        pinned: z.boolean().optional(),
        acknowledgementRequired: z.boolean().optional(),
        publishNow: z.boolean().optional(),
      })
      .parse(req.body);
    return createAnnouncement(body);
  }),
);

router.post('/announcements/:id/publish', handler(async (req) => publishAnnouncement(req.params.id)));
router.post('/announcements/:id/withdraw', handler(async (req) => withdrawAnnouncement(req.params.id)));
router.post('/announcements/:id/ack', handler(async (req) => acknowledgeAnnouncement(req.params.id)));
router.get('/announcements/:id/acks', handler(async (req) => announcementAcks(req.params.id)));

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

router.get('/recognitions', handler(async () => listRecognitions()));

router.post(
  '/recognitions',
  handler(async (req) => {
    const body = z
      .object({
        toPartyId: z.string().min(1),
        badge: z.string().min(1),
        message: z.string().min(1),
        points: z.number().int().min(0).optional(),
        public: z.boolean().optional(),
      })
      .parse(req.body);
    return giveRecognition(body);
  }),
);

router.get('/recognitions/leaderboard', handler(async (req) => recognitionLeaderboard(req.query.limit ? Number(req.query.limit) : undefined)));

// ---------------------------------------------------------------------------
// Pulse surveys
// ---------------------------------------------------------------------------

const surveyQuestionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['scale', 'text', 'enps']),
  text: z.string().min(1),
  scaleMax: z.number().int().positive().optional(),
});

router.get('/surveys', handler(async () => listPulseSurveys()));

router.post(
  '/surveys',
  handler(async (req) => {
    const body = audienceSchema
      .extend({
        title: z.string().min(1),
        questions: z.array(surveyQuestionSchema).min(1),
        anonymous: z.boolean().optional(),
        opensAt: z.coerce.date(),
        closesAt: z.coerce.date(),
      })
      .parse(req.body);
    return createPulseSurvey(body);
  }),
);

router.post('/surveys/:id/open', handler(async (req) => openPulseSurvey(req.params.id)));
router.post('/surveys/:id/close', handler(async (req) => closePulseSurvey(req.params.id)));

router.post(
  '/surveys/:id/responses',
  handler(async (req) => {
    const body = z
      .object({
        answers: z.array(z.object({ questionId: z.string(), value: z.union([z.number(), z.string()]) })),
      })
      .parse(req.body);
    return submitSurveyResponse(req.params.id, body.answers);
  }),
);

router.get('/surveys/:id/results', handler(async (req) => pulseSurveyResults(req.params.id)));

// ---------------------------------------------------------------------------
// HR helpdesk cases
// ---------------------------------------------------------------------------

router.get('/hr-cases', handler(async () => listHrCases()));
router.get('/hr-cases/confidential', handler(async () => listConfidentialHrCases()));

router.post(
  '/hr-cases',
  handler(async (req) => {
    const body = z
      .object({
        category: z.enum(['payroll', 'leave', 'policy', 'it', 'grievance', 'other']),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        subject: z.string().min(1),
        body: z.string().min(1),
        confidential: z.boolean().optional(),
      })
      .parse(req.body);
    return createHrCase(body);
  }),
);

router.get('/hr-cases/:id', handler(async (req) => getHrCase(req.params.id)));

router.post(
  '/hr-cases/:id/messages',
  handler(async (req) => {
    const body = z.object({ body: z.string().min(1) }).parse(req.body);
    return addHrCaseMessage(req.params.id, body.body);
  }),
);

router.post(
  '/hr-cases/:id/assign',
  handler(async (req) => {
    const body = z.object({ assigneePartyId: z.string().min(1) }).parse(req.body);
    return assignHrCase(req.params.id, body.assigneePartyId);
  }),
);

router.post(
  '/hr-cases/:id/transition',
  handler(async (req) => {
    const body = z.object({ status: z.enum(['open', 'in_progress', 'waiting', 'resolved', 'closed']), note: z.string().optional() }).parse(req.body);
    return transitionHrCase(req.params.id, body.status, body.note);
  }),
);

// ---------------------------------------------------------------------------
// Policy documents
// ---------------------------------------------------------------------------

router.get('/policies', handler(async () => listPolicyDocuments()));

router.post(
  '/policies',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        version: z.string().min(1),
        body: z.string().min(1),
        effectiveFrom: z.coerce.date(),
        acknowledgementRequired: z.boolean().optional(),
      })
      .parse(req.body);
    return createPolicyDocument(body);
  }),
);

router.post('/policies/:id/publish', handler(async (req) => publishPolicyDocument(req.params.id)));
router.post('/policies/:id/ack', handler(async (req) => acknowledgePolicyDocument(req.params.id)));
router.get('/policies/:id/status', handler(async (req) => policyAckStatus(req.params.id)));

// ---------------------------------------------------------------------------
// Exit interviews
// ---------------------------------------------------------------------------

router.get('/exit-interviews', handler(async () => listExitInterviews()));
router.get('/exit-interviews/themes', handler(async () => exitInterviewThemeSummary()));

router.post(
  '/exit-interviews',
  handler(async (req) => {
    const body = z
      .object({
        offboardingId: z.string().min(1),
        employmentRelationshipId: z.string().min(1),
        questionnaire: z.array(z.object({ question: z.string(), answer: z.string() })),
        themes: z.array(z.string()).optional(),
      })
      .parse(req.body);
    return createExitInterview(body);
  }),
);

// ---------------------------------------------------------------------------
// /me/home
// ---------------------------------------------------------------------------

router.get('/me/home', handler(async () => myEngagementHome()));

export default router;
