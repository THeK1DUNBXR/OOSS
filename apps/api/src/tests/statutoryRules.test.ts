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
import {
  approveStatutoryRule,
  createStatutoryRule,
  holdStatutoryRule,
  ruleAt,
  StatutoryRuleNotFoundError,
} from '../domains/statutory.js';
import { asUser, expectReject, tenantId, withFixtureRole } from './helpers.js';

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

/**
 * Drafting and approval (FIXES P2, P3). The creator is the chairman, who holds
 * every grant; the approver is a fixture role that holds `approve` on
 * rate_tables and nothing else. Maker and checker must be different people.
 */
const FX_JURISDICTION = 'TEST-W1K-FX';
const CREATOR = 'chairman@kaizen.co.in';
const APPROVER_GRANTS = [{ resource: 'rate_tables', verbs: ['view', 'edit', 'approve'] }];

async function clearFx() {
  await unscopedPrisma.statutoryRule.deleteMany({ where: { jurisdiction: FX_JURISDICTION } });
}

describe('StatutoryRule drafting and approval (FIXES P2, P3)', () => {
  beforeEach(async () => {
    tid = await tenantId();
    await clearFx();
  });

  afterAll(clearFx);

  it('stages a DRAFT over an open-ended APPROVED rule (exclusion covers APPROVED rows only)', async () => {
    await seed({ jurisdiction: FX_JURISDICTION, effectiveFrom: dateOnly('2026-01-01'), effectiveTo: null });
    await expect(
      seed({
        jurisdiction: FX_JURISDICTION,
        effectiveFrom: dateOnly('2027-04-01'),
        effectiveTo: null,
        status: 'DRAFT',
        approvedBy: null,
        approvedAt: null,
      }),
    ).resolves.toBeDefined();
  });

  it('createStatutoryRule stages next year\'s rate as a DRAFT while this year\'s open-ended rule is APPROVED', async () => {
    await seed({ jurisdiction: FX_JURISDICTION, effectiveFrom: dateOnly('2026-01-01'), effectiveTo: null });
    const draft = await asUser(CREATOR, (p) =>
      createStatutoryRule({
        domain: 'test',
        key: KEY,
        jurisdiction: FX_JURISDICTION,
        effectiveFrom: dateOnly('2027-04-01'),
        value: 2,
        source: 'fixture: obviously fake, W1K',
      }).then((row) => ({ row, creatorPartyId: p.partyId })),
    );
    expect(draft.row.status).toBe('DRAFT');
    expect(draft.row.createdBy).toBe(draft.creatorPartyId);
  });

  it('two domains with the same key and jurisdiction over the same days coexist', async () => {
    await seed({ jurisdiction: FX_JURISDICTION, domain: 'test', effectiveFrom: dateOnly('2026-01-01'), effectiveTo: null });
    await expect(
      seed({ jurisdiction: FX_JURISDICTION, domain: 'other', effectiveFrom: dateOnly('2026-01-01'), effectiveTo: null }),
    ).resolves.toBeDefined();
  });

  it('refuses approval by the creator, and leaves the row a DRAFT', async () => {
    const draft = await asUser(CREATOR, () =>
      createStatutoryRule({
        domain: 'test',
        key: KEY,
        jurisdiction: FX_JURISDICTION,
        effectiveFrom: dateOnly('2026-04-01'),
        value: 2,
        source: 'fixture: obviously fake, W1K',
      }),
    );
    const err = await expectReject(() => asUser(CREATOR, () => approveStatutoryRule(draft.id)));
    expect(err.status).toBe(403);
    const after = await unscopedPrisma.statutoryRule.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.status).toBe('DRAFT');
    expect(after.approvedBy).toBeNull();
  });

  it('refuses approval by a principal without the approve verb, and leaves the row a DRAFT', async () => {
    const draft = await asUser(CREATOR, () =>
      createStatutoryRule({
        domain: 'test',
        key: KEY,
        jurisdiction: FX_JURISDICTION,
        effectiveFrom: dateOnly('2026-04-01'),
        value: 2,
        source: 'fixture: obviously fake, W1K',
      }),
    );
    await withFixtureRole({ grants: [{ resource: 'rate_tables', verbs: ['view', 'edit'] }] }, async () => {
      const err = await expectReject(() => approveStatutoryRule(draft.id));
      expect(err.status).toBe(403);
    });
    const after = await unscopedPrisma.statutoryRule.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.status).toBe('DRAFT');
  });

  it('approval by another person closes the open-ended prior rule at the new effectiveFrom, and ruleAt switches on the IST day', async () => {
    const prior = await seed({
      jurisdiction: FX_JURISDICTION,
      effectiveFrom: dateOnly('2026-01-01'),
      effectiveTo: null,
      value: 1,
    });
    const draft = await asUser(CREATOR, () =>
      createStatutoryRule({
        domain: 'test',
        key: KEY,
        jurisdiction: FX_JURISDICTION,
        effectiveFrom: dateOnly('2026-04-01'),
        value: 2,
        source: 'fixture: obviously fake, W1K',
      }),
    );

    const approved = await withFixtureRole({ grants: APPROVER_GRANTS }, (approver) =>
      approveStatutoryRule(draft.id).then((row) => ({ row, approverPartyId: approver.partyId })),
    );
    expect(approved.row.status).toBe('APPROVED');
    expect(approved.row.approvedBy).toBe(approved.approverPartyId);

    const closed = await unscopedPrisma.statutoryRule.findUniqueOrThrow({ where: { id: prior.id } });
    expect(closed.effectiveTo).toEqual(dateOnly('2026-04-01'));

    // 2026-03-31T18:30Z is 00:00 IST on 1 April. 18:29Z is still 31 March IST.
    const before = await asUser(CREATOR, () => ruleAt(KEY, FX_JURISDICTION, new Date('2026-03-31T18:29:00.000Z')));
    expect(before.value).toBe(1);
    const onTheDay = await asUser(CREATOR, () => ruleAt(KEY, FX_JURISDICTION, new Date('2026-03-31T18:30:00.000Z')));
    expect(onTheDay.value).toBe(2);
  });

  it('approval writes an audit record for both the new row and the closed prior row', async () => {
    const prior = await seed({ jurisdiction: FX_JURISDICTION, effectiveFrom: dateOnly('2026-01-01'), effectiveTo: null });
    const draft = await asUser(CREATOR, () =>
      createStatutoryRule({
        domain: 'test',
        key: KEY,
        jurisdiction: FX_JURISDICTION,
        effectiveFrom: dateOnly('2026-04-01'),
        value: 2,
        source: 'fixture: obviously fake, W1K',
      }),
    );
    await withFixtureRole({ grants: APPROVER_GRANTS }, () => approveStatutoryRule(draft.id));
    const audited = await unscopedPrisma.auditRecord.findMany({
      where: { subjectType: 'statutory_rule', subjectId: { in: [prior.id, draft.id] } },
    });
    expect(new Set(audited.map((a) => a.subjectId))).toEqual(new Set([prior.id, draft.id]));
  });

  it('refuses approval that would overlap an approved bounded rule, as a conflict', async () => {
    await seed({
      jurisdiction: FX_JURISDICTION,
      effectiveFrom: dateOnly('2026-01-01'),
      effectiveTo: dateOnly('2026-06-01'),
    });
    const draft = await asUser(CREATOR, () =>
      createStatutoryRule({
        domain: 'test',
        key: KEY,
        jurisdiction: FX_JURISDICTION,
        effectiveFrom: dateOnly('2026-03-01'),
        value: 2,
        source: 'fixture: obviously fake, W1K',
      }),
    );
    await withFixtureRole({ grants: APPROVER_GRANTS }, async () => {
      const err = await expectReject(() => approveStatutoryRule(draft.id));
      expect(err.status).toBe(409);
    });
    const after = await unscopedPrisma.statutoryRule.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.status).toBe('DRAFT');
  });

  it('holding an approved rule takes it out of ruleAt', async () => {
    const rule = await seed({ jurisdiction: FX_JURISDICTION, effectiveFrom: dateOnly('2026-01-01'), effectiveTo: null });
    const held = await asUser(CREATOR, () => holdStatutoryRule(rule.id));
    expect(held.status).toBe('HOLD');
    await expect(
      asUser(CREATOR, () => ruleAt(KEY, FX_JURISDICTION, new Date('2026-06-01T00:00:00.000Z'))),
    ).rejects.toBeInstanceOf(StatutoryRuleNotFoundError);
  });
});
