import { Router } from 'express';
import authRoutes from './auth.routes.js';
import crmRoutes from './crm.routes.js';
import pipelineRoutes from './pipeline.routes.js';
import commercialRoutes from './commercial.routes.js';
import financeRoutes from './finance.routes.js';
import commandRoutes from './command.routes.js';
import adminRoutes from './admin.routes.js';
import educationRoutes from './education.routes.js';
import hrRoutes from './hr.routes.js';
import booksRoutes from './books.routes.js';
import { importsRouter } from './imports.routes.js';
import boardRoutes from './board.routes.js';
import metaRoutes from './meta.routes.js';
import equityRoutes from './equity.routes.js';
import groupRoutes from './group.routes.js';
import esopRoutes from './esop.routes.js';
import complianceRoutes from './compliance/index.js';
import itRoutes from './it/index.js';
import ceoRoutes from './ceo/index.js';
import { marketingRouter, marketingPublicRouter } from './marketing/index.js';
import { requireAuth } from '../lib/http.js';

const router = Router();

router.use('/auth', authRoutes);
// Marketing's public surface (form submissions, short-link redirects, inbound
// webhooks, unsubscribe) resolves its own tenant per-request and must never
// go through requireAuth — mounted first so it is matched before the
// authenticated marketing router below. Its own routes already spell out the
// `/public/...` segment, so this sits at `/marketing`, not `/marketing/public`.
router.use('/marketing', marketingPublicRouter);
router.use('/marketing', requireAuth, marketingRouter);
router.use('/crm', requireAuth, crmRoutes);
router.use('/pipelines', requireAuth, pipelineRoutes);
router.use('/commercial', requireAuth, commercialRoutes);
router.use('/finance', requireAuth, financeRoutes);
router.use('/command', requireAuth, commandRoutes);
router.use('/admin', requireAuth, adminRoutes);
router.use('/education', requireAuth, educationRoutes);
router.use('/hr', requireAuth, hrRoutes);
router.use('/books', requireAuth, booksRoutes);
router.use('/imports', requireAuth, importsRouter);
router.use('/equity', requireAuth, equityRoutes);
router.use('/group', requireAuth, groupRoutes);
router.use('/esop', requireAuth, esopRoutes);
router.use('/board', requireAuth, boardRoutes);
router.use('/compliance', requireAuth, complianceRoutes);
router.use('/it', requireAuth, itRoutes);
router.use('/ceo', requireAuth, ceoRoutes);
// What is running, and against what data. Signed in, because the seed stamp is
// about a particular tenant.
router.use('/meta', requireAuth, metaRoutes);

export default router;
