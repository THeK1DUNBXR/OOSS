/**
 * FX-22: two leave-policy deletes removed rows with no audit row. deleteApprovalChain
 * and withdrawRestrictedHolidayElection now audit the delete, in the same
 * transaction, against the row that was removed.
 */

import { describe, expect, it } from 'vitest';
import { deleteApprovalChain, withdrawRestrictedHolidayElection } from '../domains/hcm/leavepolicy.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';

describe('leave policy deletes — audit', () => {
  it('deleting an approval chain writes a delete audit row against the chain', async () => {
    const tid = await tenantId();
    const chain = await unscopedPrisma.leaveApprovalChain.create({
      data: { tenantId: tid, name: 'FX-22 chain audit probe', levels: [] },
    });

    await asUser('chairman@kaizen.co.in', () => deleteApprovalChain(chain.id));

    expect(await unscopedPrisma.leaveApprovalChain.findFirst({ where: { id: chain.id } })).toBeNull();
    const audit = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'leave_approval_chain', subjectId: chain.id },
    });
    expect(audit.map((r) => r.action)).toContain('delete');
  });

  it('withdrawing a restricted holiday election writes a delete audit row against the election', async () => {
    const tid = await tenantId();
    const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { tenantId: tid } });
    const holiday = await unscopedPrisma.holiday.findFirstOrThrow({ where: { tenantId: tid } });
    await unscopedPrisma.restrictedHolidayElection.deleteMany({
      where: { tenantId: tid, employmentRelationshipId: employment.id, holidayId: holiday.id },
    });
    const election = await unscopedPrisma.restrictedHolidayElection.create({
      data: { tenantId: tid, employmentRelationshipId: employment.id, holidayId: holiday.id, fy: '2099-00' },
    });

    await asUser('chairman@kaizen.co.in', () => withdrawRestrictedHolidayElection(election.id));

    expect(await unscopedPrisma.restrictedHolidayElection.findFirst({ where: { id: election.id } })).toBeNull();
    const audit = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'restricted_holiday_election', subjectId: election.id },
    });
    expect(audit.map((r) => r.action)).toContain('delete');
  });
});
