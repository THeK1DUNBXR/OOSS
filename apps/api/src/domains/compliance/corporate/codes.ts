/**
 * Internal record codes for this workstream's own entities, generated
 * through the same gapless per-tenant-per-year sequence `recordCode.ts`
 * uses, without extending the shared `RECORD_TYPE_CODES` union — mirroring
 * how `platform/documentNumber.ts` keys its own series (`DOC:${series}`)
 * off the same table without touching that union either.
 */

import { prisma } from '../../../platform/db.js';
import { currentTenantId } from '../../../platform/context.js';

export type CorporatePrefix = 'BM' | 'BR' | 'REG' | 'MCA';

export async function nextCorporateCode(prefix: CorporatePrefix, at: Date = new Date()): Promise<string> {
  const tenantId = currentTenantId();
  const year = at.getUTCFullYear();
  const entityType = `CMPCOR:${prefix}`;

  const row = await prisma.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId, entityType, year } },
    create: { tenantId, entityType, year, nextSequence: 2 },
    update: { nextSequence: { increment: 1 } },
    select: { nextSequence: true },
  });
  const seq = row.nextSequence - 1;
  return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
}
