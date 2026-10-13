/**
 * Characterisation of the IT money columns as they reach the wire today
 * (ORDERED-PLAN 1.6, MONEY-S8-IT). Pins the TYPE and VALUE of every money
 * field on every path that reads purchaseCost, budget, planned,
 * costPerPeriod, pendingRenewalCostPerPeriod and value, as the JSON `res.json`
 * would send them. These assertions must pass on the Decimal columns and,
 * unchanged, on the BigInt `*Minor` columns, so no figure moves by a paisa and
 * no client sees a field change type.
 *
 * Amounts are exact in binary floating point (x.25, x.5, x.75) so the float
 * arithmetic on the old path and the paise arithmetic on the new one agree.
 * The `*Minor` siblings are asserted in a separate file: they do not exist yet.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, unscopedPrisma } from '../helpers.js';
import { bigintReplacer } from '../../platform/wire.js';
import { createAsset, assetDetail, listAssets, summary as assetsSummary } from '../../domains/it/assets.js';
import {
  createInitiative,
  initiativeDetail,
  createBudgetLine,
  budgetLineDetail,
  budgetForFy,
} from '../../domains/it/portfolio.js';
import {
  createApplication,
  createLicence,
  licenceDetail,
  proposeRenewal,
  approveRenewal,
  licencesSummary,
} from '../../domains/it/software.js';
import {
  createVendor,
  createVendorContract,
  vendorContractDetail,
  summaryContracts,
} from '../../domains/it/vendors.js';

/** What `res.json` would send: Prisma Decimals become their two-place string, BigInt its digits. */
const wire = <T>(value: T): any => JSON.parse(JSON.stringify(value, bigintReplacer));
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const FINANCE = 'finance@kaizen.co.in';
const OPS = 'operations@kaizen.co.in';

describe('IT money columns — wire characterisation (pre-conversion)', () => {
  let personId: string;

  beforeAll(async () => {
    const ops = await unscopedPrisma.user.findFirstOrThrow({
      where: { email: OPS, tenant: { slug: 'kaizen' } },
      include: { person: true },
    });
    personId = ops.person!.id;
  });

  it('licence: raw-row paths send costPerPeriod as a two-place string; detail derives a number annualisedCost', async () => {
    const app = await asUser(OPS, () =>
      createApplication({ name: `Char licence app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const created = await asUser(OPS, () =>
      createLicence({
        applicationId: app.id,
        kind: 'per_seat',
        seatsPurchased: 10,
        seatsInUse: 4,
        costPerPeriod: 1000.25,
        billingCycle: 'monthly',
      }),
    );
    // Pins today's shape, not a wanted one: createLicence returns the cost to
    // Operations, who cannot see it on the detail path. Flip this when that leak is fixed.
    expect(wire(created).costPerPeriod).toBe('1000.25');
    expect(wire(created).pendingRenewalCostPerPeriod).toBeNull();

    const detail = wire(await asUser(FINANCE, () => licenceDetail(created.id)));
    expect(detail.costPerPeriod).toBe('1000.25');
    expect(detail.annualisedCost).toBe(12003);
    expect(detail.pendingRenewalCostPerPeriod).toBeNull();
  });

  it('licence: operations (no financial grant) sees costPerPeriod and annualisedCost withheld as null', async () => {
    const app = await asUser(OPS, () =>
      createApplication({ name: `Char withheld app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const created = await asUser(OPS, () =>
      createLicence({
        applicationId: app.id,
        kind: 'per_seat',
        seatsPurchased: 5,
        seatsInUse: 1,
        costPerPeriod: 250.5,
        billingCycle: 'annual',
      }),
    );
    const detail = wire(await asUser(OPS, () => licenceDetail(created.id)));
    expect(detail.costPerPeriod).toBeNull();
    expect(detail.annualisedCost).toBeNull();
    expect(detail.pendingRenewalCostPerPeriod).toBeNull();
  });

  it('licence renewal: the proposed cost rides pendingRenewalCostPerPeriod, then becomes costPerPeriod on approval', async () => {
    const app = await asUser(OPS, () =>
      createApplication({ name: `Char renewal app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const created = await asUser(OPS, () =>
      createLicence({
        applicationId: app.id,
        kind: 'per_seat',
        seatsPurchased: 5,
        seatsInUse: 2,
        costPerPeriod: 100.25,
        billingCycle: 'monthly',
      }),
    );
    const newTermEnd = new Date(Date.UTC(2027, 2, 31));
    const proposed = await asUser(OPS, () => proposeRenewal(created.id, { newTermEnd, newCostPerPeriod: 1500.5 }));
    expect(wire(proposed.licence).pendingRenewalCostPerPeriod).toBe('1500.5');
    expect(wire(proposed.licence).costPerPeriod).toBe('100.25');

    const approved = await asUser(FINANCE, () => approveRenewal(created.id, true, 'char'));
    expect(approved.applied).toBe(true);
    expect(wire(approved.licence).costPerPeriod).toBe('1500.5');
    expect(wire(approved.licence).pendingRenewalCostPerPeriod).toBeNull();
  });

  it('licence summary: annualisedSpendByApplication carries a number per application, withheld from operations', async () => {
    const app = await asUser(OPS, () =>
      createApplication({ name: `Char summary app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    await asUser(OPS, () =>
      createLicence({
        applicationId: app.id,
        kind: 'per_seat',
        seatsPurchased: 5,
        seatsInUse: 2,
        costPerPeriod: 1000.25,
        billingCycle: 'quarterly',
      }),
    );
    await asUser(OPS, () =>
      createLicence({
        applicationId: app.id,
        kind: 'per_seat',
        seatsPurchased: 5,
        seatsInUse: 2,
        costPerPeriod: 0.75,
        billingCycle: 'monthly',
      }),
    );
    const finance = wire(await asUser(FINANCE, () => licencesSummary()));
    const mine = finance.annualisedSpendByApplication.find(
      (a: { applicationId: string }) => a.applicationId === app.id,
    );
    expect(typeof mine.annualisedCost).toBe('number');
    expect(mine.annualisedCost).toBe(1000.25 * 4 + 0.75 * 12);

    const ops = wire(await asUser(OPS, () => licencesSummary()));
    expect(ops.annualisedSpend).toBeNull();
    const opsMine = ops.annualisedSpendByApplication.find((a: { applicationId: string }) => a.applicationId === app.id);
    expect(opsMine.annualisedCost).toBeNull();
  });

  it('asset: purchaseCost is a two-place string on rows, bookValue a number on detail, and a zero cost stays zero', async () => {
    const tag = `AST-CHAR-${stamp()}`;
    const asset = await asUser(OPS, () => createAsset({ tag, kind: 'laptop', purchaseCost: 1500.25 }));
    expect(wire(asset).purchaseCost).toBe('1500.25');

    const detail = wire(await asUser(OPS, () => assetDetail(asset.id)));
    expect(detail.purchaseCost).toBe('1500.25');
    expect(detail.bookValue).toBe(1500.25);

    const zeroTag = `AST-CHAR0-${stamp()}`;
    const zero = await asUser(OPS, () => createAsset({ tag: zeroTag, kind: 'phone', purchaseCost: 0 }));
    const zeroDetail = wire(await asUser(OPS, () => assetDetail(zero.id)));
    expect(zeroDetail.purchaseCost).toBe('0');
    expect(zeroDetail.bookValue).toBe(0);

    const rows = wire(await asUser(OPS, () => listAssets({})));
    const row = rows.find((r: { id: string }) => r.id === asset.id);
    expect(row.purchaseCost).toBe('1500.25');
  });

  it('asset summary: bookValue is a number and sums the non-disposed fleet', async () => {
    const before = wire(await asUser(OPS, () => assetsSummary())).bookValue;
    const tag = `AST-SUM-${stamp()}`;
    await asUser(OPS, () => createAsset({ tag, kind: 'monitor', purchaseCost: 2000.75 }));
    const after = wire(await asUser(OPS, () => assetsSummary())).bookValue;
    expect(typeof after).toBe('number');
    expect(after - before).toBe(2000.75);
  });

  it('initiative: budget is a two-place string on the raw row', async () => {
    const created = await asUser(OPS, () =>
      createInitiative({
        title: `Char initiative ${stamp()}`,
        theme: 'grow',
        sponsorPartyId: personId,
        ownerPartyId: personId,
        budget: 2000.5,
      }),
    );
    expect(wire(created).budget).toBe('2000.5');
    const detail = wire(await asUser(OPS, () => initiativeDetail(created.id)));
    expect(detail.budget).toBe('2000.5');
  });

  it('budget line: planned is a two-place string on the raw row, a number in the FY roll-up', async () => {
    const fy = 'FY2026-27';
    const line = await asUser(FINANCE, () =>
      createBudgetLine({ fy, category: 'cloud', division: 'shared', kind: 'run', planned: 750.25 }),
    );
    expect(wire(line).planned).toBe('750.25');

    const detail = wire(await asUser(FINANCE, () => budgetLineDetail(line.id)));
    expect(detail.planned).toBe('750.25');
    expect(detail.variance).toBe(750.25 - detail.actual);

    const forFy = wire(await asUser(FINANCE, () => budgetForFy(fy)));
    const inFy = forFy.lines.find((l: { id: string }) => l.id === line.id);
    expect(inFy.planned).toBe(750.25);
    expect(typeof forFy.plannedTotal).toBe('number');

    const opsView = wire(await asUser(OPS, () => budgetForFy(fy)));
    expect(opsView.plannedTotal).toBeNull();
    const opsLine = opsView.lines.find((l: { id: string }) => l.id === line.id);
    expect(opsLine.planned).toBeNull();
  });

  it('vendor contract: value is a number on detail, withheld from operations', async () => {
    const vendor = await asUser(OPS, () =>
      createVendor({ name: `Char vendor ${stamp()}`, category: 'saas', tier: 1, riskRating: 'low' }),
    );
    const contract = await asUser('chairman@kaizen.co.in', () =>
      createVendorContract({ vendorId: vendor.id, title: `Char contract ${stamp()}`, value: 5000.75 }),
    );
    expect(wire(contract).value).toBe(5000.75);

    const detail = wire(await asUser(FINANCE, () => vendorContractDetail(contract.id)));
    expect(detail.value).toBe(5000.75);

    const opsDetail = wire(await asUser(OPS, () => vendorContractDetail(contract.id)));
    expect(opsDetail.value).toBeNull();
  });

  it('vendor contract summary: contract value under management is a number', async () => {
    const before = wire(await asUser(FINANCE, () => summaryContracts())).valueUnderManagement;
    const vendor = await asUser(OPS, () =>
      createVendor({ name: `Char summary vendor ${stamp()}`, category: 'saas', tier: 1, riskRating: 'low' }),
    );
    await asUser('chairman@kaizen.co.in', () =>
      createVendorContract({ vendorId: vendor.id, title: `Char summary contract ${stamp()}`, value: 125.5 }),
    );
    const after = wire(await asUser(FINANCE, () => summaryContracts())).valueUnderManagement;
    expect(typeof after).toBe('number');
    expect(typeof before).toBe('number');
  });
});
