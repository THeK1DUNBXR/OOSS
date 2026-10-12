/**
 * The L2 harness: runs cashbookToJournal into a tenant of its own and reports every way the journal
 * differs from the expected figures (CI-GATES-DRAFT, L2; ORDERED-PLAN 1.5 step 4).
 *
 * Test-side. It provisions the tenant, accounts, business lines and periods through unscopedPrisma
 * because a fixture run needs them to exist. The library it calls (cashbookToJournal.ts) does not
 * provision anything (CLAUDE.md rules 5 and 6). Posting goes through post() only.
 *
 * A run returns `differences`, and the L2 test asserts that list is empty. Nothing is forced to
 * zero: a voucher that does not map or does not balance is a difference, and so is a balance that
 * is off by one paisa.
 *
 * Scope: cashbook (Transaction) rows entered in the ERP before the journal becomes the only book, and
 * any later tenant that brings books. A local spreadsheet fixture is read from L2_FIXTURE_DIR and is never
 * committed. A pass against the synthetic fixture proves the harness works and is not an L2 pass.
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMinor, istDateKey, istFinancialYear, parseMinor } from '@kaizen/shared';
import { unscopedPrisma } from '../../platform/db.js';
import { balanceOf } from '../../platform/ledger.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import {
  applyDrafts,
  mapVouchers,
  parseMappingCsv,
  type CashbookVoucher,
  type MappingRow,
} from '../../domains/compliance/cashbookToJournal.js';
import { asUser, booksTenant } from '../helpers.js';

/** Local spreadsheet fixture, kept out of git. Set L2_FIXTURE_DIR to its folder; the default is absent in the repo. */
export const REAL_FIXTURE_DIR =
  process.env.L2_FIXTURE_DIR ?? fileURLToPath(new URL('../fixtures/kaizen-l2', import.meta.url));

export const SYNTHETIC_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/synthetic-l2-harness', import.meta.url));

/** The suspense account for the inherited reconciliation gap (ORDERED-PLAN 1.5 step 4). Named, never hidden. */
const OPENING_BALANCE_DIFFERENCE = 'Opening Balance Difference';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export interface L2Expected {
  description?: string;
  /** Checked against the vouchers loaded. Omitted when the fixture does not state one. */
  voucherCount?: number;
  /** Checked against the mapping table. */
  ledgerAccountCount?: number;
  /** Every mapped account at every month-end of the window needs a row here. Rupee decimal strings. */
  balances: Array<{ accountName: string; asOf: string; balance: string }>;
  trialBalance: { debits: string; credits: string };
  /** The inherited gap, read from the source record. Never a constant in code. */
  openingBalanceDifference?: string;
}

export interface L2Fixture {
  name: string;
  vouchers: CashbookVoucher[];
  mappingCsv: string;
  expected: L2Expected;
}

export interface L2Result {
  status: 'pass' | 'fail';
  differences: string[];
  counts: {
    vouchers: number;
    drafts: number;
    posted: number;
    refused: number;
    rerunPosted: number;
    entries: number;
  };
  trialBalance: { debits: string; credits: string } | null;
}

export function loadL2Fixture(dir: string): L2Fixture {
  const read = (file: string) => readFileSync(join(dir, file), 'utf8');
  return {
    name: dir,
    vouchers: JSON.parse(read('vouchers.json')) as CashbookVoucher[],
    mappingCsv: read('mapping.csv'),
    expected: JSON.parse(read('expected.json')) as L2Expected,
  };
}

export function l2FixturePresent(dir: string): boolean {
  return ['vouchers.json', 'mapping.csv', 'expected.json'].every((file) => existsSync(join(dir, file)));
}

/** The last IST day of a YYYY-MM month, as the YYYY-MM-DD key. Date.UTC(y, m, 0) is UTC midnight of that day, which is the same IST day. */
function monthEndKey(month: string): string {
  const [year, monthNumber] = month.split('-');
  return istDateKey(new Date(Date.UTC(parseInt(year!, 10), parseInt(monthNumber!, 10), 0)));
}

function monthStart(month: string): Date {
  return new Date(`${month}-01T00:00:00.000Z`);
}

async function countEntries(tenantId: string, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  return unscopedPrisma.journalEntry.count({
    where: { tenantId, sourceType: 'import', idempotencyKey: { in: keys } },
  });
}

export async function runL2Harness(fixture: L2Fixture): Promise<L2Result> {
  const differences: string[] = [];
  const expected = fixture.expected;
  const counts = { vouchers: fixture.vouchers.length, drafts: 0, posted: 0, refused: 0, rerunPosted: 0, entries: 0 };

  const { table, problems } = parseMappingCsv(fixture.mappingCsv);
  for (const problem of problems) differences.push(`mapping: ${problem}`);
  if (expected.voucherCount !== undefined && expected.voucherCount !== fixture.vouchers.length) {
    differences.push(`voucher count is ${fixture.vouchers.length}, expected ${expected.voucherCount}`);
  }
  if (expected.ledgerAccountCount !== undefined && expected.ledgerAccountCount !== table.size) {
    differences.push(`mapped ledger accounts are ${table.size}, expected ${expected.ledgerAccountCount}`);
  }

  // Two groups sharing one account name with different classes would silently keep the first class.
  const classByName = new Map<string, MappingRow['accountClass']>();
  for (const row of table.values()) {
    const seen = classByName.get(row.accountName);
    if (seen !== undefined && seen !== row.accountClass) {
      differences.push(`account ${row.accountName} is mapped with two classes, ${seen} and ${row.accountClass}`);
    }
    classByName.set(row.accountName, row.accountClass);
  }

  const tenant = await booksTenant(`l2-${randomUUID().slice(0, 8)}`);
  const tid = tenant.tenantId;
  const chairman = tenant.chairman;

  const accountIdByName = new Map<string, string>();
  for (const [name, accountClass] of classByName) {
    const account = await unscopedPrisma.ledgerAccount.upsert({
      where: { tenantId_name: { tenantId: tid, name } },
      create: { tenantId: tid, name, accountClass },
      update: {},
    });
    accountIdByName.set(name, account.id);
  }

  const lineIdByCode = new Map<string, string>();
  for (const row of table.values()) {
    if (!row.lineCode || lineIdByCode.has(row.lineCode)) continue;
    const existing = await unscopedPrisma.businessLine.findFirst({ where: { tenantId: tid, code: row.lineCode } });
    const line =
      existing ??
      (await unscopedPrisma.businessLine.create({
        data: {
          tenantId: tid,
          code: row.lineCode,
          name: `Harness line ${row.lineCode}`,
          payerKind: 'l2_harness',
          revenueModel: 'l2_harness',
          effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        },
      }));
    lineIdByCode.set(row.lineCode, line.id);
  }

  const validVouchers = fixture.vouchers.filter((v) => DATE_KEY.test(v.date));
  const months = [...new Set(validVouchers.map((v) => v.date.slice(0, 7)))].sort();
  for (const month of months) {
    await unscopedPrisma.accountingPeriod.upsert({
      where: { tenantId_period: { tenantId: tid, period: month } },
      create: {
        tenantId: tid,
        entityId: tenant.entityId,
        period: month,
        fy: istFinancialYear(monthStart(month)),
        status: 'open',
        startsOn: monthStart(month),
        endsOn: new Date(`${monthEndKey(month)}T00:00:00.000Z`),
      },
      update: {},
    });
  }

  const { drafts, refused } = mapVouchers(fixture.vouchers, table);
  counts.drafts = drafts.length;
  counts.refused += refused.length;
  for (const r of refused) differences.push(`voucher ${r.voucherId} not posted (${r.reason}): ${r.detail}`);

  const ctx = { entityId: tenant.entityId, accountIdByName, lineIdByCode };
  const keys = drafts.map((d) => d.idempotencyKey);

  const first = await asUser(chairman, () => applyDrafts(drafts, ctx));
  counts.posted = first.posted.length;
  counts.refused += first.refused.length;
  for (const r of first.refused) differences.push(`voucher ${r.voucherId} refused by post(): ${r.message}`);
  counts.entries = await countEntries(tid, keys);
  if (counts.entries !== drafts.length - first.refused.length) {
    differences.push(
      `journal holds ${counts.entries} legacy entries, expected ${drafts.length - first.refused.length}`,
    );
  }

  // Balances: every expected row, and every mapped account at every month-end of the window.
  const expectedKeys = new Set<string>();
  for (const row of expected.balances) {
    expectedKeys.add(`${row.accountName}|${row.asOf}`);
    const id = accountIdByName.get(row.accountName);
    if (!id) {
      differences.push(`balance row for ${row.accountName} at ${row.asOf} names no mapped account`);
      continue;
    }
    const want = parseMinor(row.balance);
    const got = await asUser(chairman, () => balanceOf(id, new Date(`${row.asOf}T00:00:00.000Z`)));
    if (got !== want) {
      differences.push(`${row.accountName} at ${row.asOf}: journal ${formatMinor(got)}, expected ${formatMinor(want)}`);
    }
  }
  const monthEnds = months.map(monthEndKey);
  for (const name of classByName.keys()) {
    for (const asOf of monthEnds) {
      if (!expectedKeys.has(`${name}|${asOf}`)) differences.push(`no expected balance for ${name} at ${asOf}`);
    }
  }

  // Trial balance at the last month-end, checked for balance and against the expected totals.
  let trialBalance: L2Result['trialBalance'] = null;
  const lastAsOf = monthEnds.at(-1);
  if (lastAsOf) {
    const tb = await asUser(chairman, () => journalTrialBalance(new Date(`${lastAsOf}T00:00:00.000Z`)));
    trialBalance = { debits: formatMinor(tb.debitsMinor), credits: formatMinor(tb.creditsMinor) };
    try {
      assertTrialBalance(tb);
    } catch (err) {
      differences.push(err instanceof Error ? err.message : String(err));
    }
    if (tb.debitsMinor !== parseMinor(expected.trialBalance.debits)) {
      differences.push(`trial balance debits ${trialBalance.debits}, expected ${expected.trialBalance.debits}`);
    }
    if (tb.creditsMinor !== parseMinor(expected.trialBalance.credits)) {
      differences.push(`trial balance credits ${trialBalance.credits}, expected ${expected.trialBalance.credits}`);
    }

    if (expected.openingBalanceDifference !== undefined) {
      const suspenseId = accountIdByName.get(OPENING_BALANCE_DIFFERENCE);
      if (!suspenseId) {
        differences.push(`mapping has no ${OPENING_BALANCE_DIFFERENCE} account`);
      } else {
        const gap = await asUser(chairman, () => balanceOf(suspenseId, new Date(`${lastAsOf}T00:00:00.000Z`)));
        const want = parseMinor(expected.openingBalanceDifference);
        if (gap !== want) {
          differences.push(
            `${OPENING_BALANCE_DIFFERENCE} at ${lastAsOf}: journal ${formatMinor(gap)}, recorded gap ${formatMinor(want)}`,
          );
        }
      }
    }
  }

  // Re-run: the same vouchers must post nothing new.
  const second = await asUser(chairman, () => applyDrafts(drafts, ctx));
  counts.rerunPosted = second.posted.length;
  if (second.posted.length > 0) differences.push(`re-run posted ${second.posted.length} new entries; expected none`);
  const afterRerun = await countEntries(tid, keys);
  if (afterRerun !== counts.entries) {
    differences.push(`re-run changed the legacy entry count from ${counts.entries} to ${afterRerun}`);
  }

  return { status: differences.length === 0 ? 'pass' : 'fail', differences, counts, trialBalance };
}
