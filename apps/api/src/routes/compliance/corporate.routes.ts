/**
 * Compliance — corporate (docs/plan/compliance.md, H). Mounted at
 * /api/compliance/corporate; requireAuth is already applied by
 * routes/compliance/index.ts's mount of /api/compliance.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import { REGISTER_KINDS, BOARD_MEETING_KINDS, BOARD_RESOLUTION_KINDS, CERTIFICATE_KINDS, MCA_FILINGS } from '@kaizen/shared';
import {
  securityPolicy,
  updateSecurityPolicy,
  listBackups,
  runBackup,
  listRegisterEntries,
  createRegisterEntry,
  currentRegister,
  exportRegisterCsv,
  listBoardMeetings,
  getBoardMeeting,
  createBoardMeeting,
  updateBoardMeetingMinutes,
  recordBoardMeeting,
  addBoardResolution,
  listMcaFilings,
  createMcaFiling,
  markMcaFilingFiled,
  listStampDutyRules,
  listRetentionRules,
  requestESignature,
  markESigned,
  applyRetention,
  setForeignReceiptDetails,
  listRefunds,
  requestRefund,
  approveRefund,
  payRefund,
  currentRefundPolicy,
  listRefundPolicyVersions,
  publishRefundPolicy,
  listCertificates,
  issueCertificate,
  verifyCertificate,
} from '../../domains/compliance/corporate.js';
import { currentAuth } from '../../platform/context.js';

const router = Router();

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

router.get('/security/policy', handler(async () => securityPolicy()));

router.patch(
  '/security/policy',
  handler(async (req) => {
    const schema = z.object({
      mfaRequiredForRoleSlugs: z.array(z.string()).optional(),
      sessionHours: z.number().int().positive().optional(),
      passwordMinLength: z.number().int().min(8).optional(),
    });
    return updateSecurityPolicy(schema.parse(req.body));
  }),
);

router.get('/security/backups', handler(async () => listBackups()));

router.post(
  '/security/backups/run',
  handler(async () => {
    const auth = currentAuth();
    return runBackup(auth.tenantId);
  }),
);

// ---------------------------------------------------------------------------
// Statutory registers
// ---------------------------------------------------------------------------

const registerKindSchema = z.enum(REGISTER_KINDS);

router.get(
  '/registers',
  handler(async (req) => {
    const kind = str(req.query.kind);
    return listRegisterEntries(kind ? registerKindSchema.parse(kind) : undefined, str(req.query.subjectKey));
  }),
);

router.get(
  '/registers/:kind/current',
  handler(async (req) => currentRegister(registerKindSchema.parse(req.params.kind))),
);

router.get('/registers/:kind/export.csv', async (req, res, next) => {
  try {
    const kind = registerKindSchema.parse(req.params.kind);
    const csv = await exportRegisterCsv(kind);
    res.setHeader('content-type', 'text/csv');
    res.setHeader('content-disposition', `attachment; filename="${kind}-register.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/registers',
  handler(async (req) => {
    const schema = z.object({
      registerKind: registerKindSchema,
      subjectKey: z.string().min(1),
      body: z.record(z.string(), z.unknown()),
      supersedesId: z.string().optional(),
    });
    return createRegisterEntry(schema.parse(req.body));
  }),
);

// ---------------------------------------------------------------------------
// Board minutes
// ---------------------------------------------------------------------------

router.get('/board/meetings', handler(async () => listBoardMeetings()));
router.get('/board/meetings/:id', handler(async (req) => getBoardMeeting(req.params.id)));

router.post(
  '/board/meetings',
  handler(async (req) => {
    const schema = z.object({
      kind: z.enum(BOARD_MEETING_KINDS),
      heldOn: z.coerce.date(),
      noticeOn: z.coerce.date().optional(),
      quorum: z.string().optional(),
      attendees: z.array(z.unknown()).optional(),
    });
    return createBoardMeeting(schema.parse(req.body));
  }),
);

router.patch(
  '/board/meetings/:id/minutes',
  handler(async (req) => {
    const schema = z.object({ minutes: z.string() });
    return updateBoardMeetingMinutes(req.params.id, schema.parse(req.body).minutes);
  }),
);

router.post('/board/meetings/:id/record', handler(async (req) => recordBoardMeeting(req.params.id)));

router.post(
  '/board/meetings/:id/resolutions',
  handler(async (req) => {
    const schema = z.object({
      subject: z.string().min(1),
      text: z.string().min(1),
      kind: z.enum(BOARD_RESOLUTION_KINDS),
      passedOn: z.coerce.date(),
      correctsId: z.string().optional(),
    });
    const input = schema.parse(req.body);
    return addBoardResolution({ ...input, meetingId: req.params.id });
  }),
);

// ---------------------------------------------------------------------------
// MCA filings
// ---------------------------------------------------------------------------

const mcaFormSchema = z.enum(MCA_FILINGS.map((f) => f.form) as [string, ...string[]]);

router.get('/mca/filings', handler(async (req) => listMcaFilings(str(req.query.fy))));
router.get('/mca/filings/types', handler(async () => MCA_FILINGS));

router.post(
  '/mca/filings',
  handler(async (req) => {
    const schema = z.object({ form: mcaFormSchema, fy: z.string() });
    const input = schema.parse(req.body);
    return createMcaFiling({ form: input.form as never, fy: input.fy });
  }),
);

router.post(
  '/mca/filings/:id/file',
  handler(async (req) => {
    const schema = z.object({ srn: z.string().min(1), filedOn: z.coerce.date() });
    return markMcaFilingFiled(req.params.id, schema.parse(req.body));
  }),
);

// ---------------------------------------------------------------------------
// Contracts: stamp duty, e-signature, retention
// ---------------------------------------------------------------------------

router.get('/contracts/stamp-duty-rules', handler(async () => listStampDutyRules()));
router.get('/contracts/retention-rules', handler(async () => listRetentionRules()));

router.post(
  '/documents/:id/esign',
  handler(async (req) => {
    const schema = z.object({ signers: z.array(z.object({ name: z.string(), email: z.string().email() })).min(1) });
    return requestESignature(req.params.id, schema.parse(req.body).signers);
  }),
);

router.post(
  '/documents/:id/esign/mark-signed',
  handler(async (req) => {
    await markESigned(req.params.id);
    return { ok: true };
  }),
);

router.post(
  '/documents/:id/retention',
  handler(async (req) => {
    const schema = z.object({ anchorDate: z.coerce.date() });
    return applyRetention(req.params.id, schema.parse(req.body).anchorDate);
  }),
);

// ---------------------------------------------------------------------------
// FEMA
// ---------------------------------------------------------------------------

router.patch(
  '/payments/:id/foreign',
  handler(async (req) => {
    const schema = z.object({
      foreignCurrency: z.string().optional().nullable(),
      foreignAmount: z.number().optional().nullable(),
      fircNumber: z.string().optional().nullable(),
      fircDate: z.coerce.date().optional().nullable(),
    });
    return setForeignReceiptDetails(req.params.id, schema.parse(req.body));
  }),
);

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

router.get('/refunds', handler(async (req) => listRefunds(str(req.query.status))));

router.post(
  '/refunds',
  handler(async (req) => {
    const schema = z.object({
      invoiceId: z.string().optional(),
      receiptId: z.string().optional(),
      amount: z.number().positive(),
      reason: z.string().min(1),
    });
    return requestRefund(schema.parse(req.body));
  }),
);

router.post('/refunds/:id/approve', handler(async (req) => approveRefund(req.params.id)));

router.post(
  '/refunds/:id/pay',
  handler(async (req) => {
    const schema = z.object({ accountId: z.string(), method: z.string().optional(), reference: z.string().optional() });
    return payRefund(req.params.id, schema.parse(req.body));
  }),
);

router.get('/refunds/policy', handler(async () => currentRefundPolicy()));
router.get('/refunds/policy/versions', handler(async () => listRefundPolicyVersions()));

router.post(
  '/refunds/policy',
  handler(async (req) => {
    const schema = z.object({
      text: z.string().min(1),
      rules: z.object({ fullWithinDays: z.number().int(), partialPercent: z.number(), noneAfterStartDays: z.number().int() }),
    });
    return publishRefundPolicy(schema.parse(req.body));
  }),
);

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

router.get('/certificates', handler(async (req) => listCertificates(str(req.query.enrollmentId))));

router.post(
  '/certificates',
  handler(async (req) => {
    const schema = z.object({
      enrollmentId: z.string(),
      kind: z.enum(CERTIFICATE_KINDS),
      snapshot: z.record(z.string(), z.unknown()),
    });
    return issueCertificate(schema.parse(req.body));
  }),
);

// Public-shaped (a verification code, not an id) but still behind requireAuth
// via this router's mount — see certificates.ts's own note.
router.get('/certificates/verify/:code', handler(async (req) => verifyCertificate(req.params.code)));

export default router;
