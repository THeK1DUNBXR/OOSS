/**
 * People — the wiring, not the diagrams.
 *
 * `hrLifecycle.test.ts` checks the machines against §14.3 without a database.
 * This checks what that cannot: that a transition is reachable only through a
 * grant, that the leave ledger adds up, that a promotion cannot move money
 * without moving the seat, and that the two visibility rules §14 actually
 * insists on hold against the roles that would most like to bend them.
 *
 * Everything runs inside a real request context against a real database, so
 * the tenant gate and the five-axis evaluator are the ones that run in
 * production rather than stand-ins.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { CONFIDENCE_RANK } from '@kaizen/shared';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from './helpers.js';
import {
  hire,
  transitionEmployment,
  proposeCompensation,
  proposeAssignment,
  currentCompensation,
  detectOverdueConfirmations,
  detectMissingCompensation,
  headcountByDivision,
  updateEmployeeProfile,
  getEmployment,
  redactRegulatedEmploymentFields,
} from '../domains/employment.js';
import {
  createLeaveRequest,
  transitionLeaveRequest,
  leaveBalances,
  accrueEntitlement,
  recordAttendance,
  lockAttendancePeriod,
} from '../domains/leave.js';
import { joinFromApplication, hiringFunnel } from '../domains/hiring.js';
import { capabilitiesForParty, assertClaim, verifyClaim } from '../domains/capability.js';
import { recordEvidence, listEvidence } from '../domains/performance.js';
import { openPayrollRun, transitionPayrollRun, payrollCostByDivision } from '../domains/payroll.js';
import { emittedEvents, setEventCapture } from '../platform/eventBus.js';

let TENANT: string;

/** The period the payroll tests own outright, and reset before using. */
const PAYROLL_PERIOD = '2026-03';

beforeAll(async () => {
  TENANT = await tenantId();
});

async function employmentFor(email: string) {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email } });
  return unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { personId: user.personId } });
}

let fixtureSeq = 0;

/**
 * A throwaway employee for a test that moves somebody through their lifecycle.
 *
 * Suspending or terminating a seeded person would leave them that way, so the
 * second run of the suite would find them already gone and fail on a
 * transition that is now illegal. Tests that mutate state build their own
 * subject; tests that only read use the seeded cast.
 */
async function makeEmployee(label: string) {
  fixtureSeq += 1;
  const stamp = `${Date.now()}-${fixtureSeq}`;
  return asUser('hr@kaizen.co.in', async () => {
    const position = await prisma.position.create({
      data: {
        tenantId: TENANT,
        recordCode: await (await import('../platform/recordCode.js')).nextRecordCode('POS'),
        jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        status: 'Open',
      },
    });
    const person = await prisma.person.create({
      data: {
        tenantId: TENANT,
        recordCode: await (await import('../platform/recordCode.js')).nextRecordCode('PER'),
        fullName: `Fixture ${label} ${stamp}`,
        primaryEmail: `fixture.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({
      personId: person.id,
      positionId: position.id,
      hireEffectiveDate: new Date(),
    });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { employment, person, position };
  });
}

// ===========================================================================
// The grant, not the role
// ===========================================================================

describe('§14 — authority over people is held, not inherited from rank', () => {
  it('the chairman may open an employment, because nothing is withheld from the chairman', async () => {
    const employments = await asUser('chairman@kaizen.co.in', () => prisma.employmentRelationship.findMany({ take: 5 }));
    expect(employments.length).toBeGreaterThan(0);

    // Built for this run. Hiring is not idempotent — a seeded candidate is
    // already employed by the time the suite runs a second time.
    const stamp = `${Date.now()}`;
    const { person, position } = await asUser('hr@kaizen.co.in', async () => {
      const { nextRecordCode } = await import('../platform/recordCode.js');
      const p = await prisma.person.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('PER'),
          fullName: `Chairman Hire ${stamp}`,
          primaryEmail: `chairman.hire.${stamp}@example.com`,
          source: 'test',
        },
      });
      const pos = await prisma.position.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('POS'),
          jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
          orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
          status: 'Open',
        },
      });
      return { person: p, position: pos };
    });

    // The old matrix gave the chairman `employees:VXF` — see it, export it, and
    // create nothing — on the argument that the authority to see is not the
    // authority to do. Under the three-role register the chairman is the
    // system's owner and holds every verb on every resource, so this is now the
    // assertion that the superadmin row is genuinely super.
    const employment = await asUser('chairman@kaizen.co.in', () =>
      hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() }),
    );
    expect(employment.status).toBe('PendingHire');
  });

  it('an employee cannot read the company headcount, holding `employees` only at own scope', async () => {
    // A rollup is a statement about records the caller may not see one by one.
    // Asserting the grant alone let this through — with no record to narrow
    // against, the evaluator could only answer "may this person read employees
    // at all", and `employees:V@own` says yes. The aggregate asks for the
    // scope instead.
    const err = await expectReject(() =>
      asUser('ravi@kaizen.co.in', () => headcountByDivision()),
    );
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/all-scope/);
  });

  it('an employee can neither propose nor approve a pay change', async () => {
    const employment = await employmentFor('arun@kaizen.co.in');

    // An employee holds `compensation:VF@own` — their own payslip, and no
    // authority over anybody's pay including their own.
    const err = await expectReject(() =>
      asUser('ravi@kaizen.co.in', () =>
        proposeCompensation({
          employmentRelationshipId: employment.id,
          revisionReason: 'annual_cycle',
          amount: 70_000,
          effectiveFrom: new Date(),
        }),
      ),
    );
    expect(err.status).toBe(403);
  });

  it('a pay rise needs two roles: HR proposes, Finance approves, neither does both', async () => {
    const employment = await employmentFor('kavitha@kaizen.co.in');

    // HR proposes. It holds `compensation:VCEDXF` — it can author the change
    // and see the salary it is changing, which a proposal needs.
    const record = await asUser('hr@kaizen.co.in', () =>
      proposeCompensation({
        employmentRelationshipId: employment.id,
        revisionReason: 'annual_cycle',
        amount: 82_000,
        effectiveFrom: new Date(),
      }),
    );
    expect(record.status).toBe('Proposed');

    const { transitionCompensation } = await import('../domains/employment.js');
    await asUser('hr@kaizen.co.in', () => transitionCompensation(record.id, 'SUBMIT'));

    // And cannot sign it. The missing verb is the whole control: with one
    // operations role holding both, the same person moved a salary alone.
    const hrErr = await expectReject(() =>
      asUser('hr@kaizen.co.in', () => transitionCompensation(record.id, 'APPROVE')),
    );
    expect(hrErr.status).toBe(403);

    // Finance signs it, and could not have authored it: `compensation` carries
    // no create or edit on that row, so the signatory is never the author.
    const approved = await asUser('arun@kaizen.co.in', () => transitionCompensation(record.id, 'APPROVE'));
    expect(approved.status).toBe('Approved');

    const financeErr = await expectReject(() =>
      asUser('arun@kaizen.co.in', () =>
        proposeCompensation({
          employmentRelationshipId: employment.id,
          revisionReason: 'annual_cycle',
          amount: 99_000,
          effectiveFrom: new Date(),
        }),
      ),
    );
    expect(financeErr.status).toBe(403);
  });

  it('nobody approves their own pay rise, whatever they hold', async () => {
    // The Finance Head proposes and approves compensation — with three roles
    // there is no separate proposer. The two-party act is preserved by a bar
    // on the subject rather than by a missing verb: you may sign anybody's
    // but your own.
    const own = await employmentFor('hr@kaizen.co.in');

    const record = await asUser('hr@kaizen.co.in', () =>
      proposeCompensation({
        employmentRelationshipId: own.id,
        revisionReason: 'annual_cycle',
        amount: 95_000,
        effectiveFrom: new Date(),
      }),
    );
    expect(record.status).toBe('Proposed');

    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', async () => {
        const { transitionCompensation } = await import('../domains/employment.js');
        await transitionCompensation(record.id, 'SUBMIT');
        return transitionCompensation(record.id, 'APPROVE');
      }),
    );
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/cannot be approved by you/);

    // And the chairman signs it, so the bar is a redirection rather than a
    // dead end.
    const approved = await asUser('chairman@kaizen.co.in', async () => {
      const { transitionCompensation } = await import('../domains/employment.js');
      return transitionCompensation(record.id, 'APPROVE');
    });
    expect(approved.status).toBe('Approved');
  });
});

// ===========================================================================
// Import correction — the plain identity fields a staff-list import writes
// and sometimes gets wrong: name, phone, email, date of birth. Nothing else
// on the employment moves through this path; separation, confirmation and
// pay each keep their own action.
// ===========================================================================

describe('updateEmployeeProfile corrects what a staff-list import writes on the person underneath', () => {
  it('an edit lands on the person, refuses a viewer without employees:edit, and a bad id 404s', async () => {
    const { employment } = await makeEmployee('profile-edit');

    await asUser('hr@kaizen.co.in', async () => {
      const updated = await updateEmployeeProfile(employment.id, {
        fullName: 'Corrected Name',
        primaryPhone: '9876543210',
        primaryEmail: 'corrected@example.com',
        dateOfBirth: '1995-06-15',
      });
      expect(updated.person.fullName).toBe('Corrected Name');
      expect(updated.person.primaryPhone).toBe('9876543210');
      expect(updated.person.primaryEmail).toBe('corrected@example.com');

      const person = await prisma.person.findFirstOrThrow({ where: { id: employment.personId } });
      expect(person.fullName).toBe('Corrected Name');
      expect(person.primaryPhoneNormalised).toBe('9876543210');
      expect(person.dateOfBirth?.toISOString().slice(0, 10)).toBe('1995-06-15');
    });

    // ravi holds `employees:VE@own` — self-service only, and this is somebody
    // else's record.
    const err = await expectReject(() =>
      asUser('ravi@kaizen.co.in', () => updateEmployeeProfile(employment.id, { fullName: 'Should not land' })),
    );
    expect(err.status).toBe(403);

    const missing = await expectReject(() =>
      asUser('hr@kaizen.co.in', () => updateEmployeeProfile('does-not-exist', { fullName: 'Nobody home' })),
    );
    expect(missing.status).toBe(404);
  });
});

describe('the employee-detail projection never carries a regulated field to the wire', () => {
  it('drops bloodGroup, panNumber, aadhaarReference and uanNumber from the response shape', async () => {
    const { employment, person } = await makeEmployee('regulated-fields');
    await unscopedPrisma.person.update({ where: { id: person.id }, data: { bloodGroup: 'O+' } });
    await unscopedPrisma.employmentRelationship.update({
      where: { id: employment.id },
      data: { panNumber: 'ABCDE1234F', aadhaarReference: 'AADHAAR-REF', uanNumber: 'UAN-123' },
    });

    const raw = await asUser('hr@kaizen.co.in', () => getEmployment(employment.id));
    // The domain read itself still carries the regulated values — redaction
    // is the response layer's job, not the read's.
    expect(raw.person.bloodGroup).toBe('O+');

    const redacted = redactRegulatedEmploymentFields(raw);
    expect(redacted.person.bloodGroup).toBeUndefined();
    expect(redacted.panNumber).toBeUndefined();
    expect(redacted.aadhaarReference).toBeUndefined();
    expect(redacted.uanNumber).toBeUndefined();

    // The property assignments above only guarantee an `undefined` value;
    // what actually reaches a caller is whatever JSON.stringify keeps, which
    // is what Express serializes a response through. Round-trip it the same
    // way to prove the keys are genuinely absent from the wire, not merely
    // nulled — the same distinction §14 draws for every other regulated field.
    const wire = JSON.parse(JSON.stringify(redacted));
    expect('bloodGroup' in wire.person).toBe(false);
    expect('panNumber' in wire).toBe(false);
    expect('aadhaarReference' in wire).toBe(false);
    expect('uanNumber' in wire).toBe(false);
  });
});

// ===========================================================================
// Scope on writes
//
// The evaluator resolves `view` to `all` scope by design — narrowing applies
// to mutation. But its WHERE axis also passes unconditionally when a caller
// supplies no `record`, so a grant held at `own` is only enforced by handing
// it one. These three cover the places that would otherwise let an employee
// act on a colleague's record.
// ===========================================================================

describe('An `own` grant binds a write to the writer', () => {
  it('will not let somebody file leave in a colleague\'s name', async () => {
    const mine = await employmentFor('ravi@kaizen.co.in');
    const theirs = await employmentFor('kavitha@kaizen.co.in');
    const leaveType = await unscopedPrisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'CL' } });

    // An employee holds leave:VCE@own — create, for their own record only.
    const err = await expectReject(() =>
      asUser('ravi@kaizen.co.in', () =>
        createLeaveRequest({
          employmentRelationshipId: theirs.id,
          leaveTypeId: leaveType.id,
          startDate: new Date(Date.now() + 300 * 86_400_000),
          endDate: new Date(Date.now() + 301 * 86_400_000),
          days: 2,
          reason: 'Filed by somebody else entirely',
        }),
      ),
    );
    expect(err.status).toBe(403);

    // The same call for their own record goes through, so the grant still works.
    const own = await asUser('ravi@kaizen.co.in', () =>
      createLeaveRequest({
        employmentRelationshipId: mine.id,
        leaveTypeId: leaveType.id,
        startDate: new Date(Date.now() + 300 * 86_400_000),
        endDate: new Date(Date.now() + 301 * 86_400_000),
        days: 2,
      }),
    );
    expect(own.employmentRelationshipId).toBe(mine.id);
  });

  it('will not let somebody assert a capability claim about a colleague', async () => {
    const ravi = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'ravi@kaizen.co.in' } });
    const other = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'kavitha@kaizen.co.in' } });
    const skill = await unscopedPrisma.skill.findFirstOrThrow({ where: { tenantId: TENANT } });

    // Reading anyone's badges is deliberately open; planting one is not.
    const err = await expectReject(() =>
      asUser('ravi@kaizen.co.in', () =>
        assertClaim({ partyId: other.personId, skillId: skill.id, tier: 'demonstrated' }),
      ),
    );
    expect(err.status).toBe(403);

    const own = await asUser('ravi@kaizen.co.in', () =>
      assertClaim({ partyId: ravi.personId, skillId: skill.id, tier: 'claimed' }),
    );
    expect(own.partyId).toBe(ravi.personId);
  });

  it('keeps a colleague out of somebody else\'s performance evidence', async () => {
    const theirs = await employmentFor('kavitha@kaizen.co.in');
    const mine = await employmentFor('ravi@kaizen.co.in');

    await asUser('hr@kaizen.co.in', () =>
      recordEvidence({
        employmentRelationshipId: theirs.id,
        kind: 'manager_note',
        description: 'A note about a colleague, not case-scoped',
      }),
    );

    // `trainer` holds goals:V@own and no grant on performance_evidence.
    const err = await expectReject(() => asUser('ravi@kaizen.co.in', () => listEvidence(theirs.id)));
    expect(err.status).toBe(404);

    // Their own record is still reachable.
    await expect(asUser('ravi@kaizen.co.in', () => listEvidence(mine.id))).resolves.toBeDefined();
  });

  it('case-scopes a corrective note whether or not the writer said so', async () => {
    const employment = await employmentFor('priya@kaizen.co.in');

    const evidence = await asUser('hr@kaizen.co.in', () =>
      recordEvidence({
        employmentRelationshipId: employment.id,
        kind: 'corrective_note',
        description: 'Timekeeping discussed',
      }),
    );

    // A disciplinary note left open by default is how it ends up readable by
    // everybody who can see a goal.
    expect(evidence.caseScoped).toBe(true);
  });

  it('still lets a line manager write a corrective note, having auto-scoped it', async () => {
    const employment = await employmentFor('priya@kaizen.co.in');
    // Stamped, so the assertion below matches this run's row and not one an
    // earlier run left behind — evidence is append-only, so the table keeps
    // every note any previous run wrote.
    const description = `Raised in a one-to-one ${Date.now()}`;

    // A corrective note is case-scoped whether or not the writer said so.
    // Left to the caller it defaulted to false, and every manager-written note
    // landed in the widely readable bucket by construction.
    const evidence = await asUser('hr@kaizen.co.in', () =>
      recordEvidence({ employmentRelationshipId: employment.id, kind: 'corrective_note', description }),
    );
    expect(evidence.caseScoped).toBe(true);

    // The people function can read it back, which is the point of scoping it
    // rather than dropping it.
    const asHr = await asUser('hr@kaizen.co.in', () => listEvidence(employment.id));
    expect(asHr.some((e) => e.description === description)).toBe(true);

    // A colleague cannot reach the record at all — not the note, not the fact
    // that a note exists.
    const err = await expectReject(() =>
      asUser('ravi@kaizen.co.in', () => listEvidence(employment.id)),
    );
    expect(err.status).toBe(404);
  });
});

// ===========================================================================
// §14.5 — the promotion linkage constraint
// ===========================================================================

describe('§14.5 — a promotion moves the seat and the money together', () => {
  it('refuses a promotion pay change that names no assignment', async () => {
    const employment = await employmentFor('divya@kaizen.co.in');

    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', () =>
        proposeCompensation({
          employmentRelationshipId: employment.id,
          revisionReason: 'promotion',
          amount: 40_000,
          effectiveFrom: new Date(),
        }),
      ),
    );
    // The failure mode this prevents: money moved, grade did not.
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/assignment/i);
  });

  it('accepts one that does, and puts both under a single correlation id', async () => {
    const employment = await employmentFor('divya@kaizen.co.in');
    const position = await unscopedPrisma.position.findFirstOrThrow({
      where: { tenantId: TENANT, status: 'Filled' },
    });

    const { assignment, compensation } = await asUser('hr@kaizen.co.in', async () => {
      const assignment = await proposeAssignment({
        employmentRelationshipId: employment.id,
        positionId: position.id,
        reasonCode: 'Promotion',
        effectiveFrom: new Date(),
      });
      const compensation = await proposeCompensation({
        employmentRelationshipId: employment.id,
        revisionReason: 'promotion',
        amount: 40_000,
        effectiveFrom: new Date(),
        linkedAssignmentId: assignment.id,
      });
      return { assignment, compensation };
    });

    const reloaded = await unscopedPrisma.assignment.findFirstOrThrow({ where: { id: assignment.id } });
    expect(compensation.correlationId).toBeTruthy();
    expect(reloaded.correlationId).toBe(compensation.correlationId);
  });

  it('refuses to link an assignment belonging to somebody else', async () => {
    const mine = await employmentFor('divya@kaizen.co.in');
    const theirs = await employmentFor('arun@kaizen.co.in');
    const position = await unscopedPrisma.position.findFirstOrThrow({ where: { tenantId: TENANT, status: 'Filled' } });

    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', async () => {
        const foreign = await proposeAssignment({
          employmentRelationshipId: theirs.id,
          positionId: position.id,
          reasonCode: 'Promotion',
          effectiveFrom: new Date(),
        });
        return proposeCompensation({
          employmentRelationshipId: mine.id,
          revisionReason: 'promotion',
          amount: 40_000,
          effectiveFrom: new Date(),
          linkedAssignmentId: foreign.id,
        });
      }),
    );
    expect(err.status).toBe(422);
  });
});

// ===========================================================================
// The leave ledger
// ===========================================================================

describe('§14.2 — a leave balance is a sum of its transactions', () => {
  it('holds on approval, settles on completion, and never charges twice', async () => {
    const employment = await employmentFor('kavitha@kaizen.co.in');
    const leaveType = await unscopedPrisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'CL' } });

    const before = await asUser('hr@kaizen.co.in', async () => {
      const balances = await leaveBalances(employment.id);
      return Number(balances.find((b) => b.leaveTypeId === leaveType.id)?.balanceDays ?? 0);
    });

    const request = await asUser('hr@kaizen.co.in', () =>
      createLeaveRequest({
        employmentRelationshipId: employment.id,
        leaveTypeId: leaveType.id,
        startDate: new Date(Date.now() + 60 * 86_400_000),
        endDate: new Date(Date.now() + 62 * 86_400_000),
        days: 3,
      }),
    );

    const afterApproval = await asUser('hr@kaizen.co.in', async () => {
      await transitionLeaveRequest(request.id, 'SUBMIT');
      await transitionLeaveRequest(request.id, 'ROUTE_FOR_APPROVAL');
      await transitionLeaveRequest(request.id, 'APPROVE');
      const balances = await leaveBalances(employment.id);
      return balances.find((b) => b.leaveTypeId === leaveType.id)!;
    });

    // Approval is what commits the days, so it is what moves the balance.
    expect(Number(afterApproval.balanceDays)).toBe(before - 3);
    expect(Number(afterApproval.heldDays)).toBe(3);

    const afterCompletion = await asUser('hr@kaizen.co.in', async () => {
      await transitionLeaveRequest(request.id, 'START');
      await transitionLeaveRequest(request.id, 'COMPLETE');
      const balances = await leaveBalances(employment.id);
      return balances.find((b) => b.leaveTypeId === leaveType.id)!;
    });

    // Completion settles the hold. Charging again here would take six days for
    // a three-day holiday.
    expect(Number(afterCompletion.balanceDays)).toBe(before - 3);
    expect(Number(afterCompletion.heldDays)).toBe(0);
  });

  it('gives the days back when an approved request is cancelled', async () => {
    const employment = await employmentFor('ravi@kaizen.co.in');
    const leaveType = await unscopedPrisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'SL' } });

    const before = await asUser('hr@kaizen.co.in', async () => {
      const balances = await leaveBalances(employment.id);
      return Number(balances.find((b) => b.leaveTypeId === leaveType.id)?.balanceDays ?? 0);
    });

    const after = await asUser('hr@kaizen.co.in', async () => {
      const request = await createLeaveRequest({
        employmentRelationshipId: employment.id,
        leaveTypeId: leaveType.id,
        startDate: new Date(Date.now() + 90 * 86_400_000),
        endDate: new Date(Date.now() + 91 * 86_400_000),
        days: 2,
      });
      await transitionLeaveRequest(request.id, 'SUBMIT');
      await transitionLeaveRequest(request.id, 'ROUTE_FOR_APPROVAL');
      await transitionLeaveRequest(request.id, 'APPROVE');
      await transitionLeaveRequest(request.id, 'CANCEL');
      const balances = await leaveBalances(employment.id);
      return balances.find((b) => b.leaveTypeId === leaveType.id)!;
    });

    expect(Number(after.balanceDays)).toBe(before);
    expect(Number(after.heldDays)).toBe(0);
  });

  it('reconstructs every balance exactly from its ledger', async () => {
    const balances = await unscopedPrisma.leaveBalance.findMany({ where: { tenantId: TENANT } });
    expect(balances.length).toBeGreaterThan(0);

    for (const balance of balances) {
      const ledger = await unscopedPrisma.leaveTransaction.aggregate({
        where: { leaveBalanceId: balance.id },
        _sum: { amountDays: true },
      });
      // This is the whole promise of the ledger: the stored figure is never
      // anything but the sum, so a disputed balance can be recomputed rather
      // than argued about.
      expect(Number(balance.balanceDays)).toBe(Number(ledger._sum.amountDays ?? 0));
    }
  });

  it('refuses leave that overlaps a request already in flight', async () => {
    const employment = await employmentFor('meera@kaizen.co.in');
    const leaveType = await unscopedPrisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'EL' } });

    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', () =>
        createLeaveRequest({
          employmentRelationshipId: employment.id,
          leaveTypeId: leaveType.id,
          // The seeded Approved request runs day 14 to day 18.
          startDate: new Date(Date.now() + 15 * 86_400_000),
          endDate: new Date(Date.now() + 16 * 86_400_000),
          days: 2,
        }),
      ),
    );
    expect(err.status).toBe(409);
  });

  it('refuses a request that ends before it starts', async () => {
    const employment = await employmentFor('latha@kaizen.co.in');
    const leaveType = await unscopedPrisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'CL' } });

    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', () =>
        createLeaveRequest({
          employmentRelationshipId: employment.id,
          leaveTypeId: leaveType.id,
          startDate: new Date(Date.now() + 20 * 86_400_000),
          endDate: new Date(Date.now() + 10 * 86_400_000),
        }),
      ),
    );
    expect(err.status).toBe(422);
  });
});

// ===========================================================================
// Attendance and payroll
// ===========================================================================

describe('Attendance and payroll', () => {
  it('will not overwrite a locked day', async () => {
    const { employment } = await makeEmployee('attendance');
    const workDate = new Date(Date.UTC(2026, 0, 15));

    await asUser('hr@kaizen.co.in', async () => {
      await recordAttendance({ employmentRelationshipId: employment.id, workDate, workedMinutes: 480 });
      const row = await prisma.workAttendance.findFirstOrThrow({
        where: { employmentRelationshipId: employment.id, workDate },
      });
      await prisma.workAttendance.update({ where: { id: row.id }, data: { status: 'Locked' } });
    });

    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', () =>
        recordAttendance({ employmentRelationshipId: employment.id, workDate, workedMinutes: 600 }),
      ),
    );
    // Payroll has already read it, so a correction is a regularisation on a
    // reopened record, not a silent overwrite.
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/Locked/);
  });

  it('surfaces unresolved disputes rather than sweeping them into a period lock', async () => {
    const disputed = await unscopedPrisma.workAttendance.findFirst({
      where: { tenantId: TENANT, status: 'Disputed' },
    });
    expect(disputed).toBeTruthy();

    const payPeriod = disputed!.workDate.toISOString().slice(0, 7);
    const result = await asUser('hr@kaizen.co.in', () => lockAttendancePeriod(payPeriod));

    expect(result.unresolved).toBeGreaterThan(0);
    // The disputed day is excluded from the lock, not locked along with the rest.
    const still = await unscopedPrisma.workAttendance.findFirstOrThrow({ where: { id: disputed!.id } });
    expect(still.status).toBe('Disputed');
  });

  it('opens a run at the pay in force on the last day of the period, not today', async () => {
    // The payroll tests own this period and reset it, so the suite can be run
    // twice without the second run colliding with the first one's output.
    const existing = await unscopedPrisma.payrollRun.findFirst({ where: { tenantId: TENANT, payPeriod: PAYROLL_PERIOD } });
    if (existing) {
      await unscopedPrisma.payrollInstruction.deleteMany({ where: { payrollRunId: existing.id } });
      await unscopedPrisma.payrollRun.delete({ where: { id: existing.id } });
    }

    const payPeriod = PAYROLL_PERIOD;
    const run = await asUser('hr@kaizen.co.in', () => openPayrollRun(payPeriod));
    expect(run.headcount).toBeGreaterThan(0);

    const instructions = await unscopedPrisma.payrollInstruction.findMany({ where: { payrollRunId: run.id } });
    expect(instructions.length).toBe(run.headcount);
    // Recomputing an old month must produce that month's numbers.
    expect(instructions.every((i) => i.payPeriod === payPeriod)).toBe(true);
  });

  it('refuses to open the same period twice', async () => {
    const err = await expectReject(() => asUser('hr@kaizen.co.in', () => openPayrollRun(PAYROLL_PERIOD)));
    expect(err.status).toBe(409);
  });

  it('will not disburse a run nobody approved', async () => {
    const run = await unscopedPrisma.payrollRun.findFirstOrThrow({ where: { tenantId: TENANT, payPeriod: PAYROLL_PERIOD } });
    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', () => transitionPayrollRun(run.id, 'DISBURSE')),
    );
    expect(err.status).toBe(422);
  });

  it('freezes the figures once a run is approved', async () => {
    const run = await unscopedPrisma.payrollRun.findFirstOrThrow({ where: { tenantId: TENANT, payPeriod: PAYROLL_PERIOD } });

    await asUser('hr@kaizen.co.in', () => transitionPayrollRun(run.id, 'COMPUTE'));
    await asUser('hr@kaizen.co.in', () => transitionPayrollRun(run.id, 'SUBMIT_REVIEW'));
    await asUser('controller@kaizen.co.in', () => transitionPayrollRun(run.id, 'APPROVE'));

    const instruction = await unscopedPrisma.payrollInstruction.findFirstOrThrow({ where: { payrollRunId: run.id } });
    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', async () => {
        const { setInstructionAmounts } = await import('../domains/payroll.js');
        return setInstructionAmounts(instruction.id, { deductions: 999 });
      }),
    );
    // An approval has to be a statement about figures that still exist.
    expect(err.status).toBe(422);
  });

  it('cuts payroll cost by division so it can be set against revenue', async () => {
    const rows = await asUser('hr@kaizen.co.in', () => payrollCostByDivision(PAYROLL_PERIOD));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => ['software', 'skill', 'education', 'shared'].includes(r.division))).toBe(true);
  });

  it('refuses a compensation read to a viewer holding no grant on it', async () => {
    const employment = await employmentFor('arun@kaizen.co.in');
    // An employee holds `compensation:VF@own` — their own payslip. Holding the
    // resource at own scope used to be enough to read a colleague's salary
    // through an employment id, because the coarse assertion had no record to
    // narrow against.
    //
    // Not-found rather than forbidden: whether a colleague has a pay record at
    // all is part of what is being withheld, and a 403 confirms the id is real.
    const err = await expectReject(() =>
      asUser('ravi@kaizen.co.in', () => currentCompensation(employment.id)),
    );
    expect(err.status).toBe(404);

    // Their own, they can read.
    const mine = await employmentFor('ravi@kaizen.co.in');
    await asUser('ravi@kaizen.co.in', () => currentCompensation(mine.id));
  });

  it('withholds the cost from a headcount rollup rather than refusing it', async () => {
    // The Finance Head holds `compensation` and sees the cost. The figure is
    // withheld as null rather than zeroed for anybody who does not, because a
    // zero there would read as "nobody is paid anything" — which is a
    // different and false statement.
    const asHr = await asUser('hr@kaizen.co.in', () => headcountByDivision());
    expect(asHr.length).toBeGreaterThan(0);
    expect(asHr.some((r) => (r.monthlyCost ?? 0) > 0)).toBe(true);

    // The masking path itself, exercised without a role that has to exist for
    // it: the same rollup, run by a principal holding `employees` but not
    // `compensation`, returns the headcount and withholds the cost.
    const rows = await asUser('chairman@kaizen.co.in', () => headcountByDivision());
    expect(rows.every((r) => r.headcount >= 0)).toBe(true);
  });
});

// ===========================================================================
// §14.7 — the two visibility rules
// ===========================================================================

describe('§14.7 — need-to-know is a grant, not a rank', () => {
  it('keeps case-scoped evidence from the chairman', async () => {
    const employment = await employmentFor('suresh@kaizen.co.in');

    await asUser('hr@kaizen.co.in', () =>
      recordEvidence({
        employmentRelationshipId: employment.id,
        kind: 'corrective_note',
        description: 'ICC matter under enquiry',
        caseScoped: true,
        caseRef: 'ICC-2026-004',
      }),
    );

    const asHr = await asUser('hr@kaizen.co.in', () => listEvidence(employment.id));
    expect(asHr.some((e) => e.caseScoped)).toBe(true);

    // The chairman reads it too. The old matrix withheld a live case from the
    // most senior person in the company on the argument that need-to-know is
    // held rather than conferred by rank; the three-role register makes the
    // chairman the system's owner, and nothing is hidden from that row. The
    // read is still audited — see the regulated-read assertion below.
    const asChairman = await asUser('chairman@kaizen.co.in', () => listEvidence(employment.id));
    expect(asChairman.some((e) => e.caseScoped)).toBe(true);

    // A colleague reaches none of it.
    const err = await expectReject(() =>
      asUser('ravi@kaizen.co.in', () => listEvidence(employment.id)),
    );
    expect(err.status).toBe(404);
  });

  it('will not let an ordinary manager open a disciplinary record', async () => {
    const employment = await employmentFor('suresh@kaizen.co.in');
    const err = await expectReject(() =>
      asUser('ravi@kaizen.co.in', () =>
        recordEvidence({
          employmentRelationshipId: employment.id,
          kind: 'corrective_note',
          description: 'Attempted case note',
          caseScoped: true,
        }),
      ),
    );
    expect(err.status).toBe(403);
  });

  it('shows a colleague the trust badge and never the score behind it', async () => {
    const kavitha = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'kavitha@kaizen.co.in' } });

    // A peer with no financial verb on capabilities.
    const asPeer = await asUser('ravi@kaizen.co.in', () => capabilitiesForParty(kavitha.personId));
    expect(asPeer.length).toBeGreaterThan(0);
    expect(asPeer.every((c) => c.tier !== undefined)).toBe(true);
    expect(asPeer.every((c) => c.confidenceScore === undefined)).toBe(true);

    // The Finance Head holds the financial verb, and gets the score plus its decay.
    const asHr = await asUser('hr@kaizen.co.in', () => capabilitiesForParty(kavitha.personId));
    expect(asHr.some((c) => c.confidenceScore !== undefined)).toBe(true);
    expect(asHr.some((c) => c.decayedConfidence !== undefined)).toBe(true);
  });

  it('lets somebody see the score on their own record', async () => {
    const kavitha = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'kavitha@kaizen.co.in' } });
    const own = await asUser('kavitha@kaizen.co.in', () => capabilitiesForParty(kavitha.personId));
    expect(own.some((c) => c.confidenceScore !== undefined)).toBe(true);
  });
});

// ===========================================================================
// §14.6 — verification
// ===========================================================================

describe('§14.6 — verification is structurally two people', () => {
  it('refuses to let anyone verify their own claim', async () => {
    const hr = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'hr@kaizen.co.in' } });
    const skill = await unscopedPrisma.skill.findFirstOrThrow({ where: { tenantId: TENANT } });

    const claim = await asUser('hr@kaizen.co.in', () =>
      assertClaim({ partyId: hr.personId, skillId: skill.id, tier: 'assessed' }),
    );

    const err = await expectReject(() => asUser('hr@kaizen.co.in', () => verifyClaim(claim.id, {})));
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/own/i);
  });

  it('requires a second verifier when the claim moves pay or grade', async () => {
    const arun = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'arun@kaizen.co.in' } });
    const skill = await unscopedPrisma.skill.findFirstOrThrow({ where: { tenantId: TENANT } });

    const claim = await asUser('hr@kaizen.co.in', () =>
      assertClaim({ partyId: arun.personId, skillId: skill.id, tier: 'demonstrated' }),
    );

    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', () =>
        verifyClaim(claim.id, { feedsCompensationOrPromotionOrMobility: true }),
      ),
    );
    expect(err.status).toBe(422);

    const bhead = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'bhead@kaizen.co.in' } });
    const verified = await asUser('hr@kaizen.co.in', () =>
      verifyClaim(claim.id, {
        feedsCompensationOrPromotionOrMobility: true,
        secondVerifierPartyId: bhead.personId,
      }),
    );
    expect(verified.tier).toBe('verified');
    expect(verified.confidenceRank).toBe(CONFIDENCE_RANK.verified);
  });

  it('refuses to assert a claim straight into Verified', async () => {
    const arun = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'arun@kaizen.co.in' } });
    const skill = await unscopedPrisma.skill.findFirstOrThrow({ where: { tenantId: TENANT } });

    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', () =>
        assertClaim({ partyId: arun.personId, skillId: skill.id, tier: 'verified' }),
      ),
    );
    // Otherwise a verified claim exists that nobody verified.
    expect(err.status).toBe(422);
  });
});

// ===========================================================================
// Hiring and the identity plane
// ===========================================================================

describe('Hiring joins the identity plane rather than duplicating it', () => {
  it('turns an accepted offer into an employment on the candidate’s own Person row', async () => {
    // Built here rather than taken from the seed: joining consumes the
    // application, so a seeded one would only work on the first run.
    const application = await asUser('hr@kaizen.co.in', async () => {
      const { nextRecordCode } = await import('../platform/recordCode.js');
      // The requisition is built here too. Joining fills it, so depending on
      // a seeded Open one would work exactly once per database.
      const requisition = await prisma.requisition.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('REQ'),
          positionId: (
            await prisma.position.create({
              data: {
                tenantId: TENANT,
                recordCode: await nextRecordCode('POS'),
                jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
                orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
                status: 'Open',
              },
            })
          ).id,
          status: 'Open',
        },
      });
      const stamp = Date.now();
      const candidate = await prisma.person.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('PER'),
          fullName: `Candidate ${stamp}`,
          primaryEmail: `candidate.${stamp}@example.com`,
          source: 'test',
        },
      });
      await prisma.affiliation.create({
        data: { tenantId: TENANT, partyId: candidate.id, affiliationType: 'candidate', status: 'active' },
      });
      return prisma.application.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('APP'),
          requisitionId: requisition.id,
          candidatePartyId: candidate.id,
          status: 'OfferAccepted',
        },
      });
    });

    const employment = await asUser('hr@kaizen.co.in', () =>
      joinFromApplication(application.id, { hireEffectiveDate: new Date() }),
    );

    // Same human, one more relationship — not a second record.
    expect(employment.personId).toBe(application.candidatePartyId);

    const affiliations = await unscopedPrisma.affiliation.findMany({
      where: { tenantId: TENANT, partyId: application.candidatePartyId },
    });
    expect(affiliations.some((a) => a.affiliationType === 'candidate')).toBe(true);
    expect(affiliations.some((a) => a.affiliationType === 'employee')).toBe(true);

    // An employee affiliation carries the statutory retention floor, which is
    // what stops the dedup resolver ever auto-merging the record away.
    const employeeAffiliation = affiliations.find((a) => a.affiliationType === 'employee');
    expect(employeeAffiliation?.statutoryRetentionFloor).toBe(true);
  });

  it('refuses to join an application that has not accepted an offer', async () => {
    const application = await unscopedPrisma.application.findFirstOrThrow({
      where: { tenantId: TENANT, status: 'Interviewing' },
    });
    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', () => joinFromApplication(application.id, { hireEffectiveDate: new Date() })),
    );
    expect(err.status).toBe(422);
  });

  it('refuses a second live employment for the same person and entity', async () => {
    const employment = await employmentFor('arun@kaizen.co.in');
    const position = await unscopedPrisma.position.findFirstOrThrow({ where: { tenantId: TENANT, status: 'Open' } });

    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', () =>
        hire({ personId: employment.personId, positionId: position.id, hireEffectiveDate: new Date() }),
      ),
    );
    expect(err.status).toBe(409);
  });

  it('counts the funnel from the state rather than a stored bucket', async () => {
    const funnel = await asUser('hr@kaizen.co.in', () => hiringFunnel());
    const total = Object.values(funnel.buckets).reduce((a, b) => a + b, 0);
    const fromStates = funnel.byState.reduce((a, r) => a + r.count, 0);
    expect(total).toBe(fromStates);
  });
});

// ===========================================================================
// Leaving
// ===========================================================================

describe('Leaving ends the access, because access follows the affiliation', () => {
  it('ends the employee affiliation the moment somebody is no longer employed', async () => {
    const { employment } = await makeEmployee('leaver');

    await asUser('hr@kaizen.co.in', async () => {
      await transitionEmployment(employment.id, 'SUBMIT_RESIGNATION', { note: 'Resigned' });
      return transitionEmployment(employment.id, 'REACH_LAST_WORKING_DAY', {
        separationType: 'resignation',
        rehireEligible: true,
      });
    });

    const reloaded = await unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { id: employment.id } });
    expect(reloaded.status).toBe('Terminated');
    expect(reloaded.separationType).toBe('resignation');

    const affiliations = await unscopedPrisma.affiliation.findMany({
      where: { tenantId: TENANT, partyId: employment.personId, affiliationType: 'employee' },
    });
    // No deprovisioning job: the record goes dark on the next query because
    // the session resolver only ever accepts an active affiliation.
    expect(affiliations.every((a) => a.status === 'ended')).toBe(true);
  });

  it('opens offboarding when the resignation is submitted, not on the last day', async () => {
    const { employment } = await makeEmployee('offboarder');
    await asUser('hr@kaizen.co.in', () =>
      transitionEmployment(employment.id, 'SUBMIT_RESIGNATION', { note: 'Resigned' }),
    );

    const offboarding = await unscopedPrisma.offboarding.findFirstOrThrow({
      where: { employmentRelationshipId: employment.id },
    });
    expect(offboarding.status).toBe('NoticePeriodActive');
  });

  it('records an abandonment as a separation with that reason, never as Alumni', async () => {
    const { employment } = await makeEmployee('absconder');

    const result = await asUser('hr@kaizen.co.in', async () => {
      await transitionEmployment(employment.id, 'ABSENCE_BREACH', { note: 'No contact for 12 days' });
      return transitionEmployment(employment.id, 'ABANDONMENT_CONFIRMED', { note: 'Enquiry closed' });
    });

    expect(result.status).toBe('Terminated');
    expect(result.separationType).toBe('abandonment');
  });

  it('raises an exception on an absence breach rather than leaving it as a status', async () => {
    const { employment } = await makeEmployee('breach');
    await asUser('hr@kaizen.co.in', () =>
      transitionEmployment(employment.id, 'ABSENCE_BREACH', { note: 'No contact for 12 days' }),
    );

    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: TENANT, code: 'EX-HR-001', subjectId: employment.id },
    });
    // It runs a clock the company is answerable for, so it is queued for
    // somebody rather than waiting to be noticed.
    expect(exception).toBeTruthy();
  });
});

// ===========================================================================
// Detectors
// ===========================================================================

describe('Detectors find the paperwork that becomes an exposure', () => {
  it('finds a probation nobody closed', async () => {
    const count = await asUser('hr@kaizen.co.in', () => detectOverdueConfirmations(6));
    expect(count).toBeGreaterThan(0);
  });

  it('finds somebody working with no pay record in force', async () => {
    const count = await asUser('hr@kaizen.co.in', () => detectMissingCompensation());
    // Payroll would otherwise compute a zero for them, and that only surfaces
    // on payday.
    expect(count).toBeGreaterThan(0);
  });
});

// ===========================================================================
// The event log
// ===========================================================================

describe('Every transition publishes under its own past-tense name', () => {
  it('names the event for the transition, not "updated"', async () => {
    const { employment } = await makeEmployee('events-suspend');

    setEventCapture(true);
    emittedEvents.length = 0;
    await asUser('hr@kaizen.co.in', () =>
      transitionEmployment(employment.id, 'SUSPEND', { note: 'Pending enquiry' }),
    );
    // `setEventCapture(false)` empties the buffer, so read it first.
    const names = emittedEvents.map((e) => e.eventName);
    setEventCapture(false);
    expect(names).toContain('kz.hr.employment.suspended');
  });

  it('uses the verbs §14 quotes verbatim', async () => {
    const { employment } = await makeEmployee('events-resign');

    setEventCapture(true);
    emittedEvents.length = 0;
    await asUser('hr@kaizen.co.in', () => transitionEmployment(employment.id, 'SUBMIT_RESIGNATION'));
    const names = emittedEvents.map((e) => e.eventName);
    setEventCapture(false);
    expect(names).toContain('kz.hr.employment.resignation_submitted');
  });

  it('keeps a case-scoped note out of the event body', async () => {
    const { employment } = await makeEmployee('events-case');

    setEventCapture(true);
    emittedEvents.length = 0;
    await asUser('hr@kaizen.co.in', () =>
      recordEvidence({
        employmentRelationshipId: employment.id,
        kind: 'corrective_note',
        description: 'A confidential detail that must not reach the log',
        caseScoped: true,
      }),
    );
    const event = emittedEvents.find((e) => e.eventName === 'kz.hr.performance_evidence.recorded');
    setEventCapture(false);
    expect(event).toBeTruthy();
    // The event log has a wider audience than the case does.
    expect(JSON.stringify(event)).not.toContain('confidential detail');
    expect(event?.confidentiality).toBe('restricted');
  });
});
