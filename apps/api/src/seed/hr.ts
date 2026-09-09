/**
 * The People dataset.
 *
 * Built on the company's real shape — three divisions (Software, Skill
 * Development, Education) over a shared corporate function, which is how the
 * founder's own books already cut every figure.
 *
 * As with the rest of the seed, some of this is deliberately wrong: a
 * probation nobody closed, an employee with no pay record in force, a disputed
 * attendance day inside an open payroll period, and a capability claim sitting
 * in contradiction. Every detector and every surface therefore has something
 * real to show on first run, instead of an empty state that proves nothing.
 */

import { CONFIDENCE_RANK, ORIGINATION_FOR_TIER } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { nextRecordCode } from '../platform/recordCode.js';

/** Mirrors the shape `seedPeopleAndUsers` returns. */
interface SeededPerson {
  id: string;
  fullName: string;
  email: string;
  roleSlug: string;
  branch: string;
}

function monthsAgo(n: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

/** The pay period before the current one — the one a run would be opened for. */
function lastCompletePeriod(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
}

export async function seedHr(people: SeededPerson[]) {
  const tenantId = currentAuth().tenantId;
  const byEmail = new Map(people.map((p) => [p.email, p]));

  // -------------------------------------------------------------------------
  // Org structure. `division` is what lets payroll cost land in the same cut
  // as revenue does.
  // -------------------------------------------------------------------------
  const unitSpecs = [
    { key: 'company', name: 'Kaizen Infinities', unitType: 'company', division: 'shared', parent: null },
    { key: 'software', name: 'Software Services', unitType: 'division', division: 'software', parent: 'company' },
    { key: 'skill', name: 'Skill Development', unitType: 'division', division: 'skill', parent: 'company' },
    { key: 'education', name: 'Education', unitType: 'division', division: 'education', parent: 'company' },
    { key: 'corporate', name: 'Shared / Corporate', unitType: 'division', division: 'shared', parent: 'company' },
    { key: 'commercial', name: 'Commercial', unitType: 'department', division: 'shared', parent: 'corporate' },
    { key: 'finance', name: 'Finance & Accounts', unitType: 'department', division: 'shared', parent: 'corporate' },
    { key: 'delivery', name: 'Delivery', unitType: 'department', division: 'software', parent: 'software' },
  ];

  const units = new Map<string, string>();
  for (const spec of unitSpecs) {
    const existing = await prisma.orgUnit.findFirst({ where: { tenantId, name: spec.name } });
    const unit =
      existing ??
      (await prisma.orgUnit.create({
        data: {
          tenantId,
          name: spec.name,
          unitType: spec.unitType,
          division: spec.division,
          parentId: spec.parent ? (units.get(spec.parent) ?? null) : null,
        },
      }));
    units.set(spec.key, unit.id);
  }

  // -------------------------------------------------------------------------
  // Jobs and seats
  // -------------------------------------------------------------------------
  const jobSpecs = [
    { key: 'sr_dev', title: 'Senior Developer', jobFamily: 'Engineering', jobLevel: 'L4' },
    { key: 'dev', title: 'Software Developer', jobFamily: 'Engineering', jobLevel: 'L3' },
    { key: 'sr_instructor', title: 'Senior Instructor', jobFamily: 'Delivery', jobLevel: 'L4' },
    { key: 'instructor', title: 'Instructor', jobFamily: 'Delivery', jobLevel: 'L3' },
    { key: 'counsellor', title: 'Education Counsellor', jobFamily: 'Commercial', jobLevel: 'L3' },
    { key: 'sales', title: 'Sales Executive', jobFamily: 'Commercial', jobLevel: 'L3' },
    { key: 'accounts', title: 'Accounts Executive', jobFamily: 'Finance', jobLevel: 'L3' },
    { key: 'hr', title: 'HR Operations Executive', jobFamily: 'Corporate', jobLevel: 'L3' },
    { key: 'lead', title: 'Business Head', jobFamily: 'Leadership', jobLevel: 'L6' },
  ];

  const jobs = new Map<string, string>();
  for (const { key, ...spec } of jobSpecs) {
    const existing = await prisma.job.findFirst({ where: { tenantId, title: spec.title } });
    const job = existing ?? (await prisma.job.create({ data: { tenantId, ...spec } }));
    jobs.set(key, job.id);
  }

  /** One seat per person we are about to put in it. */
  const seatSpecs: Array<{ email: string; job: string; unit: string; lead?: boolean }> = [
    { email: 'chairman@kaizen.co.in', job: 'lead', unit: 'company', lead: true },
    { email: 'bhead@kaizen.co.in', job: 'lead', unit: 'commercial', lead: true },
    { email: 'director@kaizen.co.in', job: 'lead', unit: 'company', lead: true },
    { email: 'controller@kaizen.co.in', job: 'accounts', unit: 'finance', lead: true },
    { email: 'arun@kaizen.co.in', job: 'sales', unit: 'commercial' },
    { email: 'sanjay@kaizen.co.in', job: 'sales', unit: 'commercial' },
    { email: 'divya@kaizen.co.in', job: 'sales', unit: 'commercial' },
    { email: 'meera@kaizen.co.in', job: 'counsellor', unit: 'education' },
    { email: 'ravi@kaizen.co.in', job: 'sr_instructor', unit: 'skill' },
    { email: 'kavitha@kaizen.co.in', job: 'sr_dev', unit: 'delivery' },
    { email: 'suresh@kaizen.co.in', job: 'instructor', unit: 'skill' },
    { email: 'priya@kaizen.co.in', job: 'dev', unit: 'delivery' },
    { email: 'latha@kaizen.co.in', job: 'accounts', unit: 'finance' },
    { email: 'hr@kaizen.co.in', job: 'hr', unit: 'corporate' },
  ];

  // A seat holds one person. Reusing a row because its job and unit match
  // would put two people in one chair — so the existing seat is found through
  // the occupant's own assignment, not through the seat's shape.
  const seats = new Map<string, { id: string; orgUnitId: string }>();
  for (const spec of seatSpecs) {
    const person = byEmail.get(spec.email);
    if (!person) continue;

    const held = await prisma.assignment.findFirst({
      where: { tenantId, rowStatus: 'Effective', employmentRelationship: { personId: person.id } },
      include: { position: true },
    });

    const position =
      held?.position ??
      (await prisma.position.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('POS'),
          jobId: jobs.get(spec.job)!,
          orgUnitId: units.get(spec.unit)!,
          location: 'Chennai',
          isLeadPosition: spec.lead ?? false,
          status: 'Filled',
        },
      }));
    seats.set(spec.email, { id: position.id, orgUnitId: position.orgUnitId });
  }

  // -------------------------------------------------------------------------
  // Employment relationships.
  //
  // Created directly rather than through `hire()`: these people already hold a
  // seeded employee affiliation carrying their role, and hiring them again
  // would add a second one with no role — which the session resolver would
  // then have to disambiguate. `hire()` is exercised by the hiring funnel
  // below, where the candidate genuinely has no employment yet.
  // -------------------------------------------------------------------------
  const employmentSpecs: Array<{
    email: string;
    monthsService: number;
    monthlyPay: number;
    confirmation: string;
    /** Left without a pay record on purpose, for the detector to find. */
    skipCompensation?: boolean;
  }> = [
    { email: 'chairman@kaizen.co.in', monthsService: 84, monthlyPay: 250_000, confirmation: 'confirmed' },
    { email: 'bhead@kaizen.co.in', monthsService: 46, monthlyPay: 145_000, confirmation: 'confirmed' },
    { email: 'director@kaizen.co.in', monthsService: 60, monthlyPay: 180_000, confirmation: 'confirmed' },
    { email: 'controller@kaizen.co.in', monthsService: 38, monthlyPay: 110_000, confirmation: 'confirmed' },
    { email: 'arun@kaizen.co.in', monthsService: 29, monthlyPay: 62_000, confirmation: 'confirmed' },
    { email: 'sanjay@kaizen.co.in', monthsService: 14, monthlyPay: 54_000, confirmation: 'confirmed' },
    { email: 'divya@kaizen.co.in', monthsService: 9, monthlyPay: 28_000, confirmation: 'confirmed' },
    { email: 'meera@kaizen.co.in', monthsService: 21, monthlyPay: 46_000, confirmation: 'confirmed' },
    { email: 'ravi@kaizen.co.in', monthsService: 33, monthlyPay: 68_000, confirmation: 'confirmed' },
    { email: 'kavitha@kaizen.co.in', monthsService: 26, monthlyPay: 96_000, confirmation: 'confirmed' },
    { email: 'suresh@kaizen.co.in', monthsService: 11, monthlyPay: 42_000, confirmation: 'confirmed' },
    // Hired ten months ago and never confirmed — EX-HR-002 finds this one.
    { email: 'priya@kaizen.co.in', monthsService: 10, monthlyPay: 58_000, confirmation: 'in_probation' },
    { email: 'latha@kaizen.co.in', monthsService: 19, monthlyPay: 44_000, confirmation: 'confirmed' },
    // On the books with nothing in force — EX-HR-003 finds this one.
    { email: 'hr@kaizen.co.in', monthsService: 4, monthlyPay: 0, confirmation: 'in_probation', skipCompensation: true },
  ];

  const employments = new Map<string, { id: string; personId: string }>();

  for (const spec of employmentSpecs) {
    const person = byEmail.get(spec.email);
    const seat = seats.get(spec.email);
    if (!person || !seat) continue;

    const existing = await prisma.employmentRelationship.findFirst({
      where: { tenantId, personId: person.id },
    });
    if (existing) {
      employments.set(spec.email, { id: existing.id, personId: person.id });
      continue;
    }

    const hireDate = monthsAgo(spec.monthsService);
    const employment = await prisma.employmentRelationship.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('EMP'),
        personId: person.id,
        hireEffectiveDate: hireDate,
        status: 'Active',
        confirmationState: spec.confirmation,
      },
    });
    employments.set(spec.email, { id: employment.id, personId: person.id });

    await prisma.assignment.create({
      data: {
        tenantId,
        employmentRelationshipId: employment.id,
        positionId: seat.id,
        reasonCode: 'Hire',
        requestStatus: 'Effective',
        rowStatus: 'Effective',
        effectiveFrom: hireDate,
      },
    });

    await prisma.onboarding.create({
      data: { tenantId, employmentRelationshipId: employment.id, status: 'Completed' },
    });

    if (!spec.skipCompensation) {
      await prisma.compensationRecord.create({
        data: {
          tenantId,
          employmentRelationshipId: employment.id,
          revisionReason: 'hire',
          amount: spec.monthlyPay,
          basicPay: Math.round(spec.monthlyPay * 0.5),
          status: 'Effective',
          effectiveFrom: hireDate,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Leave. Types first, then a year's entitlement as an accrual so the ledger
  // reads correctly from its first row, then requests in several states.
  // -------------------------------------------------------------------------
  const leaveTypeSpecs = [
    { code: 'CL', name: 'Casual Leave', annualEntitlementDays: 12, statutory: false, employmentStateAffecting: false },
    { code: 'SL', name: 'Sick Leave', annualEntitlementDays: 12, statutory: true, employmentStateAffecting: false },
    { code: 'EL', name: 'Earned Leave', annualEntitlementDays: 15, statutory: true, employmentStateAffecting: false },
    // Long leave takes somebody off the roll while it runs, so the employment
    // relationship moves with it.
    { code: 'ML', name: 'Maternity Leave', annualEntitlementDays: 182, statutory: true, employmentStateAffecting: true },
    { code: 'LOP', name: 'Loss of Pay', annualEntitlementDays: 0, statutory: false, employmentStateAffecting: false },
  ];

  const leaveTypes = new Map<string, string>();
  for (const spec of leaveTypeSpecs) {
    const existing = await prisma.leaveType.findFirst({ where: { tenantId, code: spec.code } });
    const type = existing ?? (await prisma.leaveType.create({ data: { tenantId, ...spec } }));
    leaveTypes.set(spec.code, type.id);
  }

  for (const [, employment] of employments) {
    for (const spec of leaveTypeSpecs) {
      if (spec.annualEntitlementDays === 0) continue;
      const balance = await prisma.leaveBalance.upsert({
        where: {
          employmentRelationshipId_leaveTypeId: {
            employmentRelationshipId: employment.id,
            leaveTypeId: leaveTypes.get(spec.code)!,
          },
        },
        create: {
          tenantId,
          employmentRelationshipId: employment.id,
          leaveTypeId: leaveTypes.get(spec.code)!,
        },
        update: {},
      });

      const already = await prisma.leaveTransaction.findFirst({ where: { leaveBalanceId: balance.id } });
      if (already) continue;

      // Maternity leave is not accrued as a running balance; it is granted
      // when it is taken. Everything else opens the year at its entitlement.
      const days = spec.code === 'ML' ? 0 : spec.annualEntitlementDays;
      if (days === 0) continue;

      await prisma.leaveTransaction.create({
        data: {
          tenantId,
          leaveBalanceId: balance.id,
          txnType: 'accrual',
          amountDays: days,
          note: 'Annual entitlement',
        },
      });
      await prisma.leaveBalance.update({ where: { id: balance.id }, data: { balanceDays: days } });
    }
  }

  const leaveRequestSpecs: Array<{
    email: string; code: string; from: number; to: number; days: number; status: string; reason: string;
  }> = [
    { email: 'arun@kaizen.co.in', code: 'CL', from: -21, to: -19, days: 3, status: 'Completed', reason: 'Family function' },
    { email: 'divya@kaizen.co.in', code: 'SL', from: -9, to: -8, days: 2, status: 'Completed', reason: 'Fever' },
    { email: 'ravi@kaizen.co.in', code: 'EL', from: 6, to: 10, days: 5, status: 'PendingApproval', reason: 'Vacation' },
    { email: 'priya@kaizen.co.in', code: 'CL', from: 3, to: 3, days: 1, status: 'PendingApproval', reason: 'Personal' },
    { email: 'meera@kaizen.co.in', code: 'EL', from: 14, to: 18, days: 5, status: 'Approved', reason: 'Travel' },
    { email: 'suresh@kaizen.co.in', code: 'CL', from: -3, to: -3, days: 1, status: 'Rejected', reason: 'Short notice' },
  ];

  for (const spec of leaveRequestSpecs) {
    const employment = employments.get(spec.email);
    if (!employment) continue;

    const existing = await prisma.leaveRequest.findFirst({
      where: { tenantId, employmentRelationshipId: employment.id, startDate: daysAgo(-spec.from) },
    });
    if (existing) continue;

    const request = await prisma.leaveRequest.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('LVR'),
        employmentRelationshipId: employment.id,
        leaveTypeId: leaveTypes.get(spec.code)!,
        startDate: daysAgo(-spec.from),
        endDate: daysAgo(-spec.to),
        days: spec.days,
        reason: spec.reason,
        status: spec.status,
      },
    });

    // A request that reached Approved or beyond has moved the balance, so the
    // ledger has to show it — a status without its posting is exactly the
    // inconsistency the ledger exists to prevent.
    if (['Approved', 'InProgress', 'Completed'].includes(spec.status)) {
      const balance = await prisma.leaveBalance.findFirst({
        where: { employmentRelationshipId: employment.id, leaveTypeId: leaveTypes.get(spec.code)! },
      });
      if (balance) {
        await prisma.leaveTransaction.create({
          data: {
            tenantId,
            leaveBalanceId: balance.id,
            leaveRequestId: request.id,
            txnType: 'hold',
            amountDays: -spec.days,
            note: `Approved ${request.recordCode}`,
          },
        });
        if (spec.status === 'Completed') {
          await prisma.leaveTransaction.create({
            data: {
              tenantId,
              leaveBalanceId: balance.id,
              leaveRequestId: request.id,
              txnType: 'deduction',
              amountDays: 0,
              note: `Taken — ${request.recordCode}`,
            },
          });
        }
        const ledger = await prisma.leaveTransaction.aggregate({
          where: { leaveBalanceId: balance.id },
          _sum: { amountDays: true },
        });
        await prisma.leaveBalance.update({
          where: { id: balance.id },
          data: {
            balanceDays: Number(ledger._sum.amountDays ?? 0),
            heldDays: spec.status === 'Approved' ? spec.days : 0,
          },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Attendance for the last complete period, with one day left disputed so
  // that locking the period has something to refuse.
  // -------------------------------------------------------------------------
  const period = lastCompletePeriod();
  const [py, pm] = period.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(py, pm, 0)).getUTCDate();

  for (const [email, employment] of employments) {
    for (let day = 1; day <= daysInMonth; day += 1) {
      const workDate = new Date(Date.UTC(py, pm - 1, day));
      // Sundays off.
      if (workDate.getUTCDay() === 0) continue;

      const disputed = email === 'suresh@kaizen.co.in' && day === 12;
      await prisma.workAttendance.upsert({
        where: { employmentRelationshipId_workDate: { employmentRelationshipId: employment.id, workDate } },
        create: {
          tenantId,
          employmentRelationshipId: employment.id,
          workDate,
          workedMinutes: disputed ? 0 : 480,
          overtimeMinutes: day % 9 === 0 ? 60 : 0,
          status: disputed ? 'Disputed' : 'Recorded',
          missingPunch: disputed,
          note: disputed ? 'Punch missing; employee says they were on site' : null,
        },
        update: {},
      });
    }
  }

  // -------------------------------------------------------------------------
  // A payroll run for that period, left Computed so the approval step is the
  // first thing a controller sees rather than a fait accompli.
  // -------------------------------------------------------------------------
  const existingRun = await prisma.payrollRun.findFirst({ where: { tenantId, payPeriod: period } });
  if (!existingRun) {
    const run = await prisma.payrollRun.create({
      data: { tenantId, recordCode: await nextRecordCode('PRN'), payPeriod: period, status: 'Computed' },
    });

    let grossTotal = 0;
    let headcount = 0;

    for (const [email, employment] of employments) {
      const seat = seats.get(email);
      const unit = seat ? unitSpecs.find((u) => units.get(u.key) === seat.orgUnitId) : null;
      const pay = await prisma.compensationRecord.findFirst({
        where: { tenantId, employmentRelationshipId: employment.id, status: 'Effective' },
        orderBy: { effectiveFrom: 'desc' },
      });
      const gross = Number(pay?.amount ?? 0);
      // Professional tax and PF, roughly. The engine is elsewhere; what is
      // modelled here is the instruction, not the computation.
      const deductions = gross > 0 ? Math.round(gross * 0.12) + 200 : 0;

      await prisma.payrollInstruction.create({
        data: {
          tenantId,
          employmentRelationshipId: employment.id,
          payrollRunId: run.id,
          payPeriod: period,
          status: 'Computed',
          grossAmount: gross,
          deductions,
          netAmount: gross - deductions,
          division: unit?.division ?? 'shared',
        },
      });

      grossTotal += gross;
      headcount += 1;
    }

    await prisma.payrollRun.update({
      where: { id: run.id },
      data: { grossTotal, netTotal: Math.round(grossTotal * 0.88), headcount },
    });
  }

  // -------------------------------------------------------------------------
  // Capability. One claim is left contradicted, so the resolution queue is not
  // empty on first run.
  // -------------------------------------------------------------------------
  const skillSpecs = [
    { name: 'React', halfLifeMonths: 18 },
    { name: 'Node.js', halfLifeMonths: 18 },
    { name: 'PostgreSQL', halfLifeMonths: 30 },
    { name: 'Classroom Facilitation', halfLifeMonths: 36 },
    { name: 'GST Compliance', halfLifeMonths: 12 },
    { name: 'Spoken English Training', halfLifeMonths: 36 },
  ];

  const skills = new Map<string, string>();
  for (const spec of skillSpecs) {
    const existing = await prisma.skill.findFirst({ where: { tenantId, name: spec.name } });
    const skill =
      existing ??
      (await prisma.skill.create({
        data: { tenantId, name: spec.name, halfLifeMonths: spec.halfLifeMonths, proficiencyScale: [1, 2, 3, 4, 5] },
      }));
    skills.set(spec.name, skill.id);
  }

  const claimSpecs: Array<{ email: string; skill: string; tier: keyof typeof CONFIDENCE_RANK; state?: string; monthsSinceEvidence: number }> = [
    { email: 'kavitha@kaizen.co.in', skill: 'React', tier: 'verified', monthsSinceEvidence: 2 },
    { email: 'kavitha@kaizen.co.in', skill: 'PostgreSQL', tier: 'demonstrated', monthsSinceEvidence: 5 },
    { email: 'priya@kaizen.co.in', skill: 'React', tier: 'assessed', monthsSinceEvidence: 8 },
    { email: 'priya@kaizen.co.in', skill: 'Node.js', tier: 'claimed', monthsSinceEvidence: 14 },
    { email: 'ravi@kaizen.co.in', skill: 'Classroom Facilitation', tier: 'verified', monthsSinceEvidence: 1 },
    { email: 'suresh@kaizen.co.in', skill: 'Spoken English Training', tier: 'assessed', monthsSinceEvidence: 3, state: 'contradicted' },
    { email: 'latha@kaizen.co.in', skill: 'GST Compliance', tier: 'demonstrated', monthsSinceEvidence: 4 },
    // Inferred from a document, never confirmed by anybody — the weakest tier,
    // and the one a surface should be most careful about presenting.
    { email: 'sanjay@kaizen.co.in', skill: 'Node.js', tier: 'inferred', monthsSinceEvidence: 20 },
  ];

  for (const spec of claimSpecs) {
    const person = byEmail.get(spec.email);
    if (!person) continue;

    const existing = await prisma.capabilityClaim.findFirst({
      where: { tenantId, partyId: person.id, skillId: skills.get(spec.skill)! },
    });
    if (existing) continue;

    const claim = await prisma.capabilityClaim.create({
      data: {
        tenantId,
        partyId: person.id,
        skillId: skills.get(spec.skill)!,
        tier: spec.tier,
        confidenceRank: CONFIDENCE_RANK[spec.tier],
        confidenceScore: 0.5 + CONFIDENCE_RANK[spec.tier] * 0.08,
        source: ORIGINATION_FOR_TIER[spec.tier],
        state: spec.state ?? 'active',
        lastEvidencedAt: monthsAgo(spec.monthsSinceEvidence),
      },
    });

    if (spec.tier === 'verified') {
      const verifier = byEmail.get('bhead@kaizen.co.in');
      const second = byEmail.get('hr@kaizen.co.in');
      await prisma.verificationEvent.create({
        data: {
          tenantId,
          capabilityClaimId: claim.id,
          verifierPartyId: verifier?.id ?? person.id,
          // The two-person rule, satisfied.
          secondVerifierPartyId: second?.id ?? null,
          note: 'Verified against delivered work and a second reviewer.',
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Goals, learning, and a hiring funnel with something at every stage.
  // -------------------------------------------------------------------------
  const goalSpecs = [
    { email: 'arun@kaizen.co.in', description: 'Close ₹40L of new institutional business this quarter', status: 'InProgress' },
    { email: 'meera@kaizen.co.in', description: 'Convert 60 admissions across the Madurai belt', status: 'AtRisk' },
    { email: 'kavitha@kaizen.co.in', description: 'Ship the placement portal to production', status: 'InProgress' },
    { email: 'ravi@kaizen.co.in', description: 'Lift batch completion above 85%', status: 'Achieved' },
    { email: 'priya@kaizen.co.in', description: 'Take the internal component library to v1', status: 'Draft' },
  ];

  for (const spec of goalSpecs) {
    const employment = employments.get(spec.email);
    if (!employment) continue;
    const existing = await prisma.goal.findFirst({
      where: { tenantId, employmentRelationshipId: employment.id, description: spec.description },
    });
    if (existing) continue;
    await prisma.goal.create({
      data: {
        tenantId,
        employmentRelationshipId: employment.id,
        description: spec.description,
        status: spec.status,
        periodLabel: 'FY26 Q2',
      },
    });
  }

  const activitySpecs = [
    { title: 'POSH Awareness (annual)', isCompliance: true, cost: 0 },
    { title: 'Fire and Workplace Safety', isCompliance: true, cost: 0 },
    { title: 'Advanced React Patterns', isCompliance: false, cost: 12_000 },
  ];

  const activities = new Map<string, string>();
  for (const spec of activitySpecs) {
    const existing = await prisma.learningActivity.findFirst({ where: { tenantId, title: spec.title } });
    const activity = existing ?? (await prisma.learningActivity.create({ data: { tenantId, ...spec } }));
    activities.set(spec.title, activity.id);
  }

  // Compliance training enrolled for everyone, completed by most — the
  // stragglers are what the compliance report is for.
  let index = 0;
  for (const [, employment] of employments) {
    for (const title of ['POSH Awareness (annual)', 'Fire and Workplace Safety']) {
      const existing = await prisma.learningRecord.findFirst({
        where: { tenantId, employmentRelationshipId: employment.id, learningActivityId: activities.get(title)! },
      });
      if (existing) continue;
      const done = index % 5 !== 0;
      await prisma.learningRecord.create({
        data: {
          tenantId,
          employmentRelationshipId: employment.id,
          learningActivityId: activities.get(title)!,
          status: done ? 'Completed' : 'Enrolled',
          completedAt: done ? daysAgo(40) : null,
        },
      });
    }
    index += 1;
  }

  const openSeat = await prisma.position.findFirst({ where: { tenantId, status: 'Open' } });
  const hiringSeat =
    openSeat ??
    (await prisma.position.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('POS'),
        jobId: jobs.get('dev')!,
        orgUnitId: units.get('delivery')!,
        location: 'Chennai',
        status: 'Open',
      },
    }));

  const existingReq = await prisma.requisition.findFirst({ where: { tenantId, positionId: hiringSeat.id } });
  if (!existingReq) {
    const requisition = await prisma.requisition.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('REQ'),
        positionId: hiringSeat.id,
        raisedByPartyId: byEmail.get('bhead@kaizen.co.in')?.id ?? null,
        targetStartDate: daysAgo(-45),
        status: 'Open',
      },
    });

    // Candidates are Person rows like anybody else — the same row they keep if
    // they are hired.
    const candidateSpecs = [
      { name: 'Deepak Rangan', email: 'deepak.rangan@example.com', status: 'OfferAccepted' },
      { name: 'Sneha Varghese', email: 'sneha.varghese@example.com', status: 'Interviewing' },
      { name: 'Imran Sheikh', email: 'imran.sheikh@example.com', status: 'Screening' },
      { name: 'Anitha Devi', email: 'anitha.devi@example.com', status: 'Rejected' },
    ];

    for (const spec of candidateSpecs) {
      let candidate = await prisma.person.findFirst({ where: { tenantId, primaryEmail: spec.email } });
      candidate ??= await prisma.person.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('PER'),
          fullName: spec.name,
          primaryEmail: spec.email,
          primaryEmailNormalised: spec.email.toLowerCase(),
          source: 'seed',
        },
      });

      await prisma.affiliation.create({
        data: {
          tenantId,
          partyId: candidate.id,
          affiliationType: 'candidate',
          counterpartyName: 'Kaizen Infinities',
          status: 'active',
        },
      });

      await prisma.application.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('APP'),
          requisitionId: requisition.id,
          candidatePartyId: candidate.id,
          status: spec.status,
          rejectionReason: spec.status === 'Rejected' ? 'Stronger candidates at the same level' : null,
        },
      });
    }
  }

  console.log(
    `people  ${employments.size} employments, ${seats.size} seats, ${leaveTypes.size} leave types, ` +
      `payroll ${period}`,
  );
}
