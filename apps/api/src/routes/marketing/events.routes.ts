/**
 * Marketing events & registrations. Mounted at `/api/marketing/events`.
 */

import { Router } from 'express';
import { z } from 'zod';
import { MARKETING_EVENT_KINDS } from '@kaizen/shared';
import { handler, parsePaging, str, date } from '../../lib/http.js';
import {
  createEvent,
  listEvents,
  loadEvent,
  updateEvent,
  openEvent,
  closeEvent,
  startEvent,
  completeEvent,
  cancelEvent,
  registerForEvent,
  listEventRegistrations,
  confirmRegistration,
  checkInRegistration,
  markNoShow,
  cancelRegistration,
  followUpRegistration,
  convertAttendees,
  exportRegistrations,
} from '../../domains/marketing/events.js';

const router = Router();

const EventInputSchema = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(MARKETING_EVENT_KINDS),
  campaignId: z.string().nullish(),
  institutionId: z.string().nullish(),
  venue: z.string().nullish(),
  isOnline: z.boolean().optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date().nullish(),
  capacity: z.number().int().positive().nullish(),
  costPlanned: z.number().nonnegative().nullish(),
  division: z.string().optional(),
});

router.get(
  '/',
  handler(async (req) => {
    const { page, pageSize } = parsePaging(req);
    return listEvents({
      status: str(req.query.status),
      campaignId: str(req.query.campaignId),
      division: str(req.query.division),
      q: str(req.query.q),
      from: date(req.query.from),
      to: date(req.query.to),
      page,
      pageSize,
    });
  }),
);

router.get('/:id', handler(async (req) => loadEvent(req.params.id)));

router.post(
  '/',
  handler(async (req, res) => {
    const input = EventInputSchema.parse(req.body);
    const event = await createEvent(input);
    res.status(201).json(event);
    return undefined;
  }),
);

router.patch(
  '/:id',
  handler(async (req) => {
    const input = EventInputSchema.partial().parse(req.body);
    return updateEvent(req.params.id, input);
  }),
);

router.post('/:id/open', handler(async (req) => openEvent(req.params.id)));
router.post('/:id/close', handler(async (req) => closeEvent(req.params.id)));
router.post('/:id/start', handler(async (req) => startEvent(req.params.id)));
router.post('/:id/complete', handler(async (req) => completeEvent(req.params.id)));

router.post(
  '/:id/cancel',
  handler(async (req) => {
    const schema = z.object({ reason: z.string().min(1) });
    const input = schema.parse(req.body);
    return cancelEvent(req.params.id, input.reason);
  }),
);

router.get(
  '/:id/registrations',
  handler(async (req) => listEventRegistrations(req.params.id, str(req.query.status))),
);

router.post(
  '/:id/register',
  handler(async (req, res) => {
    const schema = z.object({
      personId: z.string().optional(),
      person: z
        .object({
          fullName: z.string(),
          primaryPhone: z.string().nullish(),
          primaryEmail: z.string().nullish(),
        })
        .optional(),
      source: z.string().optional(),
    });
    const input = schema.parse(req.body);
    const registration = await registerForEvent(req.params.id, input);
    res.status(201).json(registration);
    return undefined;
  }),
);

router.post('/registrations/:id/confirm', handler(async (req) => confirmRegistration(req.params.id)));
router.post('/registrations/:id/check-in', handler(async (req) => checkInRegistration(req.params.id)));
router.post('/registrations/:id/no-show', handler(async (req) => markNoShow(req.params.id)));
router.post('/registrations/:id/cancel', handler(async (req) => cancelRegistration(req.params.id)));

router.post(
  '/registrations/:id/follow-up',
  handler(async (req) => {
    const schema = z.object({ done: z.boolean(), note: z.string().optional() });
    const input = schema.parse(req.body);
    return followUpRegistration(req.params.id, input.done, input.note);
  }),
);

router.post('/:id/convert-attendees', handler(async (req) => convertAttendees(req.params.id)));

router.get(
  '/:id/export',
  handler(async (req, res) => {
    const csv = await exportRegistrations(req.params.id);
    res.setHeader('content-type', 'text/csv');
    res.send(csv);
    return undefined;
  }),
);

export default router;
