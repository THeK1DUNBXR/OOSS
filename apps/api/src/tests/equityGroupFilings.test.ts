/**
 * Phase 6c of the equity portal — the group-dependent statutory exports
 * (AOC-1, BEN-1/BEN-2 candidates).
 *
 * Requirements named `EQT-FIL-011` through `EQT-FIL-015`, per the phase-6c
 * brief in `docs/plan/equity-portal.md` §6.
 *
 * Runs against its own holding tenant (never `kaizen`, unlike
 * `equityFilings.test.ts`'s single subsidiary) so the holding's own cap
 * table can be mutated freely without touching a shared fixture — mirroring
 * `equityGroup.test.ts`'s own `principalInTenant`/`asTenantUser` pattern,
 * since `asUser` resolves an email with no tenant filter.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createShareClass, createHolder, proposeAllotment, approveShareTransaction, makeEffective,
} from '../domains/equity.js';
import { publishEntitySnapshot, aoc1, aoc1Export, groupBenCandidates, benCandidatesExport } from '../domains/group.js';
import { recordFiling } from '../domains/filings.js';
import { updateCompanyProfile } from '../domains/companyProfile.js';
import { seedBootstrap } from '../seed/bootstrap.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { asPrincipal, authFor, type TestPrincipal, unscopedPrisma, prisma as scopedPrisma } from './helpers.js';

const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const cleanupTenantSlugs: string[] = [];

let HOLDING: string;
let HOLDING_SLUG: string;

async function principalInTenant(tid: string, email: string): Promise<TestPrincipal> {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { tenantId: tid, email } });
  const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
    where: { tenantId: tid, partyId: user.personId, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return {
    tenantId: tid,
    partyId: user.personId,
    userId: user.id,
    affiliationId: affiliation.id,
    roleSlug: affiliation.roleSlug ?? 'chairman',
    branch: user.branch,
  };
}

async function asTenantUser<T>(tid: string, email: 'chairman@kaizen.co.in' | 'finance@kaizen.co.in', fn: () => Promise<T>): Promise<T> {
  const p = await principalInTenant(tid, email);
  return asPrincipal(authFor(p), fn);
}

async function ensureSignatories(tid: string) {
  await asTenantUser(tid, 'chairman@kaizen.co.in', () =>
    updateCompanyProfile({ certificateSignatories: [{ name: 'A. Director', designation: 'Director' }, { name: 'B. Secretary', designation: 'Company Secretary' }] }),
  );
}

async function newClassIn(tid: string, label: string, faceValue = 10) {
  return asTenantUser(tid, 'chairman@kaizen.co.in', () =>
    createShareClass({ name: `${label}-${suffix}`, kind: 'equity', instrument: 'equity', faceValue }),
  );
}

async function newPersonHolderIn(tid: string, label: string, email: string) {
  return asTenantUser(tid, 'chairman@kaizen.co.in', async () => {
    const person = await scopedPrisma.person.create({
      data: { tenantId: tid, recordCode: await nextRecordCode('PER'), fullName: label, primaryEmail: email, primaryEmailNormalised: email, source: 'test' },
    });
    return createHolder({ kind: 'person', personId: person.id, residency: 'resident', investmentBasis: null });
  });
}

async function newEntityHolderIn(tid: string, heldByTenantId: string) {
  return asTenantUser(tid, 'chairman@kaizen.co.in', () => createHolder({ kind: 'entity', heldByTenantId, residency: 'resident' }));
}

async function allotIn(tid: string, shareClassId: string, toHolderId: string, count: number) {
  const proposed = await asTenantUser(tid, 'chairman@kaizen.co.in', () =>
    proposeAllotment({ shareClassId, toHolderId, count, pricePerShare: null, effectiveOn: new Date().toISOString() }),
  );
  await asTenantUser(tid, 'finance@kaizen.co.in', () => approveShareTransaction(proposed.id));
  return asTenantUser(tid, 'finance@kaizen.co.in', () => makeEffective(proposed.id));
}

async function cleanupSnapshotsFor(sourceTenantId: string) {
  await unscopedPrisma.entitySnapshot.deleteMany({ where: { sourceTenantId } }).catch(() => {});
  await unscopedPrisma.entitySnapshotHistory.deleteMany({ where: { sourceTenantId } }).catch(() => {});
}

beforeAll(async () => {
  HOLDING_SLUG = `eqt-filgrp-holding-${suffix}`;
  cleanupTenantSlugs.push(HOLDING_SLUG);
  const { tenantId: holdingId } = await seedBootstrap({ tenantSlug: HOLDING_SLUG, tenantName: 'EQT-FIL-GRP Holding' });
  HOLDING = holdingId;
  await ensureSignatories(HOLDING);
});

afterAll(async () => {
  const tenants = await unscopedPrisma.tenant.findMany({ where: { slug: { in: cleanupTenantSlugs } } });
  for (const t of tenants) await cleanupSnapshotsFor(t.id);

  const bySlug = new Map(tenants.map((t) => [t.slug, t] as const));
  const ordered = [...cleanupTenantSlugs].reverse(); // children before parents
  for (const slug of ordered) {
    const t = bySlug.get(slug);
    if (!t) continue;
    await unscopedPrisma.exceptionRecord.deleteMany({ where: { tenantId: t.id } }).catch(() => {});
    await unscopedPrisma.tenant.delete({ where: { id: t.id } }).catch(() => {});
  }
});

describe('EQT-FIL-011 — the AOC-1 statement lists each subsidiary from its snapshot and says not published where a figure is absent', () => {
  it("a subsidiary's Part A row carries share capital and % holding from the snapshot, and reads not published where the books carry nothing", async () => {
    const subSlug = `eqt-fil-011-sub-${suffix}`;
    cleanupTenantSlugs.push(subSlug);
    const { tenantId: subId } = await seedBootstrap({ tenantSlug: subSlug, tenantName: 'EQT-FIL-011 Sub', parentTenantSlug: HOLDING_SLUG });
    await ensureSignatories(subId);

    const cls = await newClassIn(subId, 'Equity-011', 10);
    const founder = await newPersonHolderIn(subId, 'Founder 011', `founder-011-${suffix}@example.test`);
    await allotIn(subId, cls.id, founder.id, 100);
    const kipl = await newEntityHolderIn(subId, HOLDING);
    await allotIn(subId, cls.id, kipl.id, 900);

    const published = await publishEntitySnapshot(subId);
    expect(published.published).toBe(true);

    const view = await asTenantUser(HOLDING, 'chairman@kaizen.co.in', () => aoc1());
    expect(view.note).toBeNull();

    const row = view.partA.find((r) => r.tenantId === subId);
    expect(row).toBeTruthy();
    expect(row!.name).toBe('EQT-FIL-011 Sub');
    expect(row!.cin).toBe('not published'); // no CIN was ever recorded for this subsidiary
    expect(row!.reserves).toBe('not published'); // the books carry no reserve ledger, ever
    expect(row!.profitAfterTax).toBe('not published'); // no tax figure is modelled anywhere
    expect(row!.shareCapital).toBe(10_000); // (100 + 900) shares x face value 10
    expect(row!.parentHoldingIssuedPct).toBe(90);
    expect(typeof row!.turnover).toBe('number'); // a real (zero) figure, not "not published"
    expect(typeof row!.profitBeforeTax).toBe('number');

    const file = await asTenantUser(HOLDING, 'chairman@kaizen.co.in', () => aoc1Export());
    expect(file.length).toBeGreaterThan(0);
  });

  it('a tenant with no subsidiary snapshots gets an empty Part A and the stated note', async () => {
    const emptySlug = `eqt-fil-011-empty-${suffix}`;
    cleanupTenantSlugs.push(emptySlug);
    const { tenantId: emptyId } = await seedBootstrap({ tenantSlug: emptySlug, tenantName: 'EQT-FIL-011 Empty' });

    const view = await asTenantUser(emptyId, 'chairman@kaizen.co.in', () => aoc1());
    expect(view.partA).toHaveLength(0);
    expect(view.partB).toHaveLength(0);
    expect(view.note).toBe('This company has no subsidiaries on record.');
  });
});

// Shared across EQT-FIL-012/013: one holding-level person who is significant
// beneficial owner of both the holding itself (direct) and a subsidiary the
// holding partly owns (direct + look-through), and one standalone subsidiary
// that names the holding as its own reporting company.
let benPersonEmail: string;
let benSubId: string;

/**
 * Builds one such fixture under a `label` unique to the caller, so
 * EQT-FIL-014 can build its own independent copy rather than depending on
 * EQT-FIL-012 having already run (and already raised the exception it
 * wants to see at zero beforehand).
 */
async function buildBenFixture(label: string): Promise<{ subId: string; personEmail: string }> {
  const subSlug = `eqt-fil-${label}-sub-${suffix}`;
  cleanupTenantSlugs.push(subSlug);
  const { tenantId: subId } = await seedBootstrap({ tenantSlug: subSlug, tenantName: `EQT-FIL-${label} Sub`, parentTenantSlug: HOLDING_SLUG });
  await ensureSignatories(subId);
  const personEmail = `multi-holder-${label}-${suffix}@example.test`;

  // The holding's own register: the person holds 25% directly; the rest to
  // another holder, so the class totals to exactly 100 shares.
  const holdingClass = await newClassIn(HOLDING, `Equity-${label}-Holding`, 10);
  const personInHolding = await newPersonHolderIn(HOLDING, `Multi Holder ${label}`, personEmail);
  await allotIn(HOLDING, holdingClass.id, personInHolding.id, 25);
  const otherInHolding = await newPersonHolderIn(HOLDING, `Other Holder ${label}`, `other-${label}-${suffix}@example.test`);
  await allotIn(HOLDING, holdingClass.id, otherInHolding.id, 75);

  // The subsidiary's own register: the holding holds 50% (the edge), the
  // same person holds 2% directly, and a third holder rounds out to 100.
  const subClass = await newClassIn(subId, `Equity-${label}-Sub`, 10);
  const kipl = await newEntityHolderIn(subId, HOLDING);
  await allotIn(subId, subClass.id, kipl.id, 50);
  const personInSub = await newPersonHolderIn(subId, `Multi Holder ${label}`, personEmail);
  await allotIn(subId, subClass.id, personInSub.id, 2);
  const otherInSub = await newPersonHolderIn(subId, `Other Sub Holder ${label}`, `other-sub-${label}-${suffix}@example.test`);
  await allotIn(subId, subClass.id, otherInSub.id, 48);

  const published = await publishEntitySnapshot(subId);
  expect(published.published).toBe(true);

  return { subId, personEmail };
}

async function setupBenFixture() {
  const { subId, personEmail } = await buildBenFixture('012');
  benSubId = subId;
  benPersonEmail = personEmail;
}

describe('EQT-FIL-012 — a person at ten percent look-through appears as a BEN candidate with the chain and the direct and indirect split', () => {
  beforeAll(setupBenFixture);

  it("the person's direct stake in the holding, and direct + look-through stake in the subsidiary, both appear", async () => {
    const view = await asTenantUser(HOLDING, 'chairman@kaizen.co.in', () => groupBenCandidates());
    expect(view.mode).toBe('individuals');

    const inHolding = view.individuals.find((c) => c.holderKey === benPersonEmail && c.entityId === HOLDING);
    expect(inHolding).toBeTruthy();
    expect(inHolding!.directIssuedPct).toBe(25);
    expect(inHolding!.indirectIssuedPct).toBe(0);
    expect(inHolding!.lookThroughIssuedPct).toBe(25);
    expect(inHolding!.chain).toEqual([]);

    const inSub = view.individuals.find((c) => c.holderKey === benPersonEmail && c.entityId === benSubId);
    expect(inSub).toBeTruthy();
    expect(inSub!.directIssuedPct).toBe(2);
    expect(inSub!.indirectIssuedPct).toBe(12.5); // 25% (in the holding) x 50% (the holding's own stake in the sub)
    expect(inSub!.lookThroughIssuedPct).toBe(14.5);
    expect(inSub!.chain).toHaveLength(1);
    expect(inSub!.chain[0].tenantId).toBe(HOLDING);
    expect(inSub!.chain[0].directPctInEntity).toBe(25);
    expect(inSub!.chain[0].parentStakeInEntity).toBe(50);
    expect(inSub!.chain[0].contributionPct).toBe(12.5);
    expect(inSub!.thresholdCrossedOn).toBeTruthy();

    const file = await asTenantUser(HOLDING, 'chairman@kaizen.co.in', () => benCandidatesExport());
    expect(file.length).toBeGreaterThan(0);
  });
});

describe('EQT-FIL-013 — a subsidiary names its holding reporting company under BEN-2 and lists no individuals', () => {
  beforeAll(async () => {
    if (!benSubId) await setupBenFixture();
  });

  it("the subsidiary's own export names the holding, not the person behind it", async () => {
    const view = await asTenantUser(benSubId, 'chairman@kaizen.co.in', () => groupBenCandidates());
    expect(view.mode).toBe('holding_reporting_company');
    expect(view.individuals).toEqual([]);
    expect(view.holdingReportingCompany).toBeTruthy();
    expect(view.holdingReportingCompany!.tenantId).toBe(HOLDING);
    expect(view.holdingReportingCompany!.directIssuedPct).toBe(50);

    const file = await asTenantUser(benSubId, 'chairman@kaizen.co.in', () => benCandidatesExport());
    expect(file.length).toBeGreaterThan(0);
  });
});

describe('EQT-FIL-014 — the BEN declaration item is raised once per candidate and closed by recording BEN-2', () => {
  let personEmail: string;

  beforeAll(async () => {
    // Its own fixture, independent of EQT-FIL-012/013 — this test wants to
    // see the exception count at genuinely zero before the first compute,
    // which a shared fixture already exercised by an earlier test cannot
    // promise.
    const built = await buildBenFixture('014');
    personEmail = built.personEmail;
  });

  it('runs twice without duplicating, and recording BEN-2 for the holder key resolves it', async () => {
    const before = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: HOLDING, code: 'EX-EQT-011', subjectId: personEmail } });
    expect(before).toHaveLength(0);

    await asTenantUser(HOLDING, 'chairman@kaizen.co.in', () => groupBenCandidates());
    const afterFirst = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: HOLDING, code: 'EX-EQT-011', subjectId: personEmail } });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].state).not.toBe('resolved');

    await asTenantUser(HOLDING, 'chairman@kaizen.co.in', () => groupBenCandidates());
    const afterSecond = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: HOLDING, code: 'EX-EQT-011', subjectId: personEmail } });
    expect(afterSecond).toHaveLength(1); // no duplicate on a repeat computation
    expect(afterSecond[0].id).toBe(afterFirst[0].id);

    await asTenantUser(HOLDING, 'chairman@kaizen.co.in', () =>
      recordFiling({ form: 'BEN-2', relatedType: 'group_holder', relatedId: personEmail, periodOrEvent: `FY 2026-27 — ${personEmail}`, status: 'filed' }),
    );

    const resolved = await unscopedPrisma.exceptionRecord.findFirst({ where: { id: afterFirst[0].id } });
    expect(resolved!.state).toBe('resolved');
  });
});

describe('EQT-FIL-015 — the group exports read only snapshots (source grep on group.ts\'s AOC-1/BEN sections)', () => {
  it('no unscopedPrisma reference appears from the AOC-1 section to the end of the file', () => {
    const path = fileURLToPath(new URL('../domains/group.ts', import.meta.url));
    const text = readFileSync(path, 'utf8');
    const start = text.indexOf('AOC-1 — the statement of subsidiaries');
    expect(start).toBeGreaterThan(-1);
    const section = text.slice(start);
    expect(section.includes('unscopedPrisma')).toBe(false);
  });
});
