/**
 * The group (bounded context `eqt`) — equity-portal plan §3.3, §5 "Group",
 * §6 phase 2.
 *
 * The tenant gate stays absolute (§3.3, the load-bearing decision of the
 * whole plan): a subsidiary PUBLISHES a summary of itself — `EntitySnapshot`
 * — into its parent's tenant, and the group screen reads only that row. No
 * function below `// ==== Publisher ====` ever changes which tenant a
 * request is running in; every function below it reads exclusively from
 * `prisma.entitySnapshot`, scoped to the caller's own (holding) tenant, plus
 * that tenant's own live figures where the plan calls for them (§6 item 2 —
 * "the holding tenant's OWN summary shown beside the others").
 *
 * `unscopedPrisma` and `asSystem` (crossing into another tenant's context)
 * appear ONLY inside the publisher section. `EQT-GRP-001` greps this file to
 * hold that boundary, the same way `CRM-FOUND-004` greps for a role-slug
 * comparison.
 */

import { createHash } from 'node:crypto';
import {
  EVENTS,
  DIVISIONS,
  DIVISION_LABELS,
  GROUP_LABELS,
  GROUP_SBO_THRESHOLD_PCT,
  GROUP_SNAPSHOT_STALE_HOURS,
  groupEntityBadge,
  holderKeyFor,
  computeLookThrough,
  type LookThroughDirectRow,
  type LookThroughEdge,
  type LookThroughMatch,
  type GroupStructureNodeView,
  type GroupStructureEdgeView,
  type GroupHolderRowView,
  type GroupEntityFinancialView,
  type GroupComplianceRowView,
  round2,
} from '@kaizen/shared';
import { prisma, unscopedPrisma, num } from '../platform/db.js';
import { currentAuth, asSystem } from '../platform/context.js';
import { assertCan, assertScopeAll } from '../platform/permissions.js';
import { ApiError } from '../platform/errors.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { capTable, listShareClasses, listValuations } from './equity.js';
import { companyProfile } from './companyProfile.js';
import { headcountByDivision } from './employment.js';
import { profitAndLoss, cashPosition } from './books.js';

// ---------------------------------------------------------------------------
// Shared helpers (no unscoped client — used both by the publisher, inside a
// tenant's own `asSystem` context, and by the read model, inside a normal
// request context; either way they only ever touch `currentAuth().tenantId`'s
// own rows).
// ---------------------------------------------------------------------------

function panHash(pan: string): string {
  return createHash('sha256').update(pan.trim().toUpperCase()).digest('hex');
}

interface HolderKeyMeta {
  holderId: string;
  kind: string;
  heldByTenantId: string | null;
  folioNumber: string;
  holderKey: string | null;
  matchedBy: LookThroughMatch;
}

/** Every holder of the current tenant, with its cross-tenant `holderKey` resolved. */
async function buildHolderKeyIndex(): Promise<Map<string, HolderKeyMeta>> {
  const auth = currentAuth();
  const holders = await prisma.holder.findMany({ where: { tenantId: auth.tenantId, deletedAt: null } });
  const personIds = holders.filter((h) => h.kind === 'person' && h.personId).map((h) => h.personId!);
  const people = personIds.length
    ? await prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, primaryEmail: true } })
    : [];
  const emailByPersonId = new Map(people.map((p) => [p.id, p.primaryEmail]));

  const out = new Map<string, HolderKeyMeta>();
  for (const h of holders) {
    const email = h.kind === 'person' && h.personId ? emailByPersonId.get(h.personId) ?? null : null;
    const { key, matchedBy } = holderKeyFor({ email, panHash: h.panNumber ? panHash(h.panNumber) : null });
    out.set(h.id, { holderId: h.id, kind: h.kind, heldByTenantId: h.heldByTenantId, folioNumber: h.folioNumber, holderKey: key, matchedBy });
  }
  return out;
}

function lastCompleteMonthKey(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed; -1 for last month
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Every month of the financial year (April–March) from its start to `cutoffPeriod`, inclusive. */
function fiscalYearToDatePeriods(cutoffPeriod: string): string[] {
  const [y, m] = cutoffPeriod.split('-').map(Number);
  const fyStartYear = m >= 4 ? y : y - 1;
  const periods: string[] = [];
  let py = fyStartYear;
  let pm = 4;
  while (py < y || (py === y && pm <= m)) {
    periods.push(`${py}-${String(pm).padStart(2, '0')}`);
    pm += 1;
    if (pm > 12) {
      pm = 1;
      py += 1;
    }
  }
  return periods;
}

function sumPnl(rows: Array<{ income: number; expense: number; net: number }>): { income: number; expense: number; net: number } {
  const income = round2(rows.reduce((s, r) => s + r.income, 0));
  const expense = round2(rows.reduce((s, r) => s + r.expense, 0));
  return { income, expense, net: round2(income - expense) };
}

async function intercompanyTotals(): Promise<{ in: number; out: number }> {
  const auth = currentAuth();
  const rows = await prisma.transaction.groupBy({
    by: ['direction'],
    where: { tenantId: auth.tenantId, deletedAt: null, intercompanyTenantId: { not: null } },
    _sum: { amount: true },
  });
  const inflow = rows.find((r) => r.direction === 'in');
  const outflow = rows.find((r) => r.direction === 'out');
  return { in: num(inflow?._sum.amount) ?? 0, out: num(outflow?._sum.amount) ?? 0 };
}

/** Two months, per SH-1 — mirrors `equity.ts`'s own window; kept local since that constant is not exported. */
const CERTIFICATE_WINDOW_DAYS = 60;

async function certificateOverdueCount(): Promise<number> {
  const auth = currentAuth();
  const cutoff = new Date(Date.now() - CERTIFICATE_WINDOW_DAYS * 86_400_000);
  const overdue = await prisma.shareTransaction.findMany({
    where: { tenantId: auth.tenantId, status: 'effective', type: { in: ['allotment', 'transfer'] }, effectiveOn: { lt: cutoff } },
    select: { id: true, toHolderId: true, shareClassId: true },
  });
  let count = 0;
  for (const t of overdue) {
    if (!t.toHolderId) continue;
    const covering = await prisma.shareCertificate.findFirst({
      where: { tenantId: auth.tenantId, holderId: t.toHolderId, shareClassId: t.shareClassId, issuedForTransactionId: t.id },
    });
    if (!covering) count += 1;
  }
  return count;
}

function stalenessOf(publishedAt: Date, now = Date.now()): { staleSeconds: number; stale: boolean } {
  const staleSeconds = Math.max(0, Math.floor((now - publishedAt.getTime()) / 1000));
  return { staleSeconds, stale: staleSeconds > GROUP_SNAPSHOT_STALE_HOURS * 3600 };
}

// ===========================================================================
// ==== Publisher ====
//
// Everything in this section runs a source tenant's own read functions
// under `asSystem(sourceTenantId)`, then writes the result into the PARENT
// tenant under `asSystem(parentTenantId)`. This is the one place in the
// whole `eqt` domain a request's tenant context changes mid-call (plan
// §3.3): a subsidiary publishes; nothing ever reaches across to read one.
// ===========================================================================

interface BuiltSnapshot {
  sourceTenantId: string;
  sourceSlug: string;
  sourceName: string;
  originDivision: string | null;
  asOf: Date;
  sourceEventHash: string | null;
  capTable: Record<string, unknown>;
  shareClasses: unknown;
  board: { available: false };
  financial: Record<string, unknown>;
  compliance: Record<string, unknown>;
  valuation: unknown;
}

/**
 * Composes the JSON blocks of a subsidiary's summary, entirely from calls
 * inside that subsidiary's own tenant — `capTable()`, `listShareClasses()`,
 * `profitAndLoss()`, `cashPosition()`, `headcountByDivision()`,
 * `companyProfile()`, the latest `Valuation` — the same functions its own
 * screens use. Nothing here writes anywhere; `publishEntitySnapshot` does
 * the writing, in the parent.
 */
export async function buildEntitySnapshot(sourceTenantId: string): Promise<BuiltSnapshot> {
  return asSystem(sourceTenantId, async () => {
    const tenant = await unscopedPrisma.tenant.findFirstOrThrow({ where: { id: sourceTenantId } });

    const [cap, classes, holderIndex, profile, headcount, valuations, latestEvent, intercompany, overdue, cash] = await Promise.all([
      capTable(),
      listShareClasses(),
      buildHolderKeyIndex(),
      companyProfile(),
      headcountByDivision(),
      listValuations(),
      prisma.eventRecord.findFirst({ where: { tenantId: sourceTenantId }, orderBy: { recordedAt: 'desc' }, select: { hash: true } }),
      intercompanyTotals(),
      certificateOverdueCount(),
      cashPosition(),
    ]);

    const holders = [...holderIndex.values()];

    const cutoffMonth = lastCompleteMonthKey();
    const pnlMonth = await profitAndLoss(cutoffMonth);
    const fyPeriods = fiscalYearToDatePeriods(cutoffMonth);
    const pnlByPeriod = await Promise.all(fyPeriods.map((p) => profitAndLoss(p)));
    const pnlFyToDate = sumPnl(pnlByPeriod);

    const config = (tenant.config as { originDivision?: string } | null) ?? {};

    return {
      sourceTenantId,
      sourceSlug: tenant.slug,
      sourceName: tenant.name,
      originDivision: config.originDivision ?? null,
      asOf: new Date(),
      sourceEventHash: latestEvent?.hash ?? null,
      capTable: { ...cap, holders },
      shareClasses: classes,
      board: { available: false },
      financial: {
        period: cutoffMonth,
        cash: cash.cash,
        pnlMonth: { income: pnlMonth.income, expense: pnlMonth.expense, net: pnlMonth.net, byDivision: pnlMonth.byDivision },
        pnlFyToDate,
        headcount,
        intercompany,
      },
      compliance: {
        dematStatus: profile.dematStatus ?? null,
        isSmallCompany: profile.isSmallCompany ?? null,
        certificateOverdueCount: overdue,
        kind: tenant.kind,
      },
      valuation: valuations[0] ?? null,
    };
  });
}

/**
 * Builds, then writes into the parent (skipping silently when the tenant has
 * no parent — most tenants never publish) and emits `kz.eqt.snapshot.
 * published` in both tenants. Kept idempotent per `sourceTenantId`
 * (`@@unique([tenantId, sourceTenantId])` on `EntitySnapshot`) so a retried
 * job tick or a second manual publish overwrites the same row rather than
 * accumulating duplicates; the full history survives regardless, in
 * `EntitySnapshotHistory`.
 */
export async function publishEntitySnapshot(sourceTenantId: string): Promise<{ published: boolean; parentTenantId: string | null }> {
  const source = await unscopedPrisma.tenant.findFirst({ where: { id: sourceTenantId } });
  if (!source) throw ApiError.notFound('Tenant');
  if (!source.parentTenantId) return { published: false, parentTenantId: null };
  const parentTenantId = source.parentTenantId;

  const built = await buildEntitySnapshot(sourceTenantId);

  await asSystem(parentTenantId, async () => {
    const existing = await prisma.entitySnapshot.findFirst({ where: { tenantId: parentTenantId, sourceTenantId } });
    const shared = {
      sourceTenantId: built.sourceTenantId,
      sourceSlug: built.sourceSlug,
      sourceName: built.sourceName,
      originDivision: built.originDivision,
      asOf: built.asOf,
      sourceEventHash: built.sourceEventHash,
      capTable: built.capTable as never,
      shareClasses: built.shareClasses as never,
      board: built.board as never,
      financial: built.financial as never,
      compliance: built.compliance as never,
      valuation: (built.valuation ?? undefined) as never,
      publishedAt: new Date(),
    };

    const row = existing
      ? await prisma.entitySnapshot.update({ where: { id: existing.id }, data: shared })
      : await prisma.entitySnapshot.create({ data: { tenantId: parentTenantId, recordCode: await nextRecordCode('ESN'), ...shared } });

    await prisma.entitySnapshotHistory.create({
      data: { tenantId: parentTenantId, recordCode: await nextRecordCode('ESN'), ...shared },
    });

    await emit({
      name: EVENTS.SNAPSHOT_PUBLISHED,
      subject: { entityType: 'entity_snapshot', entityId: row.id, recordCode: row.recordCode },
      newState: { sourceTenantId, asOf: built.asOf.toISOString() },
    });
  });

  await asSystem(sourceTenantId, async () => {
    await emit({
      name: EVENTS.SNAPSHOT_PUBLISHED,
      subject: { entityType: 'tenant', entityId: sourceTenantId, recordCode: source.slug },
      newState: { parentTenantId, asOf: built.asOf.toISOString() },
    });

    const t = await prisma.tenant.findFirstOrThrow({ where: { id: sourceTenantId } });
    const config = (t.config as Record<string, unknown>) ?? {};
    if (config.snapshotDirty) {
      await prisma.tenant.update({ where: { id: sourceTenantId }, data: { config: { ...config, snapshotDirty: false } as never } });
    }
  });

  return { published: true, parentTenantId };
}

/** `POST /group/publish` — a subsidiary publishing itself, right now. */
export async function publishNow(): Promise<{ published: boolean; parentTenantId: string | null }> {
  const auth = currentAuth();
  await assertCan({ resource: 'group', verb: 'create' });
  return publishEntitySnapshot(auth.tenantId);
}

/**
 * `POST /group/refresh` — the holding asks every child to publish its own
 * summary. This still never reads a child's tables from here: each call
 * into `publishEntitySnapshot` re-enters the child's own context to build
 * its figures, exactly as the scheduled job does, and only the resulting
 * snapshot ever lands in this (the caller's) tenant.
 */
export async function refreshGroup(): Promise<{ published: number; skipped: number }> {
  const auth = currentAuth();
  await assertCan({ resource: 'group', verb: 'create' });

  const children = await unscopedPrisma.tenant.findMany({ where: { parentTenantId: auth.tenantId } });
  let published = 0;
  for (const child of children) {
    const result = await publishEntitySnapshot(child.id);
    if (result.published) published += 1;
  }
  return { published, skipped: children.length - published };
}

// ===========================================================================
// ==== End publisher ====
// Everything below reads only `prisma.entitySnapshot` (scoped to the
// caller's own tenant) plus that tenant's own live figures. No cross-tenant
// read, ever — that is what publication above is for.
// ===========================================================================

export async function groupStructure() {
  const auth = currentAuth();
  await assertCan({ resource: 'group', verb: 'view' });
  await assertScopeAll('group');

  const tenant = await prisma.tenant.findFirstOrThrow({ where: { id: auth.tenantId } });
  const snapshots = await prisma.entitySnapshot.findMany({ where: { tenantId: auth.tenantId }, orderBy: { sourceName: 'asc' } });

  const nodes: GroupStructureNodeView[] = [
    {
      tenantId: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      kind: tenant.kind as GroupStructureNodeView['kind'],
      originDivision: null,
      badge: null,
      layerDepth: 0,
      layerLimitExceeded: false,
      asOf: null,
      publishedAt: null,
      staleSeconds: null,
      stale: false,
    },
  ];
  const edges: GroupStructureEdgeView[] = [];
  const claimedDivisions = new Set<string>();

  for (const snap of snapshots) {
    if (snap.originDivision) claimedDivisions.add(snap.originDivision);
    const cap = snap.capTable as unknown as {
      holderTotals: Array<{ holderId: string; issuedPct: number; fullyDilutedPct: number }>;
      holders: Array<{ holderId: string; heldByTenantId: string | null }>;
    };
    const holderRow = (cap.holders ?? []).find((h) => h.heldByTenantId === auth.tenantId);
    const totals = holderRow ? (cap.holderTotals ?? []).find((t) => t.holderId === holderRow.holderId) : null;
    const issuedPct = totals?.issuedPct ?? 0;
    const fullyDilutedPct = totals?.fullyDilutedPct ?? 0;
    const badge = groupEntityBadge(issuedPct);
    const { staleSeconds, stale } = stalenessOf(snap.publishedAt);

    // Depth is always 1 at this phase: a snapshot is one hop (the direct
    // child's own summary), and a grandchild's stake in its own parent lives
    // in a snapshot this tenant never receives — the two-layer check applies
    // once snapshots themselves start relaying deeper structure.
    nodes.push({
      tenantId: snap.sourceTenantId,
      slug: snap.sourceSlug,
      name: snap.sourceName,
      kind: 'subsidiary',
      originDivision: snap.originDivision,
      badge,
      layerDepth: 1,
      layerLimitExceeded: false,
      asOf: snap.asOf.toISOString(),
      publishedAt: snap.publishedAt.toISOString(),
      staleSeconds,
      stale,
    });

    edges.push({ parentTenantId: tenant.id, childTenantId: snap.sourceTenantId, issuedPct, fullyDilutedPct, badge });
  }

  for (const division of DIVISIONS) {
    if (tenant.kind !== 'holding') break; // the "not yet incorporated" nodes are a holding's own divisions, not any tenant's
    if (division === 'shared') continue;
    if (claimedDivisions.has(division)) continue;
    nodes.push({
      tenantId: null,
      slug: null,
      name: DIVISION_LABELS[division],
      kind: 'not_yet_incorporated',
      originDivision: division,
      badge: 'not_yet_incorporated',
      layerDepth: 1,
      layerLimitExceeded: false,
      asOf: null,
      publishedAt: null,
      staleSeconds: null,
      stale: false,
    });
  }

  return { self: { tenantId: tenant.id, slug: tenant.slug, name: tenant.name, kind: tenant.kind }, nodes, edges };
}

export async function groupHolders() {
  const auth = currentAuth();
  await assertCan({ resource: 'group', verb: 'view' });
  await assertScopeAll('group');

  const tenant = await prisma.tenant.findFirstOrThrow({ where: { id: auth.tenantId } });
  const snapshots = await prisma.entitySnapshot.findMany({ where: { tenantId: auth.tenantId } });

  const ownCap = await capTable();
  const ownIndex = await buildHolderKeyIndex();

  const direct: LookThroughDirectRow[] = [];
  const edges: LookThroughEdge[] = [];
  const displayNames = new Map<string, string>();

  for (const total of ownCap.holderTotals) {
    const meta = ownIndex.get(total.holderId);
    if (!meta?.holderKey) continue;
    direct.push({ entityId: tenant.id, holderKey: meta.holderKey, issuedPct: total.issuedPct, fullyDilutedPct: total.fullyDilutedPct, matchedBy: meta.matchedBy });
    displayNames.set(meta.holderKey, total.holderName);
  }

  for (const snap of snapshots) {
    const cap = snap.capTable as unknown as {
      holderTotals: Array<{ holderId: string; holderName: string; issuedPct: number; fullyDilutedPct: number }>;
      holders: Array<{ holderId: string; heldByTenantId: string | null; holderKey: string | null; matchedBy: LookThroughMatch }>;
    };
    const metaById = new Map((cap.holders ?? []).map((h) => [h.holderId, h]));
    let parentIssuedPct = 0;
    let parentFullyDilutedPct = 0;

    for (const total of cap.holderTotals ?? []) {
      const meta = metaById.get(total.holderId);
      if (meta?.heldByTenantId === tenant.id) {
        parentIssuedPct = total.issuedPct;
        parentFullyDilutedPct = total.fullyDilutedPct;
        continue; // becomes the structure edge, not a holder row
      }
      if (!meta?.holderKey) continue;
      direct.push({ entityId: snap.sourceTenantId, holderKey: meta.holderKey, issuedPct: total.issuedPct, fullyDilutedPct: total.fullyDilutedPct, matchedBy: meta.matchedBy });
      if (!displayNames.has(meta.holderKey)) displayNames.set(meta.holderKey, total.holderName);
    }

    edges.push({ parentEntityId: tenant.id, childEntityId: snap.sourceTenantId, issuedPct: parentIssuedPct, fullyDilutedPct: parentFullyDilutedPct });
  }

  const lookThrough = computeLookThrough(direct, edges);

  type Stake = { directIssuedPct: number; directFullyDilutedPct: number; lookThroughIssuedPct: number; lookThroughFullyDilutedPct: number; matchedBy: LookThroughMatch };
  const perEntity = new Map<string, Stake>();
  const stakeKey = (e: string, h: string) => `${e}::${h}`;

  for (const d of direct) {
    perEntity.set(stakeKey(d.entityId, d.holderKey), {
      directIssuedPct: d.issuedPct,
      directFullyDilutedPct: d.fullyDilutedPct,
      lookThroughIssuedPct: d.issuedPct,
      lookThroughFullyDilutedPct: d.fullyDilutedPct,
      matchedBy: d.matchedBy,
    });
  }
  for (const row of lookThrough) {
    const key = stakeKey(row.entityId, row.holderKey);
    const existing = perEntity.get(key) ?? {
      directIssuedPct: 0,
      directFullyDilutedPct: 0,
      lookThroughIssuedPct: 0,
      lookThroughFullyDilutedPct: 0,
      matchedBy: row.matchedBy,
    };
    existing.lookThroughIssuedPct = row.issuedPct;
    existing.lookThroughFullyDilutedPct = row.fullyDilutedPct;
    perEntity.set(key, existing);
  }

  const byHolder = new Map<string, GroupHolderRowView>();
  for (const [key, stake] of perEntity) {
    const [entityId, holderKey] = key.split('::');
    const row = byHolder.get(holderKey) ?? { holderKey, displayName: displayNames.get(holderKey) ?? holderKey, perEntity: {}, sbo: false };
    row.perEntity[entityId] = stake;
    if (stake.lookThroughFullyDilutedPct >= GROUP_SBO_THRESHOLD_PCT) row.sbo = true;
    byHolder.set(holderKey, row);
  }

  return {
    entities: [{ tenantId: tenant.id, name: tenant.name }, ...snapshots.map((s) => ({ tenantId: s.sourceTenantId, name: s.sourceName }))],
    holders: [...byHolder.values()],
  };
}

export async function groupFinancials() {
  const auth = currentAuth();
  await assertCan({ resource: 'group', verb: 'view' });
  await assertScopeAll('group');

  const tenant = await prisma.tenant.findFirstOrThrow({ where: { id: auth.tenantId } });
  const snapshots = await prisma.entitySnapshot.findMany({ where: { tenantId: auth.tenantId } });

  const ownPeriod = lastCompleteMonthKey();
  const [ownCash, ownPnl, ownIntercompany, ownHeadcount] = await Promise.all([
    cashPosition(),
    profitAndLoss(ownPeriod),
    intercompanyTotals(),
    headcountByDivision(),
  ]);

  const entities: GroupEntityFinancialView[] = [
    {
      tenantId: tenant.id,
      name: tenant.name,
      period: ownPeriod,
      cash: ownCash.cash,
      pnlMonth: { income: ownPnl.income, expense: ownPnl.expense, net: ownPnl.net },
      pnlFyToDate: null,
      headcount: ownHeadcount.reduce((s, r) => s + r.headcount, 0),
      intercompanyIn: ownIntercompany.in,
      intercompanyOut: ownIntercompany.out,
      asOf: new Date().toISOString(),
    },
  ];

  for (const snap of snapshots) {
    const fin = snap.financial as unknown as {
      period: string;
      cash: number | null;
      pnlMonth: { income: number; expense: number; net: number } | null;
      pnlFyToDate: { income: number; expense: number; net: number } | null;
      headcount: Array<{ headcount: number }>;
      intercompany: { in: number; out: number } | null;
    };
    entities.push({
      tenantId: snap.sourceTenantId,
      name: snap.sourceName,
      period: fin.period,
      cash: fin.cash ?? null,
      pnlMonth: fin.pnlMonth ?? null,
      pnlFyToDate: fin.pnlFyToDate ?? null,
      headcount: Array.isArray(fin.headcount) ? fin.headcount.reduce((s, r) => s + r.headcount, 0) : 0,
      intercompanyIn: fin.intercompany?.in ?? null,
      intercompanyOut: fin.intercompany?.out ?? null,
      asOf: snap.asOf.toISOString(),
    });
  }

  const totalCash = entities.every((e) => e.cash != null) ? round2(entities.reduce((s, e) => s + (e.cash ?? 0), 0)) : null;
  const totalPnlMonth = entities.every((e) => e.pnlMonth) ? sumPnl(entities.map((e) => e.pnlMonth!)) : null;
  const intercompanyTotal = {
    in: round2(entities.reduce((s, e) => s + (e.intercompanyIn ?? 0), 0)),
    out: round2(entities.reduce((s, e) => s + (e.intercompanyOut ?? 0), 0)),
  };

  return {
    entities,
    totalLabel: GROUP_LABELS.totalBeforeEliminations,
    totalCash,
    totalPnlMonth,
    intercompanyTotal,
  };
}

export async function groupCompliance() {
  const auth = currentAuth();
  await assertCan({ resource: 'group', verb: 'view' });
  await assertScopeAll('group');

  const tenant = await prisma.tenant.findFirstOrThrow({ where: { id: auth.tenantId } });
  const snapshots = await prisma.entitySnapshot.findMany({ where: { tenantId: auth.tenantId } });

  const [ownProfile, ownOverdue] = await Promise.all([companyProfile(), certificateOverdueCount()]);
  const now = new Date();

  const rows: GroupComplianceRowView[] = [
    {
      tenantId: tenant.id,
      name: tenant.name,
      dematStatus: (ownProfile.dematStatus as GroupComplianceRowView['dematStatus']) ?? null,
      isSmallCompany: ownProfile.isSmallCompany ?? null,
      certificateOverdueCount: ownOverdue,
      kind: tenant.kind,
      asOf: now.toISOString(),
      publishedAt: now.toISOString(),
      staleSeconds: 0,
      stale: false,
    },
  ];

  for (const snap of snapshots) {
    const comp = snap.compliance as unknown as { dematStatus: GroupComplianceRowView['dematStatus']; isSmallCompany: boolean | null; certificateOverdueCount: number; kind: string };
    const { staleSeconds, stale } = stalenessOf(snap.publishedAt);
    rows.push({
      tenantId: snap.sourceTenantId,
      name: snap.sourceName,
      dematStatus: comp.dematStatus ?? null,
      isSmallCompany: comp.isSmallCompany ?? null,
      certificateOverdueCount: comp.certificateOverdueCount ?? 0,
      kind: comp.kind ?? 'subsidiary',
      asOf: snap.asOf.toISOString(),
      publishedAt: snap.publishedAt.toISOString(),
      staleSeconds,
      stale,
    });
  }

  return { rows };
}

/** `GET /group/entities/:sourceTenantId` — the one-snapshot, read-only view. */
export async function entitySnapshotView(sourceTenantId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'group', verb: 'view' });
  const snap = await prisma.entitySnapshot.findFirst({ where: { tenantId: auth.tenantId, sourceTenantId } });
  if (!snap) throw ApiError.notFound('Entity snapshot');
  const { staleSeconds, stale } = stalenessOf(snap.publishedAt);

  return {
    sourceTenantId: snap.sourceTenantId,
    sourceSlug: snap.sourceSlug,
    sourceName: snap.sourceName,
    originDivision: snap.originDivision,
    asOf: snap.asOf.toISOString(),
    publishedAt: snap.publishedAt.toISOString(),
    staleSeconds,
    stale,
    capTable: snap.capTable,
    shareClasses: snap.shareClasses,
    board: snap.board,
    financial: snap.financial,
    compliance: snap.compliance,
    valuation: snap.valuation,
  };
}

// ---------------------------------------------------------------------------
// Scheduled publishing (called from `jobs/scheduler.ts`)
// ---------------------------------------------------------------------------

/** Publishes every tenant flagged `config.snapshotDirty` since the last tick. Runs as SYSTEM, per tenant, like every other job. */
export async function publishDirtySnapshots(): Promise<number> {
  const auth = currentAuth();
  const tenant = await prisma.tenant.findFirst({ where: { id: auth.tenantId } });
  const config = (tenant?.config as { snapshotDirty?: boolean } | null) ?? {};
  if (!config.snapshotDirty) return 0;
  const result = await publishEntitySnapshot(auth.tenantId);
  return result.published ? 1 : 0;
}

/** The nightly full publish, regardless of the dirty flag — the backstop against a missed subscriber. */
export async function publishNightlySnapshot(): Promise<number> {
  const auth = currentAuth();
  const result = await publishEntitySnapshot(auth.tenantId);
  return result.published ? 1 : 0;
}

/** Marks the current tenant's snapshot as needing a fresh publish. Called by the `kz.eqt.*` subscribers in `events/handlers.ts`. */
export async function markSnapshotDirty(tenantId: string): Promise<void> {
  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId } });
  if (!tenant) return;
  const config = (tenant.config as Record<string, unknown>) ?? {};
  if (config.snapshotDirty === true) return;
  await prisma.tenant.update({ where: { id: tenantId }, data: { config: { ...config, snapshotDirty: true } as never } });
}
