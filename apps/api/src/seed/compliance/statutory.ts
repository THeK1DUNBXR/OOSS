import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';

const EFFECTIVE_FROM = new Date('2025-09-22T00:00:00.000Z');

/**
 * The pack is deliberately marked for legal verification. It makes the
 * effective-dated shape available without pretending that this seed is a
 * gazette or a substitute for counsel's sign-off.
 */
export async function seedStatutory(): Promise<void> {
  const tenantId = currentAuth().tenantId;
  const rules = [
    {
      domain: 'gst',
      key: 'gst.rate.slabs',
      jurisdiction: 'IN',
      value: { status: 'needs_legal_verification', rates: ['0', '5', '18', '40'], effectiveDate: '2025-09-22' },
      source: 'Phase 3 brief; verify against the applicable CBIC notification before production use.',
    },
    {
      domain: 'pf',
      key: 'pf.wage_ceiling',
      jurisdiction: 'IN',
      value: { status: 'needs_legal_verification', amountMinor: '1500000', currency: 'INR' },
      source: 'Phase 3 brief; verify current EPF Scheme notification before production use.',
    },
    {
      domain: 'esi',
      key: 'esi.contribution_period',
      jurisdiction: 'IN',
      value: { status: 'needs_legal_verification', periods: ['APR-SEP', 'OCT-MAR'] },
      source: 'Phase 3 brief; verify current ESIC notification before production use.',
    },
    {
      domain: 'pt',
      key: 'pt.local_body_schedule',
      jurisdiction: 'IN-TN',
      value: { status: 'needs_local_body_confirmation', localBodyRequired: true, slabs: [] },
      source: 'Tamil Nadu local-body schedule must be supplied per municipality before payroll use.',
    },
    {
      domain: 'tds',
      key: 'tds.forms',
      jurisdiction: 'IN',
      value: { status: 'needs_gazette_verification', forms: {} },
      source: 'Read the current Income-tax Rules and notified appendices before generating certificates.',
    },
  ];

  for (const rule of rules) {
    const existing = await prisma.statutoryRule.findFirst({
      where: { tenantId, domain: rule.domain, key: rule.key, jurisdiction: rule.jurisdiction, effectiveFrom: EFFECTIVE_FROM },
    });
    if (!existing) {
      await prisma.statutoryRule.create({ data: { tenantId, effectiveFrom: EFFECTIVE_FROM, ...rule } });
    }
  }
}
