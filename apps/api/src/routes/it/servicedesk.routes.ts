/**
 * Technology — service desk (docs/plan/cio.md, workstream D). Mounted at
 * `/api/it`, so every route here declares its full segment.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  listSlaPolicies,
  setSlaPolicy,
  listTickets,
  getTicket,
  createTicket,
  triageTicket,
  assignTicket,
  transitionTicket,
  addComment,
  rateTicket,
  listKnowledge,
  getKnowledgeArticle,
  createKnowledgeArticle,
  publishKnowledgeArticle,
  markKnowledgeHelpful,
  myIt,
  summary,
} from '../../domains/it/servicedesk.js';
import { IT_TICKET_PRIORITIES, IT_TICKET_CATEGORIES } from '@kaizen/shared';
import { ApiError } from '../../platform/errors.js';

const router = Router();

// ---------------------------------------------------------------------------
// SLA policies
// ---------------------------------------------------------------------------

router.get('/sla-policies', handler(async () => listSlaPolicies()));

router.post(
  '/sla-policies',
  handler(async (req) => {
    const body = z
      .object({
        priority: z.enum(IT_TICKET_PRIORITIES),
        responseMinutes: z.number().int().positive(),
        resolutionMinutes: z.number().int().positive(),
        businessHoursOnly: z.boolean().optional(),
        effectiveFrom: z.string().optional(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return setSlaPolicy({ ...body, effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : undefined });
  }),
);

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

router.get(
  '/tickets',
  handler(async (req) => {
    return listTickets({
      tab: str(req.query.tab) as never,
      status: str(req.query.status),
      priority: str(req.query.priority),
    });
  }),
);

router.get('/tickets/summary', handler(async () => summary()));

router.get('/tickets/:id', handler(async (req) => getTicket(req.params.id)));

router.post(
  '/tickets',
  handler(async (req) => {
    const body = z
      .object({
        category: z.enum(IT_TICKET_CATEGORIES),
        subject: z.string().min(1),
        description: z.string().min(1),
        assetId: z.string().nullish(),
        applicationId: z.string().nullish(),
        requesterPartyId: z.string().nullish(),
      })
      .parse(req.body);
    return createTicket(body);
  }),
);

router.post(
  '/tickets/:id/triage',
  handler(async (req) => {
    const body = z
      .object({
        priority: z.enum(IT_TICKET_PRIORITIES),
        category: z.enum(IT_TICKET_CATEGORIES).optional(),
      })
      .parse(req.body);
    return triageTicket(req.params.id, body);
  }),
);

router.post(
  '/tickets/:id/assign',
  handler(async (req) => {
    const body = z.object({ assigneePartyId: z.string().min(1) }).parse(req.body);
    return assignTicket(req.params.id, body.assigneePartyId);
  }),
);

router.post(
  '/tickets/:id/transition',
  handler(async (req) => {
    const body = z
      .object({
        event: z.enum(['START', 'WAIT', 'RESUME', 'RESOLVE', 'CLOSE', 'REOPEN']),
        note: z.string().nullish(),
      })
      .parse(req.body);
    if (!body.event) throw ApiError.badRequest('A transition needs an `event`.');
    return transitionTicket(req.params.id, body.event, body.note ?? undefined);
  }),
);

router.post(
  '/tickets/:id/comments',
  handler(async (req) => {
    const body = z.object({ body: z.string().min(1), internal: z.boolean().optional() }).parse(req.body);
    return addComment(req.params.id, body);
  }),
);

router.post(
  '/tickets/:id/rate',
  handler(async (req) => {
    const body = z.object({ satisfaction: z.number().int().min(1).max(5) }).parse(req.body);
    return rateTicket(req.params.id, body.satisfaction);
  }),
);

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

router.get(
  '/knowledge',
  handler(async (req) => {
    return listKnowledge({ status: str(req.query.status), applicationId: str(req.query.applicationId) });
  }),
);

router.get('/knowledge/:id', handler(async (req) => getKnowledgeArticle(req.params.id)));

router.post(
  '/knowledge',
  handler(async (req) => {
    const body = z
      .object({ title: z.string().min(1), body: z.string().min(1), applicationId: z.string().nullish() })
      .parse(req.body);
    return createKnowledgeArticle(body);
  }),
);

router.post('/knowledge/:id/publish', handler(async (req) => publishKnowledgeArticle(req.params.id)));

router.post('/knowledge/:id/helpful', handler(async (req) => markKnowledgeHelpful(req.params.id)));

// ---------------------------------------------------------------------------
// My IT
// ---------------------------------------------------------------------------

router.get('/my', handler(async () => myIt()));

export default router;
