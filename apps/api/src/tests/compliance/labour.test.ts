/**
 * Compliance — F. Labour law and conduct (docs/plan/compliance.md).
 *
 * CMP-LAB-001..004 plus holiday-aware leave counting, committee validation,
 * letter immutability and register CSV shape.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { financialYearOf, isoWeekLabel, isoWeekRange } from '@kaizen/shared';
import { asUser, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import { createLeaveRequest, accrueEntitlement } from '../../domains/leave.js';
import { createRequisition, transitionRequisition, createApplication, transitionApplication } from '../../domains/hiring.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import {
  createHoliday,
  runPoshOverdueCheck,
  createPoshComplaint,
  runWeeklyHoursCheck,
  createWorkingHoursRule,
  runLeaveYearClose,
  encashLeave,
  appointIccMember,
  validateCommittee,
  openDisciplinaryCase,
  advanceDisciplinaryCase,
  listLetters,
  registerEmployees,
  registerMusterRoll,
  recordBgvConsent,
  recordCodeOfConductAck,
} from '../../domains/compliance/labour.js';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

/** A throwaway employee, built fresh so a test that mutates state never collides with the seeded cast. */
async function makeEmployee(label: string, monthlyBasic = 30_000) {
  fixtureSeq += 1;
  const stamp = `${Date.now()}-${fixtureSeq}`;
  return asUser('operations@kaizen.co.in', async () => {
    const position = await prisma.position.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('POS'),
        jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        status: 'Open',
      },
    });
    const person = await prisma.person.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('PER'),
        fullName: `Fixture ${label} ${stamp}`,
        primaryEmail: `fixture.labour.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    await prisma.compensationRecord.create({
      data: {
        tenantId: TENANT,
        employmentRelationshipId: employment.id,
        revisionReason: 'initial',
        amount: monthlyBasic,
        basicPay: monthlyBasic,
        status: 'Effective',
        effectiveFrom: new Date(Date.now() - 30 * 86_400_000),
      },
    });
    return { employment, person, position };
  });
}

// ===========================================================================
// Holidays and holiday-aware leave counting
// ===========================================================================

describe('Holidays — leave arithmetic skips holidays and the weekly off', () => {
  it('a leave request spanning a holiday and a Sunday costs fewer days than the calendar span', async () => {
    const { employment } = await makeEmployee('holiday-leave');

    await asUser('operations@kaizen.co.in', async () => {
      // A Monday..Friday span with a mid-week holiday declared inside it.
      const monday = nextWeekday(1);
      const wednesday = new Date(monday.getTime() + 2 * 86_400_000);
      const friday = new Date(monday.getTime() + 4 * 86_400_000);

      await createHoliday({ date: wednesday, name: `Fixture Holiday ${Date.now()}`, kind: 'restricted' });

      const leaveType = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'EL' } });
      const request = await createLeaveRequest({
        employmentRelationshipId: employment.id,
        leaveTypeId: leaveType.id,
        startDate: monday,
        endDate: friday,
      });

      // Mon..Fri is 5 calendar days; the Wednesday holiday drops it to 4.
      expect(Number(request.days)).toBe(4);
    });
  });
});

/** A Monday well clear of the seeded national holidays (26 Jan, 15 Aug, 2 Oct) and of anything else the fixtures scheduled. */
function nextWeekday(target: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 100);
  while (d.getUTCDay() !== target) d.setUTCDate(d.getUTCDate() + 1);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ===========================================================================
// CMP-LAB-004 — leave carry-forward is idempotent
// ===========================================================================

describe('CMP-LAB-004 — leave carry-forward is idempotent against a re-run in the same period', () => {
  it('trims a balance to the cap once, and a second run in the same FY changes nothing', async () => {
    const { employment } = await makeEmployee('carry-forward');

    await asUser('operations@kaizen.co.in', async () => {
      const stamp = Date.now();
      const leaveType = await prisma.leaveType.create({
        data: {
          tenantId: TENANT,
          code: `CF${stamp}`,
          name: `Fixture Carry-Forward ${stamp}`,
          annualEntitlementDays: 20,
          carryForwardCapDays: 5,
        },
      });

      await accrueEntitlement({ employmentRelationshipId: employment.id, leaveTypeId: leaveType.id, days: 12 });

      const before = await prisma.leaveBalance.findFirstOrThrow({
        where: { tenantId: TENANT, employmentRelationshipId: employment.id, leaveTypeId: leaveType.id },
      });
      expect(Number(before.balanceDays)).toBe(12);

      const first = await runLeaveYearClose();
      expect(first.processed).toBeGreaterThan(0);

      const afterFirst = await prisma.leaveBalance.findFirstOrThrow({ where: { id: before.id } });
      expect(Number(afterFirst.balanceDays)).toBe(5); // trimmed to the cap

      const fy = financialYearOf(new Date());
      const closeRows = await prisma.leaveYearClose.findMany({ where: { tenantId: TENANT, leaveTypeId: leaveType.id, fy } });
      expect(closeRows).toHaveLength(1);

      const second = await runLeaveYearClose();
      // The type is already closed for this FY — nothing more is processed for it.
      const closeRowsAfter = await prisma.leaveYearClose.findMany({ where: { tenantId: TENANT, leaveTypeId: leaveType.id, fy } });
      expect(closeRowsAfter).toHaveLength(1);
      void second;

      const afterSecond = await prisma.leaveBalance.findFirstOrThrow({ where: { id: before.id } });
      expect(Number(afterSecond.balanceDays)).toBe(5); // unchanged
    });
  });
});

// ===========================================================================
// Leave encashment
// ===========================================================================

describe('Leave encashment', () => {
  it('writes an encashment transaction and a LeaveEncashment row at basic/26 x days', async () => {
    const { employment } = await makeEmployee('encash', 26_000); // basic/26 = 1000/day

    await asUser('operations@kaizen.co.in', async () => {
      const stamp = Date.now();
      const leaveType = await prisma.leaveType.create({
        data: {
          tenantId: TENANT,
          code: `EN${stamp}`,
          name: `Fixture Encashable ${stamp}`,
          annualEntitlementDays: 15,
          encashable: true,
          maxEncashDays: 10,
        },
      });
      await accrueEntitlement({ employmentRelationshipId: employment.id, leaveTypeId: leaveType.id, days: 15 });

      const { encashment } = await encashLeave(employment.id, { leaveTypeId: leaveType.id, days: 5 });
      expect(Number(encashment.days)).toBe(5);
      expect(Number(encashment.amount)).toBe(5000);

      const balance = await prisma.leaveBalance.findFirstOrThrow({
        where: { tenantId: TENANT, employmentRelationshipId: employment.id, leaveTypeId: leaveType.id },
      });
      expect(Number(balance.balanceDays)).toBe(10);
    });
  });

  it('refuses encashment above maxEncashDays', async () => {
    const { employment } = await makeEmployee('encash-over');
    await asUser('operations@kaizen.co.in', async () => {
      const stamp = Date.now();
      const leaveType = await prisma.leaveType.create({
        data: { tenantId: TENANT, code: `EO${stamp}`, name: `Fixture Over ${stamp}`, encashable: true, maxEncashDays: 3 },
      });
      await accrueEntitlement({ employmentRelationshipId: employment.id, leaveTypeId: leaveType.id, days: 10 });
      await expect(encashLeave(employment.id, { leaveTypeId: leaveType.id, days: 5 })).rejects.toThrow();
    });
  });
});

// ===========================================================================
// CMP-LAB-002 — weekly hours breach and overtime accrual
// ===========================================================================

describe('CMP-LAB-002 — weekly hours exceeding the cap raise an exception rather than posting silently', () => {
  it('raises CMP_LAB_HOURS_BREACH once for the week and posts an OvertimeAccrual row', async () => {
    const { employment } = await makeEmployee('hours', 20_800); // basic/(26*8) = 100/hr

    await asUser('operations@kaizen.co.in', async () => {
      await createWorkingHoursRule({
        effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
        dailyCapHours: 8,
        weeklyCapHours: 48,
        spreadOverHours: 12,
        otMultiplier: 2,
        otCapPerQuarterHours: 50,
      });

      // Last week's Monday, so the job (anchored on "now - 7 days") lands inside it.
      const anchor = new Date(Date.now() - 7 * 86_400_000);
      const week = isoWeekLabel(anchor);
      const { start } = isoWeekRange(week);

      // Six days at 10 worked hours + 1 overtime hour each = 66 hours, well past 48.
      for (let i = 0; i < 6; i += 1) {
        const day = new Date(start.getTime() + i * 86_400_000);
        await prisma.workAttendance.create({
          data: {
            tenantId: TENANT,
            employmentRelationshipId: employment.id,
            workDate: day,
            workedMinutes: 10 * 60,
            overtimeMinutes: 60,
          },
        });
      }

      const result = await runWeeklyHoursCheck();
      expect(result.notified).toBeGreaterThan(0);

      const exception = await prisma.exceptionRecord.findFirst({
        where: { tenantId: TENANT, code: 'CMP_LAB_HOURS_BREACH', subjectId: employment.id },
      });
      expect(exception).toBeTruthy();
      expect(exception?.severity).toBe('S2_WARNING');
      expect(exception?.ownerPartyId).toBeTruthy();

      const accrual = await prisma.overtimeAccrual.findFirst({
        where: { tenantId: TENANT, employmentRelationshipId: employment.id, isoWeek: week },
      });
      expect(accrual).toBeTruthy();
      expect(Number(accrual?.hours)).toBe(6); // six OT hours logged
      expect(Number(accrual?.amount)).toBe(6 * 100 * 2); // hours x hourly rate x 2x multiplier
    });
  });
});

// ===========================================================================
// CMP-LAB-001 — POSH inquiry overdue
// ===========================================================================

describe('CMP-LAB-001 — a POSH complaint past its 90-day inquiry deadline raises an exception', () => {
  it('fires CMP_POSH_INQUIRY_OVERDUE when unclosed past the deadline, and not for a closed one', async () => {
    await asUser('operations@kaizen.co.in', async () => {
      const overdue = await createPoshComplaint({
        complainantText: 'Fixture complainant',
        respondentText: 'Fixture respondent',
        receivedOn: new Date(Date.now() - 100 * 86_400_000),
      });

      const closed = await createPoshComplaint({
        complainantText: 'Fixture complainant 2',
        respondentText: 'Fixture respondent 2',
        receivedOn: new Date(Date.now() - 100 * 86_400_000),
      });
      await prisma.poshComplaint.update({ where: { id: closed.id }, data: { status: 'closed' } });

      await runPoshOverdueCheck();

      const overdueException = await prisma.exceptionRecord.findFirst({
        where: { tenantId: TENANT, code: 'CMP_POSH_INQUIRY_OVERDUE', subjectId: overdue.id },
      });
      expect(overdueException).toBeTruthy();
      expect(overdueException?.severity).toBe('S3_HIGH_RISK');

      const closedException = await prisma.exceptionRecord.findFirst({
        where: { tenantId: TENANT, code: 'CMP_POSH_INQUIRY_OVERDUE', subjectId: closed.id },
      });
      expect(closedException).toBeNull();
    });
  });

  it('concealed complaints are listed only to a holder of posh_cases:view', async () => {
    await asUser('finance@kaizen.co.in', async () => {
      await expect(
        (await import('../../domains/compliance/labour.js')).listPoshComplaints(),
      ).rejects.toThrow();
    });
  });
});

// ===========================================================================
// POSH — Internal Committee composition
// ===========================================================================

describe('POSH Internal Committee validation', () => {
  it('reports what is missing as true statements, then reports compliant once fixed', async () => {
    await asUser('operations@kaizen.co.in', async () => {
      // Wipe any prior fixture members from other runs, for a clean roster.
      await prisma.internalCommitteeMember.deleteMany({ where: { tenantId: TENANT } });

      const incomplete = await validateCommittee();
      expect(incomplete.compliant).toBe(false);
      expect(incomplete.missing.length).toBeGreaterThan(0);

      await appointIccMember({ role: 'presiding', isWoman: true, externalName: 'Fixture Presiding Officer', appointedOn: new Date() });
      await appointIccMember({ role: 'member', isWoman: true, externalName: 'Fixture Member A', appointedOn: new Date() });
      await appointIccMember({ role: 'member', isWoman: false, externalName: 'Fixture Member B', appointedOn: new Date() });
      await appointIccMember({ role: 'external', isWoman: true, externalName: 'Fixture External NGO Rep', appointedOn: new Date() });

      const complete = await validateCommittee();
      expect(complete.presidingIsWoman).toBe(true);
      expect(complete.womenHalfOrMore).toBe(true);
      expect(complete.hasExternalMember).toBe(true);
      expect(complete.compliant).toBe(true);
      expect(complete.missing).toHaveLength(0);
    });
  });
});

// ===========================================================================
// Disciplinary process, linked to case-scoped performance evidence
// ===========================================================================

describe('Disciplinary process', () => {
  it('walks show-cause through decision, recording case-scoped evidence at each step', async () => {
    const { employment } = await makeEmployee('disciplinary');

    const kase = await asUser('operations@kaizen.co.in', () =>
      openDisciplinaryCase({ employmentRelationshipId: employment.id, note: 'Show-cause issued for fixture matter.' }),
    );
    expect(kase.status).toBe('show_cause');
    expect(kase.replyDueAt.getTime()).toBeGreaterThan(kase.showCauseIssuedAt.getTime());

    await asUser('operations@kaizen.co.in', async () => {
      await advanceDisciplinaryCase(kase.id, { event: 'reply', note: 'Employee replied.' });
      await advanceDisciplinaryCase(kase.id, { event: 'inquiry', note: 'Inquiry opened.', inquiryOfficer: 'Fixture Officer' });
      const { case: decided } = await advanceDisciplinaryCase(kase.id, {
        event: 'decision',
        note: 'Decision: warning.',
        decision: 'Formal warning issued.',
        outcome: 'warning',
      });
      expect(decided.outcome).toBe('warning');

      const evidence = await prisma.performanceEvidence.findMany({
        where: { tenantId: TENANT, employmentRelationshipId: employment.id, caseRef: kase.id },
      });
      expect(evidence.length).toBeGreaterThanOrEqual(3);
      expect(evidence.every((e) => e.caseScoped)).toBe(true);
    });
  });
});

// ===========================================================================
// CMP-LAB-003 — an accepted offer generates an appointment letter
// ===========================================================================

describe('CMP-LAB-003 — an accepted offer issues an appointment letter as a final document', () => {
  it('issues an HrLetter of kind appointment when the application reaches OfferAccepted', async () => {
    await asUser('operations@kaizen.co.in', async () => {
      const position = await prisma.position.findFirstOrThrow({ where: { tenantId: TENANT, status: 'Open' } });
      const requisition = await createRequisition({ positionId: position.id });
      await transitionRequisition(requisition.id, 'SUBMIT');
      await transitionRequisition(requisition.id, 'APPROVE');
      await transitionRequisition(requisition.id, 'PUBLISH');

      const candidate = await prisma.person.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('PER'),
          fullName: `Fixture Candidate ${Date.now()}`,
          primaryEmail: `fixture.candidate.${Date.now()}@example.com`,
          source: 'test',
        },
      });
      const application = await createApplication({ requisitionId: requisition.id, candidatePartyId: candidate.id });
      await transitionApplication(application.id, 'ADVANCE');
      await transitionApplication(application.id, 'ADVANCE');
      await transitionApplication(application.id, 'ADVANCE');
      await transitionApplication(application.id, 'EXTEND_OFFER');
      await transitionApplication(application.id, 'ACCEPT_OFFER');

      const letters = await listLetters({ applicationId: application.id });
      expect(letters).toHaveLength(1);
      expect(letters[0].kind).toBe('appointment');
      expect(letters[0].number).toBeTruthy();
    });
  });
});

// ===========================================================================
// Letter immutability
// ===========================================================================

describe('Letters are final once issued', () => {
  it('a correction is a new letter, never an edit of the old one', async () => {
    const { employment } = await makeEmployee('letters');
    await asUser('operations@kaizen.co.in', async () => {
      const { issueLetter } = await import('../../domains/compliance/labour.js');
      const first = await issueLetter({
        kind: 'confirmation',
        employmentRelationshipId: employment.id,
        employeeName: 'Fixture Employee',
        legalEntity: 'Kaizen Infinities Pvt Ltd',
      });
      const second = await issueLetter({
        kind: 'confirmation',
        employmentRelationshipId: employment.id,
        employeeName: 'Fixture Employee',
        legalEntity: 'Kaizen Infinities Pvt Ltd',
      });

      expect(first.id).not.toBe(second.id);
      expect(first.number).not.toBe(second.number);

      const stillThere = await prisma.hrLetter.findUniqueOrThrow({ where: { id: first.id } });
      expect(stillThere.kind).toBe('confirmation');
      expect((stillThere.snapshot as { number: string }).number).toBe(first.number);
    });
  });
});

// ===========================================================================
// Statutory registers — CSV shape
// ===========================================================================

describe('Statutory registers export as CSV under the register\'s statutory name', () => {
  it('the employees register has a header row and one row per employment', async () => {
    await makeEmployee('register');
    const { filename, csv } = await asUser('finance@kaizen.co.in', () => registerEmployees());
    expect(filename).toContain('Register of Employees');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe("Name,Father's Name,Date of Birth,Date of Joining,Designation,Engagement Type");
    expect(lines.length).toBeGreaterThan(1);
  });

  it('the muster roll lists attendance for the period', async () => {
    const { employment } = await makeEmployee('muster');
    const period = new Date().toISOString().slice(0, 7);
    await asUser('operations@kaizen.co.in', () =>
      prisma.workAttendance.create({
        data: { tenantId: TENANT, employmentRelationshipId: employment.id, workDate: new Date(), workedMinutes: 480 },
      }),
    );
    const { filename, csv } = await asUser('finance@kaizen.co.in', () => registerMusterRoll(period));
    expect(filename).toContain('Muster Roll');
    expect(csv.split('\r\n')[0]).toBe('Employee,Date,Worked Minutes,Overtime Minutes,Status');
  });
});

// ===========================================================================
// Consents
// ===========================================================================

describe('BGV consent and code-of-conduct acknowledgement', () => {
  it('are audited timestamps, settable by HR for any employee', async () => {
    const { employment } = await makeEmployee('consent');
    const result = await asUser('operations@kaizen.co.in', () => recordBgvConsent(employment.id));
    expect(result.backgroundVerificationConsentAt).toBeInstanceOf(Date);
    const ack = await asUser('operations@kaizen.co.in', () => recordCodeOfConductAck(employment.id));
    expect(ack.codeOfConductAcknowledgedAt).toBeInstanceOf(Date);
  });

  it('an employee can only set their own', async () => {
    const rogue = await unscopedPrisma.employmentRelationship.findFirstOrThrow({
      where: { tenantId: TENANT, personId: { not: (await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'ravi@kaizen.co.in' } })).personId } },
    });
    await expect(asUser('ravi@kaizen.co.in', () => recordBgvConsent(rogue.id))).rejects.toThrow();

    const own = await unscopedPrisma.employmentRelationship.findFirstOrThrow({
      where: { tenantId: TENANT, personId: (await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'ravi@kaizen.co.in' } })).personId },
    });
    const result = await asUser('ravi@kaizen.co.in', () => recordBgvConsent(own.id));
    expect(result.backgroundVerificationConsentAt).toBeInstanceOf(Date);
  });
});
