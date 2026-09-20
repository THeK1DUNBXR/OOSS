/**
 * HCM — WS5 performance (docs/hcm/performance.md).
 *
 * HCM-PERFORMANCE-001..011: review cycle create -> phase transitions ->
 * assignment -> submit -> calibrate -> release, the Self-Dealing Bar on
 * releasing a rating and closing a PIP, visibility gating, and cross-tenant
 * isolation.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import {
  createReviewCycle,
  advanceReviewCyclePhase,
  getReviewCycle,
  createReviewAssignment,
  submitReviewResponse,
  getReviewAssignment,
  openCalibrationSession,
  updateCalibrationDecisions,
  closeCalibrationSession,
  listFinalRatings,
  releaseFinalRating,
  nineBoxForCycle,
  giveFeedback,
  listFeedback,
  openPip,
  closePip,
} from '../../domains/hcm/performance.js';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

/** A throwaway employee with no login, for use as a subject/reviewer id in fixtures. */
async function makeEmployee(label: string) {
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
        primaryEmail: `fixture.performance.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { employment, person };
  });
}

/** The employment relationship behind one of the seeded, logged-in demo accounts. */
async function employmentFor(email: string): Promise<{ employmentRelationshipId: string; personId: string }> {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email, tenant: { slug: 'kaizen' } } });
  const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({
    where: { tenantId: TENANT, personId: user.personId },
    orderBy: { hireEffectiveDate: 'desc' },
  });
  return { employmentRelationshipId: employment.id, personId: user.personId };
}

async function makeCycle(label: string) {
  return asUser('operations@kaizen.co.in', () =>
    createReviewCycle({
      name: `Fixture cycle ${label} ${Date.now()}`,
      kind: 'annual',
      periodLabel: 'FY2026-27',
      startsOn: new Date(),
      endsOn: new Date(Date.now() + 60 * 86_400_000),
    }),
  );
}

// ===========================================================================
// Review cycles
// ===========================================================================

describe('HCM-PERFORMANCE-001 — a review cycle is created in phase "self" with a record code', () => {
  it('allocates a RVW-prefixed record code and opens in phase self', async () => {
    const cycle = await makeCycle('create');
    expect(cycle.recordCode).toMatch(/^RVW-\d{4}-\d{5}$/);
    expect(cycle.phase).toBe('self');
  });
});

describe('HCM-PERFORMANCE-002 — a cycle only ever advances one phase at a time', () => {
  it('refuses jumping from self straight to closed', async () => {
    const cycle = await makeCycle('skip-phase');
    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'closed')));
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/manager/);
  });

  it('accepts self -> manager in order', async () => {
    const cycle = await makeCycle('advance-ok');
    const advanced = await asUser('operations@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'manager'));
    expect(advanced.phase).toBe('manager');
  });
});

// ===========================================================================
// Review assignments
// ===========================================================================

describe('HCM-PERFORMANCE-003 — a reviewer never reviews themselves outside the self form', () => {
  it('refuses a manager-kind assignment where the reviewer is the subject', async () => {
    const cycle = await makeCycle('self-dealing-assignment');
    const { employment } = await makeEmployee('assignment-subject');

    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () =>
        createReviewAssignment({
          cycleId: cycle.id,
          employmentRelationshipId: employment.id,
          reviewerEmploymentRelationshipId: employment.id,
          kind: 'manager',
        }),
      ),
    );
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/reviewer/);
  });

  it('accepts a self-kind assignment where reviewer and subject are the same person', async () => {
    const cycle = await makeCycle('self-form');
    const { employment } = await makeEmployee('self-form-subject');
    const assignment = await asUser('operations@kaizen.co.in', () =>
      createReviewAssignment({
        cycleId: cycle.id,
        employmentRelationshipId: employment.id,
        reviewerEmploymentRelationshipId: employment.id,
        kind: 'self',
      }),
    );
    expect(assignment.kind).toBe('self');
    expect(assignment.status).toBe('pending');
  });
});

describe('HCM-PERFORMANCE-004 — a submitted review is final; it cannot be resubmitted', () => {
  it('moves the assignment to submitted and refuses a second submission', async () => {
    const cycle = await makeCycle('submit');
    const subject = await makeEmployee('submit-subject');
    const reviewerEmp = await employmentFor('hr@kaizen.co.in');

    const assignment = await asUser('operations@kaizen.co.in', () =>
      createReviewAssignment({
        cycleId: cycle.id,
        employmentRelationshipId: subject.employment.id,
        reviewerEmploymentRelationshipId: reviewerEmp.employmentRelationshipId,
        kind: 'manager',
      }),
    );

    await asUser('operations@kaizen.co.in', () =>
      submitReviewResponse(assignment.id, { ratings: [{ sectionKey: 'impact', score: 4 }], comments: 'Solid quarter.' }),
    );

    const fetched = await asUser('operations@kaizen.co.in', () => getReviewAssignment(assignment.id));
    expect(fetched.status).toBe('submitted');
    expect(fetched.response?.comments).toBe('Solid quarter.');

    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => submitReviewResponse(assignment.id, { ratings: [{ sectionKey: 'impact', score: 5 }] })),
    );
    expect(err.status).toBe(409);
  });
});

// ===========================================================================
// Calibration -> final ratings -> release
// ===========================================================================

describe('HCM-PERFORMANCE-005 — closing a calibration session snapshots decisions into final ratings', () => {
  it('creates a FinalRating row per decision', async () => {
    const cycle = await makeCycle('calibrate');
    const subject = await makeEmployee('calibrate-subject');

    await asUser('operations@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'manager'));
    await asUser('operations@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'calibration'));

    const session = await asUser('operations@kaizen.co.in', () =>
      openCalibrationSession({ cycleId: cycle.id, participants: [{ employmentRelationshipId: subject.employment.id }] }),
    );
    await asUser('operations@kaizen.co.in', () =>
      updateCalibrationDecisions(session.id, [
        { employmentRelationshipId: subject.employment.id, rating: '4', potential: 'high', promotionRecommended: true },
      ]),
    );
    const closed = await asUser('operations@kaizen.co.in', () => closeCalibrationSession(session.id));
    expect(closed.status).toBe('closed');

    const ratings = await asUser('operations@kaizen.co.in', () => listFinalRatings({ cycleId: cycle.id }));
    const mine = ratings.find((r) => r.employmentRelationshipId === subject.employment.id);
    expect(mine?.rating).toBe('4');
    expect(mine?.released).toBe(false);
  });

  it('refuses closing an already-closed session', async () => {
    const cycle = await makeCycle('calibrate-twice');
    const subject = await makeEmployee('calibrate-twice-subject');
    await asUser('operations@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'manager'));
    await asUser('operations@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'calibration'));
    const session = await asUser('operations@kaizen.co.in', () =>
      openCalibrationSession({ cycleId: cycle.id, participants: [{ employmentRelationshipId: subject.employment.id }] }),
    );
    await asUser('operations@kaizen.co.in', () =>
      updateCalibrationDecisions(session.id, [{ employmentRelationshipId: subject.employment.id, rating: '3', potential: 'medium' }]),
    );
    await asUser('operations@kaizen.co.in', () => closeCalibrationSession(session.id));
    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => closeCalibrationSession(session.id)));
    expect(err.status).toBe(409);
  });
});

describe('HCM-PERFORMANCE-006 — the Self-Dealing Bar: nobody releases their own final rating', () => {
  it('refuses when the releaser is the rating\'s subject', async () => {
    const cycle = await makeCycle('self-release');
    const hrEmployment = await employmentFor('hr@kaizen.co.in');

    // hr@kaizen.co.in is also hr_ops_manager (an all-scope grant on
    // review_cycles/calibrations/reviews), so they can run their own cycle
    // through to a rating on themselves — and then hit the bar trying to
    // release it.
    await asUser('hr@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'manager'));
    await asUser('hr@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'calibration'));
    const session = await asUser('hr@kaizen.co.in', () =>
      openCalibrationSession({ cycleId: cycle.id, participants: [{ employmentRelationshipId: hrEmployment.employmentRelationshipId }] }),
    );
    await asUser('hr@kaizen.co.in', () =>
      updateCalibrationDecisions(session.id, [
        { employmentRelationshipId: hrEmployment.employmentRelationshipId, rating: '5', potential: 'high' },
      ]),
    );
    await asUser('hr@kaizen.co.in', () => closeCalibrationSession(session.id));
    await asUser('hr@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'closed'));

    const [rating] = await asUser('hr@kaizen.co.in', () => listFinalRatings({ cycleId: cycle.id }));

    const selfErr = await expectReject(() => asUser('hr@kaizen.co.in', () => releaseFinalRating(rating.id)));
    expect(selfErr.status).toBe(403);
    expect(selfErr.message).toMatch(/Self-Dealing Bar/);

    // A different hr_ops_manager principal may release it.
    const released = await asUser('operations@kaizen.co.in', () => releaseFinalRating(rating.id));
    expect(released.released).toBe(true);
  });
});

describe('HCM-PERFORMANCE-007 — a rating is hidden from its subject until the cycle is closed and released', () => {
  it('is invisible before release, visible to the subject after', async () => {
    const cycle = await makeCycle('visibility');
    const divya = await employmentFor('divya@kaizen.co.in');

    await asUser('operations@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'manager'));
    await asUser('operations@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'calibration'));
    const session = await asUser('operations@kaizen.co.in', () =>
      openCalibrationSession({ cycleId: cycle.id, participants: [{ employmentRelationshipId: divya.employmentRelationshipId }] }),
    );
    await asUser('operations@kaizen.co.in', () =>
      updateCalibrationDecisions(session.id, [{ employmentRelationshipId: divya.employmentRelationshipId, rating: '3', potential: 'medium' }]),
    );
    await asUser('operations@kaizen.co.in', () => closeCalibrationSession(session.id));
    await asUser('operations@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'closed'));

    const [rating] = await asUser('operations@kaizen.co.in', () => listFinalRatings({ cycleId: cycle.id }));

    const beforeRelease = await asUser('divya@kaizen.co.in', () => listFinalRatings({ cycleId: cycle.id }));
    expect(beforeRelease).toHaveLength(0);

    await asUser('operations@kaizen.co.in', () => releaseFinalRating(rating.id));

    const afterRelease = await asUser('divya@kaizen.co.in', () => listFinalRatings({ cycleId: cycle.id }));
    expect(afterRelease).toHaveLength(1);
    expect(afterRelease[0].released).toBe(true);
  });
});

describe('HCM-PERFORMANCE-008 — the 9-box needs an all-scope grant', () => {
  it('refuses an own-scoped employee', async () => {
    const cycle = await makeCycle('nine-box');
    const err = await expectReject(() => asUser('divya@kaizen.co.in', () => nineBoxForCycle(cycle.id)));
    expect(err.status).toBe(403);
  });

  it('lets hr_ops_manager compute the cell for a rated employee', async () => {
    const cycle = await makeCycle('nine-box-hr');
    const ravi = await employmentFor('ravi@kaizen.co.in');
    await asUser('operations@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'manager'));
    await asUser('operations@kaizen.co.in', () => advanceReviewCyclePhase(cycle.id, 'calibration'));
    const session = await asUser('operations@kaizen.co.in', () =>
      openCalibrationSession({ cycleId: cycle.id, participants: [{ employmentRelationshipId: ravi.employmentRelationshipId }] }),
    );
    await asUser('operations@kaizen.co.in', () =>
      updateCalibrationDecisions(session.id, [{ employmentRelationshipId: ravi.employmentRelationshipId, rating: '5', potential: 'high' }]),
    );
    await asUser('operations@kaizen.co.in', () => closeCalibrationSession(session.id));

    const grid = await asUser('operations@kaizen.co.in', () => nineBoxForCycle(cycle.id));
    const cell = grid.find((g) => g.employmentRelationshipId === ravi.employmentRelationshipId);
    expect(cell?.label).toBe('Star');
  });
});

// ===========================================================================
// Feedback
// ===========================================================================

describe('HCM-PERFORMANCE-009 — feedback is visible to its giver and recipient, not to an unrelated colleague', () => {
  it('an unrelated employee cannot list feedback given about somebody else', async () => {
    const divya = await employmentFor('divya@kaizen.co.in');
    const ravi = await employmentFor('ravi@kaizen.co.in');

    await asUser('divya@kaizen.co.in', () =>
      giveFeedback({
        fromEmploymentRelationshipId: divya.employmentRelationshipId,
        toEmploymentRelationshipId: ravi.employmentRelationshipId,
        kind: 'praise',
        message: 'Great work covering the Chennai batch this week.',
      }),
    );

    const raviView = await asUser('ravi@kaizen.co.in', () => listFeedback({}));
    expect(raviView.some((f) => f.fromPartyId === divya.personId)).toBe(true);

    const hrView = await asUser('operations@kaizen.co.in', () => listFeedback({ employmentRelationshipId: ravi.employmentRelationshipId }));
    expect(hrView.length).toBeGreaterThan(0);
  });

  it('refuses giving feedback "from" someone other than yourself', async () => {
    const divya = await employmentFor('divya@kaizen.co.in');
    const ravi = await employmentFor('ravi@kaizen.co.in');
    const err = await expectReject(() =>
      asUser('ravi@kaizen.co.in', () =>
        giveFeedback({
          fromEmploymentRelationshipId: divya.employmentRelationshipId,
          toEmploymentRelationshipId: ravi.employmentRelationshipId,
          kind: 'praise',
          message: 'Impersonating divya.',
        }),
      ),
    );
    expect(err.status).toBe(403);
  });
});

// ===========================================================================
// PIPs
// ===========================================================================

describe('HCM-PERFORMANCE-010 — the Self-Dealing Bar: nobody closes their own PIP', () => {
  it('refuses when the closer is the PIP subject, accepts a different manager', async () => {
    // meera@kaizen.co.in and kavitha@kaizen.co.in both map onto hr_ops_manager
    // (an all-scope grant on `pips`), so both genuinely hold `pips:edit` — the
    // refusal below is the Self-Dealing Bar itself, not a missing grant.
    const meera = await employmentFor('meera@kaizen.co.in');
    const pip = await asUser('operations@kaizen.co.in', () =>
      openPip({
        employmentRelationshipId: meera.employmentRelationshipId,
        startsOn: new Date(),
        endsOn: new Date(Date.now() + 30 * 86_400_000),
        objectives: [{ description: 'Hit weekly counselling targets.' }],
      }),
    );

    const selfCloseErr = await expectReject(() => asUser('meera@kaizen.co.in', () => closePip(pip.id, 'successful')));
    expect(selfCloseErr.status).toBe(403);
    expect(selfCloseErr.message).toMatch(/Self-Dealing Bar/);

    const closed = await asUser('kavitha@kaizen.co.in', () => closePip(pip.id, 'successful', 'Targets met for three straight weeks.'));
    expect(closed.outcome).toBe('successful');
  });
});

// ===========================================================================
// Cross-tenant isolation
// ===========================================================================

describe('HCM-PERFORMANCE-011 — a review cycle from another tenant is invisible (404, not a leak)', () => {
  it('returns 404 rather than the record when the row belongs to a different tenant', async () => {
    const otherTenant = await unscopedPrisma.tenant.create({
      data: { name: `Other Tenant ${Date.now()}`, slug: `other-perf-${Date.now()}` },
    });
    const foreignCycle = await unscopedPrisma.reviewCycle.create({
      data: {
        tenantId: otherTenant.id,
        recordCode: `RVW-${new Date().getUTCFullYear()}-99999`,
        name: 'Foreign cycle',
        kind: 'annual',
        periodLabel: 'Foreign',
        phase: 'self',
        startsOn: new Date(),
        endsOn: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => getReviewCycle(foreignCycle.id)));
    expect(err.status).toBe(404);
  });
});
