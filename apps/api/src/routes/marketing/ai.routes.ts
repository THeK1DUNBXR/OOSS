import { Router } from 'express';
import { z } from 'zod';
import { handler } from '../../lib/http.js';
import { draft } from '../../domains/marketing/ai.js';

const router = Router();

const DraftRequestSchema = z.object({
  kind: z.enum(['campaign_brief', 'copy', 'subject_lines', 'segment', 'next_best_action']),
  context: z.record(z.unknown()).optional(),
});

router.post(
  '/ai/draft',
  handler(async (req) => {
    const input = DraftRequestSchema.parse(req.body);
    return draft(input.kind, input.context ?? {});
  }),
);

export default router;
