/**
 * MCA filings — AOC-4, MGT-7/7A, DIR-3 KYC, ADT-1, DPT-3, MSME-1
 * (docs/plan/compliance.md, H). The obligation *types* are `MCA_FILINGS` in
 * shared, for workstream A's calendar to seed as `ComplianceObligation` rows;
 * this is the filing record itself, once one is actually filed.
 */

import type { McaFilingForm } from '@kaizen/shared';
import { prisma } from '../../../platform/db.js';
import { currentAuth } from '../../../platform/context.js';
import { ApiError } from '../../../platform/errors.js';
import { assertCan } from '../../../platform/permissions.js';
import { auditWrite } from '../../../platform/audit.js';
import { assertStepUpForApprove } from './security.js';
import { nextCorporateCode } from './codes.js';

export async function listMcaFilings(fy?: string) {
  await assertCan({ resource: 'corporate_registers', verb: 'view' });
  const auth = currentAuth();
  return prisma.mcaFiling.findMany({
    where: { tenantId: auth.tenantId, ...(fy ? { fy } : {}) },
    orderBy: [{ fy: 'desc' }, { form: 'asc' }],
  });
}

export async function createMcaFiling(input: { form: McaFilingForm; fy: string }) {
  await assertCan({ resource: 'corporate_registers', verb: 'create' });
  const auth = currentAuth();
  const recordCode = await nextCorporateCode('MCA');
  const filing = await prisma.mcaFiling.create({
    data: { tenantId: auth.tenantId, recordCode, form: input.form, fy: input.fy, status: 'pending', createdById: auth.partyId },
  });
  await auditWrite({ action: 'create', subjectType: 'mca_filing', subjectId: filing.id, after: { recordCode, form: input.form, fy: input.fy } });
  return filing;
}

/** Filing is an approve-shaped act (CMP-COR-002): gated the same way a refund payout is. */
export async function markMcaFilingFiled(id: string, input: { srn: string; filedOn: Date }) {
  await assertStepUpForApprove('Recording an MCA filing as filed');
  await assertCan({ resource: 'corporate_registers', verb: 'edit' });
  const auth = currentAuth();
  const filing = await prisma.mcaFiling.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!filing) throw ApiError.notFound('MCA filing');
  if (filing.status === 'filed') {
    throw ApiError.unprocessable('This filing is already recorded as filed. A correction is a new filing row, not an edit to this one.');
  }

  const updated = await prisma.mcaFiling.update({
    where: { id },
    data: { status: 'filed', srn: input.srn, filedOn: input.filedOn },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'mca_filing',
    subjectId: id,
    before: { status: filing.status },
    after: { status: 'filed', srn: input.srn },
  });
  return updated;
}
