/**
 * HCM — time (docs/hcm/time.md). Mounted at /api/hcm/time.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str, date } from '../../lib/http.js';
import {
  listShifts, createShift, updateShift,
  listRosterAssignments, assignRoster, rosterFor,
  listClockEvents, recordClockEvent, myEmploymentId,
  deriveAttendanceFromClockEvents,
  listTimesheets, getTimesheet, addTimesheetEntry, removeTimesheetEntry,
  submitTimesheet, approveTimesheet, rejectTimesheet,
  listOvertimeRequests, requestOvertime, approveOvertimeRequest, rejectOvertimeRequest,
  earnCompOffForHolidayWork,
  listCompOffs, consumeCompOff, runCompOffExpiry,
  listRegularisations, submitRegularisation, approveRegularisation, rejectRegularisation,
} from '../../domains/hcm/time.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'time', ready: true })));

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

router.get('/shifts', handler(async (req) => listShifts(req.query.activeOnly === 'true')));

router.post(
  '/shifts',
  handler(async (req) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        startTime: z.string().min(1),
        endTime: z.string().min(1),
        graceMinutes: z.number().int().min(0).optional(),
        breakMinutes: z.number().int().min(0).optional(),
        nightShift: z.boolean().optional(),
      })
      .parse(req.body);
    return createShift(body);
  }),
);

router.patch(
  '/shifts/:id',
  handler(async (req) => {
    const body = z
      .object({ name: z.string().min(1).optional(), graceMinutes: z.number().int().min(0).optional(), breakMinutes: z.number().int().min(0).optional(), active: z.boolean().optional() })
      .parse(req.body);
    return updateShift(req.params.id, body);
  }),
);

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

router.get('/rosters', handler(async (req) => listRosterAssignments(str(req.query.employmentRelationshipId))));

router.get(
  '/rosters/mine',
  handler(async () => {
    const employmentId = await myEmploymentId();
    return rosterFor(employmentId);
  }),
);

router.post(
  '/rosters',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        shiftId: z.string(),
        effectiveFrom: z.coerce.date(),
        effectiveTo: z.coerce.date().nullish(),
        weeklyOffDays: z.array(z.number().int().min(0).max(6)).optional(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return assignRoster(body);
  }),
);

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

router.get(
  '/clock',
  handler(async (req) => {
    const employmentRelationshipId = str(req.query.employmentRelationshipId) ?? (await myEmploymentId());
    return listClockEvents(employmentRelationshipId, date(req.query.from), date(req.query.to));
  }),
);

router.get(
  '/clock/mine',
  handler(async (req) => {
    const employmentId = await myEmploymentId();
    return listClockEvents(employmentId, date(req.query.from), date(req.query.to));
  }),
);

const clockSourceEnum = z.enum(['web', 'mobile', 'biometric_import']);

router.post(
  '/clock/mine/:kind',
  handler(async (req) => {
    const kind = z.enum(['in', 'out']).parse(req.params.kind);
    const body = z
      .object({ source: clockSourceEnum.optional(), lat: z.number().nullish(), long: z.number().nullish(), deviceId: z.string().nullish(), note: z.string().nullish() })
      .parse(req.body ?? {});
    const employmentId = await myEmploymentId();
    return recordClockEvent({
      employmentRelationshipId: employmentId,
      kind,
      source: body.source ?? 'web',
      ip: req.ip ?? null,
      deviceId: body.deviceId ?? null,
      lat: body.lat ?? null,
      long: body.long ?? null,
      note: body.note ?? null,
    });
  }),
);

router.post(
  '/clock',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        kind: z.enum(['in', 'out']),
        occurredAt: z.coerce.date().optional(),
        source: clockSourceEnum.optional(),
        deviceId: z.string().nullish(),
        lat: z.number().nullish(),
        long: z.number().nullish(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return recordClockEvent({ ...body, ip: req.ip ?? null });
  }),
);

router.post('/jobs/derive-attendance', handler(async (req) => {
  const body = z.object({ date: z.coerce.date().optional() }).parse(req.body ?? {});
  return deriveAttendanceFromClockEvents(body.date);
}));

// ---------------------------------------------------------------------------
// Timesheets
// ---------------------------------------------------------------------------

router.get('/timesheets', handler(async (req) => listTimesheets(str(req.query.employmentRelationshipId))));

router.get(
  '/timesheets/mine',
  handler(async () => listTimesheets(await myEmploymentId())),
);

router.get('/timesheets/:id', handler(async (req) => getTimesheet(req.params.id)));

router.post(
  '/timesheets/entries',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string().optional(),
        date: z.coerce.date(),
        projectId: z.string().nullish(),
        taskRef: z.string().nullish(),
        hours: z.number().positive(),
        billable: z.boolean().optional(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    const employmentRelationshipId = body.employmentRelationshipId ?? (await myEmploymentId());
    return addTimesheetEntry({ ...body, employmentRelationshipId });
  }),
);

router.delete('/timesheets/entries/:id', handler(async (req) => removeTimesheetEntry(req.params.id)));

router.post('/timesheets/:id/submit', handler(async (req) => submitTimesheet(req.params.id)));

router.post(
  '/timesheets/:id/approve',
  handler(async (req) => {
    const body = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    return approveTimesheet(req.params.id, body.note);
  }),
);

router.post(
  '/timesheets/:id/reject',
  handler(async (req) => {
    const body = z.object({ note: z.string().min(1) }).parse(req.body);
    return rejectTimesheet(req.params.id, body.note);
  }),
);

// ---------------------------------------------------------------------------
// Overtime
// ---------------------------------------------------------------------------

router.get('/overtime', handler(async (req) => listOvertimeRequests(str(req.query.employmentRelationshipId))));

router.get('/overtime/mine', handler(async () => listOvertimeRequests(await myEmploymentId())));

router.post(
  '/overtime',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string().optional(),
        date: z.coerce.date(),
        hours: z.number().positive(),
        reason: z.string().nullish(),
      })
      .parse(req.body);
    const employmentRelationshipId = body.employmentRelationshipId ?? (await myEmploymentId());
    return requestOvertime({ ...body, employmentRelationshipId });
  }),
);

router.post(
  '/overtime/:id/approve',
  handler(async (req) => {
    const body = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    return approveOvertimeRequest(req.params.id, body.note);
  }),
);

router.post(
  '/overtime/:id/reject',
  handler(async (req) => {
    const body = z.object({ note: z.string().min(1) }).parse(req.body);
    return rejectOvertimeRequest(req.params.id, body.note);
  }),
);

// ---------------------------------------------------------------------------
// Comp-off
// ---------------------------------------------------------------------------

router.get('/comp-offs', handler(async (req) => listCompOffs(str(req.query.employmentRelationshipId))));

router.get('/comp-offs/mine', handler(async () => listCompOffs(await myEmploymentId())));

router.post(
  '/comp-offs/holiday-work',
  handler(async (req) => {
    const body = z
      .object({ employmentRelationshipId: z.string(), earnedOn: z.coerce.date(), days: z.number().positive(), note: z.string().nullish() })
      .parse(req.body);
    return earnCompOffForHolidayWork(body);
  }),
);

router.post(
  '/comp-offs/:id/consume',
  handler(async (req) => {
    const body = z.object({ consumedOn: z.coerce.date().optional() }).parse(req.body ?? {});
    return consumeCompOff(req.params.id, body.consumedOn);
  }),
);

router.post('/jobs/expire-comp-offs', handler(async () => runCompOffExpiry()));

// ---------------------------------------------------------------------------
// Attendance regularisation
// ---------------------------------------------------------------------------

router.get('/regularisations', handler(async (req) => listRegularisations(str(req.query.employmentRelationshipId))));

router.get('/regularisations/mine', handler(async () => listRegularisations(await myEmploymentId())));

router.post(
  '/regularisations',
  handler(async (req) => {
    const body = z
      .object({ employmentRelationshipId: z.string().optional(), date: z.coerce.date(), reason: z.string().min(1) })
      .parse(req.body);
    const employmentRelationshipId = body.employmentRelationshipId ?? (await myEmploymentId());
    return submitRegularisation({ ...body, employmentRelationshipId });
  }),
);

router.post(
  '/regularisations/:id/approve',
  handler(async (req) => {
    const body = z.object({ note: z.string().optional(), correctedWorkedMinutes: z.number().int().min(0).optional() }).parse(req.body ?? {});
    return approveRegularisation(req.params.id, body.note, body.correctedWorkedMinutes);
  }),
);

router.post(
  '/regularisations/:id/reject',
  handler(async (req) => {
    const body = z.object({ note: z.string().min(1) }).parse(req.body);
    return rejectRegularisation(req.params.id, body.note);
  }),
);

export default router;
