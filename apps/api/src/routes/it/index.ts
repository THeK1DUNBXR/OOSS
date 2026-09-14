/**
 * Technology (docs/plan/cio.md). One router per workstream, each in its own
 * file so the workstreams can be built side by side. Mounted at /api/it.
 */
import { Router } from 'express';
import assets from './assets.routes.js';
import software from './software.routes.js';
import vendors from './vendors.routes.js';
import servicedesk from './servicedesk.routes.js';
import itsm from './itsm.routes.js';
import governance from './governance.routes.js';
import portfolio from './portfolio.routes.js';
import continuity from './continuity.routes.js';
import overview from './overview.routes.js';

const router = Router();
// A. Assets and devices: /api/it/assets
router.use('/assets', assets);
// B. Applications and licences: /api/it/applications, /api/it/licences
router.use('/', software);
// C. Vendors and contracts: /api/it/vendors, /api/it/contracts
router.use('/', vendors);
// D. Service desk: /api/it/tickets, /api/it/sla-policies, /api/it/knowledge, /api/it/my
router.use('/', servicedesk);
// E. Incidents, problems, changes: /api/it/incidents, /api/it/problems, /api/it/changes
router.use('/', itsm);
// F. Security and governance: /api/it/risks, /api/it/policies, /api/it/controls, /api/it/access-reviews, /api/it/findings
router.use('/', governance);
// G. Portfolio and budget: /api/it/initiatives, /api/it/roadmap, /api/it/budget, /api/it/tech-debt
router.use('/', portfolio);
// H. Continuity: /api/it/continuity, /api/it/availability, /api/it/maintenance
router.use('/', continuity);
// I. The overview: /api/it/overview
router.use('/', overview);

export default router;
