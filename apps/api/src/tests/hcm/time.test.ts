/**
 * HCM — WS2 time (docs/hcm/time.md).
 *
 * HCM-TIME-001..009: shifts + roster, clock in/out and its own-account
 * double clock-in refusal, the nightly attendance deriver, timesheets
 * submit → approve with the Self-Dealing Bar, overtime approval earning a
 * comp-off, comp-off expiry and the refusal to consume one, attendance
 * regularisation driving the existing WorkAttendance machine (including an
 * invalid-transition refusal), and scope/visibility refusals.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import {
  createShift,
  assignRoster,
  rosterFor,
  recordClockEvent,
  deriveAttendanceFromClockEvents,
  addTimesheetEntry,
  submitTimesheet,
  approveTimesheet,
  getTimesheet,
  requestOvertime,
  approveOvertimeRequest,
  listCompOffs,
  consumeCompOff,
  runCompOffExpiry,
  submitRegularisation,
  approveRegularisation,
} from '../../domains/hcm/time.js';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

/** The employment behind an already-seeded, login-capable staff account. */
async function employmentFor(email: string): Promise<{ employmentRelationshipId: string; personId: string }> {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email, tenant: { slug: 'kaizen' } } });
  const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({
    where: { tenantId: TENANT, personId: user.personId },
    orderBy: { hireEffectiveDate: 'desc' },
  });
  return { employmentRelationshipId: employment.id, personId: user.personId };
}

/**
 * A day far from anything the demo dataset seeded, salted by this run's start
 * time so a second run against the same persistent test database never lands
 * on a day an earlier run already wrote clock events or attendance for.
 */
const RUN_SALT = Math.floor(Date.now() / 1000) % 5000;
function fixtureDay(offsetDays: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 300 + RUN_SALT + offsetDays);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

describe('HCM-TIME-001 — a shift and a roster assignment', () => {
  it('HCM-TIME-001: HR defines a shift and assigns an employment to it; the roster resolves for a covered day', async () => {
    const stamp = Date.now();
    const divya = await employmentFor('divya@kaizen.co.in');

    const roster = await asUser('hr@kaizen.co.in', async () => {
      const shift = await createShift({ code: `SH-${stamp}`, name: 'General', startTime: '09:00', endTime: '18:00', graceMinutes: 10, breakMinutes: 60 });
      return assignRoster({
        employmentRelationshipId: divya.employmentRelationshipId,
        shiftId: shift.id,
        effectiveFrom: fixtureDay(0),
        weeklyOffDays: [0],
      });
    });

    const resolved = await asUser('hr@kaizen.co.in', () => rosterFor(divya.employmentRelationshipId, fixtureDay(1)));
    expect(resolved?.id).toBe(roster.id);
  });
});

describe('HCM-TIME-002 — clock in/out on one’s own account', () => {
  it('HCM-TIME-002: divya clocks in and out for herself, and a second clock-in with no clock-out first is refused', async () => {
    const divya = await employmentFor('divya@kaizen.co.in');
    const day = fixtureDay(2);

    await asUser('divya@kaizen.co.in', async (p) => {
      await recordClockEvent({ employmentRelationshipId: divya.employmentRelationshipId, kind: 'in', occurredAt: new Date(day.getTime() + 9 * 3_600_000), source: 'web' });
      expect(p.partyId).toBe(divya.personId);

      const rejected = await expectReject(() =>
        recordClockEvent({ employmentRelationshipId: divya.employmentRelationshipId, kind: 'in', occurredAt: new Date(day.getTime() + 9.5 * 3_600_000), source: 'web' }),
      );
      expect(rejected.status).toBe(422);

      await recordClockEvent({ employmentRelationshipId: divya.employmentRelationshipId, kind: 'out', occurredAt: new Date(day.getTime() + 18 * 3_600_000), source: 'web' });
    });
  });
});

describe('HCM-TIME-003 — nightly attendance derivation from clock events', () => {
  it('HCM-TIME-003: a punch pair against the roster shift folds into WorkAttendance as worked minutes', async () => {
    const stamp = Date.now();
    const divya = await employmentFor('divya@kaizen.co.in');
    const day = fixtureDay(10);

    await asUser('hr@kaizen.co.in', async () => {
      const shift = await createShift({ code: `SH2-${stamp}`, name: 'General 2', startTime: '09:00', endTime: '17:00', graceMinutes: 10, breakMinutes: 30 });
      await assignRoster({ employmentRelationshipId: divya.employmentRelationshipId, shiftId: shift.id, effectiveFrom: day, weeklyOffDays: [0] });
    });

    await asUser('divya@kaizen.co.in', async () => {
      await recordClockEvent({ employmentRelationshipId: divya.employmentRelationshipId, kind: 'in', occurredAt: new Date(day.getTime() + 9 * 3_600_000) });
      await recordClockEvent({ employmentRelationshipId: divya.employmentRelationshipId, kind: 'out', occurredAt: new Date(day.getTime() + 17 * 3_600_000) });
    });

    await asUser('hr@kaizen.co.in', () => deriveAttendanceFromClockEvents(day));

    const row = await asUser('hr@kaizen.co.in', () =>
      prisma.workAttendance.findUnique({
        where: { employmentRelationshipId_workDate: { employmentRelationshipId: divya.employmentRelationshipId, workDate: day } },
      }),
    );
    // 9:00-17:00 minus a 30-minute break is 7.5 hours.
    expect(row?.workedMinutes).toBe(450);
    expect(row?.missingPunch).toBe(false);
  });
});

describe('HCM-TIME-004 — timesheet submit → approve, and the Self-Dealing Bar', () => {
  it('HCM-TIME-004: divya submits a timesheet and HR approves it; divya may not approve her own', async () => {
    const divya = await employmentFor('divya@kaizen.co.in');
    const day = fixtureDay(20);

    const timesheet = await asUser('divya@kaizen.co.in', async () => {
      const entry = await addTimesheetEntry({ employmentRelationshipId: divya.employmentRelationshipId, date: day, hours: 8, taskRef: 'Fixture task' });
      return submitTimesheet(entry.timesheetId);
    });
    expect(timesheet.status).toBe('submitted');

    const selfApprove = await expectReject(() => asUser('divya@kaizen.co.in', () => approveTimesheet(timesheet.id)));
    expect(selfApprove.status).toBe(403);

    const approved = await asUser('hr@kaizen.co.in', () => approveTimesheet(timesheet.id, 'Looks right.'));
    expect(approved.status).toBe('approved');

    const reapprove = await expectReject(() => asUser('hr@kaizen.co.in', () => approveTimesheet(timesheet.id)));
    expect(reapprove.status).toBe(422);
  });
});

describe('HCM-TIME-005 — approving overtime earns a comp-off, which can be consumed exactly once', () => {
  it('HCM-TIME-005: an approved overtime request earns a comp-off; consuming it twice is refused the second time', async () => {
    const divya = await employmentFor('divya@kaizen.co.in');
    const day = fixtureDay(30);

    const request = await asUser('divya@kaizen.co.in', () =>
      requestOvertime({ employmentRelationshipId: divya.employmentRelationshipId, date: day, hours: 4, reason: 'Month-end close' }),
    );

    const selfApprove = await expectReject(() => asUser('divya@kaizen.co.in', () => approveOvertimeRequest(request.id)));
    expect(selfApprove.status).toBe(403);

    await asUser('hr@kaizen.co.in', () => approveOvertimeRequest(request.id, 'Approved.'));

    const compOffs = await asUser('divya@kaizen.co.in', () => listCompOffs(divya.employmentRelationshipId));
    const earned = compOffs.find((c) => c.sourceRef === request.id);
    expect(earned).toBeTruthy();
    expect(Number(earned!.days)).toBe(0.5);

    // Consuming is HR's action, not the employee's — `comp_offs` carries no
    // own-scoped edit grant, only `view` (consumption is meant to run through
    // the leave-policy engine's CO leave type once that workstream lands).
    await asUser('hr@kaizen.co.in', () => consumeCompOff(earned!.id));
    const reconsume = await expectReject(() => asUser('hr@kaizen.co.in', () => consumeCompOff(earned!.id)));
    expect(reconsume.status).toBe(422);
  });
});

describe('HCM-TIME-006 — comp-off expiry', () => {
  it('HCM-TIME-006: a comp-off past its expiry is swept to expired and can no longer be consumed', async () => {
    const divya = await employmentFor('divya@kaizen.co.in');
    const longAgo = new Date(Date.now() - 200 * 86_400_000);

    const compOff = await asUser('hr@kaizen.co.in', () =>
      prisma.compOff.create({
        data: {
          tenantId: TENANT,
          employmentRelationshipId: divya.employmentRelationshipId,
          earnedFrom: 'holiday_work',
          earnedOn: longAgo,
          days: 1,
          expiresOn: new Date(longAgo.getTime() + 90 * 86_400_000),
        },
      }),
    );
    expect(compOff.expiresOn.getTime()).toBeLessThan(Date.now());

    const result = await asUser('hr@kaizen.co.in', () => runCompOffExpiry());
    expect(result.processed).toBeGreaterThanOrEqual(1);

    const rejected = await expectReject(() => asUser('hr@kaizen.co.in', () => consumeCompOff(compOff.id)));
    expect(rejected.status).toBe(422);
  });
});

describe('HCM-TIME-007 — attendance regularisation drives the existing WorkAttendance machine', () => {
  it('HCM-TIME-007: submitting disputes the day, approving regularises it, and a second approval is refused as an invalid transition', async () => {
    const divya = await employmentFor('divya@kaizen.co.in');
    const day = fixtureDay(40);

    const request = await asUser('divya@kaizen.co.in', () =>
      submitRegularisation({ employmentRelationshipId: divya.employmentRelationshipId, date: day, reason: 'Forgot to clock in.' }),
    );

    const disputed = await asUser('hr@kaizen.co.in', () =>
      prisma.workAttendance.findUnique({
        where: { employmentRelationshipId_workDate: { employmentRelationshipId: divya.employmentRelationshipId, workDate: day } },
      }),
    );
    expect(disputed?.status).toBe('Disputed');

    const selfApprove = await expectReject(() => asUser('divya@kaizen.co.in', () => approveRegularisation(request.id)));
    expect(selfApprove.status).toBe(403);

    const approved = await asUser('hr@kaizen.co.in', () => approveRegularisation(request.id, 'Confirmed via badge log.', 480));
    expect(approved.status).toBe('approved');

    const regularised = await asUser('hr@kaizen.co.in', () => prisma.workAttendance.findUnique({ where: { id: disputed!.id } }));
    expect(regularised?.status).toBe('Regularised');
    expect(regularised?.workedMinutes).toBe(480);

    const reapprove = await expectReject(() => asUser('hr@kaizen.co.in', () => approveRegularisation(request.id)));
    expect(reapprove.status).toBe(422);
  });
});

describe('HCM-TIME-008 — visibility: a non-existent timesheet 404s rather than leaking a cross-tenant record', () => {
  it('HCM-TIME-008: reading a timesheet id that does not exist in this tenant 404s', async () => {
    const rejected = await expectReject(() => asUser('hr@kaizen.co.in', () => getTimesheet('does-not-exist')));
    expect(rejected.status).toBe(404);
  });
});

describe('HCM-TIME-009 — own-scope visibility on a colleague’s timesheet', () => {
  it('HCM-TIME-009: an employee-scoped principal cannot read a colleague’s timesheet by id', async () => {
    const divya = await employmentFor('divya@kaizen.co.in');
    const day = fixtureDay(50);

    const timesheet = await asUser('divya@kaizen.co.in', async () => {
      const entry = await addTimesheetEntry({ employmentRelationshipId: divya.employmentRelationshipId, date: day, hours: 6, taskRef: 'Fixture task 2' });
      return submitTimesheet(entry.timesheetId);
    });

    const rejected = await expectReject(() => asUser('priya@kaizen.co.in', () => getTimesheet(timesheet.id)));
    expect(rejected.status).toBe(404);
  });
});
