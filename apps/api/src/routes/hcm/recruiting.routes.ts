/**
 * HCM — recruiting (docs/hcm/recruiting.md). Mounted at /api/hcm/recruiting.
 *
 * A full ATS on top of the existing `/api/hr/requisitions` and
 * `/api/hr/applications` machines — this router never re-implements those,
 * it reads `requisitionId`/`applicationId` off records that belong to it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { jobPostingMachine, offerMachine } from '@kaizen/shared';
import type { JobPostingEvent, OfferEvent } from '@kaizen/shared';
import { handler, str } from '../../lib/http.js';
import {
  listJobPostings, createJobPosting, transitionJobPosting,
  listCandidates, createCandidate,
  listInterviewRounds, scheduleInterview, completeInterview,
  submitScorecard, listScorecards,
  listOffers, createOffer, transitionOffer, joinAndOnboard,
  listReferrals, createReferral, updateReferralStatus,
  listBackgroundVerifications, createBackgroundVerification, updateBackgroundVerification,
  listOnboardingTemplates, createOnboardingTemplate,
  instantiateOnboardingTasks, listOnboardingTasks, completeOnboardingTask,
  recruitingFunnel,
} from '../../domains/hcm/recruiting.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'recruiting', ready: true })));

// ---------------------------------------------------------------------------
// Job postings
// ---------------------------------------------------------------------------

router.get(
  '/job-postings',
  handler(async (req) => {
    const rows = await listJobPostings({ status: str(req.query.status), requisitionId: str(req.query.requisitionId) });
    return rows.map((r) => ({ ...r, availableTransitions: jobPostingMachine.allowedEvents(r.status as never) }));
  }),
);

router.post(
  '/job-postings',
  handler(async (req) => {
    const body = z
      .object({
        requisitionId: z.string(),
        title: z.string().min(1),
        description: z.string().min(1),
        channel: z.enum(['internal', 'external', 'referral']).optional(),
      })
      .parse(req.body);
    return createJobPosting(body);
  }),
);

router.post(
  '/job-postings/:id/transition',
  handler(async (req) => {
    const body = z.object({ event: z.string().min(1), note: z.string().optional() }).parse(req.body);
    return transitionJobPosting(req.params.id, body.event as JobPostingEvent, body.note);
  }),
);

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

router.get(
  '/candidates',
  handler(async (req) => listCandidates({ source: str(req.query.source), q: str(req.query.q) })),
);

router.post(
  '/candidates',
  handler(async (req) => {
    const body = z
      .object({
        fullName: z.string().min(1),
        primaryPhone: z.string().nullish(),
        primaryEmail: z.string().nullish(),
        source: z.string().optional(),
        resumeText: z.string().optional(),
        currentCtc: z.number().nonnegative().nullish(),
        expectedCtc: z.number().nonnegative().nullish(),
        noticeDays: z.number().int().nonnegative().nullish(),
        tags: z.array(z.string()).optional(),
      })
      .parse(req.body);
    return createCandidate(body);
  }),
);

// ---------------------------------------------------------------------------
// Interviews and scorecards
// ---------------------------------------------------------------------------

router.get(
  '/applications/:applicationId/interviews',
  handler(async (req) => listInterviewRounds(req.params.applicationId)),
);

router.post(
  '/interviews',
  handler(async (req) => {
    const body = z
      .object({
        applicationId: z.string(),
        roundNo: z.number().int().positive(),
        kind: z.enum(['phone', 'technical', 'hr', 'panel']),
        scheduledAt: z.coerce.date(),
        interviewerPartyIds: z.array(z.string()).min(1),
        mode: z.enum(['video', 'onsite', 'phone']).optional(),
      })
      .parse(req.body);
    return scheduleInterview(body);
  }),
);

router.post(
  '/interviews/:id/complete',
  handler(async (req) => {
    const body = z
      .object({
        outcome: z.enum(['advance', 'reject', 'hold']),
        status: z.enum(['Completed', 'Cancelled', 'NoShow']).optional(),
      })
      .parse(req.body);
    return completeInterview(req.params.id, body);
  }),
);

router.get('/interviews/:id/scorecards', handler(async (req) => listScorecards(req.params.id)));

router.post(
  '/interviews/:id/scorecards',
  handler(async (req) => {
    const body = z
      .object({
        competencyScores: z.record(z.string(), z.number()),
        recommendation: z.enum(['strong_hire', 'hire', 'no_hire', 'strong_no_hire']),
        notes: z.string().optional(),
      })
      .parse(req.body);
    return submitScorecard({ roundId: req.params.id, ...body });
  }),
);

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

router.get(
  '/offers',
  handler(async (req) => {
    const rows = await listOffers({ applicationId: str(req.query.applicationId), status: str(req.query.status) });
    return rows.map((r) => ({ ...r, availableTransitions: offerMachine.allowedEvents(r.status as never) }));
  }),
);

router.post(
  '/offers',
  handler(async (req) => {
    const body = z
      .object({
        applicationId: z.string(),
        ctc: z.number().positive(),
        joiningDate: z.coerce.date(),
        validUntil: z.coerce.date(),
      })
      .parse(req.body);
    return createOffer(body);
  }),
);

router.post(
  '/offers/:id/transition',
  handler(async (req) => {
    const body = z
      .object({ event: z.string().min(1), note: z.string().optional(), declineReason: z.string().optional() })
      .parse(req.body);
    return transitionOffer(req.params.id, body.event as OfferEvent, body);
  }),
);

router.post(
  '/applications/:id/join-and-onboard',
  handler(async (req) => {
    const body = z
      .object({
        hireEffectiveDate: z.coerce.date(),
        legalEntity: z.string().optional(),
        noticePeriodDays: z.number().int().optional(),
        branch: z.string().nullish(),
      })
      .parse(req.body);
    return joinAndOnboard(req.params.id, body);
  }),
);

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

router.get('/referrals', handler(async (req) => listReferrals({ referrerEmploymentId: str(req.query.referrerEmploymentId) })));

router.post(
  '/referrals',
  handler(async (req) => {
    const body = z
      .object({
        referrerEmploymentId: z.string(),
        candidate: z.object({
          fullName: z.string().min(1),
          primaryPhone: z.string().nullish(),
          primaryEmail: z.string().nullish(),
        }),
        bonusAmount: z.number().nonnegative().nullish(),
        applicationId: z.string().nullish(),
      })
      .parse(req.body);
    return createReferral(body);
  }),
);

router.post(
  '/referrals/:id/status',
  handler(async (req) => {
    const body = z.object({ status: z.string().min(1) }).parse(req.body);
    return updateReferralStatus(req.params.id, body.status);
  }),
);

// ---------------------------------------------------------------------------
// Background verification
// ---------------------------------------------------------------------------

router.get(
  '/background-verifications',
  handler(async (req) =>
    listBackgroundVerifications({ applicationId: str(req.query.applicationId), employmentId: str(req.query.employmentId) }),
  ),
);

router.post(
  '/background-verifications',
  handler(async (req) => {
    const body = z
      .object({
        applicationId: z.string().nullish(),
        employmentId: z.string().nullish(),
        vendor: z.string().min(1),
        checks: z.array(z.string()),
      })
      .parse(req.body);
    return createBackgroundVerification(body);
  }),
);

router.patch(
  '/background-verifications/:id',
  handler(async (req) => {
    const body = z
      .object({
        status: z.enum(['Pending', 'InProgress', 'Completed']).optional(),
        outcome: z.enum(['clear', 'adverse', 'pending']).optional(),
      })
      .parse(req.body);
    return updateBackgroundVerification(req.params.id, body);
  }),
);

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

router.get('/onboarding-templates', handler(async () => listOnboardingTemplates()));

router.post(
  '/onboarding-templates',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        category: z.string().optional(),
        assignee: z.enum(['hr', 'it', 'manager', 'employee']),
        dueOffsetDays: z.number().int().optional(),
      })
      .parse(req.body);
    return createOnboardingTemplate(body);
  }),
);

router.get(
  '/onboarding-tasks',
  handler(async (req) => {
    const employmentId = str(req.query.employmentId);
    if (!employmentId) return [];
    return listOnboardingTasks(employmentId);
  }),
);

router.post(
  '/onboarding-tasks/instantiate',
  handler(async (req) => {
    const body = z.object({ employmentId: z.string(), hireEffectiveDate: z.coerce.date() }).parse(req.body);
    return instantiateOnboardingTasks(body.employmentId, body.hireEffectiveDate);
  }),
);

router.post(
  '/onboarding-tasks/:id/complete',
  handler(async (req) => {
    const body = z.object({ skip: z.boolean().optional() }).parse(req.body ?? {});
    return completeOnboardingTask(req.params.id, body.skip ?? false);
  }),
);

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

router.get('/funnel', handler(async () => recruitingFunnel()));

export default router;
