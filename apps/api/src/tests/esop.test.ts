/**
 * Phase 5 of the equity portal — ESOP.
 *
 * Requirements named `EQT-ESP-*`, per the phase-5 brief in
 * `docs/plan/equity-portal.md` §6.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  createShareClass, createHolder, proposeAllotment, approveShareTransaction, makeEffective,
  recordValuation, capTable,
} from '../domains/equity.js';
import {
  createPlan, activatePlan, listPlans, plan,
  proposeGrant, approveGrant, cancelGrant, lapseGrant, grant, listGrants,
  runVesting, runExpiredExerciseWindows, handleEmploymentExit,
  requestExercise, approveExercise, rejectExercise,
  sh6Register, sh6Export, myGrants,
} from '../domains/esop.js';
import { hire, transitionEmployment } from '../domains/employment.js';
import { createOrResetSignIn } from '../domains/signIns.js';
import { updateCompanyProfile } from '../domains/companyProfile.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { asUser, asPrincipal, authFor, expectReject, principalFor, prisma as scopedPrisma, tenantId, unscopedPrisma } from './helpers.js';

let HOLDING: string;
let POOL_CLASS_ID: string;
let TARGET_CLASS_ID: string;

async function newSecretary() {
  return asUser('chairman@kaizen.co.in', async () => {
    const email = 'secretary@kaizen.co.in';
    const existing = await unscopedPrisma.user.findFirst({ where: { email } });
    if (existing) return;
    const person = await scopedPrisma.person.create({
      data: { tenantId: HOLDING, recordCode: await nextRecordCode('PER'), fullName: 'Company Secretary', primaryEmail: email, primaryEmailNormalised: email, source: 'test' },
    });
    await createOrResetSignIn({ personId: person.id, roleSlug: 'company_secretary', email });
  });
}

async function ensureCertificateSignatories() {
  await asUser('chairman@kaizen.co.in', () =>
    updateCompanyProfile({
      certificateSignatories: [
        { name: 'A. Director', designation: 'Director' },
        { name: 'B. Secretary', designation: 'Company Secretary' },
      ],
    }),
  );
}

let fixtureSeq = 0;

/** A throwaway active employee, hired by HR. */
async function makeEmployee(label: string) {
  fixtureSeq += 1;
  const stamp = `${Date.now()}-${fixtureSeq}`;
  return asUser('hr@kaizen.co.in', async () => {
    const position = await scopedPrisma.position.create({
      data: {
        tenantId: HOLDING,
        recordCode: await nextRecordCode('POS'),
        jobId: (await scopedPrisma.job.findFirstOrThrow({ where: { tenantId: HOLDING } })).id,
        orgUnitId: (await scopedPrisma.orgUnit.findFirstOrThrow({ where: { tenantId: HOLDING } })).id,
        status: 'Open',
      },
    });
    const person = await scopedPrisma.person.create({
      data: {
        tenantId: HOLDING,
        recordCode: await nextRecordCode('PER'),
        fullName: `Fixture ${label} ${stamp}`,
        primaryEmail: `fixture.esop.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { employment, person };
  });
}

/** Runs `fn` as an "employee" principal with no User row — permission is by role slug + partyId, not by a sign-in. */
async function asEmployee<T>(personId: string, fn: () => Promise<T>): Promise<T> {
  const chairman = await principalFor('chairman@kaizen.co.in');
  return asPrincipal(authFor({ ...chairman, partyId: personId, roleSlug: 'employee' }), fn);
}

function monthsAgo(n: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString();
}

/** A fresh, active plan under a fresh option pool of the given size. */
async function newPlan(label: string, opts: { poolSize?: number; dpiit?: boolean; exercisePriceDefault?: number } = {}) {
  const stamp = `${label}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  if (opts.dpiit) {
    await asUser('finance@kaizen.co.in', () => updateCompanyProfile({ dpiitRecognisedOn: new Date().toISOString(), dpiitNumber: 'DPIIT-TEST' }));
  } else {
    await asUser('finance@kaizen.co.in', () => updateCompanyProfile({ dpiitRecognisedOn: null, dpiitNumber: null }));
  }

  const pool = await asUser('secretary@kaizen.co.in', () =>
    createShareClass({ name: `Option Pool ${stamp}`, kind: 'equity', instrument: 'option', faceValue: 0, authorisedCount: opts.poolSize ?? 10_000 }),
  );

  const created = await asUser('secretary@kaizen.co.in', () =>
    createPlan({
      name: `Plan ${stamp}`,
      poolShareClassId: pool.id,
      targetShareClassId: TARGET_CLASS_ID,
      exercisePriceDefault: opts.exercisePriceDefault ?? 10,
      vestingDefault: { cliffMonths: 12, totalMonths: 12, frequency: 'annual' },
    }),
  );

  const activated = await asUser('finance@kaizen.co.in', () =>
    activatePlan(created.id, { approvedOn: new Date().toISOString(), resolutionRef: `SR-${stamp}` }),
  );
  return activated;
}

beforeAll(async () => {
  HOLDING = await tenantId();
  await newSecretary();
  await ensureCertificateSignatories();
  const target = await asUser('secretary@kaizen.co.in', () => createShareClass({ name: `ESOP Target Equity ${Date.now()}`, kind: 'equity', instrument: 'equity', faceValue: 10, authorisedCount: 100_000 }));
  TARGET_CLASS_ID = target.id;
  POOL_CLASS_ID = target.id; // unused placeholder to satisfy the outer-scope var; each test makes its own pool
  void POOL_CLASS_ID;
});

describe('EQT-ESP-001 — a grant cannot exceed the pool\'s available options', () => {
  it('refuses a grant larger than the pool, naming the over-allocation', async () => {
    const p = await newPlan('001', { poolSize: 100 });
    const emp = await makeEmployee('esp001');

    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', () =>
        proposeGrant({ planId: p.id, employmentId: emp.employment.id, grantedOn: monthsAgo(0), count: 150, resolutionRef: 'SR-TEST' }),
      ),
    );
    expect(err.message).toMatch(/over-allocation/i);

    const within = await asUser('hr@kaizen.co.in', () =>
      proposeGrant({ planId: p.id, employmentId: emp.employment.id, grantedOn: monthsAgo(0), count: 50, resolutionRef: 'SR-TEST' }),
    );
    expect(within.count).toBe(50);

    const refreshed = await asUser('secretary@kaizen.co.in', () => plan(p.id));
    expect(refreshed.pool.available).toBe(50);
  });
});

describe('EQT-ESP-002 — first vesting earlier than twelve months after grant is refused (Rule 12)', () => {
  it('refuses a schedule whose cliff is under twelve months', async () => {
    const p = await newPlan('002');
    const emp = await makeEmployee('esp002');

    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', () =>
        proposeGrant({
          planId: p.id,
          employmentId: emp.employment.id,
          grantedOn: monthsAgo(0),
          count: 10,
          vestingOverride: { cliffMonths: 6, totalMonths: 24, frequency: 'quarterly' },
        }),
      ),
    );
    expect(err.message).toMatch(/Rule 12/);
  });

  it('also refuses a plan whose own default cliff is under twelve months', async () => {
    const pool = await asUser('secretary@kaizen.co.in', () => createShareClass({ name: `Bad Pool ${Date.now()}`, kind: 'equity', instrument: 'option', faceValue: 0, authorisedCount: 100 }));
    const err = await expectReject(() =>
      asUser('secretary@kaizen.co.in', () =>
        createPlan({
          name: `Bad Plan ${Date.now()}`,
          poolShareClassId: pool.id,
          targetShareClassId: TARGET_CLASS_ID,
          vestingDefault: { cliffMonths: 3, totalMonths: 12, frequency: 'monthly' },
        }),
      ),
    );
    expect(err.message).toMatch(/Rule 12/);
  });
});

describe('EQT-ESP-003 — a promoter or over-ten-percent holder is refused without DPIIT recognition and allowed with it', () => {
  it('refuses a grant to a >10% holder under a non-DPIIT plan, and allows it once the plan is DPIIT-recognised', async () => {
    const emp = await makeEmployee('esp003');

    // Give this person the overwhelming majority of the equity. The suite
    // shares one tenant with the register, rounds and filings tests, so the
    // stake is sized against whatever they have already allotted rather than
    // assumed to be the only equity in existence.
    const alreadyIssued = (await asUser('chairman@kaizen.co.in', () => capTable())).holderTotals
      .reduce((sum, h) => sum + h.totalCount, 0);
    const majorityCount = Math.max(900, Math.ceil(alreadyIssued * 20));
    const majorityHolder = await asUser('secretary@kaizen.co.in', () => createHolder({ kind: 'person', personId: emp.person.id, residency: 'resident' }));
    const minorityHolder = await asUser('secretary@kaizen.co.in', () =>
      createHolder({ kind: 'person', person: { fullName: `Minority ${Date.now()}`, email: `minority.${Date.now()}@example.test` }, residency: 'resident' }),
    );

    for (const [holderId, count] of [[majorityHolder.id, majorityCount], [minorityHolder.id, 100]] as const) {
      const proposed = await asUser('secretary@kaizen.co.in', () =>
        proposeAllotment({ shareClassId: TARGET_CLASS_ID, toHolderId: holderId, count, effectiveOn: new Date().toISOString() }),
      );
      await asUser('chairman@kaizen.co.in', () => approveShareTransaction(proposed.id));
      await asUser('chairman@kaizen.co.in', () => makeEffective(proposed.id));
    }

    const nonDpiit = await newPlan('003-non-dpiit', { dpiit: false, poolSize: 5 });
    const err = await expectReject(() =>
      asUser('hr@kaizen.co.in', () => proposeGrant({ planId: nonDpiit.id, employmentId: emp.employment.id, grantedOn: monthsAgo(0), count: 1, resolutionRef: 'SR-TEST' })),
    );
    expect(err.message).toMatch(/Rule 12\(1\)\(c\)/);

    const dpiit = await newPlan('003-dpiit', { dpiit: true, poolSize: 5 });
    const allowed = await asUser('hr@kaizen.co.in', () => proposeGrant({ planId: dpiit.id, employmentId: emp.employment.id, grantedOn: monthsAgo(0), count: 1, resolutionRef: 'SR-TEST' }));
    expect(allowed.promoterCheck.holdsOver10Pct).toBe(true);
    expect(allowed.promoterCheck.dpiitReliefApplied).toBe(true);
  });
});

describe('EQT-ESP-004 — the grantee and the proposer cannot approve the grant', () => {
  it('refuses the proposer, and refuses the grantee, before consulting the approval gate', async () => {
    const p = await newPlan('004');
    const emp = await makeEmployee('esp004');

    const proposed = await asUser('hr@kaizen.co.in', () =>
      proposeGrant({ planId: p.id, employmentId: emp.employment.id, grantedOn: monthsAgo(0), count: 10, resolutionRef: 'SR-TEST' }),
    );

    const byProposer = await expectReject(() => asUser('hr@kaizen.co.in', () => approveGrant(proposed.id)));
    expect(byProposer.message).toMatch(/Self-Dealing Bar/);

    const byGrantee = await expectReject(() => asEmployee(emp.person.id, () => approveGrant(proposed.id)));
    expect(byGrantee.status ?? 403).toBeDefined();

    const approved = await asUser('finance@kaizen.co.in', () => approveGrant(proposed.id));
    expect(approved.status).toBe('granted');
  });
});

describe('EQT-ESP-005 — the vesting job vests due tranches once and skips an ended employment', () => {
  it('vests a due tranche, is idempotent on a second run, and does not vest a terminated employment', async () => {
    const p = await newPlan('005');
    const active = await makeEmployee('esp005-active');
    const ending = await makeEmployee('esp005-ending');

    const grantA = await asUser('hr@kaizen.co.in', () =>
      proposeGrant({ planId: p.id, employmentId: active.employment.id, grantedOn: monthsAgo(13), count: 12, resolutionRef: 'SR-TEST' }),
    );
    await asUser('finance@kaizen.co.in', () => approveGrant(grantA.id));

    const grantB = await asUser('hr@kaizen.co.in', () =>
      proposeGrant({ planId: p.id, employmentId: ending.employment.id, grantedOn: monthsAgo(13), count: 12, resolutionRef: 'SR-TEST' }),
    );
    await asUser('finance@kaizen.co.in', () => approveGrant(grantB.id));

    // Suspended is required before a disciplinary termination (Diagram 14.1).
    await asUser('hr@kaizen.co.in', () => transitionEmployment(ending.employment.id, 'SUSPEND'));
    await asUser('hr@kaizen.co.in', () => transitionEmployment(ending.employment.id, 'TERMINATE_POST_DISCIPLINARY'));

    const firstRun = await asUser('finance@kaizen.co.in', () => runVesting());
    expect(firstRun).toBeGreaterThanOrEqual(1);

    const refreshedA = await asUser('finance@kaizen.co.in', () => grant(grantA.id));
    expect(refreshedA.vested).toBe(12);
    expect(['fully_vested']).toContain(refreshedA.status);

    const refreshedB = await asUser('finance@kaizen.co.in', () => grant(grantB.id));
    expect(refreshedB.vested).toBe(0);

    const secondRun = await asUser('finance@kaizen.co.in', () => runVesting());
    const refreshedA2 = await asUser('finance@kaizen.co.in', () => grant(grantA.id));
    expect(refreshedA2.vested).toBe(12);
    void secondRun;
  });
});

describe('EQT-ESP-006 — an exit lapses unvested options immediately and vested ones after the window', () => {
  it('lapses the unvested balance at exit, and the vested-unexercised balance once its window passes', async () => {
    const p = await newPlan('006');
    const emp = await makeEmployee('esp006');

    const g = await asUser('hr@kaizen.co.in', () =>
      proposeGrant({
        planId: p.id,
        employmentId: emp.employment.id,
        grantedOn: monthsAgo(13),
        count: 24,
        vestingOverride: { cliffMonths: 12, totalMonths: 24, frequency: 'annual' },
        resolutionRef: 'SR-TEST',
      }),
    );
    await asUser('finance@kaizen.co.in', () => approveGrant(g.id));
    await asUser('finance@kaizen.co.in', () => runVesting());

    const beforeExit = await asUser('finance@kaizen.co.in', () => grant(g.id));
    expect(beforeExit.vested).toBe(12);
    expect(beforeExit.lapsed).toBe(0);

    await asUser('hr@kaizen.co.in', async () => {
      await handleEmploymentExit(emp.employment.id, new Date());
    });

    const afterExit = await asUser('finance@kaizen.co.in', () => grant(g.id));
    expect(afterExit.lapsed).toBe(12); // the unvested tranche
    expect(afterExit.vested).toBe(12); // untouched
    expect(afterExit.exerciseWindowEndsOn).not.toBeNull();
    expect(afterExit.status).not.toBe('lapsed'); // a vested-unexercised balance remains outstanding

    // Force the window closed, as the daily job would find it later.
    await asUser('finance@kaizen.co.in', () =>
      scopedPrisma.optionGrant.update({ where: { id: g.id }, data: { exerciseWindowEndsOn: new Date(Date.now() - 86_400_000) } }),
    );
    const swept = await asUser('finance@kaizen.co.in', () => runExpiredExerciseWindows());
    expect(swept).toBeGreaterThanOrEqual(1);

    const afterWindow = await asUser('finance@kaizen.co.in', () => grant(g.id));
    expect(afterWindow.status).toBe('lapsed');
    expect(afterWindow.lapsed).toBe(24);
  });
});

describe('EQT-ESP-007 — exercise allots shares through the register at the exercise price and links the allotment', () => {
  it('allots the target class through makeEffective and links the transaction back onto the exercise', async () => {
    const p = await newPlan('007', { exercisePriceDefault: 15 });
    const emp = await makeEmployee('esp007');

    const g = await asUser('hr@kaizen.co.in', () =>
      proposeGrant({ planId: p.id, employmentId: emp.employment.id, grantedOn: monthsAgo(13), count: 10, resolutionRef: 'SR-TEST' }),
    );
    await asUser('finance@kaizen.co.in', () => approveGrant(g.id));
    await asUser('finance@kaizen.co.in', () => runVesting());

    const requested = await asEmployee(emp.person.id, () => requestExercise({ grantId: g.id, count: 4 }));
    expect(requested.status).toBe('requested');

    const approved = await asUser('finance@kaizen.co.in', () => approveExercise(requested.id));
    expect(approved.status).toBe('allotted');
    expect(approved.allotmentTransactionId).toBeTruthy();

    const { txn, holder, cert } = await asUser('finance@kaizen.co.in', async () => {
      const txn = await scopedPrisma.shareTransaction.findFirstOrThrow({ where: { id: approved.allotmentTransactionId! } });
      const holder = await scopedPrisma.holder.findFirstOrThrow({ where: { id: txn.toHolderId! } });
      const cert = await scopedPrisma.shareCertificate.findFirst({ where: { issuedForTransactionId: txn.id } });
      return { txn, holder, cert };
    });
    expect(txn.status).toBe('effective');
    expect(txn.type).toBe('allotment');
    expect(txn.shareClassId).toBe(p.targetShareClassId);
    expect(Number(txn.count)).toBe(4);
    expect(Number(txn.pricePerShare)).toBe(15);
    expect(holder.personId).toBe(emp.person.id);
    expect(cert).not.toBeNull();

    const refreshedGrant = await asUser('finance@kaizen.co.in', () => grant(g.id));
    expect(refreshedGrant.exercised).toBe(4);
  });
});

describe('EQT-ESP-008 — the perquisite is computed only from a merchant-banker valuation within 180 days, else stated as not available', () => {
  it('withholds the perquisite with no valuation, computes it from a fresh one, and withholds it again once stale', async () => {
    const p = await newPlan('008', { exercisePriceDefault: 20 });
    const emp = await makeEmployee('esp008');

    const g = await asUser('hr@kaizen.co.in', () =>
      proposeGrant({ planId: p.id, employmentId: emp.employment.id, grantedOn: monthsAgo(13), count: 10, resolutionRef: 'SR-TEST' }),
    );
    await asUser('finance@kaizen.co.in', () => approveGrant(g.id));
    await asUser('finance@kaizen.co.in', () => runVesting());

    const withoutFmv = await asEmployee(emp.person.id, () => requestExercise({ grantId: g.id, count: 1 }));
    expect(withoutFmv.fmvBasis).toBe('none');
    expect(withoutFmv.perquisite).toBeNull();
    expect(withoutFmv.perquisiteNote).toMatch(/No merchant-banker FMV on record/);

    await asUser('finance@kaizen.co.in', () =>
      recordValuation({ asOf: new Date().toISOString(), basis: 'merchant_banker', perShareByClass: { [p.targetShareClassId]: 50 } }),
    );

    const withFmv = await asEmployee(emp.person.id, () => requestExercise({ grantId: g.id, count: 1 }));
    expect(withFmv.fmvBasis).toBe('merchant_banker');
    expect(withFmv.fmvPerShare).toBe(50);
    expect(withFmv.perquisite).toBe((50 - 20) * 1);

    // A valuation older than 180 days does not count.
    const stale = await asUser('finance@kaizen.co.in', () =>
      recordValuation({ asOf: new Date(Date.now() - 10 * 86_400_000).toISOString(), basis: 'merchant_banker', perShareByClass: { [p.targetShareClassId]: 999 } }),
    );
    const backdated = new Date(Date.now() - 200 * 86_400_000);
    await asUser('finance@kaizen.co.in', async () => {
      await scopedPrisma.valuation.update({ where: { id: stale.id }, data: { asOf: backdated } });
      await scopedPrisma.valuation.update({ where: { id: withFmv.fmvValuationId! }, data: { asOf: backdated } });
    });

    const afterStale = await asEmployee(emp.person.id, () => requestExercise({ grantId: g.id, count: 1 }));
    expect(afterStale.fmvBasis).toBe('none');
    expect(afterStale.perquisite).toBeNull();
  });
});

describe('EQT-ESP-009 — the SH-6 register lists every grant in form order and the export downloads', () => {
  it('lists grants oldest-first with the SH-6 columns, and exports the same rows as an .xlsx', async () => {
    const p = await newPlan('009');
    const empA = await makeEmployee('esp009-a');
    const empB = await makeEmployee('esp009-b');

    const gA = await asUser('hr@kaizen.co.in', () => proposeGrant({ planId: p.id, employmentId: empA.employment.id, grantedOn: monthsAgo(20), count: 10, resolutionRef: 'SR-TEST' }));
    const gB = await asUser('hr@kaizen.co.in', () => proposeGrant({ planId: p.id, employmentId: empB.employment.id, grantedOn: monthsAgo(5), count: 8, resolutionRef: 'SR-TEST' }));

    const rows = await asUser('secretary@kaizen.co.in', () => sh6Register());
    const idxA = rows.findIndex((r) => r.grantId === gA.id);
    const idxB = rows.findIndex((r) => r.grantId === gB.id);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB); // the older grant comes first

    const rowA = rows[idxA];
    expect(rowA.optionsGranted).toBe(10);
    expect(rowA.exercisePrice).toBeGreaterThan(0);
    expect(Array.isArray(rowA.vestingDates)).toBe(true);

    const buffer = await asUser('secretary@kaizen.co.in', () => sh6Export());
    const book = XLSX.read(buffer, { type: 'buffer' });
    expect(book.SheetNames).toContain('SH-6');
    const sheet = XLSX.utils.sheet_to_json(book.Sheets['SH-6'], { header: 1 }) as unknown[][];
    // Header row plus one row per grant on record for this tenant.
    expect(sheet.length).toBe(rows.length + 1);
  });
});

describe('EQT-ESP-010 — an employee sees only their own grants', () => {
  it('myGrants() returns only the calling employee\'s own grants, with the plain-words tax line', async () => {
    const p = await newPlan('010');
    const empA = await makeEmployee('esp010-a');
    const empB = await makeEmployee('esp010-b');

    await asUser('hr@kaizen.co.in', () => proposeGrant({ planId: p.id, employmentId: empA.employment.id, grantedOn: monthsAgo(13), count: 5, resolutionRef: 'SR-TEST' }));
    await asUser('hr@kaizen.co.in', () => proposeGrant({ planId: p.id, employmentId: empB.employment.id, grantedOn: monthsAgo(13), count: 5, resolutionRef: 'SR-TEST' }));

    const mineA = await asEmployee(empA.person.id, () => myGrants());
    expect(mineA.length).toBeGreaterThanOrEqual(1);
    expect(mineA.every((g) => g.personId === empA.person.id)).toBe(true);
    expect(mineA[0].taxLine).toMatch(/tax figure cannot be shown yet|taxed as salary|deferred under section 192/);

    const mineB = await asEmployee(empB.person.id, () => myGrants());
    expect(mineB.every((g) => g.personId === empB.person.id)).toBe(true);
    expect(mineA.some((g) => empB.person.id === g.personId)).toBe(false);

    // The list endpoint's own scope narrows the same way.
    const listedA = await asEmployee(empA.person.id, () => listGrants());
    expect(listedA.every((g) => g.personId === empA.person.id)).toBe(true);
  });
});

describe('lapseGrant and cancelGrant — the secretary\'s manual paths', () => {
  it('cancelGrant refuses once any tranche has vested, and lapseGrant is available regardless', async () => {
    const p = await newPlan('cancel-lapse');
    const emp = await makeEmployee('esp-cancel');

    const g = await asUser('hr@kaizen.co.in', () => proposeGrant({ planId: p.id, employmentId: emp.employment.id, grantedOn: monthsAgo(0), count: 10, resolutionRef: 'SR-TEST' }));
    const cancelled = await asUser('secretary@kaizen.co.in', () => cancelGrant(g.id, 'Made in error'));
    expect(cancelled.status).toBe('cancelled');

    const g2 = await asUser('hr@kaizen.co.in', () => proposeGrant({ planId: p.id, employmentId: emp.employment.id, grantedOn: monthsAgo(13), count: 10, resolutionRef: 'SR-TEST' }));
    await asUser('finance@kaizen.co.in', () => approveGrant(g2.id));
    await asUser('finance@kaizen.co.in', () => runVesting());
    await expectReject(() => asUser('secretary@kaizen.co.in', () => cancelGrant(g2.id, 'Too late')));

    const lapsed = await asUser('secretary@kaizen.co.in', () => lapseGrant(g2.id, 'Performance conditions unmet'));
    expect(lapsed.status).toBe('lapsed');
  });
});

describe('rejectExercise', () => {
  it('a finance head can reject a requested exercise', async () => {
    const p = await newPlan('reject');
    const emp = await makeEmployee('esp-reject');
    const g = await asUser('hr@kaizen.co.in', () => proposeGrant({ planId: p.id, employmentId: emp.employment.id, grantedOn: monthsAgo(13), count: 10, resolutionRef: 'SR-TEST' }));
    await asUser('finance@kaizen.co.in', () => approveGrant(g.id));
    await asUser('finance@kaizen.co.in', () => runVesting());
    const requested = await asEmployee(emp.person.id, () => requestExercise({ grantId: g.id, count: 2 }));
    const rejected = await asUser('finance@kaizen.co.in', () => rejectExercise(requested.id, 'Not this quarter'));
    expect(rejected.status).toBe('rejected');
  });
});

describe('listPlans', () => {
  it('lists every plan with its pool figures for the register keeper', async () => {
    await newPlan('list');
    const rows = await asUser('secretary@kaizen.co.in', () => listPlans());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].pool).toBeDefined();
  });
});
