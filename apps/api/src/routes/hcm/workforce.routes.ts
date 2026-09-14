/**
 * HCM — workforce (docs/hcm/workforce.md). Mounted at /api/hcm/workforce.
 */
import { Router } from 'express';
import { z } from 'zod';
import { handler, str } from '../../lib/http.js';
import {
  getProfileExtension,
  upsertProfileExtension,
  listEmployeeDocuments,
  uploadEmployeeDocument,
  verifyEmployeeDocument,
  getEmployeeDocumentContent,
  listReportingLines,
  setReportingLine,
  orgChart,
  directorySearch,
  employee360,
  listCostCentres,
  createCostCentre,
  listLocations,
  createLocation,
  listGrades,
  createGrade,
  proposeStatusChange,
  listStatusChanges,
  decideStatusChange,
  applyStatusChange,
} from '../../domains/hcm/workforce.js';

const router = Router();

router.get('/_status', handler(async () => ({ module: 'workforce', ready: true })));

// ---------------------------------------------------------------------------
// Org chart & directory
// ---------------------------------------------------------------------------

router.get('/org-chart', handler(async () => orgChart()));

router.get(
  '/directory',
  handler(async (req) =>
    directorySearch({ q: str(req.query.q), orgUnitId: str(req.query.orgUnitId), status: str(req.query.status) }),
  ),
);

// ---------------------------------------------------------------------------
// Employee 360
// ---------------------------------------------------------------------------

router.get('/employees/:id/360', handler(async (req) => employee360(req.params.id)));

// ---------------------------------------------------------------------------
// Profile extension
// ---------------------------------------------------------------------------

router.get('/employees/:id/profile', handler(async (req) => getProfileExtension(req.params.id)));

const profileBody = z.object({
  gender: z.string().nullish(),
  maritalStatus: z.string().nullish(),
  nationality: z.string().nullish(),
  passportNumber: z.string().nullish(),
  passportExpiry: z.coerce.date().nullish(),
  emergencyContacts: z.array(z.object({ name: z.string(), relationship: z.string(), phone: z.string() })).optional(),
  currentAddress: z.record(z.unknown()).nullish(),
  permanentAddress: z.record(z.unknown()).nullish(),
  educationHistory: z.array(z.record(z.unknown())).optional(),
  previousEmployment: z.array(z.record(z.unknown())).optional(),
  dependants: z.array(z.record(z.unknown())).optional(),
});

router.patch(
  '/employees/:id/profile',
  handler(async (req) => upsertProfileExtension(req.params.id, profileBody.parse(req.body))),
);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

router.get('/employees/:id/documents', handler(async (req) => listEmployeeDocuments(req.params.id)));

router.post(
  '/employees/:id/documents',
  handler(async (req) => {
    const body = z
      .object({
        kind: z.enum(['id_proof', 'address_proof', 'education', 'offer', 'contract', 'other']),
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        content: z.string().min(1),
        expiresOn: z.coerce.date().nullish(),
      })
      .parse(req.body);
    return uploadEmployeeDocument(req.params.id, body);
  }),
);

router.get(
  '/documents/:id/content',
  handler(async (req, res) => {
    const doc = await getEmployeeDocumentContent(req.params.id);
    res.json({ filename: doc.filename, mimeType: doc.mimeType, content: doc.content });
  }),
);

router.post(
  '/documents/:id/verify',
  handler(async (req) => {
    const body = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    return verifyEmployeeDocument(req.params.id, body.note);
  }),
);

// ---------------------------------------------------------------------------
// Reporting lines
// ---------------------------------------------------------------------------

router.get('/employees/:id/reporting-lines', handler(async (req) => listReportingLines(req.params.id)));

router.post(
  '/reporting-lines',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        managerEmploymentRelationshipId: z.string(),
        kind: z.enum(['primary', 'dotted']).optional(),
        effectiveFrom: z.coerce.date().optional(),
      })
      .parse(req.body);
    return setReportingLine(body);
  }),
);

// ---------------------------------------------------------------------------
// Org design — cost centres, locations, grades
// ---------------------------------------------------------------------------

router.get('/cost-centres', handler(async () => listCostCentres()));
router.post(
  '/cost-centres',
  handler(async (req) => createCostCentre(z.object({ code: z.string().min(1), name: z.string().min(1) }).parse(req.body))),
);

router.get('/locations', handler(async () => listLocations()));
router.post(
  '/locations',
  handler(async (req) =>
    createLocation(
      z
        .object({
          name: z.string().min(1),
          kind: z.string().optional(),
          city: z.string().nullish(),
          state: z.string().nullish(),
          address: z.string().nullish(),
        })
        .parse(req.body),
    ),
  ),
);

router.get('/grades', handler(async () => listGrades()));
router.post(
  '/grades',
  handler(async (req) =>
    createGrade(z.object({ code: z.string().min(1), name: z.string().min(1), level: z.number().int() }).parse(req.body)),
  ),
);

// ---------------------------------------------------------------------------
// Employee status changes
// ---------------------------------------------------------------------------

router.get(
  '/status-changes',
  handler(async (req) => listStatusChanges(str(req.query.employmentRelationshipId))),
);

router.post(
  '/status-changes',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        kind: z.enum(['transfer', 'promotion', 'demotion', 'redesignation']),
        changes: z.object({
          designation: z.string().optional(),
          gradeId: z.string().optional(),
          costCentreId: z.string().optional(),
          locationId: z.string().optional(),
        }),
        reason: z.string().min(1),
        effectiveDate: z.coerce.date(),
      })
      .parse(req.body);
    return proposeStatusChange(body);
  }),
);

router.post(
  '/status-changes/:id/decide',
  handler(async (req) => {
    const body = z.object({ approve: z.boolean(), note: z.string().optional() }).parse(req.body);
    return decideStatusChange(req.params.id, body.approve, body.note);
  }),
);

router.post('/status-changes/:id/apply', handler(async (req) => applyStatusChange(req.params.id)));

export default router;
