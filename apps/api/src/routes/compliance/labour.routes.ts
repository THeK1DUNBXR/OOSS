/** Compliance — labour (docs/plan/compliance.md). Mounted at /api/compliance/labour. */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str, numeric } from '../../lib/http.js';
import { num } from '../../platform/db.js';
import {
  listHolidays,
  createHoliday,
  deleteHoliday,
  runLeaveYearClose,
  encashLeave,
  listWorkingHoursRules,
  createWorkingHoursRule,
  runWeeklyHoursCheck,
  overtimeAccruals,
  registerWages,
  registerLeave,
  registerMusterRoll,
  registerEmployees,
  listIccMembers,
  appointIccMember,
  endIccMemberTerm,
  validateCommittee,
  listPoshComplaints,
  createPoshComplaint,
  transitionPoshComplaint,
  createPoshWorkshop,
  listPoshWorkshops,
  poshAnnualReport,
  markPoshAnnualReportFiled,
  listDisciplinaryCases,
  openDisciplinaryCase,
  advanceDisciplinaryCase,
  listLetters,
  letterDocument,
  recordBgvConsent,
  recordCodeOfConductAck,
} from '../../domains/compliance/labour.js';

const router = Router();

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

router.get('/holidays', handler(async (req) => listHolidays(numeric(req.query.year))));

router.post(
  '/holidays',
  handler(async (req) => {
    const body = z
      .object({
        date: z.coerce.date(),
        name: z.string().min(1),
        kind: z.enum(['national', 'state', 'restricted']),
        state: z.string().nullish(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return createHoliday(body);
  }),
);

router.delete('/holidays/:id', handler(async (req) => deleteHoliday(req.params.id)));

// ---------------------------------------------------------------------------
// Leave year-end
// ---------------------------------------------------------------------------

router.post('/leave/year-close/run', handler(async () => runLeaveYearClose()));

router.post(
  '/leave/:employmentId/encash',
  handler(async (req) => {
    const body = z.object({ leaveTypeId: z.string(), days: z.number().positive() }).parse(req.body);
    return encashLeave(req.params.employmentId, body);
  }),
);

// ---------------------------------------------------------------------------
// Working hours
// ---------------------------------------------------------------------------

router.get('/hours/rules', handler(async () => listWorkingHoursRules()));

router.post(
  '/hours/rules',
  handler(async (req) => {
    const body = z
      .object({
        effectiveFrom: z.coerce.date(),
        dailyCapHours: z.number(),
        weeklyCapHours: z.number(),
        spreadOverHours: z.number(),
        otMultiplier: z.number(),
        otCapPerQuarterHours: z.number(),
        confirmed: z.boolean().optional(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return createWorkingHoursRule(body);
  }),
);

router.post('/hours/check/run', handler(async () => runWeeklyHoursCheck()));

router.get(
  '/hours/:employmentId/overtime',
  handler(async (req) => {
    const rows = await overtimeAccruals(req.params.employmentId);
    return rows.map((r) => ({ isoWeek: r.isoWeek, hours: num(r.hours), rate: num(r.rate), amount: num(r.amount) }));
  }),
);

// ---------------------------------------------------------------------------
// Statutory registers
// ---------------------------------------------------------------------------

function downloadCsv(res: { setHeader: (k: string, v: string) => void; send: (body: string) => void }, filename: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  res.send(csv);
}

router.get(
  '/registers/wages',
  handler(async (req, res) => {
    const period = str(req.query.period);
    if (!period) throw new Error('period is required');
    const { filename, csv } = await registerWages(period);
    downloadCsv(res, filename, csv);
  }),
);

router.get(
  '/registers/leave',
  handler(async (req, res) => {
    const fy = str(req.query.fy) ?? '';
    const { filename, csv } = await registerLeave(fy);
    downloadCsv(res, filename, csv);
  }),
);

router.get(
  '/registers/muster-roll',
  handler(async (req, res) => {
    const period = str(req.query.period);
    if (!period) throw new Error('period is required');
    const { filename, csv } = await registerMusterRoll(period);
    downloadCsv(res, filename, csv);
  }),
);

router.get(
  '/registers/employees',
  handler(async (_req, res) => {
    const { filename, csv } = await registerEmployees();
    downloadCsv(res, filename, csv);
  }),
);

// ---------------------------------------------------------------------------
// POSH
// ---------------------------------------------------------------------------

router.get('/posh/committee', handler(async () => listIccMembers()));

router.post(
  '/posh/committee',
  handler(async (req) => {
    const body = z
      .object({
        personId: z.string().nullish(),
        externalName: z.string().nullish(),
        role: z.enum(['presiding', 'member', 'external']),
        isWoman: z.boolean(),
        appointedOn: z.coerce.date(),
        termEnds: z.coerce.date().nullish(),
      })
      .parse(req.body);
    return appointIccMember(body);
  }),
);

router.post(
  '/posh/committee/:id/end-term',
  handler(async (req) => {
    const body = z.object({ termEnds: z.coerce.date() }).parse(req.body);
    return endIccMemberTerm(req.params.id, body.termEnds);
  }),
);

router.post('/posh/committee/validate', handler(async () => validateCommittee()));

router.get('/posh/complaints', handler(async () => listPoshComplaints()));

router.post(
  '/posh/complaints',
  handler(async (req) => {
    const body = z
      .object({
        complainantPersonId: z.string().nullish(),
        complainantText: z.string().nullish(),
        respondentPersonId: z.string().nullish(),
        respondentText: z.string().nullish(),
        receivedOn: z.coerce.date(),
      })
      .parse(req.body);
    return createPoshComplaint(body);
  }),
);

router.post(
  '/posh/complaints/:id/transition',
  handler(async (req) => {
    const body = z
      .object({
        status: z.enum(['received', 'inquiry', 'report_submitted', 'closed', 'withdrawn']),
        findings: z.string().optional(),
        action: z.string().optional(),
      })
      .parse(req.body);
    return transitionPoshComplaint(req.params.id, body.status, body);
  }),
);

router.get('/posh/workshops', handler(async () => listPoshWorkshops()));

router.post(
  '/posh/workshops',
  handler(async (req) => {
    const body = z.object({ heldOn: z.coerce.date(), topic: z.string().min(1), attendeeCount: z.number().int(), note: z.string().nullish() }).parse(req.body);
    return createPoshWorkshop(body);
  }),
);

router.get(
  '/posh/annual-report/:year',
  handler(async (req) => poshAnnualReport(Number(req.params.year))),
);

router.post(
  '/posh/annual-report/:year/file',
  handler(async (req) => markPoshAnnualReportFiled(Number(req.params.year))),
);

// ---------------------------------------------------------------------------
// Disciplinary
// ---------------------------------------------------------------------------

router.get('/disciplinary', handler(async (req) => listDisciplinaryCases(str(req.query.employmentId))));

router.post(
  '/disciplinary',
  handler(async (req) => {
    const body = z
      .object({ employmentRelationshipId: z.string(), showCauseIssuedAt: z.coerce.date().optional(), note: z.string().min(1) })
      .parse(req.body);
    return openDisciplinaryCase(body);
  }),
);

router.post(
  '/disciplinary/:id/advance',
  handler(async (req) => {
    const body = z
      .object({
        event: z.enum(['reply', 'inquiry', 'decision', 'close']),
        note: z.string().min(1),
        inquiryOfficer: z.string().optional(),
        decision: z.string().optional(),
        outcome: z.enum(['warning', 'suspension', 'termination', 'none']).optional(),
      })
      .parse(req.body);
    return advanceDisciplinaryCase(req.params.id, body);
  }),
);

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

router.get(
  '/letters',
  handler(async (req) => listLetters({ employmentRelationshipId: str(req.query.employmentId), applicationId: str(req.query.applicationId) })),
);

router.get(
  '/letters/:id/document',
  handler(async (req) => letterDocument(req.params.id)),
);

// ---------------------------------------------------------------------------
// Consents
// ---------------------------------------------------------------------------

router.post('/employees/:id/bgv-consent', handler(async (req) => recordBgvConsent(req.params.id)));
router.post('/employees/:id/code-of-conduct-ack', handler(async (req) => recordCodeOfConductAck(req.params.id)));

export default router;
