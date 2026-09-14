/**
 * Chairman's Office — route mount point (docs/plan/ceo-office.md §6, Phase 0).
 *
 * One router per area, mounted at the prefix its owning phase builds against.
 * This file is never edited again after Phase 0 lands — each phase replaces
 * only the stub router file it owns (below), never this index.
 */

import { Router } from 'express';
import cockpitRoutes from './cockpit.routes.js';
import strategyRoutes from './strategy.routes.js';
import initiativesRoutes from './initiatives.routes.js';
import rhythmRoutes from './rhythm.routes.js';
import doaRoutes from './doa.routes.js';
import boardRoutes from './board.routes.js';
import riskRoutes from './risk.routes.js';
import financeRoutes from './finance.routes.js';
import peopleRoutes from './people.routes.js';

const router = Router();

router.use('/cockpit', cockpitRoutes); // Phase 1 — Cockpit & KPI Library
router.use('/strategy', strategyRoutes); // Phase 2 — Strategy & OKRs
router.use('/initiatives', initiativesRoutes); // Phase 3 — Initiatives Portfolio
router.use('/rhythm', rhythmRoutes); // Phase 4 — Operating Rhythm
router.use('/doa', doaRoutes); // Phase 5 — Delegation of Authority & Approvals Inbox
router.use('/board', boardRoutes); // Phase 6 — Board Pack, Investor Updates & Stakeholders
router.use('/risk', riskRoutes); // Phase 7 — Risk, Policy & Governance
router.use('/finance', financeRoutes); // Phase 8 — Financial Planning & Headcount
router.use('/people', peopleRoutes); // Phase 9 — Leadership, Org, 1:1s & Succession

export default router;
