/**
 * Statutory rules are date-effective data (ORDERED-PLAN 3.1). The fixtures here
 * use fake keys and fake values on purpose: nothing in this file is a statutory
 * figure, and none may become one. `test.example_rate` = 1 is a stand-in for a
 * rate, not a rate.
 *
 * The database is the backstop. The overlap, citation and approval rules are
 * asserted against raw inserts, so they hold for any writer, not only the one
 * domain function that happens to check them today.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { unscopedPrisma } from '../platform/db.js';
import { ruleAt, StatutoryRuleNotFoundError } from '../domains/statutory.js';
import { asUser, tenantId } from './helpers.js';

const JURISDICTION = 'TEST-W1K';
const KEY = 'test.example_rate';

let tid: string;

async function seed(data: Record<string, unknown> = {}) {
  return unscopedPrisma.statutoryRule.create({
    data: {
      tenantId: tid,
      domain: 'test',
      key: KEY,
      jurisdiction: JURISDICTION,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
      value: 1,
      source: 'fixture: obviously fake, W1K',
      status: 'APPROVED',
      approvedBy: 'fixture',
      approvedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...data,
    } as never,
  });
}

function dateOnly(iso: string) {
  return new Date(`${iso}T00:00:00.000Z`);
}

describe('StatutoryRule structure (3.1)', () => {
  beforeEach(async () => {
    tid = await tenantId();
    await unscopedPrisma.statutoryRule.deleteMany({ where: { jurisdiction: JURISDICTION } });
  });

  afterAll(async () => {
    await unscopedPrisma.statutoryRule.deleteMany({ where: { jurisdiction: JURISDICTION } });
  });

  describe('DB constraints', () => {
    it('rejects overlapping effective ranges for the same tenant, jurisdiction and key', async () => {
      await seed({ effectiveFrom: dateOnly('2026-01-01'), effectiveTo: dateOnly('2026-06-01') });
      await expect(
        seed({ effectiveFrom: dateOnly('2026-05-01'), effectiveTo: dateOnly('2026-09-01') }),
      ).rejects.toThrow(/exclusion|23P01/);
    });

    it('rejects an open-ended rule that overlaps an existing one', async () => {
      await seed({ effectiveFrom: dateOnly('2026-01-01'), effectiveTo: null });
      await expect(seed({ effectiveFrom: dateOnly('2027-01-01'), effectiveTo: null })).rejects.toThrow(
        /exclusion|23P01/,
      );
    });

    it('accepts adjacent ranges: effectiveTo is exclusive', async () => {
      await seed({ effectiveFrom: dateOnly('2026-01-01'), effectiveTo: dateOnly('2026-06-01') });
      await expect(
        seed({ effectiveFrom: dateOnly('2026-06-01'), effectiveTo: dateOnly('2027-01-01') }),
      ).resolves.toBeDefined();
    });

    it('rejects a rule with no citation, and one with only whitespace', async () => {
      await expect(seed({ source: '' })).rejects.toThrow(/check|constraint/i);
      await expect(seed({ source: '   ' })).rejects.toThrow(/check|constraint/i);
    });

    it('rejects approvedBy or approvedAt on a row that is not APPROVED', async () => {
      await expect(seed({ status: 'DRAFT' })).rejects.toThrow(/check|constraint/i);
      await expect(seed({ status: 'HOLD' })).rejects.toThrow(/check|constraint/i);
    });

    it('rejects an APPROVED row without an approver', async () => {
      await expect(seed({ approvedBy: null, approvedAt: null })).rejects.toThrow(/check|constraint/i);
    });

    it('defaults a new row to DRAFT when no status is given', async () => {
      const row = await unscopedPrisma.statutoryRule.create({
        data: {
          tenantId: tid,
          domain: 'test',
          key: KEY,
          jurisdiction: JURISDICTION,
          effectiveFrom: dateOnly('2026-01-01'),
          value: 1,
          source: 'fixture: obviously fake, W1K',
        },
      });
      expect(row.status).toBe('DRAFT');
      expect(row.approvedBy).toBeNull();
    });
  });

  describe('ruleAt resolver', () => {
    it('returns an APPROVED rule effective on the IST date of the instant', async () => {
      await seed({ effectiveFrom: dateOnly('2026-04-01') });
      const row = await asUser('chairman@kaizen.co.in', () =>
        ruleAt(KEY, JURISDICTION, new Date('2026-04-01T10:00:00.000Z')),
      );
      expect(row.key).toBe(KEY);
    });

    it('uses the IST date, not the UTC date: 00:30 IST on 1 April is already 1 April', async () => {
      // 2026-03-31T19:00Z is 2026-04-01 00:30 IST. The rule starts 1 April IST.
      // A UTC derivation would read 31 March and find nothing.
      await seed({ effectiveFrom: dateOnly('2026-04-01') });
      const row = await asUser('chairman@kaizen.co.in', () =>
        ruleAt(KEY, JURISDICTION, new Date('2026-03-31T19:00:00.000Z')),
      );
      expect(row.key).toBe(KEY);
    });

    it('control: 23:30 IST on 31 March is still 31 March and finds no rule starting 1 April', async () => {
      await seed({ effectiveFrom: dateOnly('2026-04-01') });
      await expect(
        asUser('chairman@kaizen.co.in', () => ruleAt(KEY, JURISDICTION, new Date('2026-03-31T18:00:00.000Z'))),
      ).rejects.toBeInstanceOf(StatutoryRuleNotFoundError);
    });

    it('never returns a DRAFT rule', async () => {
      await seed({ status: 'DRAFT', approvedBy: null, approvedAt: null });
      await expect(
        asUser('chairman@kaizen.co.in', () => ruleAt(KEY, JURISDICTION, new Date('2026-06-01T00:00:00.000Z'))),
      ).rejects.toBeInstanceOf(StatutoryRuleNotFoundError);
    });

    it('never returns a HOLD rule', async () => {
      await seed({ status: 'HOLD', approvedBy: null, approvedAt: null });
      await expect(
        asUser('chairman@kaizen.co.in', () => ruleAt(KEY, JURISDICTION, new Date('2026-06-01T00:00:00.000Z'))),
      ).rejects.toBeInstanceOf(StatutoryRuleNotFoundError);
    });

    it('throws a typed error when no rule covers the date, and never falls back to a constant', async () => {
      await seed({ effectiveFrom: dateOnly('2026-01-01'), effectiveTo: dateOnly('2026-06-01') });
      await expect(
        asUser('chairman@kaizen.co.in', () => ruleAt(KEY, JURISDICTION, new Date('2026-07-01T00:00:00.000Z'))),
      ).rejects.toBeInstanceOf(StatutoryRuleNotFoundError);
    });
  });
});
