/**
 * The IT money columns in paise (MONEY-S8-IT; ORDERED-PLAN 1.6). The wire keeps
 * each rupee field it always had and adds a `<name>Minor` string beside it, so a
 * client can move across in a later wave. These tests pin the paise siblings,
 * the rupee-to-paise rounding on write, and that every sibling is withheld from
 * a viewer who does not hold the financial grant, exactly as its rupee field is.
 *
 * Fails on the Decimal columns: there is no `*Minor` key before the conversion.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, tenantId, unscopedPrisma } from '../helpers.js';
import { bigintReplacer } from '../../platform/wire.js';
import { createAsset, assetDetail, listAssets } from '../../domains/it/assets.js';
import {
  createInitiative,
  listInitiatives,
  budgetLineDetail,
  createBudgetLine,
  budgetForFy,
  budgetSummary,
} from '../../domains/it/portfolio.js';
import {
  createApplication,
  createLicence,
  licenceDetail,
  listLicences,
  applicationDetail,
} from '../../domains/it/software.js';
import {
  createVendor,
  createVendorContract,
  vendorContractDetail,
  summaryContracts,
  transitionVendorContract,
} from '../../domains/it/vendors.js';
import { poundsOf } from '../../domains/allocation.js';

const wire = <T>(value: T): any => JSON.parse(JSON.stringify(value, bigintReplacer));
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const FINANCE = 'finance@kaizen.co.in';
const OPS = 'operations@kaizen.co.in';

describe('IT money columns — paise siblings and withholding', () => {
  let personId: string;

  beforeAll(async () => {
    const ops = await unscopedPrisma.user.findFirstOrThrow({
      where: { email: OPS, tenant: { slug: 'kaizen' } },
      include: { person: true },
    });
    personId = ops.person!.id;
  });

  it('licence: costPerPeriodMinor is the paise string beside the rupee field, and rounds a third decimal as the Decimal did', async () => {
    const app = await asUser(OPS, () =>
      createApplication({ name: `Minor licence app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const created = await asUser(OPS, () =>
      createLicence({
        applicationId: app.id,
        kind: 'per_seat',
        seatsPurchased: 5,
        seatsInUse: 2,
        costPerPeriod: 1000.25,
        billingCycle: 'monthly',
      }),
    );
    // Operations holds no it_licences:financial, so the create response withholds
    // the cost in rupees and in paise alike. It used to return both to the creator.
    expect(wire(created).costPerPeriod).toBeNull();
    expect(wire(created).costPerPeriodMinor).toBeNull();
    expect(wire(created).pendingRenewalCostPerPeriodMinor).toBeNull();
    const createdAsFinance = wire(await asUser(FINANCE, () => licenceDetail(created.id)));
    expect(createdAsFinance.costPerPeriod).toBe('1000.25');
    expect(createdAsFinance.costPerPeriodMinor).toBe('100025');

    // 1.005 is a tie at the third decimal: half away from zero, as Postgres rounds numeric.
    const tie = await asUser(OPS, () =>
      createLicence({
        applicationId: app.id,
        kind: 'per_seat',
        seatsPurchased: 1,
        seatsInUse: 0,
        costPerPeriod: 1.005,
        billingCycle: 'annual',
      }),
    );
    // Withheld from Operations on create. Finance reads the rounded figure back,
    // so the tie is still checked against what was stored.
    expect(wire(tie).costPerPeriod).toBeNull();
    expect(wire(tie).costPerPeriodMinor).toBeNull();
    const tieAsFinance = wire(await asUser(FINANCE, () => licenceDetail(tie.id)));
    expect(tieAsFinance.costPerPeriod).toBe('1.01');
    expect(tieAsFinance.costPerPeriodMinor).toBe('101');
  });

  it('licence: the paise siblings are withheld from operations on every licence path', async () => {
    const app = await asUser(OPS, () =>
      createApplication({ name: `Minor withheld app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
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
    expect(detail.costPerPeriodMinor).toBeNull();
    expect(detail.annualisedCost).toBeNull();

    const listed = wire(await asUser(OPS, () => listLicences({ applicationId: app.id })));
    expect(listed[0].costPerPeriodMinor).toBeNull();

    const inApp = wire(await asUser(OPS, () => applicationDetail(app.id)));
    expect(inApp.licences[0].costPerPeriodMinor).toBeNull();

    const seen = wire(await asUser(FINANCE, () => licenceDetail(created.id)));
    expect(seen.costPerPeriodMinor).toBe('25050');
  });

  it('asset: purchaseCostMinor is the paise string, and a zero cost is the string "0", not absent', async () => {
    const asset = await asUser(OPS, () =>
      createAsset({ tag: `AST-MIN-${stamp()}`, kind: 'laptop', purchaseCost: 1500.25 }),
    );
    // Operations holds no it_assets:financial: the create response and the detail
    // withhold the cost in paise as well as the rupee field and the book value.
    expect(wire(asset).purchaseCostMinor).toBeNull();
    const detail = wire(await asUser(OPS, () => assetDetail(asset.id)));
    expect(detail.purchaseCostMinor).toBeNull();
    expect(detail.bookValue).toBeNull();
    const detailAsFinance = wire(await asUser(FINANCE, () => assetDetail(asset.id)));
    expect(detailAsFinance.purchaseCostMinor).toBe('150025');

    const zero = await asUser(OPS, () => createAsset({ tag: `AST-MIN0-${stamp()}`, kind: 'phone', purchaseCost: 0 }));
    expect(wire(zero).purchaseCostMinor).toBeNull();
    // Finance sees the zero as the string "0" on the list, not absent.
    const rows = wire(await asUser(FINANCE, () => listAssets({})));
    expect(rows.find((r: { id: string }) => r.id === zero.id).purchaseCostMinor).toBe('0');
  });

  it('initiative: budgetMinor is the paise string beside the rupee budget', async () => {
    const created = await asUser(OPS, () =>
      createInitiative({
        title: `Minor initiative ${stamp()}`,
        theme: 'grow',
        sponsorPartyId: personId,
        ownerPartyId: personId,
        budget: 2000.5,
      }),
    );
    // Operations holds no it_budgets:financial: the create response and the list withhold the paise.
    expect(wire(created).budgetMinor).toBeNull();
    const listed = wire(await asUser(OPS, () => listInitiatives({})));
    expect(listed.find((r: { id: string }) => r.id === created.id).budgetMinor).toBeNull();
    const listedAsFinance = wire(await asUser(FINANCE, () => listInitiatives({})));
    expect(listedAsFinance.find((r: { id: string }) => r.id === created.id).budgetMinor).toBe('200050');
  });

  it('budget line: plannedMinor is paise for finance, and withheld for operations in the line, the detail and the FY roll-up', async () => {
    const fy = 'FY2026-27';
    const line = await asUser(FINANCE, () =>
      createBudgetLine({ fy, category: 'cloud', division: 'shared', kind: 'run', planned: 750.25 }),
    );
    expect(wire(line).plannedMinor).toBe('75025');

    const seen = wire(await asUser(FINANCE, () => budgetLineDetail(line.id)));
    expect(seen.plannedMinor).toBe('75025');

    const opsDetail = wire(await asUser(OPS, () => budgetLineDetail(line.id)));
    expect(opsDetail.planned).toBeNull();
    expect(opsDetail.plannedMinor).toBeNull();

    const opsFy = wire(await asUser(OPS, () => budgetForFy(fy)));
    const opsLine = opsFy.lines.find((l: { id: string }) => l.id === line.id);
    expect(opsLine.planned).toBeNull();
    expect(opsLine.plannedMinor).toBeNull();

    const finFy = wire(await asUser(FINANCE, () => budgetForFy(fy)));
    expect(finFy.lines.find((l: { id: string }) => l.id === line.id).plannedMinor).toBe('75025');
  });

  it('vendor contract: valueMinor is paise for finance, and withheld for operations in detail and the contract list', async () => {
    const vendor = await asUser(OPS, () =>
      createVendor({ name: `Minor vendor ${stamp()}`, category: 'saas', tier: 1, riskRating: 'low' }),
    );
    const contract = await asUser('chairman@kaizen.co.in', () =>
      createVendorContract({ vendorId: vendor.id, title: `Minor contract ${stamp()}`, value: 5000.75 }),
    );
    expect(wire(contract).valueMinor).toBe('500075');

    const seen = wire(await asUser(FINANCE, () => vendorContractDetail(contract.id)));
    expect(seen.valueMinor).toBe('500075');

    // The platform's MONEY_FIELDS list matches `value` by name and would not
    // catch `valueMinor`; the contract masker withholds it explicitly.
    const opsDetail = wire(await asUser(OPS, () => vendorContractDetail(contract.id)));
    expect(opsDetail.value).toBeNull();
    expect(opsDetail.valueMinor).toBeNull();
    expect(opsDetail.currency).toBeNull();
  });
  it('budget roll-ups are exact to the paisa: plannedTotal, run/grow and the category and division lines move by exactly the lines added', async () => {
    // FY2031-32 is not used by any other test, so the deltas are the whole figure.
    const fy = 'FY2031-32';
    const before = wire(await asUser(FINANCE, () => budgetSummary(fy)));
    await asUser(FINANCE, () =>
      createBudgetLine({ fy, category: 'cloud', division: 'shared', kind: 'run', planned: 1000.25 }),
    );
    await asUser(FINANCE, () =>
      createBudgetLine({ fy, category: 'hardware', division: 'shared', kind: 'grow', planned: 250.5 }),
    );
    const after = wire(await asUser(FINANCE, () => budgetSummary(fy)));

    expect(after.plannedTotal - before.plannedTotal).toBe(1250.75);
    expect(after.runTotal - before.runTotal).toBe(1000.25);
    expect(after.growTotal - before.growTotal).toBe(250.5);

    const cat = (s: any, c: string) => s.byCategory.find((x: { category: string }) => x.category === c)?.planned ?? 0;
    expect(cat(after, 'cloud') - cat(before, 'cloud')).toBe(1000.25);
    expect(cat(after, 'hardware') - cat(before, 'hardware')).toBe(250.5);

    const div = (s: any, d: string, k: 'run' | 'grow') =>
      s.byDivision.find((x: { division: string }) => x.division === d)?.[k] ?? 0;
    expect(div(after, 'shared', 'run') - div(before, 'shared', 'run')).toBe(1000.25);
    expect(div(after, 'shared', 'grow') - div(before, 'shared', 'grow')).toBe(250.5);

    const forFy = wire(await asUser(FINANCE, () => budgetForFy(fy)));
    expect(forFy.plannedTotal).toBeGreaterThanOrEqual(1250.75);
  });

  it('value under management is exact to the paisa: the in-force sum equals the sum of valueMinor over approved, active and expiring contracts', async () => {
    const vendor = await asUser(OPS, () =>
      createVendor({ name: `Minor VUM vendor ${stamp()}`, category: 'saas', tier: 1, riskRating: 'low' }),
    );
    const contract = await asUser(OPS, () =>
      createVendorContract({ vendorId: vendor.id, title: `Minor VUM contract ${stamp()}`, value: 10000.25 }),
    );
    await asUser(OPS, () => transitionVendorContract(contract.id, 'proposed'));
    // Finance approves a proposal it did not make, within its ceiling: it applies directly.
    const approved = await asUser(FINANCE, () => transitionVendorContract(contract.id, 'approved'));
    expect(approved.applied).toBe(true);

    const tid = await tenantId();
    const inForce = await unscopedPrisma.itVendorContract.findMany({
      where: { tenantId: tid, status: { in: ['approved', 'active', 'expiring'] } },
      select: { valueMinor: true },
    });
    const paise = inForce.reduce((sum, r) => sum + r.valueMinor, 0n);
    const summary = wire(await asUser(FINANCE, () => summaryContracts()));
    expect(summary.valueUnderManagement).toBe(poundsOf(paise));
    expect(summary.valueUnderManagement).toBeGreaterThanOrEqual(10000.25);
  });
});
