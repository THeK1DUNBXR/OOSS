/**
 * Phase 6a of the equity portal — statutory exports, demat and FEMA.
 *
 * Requirements named `EQT-FIL-*`, per the phase-6a brief in
 * `docs/plan/equity-portal.md` §6.
 *
 * Runs inside its own subsidiary tenant, created once in `beforeAll` — a
 * subsidiary rather than a standalone tenant on purpose: EQT-FIL-004 needs
 * `Tenant.kind` to already be `subsidiary` the moment `checkDematRequirements`
 * first runs, which `seedBootstrap({ parentTenantSlug })` gives for free via
 * `reconcileTenantKinds` at the end of bootstrap.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  createShareClass, createHolder, proposeAllotment, proposeTransfer,
  approveShareTransaction, makeEffective, recordValuation,
} from '../domains/equity.js';
import { createRound } from '../domains/rounds.js';
import {
  mgt1Register, mgt1Export, pas3AllotteeList, pas3Export, sh4Data, pas6,
  recordFiling, listFilings, checkDematRequirements, runPas6HalfYearly, runFlaReturn,
} from '../domains/filings.js';
import { updateCompanyProfile } from '../domains/companyProfile.js';
import { updateHolder } from '../domains/equity.js';
import { seedBootstrap } from '../seed/bootstrap.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { asPrincipal, authFor, expectReject, type TestPrincipal, unscopedPrisma, prisma as scopedPrisma } from './helpers.js';

let SUB: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

async function principalInTenant(tid: string, email: string): Promise<TestPrincipal> {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { tenantId: tid, email } });
  const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
    where: { partyId: user.personId, tenantId: tid, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return {
    tenantId: tid,
    partyId: user.personId,
    userId: user.id,
    affiliationId: affiliation.id,
    roleSlug: affiliation.roleSlug ?? 'chairman',
    branch: user.branch,
  };
}

async function as<T>(email: 'chairman@kaizen.co.in' | 'finance@kaizen.co.in', fn: () => Promise<T>): Promise<T> {
  const p = await principalInTenant(SUB, email);
  return asPrincipal(authFor(p), fn);
}

async function newHolder(
  label: string,
  opts: { residency?: 'resident' | 'non_resident'; investmentBasis?: 'repatriable' | 'non_repatriable' | null; dematAccount?: Record<string, unknown> | null } = {},
) {
  return as('chairman@kaizen.co.in', async () => {
    const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${suffix}@example.test`;
    const person = await scopedPrisma.person.create({
      data: { tenantId: SUB, recordCode: await nextRecordCode('PER'), fullName: label, primaryEmail: email, primaryEmailNormalised: email, source: 'test' },
    });
    return createHolder({
      kind: 'person',
      personId: person.id,
      residency: opts.residency ?? 'resident',
      investmentBasis: opts.investmentBasis ?? null,
      dematAccount: opts.dematAccount ?? null,
    });
  });
}

async function newClass(name: string, kind: 'equity' | 'preference' | 'debenture' = 'equity', instrument: string = 'equity', faceValue = 10) {
  return as('chairman@kaizen.co.in', () =>
    createShareClass({ name: `${name}-${suffix}`, kind, instrument: instrument as never, faceValue }),
  );
}

/** Proposes (chairman) → approves (finance) → makes effective (finance) an ordinary allotment. */
async function allot(
  shareClassId: string,
  toHolderId: string,
  count: number,
  opts: { pricePerShare?: number | null; effectiveOn?: string; roundId?: string | null } = {},
) {
  const proposed = await as('chairman@kaizen.co.in', () =>
    proposeAllotment({
      shareClassId,
      toHolderId,
      count,
      pricePerShare: opts.pricePerShare ?? null,
      effectiveOn: opts.effectiveOn ?? new Date().toISOString(),
      roundId: opts.roundId ?? null,
    }),
  );
  await as('finance@kaizen.co.in', () => approveShareTransaction(proposed.id));
  return as('finance@kaizen.co.in', () => makeEffective(proposed.id));
}

async function transfer(shareClassId: string, fromHolderId: string, toHolderId: string, count: number, pricePerShare?: number | null) {
  const proposed = await as('chairman@kaizen.co.in', () =>
    proposeTransfer({ shareClassId, fromHolderId, toHolderId, count, pricePerShare: pricePerShare ?? null, effectiveOn: new Date().toISOString() }),
  );
  await as('finance@kaizen.co.in', () => approveShareTransaction(proposed.id));
  return as('finance@kaizen.co.in', () => makeEffective(proposed.id));
}

beforeAll(async () => {
  const slug = `eqt-fil-${suffix}`;
  const { tenantId } = await seedBootstrap({ tenantSlug: slug, tenantName: 'EQT Phase 6a Sub', parentTenantSlug: 'kaizen' });
  SUB = tenantId;

  await as('chairman@kaizen.co.in', () =>
    updateCompanyProfile({
      certificateSignatories: [
        { name: 'A. Director', designation: 'Director' },
        { name: 'B. Secretary', designation: 'Company Secretary' },
      ],
    }),
  );
});

describe('EQT-FIL-001 — the MGT-1 export lists every member per class in statutory column order with blanks where nothing is recorded', () => {
  it('a fully-recorded holder shows every field; a bare one shows blanks, not guesses', async () => {
    const cls = await newClass('Equity-001');
    const full = await newHolder('Full Holder 001');
    await as('chairman@kaizen.co.in', () =>
      updateHolder(full.id, {
        address: '1 MG Road, Bengaluru', occupation: 'Director', nationality: 'Indian', guardianOrSpouseName: 'A. Guardian', panNumber: 'ABCDE1234F',
      }),
    );
    const bare = await newHolder('Bare Holder 001');

    await allot(cls.id, full.id, 100);
    await allot(cls.id, bare.id, 50);

    const groups = await as('chairman@kaizen.co.in', () => mgt1Register(cls.id));
    expect(groups).toHaveLength(1);
    const rows = groups[0].rows;
    expect(rows.map((r) => Object.keys(r))).toEqual(
      rows.map(() => [
        'folioNumber', 'holderName', 'address', 'email', 'panOrCin', 'guardianOrSpouseName', 'occupation',
        'nationality', 'becameMemberOn', 'ceasedOn', 'distinctiveNumbers', 'certificateNumbers',
        'nominalValue', 'amountPaidUp', 'lockIn', 'remarks',
      ]),
    );

    const fullRow = rows.find((r) => r.holderName === 'Full Holder 001')!;
    expect(fullRow.address).toBe('1 MG Road, Bengaluru');
    expect(fullRow.occupation).toBe('Director');
    expect(fullRow.panOrCin).toBe('ABCDE1234F');
    expect(fullRow.nominalValue).toBe(1000);
    expect(fullRow.certificateNumbers).not.toBe('');

    const bareRow = rows.find((r) => r.holderName === 'Bare Holder 001')!;
    expect(bareRow.address).toBe('');
    expect(bareRow.occupation).toBe('');
    expect(bareRow.guardianOrSpouseName).toBe('');
    expect(bareRow.lockIn).toBe('');
    expect(bareRow.remarks).toBe('');

    const file = await as('chairman@kaizen.co.in', () => mgt1Export(cls.id));
    expect(file.length).toBeGreaterThan(0);
  });
});

let roundLinkedTxnId: string;

describe('EQT-FIL-002 — the PAS-3 allottee list covers exactly the round\'s effective allotments', () => {
  it('an allotment struck under the round appears; one struck outside it does not', async () => {
    const cls = await newClass('Equity-002');
    const round = await as('chairman@kaizen.co.in', () => createRound({ name: `Seed-002-${suffix}`, kind: 'seed' }));

    const inRoundHolder = await newHolder('In Round 002');
    const outOfRoundHolder = await newHolder('Out Of Round 002');

    const inRound = await allot(cls.id, inRoundHolder.id, 200, { pricePerShare: 15, roundId: round.id });
    roundLinkedTxnId = inRound.id;
    await allot(cls.id, outOfRoundHolder.id, 75, { pricePerShare: 15 });

    const { rows } = await as('chairman@kaizen.co.in', () => pas3AllotteeList(round.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].holderName).toBe('In Round 002');
    expect(rows[0].count).toBe(200);
    expect(rows[0].nominalValue).toBe(2000);
    expect(rows[0].total).toBe(3000);

    const file = await as('chairman@kaizen.co.in', () => pas3Export(round.id));
    expect(file.length).toBeGreaterThan(0);
  });
});

describe('EQT-FIL-003 — SH-4 data computes 0.015 percent stamp duty for demat and states the physical rate is not recorded', () => {
  it('a demat-to-demat transfer prices the duty; a physical one names the gap', async () => {
    const cls = await newClass('Equity-003');

    const dematFrom = await newHolder('Demat From 003', { dematAccount: { dpId: 'DP1', clientId: 'C1' } });
    const dematTo = await newHolder('Demat To 003', { dematAccount: { dpId: 'DP2', clientId: 'C2' } });
    await allot(cls.id, dematFrom.id, 1000, { pricePerShare: 20 });
    const dematTxn = await transfer(cls.id, dematFrom.id, dematTo.id, 300, 20);

    const dematData = await as('chairman@kaizen.co.in', () => sh4Data(dematTxn.id));
    expect(dematData.dematLeg).toBe(true);
    expect(dematData.consideration).toBe(6000);
    expect(dematData.stampDuty).toBeCloseTo(0.9, 5);
    expect(dematData.stampDutyNote).toBeNull();

    const physFrom = await newHolder('Physical From 003');
    const physTo = await newHolder('Physical To 003');
    await allot(cls.id, physFrom.id, 1000, { pricePerShare: 20 });
    const physTxn = await transfer(cls.id, physFrom.id, physTo.id, 300, 20);

    const physData = await as('chairman@kaizen.co.in', () => sh4Data(physTxn.id));
    expect(physData.dematLeg).toBe(false);
    expect(physData.stampDuty).toBeNull();
    expect(physData.stampDutyNote).toBe('State stamp rate not recorded');
  });
});

describe('EQT-FIL-004 — becoming a holding or subsidiary raises the demat-required item once for a physical register', () => {
  it('runs twice and raises exactly one open EX-EQT-004', async () => {
    const before = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: SUB, code: 'EX-EQT-004' } });
    expect(before).toHaveLength(0);

    await as('chairman@kaizen.co.in', () => checkDematRequirements());
    await as('chairman@kaizen.co.in', () => checkDematRequirements());

    const after = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: SUB, code: 'EX-EQT-004' } });
    expect(after).toHaveLength(1);
    expect(after[0].detail).toMatch(/Rule 9B/);
  });
});

describe('EQT-FIL-005 — a fully demat company refuses an allotment to a holder without a demat account (Rule 9B)', () => {
  it('refuses with no demat account, allows once one is on record', async () => {
    await as('chairman@kaizen.co.in', () => updateCompanyProfile({ dematStatus: 'demat' }));

    const cls = await newClass('Equity-005');
    const bare = await newHolder('No Demat Account 005');

    const rejection = await expectReject(() =>
      as('chairman@kaizen.co.in', () => proposeAllotment({ shareClassId: cls.id, toHolderId: bare.id, count: 10, effectiveOn: new Date().toISOString() })),
    );
    expect(rejection.status).toBe(422);
    expect(rejection.message).toMatch(/Rule 9B/);

    const withAccount = await newHolder('Has Demat Account 005', { dematAccount: { dpId: 'DP9', clientId: 'C9' } });
    const effective = await allot(cls.id, withAccount.id, 10);
    expect(effective.status).toBe('effective');

    // `mixed` for the rest of the suite — Rule 9B's fully-demat refusal
    // applies to `demat` only, and EQT-FIL-006's PAS-6 job wants demat or
    // mixed, so this is the state every later test in this file runs under.
    await as('chairman@kaizen.co.in', () => updateCompanyProfile({ dematStatus: 'mixed', isin: `INE${suffix.replace(/\D/g, '').padStart(9, '0').slice(0, 9)}` }));
  });
});

describe('EQT-FIL-006 — the PAS-6 item is raised once per half-year and the figures reconcile issued against demat and physical', () => {
  it('runs twice, raises once, and every class balances', async () => {
    const before = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: SUB, code: 'EX-EQT-010' } });
    expect(before).toHaveLength(0);

    await as('chairman@kaizen.co.in', () => runPas6HalfYearly());
    await as('chairman@kaizen.co.in', () => runPas6HalfYearly());

    const after = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: SUB, code: 'EX-EQT-010' } });
    expect(after).toHaveLength(1);

    const figures = await as('chairman@kaizen.co.in', () => pas6());
    expect(figures.classes.length).toBeGreaterThan(0);
    for (const c of figures.classes) {
      expect(c.dematCount + c.physicalCount).toBe(c.issuedCount);
      expect(c.difference).toBe(0);
    }
  });
});

let repatriableHolderId: string;
let fcGprTxnId: string;

describe('EQT-FIL-007 — an allotment to a repatriable non-resident raises FC-GPR at thirty days and a non-repatriable one raises nothing', () => {
  it('repatriable raises EX-EQT-006; non-repatriable raises nothing', async () => {
    const cls = await newClass('Equity-007');
    const repatriable = await newHolder('Repatriable NRI 007', { residency: 'non_resident', investmentBasis: 'repatriable', dematAccount: { dpId: 'DPX', clientId: 'CX' } });
    repatriableHolderId = repatriable.id;
    const nonRepatriable = await newHolder('Non-Repatriable NRI 007', { residency: 'non_resident', investmentBasis: 'non_repatriable', dematAccount: { dpId: 'DPY', clientId: 'CY' } });

    const repatriableTxn = await allot(cls.id, repatriable.id, 100);
    fcGprTxnId = repatriableTxn.id;
    const nonRepatriableTxn = await allot(cls.id, nonRepatriable.id, 100);

    const repatriableException = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: SUB, code: 'EX-EQT-006', subjectId: repatriableTxn.id },
    });
    expect(repatriableException).toBeTruthy();
    const expectedDue = new Date(repatriableTxn.effectiveOn!).getTime() + 30 * 86_400_000;
    expect(Math.abs(repatriableException!.slaDueAt!.getTime() - expectedDue)).toBeLessThan(60_000);

    const nonRepatriableException = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: SUB, code: 'EX-EQT-006', subjectId: nonRepatriableTxn.id },
    });
    expect(nonRepatriableException).toBeNull();
  });
});

describe('EQT-FIL-008 — a transfer between a repatriable non-resident and a resident raises FC-TRS at sixty days', () => {
  it('raises EX-EQT-007 on the transfer', async () => {
    const cls = await newClass('Equity-008');
    const repatriable = await newHolder('Repatriable NRI 008', { residency: 'non_resident', investmentBasis: 'repatriable', dematAccount: { dpId: 'DPZ', clientId: 'CZ' } });
    const resident = await newHolder('Resident 008', { dematAccount: { dpId: 'DPW', clientId: 'CW' } });

    await allot(cls.id, repatriable.id, 500);
    const txn = await transfer(cls.id, repatriable.id, resident.id, 200);

    const exception = await unscopedPrisma.exceptionRecord.findFirst({ where: { tenantId: SUB, code: 'EX-EQT-007', subjectId: txn.id } });
    expect(exception).toBeTruthy();
    const expectedDue = new Date(txn.effectiveOn!).getTime() + 60 * 86_400_000;
    expect(Math.abs(exception!.slaDueAt!.getTime() - expectedDue)).toBeLessThan(60_000);
  });
});

describe('EQT-FIL-009 — a price below the fair-value certificate is refused for a non-resident and allowed with a note when none is on record', () => {
  it('no certificate: allowed with a note and EX-EQT-009 once; a certificate on record enforces the floor', async () => {
    const cls = await newClass('Equity-009');
    const holder = await newHolder('Pricing NRI 009', { residency: 'non_resident', investmentBasis: 'repatriable', dematAccount: { dpId: 'DPP', clientId: 'CPP' } });

    const noCert = await as('chairman@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: cls.id, toHolderId: holder.id, count: 10, pricePerShare: 5, effectiveOn: new Date().toISOString() }),
    );
    expect(noCert.femaPricingNote).toBe('No fair-value certificate on record');

    const missingCertException = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: SUB, code: 'EX-EQT-009', subjectId: holder.id },
    });
    expect(missingCertException).toBeTruthy();

    await as('chairman@kaizen.co.in', () =>
      recordValuation({ asOf: new Date(Date.now() - 86_400_000).toISOString(), basis: 'registered_valuer', perShareByClass: { [cls.id]: 50 } }),
    );

    const below = await expectReject(() =>
      as('chairman@kaizen.co.in', () =>
        proposeAllotment({ shareClassId: cls.id, toHolderId: holder.id, count: 10, pricePerShare: 40, effectiveOn: new Date().toISOString() }),
      ),
    );
    expect(below.status).toBe(422);
    expect(below.message).toMatch(/FEMA pricing/);

    const atFloor = await as('chairman@kaizen.co.in', () =>
      proposeAllotment({ shareClassId: cls.id, toHolderId: holder.id, count: 10, pricePerShare: 60, effectiveOn: new Date().toISOString() }),
    );
    expect(atFloor.femaPricingNote).toBeNull();
  });
});

describe('EQT-FIL-010 — recording the filing closes the item and the FLA item is raised yearly while the holding exists', () => {
  it('records FC-GPR against EQT-FIL-007\'s allotment, and the FLA sweep raises once for the holding on record', async () => {
    const openBefore = await unscopedPrisma.exceptionRecord.findFirst({ where: { tenantId: SUB, code: 'EX-EQT-006', subjectId: fcGprTxnId } });
    expect(openBefore?.state).not.toBe('resolved');

    await as('chairman@kaizen.co.in', () =>
      recordFiling({
        form: 'FC-GPR', relatedType: 'share_transaction', relatedId: fcGprTxnId,
        periodOrEvent: `Allotment ${fcGprTxnId}`, srn: `SRN-${suffix}`, filedOn: new Date().toISOString(), status: 'filed',
      }),
    );

    const closed = await unscopedPrisma.exceptionRecord.findFirst({ where: { tenantId: SUB, code: 'EX-EQT-006', subjectId: fcGprTxnId } });
    expect(closed?.state).toBe('resolved');

    const filings = await as('chairman@kaizen.co.in', () => listFilings('FC-GPR'));
    expect(filings.some((f) => f.relatedId === fcGprTxnId && f.status === 'filed')).toBe(true);

    // A repatriable non-resident holding dated well before 31 March, so it
    // exists on that cutoff regardless of when this suite happens to run.
    const cls = await newClass('Equity-010-FLA');
    const flaHolder = await newHolder('FLA Holder 010', { residency: 'non_resident', investmentBasis: 'repatriable', dematAccount: { dpId: 'DPF', clientId: 'CF' } });
    await allot(cls.id, flaHolder.id, 40, { effectiveOn: '2020-06-01T00:00:00.000Z' });

    const beforeFla = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: SUB, code: 'EX-EQT-008', subjectId: flaHolder.id } });
    expect(beforeFla).toHaveLength(0);

    await as('chairman@kaizen.co.in', () => runFlaReturn());
    await as('chairman@kaizen.co.in', () => runFlaReturn());

    const afterFla = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: SUB, code: 'EX-EQT-008', subjectId: flaHolder.id } });
    expect(afterFla).toHaveLength(1);
  });
});
