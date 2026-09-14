/**
 * Technology — portfolio and budget (docs/plan/cio.md, workstream G).
 * Mounted at /api/it — segments declared in full.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str, date } from '../../lib/http.js';
import { ApiError } from '../../platform/errors.js';
import { IT_THEMES } from '@kaizen/shared';
import {
  createInitiative,
  listInitiatives,
  initiativeDetail,
  transitionInitiative,
  postInitiativeUpdate,
  listInitiativeUpdates,
  portfolioSummary,
  createRoadmapItem,
  listRoadmap,
  setRoadmapItemDone,
  createBudgetLine,
  updateBudgetLine,
  approveBudgetLine,
  budgetLineDetail,
  budgetForFy,
  budgetSummary,
  createTechDebtItem,
  listTechDebt,
  techDebtDetail,
  transitionTechDebt,
  techDebtSummary,
} from '../../domains/it/portfolio.js';

const router = Router();

function parseTransition(body: unknown): { event: string; note?: string } {
  const parsed = z.object({ event: z.string().min(1), note: z.string().optional() }).parse(body ?? {});
  return parsed;
}

// ---------------------------------------------------------------------------
// Initiatives
// ---------------------------------------------------------------------------

router.get(
  '/initiatives',
  handler(async (req) =>
    listInitiatives({ stage: str(req.query.stage), theme: str(req.query.theme), rag: str(req.query.rag) }),
  ),
);

router.get('/initiatives/summary', handler(async () => portfolioSummary()));

router.post(
  '/initiatives',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        theme: z.enum(IT_THEMES),
        sponsorPartyId: z.string().min(1),
        ownerPartyId: z.string().min(1),
        businessCase: z.string().nullish(),
        expectedBenefit: z.string().nullish(),
        budget: z.number().nonnegative(),
        currency: z.string().optional(),
        targetQuarter: z.string().nullish(),
        projectId: z.string().nullish(),
      })
      .parse(req.body);
    return createInitiative(body);
  }),
);

router.get('/initiatives/:id', handler(async (req) => initiativeDetail(req.params.id)));

router.post(
  '/initiatives/:id/transition',
  handler(async (req) => {
    const { event, note } = parseTransition(req.body);
    return transitionInitiative(req.params.id, event as never, note);
  }),
);

router.get('/initiatives/:id/updates', handler(async (req) => listInitiativeUpdates(req.params.id)));

router.post(
  '/initiatives/:id/updates',
  handler(async (req) => {
    const body = z.object({ body: z.string().min(1), rag: z.string() }).parse(req.body);
    return postInitiativeUpdate(req.params.id, body);
  }),
);

// ---------------------------------------------------------------------------
// Roadmap
// ---------------------------------------------------------------------------

router.get(
  '/roadmap',
  handler(async (req) => listRoadmap({ quarter: str(req.query.quarter), theme: str(req.query.theme) })),
);

router.get(
  '/roadmap/items',
  handler(async (req) => listRoadmap({ quarter: str(req.query.quarter), theme: str(req.query.theme) })),
);

router.post(
  '/roadmap/items',
  handler(async (req) => {
    const body = z
      .object({
        quarter: z.string().min(1),
        theme: z.enum(IT_THEMES),
        initiativeId: z.string().nullish(),
        milestone: z.string().min(1),
        dueAt: z.string().nullish(),
      })
      .parse(req.body);
    return createRoadmapItem({ ...body, dueAt: body.dueAt ? date(body.dueAt) ?? null : null });
  }),
);

router.post(
  '/roadmap/items/:id/done',
  handler(async (req) => {
    const body = z.object({ done: z.boolean().optional() }).parse(req.body ?? {});
    return setRoadmapItemDone(req.params.id, body.done ?? true);
  }),
);

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

router.get(
  '/budget',
  handler(async (req) => {
    const fy = str(req.query.fy);
    if (!fy) throw ApiError.badRequest('A financial year is required, e.g. ?fy=FY2026-27.');
    return budgetForFy(fy);
  }),
);

router.get('/budget/summary', handler(async (req) => budgetSummary(str(req.query.fy))));

router.post(
  '/budget/lines',
  handler(async (req) => {
    const body = z
      .object({
        fy: z.string().min(1),
        category: z.string(),
        division: z.string().nullish(),
        kind: z.string(),
        planned: z.number().nonnegative(),
        currency: z.string().optional(),
        bookCategoryIds: z.array(z.string()).optional(),
      })
      .parse(req.body);
    return createBudgetLine(body);
  }),
);

router.get('/budget/lines/:id', handler(async (req) => budgetLineDetail(req.params.id)));

router.patch(
  '/budget/lines/:id',
  handler(async (req) => {
    const body = z
      .object({
        planned: z.number().nonnegative().optional(),
        division: z.string().nullish(),
        bookCategoryIds: z.array(z.string()).optional(),
      })
      .parse(req.body);
    return updateBudgetLine(req.params.id, body);
  }),
);

router.post('/budget/lines/:id/approve', handler(async (req) => approveBudgetLine(req.params.id)));

// ---------------------------------------------------------------------------
// Technical debt
// ---------------------------------------------------------------------------

router.get(
  '/tech-debt',
  handler(async (req) =>
    listTechDebt({ status: str(req.query.status), severity: str(req.query.severity), applicationId: str(req.query.applicationId) }),
  ),
);

router.get('/tech-debt/summary', handler(async () => techDebtSummary()));

router.post(
  '/tech-debt',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        applicationId: z.string().nullish(),
        severity: z.string(),
        effortDays: z.number().int().nonnegative().nullish(),
        interest: z.string().nullish(),
        initiativeId: z.string().nullish(),
      })
      .parse(req.body);
    return createTechDebtItem(body);
  }),
);

router.get('/tech-debt/:id', handler(async (req) => techDebtDetail(req.params.id)));

router.post(
  '/tech-debt/:id/transition',
  handler(async (req) => {
    const { event, note } = parseTransition(req.body);
    return transitionTechDebt(req.params.id, event as never, note);
  }),
);

export default router;
