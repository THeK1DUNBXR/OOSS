/**
 * FX-22 (CLAUDE.md rule 5: assertCan, write, auditWrite, emit): the HCM and
 * payroll writes that had no audit row now write one.
 *
 * One representative write per changed file is performed, and its AuditRecord
 * rows are counted for the subject it wrote. The count is exact: a write that
 * audits twice is as wrong as one that does not audit. Where one domain call
 * makes several writes (a payroll run's compute), the row is picked out by the
 * field only that write records, and the count is exact on that row.
 *
 * Each test makes its own records (an org unit, a job, a person, an employment,
 * a pay period nobody else has opened), so no test depends on demo rows that
 * another test may change.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, prisma, tenantId, unscopedPrisma } from './helpers.js';
import { createJob, createOrgUnit, hire, transitionEmployment } from '../domains/employment.js';
import { createBenefitPlan } from '../domains/hcm/compensation.js';
import { acknowledgeAnnouncement, createAnnouncement } from '../domains/hcm/engagement.js';
import { createBudget } from '../domains/hcm/learning.js';
import { electRestrictedHoliday } from '../domains/hcm/leavepolicy.js';
import { createReviewTemplate } from '../domains/hcm/performance.js';
import { createOnboardingTemplate } from '../domains/hcm/recruiting.js';
import { initiateClearance } from '../domains/hcm/separations.js';
import { addTimesheetEntry } from '../domains/hcm/time.js';
import { createLeaveType } from '../domains/leave.js';
import { openPayrollRun, transitionPayrollRun } from '../domains/payroll.js';
import { computeInstruction } from '../domains/compliance/payroll.js';
import { createLearningActivity } from '../domains/performance.js';
import { createPoshWorkshop } from '../domains/compliance/labour.js';
import { runGratuityAccrual } from '../jobs/compliance/payroll.js';
import { nextRecordCode } from '../platform/recordCode.js';

const CHAIRMAN = 'chairman@kaizen.co.in';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

function stamp(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Every audit row for one subject, oldest first. */
async function auditRowsFor(subjectType: string, subjectId: string) {
  return unscopedPrisma.auditRecord.findMany({
    where: { tenantId: TENANT, subjectType, subjectId },
    orderBy: { seq: 'asc' },
  });
}

/** A pay period in 2099 that no payroll run has opened yet in this tenant. */
async function freePayPeriod(): Promise<string> {
  for (let month = 1; month <= 12; month += 1) {
    const payPeriod = `2099-${String(month).padStart(2, '0')}`;
    const taken = await unscopedPrisma.payrollRun.findFirst({ where: { tenantId: TENANT, payPeriod } });
    if (!taken) return payPeriod;
  }
  throw new Error('No free 2099 pay period is left in the test tenant.');
}

/** A person hired into a position of their own, and activated. Runs as the chairman. */
async function freshEmployment(): Promise<{ personId: string; employmentId: string }> {
  const s = stamp();
  const job = await createJob({ title: `FX22 job ${s}`, jobFamily: 'test', jobLevel: 'L1' });
  const orgUnit = await createOrgUnit({ name: `FX22 unit ${s}` });
  const position = await prisma.position.create({
    data: {
      tenantId: TENANT,
      recordCode: await nextRecordCode('POS'),
      jobId: job.id,
      orgUnitId: orgUnit.id,
      status: 'Open',
    },
  });
  const person = await prisma.person.create({
    data: {
      tenantId: TENANT,
      recordCode: await nextRecordCode('PER'),
      fullName: `FX22 ${s}`,
      primaryEmail: `fx22.${s}@example.com`,
      source: 'test',
    },
  });
  const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
  await transitionEmployment(employment.id, 'ACTIVATE');
  return { personId: person.id, employmentId: employment.id };
}

describe('FX-22 audit coverage: HCM and payroll writes', () => {
  it('employment.ts createOrgUnit writes one create row for the unit', async () => {
    await asUser(CHAIRMAN, async () => {
      const unit = await createOrgUnit({ name: `FX22 unit ${stamp()}` });
      const rows = await auditRowsFor('org_unit', unit.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('create');
    });
  });

  it('hcm/compensation.ts createBenefitPlan writes one create row for the plan', async () => {
    await asUser(CHAIRMAN, async () => {
      const plan = await createBenefitPlan({
        name: `FX22 plan ${stamp()}`,
        kind: 'health',
        employerContribution: 1000,
        employeeContribution: 500,
      });
      const rows = await auditRowsFor('benefit_plan', plan.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('create');
    });
  });

  it('hcm/engagement.ts acknowledgeAnnouncement writes one row for the first acknowledgement only', async () => {
    await asUser(CHAIRMAN, async () => {
      const announcement = await createAnnouncement({
        title: `FX22 ${stamp()}`,
        body: 'Acknowledge this.',
        acknowledgementRequired: true,
      });
      const first = await acknowledgeAnnouncement(announcement.id);
      expect(await auditRowsFor('announcement_ack', first.id)).toHaveLength(1);

      // A repeat acknowledgement changes nothing and is not recorded again.
      await acknowledgeAnnouncement(announcement.id);
      expect(await auditRowsFor('announcement_ack', first.id)).toHaveLength(1);
    });
  });

  it('hcm/learning.ts createBudget writes one create row for the budget', async () => {
    await asUser(CHAIRMAN, async () => {
      const budget = await createBudget({ fy: '2099-00', division: `FX22-${stamp()}`, amount: 1000 });
      const rows = await auditRowsFor('training_budget', budget.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('create');
    });
  });

  it('hcm/leavepolicy.ts electRestrictedHoliday writes one create row for the election', async () => {
    await asUser(CHAIRMAN, async () => {
      const { employmentId } = await freshEmployment();
      const holiday = await prisma.holiday.create({
        data: {
          tenantId: TENANT,
          date: new Date(Date.UTC(2099, 0, 26)),
          name: `FX22 restricted ${stamp()}`,
          kind: 'restricted',
        },
      });
      const election = await electRestrictedHoliday({
        employmentRelationshipId: employmentId,
        holidayId: holiday.id,
        fy: '2099-00',
      });
      const rows = await auditRowsFor('restricted_holiday_election', election.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('create');
    });
  });

  it('hcm/performance.ts createReviewTemplate writes one create row for the template', async () => {
    await asUser(CHAIRMAN, async () => {
      const template = await createReviewTemplate({
        name: `FX22 template ${stamp()}`,
        sections: [{ key: 'delivery', title: 'Delivery', weight: 1 }],
        ratingScale: [
          { value: 1, label: 'Poor' },
          { value: 5, label: 'Strong' },
        ],
      });
      const rows = await auditRowsFor('review_template', template.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('create');
    });
  });

  it('hcm/recruiting.ts createOnboardingTemplate writes one create row for the template', async () => {
    await asUser(CHAIRMAN, async () => {
      const template = await createOnboardingTemplate({ title: `FX22 task ${stamp()}`, assignee: 'hr' });
      const rows = await auditRowsFor('onboarding_task_template', template.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('create');
    });
  });

  it('hcm/separations.ts initiateClearance writes one create row per clearance it opens', async () => {
    await asUser(CHAIRMAN, async () => {
      const { employmentId } = await freshEmployment();
      await transitionEmployment(employmentId, 'SUBMIT_RESIGNATION', { note: 'FX22 test resignation' });
      const offboarding = await unscopedPrisma.offboarding.findUniqueOrThrow({
        where: { employmentRelationshipId: employmentId },
      });
      await initiateClearance(offboarding.id);

      const clearances = await unscopedPrisma.exitClearance.findMany({
        where: { tenantId: TENANT, offboardingId: offboarding.id },
      });
      expect(clearances.length).toBeGreaterThan(0);
      for (const clearance of clearances) {
        const rows = await auditRowsFor('exit_clearance', clearance.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.action).toBe('create');
      }
    });
  });

  it('hcm/time.ts addTimesheetEntry writes one create row for the entry', async () => {
    await asUser(CHAIRMAN, async () => {
      const { employmentId } = await freshEmployment();
      const entry = await addTimesheetEntry({ employmentRelationshipId: employmentId, date: new Date(), hours: 8 });
      const rows = await auditRowsFor('timesheet_entry', entry.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('create');
    });
  });

  it('leave.ts createLeaveType writes one create row for the leave type', async () => {
    await asUser(CHAIRMAN, async () => {
      const leaveType = await createLeaveType({ code: `FX${stamp()}`, name: `FX22 leave ${stamp()}` });
      const rows = await auditRowsFor('leave_type', leaveType.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('create');
    });
  });

  it('payroll.ts transitionPayrollRun writes one run row carrying the instructions moved', async () => {
    await asUser(CHAIRMAN, async () => {
      const run = await openPayrollRun(await freePayPeriod());
      await transitionPayrollRun(run.id, 'COMPUTE');

      // The run's audit rows are the preparer, the transition and this write.
      // Only this write records instructionsMoved, so that is the one counted.
      const rows = (await auditRowsFor('payroll_run', run.id)).filter(
        (row) => typeof row.meta === 'object' && row.meta !== null && 'instructionsMoved' in row.meta,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('update');
    });
  });

  it('domains/performance.ts createLearningActivity writes one create row for the activity', async () => {
    await asUser(CHAIRMAN, async () => {
      const activity = await createLearningActivity({ title: `FX22 course ${stamp()}`, cost: 0 });
      const rows = await auditRowsFor('learning_activity', activity.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('create');
    });
  });

  it('compliance/labour.ts createPoshWorkshop writes one create row for the workshop', async () => {
    await asUser(CHAIRMAN, async () => {
      const workshop = await createPoshWorkshop({
        heldOn: new Date(),
        topic: `FX22 ${stamp()}`,
        attendeeCount: 4,
      });
      const rows = await auditRowsFor('posh_workshop', workshop.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('create');
    });
  });

  it('compliance/payroll.ts computeInstruction writes one update row per instruction it computes', async () => {
    await asUser(CHAIRMAN, async () => {
      // A non-employee takes the zero-statutory path, which needs no salary
      // structure or rate tables in place, so the write is certain to happen.
      const { employmentId } = await freshEmployment();
      await unscopedPrisma.employmentRelationship.update({
        where: { id: employmentId },
        data: { engagementType: 'contractor' },
      });
      const run = await openPayrollRun(await freePayPeriod());
      await computeInstruction(run.id);

      const instruction = await unscopedPrisma.payrollInstruction.findFirstOrThrow({
        where: { tenantId: TENANT, payrollRunId: run.id, employmentRelationshipId: employmentId },
      });
      const rows = await auditRowsFor('payroll_instruction', instruction.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('update');
    });
  });

  it('jobs/compliance/payroll.ts runGratuityAccrual writes one create row per accrual it makes', async () => {
    await asUser(CHAIRMAN, async () => {
      const before = new Set(
        (await unscopedPrisma.gratuityAccrual.findMany({ where: { tenantId: TENANT } })).map((a) => a.id),
      );
      await runGratuityAccrual();
      const created = (await unscopedPrisma.gratuityAccrual.findMany({ where: { tenantId: TENANT } })).filter(
        (a) => !before.has(a.id),
      );
      // Depends on the seeded employees having basic pay and a gratuity rule in
      // force. If this fails with zero accruals, check those first.
      expect(created.length).toBeGreaterThan(0);
      for (const accrual of created) {
        const rows = await auditRowsFor('gratuity_accrual', accrual.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.action).toBe('create');
      }
    });
  });
});
