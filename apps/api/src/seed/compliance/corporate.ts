/**
 * Compliance — corporate. Rate tables and other structure the tenant needs
 * before use. Safe to re-run — every write here is an upsert or a
 * find-or-create, never a blind insert.
 */
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';

const STAMP_DUTY_EFFECTIVE_FROM = new Date('2017-07-01T00:00:00.000Z'); // TN Stamp Act, as amended — GST-era baseline.

export async function seedCorporate(): Promise<void> {
  const auth = currentAuth();
  const tenantId = auth.tenantId;

  await prisma.securityPolicy.upsert({
    where: { tenantId },
    create: { tenantId, mfaRequiredForRoleSlugs: ['finance_head', 'chairman'] },
    update: {},
  });

  // Placeholder Tamil Nadu stamp duty figures — confirm against the current
  // TN Stamp Act schedule before relying on these for a real filing. Seeded
  // so the contract-signing gate has something to check against; a tenant
  // that has not confirmed its own figures can still edit the rule before
  // the first real signature.
  const stampDutyDefaults: Array<{ agreementKind: string; percentOfValue?: number; flatAmount?: number; note: string }> = [
    { agreementKind: 'contract', percentOfValue: 0.1, note: 'Placeholder — confirm against the current TN Stamp Act schedule for a general commercial agreement.' },
    { agreementKind: 'mou', flatAmount: 100, note: 'Placeholder — an MoU with no consideration is usually a flat, nominal duty; confirm the figure.' },
    { agreementKind: 'partner_agreement', percentOfValue: 0.1, note: 'Placeholder — confirm against the current TN Stamp Act schedule.' },
  ];
  for (const rule of stampDutyDefaults) {
    const existing = await prisma.stampDutyRule.findFirst({
      where: { tenantId, agreementKind: rule.agreementKind, effectiveFrom: STAMP_DUTY_EFFECTIVE_FROM },
    });
    if (!existing) {
      await prisma.stampDutyRule.create({
        data: {
          tenantId,
          agreementKind: rule.agreementKind,
          effectiveFrom: STAMP_DUTY_EFFECTIVE_FROM,
          percentOfValue: rule.percentOfValue ?? null,
          flatAmount: rule.flatAmount ?? null,
          note: rule.note,
        },
      });
    }
  }

  const retentionDefaults: Array<{ documentKind: string; anchor: string; years: number }> = [
    { documentKind: 'contracts', anchor: 'after_expiry', years: 8 },
    { documentKind: 'invoices', anchor: 'after_fy_end', years: 8 },
    { documentKind: 'hr_files', anchor: 'after_exit', years: 3 },
  ];
  for (const rule of retentionDefaults) {
    const existing = await prisma.documentRetentionRule.findFirst({
      where: { tenantId, documentKind: rule.documentKind, effectiveFrom: STAMP_DUTY_EFFECTIVE_FROM },
    });
    if (!existing) {
      await prisma.documentRetentionRule.create({
        data: { tenantId, documentKind: rule.documentKind, anchor: rule.anchor, years: rule.years, effectiveFrom: STAMP_DUTY_EFFECTIVE_FROM },
      });
    }
  }

  const existingPolicy = await prisma.refundPolicy.findFirst({ where: { tenantId } });
  if (!existingPolicy) {
    await prisma.refundPolicy.create({
      data: {
        tenantId,
        version: 1,
        text:
          'A course fee is refunded in full when the request is made within 7 days of enrolment and before the ' +
          'course has started. A partial refund of 50% applies within 14 days of enrolment, before the course has ' +
          'started. No refund applies once the course has started. This is the platform\'s seeded starting policy — ' +
          'the company has not yet confirmed its own written refund policy (docs/plan/compliance.md, open question).',
        rules: { fullWithinDays: 7, partialPercent: 50, noneAfterStartDays: 0 },
        effectiveFrom: new Date(),
      },
    });
  }
}
