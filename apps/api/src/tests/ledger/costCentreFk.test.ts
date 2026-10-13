/**
 * Journal lines name their cost centre through a composite foreign key
 * (ORDERED-PLAN Wave 6, item 1.0, ledger half; spine contract section 1.0).
 *
 * Before this, journal_lines.costCentreId was a plain string, so a line could
 * name a cost centre that did not exist or that belonged to another tenant.
 * This file pins the three places that now refuse it: the composite key in the
 * database, post() before the write reaches the database, and the migration
 * guard that stops the key being added over orphans that are already posted.
 *
 * Real Postgres, no mocks. Posted lines are immutable (rule 2), so a refused
 * write must not commit anything: a rejected post writes nothing, and each raw
 * insert runs in a transaction that is rolled back on purpose.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { unscopedPrisma } from '../../platform/db.js';
import { post, reverse } from '../../platform/ledger.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { asUser, booksTenant } from '../helpers.js';

const APP_URL =
  process.env.TEST_APP_DATABASE_URL ??
  (process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public').replace(
    '//kaizen:kaizen@',
    '//kaizen_app:kaizen_app@',
  );

// The books tenant's own chairman, set in beforeAll: a post runs as a principal of the tenant it writes to.
let CHAIRMAN = 'chairman@kaizen.co.in';
const app = new PrismaClient({ datasourceUrl: APP_URL });
/** Past every posting: the trial balance is taken over the whole tenant. */
const ALL_TIME = new Date('9999-12-31T00:00:00.000Z');
/** A month no other ledger test posts into (periods are keyed by IST month). */
const MONTH = '2046-02';
const DAY = new Date('2046-02-15T00:00:00.000Z');
const GUARD_FILE = new URL(
  '../../../prisma/migrations/20261013205000_journal_line_cost_centre_fk/migration.sql',
  import.meta.url,
);
const FK_NAME = 'journal_lines_tenantId_costCentreId_fkey';

let tid: string;
let otherTid: string;
let entityId: string;
let bankId: string;
let payableId: string;
let liveCentreId: string;
let retiredCentreId: string;
let otherTenantCentreId: string;
/** A posted entry with no cost centre: the parent that raw line inserts are attached to. */
let parentEntryId: string;

const asChairman = <T>(fn: () => Promise<T>) => asUser(CHAIRMAN, () => fn());

/** Throws when the tenant's journal does not balance. Taken after every committed step. */
async function balances() {
  await asChairman(async () => assertTrialBalance(await journalTrialBalance(ALL_TIME)));
}

function bounds(month: string) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return {
    startsOn: new Date(`${month}-01T00:00:00.000Z`),
    endsOn: new Date(`${month}-${String(last).padStart(2, '0')}T00:00:00.000Z`),
  };
}

/** A two-line sale on the bank and payable fixtures, with the cost centre on the bank line. */
function sale(key: string, costCentreId: string | undefined, amount = 10_000n) {
  return {
    entityId,
    entryDate: DAY,
    narration: 'Cost centre fixture',
    sourceType: 'manual' as const,
    idempotencyKey: key,
    lines: [
      { accountId: bankId, amountMinor: amount, costCentreId },
      { accountId: payableId, amountMinor: -amount },
    ],
  };
}

/**
 * Inserts one line as the application role and rolls the transaction back, so
 * a line the database accepts is never committed. Returns the error that ended
 * the attempt; a database that accepts the line ends it with the sentinel.
 */
async function rawLineAttempt(costCentreId: string, t = tid): Promise<Error> {
  const rollback = new Error('rollback: the attempt is never committed');
  try {
    await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t}, true)`;
      await tx.$executeRaw`
        INSERT INTO "journal_lines"
          ("id", "tenantId", "entryId", "lineNo", "accountId", "amountMinor", "baseAmountMinor", "currency", "costCentreId")
        VALUES (${randomUUID()}, ${t}, ${parentEntryId}, ${99}, ${bankId}, ${1n}, ${1n}, 'INR', ${costCentreId})`;
      throw rollback;
    });
  } catch (err) {
    return err as Error;
  }
  throw new Error('the raw line attempt committed');
}

async function countEntries(key: string): Promise<number> {
  return unscopedPrisma.journalEntry.count({ where: { tenantId: tid, idempotencyKey: key } });
}

beforeAll(async () => {
  // Its own books tenant. The kaizen tenant is the one every invoice test issues into, and a
  // ledger entity written there here would make kaizen several-entity for the rest of the run
  // (invoicePosting.ts ledgerEntityForNewInvoice), with entries that cannot be taken back.
  const books = await booksTenant('cost-centre-fk-p0', { invoicePosting: false });
  tid = books.tenantId;
  CHAIRMAN = books.chairman;
  const other = await unscopedPrisma.tenant.create({
    data: { name: 'Cost centre FK other tenant', slug: `ccfk-other-${randomUUID().slice(0, 8)}` },
  });
  otherTid = other.id;

  const entity = await unscopedPrisma.ledgerEntity.upsert({
    where: { tenantId_code: { tenantId: tid, code: 'CCFK' } },
    create: { tenantId: tid, code: 'CCFK', legalName: 'Cost centre FK entity', stateCode: '27' },
    update: {},
  });
  entityId = entity.id;

  const account = async (name: string, accountClass: 'asset' | 'liability') =>
    (
      await unscopedPrisma.ledgerAccount.upsert({
        where: { tenantId_name: { tenantId: tid, name } },
        create: { tenantId: tid, name, accountClass },
        update: {},
      })
    ).id;
  bankId = await account('CCFK bank', 'asset');
  payableId = await account('CCFK payable', 'liability');

  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const centre = (data: { tenantId: string; code: string; deletedAt?: Date }) =>
    unscopedPrisma.costCentre.create({ data: { name: 'Cost centre FK fixture', ...data } });
  liveCentreId = (await centre({ tenantId: tid, code: `CCFK-LIVE-${suffix}` })).id;
  retiredCentreId = (await centre({ tenantId: tid, code: `CCFK-RET-${suffix}`, deletedAt: new Date() })).id;
  otherTenantCentreId = (await centre({ tenantId: otherTid, code: `CCFK-OTHER-${suffix}` })).id;

  await unscopedPrisma.accountingPeriod.upsert({
    where: { tenantId_period: { tenantId: tid, period: MONTH } },
    create: { tenantId: tid, entityId, period: MONTH, fy: '2046-47', status: 'open', ...bounds(MONTH) },
    update: { status: 'open', entityId, ...bounds(MONTH) },
  });

  const parent = await asChairman(() => post(sale(`ccfk:parent:${suffix}`, undefined)));
  parentEntryId = parent.id;
  await balances();
});

afterAll(async () => {
  await app.$disconnect();
  // Posted lines cannot be removed, so the cost centres that no line names are the only rows this file can clear.
  await unscopedPrisma.costCentre.deleteMany({ where: { id: otherTenantCentreId } });
  await unscopedPrisma.tenant.deleteMany({ where: { id: otherTid } });
});

describe('a journal line names a cost centre of its own tenant', () => {
  it("refuses a line that names another tenant's cost centre: post() writes nothing, and the database refuses the line too", async () => {
    const key = `ccfk:other-tenant:${randomUUID()}`;
    await expect(asChairman(() => post(sale(key, otherTenantCentreId)))).rejects.toMatchObject({
      code: 'COST_CENTRE_REFUSED',
      details: { reason: 'missing' },
    });
    expect(await countEntries(key)).toBe(0);
    expect((await rawLineAttempt(otherTenantCentreId)).message).toMatch(new RegExp(FK_NAME));
    await balances();
  });

  it('refuses an unknown cost centre id: post() writes nothing, and the database refuses the line too', async () => {
    const key = `ccfk:unknown:${randomUUID()}`;
    const unknown = `no-such-centre-${randomUUID()}`;
    await expect(asChairman(() => post(sale(key, unknown)))).rejects.toMatchObject({
      code: 'COST_CENTRE_REFUSED',
      details: { reason: 'missing' },
    });
    expect(await countEntries(key)).toBe(0);
    expect((await rawLineAttempt(unknown)).message).toMatch(new RegExp(FK_NAME));
    await balances();
  });

  it('posts a line on a live cost centre of its tenant, and the trial balance holds after each committed step', async () => {
    await balances();
    const withCentre = await asChairman(() => post(sale(`ccfk:live:${randomUUID()}`, liveCentreId)));
    await balances();
    const stored = await unscopedPrisma.journalLine.findMany({
      where: { tenantId: tid, entryId: withCentre.id },
      select: { costCentreId: true },
    });
    expect(stored.map((line) => line.costCentreId).filter(Boolean)).toEqual([liveCentreId]);

    await asChairman(() => post(sale(`ccfk:none:${randomUUID()}`, undefined)));
    await balances();
  });

  it('refuses a retired cost centre on a new posting', async () => {
    const key = `ccfk:retired:${randomUUID()}`;
    await expect(asChairman(() => post(sale(key, retiredCentreId)))).rejects.toMatchObject({
      code: 'COST_CENTRE_REFUSED',
      details: { reason: 'inactive' },
    });
    expect(await countEntries(key)).toBe(0);
    await balances();
  });

  it('reverses an entry whose cost centre was retired after it was posted, because a correction mirrors the line it reverses', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const centre = await unscopedPrisma.costCentre.create({
      data: { tenantId: tid, code: `CCFK-LATER-${suffix}`, name: 'Cost centre FK fixture' },
    });
    const original = await asChairman(() => post(sale(`ccfk:later:${suffix}`, centre.id)));
    await unscopedPrisma.costCentre.update({ where: { id: centre.id }, data: { deletedAt: new Date() } });
    await balances();

    const reversal = await asChairman(() => reverse(original.id, 'Correction after the cost centre was retired'));
    expect(reversal.sourceType).toBe('reversal');
    await balances();
  });

  it('refuses a reversal that names a retired cost centre its original did not use', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const plain = await asChairman(() => post(sale(`ccfk:plain:${suffix}`, undefined)));
    const key = `ccfk:bad-reversal:${suffix}`;
    await expect(
      asChairman(() => post({ ...sale(key, retiredCentreId), sourceType: 'reversal', reversalOfId: plain.id })),
    ).rejects.toMatchObject({ code: 'COST_CENTRE_REFUSED', details: { reason: 'inactive' } });
    expect(await countEntries(key)).toBe(0);
    await balances();
  });
});

describe('the migration guard refuses to add the foreign key over orphans', () => {
  let schema: string;

  /**
   * The guard, read from the migration so the test runs the text that ships.
   * The migration is the only place the guard is written; a copy here would
   * test the copy.
   */
  function guardBlock(): string {
    const sql = readFileSync(GUARD_FILE, 'utf8');
    const start = sql.indexOf('-- GUARD BEGIN');
    const end = sql.indexOf('-- GUARD END');
    if (start < 0 || end < start) throw new Error('the migration has no GUARD BEGIN / GUARD END markers');
    return sql.slice(start, end);
  }

  /**
   * Runs the guard as the application role, with search_path pointed at the
   * scratch schema so the guard's unqualified names resolve to the copies.
   * "tenants" is not copied and resolves to the real table.
   */
  function runGuard(): Promise<void> {
    return app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      await tx.$executeRawUnsafe(guardBlock());
    });
  }

  /**
   * The two tables the guard reads, as copies in a scratch schema under the
   * same tenant policy the migration creates (20261010235900_tenant_rls:72-76).
   * The copies carry no foreign keys, so an orphan can be written here, which
   * the real table refuses once the key exists. That is the state the guard
   * exists to catch.
   */
  async function copyTables() {
    await unscopedPrisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    for (const table of ['journal_lines', 'hcm_workforce_cost_centres']) {
      await unscopedPrisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."${table}" (LIKE "public"."${table}")`);
      await unscopedPrisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."${table}" ENABLE ROW LEVEL SECURITY`);
      await unscopedPrisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."${table}" FORCE ROW LEVEL SECURITY`);
      await unscopedPrisma.$executeRawUnsafe(
        `CREATE POLICY "tenant_isolation" ON "${schema}"."${table}" ` +
          `USING ("tenantId" = current_setting('app.tenant_id', true)) ` +
          `WITH CHECK ("tenantId" = current_setting('app.tenant_id', true))`,
      );
    }
    await unscopedPrisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "kaizen_app"`);
    await unscopedPrisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "kaizen_app"`,
    );
  }

  /** Writes to a copy as the table owner, with the tenant set, because FORCE RLS binds the owner too. */
  async function ownerWrite(t: string, sql: string, params: unknown[]) {
    await unscopedPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t}, true)`;
      await tx.$executeRawUnsafe(sql, ...params);
    });
  }

  const copyCentre = (t: string, id: string) =>
    ownerWrite(
      t,
      `INSERT INTO "${schema}"."hcm_workforce_cost_centres" ("id", "tenantId", "code", "name", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'guard copy', now(), now())`,
      [id, t, `GRD-${id}`],
    );

  const copyLine = (t: string, costCentreId: string | null) =>
    ownerWrite(
      t,
      `INSERT INTO "${schema}"."journal_lines"
         ("id", "tenantId", "entryId", "lineNo", "accountId", "amountMinor", "baseAmountMinor", "currency", "costCentreId")
       VALUES ($1, $2, 'guard-entry', 1, 'guard-account', 1, 1, 'INR', $3)`,
      [randomUUID(), t, costCentreId],
    );

  beforeAll(async () => {
    schema = `ccfk_guard_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await copyTables();
  });

  afterAll(async () => {
    await unscopedPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });

  it('the copies are under FORCE RLS: the application role sees no line with no tenant set', async () => {
    const seen = await app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "journal_lines"`);
      return rows[0]!.n;
    });
    expect(seen).toBe(0n);
  });

  it('refuses when a line names a cost centre its own tenant does not have, and reports the count', async () => {
    const centre = randomUUID();
    await copyCentre(tid, centre);
    await copyLine(tid, centre);
    await copyLine(tid, `ghost-${randomUUID()}`);
    await expect(runGuard()).rejects.toThrow(/names 1 journal line/);
  });

  it('passes once the orphan is removed, which only the copy allows', async () => {
    await ownerWrite(tid, `DELETE FROM "${schema}"."journal_lines" WHERE "costCentreId" LIKE $1`, ['ghost-%']);
    await expect(runGuard()).resolves.toBeUndefined();
  });

  it('visits every tenant: an orphan in another tenant alone is refused', async () => {
    await copyLine(otherTid, `ghost-${randomUUID()}`);
    await expect(runGuard()).rejects.toThrow(/names 1 journal line/);
    await ownerWrite(otherTid, `DELETE FROM "${schema}"."journal_lines" WHERE "costCentreId" LIKE $1`, ['ghost-%']);
    await expect(runGuard()).resolves.toBeUndefined();
  });

  it("refuses a line that names another tenant's cost centre: the centre exists, but not in the line's tenant", async () => {
    const elsewhere = randomUUID();
    await copyCentre(otherTid, elsewhere);
    await copyLine(tid, elsewhere);
    await expect(runGuard()).rejects.toThrow(/names 1 journal line/);
  });
});
