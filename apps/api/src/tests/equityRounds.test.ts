/**
 * Phase 4 of the equity portal — rounds, instruments, valuations, scenarios.
 *
 * Requirements named `EQT-RND-*`, per the phase-4 brief in
 * `docs/plan/equity-portal.md` §6.
 *
 * Runs inside its own subsidiary tenant, created once in `beforeAll` — the
 * books and the round calendar (free reserves, the s.42 200-offeree count,
 * the PAS-3 clock) have to be state this file controls completely, not state
 * left over by whichever other suite happened to run first in the same
 * process (`vitest.config.ts` runs every file serially against one database).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { modelRound, waterfall, type ScenarioCapTableRow } from '@kaizen/shared';
import { createShareClass, createHolder, proposeAllotment, approveShareTransaction, makeEffective, effectiveBalance, recordValuation } from '../domains/equity.js';
import {
  createRound, updateRound, openRound, closeRound,
  proposeConversion, proposeBuyback, freeReservesProxy,
  scenarioRound, scenarioWaterfall,
} from '../domains/rounds.js';
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

/** Runs `fn` as one of this file's own tenant's founding accounts. */
async function as<T>(email: 'chairman@kaizen.co.in' | 'finance@kaizen.co.in', fn: () => Promise<T>): Promise<T> {
  const p = await principalInTenant(SUB, email);
  return asPrincipal(authFor(p), fn);
}

async function newHolder(label: string) {
  return as('chairman@kaizen.co.in', async () => {
    const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${suffix}@example.test`;
    const person = await scopedPrisma.person.create({
      data: { tenantId: SUB, recordCode: await nextRecordCode('PER'), fullName: label, primaryEmail: email, primaryEmailNormalised: email, source: 'test' },
    });
    return createHolder({ kind: 'person', personId: person.id, residency: 'resident' });
  });
}

async function newClass(name: string, kind: 'equity' | 'preference', instrument: string, faceValue = 10, conversionTerms?: Record<string, unknown>) {
  return as('chairman@kaizen.co.in', () =>
    createShareClass({ name: `${name}-${suffix}`, kind, instrument: instrument as never, faceValue, conversionTerms: conversionTerms ?? null }),
  );
}

/** Proposes (chairman) → approves (finance) → makes effective (finance) an ordinary allotment. */
async function allot(shareClassId: string, toHolderId: string, count: number, pricePerShare?: number) {
  const proposed = await as('chairman@kaizen.co.in', () =>
    proposeAllotment({ shareClassId, toHolderId, count, pricePerShare: pricePerShare ?? null, effectiveOn: new Date().toISOString() }),
  );
  await as('finance@kaizen.co.in', () => approveShareTransaction(proposed.id));
  return as('finance@kaizen.co.in', () => makeEffective(proposed.id));
}

async function registeredValuerValuation(asOf: Date) {
  return as('chairman@kaizen.co.in', () =>
    recordValuation({ asOf: asOf.toISOString(), basis: 'registered_valuer', perShareByClass: {}, valuerName: 'Test Valuer LLP' }),
  );
}

beforeAll(async () => {
  const slug = `eqt-rnd-${suffix}`;
  const { tenantId } = await seedBootstrap({ tenantSlug: slug, tenantName: 'EQT Phase 4 Sub', parentTenantSlug: 'kaizen' });
  SUB = tenantId;

  await as('chairman@kaizen.co.in', async () => {
    const { updateCompanyProfile } = await import('../domains/companyProfile.js');
    await updateCompanyProfile({
      certificateSignatories: [
        { name: 'A. Director', designation: 'Director' },
        { name: 'B. Secretary', designation: 'Company Secretary' },
      ],
    });
  });
});

describe('EQT-RND-001 — a preferential round cannot open without a registered valuer\'s report dated before opening', () => {
  it('refuses with no valuation, refuses with the wrong basis, refuses with a future report, and opens with a past registered-valuer report', async () => {
    const r = await as('chairman@kaizen.co.in', () => createRound({ name: `Preferential-${suffix}`, kind: 'preferential' }));

    const noValuation = await expectReject(() => as('chairman@kaizen.co.in', () => openRound(r.id)));
    expect(noValuation.status).toBe(422);

    const internalValuation = await as('chairman@kaizen.co.in', () =>
      recordValuation({ asOf: new Date(Date.now() - 86_400_000).toISOString(), basis: 'internal', perShareByClass: {} }),
    );
    await as('chairman@kaizen.co.in', () => updateRound(r.id, { valuationId: internalValuation.id }));
    const wrongBasis = await expectReject(() => as('chairman@kaizen.co.in', () => openRound(r.id)));
    expect(wrongBasis.status).toBe(422);
    expect(wrongBasis.message).toMatch(/registered_valuer/);

    const futureValuation = await registeredValuerValuation(new Date(Date.now() + 30 * 86_400_000));
    await as('chairman@kaizen.co.in', () => updateRound(r.id, { valuationId: futureValuation.id }));
    const future = await expectReject(() => as('chairman@kaizen.co.in', () => openRound(r.id)));
    expect(future.status).toBe(422);

    const pastValuation = await registeredValuerValuation(new Date(Date.now() - 7 * 86_400_000));
    await as('chairman@kaizen.co.in', () => updateRound(r.id, { valuationId: pastValuation.id }));
    const opened = await as('chairman@kaizen.co.in', () => openRound(r.id));
    expect(opened.status).toBe('open');
  });
});

let privateRoundA: Awaited<ReturnType<typeof createRound>>;

describe('EQT-RND-002 — a private placement refuses the 201st offeree in a financial year', () => {
  it('200 across two rounds in the same year opens; 201 is refused', async () => {
    const valuation = await registeredValuerValuation(new Date(Date.now() - 7 * 86_400_000));

    privateRoundA = await as('chairman@kaizen.co.in', () =>
      createRound({
        name: `PP-A-${suffix}`,
        kind: 'private_placement',
        valuationId: valuation.id,
        offerLetterSerial: `PAS4-A-${suffix}`,
        separateBankAccountRef: `ACC-A-${suffix}`,
        offereeCount: 150,
      }),
    );
    const openedA = await as('chairman@kaizen.co.in', () => openRound(privateRoundA.id));
    expect(openedA.status).toBe('open');

    const roundB = await as('chairman@kaizen.co.in', () =>
      createRound({
        name: `PP-B-${suffix}`,
        kind: 'private_placement',
        valuationId: valuation.id,
        offerLetterSerial: `PAS4-B-${suffix}`,
        separateBankAccountRef: `ACC-B-${suffix}`,
        offereeCount: 51,
      }),
    );
    const over = await expectReject(() => as('chairman@kaizen.co.in', () => openRound(roundB.id)));
    expect(over.status).toBe(422);
    expect(over.message).toMatch(/200/);

    await as('chairman@kaizen.co.in', () => updateRound(roundB.id, { offereeCount: 50 }));
    const openedB = await as('chairman@kaizen.co.in', () => openRound(roundB.id));
    expect(openedB.status).toBe('open');
  });
});

describe('EQT-RND-003 — a conversion retires the convertible holding and allots the target class at the ratio', () => {
  it('a 1:2 conversion cancels the source holding and allots double in the target class', async () => {
    const equityClass = await newClass('Equity-003', 'equity', 'equity', 10);
    const ccpsClass = await newClass('CCPS-003', 'preference', 'ccps', 10, {
      convertsToClassId: equityClass.id,
      ratio: 2,
      atOptionOf: 'holder',
    });
    const holder = await newHolder('Rnd003 Holder');

    await allot(ccpsClass.id, holder.id, 100);
    expect(await as('chairman@kaizen.co.in', () => effectiveBalance(holder.id, ccpsClass.id))).toBe(100);

    const proposed = await as('chairman@kaizen.co.in', () =>
      proposeConversion({ holderId: holder.id, fromClassId: ccpsClass.id, count: 100, effectiveOn: new Date().toISOString() }),
    );
    await as('finance@kaizen.co.in', () => approveShareTransaction(proposed.id));
    const effective = await as('finance@kaizen.co.in', () => makeEffective(proposed.id));
    expect(effective.status).toBe('effective');

    expect(await as('chairman@kaizen.co.in', () => effectiveBalance(holder.id, ccpsClass.id))).toBe(0);
    expect(await as('chairman@kaizen.co.in', () => effectiveBalance(holder.id, equityClass.id))).toBe(200);
  });
});

describe('EQT-RND-004 — a bonus issue refuses when free reserves are not measured', () => {
  it('no transaction has ever been recorded in these books, so free reserves are not measured, and a bonus round refuses to open', async () => {
    const reserves = await as('chairman@kaizen.co.in', () => freeReservesProxy());
    expect(reserves.measured).toBe(false);

    const bonusRound = await as('chairman@kaizen.co.in', () =>
      createRound({ name: `Bonus-004-${suffix}`, kind: 'bonus', sourceOfBonus: 'free_reserves' }),
    );
    const rejection = await expectReject(() => as('chairman@kaizen.co.in', () => openRound(bonusRound.id)));
    expect(rejection.status).toBe(422);
    expect(rejection.message).toMatch(/not measured|cannot be computed/i);

    // proposeBonus refuses the same way even if a caller tried to skip
    // `openRound`'s check by proposing under an already-open round of a
    // different kind is not possible (requireOpenRoundOfKind refuses), so
    // this is the whole surface of the refusal.
  });
});

describe('EQT-RND-005 — a buy-back beyond ten percent needs a special resolution and the debt-equity test refuses at 2:1', () => {
  it('above the board ceiling with no special resolution is refused, and heavy debt refuses even a small buy-back', async () => {
    const equityClass = await newClass('Equity-005', 'equity', 'equity', 10);
    const holder = await newHolder('Rnd005 Holder');
    await allot(equityClass.id, holder.id, 1000, 10); // paid-up capital: 10,000

    // Free reserves become measured: one income transaction in these books.
    await as('chairman@kaizen.co.in', async () => {
      const account = await scopedPrisma.ledgerAccount.create({ data: { tenantId: SUB, name: `Bank-005-${suffix}`, accountType: 'bank' } });
      const category = await scopedPrisma.ledgerCategory.create({ data: { tenantId: SUB, name: `Sales-005-${suffix}`, kind: 'income' } });
      await scopedPrisma.transaction.create({
        data: {
          tenantId: SUB,
          recordCode: await nextRecordCode('TXN'),
          direction: 'in',
          amount: 50_000,
          txnDate: new Date(),
          accountId: account.id,
          categoryId: category.id,
          source: 'manual',
        },
      });
    });
    const reserves = await as('chairman@kaizen.co.in', () => freeReservesProxy());
    expect(reserves.measured).toBe(true);
    expect(reserves.amount).toBe(50_000);
    // base = paidUp (10,000) + reserves (50,000) = 60,000; board ceiling 6,000; special-resolution ceiling 15,000.

    const buybackRoundA = await as('chairman@kaizen.co.in', () => createRound({ name: `Buyback-A-${suffix}`, kind: 'buyback' }));
    await as('chairman@kaizen.co.in', () => openRound(buybackRoundA.id));

    const overBoardCeiling = await expectReject(() =>
      as('chairman@kaizen.co.in', () =>
        proposeBuyback({ roundId: buybackRoundA.id, holderId: holder.id, shareClassId: equityClass.id, count: 1000, pricePerShare: 10, effectiveOn: new Date().toISOString() }),
      ),
    );
    expect(overBoardCeiling.status).toBe(422);
    expect(overBoardCeiling.message).toMatch(/special resolution/i);

    // Heavy debt: a loan whose outstanding dwarfs the equity base, so even a
    // buy-back safely inside the 10% ceiling is refused on the 2:1 test.
    await as('chairman@kaizen.co.in', async () =>
      scopedPrisma.loan.create({
        data: {
          tenantId: SUB,
          recordCode: await nextRecordCode('LN'),
          lender: `Big Bank ${suffix}`,
          principal: 1_000_000,
          annualRate: 12,
          tenureMonths: 60,
          startDate: new Date(),
        },
      }),
    );

    const buybackRoundB = await as('chairman@kaizen.co.in', () => createRound({ name: `Buyback-B-${suffix}`, kind: 'buyback' }));
    await as('chairman@kaizen.co.in', () => openRound(buybackRoundB.id));

    const overDebtEquity = await expectReject(() =>
      as('chairman@kaizen.co.in', () =>
        proposeBuyback({ roundId: buybackRoundB.id, holderId: holder.id, shareClassId: equityClass.id, count: 100, pricePerShare: 10, effectiveOn: new Date().toISOString() }),
      ),
    );
    expect(overDebtEquity.status).toBe(422);
    expect(overDebtEquity.message).toMatch(/2:1|debt/i);
  });
});

describe('EQT-RND-006 — closing a round raises the PAS-3 item with the 15- or 30-day due date by kind', () => {
  it('a private placement gets 15 days; every other kind gets 30', async () => {
    const closedPrivate = await as('chairman@kaizen.co.in', () => closeRound(privateRoundA.id));
    expect(closedPrivate.status).toBe('closed');

    // `ExceptionRecord` is read unscoped here deliberately — the same way
    // every other test in this suite reads exceptions, since the assertion
    // is about what got written under this tenant's id, not about a request
    // in flight.
    const privateException = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: SUB, code: 'EX-EQT-003', subjectId: privateRoundA.id },
    });
    expect(privateException).toBeTruthy();
    const expectedPrivateDue = new Date(closedPrivate.closedOn!).getTime() + 15 * 86_400_000;
    expect(Math.abs(privateException!.slaDueAt!.getTime() - expectedPrivateDue)).toBeLessThan(60_000);

    const seedRound = await as('chairman@kaizen.co.in', () => createRound({ name: `Seed-006-${suffix}`, kind: 'seed' }));
    await as('chairman@kaizen.co.in', () => openRound(seedRound.id));
    const closedSeed = await as('chairman@kaizen.co.in', () => closeRound(seedRound.id));

    const seedException = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: SUB, code: 'EX-EQT-003', subjectId: seedRound.id },
    });
    expect(seedException).toBeTruthy();
    const expectedSeedDue = new Date(closedSeed.closedOn!).getTime() + 30 * 86_400_000;
    expect(Math.abs(seedException!.slaDueAt!.getTime() - expectedSeedDue)).toBeLessThan(60_000);
  });
});

describe('EQT-RND-007 — the round model dilutes every holder pro-rata and the waterfall pays preference before common', () => {
  it('modelRound dilutes both existing holders by the same proportion of the pre-round total', () => {
    const capTable: ScenarioCapTableRow[] = [
      { holderId: 'h1', holderName: 'Founder', shareClassId: 'equity', count: 800 },
      { holderId: 'h2', holderName: 'Angel', shareClassId: 'equity', count: 200 },
    ];
    const result = modelRound(capTable, {
      newMoney: 250,
      preMoney: 1000,
      newClass: { name: 'Series A', liquidationPreferenceMultiple: 1, participating: false, seniority: 0 },
    });

    expect(result.postMoney).toBe(1250);
    const founder = result.holders.find((h) => h.holderId === 'h1')!;
    const angel = result.holders.find((h) => h.holderId === 'h2')!;
    // Pro-rata: both retain the same fraction of the enlarged total they held
    // of the pre-round total — an 80/20 split before stays an 80/20 split of
    // whatever the post-round total is.
    expect(founder.after.pct / angel.after.pct).toBeCloseTo(founder.before.pct / angel.before.pct, 5);
    expect(founder.dilutionPct).toBeGreaterThan(0);
    expect(angel.dilutionPct).toBeGreaterThan(0);
  });

  it('waterfall pays a non-participating preference stack before common only when conversion is not the better outcome', () => {
    const capTable: ScenarioCapTableRow[] = [
      { holderId: 'pref', holderName: 'Series A', shareClassId: 'series-a', count: 100, preference: { multiple: 1, participating: false, seniority: 0 } },
      { holderId: 'common', holderName: 'Founder', shareClassId: 'common', count: 900 },
    ];
    const priceByClass = { 'series-a': 10, common: 1 };

    // A low exit: the preference (100 * 10 = 1,000) beats the as-converted
    // share of a 2,000 exit (10% * 2,000 = 200), so preference is taken and
    // paid before whatever is left goes to common.
    const lowExit = waterfall(capTable, priceByClass, 2000);
    const prefRowLow = lowExit.rows.find((r) => r.holderId === 'pref')!;
    expect(prefRowLow.converted).toBe(false);
    expect(prefRowLow.totalPayout).toBe(1000);
    const commonRowLow = lowExit.rows.find((r) => r.holderId === 'common')!;
    expect(commonRowLow.totalPayout).toBe(1000); // whatever remains after preference

    // A high exit: 10% of 100,000 (10,000) beats the 1,000 preference, so the
    // rational holder converts instead of taking the preference.
    const highExit = waterfall(capTable, priceByClass, 100_000);
    const prefRowHigh = highExit.rows.find((r) => r.holderId === 'pref')!;
    expect(prefRowHigh.converted).toBe(true);
    expect(prefRowHigh.totalPayout).toBeCloseTo(10_000, 0);
  });
});

describe('EQT-RND-008 — a scenario is never persisted', () => {
  it('the round-model and waterfall endpoints read the live cap table and write nothing', async () => {
    const counts = () =>
      as('chairman@kaizen.co.in', async () => ({
        rounds: await scopedPrisma.fundingRound.count({ where: { tenantId: SUB } }),
        transactions: await scopedPrisma.shareTransaction.count({ where: { tenantId: SUB } }),
        valuations: await scopedPrisma.valuation.count({ where: { tenantId: SUB } }),
        holders: await scopedPrisma.holder.count({ where: { tenantId: SUB } }),
      }));

    const before = await counts();

    const modelled = await as('chairman@kaizen.co.in', () =>
      scenarioRound({ newMoney: 100, preMoney: 900, newClass: { name: 'Seed', liquidationPreferenceMultiple: 1, participating: false, seniority: 0 } }),
    );
    expect(modelled.postMoney).toBe(1000);
    const waterfallResult = await as('chairman@kaizen.co.in', () => scenarioWaterfall(50_000));
    expect(waterfallResult.exitValue).toBe(50_000);

    const after = await counts();
    expect(after).toEqual(before);
  });
});
