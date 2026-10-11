/**
 * The business-line registry (ACCESS-MODEL-PLAN s.10; VERTICAL-TAXONOMY s.6).
 *
 * Real Postgres, real contexts, no mocks. The invariants that matter most are
 * asserted against raw writes as well as the governed writers, so a future
 * writer that skips the domain function still meets the database's refusal.
 *
 * Every date here is an IST calendar day stored as UTC midnight (the house
 * convention for `@db.Date`, see statutoryRules.test.ts). The one test that
 * depends on the clock fakes only `Date`, so the boundary is exact.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { unscopedPrisma } from '../platform/db.js';
import {
  createBusinessLine,
  recordSuccession,
  renameBusinessLine,
  retireBusinessLine,
  setLineDistribution,
} from '../domains/businessLines.js';
import { PrismaClient } from '@prisma/client';
import { asUser, expectReject, tenantId } from './helpers.js';

const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );

const CHAIRMAN = 'chairman@kaizen.co.in';
const EMPLOYEE = 'employee@kaizen.co.in';

/** A `@db.Date` value for an IST calendar day. */
function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Codes are immutable keys: uppercase, short. A random suffix keeps reruns apart. */
function uniqueCode(): string {
  const rand = Math.random()
    .toString(36)
    .slice(2, 9)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, 'X');
  return `T${rand}`;
}

let tid: string;
const createdLineIds: string[] = [];
const createdCostCentreIds: string[] = [];
const createdOrgUnitIds: string[] = [];
const createdTenantIds: string[] = [];

async function line(overrides: { effectiveFrom?: string; code?: string } = {}) {
  const row = await asUser(CHAIRMAN, () =>
    createBusinessLine({
      code: overrides.code ?? uniqueCode(),
      name: 'Test line',
      payerKind: 'test_payer',
      revenueModel: 'test_model',
      effectiveFrom: overrides.effectiveFrom ?? '2030-01-01',
      reason: 'fixture',
    }),
  );
  createdLineIds.push(row.id);
  return row;
}

async function costCentre() {
  const row = await unscopedPrisma.costCentre.create({
    data: { tenantId: tid, code: uniqueCode(), name: 'Test cost centre' },
  });
  createdCostCentreIds.push(row.id);
  return row;
}

beforeAll(async () => {
  tid = await tenantId();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  // Nothing here is hard-deleted from the audit or event tables; the registry
  // rows are removed only because the fixture tenant is shared by the suite.
  // A distribution goes with its shares in one transaction: the database refuses
  // a line removed while its header stays, and allows the pair to go together.
  const headers = await unscopedPrisma.lineDistribution.findMany({
    where: { costCentreId: { in: createdCostCentreIds } },
    select: { id: true },
  });
  const headerIds = headers.map((h) => h.id);
  await unscopedPrisma.$transaction([
    unscopedPrisma.lineDistributionLine.deleteMany({ where: { distributionId: { in: headerIds } } }),
    unscopedPrisma.lineDistribution.deleteMany({ where: { id: { in: headerIds } } }),
  ]);
  await unscopedPrisma.businessLineSuccessor.deleteMany({
    where: { OR: [{ fromLineId: { in: createdLineIds } }, { toLineId: { in: createdLineIds } }] },
  });
  await unscopedPrisma.orgUnit.deleteMany({ where: { id: { in: createdOrgUnitIds } } });
  await unscopedPrisma.businessLine.deleteMany({ where: { id: { in: createdLineIds } } });
  await unscopedPrisma.costCentre.deleteMany({ where: { id: { in: createdCostCentreIds } } });
  for (const id of createdTenantIds) await unscopedPrisma.tenant.deleteMany({ where: { id } });
});

describe('BusinessLine: the governed registry writers', () => {
  it('defaults the effective date to the IST day, not the UTC day', async () => {
    // 20:00 UTC on 31 March is 01:30 IST on 1 April. A UTC read would say 31 March.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-03-31T20:00:00.000Z') });
    const row = await asUser(CHAIRMAN, () =>
      createBusinessLine({
        code: uniqueCode(),
        name: 'Clock line',
        payerKind: 'test_payer',
        revenueModel: 'test_model',
        reason: 'fixture',
      }),
    );
    createdLineIds.push(row.id);
    expect(row.effectiveFrom.toISOString()).toBe('2030-04-01T00:00:00.000Z');
  });

  it('refuses a code that is not a short uppercase key', async () => {
    const err = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        createBusinessLine({
          code: 'edu lower',
          name: 'Bad',
          payerKind: 'x',
          revenueModel: 'y',
          effectiveFrom: '2030-01-01',
          reason: 'fixture',
        }),
      ),
    );
    expect(err.status).toBe(400);
  });

  it('refuses a code already used, even by a retired line', async () => {
    const code = uniqueCode();
    const first = await line({ code });
    await asUser(CHAIRMAN, () => retireBusinessLine({ id: first.id, effectiveTo: '2031-01-01', reason: 'fixture' }));
    const err = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        createBusinessLine({
          code,
          name: 'Reuse',
          payerKind: 'x',
          revenueModel: 'y',
          effectiveFrom: '2030-01-01',
          reason: 'fixture',
        }),
      ),
    );
    expect(err.status).toBe(409);
  });

  it('writes an audit row and a kz.org event for the create', async () => {
    const row = await line();
    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: tid, subjectType: 'business_line', subjectId: row.id, action: 'create' },
    });
    expect(audit).not.toBeNull();
    const event = await unscopedPrisma.eventRecord.findFirst({
      where: { tenantId: tid, eventName: 'kz.org.business_line.created', subjectEntityId: row.id },
    });
    expect(event).not.toBeNull();
  });

  it('renames the name and nothing else: id and code survive, and the change is audited and emitted', async () => {
    const row = await line();
    const renamed = await asUser(CHAIRMAN, () =>
      renameBusinessLine({ id: row.id, name: 'Renamed line', reason: 'label fix' }),
    );
    expect(renamed.id).toBe(row.id);
    expect(renamed.code).toBe(row.code);
    expect(renamed.name).toBe('Renamed line');
    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: tid, subjectType: 'business_line', subjectId: row.id, action: 'update' },
    });
    expect(audit).not.toBeNull();
    const event = await unscopedPrisma.eventRecord.findFirst({
      where: { tenantId: tid, eventName: 'kz.org.business_line.renamed', subjectEntityId: row.id },
    });
    expect(event).not.toBeNull();
  });

  it('retires a line once, at a date after its start, and refuses a second retirement', async () => {
    const row = await line();
    const retired = await asUser(CHAIRMAN, () =>
      retireBusinessLine({ id: row.id, effectiveTo: '2031-06-30', reason: 'exit' }),
    );
    expect(retired.effectiveTo?.toISOString()).toBe('2031-06-30T00:00:00.000Z');
    const again = await expectReject(() =>
      asUser(CHAIRMAN, () => retireBusinessLine({ id: row.id, effectiveTo: '2031-12-31', reason: 'exit' })),
    );
    expect(again.status).toBe(409);
    const event = await unscopedPrisma.eventRecord.findFirst({
      where: { tenantId: tid, eventName: 'kz.org.business_line.retired', subjectEntityId: row.id },
    });
    expect(event).not.toBeNull();
  });

  it('refuses a retirement that ends on or before the start date', async () => {
    const row = await line({ effectiveFrom: '2030-05-01' });
    const err = await expectReject(() =>
      asUser(CHAIRMAN, () => retireBusinessLine({ id: row.id, effectiveTo: '2030-05-01', reason: 'exit' })),
    );
    expect(err.status).toBe(400);
  });

  it('refuses a write by a principal without org_design, and leaves no row and no audit behind', async () => {
    const before = await unscopedPrisma.auditRecord.count({ where: { tenantId: tid, subjectType: 'business_line' } });
    const code = uniqueCode();
    const err = await expectReject(() =>
      asUser(EMPLOYEE, () =>
        createBusinessLine({
          code,
          name: 'Refused',
          payerKind: 'x',
          revenueModel: 'y',
          effectiveFrom: '2030-01-01',
          reason: 'fixture',
        }),
      ),
    );
    expect(err.status).toBe(403);
    expect(await unscopedPrisma.businessLine.count({ where: { tenantId: tid, code } })).toBe(0);
    expect(await unscopedPrisma.auditRecord.count({ where: { tenantId: tid, subjectType: 'business_line' } })).toBe(
      before,
    );
  });
});

describe('BusinessLine: immutability at the database', () => {
  it('refuses an UPDATE of code, and of id, whatever the writer', async () => {
    const row = await line();
    await expect(
      unscopedPrisma.$executeRaw`UPDATE business_lines SET code = ${'ZZZZ'} WHERE id = ${row.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(unscopedPrisma.businessLine.update({ where: { id: row.id }, data: { code: 'QQQQ' } })).rejects.toThrow(
      /immutable/,
    );
    await expect(
      unscopedPrisma.$executeRaw`UPDATE business_lines SET id = ${'moved-' + row.id} WHERE id = ${row.id}`,
    ).rejects.toThrow(/immutable/);
  });

  it('still allows the name to change at the database', async () => {
    const row = await line();
    const updated = await unscopedPrisma.businessLine.update({
      where: { id: row.id },
      data: { name: 'Direct rename' },
    });
    expect(updated.name).toBe('Direct rename');
  });
});

describe('BusinessLine: successors (dated split and merge)', () => {
  it('records a split whose shares total 10,000 basis points, and a split that states no share', async () => {
    const from = await line();
    const b = await line();
    const c = await line();
    await asUser(CHAIRMAN, () =>
      recordSuccession({
        fromLineId: from.id,
        effectiveFrom: '2030-09-01',
        successors: [
          { toLineId: b.id, shareBasisPoints: 6000 },
          { toLineId: c.id, shareBasisPoints: 4000 },
        ],
        reason: 'split',
      }),
    );
    const rows = await unscopedPrisma.businessLineSuccessor.findMany({
      where: { fromLineId: from.id, effectiveFrom: day('2030-09-01') },
    });
    expect(rows).toHaveLength(2);
    await asUser(CHAIRMAN, () =>
      recordSuccession({
        fromLineId: from.id,
        effectiveFrom: '2030-10-01',
        successors: [
          { toLineId: b.id, shareBasisPoints: null },
          { toLineId: c.id, shareBasisPoints: null },
        ],
        reason: 'split with no stated rule',
      }),
    );
  });

  it('refuses shares that do not total 10,000, and refuses a mix of stated and unstated shares', async () => {
    const from = await line();
    const b = await line();
    const c = await line();
    const short = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        recordSuccession({
          fromLineId: from.id,
          effectiveFrom: '2030-09-01',
          successors: [
            { toLineId: b.id, shareBasisPoints: 6000 },
            { toLineId: c.id, shareBasisPoints: 3000 },
          ],
          reason: 'split',
        }),
      ),
    );
    expect(short.status).toBe(400);
    const mixed = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        recordSuccession({
          fromLineId: from.id,
          effectiveFrom: '2030-09-01',
          successors: [
            { toLineId: b.id, shareBasisPoints: 6000 },
            { toLineId: c.id, shareBasisPoints: null },
          ],
          reason: 'split',
        }),
      ),
    );
    expect(mixed.status).toBe(400);
    expect(await unscopedPrisma.businessLineSuccessor.count({ where: { fromLineId: from.id } })).toBe(0);
  });

  it('refuses shares that do not total 10,000 at the database, at commit', async () => {
    const from = await line();
    const b = await line();
    const c = await line();
    await expect(
      unscopedPrisma.$transaction(async (tx) => {
        await tx.businessLineSuccessor.create({
          data: {
            tenantId: tid,
            fromLineId: from.id,
            toLineId: b.id,
            effectiveFrom: day('2030-11-01'),
            shareBasisPoints: 6000,
            recordedById: 'test',
          },
        });
        await tx.businessLineSuccessor.create({
          data: {
            tenantId: tid,
            fromLineId: from.id,
            toLineId: c.id,
            effectiveFrom: day('2030-11-01'),
            shareBasisPoints: 3000,
            recordedById: 'test',
          },
        });
      }),
    ).rejects.toThrow(/basis points/);
  });

  it('refuses a successor to itself, and a share outside 1..10,000, at the database', async () => {
    const from = await line();
    const b = await line();
    await expect(
      unscopedPrisma.businessLineSuccessor.create({
        data: {
          tenantId: tid,
          fromLineId: from.id,
          toLineId: from.id,
          effectiveFrom: day('2030-12-01'),
          recordedById: 'test',
        },
      }),
    ).rejects.toThrow(/check constraint/);
    await expect(
      unscopedPrisma.businessLineSuccessor.create({
        data: {
          tenantId: tid,
          fromLineId: from.id,
          toLineId: b.id,
          effectiveFrom: day('2030-12-01'),
          shareBasisPoints: 10001,
          recordedById: 'test',
        },
      }),
    ).rejects.toThrow(/check constraint/);
  });

  it('lets a split retire its source on the successor date, but refuses a retired successor target', async () => {
    const from = await line();
    const b = await line();
    await asUser(CHAIRMAN, () => retireBusinessLine({ id: from.id, effectiveTo: '2030-07-01', reason: 'split out' }));
    await asUser(CHAIRMAN, () =>
      recordSuccession({
        fromLineId: from.id,
        effectiveFrom: '2030-07-01',
        successors: [{ toLineId: b.id, shareBasisPoints: null }],
        reason: 'split out',
      }),
    );
    const retiredTarget = await line();
    await asUser(CHAIRMAN, () =>
      retireBusinessLine({ id: retiredTarget.id, effectiveTo: '2030-08-01', reason: 'exit' }),
    );
    const err = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        recordSuccession({
          fromLineId: from.id,
          effectiveFrom: '2030-08-01',
          successors: [{ toLineId: retiredTarget.id, shareBasisPoints: null }],
          reason: 'merge into retired',
        }),
      ),
    );
    expect(err.status).toBe(409);
  });
});

describe('BusinessLine: retired lines take no new writes, and history stays readable', () => {
  it('refuses a distribution or a successor on or after the retirement date, and keeps the history', async () => {
    const a = await line();
    const cc = await costCentre();
    await asUser(CHAIRMAN, () => retireBusinessLine({ id: a.id, effectiveTo: '2030-07-01', reason: 'exit' }));

    const late = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        setLineDistribution({
          subject: { costCentreId: cc.id },
          effectiveFrom: '2030-07-01',
          shares: [{ lineId: a.id, basisPoints: 10000 }],
          reason: 'after retirement',
        }),
      ),
    );
    expect(late.status).toBe(409);

    // Before the date the line is still open, so the history can be written.
    await asUser(CHAIRMAN, () =>
      setLineDistribution({
        subject: { costCentreId: cc.id },
        effectiveFrom: '2030-06-30',
        shares: [{ lineId: a.id, basisPoints: 10000 }],
        reason: 'before retirement',
      }),
    );

    const history = await unscopedPrisma.businessLine.findUnique({ where: { id: a.id } });
    expect(history?.effectiveTo?.toISOString()).toBe('2030-07-01T00:00:00.000Z');
  });

  it('refuses a distribution that names a line not yet in force on its date', async () => {
    const future = await line({ effectiveFrom: '2030-03-02' });
    const cc = await costCentre();
    const err = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        setLineDistribution({
          subject: { costCentreId: cc.id },
          effectiveFrom: '2030-03-01',
          shares: [{ lineId: future.id, basisPoints: 10000 }],
          reason: 'too early',
        }),
      ),
    );
    expect(err.status).toBe(409);
  });
});

describe('BusinessLine: distributions (dated, basis points)', () => {
  it('refuses a distribution whose shares do not total 10,000, and a share outside 1..10,000', async () => {
    const a = await line();
    const b = await line();
    const cc = await costCentre();
    const short = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        setLineDistribution({
          subject: { costCentreId: cc.id },
          effectiveFrom: '2030-01-01',
          shares: [
            { lineId: a.id, basisPoints: 6000 },
            { lineId: b.id, basisPoints: 3000 },
          ],
          reason: 'short',
        }),
      ),
    );
    expect(short.status).toBe(400);
    const outOfRange = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        setLineDistribution({
          subject: { costCentreId: cc.id },
          effectiveFrom: '2030-01-01',
          shares: [{ lineId: a.id, basisPoints: 10001 }],
          reason: 'too big',
        }),
      ),
    );
    expect(outOfRange.status).toBe(400);
  });

  it('refuses a distribution that total 10,000 at the database, at commit, with no lines or a short set', async () => {
    const a = await line();
    const b = await line();
    const cc = await costCentre();
    await expect(
      unscopedPrisma.$transaction(async (tx) => {
        const header = await tx.lineDistribution.create({
          data: { tenantId: tid, costCentreId: cc.id, effectiveFrom: day('2030-02-01'), recordedById: 'test' },
        });
        await tx.lineDistributionLine.create({
          data: { tenantId: tid, distributionId: header.id, lineId: a.id, basisPoints: 9000 },
        });
      }),
    ).rejects.toThrow(/basis points/);
    await expect(
      unscopedPrisma.$transaction(async (tx) => {
        await tx.lineDistribution.create({
          data: { tenantId: tid, costCentreId: cc.id, effectiveFrom: day('2030-03-01'), recordedById: 'test' },
        });
      }),
    ).rejects.toThrow(/basis points/);
    // The same shape at exactly 10,000 commits.
    await unscopedPrisma.$transaction(async (tx) => {
      const header = await tx.lineDistribution.create({
        data: { tenantId: tid, costCentreId: cc.id, effectiveFrom: day('2030-04-01'), recordedById: 'test' },
      });
      await tx.lineDistributionLine.create({
        data: { tenantId: tid, distributionId: header.id, lineId: a.id, basisPoints: 6000 },
      });
      await tx.lineDistributionLine.create({
        data: { tenantId: tid, distributionId: header.id, lineId: b.id, basisPoints: 4000 },
      });
    });
  });

  it('refuses removing one share from a committed distribution, since the total would no longer be 10,000', async () => {
    const a = await line();
    const b = await line();
    const cc = await costCentre();
    const header = await unscopedPrisma.$transaction(async (tx) => {
      const h = await tx.lineDistribution.create({
        data: { tenantId: tid, costCentreId: cc.id, effectiveFrom: day('2030-07-01'), recordedById: 'test' },
      });
      await tx.lineDistributionLine.create({
        data: { tenantId: tid, distributionId: h.id, lineId: a.id, basisPoints: 6000 },
      });
      await tx.lineDistributionLine.create({
        data: { tenantId: tid, distributionId: h.id, lineId: b.id, basisPoints: 4000 },
      });
      return h;
    });
    await expect(
      unscopedPrisma.$transaction(async (tx) => {
        await tx.lineDistributionLine.deleteMany({ where: { distributionId: header.id, lineId: b.id } });
      }),
    ).rejects.toThrow(/basis points/);
  });

  it('refuses a row that names no subject, or more than one, at the database', async () => {
    const cc = await costCentre();
    const category = await unscopedPrisma.ledgerCategory.create({
      data: { tenantId: tid, name: `Test category ${uniqueCode()}` },
    });
    await expect(
      unscopedPrisma.lineDistribution.create({
        data: { tenantId: tid, effectiveFrom: day('2030-05-01'), recordedById: 'test' },
      }),
    ).rejects.toThrow(/check constraint/);
    await expect(
      unscopedPrisma.lineDistribution.create({
        data: {
          tenantId: tid,
          costCentreId: cc.id,
          ledgerCategoryId: category.id,
          effectiveFrom: day('2030-05-01'),
          recordedById: 'test',
        },
      }),
    ).rejects.toThrow(/check constraint/);
    await unscopedPrisma.ledgerCategory.deleteMany({ where: { id: category.id } });
  });

  it('refuses two overlapping distributions for one subject at the database', async () => {
    const a = await line();
    const cc = await costCentre();
    await unscopedPrisma.$transaction(async (tx) => {
      const header = await tx.lineDistribution.create({
        data: { tenantId: tid, costCentreId: cc.id, effectiveFrom: day('2031-01-01'), recordedById: 'test' },
      });
      await tx.lineDistributionLine.create({
        data: { tenantId: tid, distributionId: header.id, lineId: a.id, basisPoints: 10000 },
      });
    });
    await expect(
      unscopedPrisma.$transaction(async (tx) => {
        const header = await tx.lineDistribution.create({
          data: { tenantId: tid, costCentreId: cc.id, effectiveFrom: day('2031-03-01'), recordedById: 'test' },
        });
        await tx.lineDistributionLine.create({
          data: { tenantId: tid, distributionId: header.id, lineId: a.id, basisPoints: 10000 },
        });
      }),
    ).rejects.toThrow(/exclusion|23P01|conflicting key/);
  });

  it('supersedes the prior distribution on a new date, keeps both as history, and emits and audits each step', async () => {
    const a = await line();
    const b = await line();
    const cc = await costCentre();
    await asUser(CHAIRMAN, () =>
      setLineDistribution({
        subject: { costCentreId: cc.id },
        effectiveFrom: '2030-01-01',
        shares: [{ lineId: a.id, basisPoints: 10000 }],
        reason: 'first',
      }),
    );
    await asUser(CHAIRMAN, () =>
      setLineDistribution({
        subject: { costCentreId: cc.id },
        effectiveFrom: '2030-06-01',
        shares: [
          { lineId: a.id, basisPoints: 6000 },
          { lineId: b.id, basisPoints: 4000 },
        ],
        reason: 'second',
      }),
    );
    const headers = await unscopedPrisma.lineDistribution.findMany({
      where: { costCentreId: cc.id },
      orderBy: { effectiveFrom: 'asc' },
    });
    expect(headers).toHaveLength(2);
    expect(headers[0]!.effectiveTo?.toISOString()).toBe('2030-06-01T00:00:00.000Z');
    expect(headers[1]!.effectiveTo).toBeNull();
    const superseded = await unscopedPrisma.eventRecord.findFirst({
      where: { tenantId: tid, eventName: 'kz.org.line_distribution.superseded', subjectEntityId: headers[0]!.id },
    });
    expect(superseded).not.toBeNull();
    const recorded = await unscopedPrisma.eventRecord.findFirst({
      where: { tenantId: tid, eventName: 'kz.org.line_distribution.recorded', subjectEntityId: headers[1]!.id },
    });
    expect(recorded).not.toBeNull();
  });
});

describe('BusinessLine: concurrency and the registry as history', () => {
  it('answers a race for the same subject and day with 409 for the losers, never a database error', async () => {
    const a = await line();
    const cc = await costCentre();
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map(() =>
        asUser(CHAIRMAN, async (): Promise<void> => {
          await setLineDistribution({
            subject: { costCentreId: cc.id },
            effectiveFrom: '2030-08-01',
            shares: [{ lineId: a.id, basisPoints: 10000 }],
            reason: 'race',
          });
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as { status?: number }).status).toBe(409);
    }
  });

  it('refuses a DELETE from the application role on every registry table', async () => {
    const a = await line();
    const app = new PrismaClient({ datasourceUrl: APP_URL });
    try {
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
          await tx.$executeRaw`DELETE FROM "business_lines" WHERE "id" = ${a.id}`;
        }),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
          await tx.$executeRaw`DELETE FROM "business_line_successors" WHERE "id" = 'none'`;
        }),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
          await tx.$executeRaw`DELETE FROM "line_distributions" WHERE "id" = 'none'`;
        }),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tid}, true)`;
          await tx.$executeRaw`DELETE FROM "line_distribution_lines" WHERE "id" = 'none'`;
        }),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await app.$disconnect();
    }
    expect(await unscopedPrisma.businessLine.count({ where: { id: a.id } })).toBe(1);
  });
});

describe('BusinessLine: RLS and tenant scope', () => {
  it('turns on, forces and polices every new table, and the OrgUnit extension is inside the same policy', async () => {
    const rows = await unscopedPrisma.$queryRaw<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policy: string | null }[]
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, p.polname AS policy
        FROM pg_class c
        LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
       WHERE c.relname IN ('business_lines', 'business_line_successors', 'line_distributions', 'line_distribution_lines', 'org_units')
    `;
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.relforcerowsecurity, r.relname).toBe(true);
      expect(r.policy, r.relname).toBe('tenant_isolation');
    }
  });

  it("refuses a successor that points at another tenant's line, through the composite key", async () => {
    const mine = await line();
    const other = await unscopedPrisma.tenant.create({
      data: { name: 'Other tenant', slug: `bl-other-${uniqueCode().toLowerCase()}` },
    });
    createdTenantIds.push(other.id);
    const theirs = await unscopedPrisma.businessLine.create({
      data: {
        tenantId: other.id,
        code: uniqueCode(),
        name: 'Theirs',
        payerKind: 'x',
        revenueModel: 'y',
        effectiveFrom: day('2030-01-01'),
      },
    });
    await expect(
      unscopedPrisma.businessLineSuccessor.create({
        data: {
          tenantId: tid,
          fromLineId: mine.id,
          toLineId: theirs.id,
          effectiveFrom: day('2030-12-01'),
          recordedById: 'test',
        },
      }),
    ).rejects.toThrow(/[Ff]oreign key/);
    await unscopedPrisma.businessLine.deleteMany({ where: { id: theirs.id } });
  });
});

describe('OrgUnit extension: a unit is a line or a function, never both', () => {
  it('requires a line on a line unit and forbids one on a function unit', async () => {
    const a = await line();
    const lineUnit = await unscopedPrisma.orgUnit.create({
      data: { tenantId: tid, name: 'Line unit', kind: 'line', businessLineId: a.id },
    });
    createdOrgUnitIds.push(lineUnit.id);
    await expect(
      unscopedPrisma.orgUnit.create({ data: { tenantId: tid, name: 'Line without line', kind: 'line' } }),
    ).rejects.toThrow(/check constraint/);
    await expect(
      unscopedPrisma.orgUnit.create({
        data: { tenantId: tid, name: 'Function with line', kind: 'function', businessLineId: a.id },
      }),
    ).rejects.toThrow(/check constraint/);
    const fn = await unscopedPrisma.orgUnit.create({ data: { tenantId: tid, name: 'Finance', kind: 'function' } });
    createdOrgUnitIds.push(fn.id);
  });
});
