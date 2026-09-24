/** Compliance — privacy (docs/plan/compliance.md §G). Safe to re-run. */
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import type { NoticePurpose } from '../../domains/compliance/privacy.js';

const PURPOSES: NoticePurpose[] = [
  {
    code: 'employment',
    label: 'Running the employment relationship',
    lawfulBasis: 'legal_obligation',
    dataCategories: ['contact details', 'PAN/Aadhaar', 'bank details', 'compensation', 'attendance'],
    retention: '8 years after the employment ends (Companies Act / Shops & Establishments)',
  },
  {
    code: 'education_delivery',
    label: 'Enrolling and teaching a learner',
    lawfulBasis: 'consent',
    dataCategories: ['contact details', 'date of birth', 'attendance', 'assessment records'],
    retention: '5 years after the last enrolment',
  },
  {
    code: 'invoicing',
    label: 'Billing for a course or service',
    lawfulBasis: 'legitimate_use',
    dataCategories: ['name', 'billing address', 'GSTIN where given'],
    retention: '8 years (Income Tax Act books-of-account requirement)',
  },
  {
    code: 'statutory_filing',
    label: 'Filing GST, TDS and other statutory returns',
    lawfulBasis: 'legal_obligation',
    dataCategories: ['GSTIN', 'PAN', 'transaction values'],
    retention: '8 years',
  },
  {
    code: 'marketing',
    label: 'Telling you about courses, offers and events',
    lawfulBasis: 'consent',
    dataCategories: ['name', 'phone', 'email'],
    retention: 'Until consent is withdrawn',
  },
];

const RETENTION_SCHEDULE = [
  { retentionClass: 'standard', years: 3 },
  { retentionClass: 'employee_record', years: 8 },
  { retentionClass: 'student_record', years: 5 },
  { retentionClass: 'audit_record', years: 8 },
];

export async function seedPrivacy(): Promise<void> {
  const auth = currentAuth();

  const existingNotice = await prisma.privacyNotice.findFirst({ where: { tenantId: auth.tenantId, status: 'current' } });
  if (!existingNotice) {
    await prisma.privacyNotice.create({
      data: {
        tenantId: auth.tenantId,
        version: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        status: 'current',
        body:
          '# Privacy notice\n\n' +
          'Kaizen Infinities Pvt Ltd (KIPL) processes personal data for the purposes ' +
          'listed below, each under the lawful basis named against it. Where the ' +
          'basis is consent, it can be withdrawn at any time without affecting what ' +
          'was already done under it. Contact the grievance officer named on the ' +
          'company profile for an access, correction or erasure request.',
        purposes: PURPOSES as never,
      },
    });
  }

  for (const row of RETENTION_SCHEDULE) {
    const existing = await prisma.retentionSchedule.findFirst({
      where: { tenantId: auth.tenantId, retentionClass: row.retentionClass },
    });
    if (existing) continue;
    await prisma.retentionSchedule.create({
      data: { tenantId: auth.tenantId, retentionClass: row.retentionClass, years: row.years, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') },
    });
  }
}
