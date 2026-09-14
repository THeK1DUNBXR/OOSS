/**
 * Technology — assets and devices (docs/plan/cio.md, workstream A).
 *
 * `warrantyRung`/`assetBookValue`/the lifecycle machine first, without a
 * database — the ladder arithmetic and the transition diagram are both pure.
 * Then the wiring: assigning and returning are append-only, an employee's
 * `it_assets:V@own` grant narrows the list to what they hold, the warranty
 * ladder and the in-repair and orphaned-asset detectors are idempotent, and
 * only a role holding `edit` can move an asset through its lifecycle.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { assetBookValue, itAssetMachine, warrantyRung, daysInRepair, daysUntil } from '@kaizen/shared';
import { asUser, expectReject, tenantId, unscopedPrisma, withFixtureRole } from '../helpers.js';
import {
  createAsset,
  listAssets,
  myAssets,
  assetDetail,
  assignAsset,
  returnAsset,
  transitionAsset,
  addAssetEvent,
  runWarrantyLadder,
  runInRepairTooLongDetector,
  runOrphanedAssetDetector,
  summary,
} from '../../domains/it/assets.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

// ---------------------------------------------------------------------------
// Pure arithmetic — no DB
// ---------------------------------------------------------------------------

describe('warrantyRung (pure arithmetic, no DB)', () => {
  it('returns null well outside every rung', () => {
    expect(warrantyRung(120)).toBeNull();
  });

  it('returns the tightest rung crossed', () => {
    expect(warrantyRung(90)).toBe(90);
    expect(warrantyRung(45)).toBe(90); // inside the 90-day window, not yet the 30-day one
    expect(warrantyRung(29)).toBe(30);
    expect(warrantyRung(10)).toBe(30);
    expect(warrantyRung(7)).toBe(7);
    expect(warrantyRung(3)).toBe(7);
    expect(warrantyRung(0)).toBe(0);
  });

  it('treats zero and negative days left as the expired rung', () => {
    expect(warrantyRung(0)).toBe(0);
    expect(warrantyRung(-30)).toBe(0);
  });

  it('honours a custom, dated rung set rather than a hard-coded ladder', () => {
    expect(warrantyRung(20, [60, 14])).toBe(60);
    expect(warrantyRung(10, [60, 14])).toBe(14);
    expect(warrantyRung(70, [60, 14])).toBeNull();
  });
});

describe('assetBookValue (pure arithmetic, no DB)', () => {
  it('sums the costs passed in', () => {
    expect(assetBookValue([1000, 2500, 500])).toBe(4000);
  });

  it('treats null/undefined costs as zero rather than throwing', () => {
    expect(assetBookValue([1000, null, undefined, 500])).toBe(1500);
  });

  it('is zero for an empty fleet', () => {
    expect(assetBookValue([])).toBe(0);
  });
});

describe('daysUntil / daysInRepair (pure arithmetic, no DB)', () => {
  it('daysUntil is positive before the date and negative after', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    expect(daysUntil(new Date('2026-06-11T00:00:00.000Z'), now)).toBe(10);
    expect(daysUntil(new Date('2026-05-22T00:00:00.000Z'), now)).toBe(-10);
  });

  it('daysInRepair counts whole days since entering repair', () => {
    const since = new Date('2026-06-01T00:00:00.000Z');
    const now = new Date('2026-06-15T00:00:00.000Z');
    expect(daysInRepair(since, now)).toBe(14);
  });
});

describe('IT-AST-001: the asset lifecycle machine (pure, no DB)', () => {
  it('transitions from each state are exactly those the machine declares', () => {
    expect(itAssetMachine.allowedEvents('in_stock').sort()).toEqual(['ASSIGN', 'RETIRE', 'SEND_TO_REPAIR'].sort());
    expect(itAssetMachine.allowedEvents('assigned').sort()).toEqual(['RETIRE', 'RETURN', 'SEND_TO_REPAIR'].sort());
    expect(itAssetMachine.allowedEvents('in_repair').sort()).toEqual(['BACK_FROM_REPAIR', 'RETIRE'].sort());
    expect(itAssetMachine.allowedEvents('retired')).toEqual(['DISPOSE']);
    expect(itAssetMachine.allowedEvents('disposed')).toEqual([]);
  });

  it('FAILs if disposed were reachable directly from assigned — it is not', () => {
    expect(itAssetMachine.can('assigned', 'DISPOSE' as never)).toBe(false);
    expect(() => itAssetMachine.apply('assigned', 'DISPOSE' as never)).toThrow();
  });

  it('disposed is reachable only through retired', () => {
    expect(itAssetMachine.can('retired', 'DISPOSE')).toBe(true);
    expect(itAssetMachine.apply('retired', 'DISPOSE')).toBe('disposed');
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('assets — domain and wiring', () => {
  let tid: string;
  let holderA: { id: string; name: string };
  let holderB: { id: string; name: string };

  beforeAll(async () => {
    tid = await tenantId();

    const s = stamp();
    const pa = await unscopedPrisma.person.create({
      data: { tenantId: tid, recordCode: `PER-AST-${s}A`, fullName: `Asset Holder A ${s}`, source: 'test' },
    });
    const pb = await unscopedPrisma.person.create({
      data: { tenantId: tid, recordCode: `PER-AST-${s}B`, fullName: `Asset Holder B ${s}`, source: 'test' },
    });
    await unscopedPrisma.affiliation.create({
      data: { tenantId: tid, partyId: pa.id, affiliationType: 'employee', counterpartyName: 'Kaizen', roleSlug: 'employee', status: 'active' },
    });
    await unscopedPrisma.affiliation.create({
      data: { tenantId: tid, partyId: pb.id, affiliationType: 'employee', counterpartyName: 'Kaizen', roleSlug: 'employee', status: 'active' },
    });
    holderA = { id: pa.id, name: pa.fullName };
    holderB = { id: pb.id, name: pb.fullName };
  });

  it('IT-AST-002: assigning writes an assignment row and returning closes it without editing the earlier row', async () => {
    const tag = `AST-${stamp()}`;
    const asset = await asUser('operations@kaizen.co.in', () => createAsset({ tag, kind: 'laptop', condition: 'good' }));
    expect(asset.status).toBe('in_stock');
    expect(asset.availableTransitions.sort()).toEqual(['ASSIGN', 'RETIRE', 'SEND_TO_REPAIR'].sort());

    const assigned = await asUser('operations@kaizen.co.in', () =>
      assignAsset(asset.id, { partyId: holderA.id, conditionOut: 'good', note: 'Issued at onboarding' }),
    );
    expect(assigned.status).toBe('assigned');
    expect(assigned.holderPartyId).toBe(holderA.id);

    const afterAssign = await unscopedPrisma.itAssetAssignment.findMany({ where: { tenantId: tid, assetId: asset.id } });
    expect(afterAssign).toHaveLength(1);
    const openRow = afterAssign[0];
    expect(openRow.partyId).toBe(holderA.id);
    expect(openRow.returnedAt).toBeNull();

    const returned = await asUser('operations@kaizen.co.in', () =>
      returnAsset(asset.id, { conditionIn: 'fair', note: 'Handed back on transfer' }),
    );
    expect(returned.status).toBe('in_stock');
    expect(returned.holderPartyId).toBeNull();

    const afterReturn = await unscopedPrisma.itAssetAssignment.findMany({ where: { tenantId: tid, assetId: asset.id } });
    // Append-only: still exactly one row — the same hand-over, now closed —
    // never a second row for the return.
    expect(afterReturn).toHaveLength(1);
    expect(afterReturn[0].id).toBe(openRow.id);
    expect(afterReturn[0].assignedAt.getTime()).toBe(openRow.assignedAt.getTime());
    expect(afterReturn[0].returnedAt).not.toBeNull();
    expect(afterReturn[0].conditionIn).toBe('fair');

    // Reassigning writes a SECOND row; the first is untouched.
    const reassigned = await asUser('operations@kaizen.co.in', () =>
      assignAsset(asset.id, { partyId: holderB.id, conditionOut: 'fair' }),
    );
    expect(reassigned.holderPartyId).toBe(holderB.id);
    const rows = await unscopedPrisma.itAssetAssignment.findMany({ where: { tenantId: tid, assetId: asset.id }, orderBy: { assignedAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].returnedAt).not.toBeNull();
    expect(rows[0].conditionIn).toBe('fair'); // unchanged from the first close
    expect(rows[1].partyId).toBe(holderB.id);
    expect(rows[1].returnedAt).toBeNull();

    // Return once more so the fixture doesn't leak an assigned asset into
    // other tests' summary/list expectations.
    await asUser('operations@kaizen.co.in', () => returnAsset(asset.id));
  });

  it('an asset must be returned before it can be reassigned — the machine only allows ASSIGN from in_stock', async () => {
    const tag = `AST-${stamp()}`;
    const asset = await asUser('operations@kaizen.co.in', () => createAsset({ tag, kind: 'monitor' }));
    await asUser('operations@kaizen.co.in', () => assignAsset(asset.id, { partyId: holderA.id }));

    const rejection = await expectReject(() => asUser('operations@kaizen.co.in', () => assignAsset(asset.id, { partyId: holderB.id })));
    expect(rejection.status).toBe(422);

    await asUser('operations@kaizen.co.in', () => returnAsset(asset.id));
  });

  it('IT-AST-003: the warranty ladder fires once per rung and a second run on the same day raises nothing new', async () => {
    const tag = `AST-WARR-${stamp()}`;
    const warrantyEnd = new Date();
    warrantyEnd.setDate(warrantyEnd.getDate() + 5); // inside the 7-day rung

    const asset = await asUser('operations@kaizen.co.in', () =>
      createAsset({ tag, kind: 'laptop', warrantyEnd }),
    );

    const first = await asUser('operations@kaizen.co.in', () => runWarrantyLadder());
    expect(first.notified).toBeGreaterThanOrEqual(1);

    const exceptions = await unscopedPrisma.exceptionRecord.findMany({
      where: { tenantId: tid, subjectType: 'it_asset', subjectId: asset.id, code: 'IT_AST_WARRANTY_APPROACHING' },
    });
    expect(exceptions).toHaveLength(1);

    const second = await asUser('operations@kaizen.co.in', () => runWarrantyLadder());
    const exceptionsAfterSecond = await unscopedPrisma.exceptionRecord.findMany({
      where: { tenantId: tid, subjectType: 'it_asset', subjectId: asset.id, code: 'IT_AST_WARRANTY_APPROACHING' },
    });
    expect(exceptionsAfterSecond).toHaveLength(1); // no duplicate
    expect(second.skippedIdempotent).toBeGreaterThanOrEqual(1);
  });

  it('IT-AST-004: an employee lists assets and sees only those assigned to them', async () => {
    const tagMine = `AST-MINE-${stamp()}`;
    const tagTheirs = `AST-THEIRS-${stamp()}`;

    const mine = await asUser('operations@kaizen.co.in', () => createAsset({ tag: tagMine, kind: 'laptop' }));
    const theirs = await asUser('operations@kaizen.co.in', () => createAsset({ tag: tagTheirs, kind: 'laptop' }));

    // Employee's own affiliation/party from the seeded fixture account.
    const employeeParty = await asUser('employee@kaizen.co.in', async (p) => p.partyId);

    await asUser('operations@kaizen.co.in', () => assignAsset(mine.id, { partyId: employeeParty }));
    await asUser('operations@kaizen.co.in', () => assignAsset(theirs.id, { partyId: holderB.id }));

    const seen = await asUser('employee@kaizen.co.in', () => listAssets());
    expect(seen.some((a) => a.id === mine.id)).toBe(true);
    expect(seen.some((a) => a.id === theirs.id)).toBe(false);

    const mineList = await asUser('employee@kaizen.co.in', () => myAssets());
    expect(mineList).toHaveLength(1);
    expect(mineList[0].id).toBe(mine.id);

    // FAIL condition made explicit: the employee cannot open another
    // person's asset detail either.
    const rejection = await expectReject(() => asUser('employee@kaizen.co.in', () => assetDetail(theirs.id)));
    expect(rejection.status).toBe(403);

    // Operations, holding it_assets:V@all, sees both.
    const opsSeen = await asUser('operations@kaizen.co.in', () => listAssets());
    expect(opsSeen.some((a) => a.id === mine.id)).toBe(true);
    expect(opsSeen.some((a) => a.id === theirs.id)).toBe(true);

    await asUser('operations@kaizen.co.in', () => returnAsset(mine.id));
    await asUser('operations@kaizen.co.in', () => returnAsset(theirs.id));
  });

  it('IT-AST-005: an asset held by a person whose affiliation has ended surfaces as an exception with the asset as subject', async () => {
    const tag = `AST-ORPH-${stamp()}`;
    const s = stamp();
    const leaver = await unscopedPrisma.person.create({
      data: { tenantId: tid, recordCode: `PER-LEAVE-${s}`, fullName: `Departed Employee ${s}`, source: 'test' },
    });
    const affiliation = await unscopedPrisma.affiliation.create({
      data: { tenantId: tid, partyId: leaver.id, affiliationType: 'employee', counterpartyName: 'Kaizen', roleSlug: 'employee', status: 'active' },
    });

    const asset = await asUser('operations@kaizen.co.in', () => createAsset({ tag, kind: 'laptop' }));
    await asUser('operations@kaizen.co.in', () => assignAsset(asset.id, { partyId: leaver.id }));

    // Nothing to flag while the affiliation is still active.
    await asUser('operations@kaizen.co.in', () => runOrphanedAssetDetector());
    let exceptions = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: tid, subjectType: 'it_asset', subjectId: asset.id, code: 'IT_AST_ORPHANED' } });
    expect(exceptions).toHaveLength(0);

    // The affiliation ends — the exit checklist's technology half.
    await unscopedPrisma.affiliation.update({ where: { id: affiliation.id }, data: { status: 'ended' } });

    const result = await asUser('operations@kaizen.co.in', () => runOrphanedAssetDetector());
    expect(result.flagged).toBeGreaterThanOrEqual(1);

    exceptions = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: tid, subjectType: 'it_asset', subjectId: asset.id, code: 'IT_AST_ORPHANED' } });
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].subjectId).toBe(asset.id);

    // Idempotent: a second run does not duplicate the open exception.
    await asUser('operations@kaizen.co.in', () => runOrphanedAssetDetector());
    exceptions = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: tid, subjectType: 'it_asset', subjectId: asset.id, code: 'IT_AST_ORPHANED' } });
    expect(exceptions).toHaveLength(1);
  });

  it('the in-repair-too-long detector fires once past the seeded threshold and is idempotent', async () => {
    const tag = `AST-REPAIR-${stamp()}`;
    const asset = await asUser('operations@kaizen.co.in', () => createAsset({ tag, kind: 'desktop' }));
    await asUser('operations@kaizen.co.in', () => transitionAsset(asset.id, 'SEND_TO_REPAIR'));

    // Backdate inRepairSince past the seeded 14-day threshold.
    const since = new Date();
    since.setDate(since.getDate() - 20);
    await unscopedPrisma.itAsset.update({ where: { id: asset.id }, data: { inRepairSince: since } });

    const first = await asUser('operations@kaizen.co.in', () => runInRepairTooLongDetector());
    expect(first.flagged).toBeGreaterThanOrEqual(1);

    const exceptions = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: tid, subjectType: 'it_asset', subjectId: asset.id, code: 'IT_AST_REPAIR_OVERDUE' } });
    expect(exceptions).toHaveLength(1);

    await asUser('operations@kaizen.co.in', () => runInRepairTooLongDetector());
    const exceptionsAfter = await unscopedPrisma.exceptionRecord.findMany({ where: { tenantId: tid, subjectType: 'it_asset', subjectId: asset.id, code: 'IT_AST_REPAIR_OVERDUE' } });
    expect(exceptionsAfter).toHaveLength(1);

    await asUser('operations@kaizen.co.in', () => transitionAsset(asset.id, 'RETIRE'));
    await asUser('operations@kaizen.co.in', () => transitionAsset(asset.id, 'DISPOSE'));
  });

  it('events: a repair note or audit sighting is recorded against the asset, append-only', async () => {
    const tag = `AST-EVT-${stamp()}`;
    const asset = await asUser('operations@kaizen.co.in', () => createAsset({ tag, kind: 'server' }));
    await asUser('operations@kaizen.co.in', () => addAssetEvent(asset.id, { kind: 'audit', detail: 'Sighted in server room during Q3 audit.' }));
    await asUser('operations@kaizen.co.in', () => addAssetEvent(asset.id, { kind: 'note', detail: 'Firmware updated.' }));

    const detail = await asUser('operations@kaizen.co.in', () => assetDetail(asset.id));
    expect(detail.events.length).toBeGreaterThanOrEqual(2);
    expect(detail.events.some((e) => e.kind === 'audit')).toBe(true);
  });

  it('the summary reports counts and "not yet measured" only when a tenant has none', async () => {
    const s = await asUser('operations@kaizen.co.in', () => summary());
    expect(s.notYetMeasured).toBe(false);
    expect(s.total).toBeGreaterThan(0);
    expect(Object.values(s.byStatus).reduce((a, b) => a + b, 0)).toBe(s.total);
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('assets — permissions', () => {
  it('an employee cannot create an asset — their it_assets grant is V@own, view only', async () => {
    const rejection = await expectReject(() =>
      asUser('employee@kaizen.co.in', () => createAsset({ tag: `AST-DENY-${stamp()}`, kind: 'laptop' })),
    );
    expect(rejection.status).toBe(403);
  });

  it('the Finance Head holds view and financial on assets, but not edit — cannot assign or transition one', async () => {
    const asset = await asUser('operations@kaizen.co.in', () => createAsset({ tag: `AST-FIN-${stamp()}`, kind: 'laptop' }));

    const rejection = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => transitionAsset(asset.id, 'RETIRE')),
    );
    expect(rejection.status).toBe(403);

    // Finance can still see it.
    const seen = await asUser('finance@kaizen.co.in', () => assetDetail(asset.id));
    expect(seen.id).toBe(asset.id);
  });

  it('the chairman holds every resource, every verb, every scope', async () => {
    const asset = await asUser('chairman@kaizen.co.in', () => createAsset({ tag: `AST-CHAIR-${stamp()}`, kind: 'phone' }));
    const seen = await asUser('chairman@kaizen.co.in', () => listAssets());
    expect(seen.some((a) => a.id === asset.id)).toBe(true);
  });

  it('cannot request a lifecycle event that has its own dedicated endpoint (ASSIGN/RETURN) through /transition', async () => {
    const asset = await asUser('operations@kaizen.co.in', () => createAsset({ tag: `AST-DEDIC-${stamp()}`, kind: 'laptop' }));
    const rejection = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => transitionAsset(asset.id, 'ASSIGN' as never)),
    );
    expect(rejection.status).toBe(400);
  });

  it('assigning and returning need the `assign` verb, not `edit` — a fixture role holding VCE cannot assign', async () => {
    const asset = await asUser('operations@kaizen.co.in', () => createAsset({ tag: `AST-NOASSIGN-${stamp()}`, kind: 'laptop' }));

    const rejection = await withFixtureRole(
      { grants: [{ resource: 'it_assets', verbs: ['view', 'create', 'edit'], scope: 'all' }] },
      () => expectReject(() => assignAsset(asset.id, { partyId: 'someone-or-other' })),
    );
    expect(rejection.status).toBe(403);

    // The Operations Head's cell (VCEDAX) does hold `assign` and succeeds.
    const tid = await tenantId();
    const throwaway = await unscopedPrisma.person.create({
      data: { tenantId: tid, recordCode: `PER-ASSIGNEE-${stamp()}`, fullName: 'Throwaway Assignee', source: 'test' },
    });
    const assigned = await asUser('operations@kaizen.co.in', () => assignAsset(asset.id, { partyId: throwaway.id }));
    expect(assigned.status).toBe('assigned');
    await asUser('operations@kaizen.co.in', () => returnAsset(asset.id));
  });

  it('the summary is a fleet-wide aggregate: an employee holding it_assets:V@own gets a summary narrowed to their own assets, never fleet-wide topHolders or bookValue', async () => {
    const s = stamp();
    const tid = await tenantId();
    const outsider = await unscopedPrisma.person.create({
      data: { tenantId: tid, recordCode: `PER-SUM-${s}`, fullName: `Summary Outsider ${s}`, source: 'test' },
    });
    await unscopedPrisma.affiliation.create({
      data: { tenantId: tid, partyId: outsider.id, affiliationType: 'employee', counterpartyName: 'Kaizen', roleSlug: 'employee', status: 'active' },
    });

    const employeeParty = await asUser('employee@kaizen.co.in', async (p) => p.partyId);

    const mineCost = 913001;
    const otherCost = 913002;
    const mine = await asUser('operations@kaizen.co.in', () => createAsset({ tag: `AST-SUM-MINE-${s}`, kind: 'laptop', purchaseCost: mineCost }));
    const other = await asUser('operations@kaizen.co.in', () => createAsset({ tag: `AST-SUM-OTHER-${s}`, kind: 'laptop', purchaseCost: otherCost }));
    await asUser('operations@kaizen.co.in', () => assignAsset(mine.id, { partyId: employeeParty }));
    await asUser('operations@kaizen.co.in', () => assignAsset(other.id, { partyId: outsider.id }));

    const employeeSummary = await asUser('employee@kaizen.co.in', () => summary());
    expect(employeeSummary.notYetMeasured).toBe(false);
    expect(employeeSummary.total).toBe(1);
    expect(employeeSummary.bookValue).toBe(mineCost);
    expect(employeeSummary.bookValue).not.toBe(mineCost + otherCost);
    for (const h of employeeSummary.topHolders) expect(h.partyId).toBe(employeeParty);
    expect(employeeSummary.topHolders.some((h) => h.partyId === outsider.id)).toBe(false);

    // Operations, holding it_assets:V@all, sees the whole fleet — strictly
    // more than the employee's own slice.
    const opsSummary = await asUser('operations@kaizen.co.in', () => summary());
    expect(opsSummary.bookValue).toBeGreaterThanOrEqual(mineCost + otherCost);

    await asUser('operations@kaizen.co.in', () => returnAsset(mine.id));
    await asUser('operations@kaizen.co.in', () => returnAsset(other.id));
  });
});
