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
import { requireAuth } from '../lib/http.js';

const router = Router();

router.use('/auth', authRoutes);
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
// What is running, and against what data. Signed in, because the seed stamp is
// about a particular tenant.
router.use('/meta', requireAuth, metaRoutes);

export default router;
