/**
 * HCM-SEP — separations & exit management (docs/hcm/separations.md).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, asPrincipal, expectReject, prisma, tenantId, unscopedPrisma, withFixtureRole } from '../helpers.js';
import type { AuthContext } from '../../platform/context.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import {
  submitResignation,
  acceptResignation,
  rejectResignation,
  withdrawResignation,
  getResignation,
  listResignations,
  createNoticePolicy,
  noticeDaysFor,
  initiateClearance,
  listExitClearances,
  clearDepartment,
  blockDepartment,
  issueNoDues,
  getNoDues,
  recordAlumni,
  getOffboardingForEmployment,
} from '../../domains/hcm/separations.js';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

/** A throwaway employee, hired fresh by HR ops so a test that resigns/terminates them never collides with the seeded cast. */
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
        primaryEmail: `fixture.sep.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
      where: { tenantId: TENANT, partyId: person.id, affiliationType: 'employee', status: 'active' },
    });
    return { employment, person, position, affiliation };
  });
}

/** Runs `fn` as the fixture employee themselves — they hold no user/login, so a constructed AuthContext at `employee` role stands in for one, exactly as `asPrincipal` does for cross-tenant and agent cases elsewhere in the suite. */
function asEmployee<T>(fixture: { person: { id: string }; affiliation: { id: string } }, fn: () => Promise<T>): Promise<T> {
  const auth: AuthContext = {
    tenantId: TENANT,
    principalType: 'human',
    partyId: fixture.person.id,
    userId: null,
    agentId: null,
    onBehalfOfPartyId: null,
    affiliationId: fixture.affiliation.id,
    roleSlug: 'employee',
    branch: null,
    orgUnitId: null,
    classificationCeiling: 'internal',
    purpose: 'operational',
    consentCodes: [],
    stepUpVerified: true,
  };
  return asPrincipal(auth, fn);
}

// ===========================================================================
// HCM-SEP-001 — resignation: submit, accept, and the employment relationship
// actually moves.
// ===========================================================================

describe('HCM-SEP-001 — a resignation, accepted, moves the employment into notice and opens offboarding', () => {
  it('submits as the employee, accepts as HR ops, and the employment relationship reaches NoticePeriod with an Offboarding row', async () => {
    const fixture = await makeEmployee('accept');

    const resignation = await asEmployee(fixture, () =>
      submitResignation({
        employmentRelationshipId: fixture.employment.id,
        requestedLastDay: new Date(Date.now() + 30 * 86_400_000),
        reasonCategory: 'career_growth',
      }),
    );
    expect(resignation.status).toBe('submitted');
    expect(resignation.recordCode).toMatch(/^RSG-/);

    const accepted = await asUser('operations@kaizen.co.in', () => acceptResignation(resignation.id));
    expect(accepted.status).toBe('accepted');
    expect(accepted.offboardingId).toBeTruthy();

    const employment = await unscopedPrisma.employmentRelationship.findUniqueOrThrow({ where: { id: fixture.employment.id } });
    expect(employment.status).toBe('NoticePeriod');

    const offboarding = await unscopedPrisma.offboarding.findUniqueOrThrow({ where: { employmentRelationshipId: fixture.employment.id } });
    expect(offboarding.status).toBe('NoticePeriodActive');
  });
});

// ===========================================================================
// HCM-SEP-002 — the Self-Dealing Bar on acceptance/rejection.
// ===========================================================================

describe('HCM-SEP-002 — a resignation cannot be accepted or rejected by the person who filed it', () => {
  it('refuses acceptance when the accepting principal is the resigning employee', async () => {
    const fixture = await makeEmployee('self-accept');
    const resignation = await asEmployee(fixture, () =>
      submitResignation({
        employmentRelationshipId: fixture.employment.id,
        requestedLastDay: new Date(Date.now() + 30 * 86_400_000),
        reasonCategory: 'personal',
      }),
    );

    // The fixture employee holds no `resignations:approve` grant at all, so
    // this is refused on the WHO axis before the Self-Dealing Bar's own check
    // is ever reached — exactly as compensation's self-dealing bar is backed
    // by a missing verb, not only the bar itself.
    const err = await expectReject(() => asEmployee(fixture, () => acceptResignation(resignation.id)));
    expect(err.status).toBe(403);
  });
});

// ===========================================================================
// HCM-SEP-003 — one pending resignation at a time.
// ===========================================================================

describe('HCM-SEP-003 — a second resignation cannot be filed while one is already pending', () => {
  it('refuses a second submission and permits a fresh one only after the first is withdrawn', async () => {
    const fixture = await makeEmployee('duplicate');
    const first = await asEmployee(fixture, () =>
      submitResignation({
        employmentRelationshipId: fixture.employment.id,
        requestedLastDay: new Date(Date.now() + 30 * 86_400_000),
        reasonCategory: 'other',
      }),
    );

    const err = await expectReject(() =>
      asEmployee(fixture, () =>
        submitResignation({
          employmentRelationshipId: fixture.employment.id,
          requestedLastDay: new Date(Date.now() + 45 * 86_400_000),
          reasonCategory: 'other',
        }),
      ),
    );
    expect(err.status).toBe(409);

    await asEmployee(fixture, () => withdrawResignation(first.id));

    const second = await asEmployee(fixture, () =>
      submitResignation({
        employmentRelationshipId: fixture.employment.id,
        requestedLastDay: new Date(Date.now() + 45 * 86_400_000),
        reasonCategory: 'other',
      }),
    );
    expect(second.status).toBe('submitted');
  });
});

// ===========================================================================
// HCM-SEP-004 — a withdrawn resignation is closed, not reopenable.
// ===========================================================================

describe('HCM-SEP-004 — a withdrawn resignation cannot then be accepted', () => {
  it('rejects acceptance of a resignation already withdrawn', async () => {
    const fixture = await makeEmployee('withdraw-then-accept');
    const resignation = await asEmployee(fixture, () =>
      submitResignation({
        employmentRelationshipId: fixture.employment.id,
        requestedLastDay: new Date(Date.now() + 30 * 86_400_000),
        reasonCategory: 'relocation',
      }),
    );
    await asEmployee(fixture, () => withdrawResignation(resignation.id));

    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => acceptResignation(resignation.id)));
    expect(err.status).toBe(409);
  });
});

// ===========================================================================
// HCM-SEP-005 — notice policy resolution.
// ===========================================================================

describe('HCM-SEP-005 — notice days come from the most specific active policy, the flat default otherwise', () => {
  it('resolves an engagement-type-specific policy over the employment default, and copies it onto the resignation at submission', async () => {
    const fixture = await makeEmployee('notice-policy');
    await asUser('operations@kaizen.co.in', async () => {
      await prisma.employmentRelationship.update({ where: { id: fixture.employment.id }, data: { engagementType: 'contractor' } });
      await createNoticePolicy({ name: 'Contractor notice', engagementType: 'contractor', noticeDays: 7, buyoutAllowed: false });
    });

    const resolved = await asUser('operations@kaizen.co.in', () => noticeDaysFor(fixture.employment.id));
    expect(resolved.noticeDays).toBe(7);
    expect(resolved.source).toBe('policy');

    const resignation = await asEmployee(fixture, () =>
      submitResignation({
        employmentRelationshipId: fixture.employment.id,
        requestedLastDay: new Date(Date.now() + 7 * 86_400_000),
        reasonCategory: 'other',
      }),
    );
    expect(resignation.noticeDays).toBe(7);
  });
});

// ===========================================================================
// HCM-SEP-006 — exit clearance completes and pulls the offboarding forward.
// ===========================================================================

describe('HCM-SEP-006 — clearing every department completes the exit clearance and advances offboarding', () => {
  it('opens five departments, clears them all, and the offboarding reaches FFSettlementPending', async () => {
    const fixture = await makeEmployee('clearance');
    const resignation = await asEmployee(fixture, () =>
      submitResignation({
        employmentRelationshipId: fixture.employment.id,
        requestedLastDay: new Date(),
        reasonCategory: 'other',
      }),
    );
    const accepted = await asUser('operations@kaizen.co.in', () => acceptResignation(resignation.id));
    const offboardingId = accepted.offboardingId!;

    const clearances = await asUser('operations@kaizen.co.in', () => initiateClearance(offboardingId));
    expect(clearances).toHaveLength(5);
    expect(clearances.every((c) => c.status === 'pending')).toBe(true);

    await asUser('operations@kaizen.co.in', async () => {
      for (const c of clearances) await clearDepartment(c.id);
    });

    const offboarding = await unscopedPrisma.offboarding.findUniqueOrThrow({ where: { id: offboardingId } });
    expect(offboarding.status).toBe('FFSettlementPending');

    const view = await asUser('operations@kaizen.co.in', () => getOffboardingForEmployment(fixture.employment.id));
    expect(view?.allCleared).toBe(true);
  });
});

// ===========================================================================
// HCM-SEP-007 — the Self-Dealing Bar on clearance: nobody clears their own exit.
// ===========================================================================

describe('HCM-SEP-007 — a department cannot clear the exit of the person who is leaving', () => {
  it('refuses when the clearing principal is the departing employee themselves', async () => {
    const fixture = await makeEmployee('self-clear');
    const resignation = await asEmployee(fixture, () =>
      submitResignation({ employmentRelationshipId: fixture.employment.id, requestedLastDay: new Date(), reasonCategory: 'other' }),
    );
    const accepted = await asUser('operations@kaizen.co.in', () => acceptResignation(resignation.id));
    const clearances = await asUser('operations@kaizen.co.in', () => initiateClearance(accepted.offboardingId!));

    // The fixture employee holds no `exit_clearances:edit` grant at all
    // (`V@own` only), so — as with acceptance — the WHO axis refuses this
    // before the Self-Dealing Bar's own subject check is reached.
    const err = await expectReject(() => asEmployee(fixture, () => clearDepartment(clearances[0].id)));
    expect(err.status).toBe(403);
  });
});

// ===========================================================================
// HCM-SEP-008 — blocking disputes the offboarding; resolving clears it.
// ===========================================================================

describe('HCM-SEP-008 — a blocked department disputes the offboarding, and clearing it resolves the dispute', () => {
  it('moves the offboarding to BlockedDisputed on a block, and back to ClearancePending once the block clears', async () => {
    const fixture = await makeEmployee('block');
    const resignation = await asEmployee(fixture, () =>
      submitResignation({ employmentRelationshipId: fixture.employment.id, requestedLastDay: new Date(), reasonCategory: 'other' }),
    );
    const accepted = await asUser('operations@kaizen.co.in', () => acceptResignation(resignation.id));
    const offboardingId = accepted.offboardingId!;
    const clearances = await asUser('operations@kaizen.co.in', () => initiateClearance(offboardingId));

    const itRow = clearances.find((c) => c.department === 'it')!;
    await asUser('operations@kaizen.co.in', () => blockDepartment(itRow.id, 'Laptop not yet returned.'));

    const disputed = await unscopedPrisma.offboarding.findUniqueOrThrow({ where: { id: offboardingId } });
    expect(disputed.status).toBe('BlockedDisputed');

    await asUser('operations@kaizen.co.in', () => clearDepartment(itRow.id, 'Laptop returned.'));
    for (const c of clearances) {
      if (c.id === itRow.id) continue;
      await asUser('operations@kaizen.co.in', () => clearDepartment(c.id));
    }

    const resolved = await unscopedPrisma.offboarding.findUniqueOrThrow({ where: { id: offboardingId } });
    expect(resolved.status).toBe('FFSettlementPending');
  });
});

// ===========================================================================
// HCM-SEP-009 — no-dues certificate gated on clearance completeness.
// ===========================================================================

describe('HCM-SEP-009 — no-dues cannot be issued until every department has cleared', () => {
  it('refuses while a department is outstanding, and succeeds once all five clear', async () => {
    const fixture = await makeEmployee('no-dues');
    const resignation = await asEmployee(fixture, () =>
      submitResignation({ employmentRelationshipId: fixture.employment.id, requestedLastDay: new Date(), reasonCategory: 'other' }),
    );
    const accepted = await asUser('operations@kaizen.co.in', () => acceptResignation(resignation.id));
    const offboardingId = accepted.offboardingId!;
    const clearances = await asUser('operations@kaizen.co.in', () => initiateClearance(offboardingId));

    const early = await expectReject(() => asUser('operations@kaizen.co.in', () => issueNoDues(offboardingId)));
    expect(early.status).toBe(409);
    expect(early.message).toMatch(/outstanding/);

    await asUser('operations@kaizen.co.in', async () => {
      for (const c of clearances) await clearDepartment(c.id);
    });

    const certificate = await asUser('operations@kaizen.co.in', () => issueNoDues(offboardingId));
    expect(certificate.offboardingId).toBe(offboardingId);

    const fetched = await asUser('operations@kaizen.co.in', () => getNoDues(offboardingId));
    expect(fetched?.id).toBe(certificate.id);
  });
});

// ===========================================================================
// HCM-SEP-010 — cross-tenant isolation.
// ===========================================================================

describe('HCM-SEP-010 — a resignation from another tenant 404s rather than 403s', () => {
  it('is not found across a tenant boundary', async () => {
    const otherTenant = await unscopedPrisma.tenant.create({
      data: { slug: `sep-other-${Date.now()}`, name: 'Other Co' },
    });
    const foreignAuth: AuthContext = {
      tenantId: otherTenant.id,
      principalType: 'human',
      partyId: 'foreign-party',
      userId: null,
      agentId: null,
      onBehalfOfPartyId: null,
      affiliationId: null,
      roleSlug: 'hr_ops_manager',
      branch: null,
      orgUnitId: null,
      classificationCeiling: 'regulated',
      purpose: 'operational',
      consentCodes: [],
      stepUpVerified: true,
    };
    const foreign = await asPrincipal(
      foreignAuth,
      () =>
        prisma.resignation.create({
          data: {
            tenantId: otherTenant.id,
            recordCode: 'RSG-2026-99999',
            employmentRelationshipId: 'nonexistent',
            submittedOn: new Date(),
            requestedLastDay: new Date(),
            noticeDays: 30,
            reasonCategory: 'other',
            status: 'submitted',
          },
        }),
    );

    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => getResignation(foreign.id)));
    expect(err.status).toBe(404);
  });
});

// ===========================================================================
// HCM-SEP-011 — alumni record on the far side of Terminated.
// ===========================================================================

describe('HCM-SEP-011 — an alumni record moves Terminated into Alumni and survives the employment', () => {
  it('writes rehire-eligibility and consent onto the alumni record once separation reaches Terminated', async () => {
    const fixture = await makeEmployee('alumni');
    const resignation = await asEmployee(fixture, () =>
      submitResignation({ employmentRelationshipId: fixture.employment.id, requestedLastDay: new Date(), reasonCategory: 'other' }),
    );
    await asUser('operations@kaizen.co.in', () => acceptResignation(resignation.id));
    await asUser('operations@kaizen.co.in', () => transitionEmployment(fixture.employment.id, 'REACH_LAST_WORKING_DAY'));

    const alumni = await asUser('operations@kaizen.co.in', () =>
      recordAlumni({
        employmentRelationshipId: fixture.employment.id,
        rehireEligible: true,
        contactConsent: true,
        contactEmail: 'fixture.alumni@example.com',
      }),
    );
    expect(alumni.rehireEligible).toBe(true);
    expect(alumni.contactConsent).toBe(true);

    const employment = await unscopedPrisma.employmentRelationship.findUniqueOrThrow({ where: { id: fixture.employment.id } });
    expect(employment.status).toBe('Alumni');
  });
});

// ===========================================================================
// HCM-SEP-012 — own-scope narrowing on the resignation list.
// ===========================================================================

describe('HCM-SEP-012 — an employee sees only their own resignations, never a colleague\'s', () => {
  it('lists only the requesting employee\'s own row and cannot fetch a colleague\'s by id', async () => {
    const mine = await makeEmployee('own-scope-a');
    const theirs = await makeEmployee('own-scope-b');

    const myResignation = await asEmployee(mine, () =>
      submitResignation({ employmentRelationshipId: mine.employment.id, requestedLastDay: new Date(), reasonCategory: 'other' }),
    );
    await asEmployee(theirs, () =>
      submitResignation({ employmentRelationshipId: theirs.employment.id, requestedLastDay: new Date(), reasonCategory: 'other' }),
    );

    const mineList = await asEmployee(mine, () => listResignations());
    expect(mineList.map((r) => r.id)).toEqual([myResignation.id]);

    const theirResignation = (await asEmployee(theirs, () => listResignations()))[0];
    const err = await expectReject(() => asEmployee(mine, () => getResignation(theirResignation.id)));
    expect(err.status).toBe(404);
  });
});

// ===========================================================================
// HCM-SEP-013..017 — the scope-axis bug from the WS5 review, audited here.
//
// `assertCan({ resource, verb })` with no `record` only proves the verb is
// held at *some* scope; the WHERE axis narrows only when a record is
// supplied. Every admin-only write in this file now also asserts
// `scopeFor(resource, verb) === 'all'` before touching anything, so an
// `@own` grant on the same verb — today's matrix never hands the employee
// role one, but a tenant's own custom role could — can never stand in for
// real authority over a colleague's record. These fixture roles build
// exactly that hypothetical: the verb, held only at `own`.
// ===========================================================================

describe('HCM-SEP-013 — accepting a resignation needs an all-scope grant, never own', () => {
  it('refuses acceptance from a role holding `resignations:approve` at own scope', async () => {
    const fixture = await makeEmployee('scope-accept');
    const resignation = await asEmployee(fixture, () =>
      submitResignation({ employmentRelationshipId: fixture.employment.id, requestedLastDay: new Date(), reasonCategory: 'other' }),
    );

    const err = await withFixtureRole(
      { slug: 'sep_own_approver', grants: [{ resource: 'resignations', verbs: ['approve'], scope: 'own' }] },
      () => expectReject(() => acceptResignation(resignation.id)),
    );
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/all-scope/);
  });
});

describe('HCM-SEP-014 — clearing a department needs an all-scope grant, never own', () => {
  it('refuses a clear from a role holding `exit_clearances:edit` at own scope', async () => {
    const fixture = await makeEmployee('scope-clear');
    const resignation = await asEmployee(fixture, () =>
      submitResignation({ employmentRelationshipId: fixture.employment.id, requestedLastDay: new Date(), reasonCategory: 'other' }),
    );
    const accepted = await asUser('operations@kaizen.co.in', () => acceptResignation(resignation.id));
    const clearances = await asUser('operations@kaizen.co.in', () => initiateClearance(accepted.offboardingId!));

    const err = await withFixtureRole(
      { slug: 'sep_own_clearer', grants: [{ resource: 'exit_clearances', verbs: ['edit'], scope: 'own' }] },
      () => expectReject(() => clearDepartment(clearances[0].id)),
    );
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/all-scope/);
  });
});

describe('HCM-SEP-015 — opening exit clearance needs an all-scope grant, never own', () => {
  it('refuses `initiateClearance` from a role holding `exit_clearances:create` at own scope', async () => {
    const fixture = await makeEmployee('scope-initiate');
    const resignation = await asEmployee(fixture, () =>
      submitResignation({ employmentRelationshipId: fixture.employment.id, requestedLastDay: new Date(), reasonCategory: 'other' }),
    );
    const accepted = await asUser('operations@kaizen.co.in', () => acceptResignation(resignation.id));

    const err = await withFixtureRole(
      { slug: 'sep_own_initiator', grants: [{ resource: 'exit_clearances', verbs: ['create'], scope: 'own' }] },
      () => expectReject(() => initiateClearance(accepted.offboardingId!)),
    );
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/all-scope/);
  });
});

describe('HCM-SEP-016 — issuing a no-dues certificate needs an all-scope grant, never own', () => {
  it('refuses `issueNoDues` from a role holding `no_dues:create` at own scope', async () => {
    const fixture = await makeEmployee('scope-nodues');
    const resignation = await asEmployee(fixture, () =>
      submitResignation({ employmentRelationshipId: fixture.employment.id, requestedLastDay: new Date(), reasonCategory: 'other' }),
    );
    const accepted = await asUser('operations@kaizen.co.in', () => acceptResignation(resignation.id));
    const clearances = await asUser('operations@kaizen.co.in', () => initiateClearance(accepted.offboardingId!));
    await asUser('operations@kaizen.co.in', async () => {
      for (const c of clearances) await clearDepartment(c.id);
    });

    const err = await withFixtureRole(
      { slug: 'sep_own_nodues', grants: [{ resource: 'no_dues', verbs: ['create'], scope: 'own' }] },
      () => expectReject(() => issueNoDues(accepted.offboardingId!)),
    );
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/all-scope/);
  });
});

describe('HCM-SEP-017 — recording an alumni entry needs an all-scope grant, never own', () => {
  it('refuses `recordAlumni` from a role holding `alumni:create` at own scope', async () => {
    const fixture = await makeEmployee('scope-alumni');
    const resignation = await asEmployee(fixture, () =>
      submitResignation({ employmentRelationshipId: fixture.employment.id, requestedLastDay: new Date(), reasonCategory: 'other' }),
    );
    await asUser('operations@kaizen.co.in', () => acceptResignation(resignation.id));
    await asUser('operations@kaizen.co.in', () => transitionEmployment(fixture.employment.id, 'REACH_LAST_WORKING_DAY'));

    const err = await withFixtureRole(
      {
        slug: 'sep_own_alumni',
        grants: [
          { resource: 'alumni', verbs: ['create'], scope: 'own' },
          // `recordAlumni` reads the employment through `assertEmploymentVisible`
          // first, so the fixture needs to actually see it — at `all`, so the
          // refusal below is provably the alumni-scope check and not this one.
          { resource: 'employees', verbs: ['view'], scope: 'all' },
        ],
      },
      () => expectReject(() => recordAlumni({ employmentRelationshipId: fixture.employment.id })),
    );
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/all-scope/);
  });
});
