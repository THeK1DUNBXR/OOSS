import { Router } from 'express';
import { z } from 'zod';
import { NOTE_REASON_CODES, SUPPLY_TYPES } from '@kaizen/shared';
import { handler, str } from '../../lib/http.js';
import {
  classifyInvoiceLine,
  unclassifiedLines,
  setCourseGstExemption,
  applyReverseCharge,
  listRcmSelfInvoices,
  flaggedRcmBills,
  issueDebitNote,
  listDebitNotes,
  listCreditNotesWithReason,
  setCreditNoteReason,
  setEInvoiceConfig,
  eInvoiceConfig,
  requestEInvoice,
  eInvoiceStatusList,
  importGstr2b,
  gstr2bMatches,
  gstr2bSummary,
  gstExposure,
} from '../../domains/compliance/gst.js';

/** Compliance — gst (docs/plan/compliance.md). Mounted at /api/compliance/gst. */
const router = Router();

const supplyTypeEnum = z.enum(SUPPLY_TYPES as unknown as [string, ...string[]]);
const reasonCodeEnum = z.enum(NOTE_REASON_CODES as unknown as [string, ...string[]]);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

router.get(
  '/classification/unclassified',
  handler(async () => unclassifiedLines()),
);

router.patch(
  '/invoices/:invoiceId/lines/:lineId/classify',
  handler(async (req) => {
    const body = z
      .object({
        supplyType: supplyTypeEnum,
        exemptionNotification: z.string().nullish(),
        gstRate: z.number().min(0).max(100).nullish(),
      })
      .parse(req.body);
    return classifyInvoiceLine(req.params.invoiceId, req.params.lineId, body as never);
  }),
);

router.post(
  '/courses/:courseId/exemption',
  handler(async (req) => {
    const body = z
      .object({ active: z.boolean(), notification: z.string().nullish(), note: z.string().nullish() })
      .parse(req.body);
    return setCourseGstExemption(req.params.courseId, body as never);
  }),
);

// ---------------------------------------------------------------------------
// Reverse charge
// ---------------------------------------------------------------------------

router.post(
  '/vendor-bills/:id/rcm',
  handler(async (req) => {
    const body = z.object({ ratePct: z.number().positive().max(100), taxableValue: z.number().positive().nullish() }).parse(req.body);
    return applyReverseCharge(req.params.id, { ratePct: body.ratePct, taxableValue: body.taxableValue ?? undefined });
  }),
);

router.get(
  '/rcm/self-invoices',
  handler(async (req) => listRcmSelfInvoices(str(req.query.period))),
);

router.get(
  '/rcm/flagged-bills',
  handler(async () => flaggedRcmBills()),
);

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

router.post(
  '/invoices/:id/debit-note',
  handler(async (req) => {
    const body = z.object({ amount: z.number().positive(), reasonCode: reasonCodeEnum, note: z.string().nullish() }).parse(req.body);
    return issueDebitNote(req.params.id, body as never);
  }),
);

router.get(
  '/debit-notes',
  handler(async (req) => listDebitNotes(str(req.query.invoiceId))),
);

router.get(
  '/credit-notes',
  handler(async () => listCreditNotesWithReason()),
);

router.patch(
  '/credit-notes/:id/reason',
  handler(async (req) => {
    const body = z.object({ reasonCode: reasonCodeEnum }).parse(req.body);
    return setCreditNoteReason(req.params.id, body.reasonCode as never);
  }),
);

// ---------------------------------------------------------------------------
// E-invoicing
// ---------------------------------------------------------------------------

router.get(
  '/einvoice/config',
  handler(async () => eInvoiceConfig()),
);

router.post(
  '/einvoice/config',
  handler(async (req) => {
    const body = z.object({ provider: z.string().min(1), credentialsRef: z.string().nullish() }).parse(req.body);
    return setEInvoiceConfig(body);
  }),
);

router.post(
  '/invoices/:id/einvoice',
  handler(async (req) => requestEInvoice(req.params.id)),
);

router.get(
  '/einvoice/status',
  handler(async () => eInvoiceStatusList()),
);

// ---------------------------------------------------------------------------
// GSTR-2B reconciliation
// ---------------------------------------------------------------------------

const gstr2bRowSchema = z.object({
  ctin: z.string(),
  inum: z.string(),
  idt: z.string(),
  val: z.number(),
  itms: z.array(z.object({ txval: z.number().optional(), camt: z.number().optional(), samt: z.number().optional(), iamt: z.number().optional() })),
});

router.post(
  '/gstr2b/:period/import',
  handler(async (req) => {
    const body = z.object({ b2b: z.array(gstr2bRowSchema) }).parse(req.body);
    return importGstr2b({ period: req.params.period, b2b: body.b2b });
  }),
);

router.get(
  '/gstr2b/:period/matches',
  handler(async (req) => gstr2bMatches(req.params.period)),
);

router.get(
  '/gstr2b/:period/summary',
  handler(async (req) => gstr2bSummary(req.params.period)),
);

// ---------------------------------------------------------------------------
// Exposure
// ---------------------------------------------------------------------------

router.get(
  '/exposure/:period',
  handler(async (req) => gstExposure(req.params.period)),
);

export default router;
