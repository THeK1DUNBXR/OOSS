/**
 * GSTR-2B reconciliation keeps its history (Wave 5, FX-71c).
 *
 * A re-import used to delete the period's match rows and write the new set
 * (gst.ts recomputeGstr2bMatches). ITC evidence then had no history: the rows a
 * filer relied on for an earlier reading of the portal were gone. Each recompute
 * now marks the current rows superseded and writes the new set in one
 * transaction. The owner client below sees superseded rows; the readers, which
 * run as the application, must show only the current set.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';
import { gstr2bMatches, gstr2bSummary, importGstr2b } from '../domains/compliance/gst.js';
import { recordVendorBill } from '../domains/books.js';

const OWNER_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public';
const APP_URL = process.env.TEST_APP_DATABASE_URL ?? OWNER_URL.replace('//kaizen:kaizen@', '//kaizen_app:kaizen_app@');

const GSTIN = '33AAACS9101K1ZI';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

// A period no other suite uses, drawn fresh each run so that bills left by an
// earlier run cannot change this run's figures.
const YEAR = 3000 + Math.floor(Math.random() * 6000);

/** Six periods, one per test, cleared of match rows and the import row. */
async function freshPeriod(month: number): Promise<string> {
  const period = `${YEAR}-${String(month).padStart(2, '0')}`;
  await unscopedPrisma.gstr2bMatch.deleteMany({ where: { tenantId: TENANT, period } });
  await unscopedPrisma.gstr2bImport.deleteMany({ where: { tenantId: TENANT, period } });
  return period;
}

/** Two bills in the period: one the portal will show exactly, one it will not show at all. */
async function recordTwoBills(period: string) {
  const [year, month] = period.split('-').map(Number);
  const billDate = new Date(Date.UTC(year, month - 1, 5));
  await asUser('finance@kaizen.co.in', async () => {
    await recordVendorBill({
      vendorName: 'Matched Co',
      vendorGstin: GSTIN,
      billNumber: `${period}-1`,
      billDate,
      subtotal: 1000,
      taxAmount: 180,
    });
    await recordVendorBill({
      vendorName: 'Absent Co',
      vendorGstin: GSTIN,
      billNumber: `${period}-2`,
      billDate,
      subtotal: 1000,
      taxAmount: 180,
    });
  });
}

function portalRow(period: string, billNo: 1 | 2) {
  const [year, month] = period.split('-');
  return {
    ctin: GSTIN,
    inum: `${period}-${billNo}`,
    idt: `05-${month}-${year}`,
    val: 1180,
    itms: [{ txval: 1000, camt: 90, samt: 90 }],
  };
}

async function importAs(period: string, b2b: ReturnType<typeof portalRow>[]) {
  return asUser('finance@kaizen.co.in', () => importGstr2b({ period, b2b }));
}

/** Import 1 shows only bill 1, so bill 2 is missing in 2B. Import 2 shows both. */
async function twoRecomputes(period: string) {
  await recordTwoBills(period);
  const importRow = await importAs(period, [portalRow(period, 1)]);
  await importAs(period, [portalRow(period, 1), portalRow(period, 2)]);
  return importRow;
}

function allRows(period: string) {
  return unscopedPrisma.gstr2bMatch.findMany({ where: { tenantId: TENANT, period }, orderBy: { matchedAt: 'asc' } });
}

describe('GSTR-2B recompute supersedes the previous set (FX-71c)', () => {
  it('keeps the first set with supersededAt set, and the second set is current', async () => {
    const period = await freshPeriod(1);
    const importRow = await twoRecomputes(period);

    const rows = await allRows(period);
    expect(rows).toHaveLength(4);

    const first = rows.filter((r) => r.supersededAt !== null);
    const current = rows.filter((r) => r.supersededAt === null);
    expect(first.map((r) => r.status).sort()).toEqual(['matched', 'missing_in_2b']);
    expect(current.map((r) => r.status).sort()).toEqual(['matched', 'matched']);

    // importId names the gstr2b_imports row. That row is upserted once per period,
    // so both sets carry the same id: it links a set to its period's import, and
    // the supersededAt column is what tells the sets apart.
    expect(rows.every((r) => r.importId === importRow.id)).toBe(true);
  });

  it('the readers return only the current set', async () => {
    const period = await freshPeriod(2);
    await twoRecomputes(period);

    const matches = await asUser('finance@kaizen.co.in', () => gstr2bMatches(period));
    expect(matches.map((m) => m.status).sort()).toEqual(['matched', 'matched']);

    const summary = await asUser('finance@kaizen.co.in', () => gstr2bSummary(period));
    expect(summary.counts.matched).toBe(2);
    expect(summary.counts.missing_in_2b).toBe(0);
  });

  it('the count of current rows equals one recompute output', async () => {
    const period = await freshPeriod(3);
    await twoRecomputes(period);

    const current = await unscopedPrisma.gstr2bMatch.count({
      where: { tenantId: TENANT, period, supersededAt: null },
    });
    const returned = await asUser('finance@kaizen.co.in', () => gstr2bMatches(period));
    expect(current).toBe(2);
    expect(returned).toHaveLength(current);
  });

  it('writes one audit row and one event per recompute', async () => {
    const period = await freshPeriod(4);
    const importRow = await twoRecomputes(period);

    const audits = await unscopedPrisma.auditRecord.count({
      where: { tenantId: TENANT, subjectType: 'gstr2b_match', subjectId: importRow.id, action: 'update' },
    });
    expect(audits).toBe(2);

    const events = await unscopedPrisma.eventRecord.count({
      where: { tenantId: TENANT, eventName: 'kz.cmp.itc_reconciliation.superseded', subjectEntityId: importRow.id },
    });
    expect(events).toBe(2);
  });

  it("does not touch another tenant's match rows", async () => {
    const period = await freshPeriod(5);
    const other = await unscopedPrisma.tenant.upsert({
      where: { slug: 'other-tenant' },
      create: { slug: 'other-tenant', name: 'Other Tenant' },
      update: {},
    });
    const foreign = await unscopedPrisma.gstr2bMatch.create({
      data: { tenantId: other.id, period, status: 'matched', differenceMinor: 0n, ctin: GSTIN, inum: `${period}-X` },
    });

    await twoRecomputes(period);

    const after = await unscopedPrisma.gstr2bMatch.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(after.supersededAt).toBeNull();
    expect(after.tenantId).toBe(other.id);

    const ours = await allRows(period);
    expect(ours.every((r) => r.tenantId === TENANT)).toBe(true);
  });

  it('refuses a raw DELETE of gstr2b_matches as the application role', async () => {
    const period = await freshPeriod(6);
    await twoRecomputes(period);

    const app = new PrismaClient({ datasourceUrl: APP_URL });
    try {
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${TENANT}, true)`;
          return tx.$executeRaw`DELETE FROM "gstr2b_matches" WHERE "period" = ${period}`;
        }),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await app.$disconnect();
    }

    expect(await unscopedPrisma.gstr2bMatch.count({ where: { tenantId: TENANT, period } })).toBe(4);
  });
});
