/**
 * A viewer without the money grant for a resource receives null for every
 * money field and its `<name>Minor` sibling (MONEY-VISIBILITY, owner-approved
 * 2026-10-13). Withheld is null, never zero.
 *
 * The unit block pins the masking mechanism in `applyFieldVisibility`: a
 * Prisma Decimal under a money key used to pass through unmasked, because the
 * walk skipped every object value. The DB block pins the create paths that
 * return a money row to a creator who does not hold the money verb.
 */

import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { applyFieldVisibility } from '../platform/permissions.js';
import { bigintReplacer } from '../platform/wire.js';
import { withFixtureRole } from './helpers.js';
import { createAsset, createLoan } from '../domains/books.js';

/** What `res.json` would send: Decimals become their string, BigInt its digits. */
const wire = <T>(value: T): any => JSON.parse(JSON.stringify(value, bigintReplacer));
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('applyFieldVisibility withholds a Decimal money field from a viewer without the money grant', () => {
  it('nulls a Decimal under a MONEY_FIELDS key (opportunity expectedValue)', () => {
    const { data, withheld } = applyFieldVisibility(
      { opportunity: { id: 'opp-1', expectedValue: new Prisma.Decimal('1000.25') } },
      { canSeeMoney: false, ceiling: 'regulated' },
    );
    expect((data.opportunity as { expectedValue: unknown }).expectedValue).toBeNull();
    expect(withheld).toContainEqual({ path: 'opportunity.expectedValue', reason: 'no_permission' });
  });

  it('nulls the <name>Minor sibling of a money field, even when the stem is not itself listed', () => {
    const { data } = applyFieldVisibility(
      {
        pipeline: {
          commitApprovalThreshold: new Prisma.Decimal('500000.00'),
          commitApprovalThresholdMinor: BigInt(50000000),
        },
      },
      { canSeeMoney: false, ceiling: 'regulated' },
    );
    const pipeline = data.pipeline as Record<string, unknown>;
    expect(pipeline.commitApprovalThreshold).toBeNull();
    expect(pipeline.commitApprovalThresholdMinor).toBeNull();
  });

  it('nulls every money figure on an opportunity detail (opportunity, proposal, quote and its lines, contract, MoU)', () => {
    const { data } = applyFieldVisibility(
      {
        opportunity: { expectedValue: new Prisma.Decimal('1000.25'), strategicValue: 'high' },
        proposal: { totalValue: new Prisma.Decimal('2500.5') },
        quote: {
          grandTotal: new Prisma.Decimal('2500.5'),
          subtotal: new Prisma.Decimal('2400'),
          lines: [{ listUnitPrice: new Prisma.Decimal('100'), lineTotal: new Prisma.Decimal('200') }],
        },
        contract: { commercialValue: new Prisma.Decimal('9000') },
        mou: { commercialValue: null },
      },
      { canSeeMoney: false, ceiling: 'regulated' },
    ) as unknown as { data: any };
    expect(data.opportunity.expectedValue).toBeNull();
    expect(data.opportunity.strategicValue).toBe('high');
    expect(data.proposal.totalValue).toBeNull();
    expect(data.quote.grandTotal).toBeNull();
    expect(data.quote.subtotal).toBeNull();
    expect(data.quote.lines[0].listUnitPrice).toBeNull();
    expect(data.quote.lines[0].lineTotal).toBeNull();
    expect(data.contract.commercialValue).toBeNull();
  });

  it('keeps the Decimal for a viewer who holds the money grant', () => {
    const { data } = applyFieldVisibility(
      { opportunity: { expectedValue: new Prisma.Decimal('1000.25') } },
      { canSeeMoney: true, ceiling: 'regulated' },
    );
    expect((data.opportunity as { expectedValue: unknown }).expectedValue).not.toBeNull();
  });
});

describe('books create paths return money only to a creator who holds the assets money verb', () => {
  it('createAsset withholds cost from a creator with assets:create and no financial verb', async () => {
    await withFixtureRole(
      { slug: 'mv_asset_creator', grants: [{ resource: 'assets', verbs: ['create', 'view'] }] },
      async () => {
        const asset = await createAsset({
          name: `MV asset ${stamp()}`,
          purchaseDate: new Date('2026-04-01T00:00:00Z'),
          cost: 1500.25,
          usefulLifeMonths: 36,
        });
        expect(wire(asset).cost).toBeNull();
      },
    );
  });

  it('createLoan withholds principal from a creator with assets:create and no financial verb', async () => {
    await withFixtureRole(
      { slug: 'mv_loan_creator', grants: [{ resource: 'assets', verbs: ['create', 'view'] }] },
      async () => {
        const loan = await createLoan({
          lender: `MV lender ${stamp()}`,
          principal: 250000.5,
          annualRate: 9.5,
          tenureMonths: 24,
          startDate: new Date('2026-04-01T00:00:00Z'),
        });
        expect(wire(loan).principal).toBeNull();
      },
    );
  });
});
