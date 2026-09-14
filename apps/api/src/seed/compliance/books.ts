/**
 * Compliance — books. Retention policies, Schedule II useful lives and the
 * Income-tax block rates — the dated tables the depreciation and retention
 * reports read from, never a constant in domain code. Also backfills any
 * pre-existing AuditRecord rows without a hash into the chain, so the chain
 * is complete from the tenant's very first audited write, not only from the
 * moment this workstream shipped.
 */

import { currentTenantId } from '../../platform/context.js';
import { prisma } from '../../platform/db.js';
import { chainUnhashedAuditRecords } from '../../domains/compliance/books.js';

const EFFECTIVE_FROM = new Date(Date.UTC(2021, 3, 1)); // FY2021-22 onward, well before any seeded data.

async function upsertRetentionPolicy(entityType: string, years: number, basis: string): Promise<void> {
  const tenantId = currentTenantId();
  await prisma.retentionPolicy.upsert({
    where: { tenantId_entityType: { tenantId, entityType } },
    create: { tenantId, entityType, years, basis },
    update: { years, basis },
  });
}

async function upsertUsefulLife(assetClass: string, years: number, residualPercent = 5): Promise<void> {
  const tenantId = currentTenantId();
  await prisma.scheduleIIUsefulLife.upsert({
    where: { tenantId_assetClass_effectiveFrom: { tenantId, assetClass, effectiveFrom: EFFECTIVE_FROM } },
    create: { tenantId, assetClass, usefulLifeYears: years, residualPercent, effectiveFrom: EFFECTIVE_FROM },
    update: { usefulLifeYears: years, residualPercent },
  });
}

async function upsertItBlock(blockName: string, ratePercent: number): Promise<void> {
  const tenantId = currentTenantId();
  await prisma.incomeTaxDepreciationBlock.upsert({
    where: { tenantId_blockName_effectiveFrom: { tenantId, blockName, effectiveFrom: EFFECTIVE_FROM } },
    create: { tenantId, blockName, ratePercent, effectiveFrom: EFFECTIVE_FROM },
    update: { ratePercent },
  });
}

export async function seedBooks(): Promise<void> {
  const tenantId = currentTenantId();

  // Companies Act s128(5): books, vouchers and supporting documents for eight
  // financial years. The audit trail and the event log are held to the same
  // floor, so the platform's own evidence outlives the books it evidences.
  await upsertRetentionPolicy('transaction', 8, 'Companies Act s128(5): 8 FYs');
  await upsertRetentionPolicy('vendor_bill', 8, 'Companies Act s128(5): 8 FYs');
  await upsertRetentionPolicy('fixed_asset', 8, 'Companies Act s128(5): 8 FYs');
  await upsertRetentionPolicy('loan', 8, 'Companies Act s128(5): 8 FYs');
  await upsertRetentionPolicy('audit_record', 8, 'Companies (Accounts) Rules 2014, r.3(1) audit-trail proviso: 8 FYs');
  await upsertRetentionPolicy('event_record', 8, 'Companies (Accounts) Rules 2014, r.3(1) audit-trail proviso: 8 FYs');

  // Schedule II, Part C useful lives, 5% residual (the Schedule's own default).
  await upsertUsefulLife('computers', 3);
  await upsertUsefulLife('office_equipment', 5);
  await upsertUsefulLife('furniture', 10);
  await upsertUsefulLife('vehicles', 8);
  await upsertUsefulLife('plant', 15);
  await upsertUsefulLife('buildings', 60);
  await upsertUsefulLife('intangibles', 5);

  // Income-tax Act block-of-assets WDV rates (Appendix I, the common blocks).
  await upsertItBlock('computers', 40);
  await upsertItBlock('office_equipment', 15);
  await upsertItBlock('furniture', 10);
  await upsertItBlock('vehicles', 15);
  await upsertItBlock('plant', 15);
  await upsertItBlock('buildings', 10);
  await upsertItBlock('intangibles', 25);

  await chainUnhashedAuditRecords(tenantId);
}
