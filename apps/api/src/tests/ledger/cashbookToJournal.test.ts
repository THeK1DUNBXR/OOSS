/**
 * cashbookToJournal and the L2 harness, on a SYNTHETIC fixture (apps/api/src/tests/fixtures/synthetic-l2-harness).
 *
 * These tests prove the mapping, the refusals and the harness. They do NOT prove L2. L2 is the
 * migration-equivalence gate for a tenant's books. The local spreadsheet fixture that l2Kaizen.test.ts
 * reads is test data, not a sign-off. A green run here is not evidence that any real books tie.
 *
 * Real Postgres, real contexts, no mocks. The pure mapping tests need no database; the harness
 * tests post into a fresh tenant.
 */

import { describe, expect, it } from 'vitest';
import { mapVouchers, parseMappingCsv } from '../../domains/compliance/cashbookToJournal.js';
import { loadL2Fixture, runL2Harness, SYNTHETIC_FIXTURE_DIR, type L2Fixture } from './l2Harness.js';

const synthetic = loadL2Fixture(SYNTHETIC_FIXTURE_DIR);
const mapped = parseMappingCsv(synthetic.mappingCsv);

describe('cashbookToJournal: pure mapping (synthetic fixture, does not prove L2)', () => {
  it('maps a balanced voucher to one draft in bigint paise under the legacy key', () => {
    const { drafts, refused } = mapVouchers(
      synthetic.vouchers.filter((v) => v.id === 'SYNTH-V001'),
      mapped.table,
    );
    expect(refused).toEqual([]);
    expect(drafts).toHaveLength(1);
    const [draft] = drafts;
    expect(draft!.idempotencyKey).toBe('legacy:SYNTH-V001');
    expect(draft!.entryDate.toISOString()).toBe('2030-02-05T00:00:00.000Z');
    expect(draft!.lines.map((l) => l.amountMinor)).toEqual([1_000_000n, -1_000_000n]);
    for (const line of draft!.lines) expect(typeof line.amountMinor).toBe('bigint');
  });

  it('reports a voucher on an unmapped ledger group and posts none of it', () => {
    const { drafts, refused } = mapVouchers(
      synthetic.vouchers.filter((v) => v.id === 'SYNTH-V003'),
      mapped.table,
    );
    expect(drafts).toEqual([]);
    expect(refused).toEqual([
      expect.objectContaining({
        voucherId: 'SYNTH-V003',
        reason: 'unmapped_group',
        detail: expect.stringContaining('taxpayable'),
      }),
    ]);
  });

  it('reports an unbalanced voucher and does not force it to balance', () => {
    const { drafts, refused } = mapVouchers(
      synthetic.vouchers.filter((v) => v.id === 'SYNTH-V004'),
      mapped.table,
    );
    expect(drafts).toEqual([]);
    expect(refused).toEqual([
      expect.objectContaining({
        voucherId: 'SYNTH-V004',
        reason: 'unbalanced',
        detail: expect.stringContaining('10.00'),
      }),
    ]);
  });

  it('refuses a P&L mapping with no business line, so its vouchers are unmapped rather than posted without one', () => {
    const csv = synthetic.mappingCsv.replace('sales,income,SYNTH Sales,SYNTHLINE1', 'sales,income,SYNTH Sales,');
    const { table, problems } = parseMappingCsv(csv);
    expect(problems).toEqual([expect.stringContaining('income account SYNTH Sales has no lineCode')]);
    expect(table.has('sales')).toBe(false);
    const { drafts, refused } = mapVouchers(
      synthetic.vouchers.filter((v) => v.id === 'SYNTH-V001'),
      table,
    );
    expect(drafts).toEqual([]);
    expect(refused[0]?.reason).toBe('unmapped_group');
  });

  it('refuses a mapping row whose class is not one of the five canonical classes', () => {
    const csv = synthetic.mappingCsv.replace('bank,asset,SYNTH Bank,', 'bank,bank,SYNTH Bank,');
    const { table, problems } = parseMappingCsv(csv);
    expect(problems).toEqual([expect.stringContaining('accountClass "bank" is not one of')]);
    expect(table.has('bank')).toBe(false);
  });

  it('refuses 2025-02-30, which V8 would roll over to 2 March instead of refusing', () => {
    const { drafts, refused } = mapVouchers(
      [
        {
          id: 'SYNTH-NO-SUCH-DAY',
          date: '2025-02-30',
          narration: 'SYNTHETIC',
          legs: [
            { ledgerGroup: 'bank', amount: '1.00' },
            { ledgerGroup: 'sales', amount: '-1.00' },
          ],
        },
      ],
      mapped.table,
    );
    expect(drafts).toEqual([]);
    expect(refused).toEqual([expect.objectContaining({ voucherId: 'SYNTH-NO-SUCH-DAY', reason: 'invalid' })]);
  });

  it('refuses 2025-13-01, a month that does not exist', () => {
    const { drafts, refused } = mapVouchers(
      [
        {
          id: 'SYNTH-NO-SUCH-MONTH',
          date: '2025-13-01',
          narration: 'SYNTHETIC',
          legs: [
            { ledgerGroup: 'bank', amount: '1.00' },
            { ledgerGroup: 'sales', amount: '-1.00' },
          ],
        },
      ],
      mapped.table,
    );
    expect(drafts).toEqual([]);
    expect(refused).toEqual([expect.objectContaining({ voucherId: 'SYNTH-NO-SUCH-MONTH', reason: 'invalid' })]);
  });

  it('refuses an amount that is not a decimal string, and a date that is not an IST day', () => {
    const { drafts, refused } = mapVouchers(
      [
        {
          id: 'SYNTH-BAD-AMOUNT',
          date: '2030-02-05',
          narration: 'SYNTHETIC',
          legs: [
            { ledgerGroup: 'bank', amount: '1,000.00' },
            { ledgerGroup: 'sales', amount: '-1000.00' },
          ],
        },
        {
          id: 'SYNTH-BAD-DATE',
          date: '05/02/2030',
          narration: 'SYNTHETIC',
          legs: [
            { ledgerGroup: 'bank', amount: '1.00' },
            { ledgerGroup: 'sales', amount: '-1.00' },
          ],
        },
      ],
      mapped.table,
    );
    expect(drafts).toEqual([]);
    expect(refused.map((r) => [r.voucherId, r.reason])).toEqual([
      ['SYNTH-BAD-AMOUNT', 'invalid'],
      ['SYNTH-BAD-DATE', 'invalid'],
    ]);
  });
});

describe('L2 harness: runs on the synthetic fixture (proves the harness, does not prove L2)', () => {
  it('posts the synthetic books through post(); the only differences are the two deliberate refusals', async () => {
    const result = await runL2Harness(synthetic);
    // The fixture carries an unmapped voucher (V003) and an unbalanced one (V004) on purpose. Both are
    // reported, and nothing else differs: balances and the trial balance tie to the expected figures.
    expect(result.differences).toEqual([
      expect.stringContaining('voucher SYNTH-V003 not posted (unmapped_group)'),
      expect.stringContaining('voucher SYNTH-V004 not posted (unbalanced)'),
    ]);
    expect(result.status).toBe('fail');
    expect(result.counts).toMatchObject({ vouchers: 5, drafts: 3, posted: 3, refused: 2 });
  }, 120_000);

  it('the trial balance ties (assertTrialBalance) and matches the expected totals', async () => {
    const result = await runL2Harness(synthetic);
    expect(result.trialBalance).toEqual({ debits: '12900.00', credits: '12900.00' });
  }, 120_000);

  it('a re-run of the same vouchers posts nothing new and leaves the entry count unchanged', async () => {
    const result = await runL2Harness(synthetic);
    expect(result.counts.rerunPosted).toBe(0);
    expect(result.counts.entries).toBe(result.counts.drafts);
  }, 120_000);

  it('reports a wrong expected balance as a difference, so the harness can fail', async () => {
    const wrong: L2Fixture = {
      ...synthetic,
      expected: {
        ...synthetic.expected,
        balances: synthetic.expected.balances.map((b) =>
          b.accountName === 'SYNTH Bank' && b.asOf === '2030-02-28' ? { ...b, balance: '7600.00' } : b,
        ),
      },
    };
    const result = await runL2Harness(wrong);
    expect(result.status).toBe('fail');
    expect(result.differences).toContainEqual(
      expect.stringContaining('SYNTH Bank at 2030-02-28: journal 7500.00, expected 7600.00'),
    );
  }, 120_000);

  it('reports a missing expected balance for a mapped account at a month-end', async () => {
    const short: L2Fixture = {
      ...synthetic,
      expected: {
        ...synthetic.expected,
        balances: synthetic.expected.balances.filter(
          (b) => !(b.accountName === 'SYNTH Rent' && b.asOf === '2030-03-31'),
        ),
      },
    };
    const result = await runL2Harness(short);
    expect(result.differences).toContainEqual(
      expect.stringContaining('no expected balance for SYNTH Rent at 2030-03-31'),
    );
  }, 120_000);
});
