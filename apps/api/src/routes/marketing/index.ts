/**
 * Marketing router aggregation.
 *
 * Two exports:
 *  - `marketingRouter`: everything that requires auth, mounted at
 *    `/api/marketing` (routes/index.ts applies `requireAuth` before this).
 *  - `marketingPublicRouter`: the unauthenticated surface (public form
 *    submission, short-link redirects, inbound webhooks, unsubscribe),
 *    mounted at `/api/marketing/public` BEFORE the auth middleware.
 *
 * Each sub-router's own path style decides where it is mounted here: a
 * router whose routes are already fully qualified (e.g. `/templates`,
 * `/sends`) is mounted at `/`; a router whose routes are relative to itself
 * (e.g. `/`, `/:id`) is mounted at its own prefix.
 */

import { Router } from 'express';

import campaignsRoutes from './campaigns.routes.js';
import plansRoutes from './plans.routes.js';
import budgetRoutes from './budget.routes.js';
import audiencesRoutes from './audiences.routes.js';
import preferencesRoutes, { publicRouter as preferencesPublicRouter } from './preferences.routes.js';
import settingsRoutes from './settings.routes.js';
import messagingRoutes from './messaging.routes.js';
import journeysRoutes from './journeys.routes.js';
import captureRoutes from './capture.routes.js';
import eventsRoutes from './events.routes.js';
import assetsRoutes from './assets.routes.js';
import referralsRoutes from './referrals.routes.js';
import analyticsRoutes from './analytics.routes.js';
import aiRoutes from './ai.routes.js';
import publicRoutes from './public.routes.js';

const router = Router();

// Absolute-path routers (each already spells out its own leading segment) —
// mounted at the root so their internal paths become the final URL.
router.use('/', analyticsRoutes); // /overview, /analytics/*
router.use('/', plansRoutes); // /plans, /calendar
router.use('/', budgetRoutes); // /budgets, /spends, /vendors
router.use('/', messagingRoutes); // /templates, /sends
router.use('/', journeysRoutes); // /journeys
router.use('/', captureRoutes); // /forms, /submissions, /touchpoints, /attribution, /score-rules, /links
router.use('/', assetsRoutes); // /assets, /social-posts
router.use('/', referralsRoutes); // /referral-programs, /referrals
router.use('/', aiRoutes); // /ai/draft

// Relative-path routers — each expects to own everything under a prefix.
router.use('/campaigns', campaignsRoutes);
router.use('/audiences', audiencesRoutes);
router.use('/preferences', preferencesRoutes);
router.use('/settings', settingsRoutes);
router.use('/events', eventsRoutes);

export const marketingRouter = router;

// ---------------------------------------------------------------------------
// Public (unauthenticated) surface.
// ---------------------------------------------------------------------------

const publicRouterAggregate = Router();

// public.routes.ts already spells out /public/forms/:publicToken/submit,
// /public/l/:slug and /public/webhooks/:provider — those paths already
// include the `/public` segment, so mount it at root of this aggregate and
// mount the aggregate itself at `/api/marketing` (NOT `/api/marketing/public`).
publicRouterAggregate.use('/', publicRoutes);

// preferences.routes.ts's publicRouter spells out /unsubscribe/:token,
// which the contract wants at /api/marketing/public/unsubscribe/:token —
// so it is mounted under the /public prefix explicitly.
publicRouterAggregate.use('/public', preferencesPublicRouter);

export const marketingPublicRouter = publicRouterAggregate;
