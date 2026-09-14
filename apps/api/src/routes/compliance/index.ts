/**
 * Compliance (docs/plan/compliance.md). One router per workstream, each in its
 * own file so the workstreams can be built side by side.
 */
import { Router } from 'express';
import calendar from './calendar.routes.js';
import gst from './gst.routes.js';
import tax from './tax.routes.js';
import books from './books.routes.js';
import payroll from './payroll.routes.js';
import labour from './labour.routes.js';
import privacy from './privacy.routes.js';
import corporate from './corporate.routes.js';

const router = Router();
router.use('/calendar', calendar);
router.use('/gst', gst);
router.use('/tax', tax);
router.use('/books', books);
router.use('/payroll', payroll);
router.use('/labour', labour);
router.use('/privacy', privacy);
router.use('/corporate', corporate);

export default router;
