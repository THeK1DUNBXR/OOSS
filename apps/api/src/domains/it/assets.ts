/**
 * Technology — assets and devices (docs/plan/cio.md, workstream A).
 *
 * `ItAsset` is the IT half of a device: serial, warranty, location, who is
 * holding it and what state it is in. `FixedAsset` (main.prisma) stays the
 * books' capital register — this file only ever reads it by bare
 * `fixedAssetId`, never duplicates its cost (Principle 8).
 *
 * The lifecycle `in_stock -> assigned -> in_repair -> retired -> disposed`
 * runs through `itAssetMachine` (`packages/shared/src/it/assets.ts`):
 * `transitionAsset` is the one place a status changes, so a button on the web
 * page can never offer a move the machine does not allow. Assigning and
 * returning are their own functions rather than plain transitions because
 * each one also writes an `ItAssetAssignment` row — an append-only hand-over
 * log a status change alone cannot express (Principle 5).
 *
 * Scope is real: an employee's `it_assets:V@own` grant narrows both the list
 * and detail reads against `holderPartyId`, mapped as the owning field for
 * the WHERE axis exactly the way `visibilityWhere`/`assertCan` expect.
 */

import {
  EVENTS,
  IT_DOMAIN,
  IT_ASSET_EVENT_VERB,
  IT_ASSET_KINDS,
  IT_ASSET_CONDITIONS,
  daysInRepair,
  daysUntil,
  itAssetMachine,
  warrantyRung,
  assetBookValue,
  type ItAssetLifecycleEvent,
  type ItAssetStatus,
} from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { availableTransitions } from '../../platform/lifecycle.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, assertScopeAll, visibilityWhere } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';

function assertValidKind(kind: string): void {
  if (!(IT_ASSET_KINDS as readonly string[]).includes(kind)) {
    throw ApiError.badRequest(`'${kind}' is not a kind an asset can be. Choose one of: ${IT_ASSET_KINDS.join(', ')}.`);
  }
}

function assertValidCondition(condition: string | null | undefined): void {
  if (condition == null) return;
  if (!(IT_ASSET_CONDITIONS as readonly string[]).includes(condition)) {
    throw ApiError.badRequest(`'${condition}' is not a condition an asset can carry. Choose one of: ${IT_ASSET_CONDITIONS.join(', ')}.`);
  }
}

registerGovernedEntities('it_assets', ['it_asset', 'it_asset_assignment', 'it_asset_event']);

const RESOURCE = 'it_assets';

// ---------------------------------------------------------------------------
// Thresholds (dated table — Principle 4)
// ---------------------------------------------------------------------------

export interface AssetThresholds {
  warrantyRungs: number[];
  repairDaysThreshold: number;
}

/** The threshold row in force now: the latest `effectiveFrom` at or before
 * `at`. Falls back to the shared defaults only when the tenant has no row at
 * all yet (a fresh tenant before the seed has run). */
export async function currentThresholds(at: Date = new Date()): Promise<AssetThresholds> {
  const auth = currentAuth();
  const row = await prisma.itAssetThreshold.findFirst({
    where: { tenantId: auth.tenantId, code: 'DEFAULT', effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!row) return { warrantyRungs: [90, 30, 7, 0], repairDaysThreshold: 14 };
  return { warrantyRungs: row.warrantyRungs, repairDaysThreshold: row.repairDaysThreshold };
}

// ---------------------------------------------------------------------------
// Create / read
// ---------------------------------------------------------------------------

export interface CreateAssetInput {
  tag: string;
  kind: string;
  make?: string | null;
  model?: string | null;
  serial?: string | null;
  purchaseDate?: Date | null;
  purchaseCost?: number | null;
  warrantyEnd?: Date | null;
  supplierName?: string | null;
  vendorId?: string | null;
  location?: string | null;
  division?: string | null;
  fixedAssetId?: string | null;
  condition?: string | null;
  notes?: string | null;
}

export async function createAsset(input: CreateAssetInput) {
  await assertCan({ resource: RESOURCE, verb: 'create' });

  const tag = input.tag?.trim();
  if (!tag) throw ApiError.badRequest('An asset needs a tag — how it gets referred to on the floor.');
  if (!input.kind) throw ApiError.badRequest('An asset needs a kind.');
  assertValidKind(input.kind);
  assertValidCondition(input.condition ?? null);

  const auth = currentAuth();
  const existing = await prisma.itAsset.findFirst({ where: { tenantId: auth.tenantId, tag } });
  if (existing) throw ApiError.conflict(`An asset already carries the tag '${tag}' (${existing.recordCode}).`);

  const recordCode = await nextRecordCode('ITA');
  const asset = await prisma.itAsset.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      tag,
      kind: input.kind,
      make: input.make ?? null,
      model: input.model ?? null,
      serial: input.serial ?? null,
      purchaseDate: input.purchaseDate ?? null,
      purchaseCost: input.purchaseCost ?? null,
      warrantyEnd: input.warrantyEnd ?? null,
      supplierName: input.supplierName ?? null,
      vendorId: input.vendorId ?? null,
      location: input.location ?? null,
      division: input.division ?? null,
      fixedAssetId: input.fixedAssetId ?? null,
      condition: input.condition ?? null,
      notes: input.notes ?? null,
      status: 'in_stock',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_asset', subjectId: asset.id, after: { recordCode, tag, kind: input.kind } });
  await emit({
    name: EVENTS.IT_ASSET_CREATED,
    subject: { entityType: 'it_asset', entityId: asset.id, recordCode },
    newState: { status: asset.status, tag, kind: input.kind },
    impact: { domains: [IT_DOMAIN] },
  });

  return withTransitions(asset);
}

export interface UpdateAssetInput {
  make?: string | null;
  model?: string | null;
  serial?: string | null;
  purchaseDate?: Date | null;
  purchaseCost?: number | null;
  warrantyEnd?: Date | null;
  supplierName?: string | null;
  vendorId?: string | null;
  location?: string | null;
  division?: string | null;
  fixedAssetId?: string | null;
  condition?: string | null;
  notes?: string | null;
}

/** Edits the descriptive fields only — status moves through
 * `transitionAsset`/`assignAsset`/`returnAsset`, never through here. */
export async function updateAsset(id: string, patch: UpdateAssetInput) {
  const auth = currentAuth();
  const asset = await prisma.itAsset.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!asset) throw ApiError.notFound('Asset');

  await assertCan({ resource: RESOURCE, verb: 'edit', record: { ownerPartyId: asset.holderPartyId } });
  if (patch.condition !== undefined) assertValidCondition(patch.condition);

  const updated = await prisma.itAsset.update({
    where: { id },
    data: {
      ...(patch.make !== undefined ? { make: patch.make } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.serial !== undefined ? { serial: patch.serial } : {}),
      ...(patch.purchaseDate !== undefined ? { purchaseDate: patch.purchaseDate } : {}),
      ...(patch.purchaseCost !== undefined ? { purchaseCost: patch.purchaseCost } : {}),
      ...(patch.warrantyEnd !== undefined ? { warrantyEnd: patch.warrantyEnd, warrantyNotifiedRungs: [] } : {}),
      ...(patch.supplierName !== undefined ? { supplierName: patch.supplierName } : {}),
      ...(patch.vendorId !== undefined ? { vendorId: patch.vendorId } : {}),
      ...(patch.location !== undefined ? { location: patch.location } : {}),
      ...(patch.division !== undefined ? { division: patch.division } : {}),
      ...(patch.fixedAssetId !== undefined ? { fixedAssetId: patch.fixedAssetId } : {}),
      ...(patch.condition !== undefined ? { condition: patch.condition } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    },
  });

  await auditWrite({ action: 'update', subjectType: 'it_asset', subjectId: id, before: asset, after: updated });
  return withTransitions(updated);
}

export interface AssetFilter {
  status?: string;
  kind?: string;
  search?: string;
}

/** Resolves a set of party ids whose name matches `search`, for the holder
 * half of the search box. Cross-model lookup at the service layer, never a
 * Prisma relation across files. */
async function partyIdsMatching(search: string): Promise<string[]> {
  const auth = currentAuth();
  const people = await prisma.person.findMany({
    where: { tenantId: auth.tenantId, fullName: { contains: search, mode: 'insensitive' } },
    select: { id: true },
    take: 200,
  });
  return people.map((p) => p.id);
}

export async function listAssets(filter: AssetFilter = {}) {
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const auth = currentAuth();
  const scopeWhere = await visibilityWhere(RESOURCE, 'holderPartyId');

  let searchWhere: Record<string, unknown> | undefined;
  const search = filter.search?.trim();
  if (search) {
    const holderIds = await partyIdsMatching(search);
    searchWhere = {
      OR: [
        { tag: { contains: search, mode: 'insensitive' } },
        { serial: { contains: search, mode: 'insensitive' } },
        { make: { contains: search, mode: 'insensitive' } },
        { model: { contains: search, mode: 'insensitive' } },
        ...(holderIds.length ? [{ holderPartyId: { in: holderIds } }] : []),
      ],
    };
  }

  const rows = await prisma.itAsset.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...scopeWhere,
      ...(searchWhere ?? {}),
    },
    orderBy: { createdAt: 'desc' },
  });

  return withHolderNames(rows.map(withTransitions));
}

/** What `GET /api/it/assets/mine` — and the My IT page in another workstream
 * — read: exactly this caller's own assets, regardless of what scope their
 * `it_assets` grant otherwise carries. */
export async function myAssets() {
  await assertCan({ resource: RESOURCE, verb: 'view' });
  const auth = currentAuth();
  if (!auth.partyId) return [];
  const rows = await prisma.itAsset.findMany({
    where: { tenantId: auth.tenantId, holderPartyId: auth.partyId },
    orderBy: { createdAt: 'desc' },
  });
  return withHolderNames(rows.map(withTransitions));
}

export async function assetDetail(id: string) {
  const auth = currentAuth();
  const asset = await prisma.itAsset.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!asset) throw ApiError.notFound('Asset');
  await assertCan({ resource: RESOURCE, verb: 'view', record: { ownerPartyId: asset.holderPartyId } });

  const [assignments, events, [holderName], fixedAssetRow] = await Promise.all([
    prisma.itAssetAssignment.findMany({ where: { tenantId: auth.tenantId, assetId: id }, orderBy: { assignedAt: 'desc' } }),
    prisma.itAssetEvent.findMany({ where: { tenantId: auth.tenantId, assetId: id }, orderBy: { createdAt: 'desc' } }),
    asset.holderPartyId ? holderNames([asset.holderPartyId]) : Promise.resolve([]),
    // Cross-workstream reference resolved at the service layer, never a
    // Prisma relation across files: `fixedAssetId` is a bare id into the
    // books' capital register.
    asset.fixedAssetId
      ? prisma.fixedAsset.findFirst({
          where: { id: asset.fixedAssetId, tenantId: auth.tenantId },
          select: { id: true, recordCode: true, name: true, cost: true, disposedAt: true },
        })
      : Promise.resolve(null),
  ]);

  const partyIds = [...new Set(assignments.map((a) => a.partyId))];
  const names = await holderNames(partyIds);
  const nameOf = (partyId: string) => names.find((n) => n.id === partyId)?.fullName ?? null;

  const fixedAsset = fixedAssetRow
    ? { id: fixedAssetRow.id, recordCode: fixedAssetRow.recordCode, name: fixedAssetRow.name, cost: Number(fixedAssetRow.cost), disposedAt: fixedAssetRow.disposedAt }
    : null;

  return {
    ...withTransitions(asset),
    holderName: holderName?.fullName ?? null,
    // The books' figure when the asset is capitalised, otherwise what was
    // typed in here — never both added together (Principle 8: money stays
    // in the books).
    bookValue: fixedAsset ? fixedAsset.cost : asset.purchaseCost ? Number(asset.purchaseCost) : null,
    fixedAsset,
    assignments: assignments.map((a) => ({ ...a, holderName: nameOf(a.partyId) })),
    events,
  };
}

async function holderNames(partyIds: string[]): Promise<Array<{ id: string; fullName: string }>> {
  if (!partyIds.length) return [];
  const auth = currentAuth();
  return prisma.person.findMany({ where: { tenantId: auth.tenantId, id: { in: partyIds } }, select: { id: true, fullName: true } });
}

async function withHolderNames<T extends { holderPartyId: string | null }>(rows: T[]): Promise<Array<T & { holderName: string | null }>> {
  const ids = [...new Set(rows.map((r) => r.holderPartyId).filter((x): x is string => Boolean(x)))];
  const names = await holderNames(ids);
  return rows.map((r) => ({ ...r, holderName: r.holderPartyId ? names.find((n) => n.id === r.holderPartyId)?.fullName ?? null : null }));
}

function withTransitions<T extends { status: string }>(row: T): T & { availableTransitions: ItAssetLifecycleEvent[] } {
  return { ...row, availableTransitions: availableTransitions(itAssetMachine, row.status as ItAssetStatus) };
}

// ---------------------------------------------------------------------------
// Assign / return — append-only (IT-AST-002)
// ---------------------------------------------------------------------------

export interface AssignAssetInput {
  partyId: string;
  conditionOut?: string | null;
  note?: string | null;
}

/**
 * Hands the asset to `partyId`: writes a NEW `ItAssetAssignment` row and
 * moves the asset to `assigned`. An asset already carrying an open
 * assignment cannot be reassigned without a `RETURN` first — the machine
 * itself only allows `ASSIGN` from `in_stock`, so the invariant is structural
 * rather than a check this function has to remember to make.
 */
export async function assignAsset(id: string, input: AssignAssetInput) {
  const auth = currentAuth();
  const asset = await prisma.itAsset.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!asset) throw ApiError.notFound('Asset');
  if (!input.partyId) throw ApiError.badRequest('Assigning an asset needs who it is going to.');
  assertValidCondition(input.conditionOut ?? null);

  // A distinct grant from `edit`: an assignment hands the asset to someone,
  // and the matrix (`it_assets` cell `A`) grants that separately — an
  // editor of the asset's own fields does not automatically get to hand it
  // to a person.
  await assertCan({ resource: RESOURCE, verb: 'assign', record: { ownerPartyId: asset.holderPartyId } });
  const to = applyTransition(asset.status as ItAssetStatus, 'ASSIGN');

  const [, , updated] = await prisma.$transaction([
    prisma.itAssetAssignment.create({
      data: {
        tenantId: auth.tenantId,
        assetId: id,
        partyId: input.partyId,
        assignedById: auth.partyId,
        conditionOut: input.conditionOut ?? asset.condition ?? null,
        note: input.note ?? null,
      },
    }),
    prisma.itAssetEvent.create({
      data: {
        tenantId: auth.tenantId,
        assetId: id,
        kind: 'transition',
        detail: `Assigned to ${input.partyId}.${input.note ? ` ${input.note}` : ''}`,
        actorPartyId: auth.partyId,
      },
    }),
    prisma.itAsset.update({
      where: { id },
      data: { status: to, holderPartyId: input.partyId, condition: input.conditionOut ?? asset.condition },
    }),
  ]);

  await auditWrite({ action: 'update', subjectType: 'it_asset', subjectId: id, before: { status: asset.status }, after: { status: to, holderPartyId: input.partyId } });
  await emit({
    name: EVENTS.IT_ASSET_ASSIGNED,
    subject: { entityType: 'it_asset', entityId: id, recordCode: asset.recordCode },
    previousState: { status: asset.status },
    newState: { status: to, holderPartyId: input.partyId },
    owner: { partyId: input.partyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return withTransitions(updated);
}

export interface ReturnAssetInput {
  conditionIn?: string | null;
  note?: string | null;
  acknowledged?: boolean;
}

/**
 * Closes the currently open assignment — `returnedAt`/`conditionIn`/
 * `acknowledgedAt` are set on that SAME row, never on a new one, and the row
 * is never edited again afterwards. The asset returns to `in_stock` with no
 * holder.
 */
export async function returnAsset(id: string, input: ReturnAssetInput = {}) {
  const auth = currentAuth();
  const asset = await prisma.itAsset.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!asset) throw ApiError.notFound('Asset');
  assertValidCondition(input.conditionIn ?? null);
  // Same distinct grant as `assignAsset` — taking an asset back is the other
  // half of the same authority, not a plain edit.
  await assertCan({ resource: RESOURCE, verb: 'assign', record: { ownerPartyId: asset.holderPartyId } });

  const open = await prisma.itAssetAssignment.findFirst({
    where: { tenantId: auth.tenantId, assetId: id, returnedAt: null },
    orderBy: { assignedAt: 'desc' },
  });
  if (!open) throw ApiError.conflict(`${asset.recordCode} has no open hand-over to return.`);

  const to = applyTransition(asset.status as ItAssetStatus, 'RETURN');
  const now = new Date();

  const [, , updated] = await prisma.$transaction([
    prisma.itAssetAssignment.update({
      where: { id: open.id },
      data: {
        returnedAt: now,
        conditionIn: input.conditionIn ?? null,
        acknowledgedAt: input.acknowledged === false ? null : now,
        ...(input.note ? { note: [open.note, input.note].filter(Boolean).join(' | ') } : {}),
      },
    }),
    prisma.itAssetEvent.create({
      data: {
        tenantId: auth.tenantId,
        assetId: id,
        kind: 'transition',
        detail: `Returned by ${open.partyId}.${input.note ? ` ${input.note}` : ''}`,
        actorPartyId: auth.partyId,
      },
    }),
    prisma.itAsset.update({
      where: { id },
      data: { status: to, holderPartyId: null, condition: input.conditionIn ?? asset.condition },
    }),
  ]);

  await auditWrite({ action: 'update', subjectType: 'it_asset', subjectId: id, before: { status: asset.status, holderPartyId: asset.holderPartyId }, after: { status: to, holderPartyId: null } });
  await emit({
    name: EVENTS.IT_ASSET_RETURNED,
    subject: { entityType: 'it_asset', entityId: id, recordCode: asset.recordCode },
    previousState: { status: asset.status, holderPartyId: asset.holderPartyId },
    newState: { status: to, holderPartyId: null },
    impact: { domains: [IT_DOMAIN] },
  });

  return withTransitions(updated);
}

function applyTransition(from: ItAssetStatus, event: ItAssetLifecycleEvent): ItAssetStatus {
  if (!itAssetMachine.can(from, event)) {
    throw ApiError.unprocessable(
      `ItAsset is ${from}; ${event} is not one of its transitions. From here it accepts: ` +
        `${itAssetMachine.allowedEvents(from).join(', ') || 'nothing — this is a terminal state'}.`,
    );
  }
  return itAssetMachine.apply(from, event);
}

// ---------------------------------------------------------------------------
// Generic lifecycle transition — repair / retire / dispose
// ---------------------------------------------------------------------------

/** Events reachable only through `assignAsset`/`returnAsset`, which also
 * write the assignment log a plain transition cannot. */
const DEDICATED_EVENTS: ItAssetLifecycleEvent[] = ['ASSIGN', 'RETURN'];

export async function transitionAsset(id: string, event: ItAssetLifecycleEvent, note?: string | null) {
  if (DEDICATED_EVENTS.includes(event)) {
    throw ApiError.badRequest(`${event} needs who it is going to/from — use the assign or return action, not a plain transition.`);
  }

  const auth = currentAuth();
  const asset = await prisma.itAsset.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!asset) throw ApiError.notFound('Asset');

  await assertCan({ resource: RESOURCE, verb: 'edit', record: { ownerPartyId: asset.holderPartyId } });

  const from = asset.status as ItAssetStatus;
  const to = applyTransition(from, event);

  const updated = await prisma.itAsset.update({
    where: { id },
    data: {
      status: to,
      inRepairSince: event === 'SEND_TO_REPAIR' ? new Date() : event === 'BACK_FROM_REPAIR' ? null : asset.inRepairSince,
      ...(event === 'RETIRE' || event === 'DISPOSE' ? { inRepairSince: null } : {}),
    },
  });

  await prisma.itAssetEvent.create({
    data: {
      tenantId: auth.tenantId,
      assetId: id,
      kind: 'transition',
      detail: `${IT_ASSET_EVENT_VERB[event]}.${note ? ` ${note}` : ''}`,
      actorPartyId: auth.partyId,
    },
  });

  await auditWrite({ action: 'update', subjectType: 'it_asset', subjectId: id, before: { status: from }, after: { status: to }, meta: { transition: event } });
  await emit({
    name: EVENTS.IT_ASSET_TRANSITIONED,
    subject: { entityType: 'it_asset', entityId: id, recordCode: asset.recordCode },
    previousState: { status: from },
    newState: { status: to },
    reason: note ? { reasonCode: event, note } : null,
    owner: { partyId: asset.holderPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return withTransitions(updated);
}

// ---------------------------------------------------------------------------
// Events — repair notes, audit sightings, free-text notes
// ---------------------------------------------------------------------------

export interface AddAssetEventInput {
  kind: string;
  detail: string;
}

export async function addAssetEvent(id: string, input: AddAssetEventInput) {
  const auth = currentAuth();
  const asset = await prisma.itAsset.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!asset) throw ApiError.notFound('Asset');
  await assertCan({ resource: RESOURCE, verb: 'edit', record: { ownerPartyId: asset.holderPartyId } });

  const detail = input.detail?.trim();
  if (!detail) throw ApiError.badRequest('An event needs a detail — what happened.');

  const event = await prisma.itAssetEvent.create({
    data: { tenantId: auth.tenantId, assetId: id, kind: input.kind || 'note', detail, actorPartyId: auth.partyId },
  });
  await auditWrite({ action: 'create', subjectType: 'it_asset_event', subjectId: event.id, after: { assetId: id, kind: event.kind } });
  return event;
}

export async function listAssetEvents(id: string) {
  const auth = currentAuth();
  const asset = await prisma.itAsset.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!asset) throw ApiError.notFound('Asset');
  await assertCan({ resource: RESOURCE, verb: 'view', record: { ownerPartyId: asset.holderPartyId } });
  return prisma.itAssetEvent.findMany({ where: { tenantId: auth.tenantId, assetId: id }, orderBy: { createdAt: 'desc' } });
}

// ---------------------------------------------------------------------------
// Warranty ladder (jobs/it/assets.ts calls this)
// ---------------------------------------------------------------------------

/** Resolves the Operations Head — the desk that owns an asset with no
 * individual holder — the same data-driven shape `resolveOwnerPartyId` in
 * `domains/compliance/calendar.ts` uses (never a role-slug branch). */
export async function resolveDeskOwnerPartyId(): Promise<string | null> {
  const auth = currentAuth();
  const affiliation = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, roleSlug: 'hr_ops_manager', status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return affiliation?.partyId ?? null;
}

export interface WarrantyLadderResult {
  checked: number;
  notified: number;
  skippedIdempotent: number;
}

export async function runWarrantyLadder(now: Date = new Date()): Promise<WarrantyLadderResult> {
  const auth = currentAuth();
  const thresholds = await currentThresholds(now);
  const rows = await prisma.itAsset.findMany({
    where: { tenantId: auth.tenantId, warrantyEnd: { not: null }, status: { notIn: ['retired', 'disposed'] } },
  });

  let notified = 0;
  let skippedIdempotent = 0;

  for (const row of rows) {
    const daysLeft = daysUntil(row.warrantyEnd!, now);
    const rung = warrantyRung(daysLeft, thresholds.warrantyRungs);
    if (rung === null) continue;

    const already = row.warrantyNotifiedRungs ?? [];
    if (already.includes(rung)) {
      skippedIdempotent += 1;
      continue;
    }

    const ownerPartyId = row.holderPartyId ?? (await resolveDeskOwnerPartyId());
    const expired = rung <= 0;

    await raiseException({
      code: expired ? 'IT_AST_WARRANTY_EXPIRED' : 'IT_AST_WARRANTY_APPROACHING',
      label: expired ? `${row.tag} warranty expired` : `${row.tag} warranty ends in ${rung} day${rung === 1 ? '' : 's'}`,
      severity: expired ? 'S3_HIGH_RISK' : rung <= 7 ? 'S2_WARNING' : 'S1_ATTENTION',
      subjectType: 'it_asset',
      subjectId: row.id,
      subjectLabel: row.recordCode,
      domain: IT_DOMAIN,
      detail: expired
        ? `${row.tag} (${row.recordCode}) warranty ended ${row.warrantyEnd!.toISOString().slice(0, 10)}.`
        : `${row.tag} (${row.recordCode}) warranty ends ${row.warrantyEnd!.toISOString().slice(0, 10)}, in ${rung} day${rung === 1 ? '' : 's'}.`,
      ownerPartyId,
      slaDueAt: row.warrantyEnd,
      triggerFingerprint: 'it_asset_warranty_ladder',
      ladderRung: rung,
    });
    notified += 1;

    await prisma.itAsset.update({ where: { id: row.id }, data: { warrantyNotifiedRungs: [...new Set([...already, rung])] } });

    await emit({
      name: EVENTS.IT_ASSET_WARRANTY_APPROACHING,
      subject: { entityType: 'it_asset', entityId: row.id, recordCode: row.recordCode },
      newState: { rung, daysLeft },
      impact: { domains: [IT_DOMAIN] },
    });
  }

  return { checked: rows.length, notified, skippedIdempotent };
}

export interface RepairDetectorResult {
  checked: number;
  flagged: number;
}

export async function runInRepairTooLongDetector(now: Date = new Date()): Promise<RepairDetectorResult> {
  const auth = currentAuth();
  const thresholds = await currentThresholds(now);
  const rows = await prisma.itAsset.findMany({
    where: { tenantId: auth.tenantId, status: 'in_repair', inRepairSince: { not: null } },
  });

  let flagged = 0;
  for (const row of rows) {
    const days = daysInRepair(row.inRepairSince!, now);
    if (days < thresholds.repairDaysThreshold) continue;

    const ownerPartyId = row.holderPartyId ?? (await resolveDeskOwnerPartyId());
    await raiseException({
      code: 'IT_AST_REPAIR_OVERDUE',
      label: `${row.tag} has been in repair for ${days} days`,
      severity: 'S2_WARNING',
      subjectType: 'it_asset',
      subjectId: row.id,
      subjectLabel: row.recordCode,
      domain: IT_DOMAIN,
      detail: `${row.tag} (${row.recordCode}) entered repair ${row.inRepairSince!.toISOString().slice(0, 10)} and is still there ${days} days later — past the ${thresholds.repairDaysThreshold}-day threshold.`,
      ownerPartyId,
      triggerFingerprint: 'it_asset_repair_overdue',
    });
    flagged += 1;
  }

  return { checked: rows.length, flagged };
}

export interface OrphanedAssetResult {
  checked: number;
  flagged: number;
}

/** An asset held by a person whose affiliation has ended — the exit
 * checklist's technology half (IT-AST-005). Never a role-slug branch: it
 * looks up the holder's own affiliation rows. */
export async function runOrphanedAssetDetector(): Promise<OrphanedAssetResult> {
  const auth = currentAuth();
  const rows = await prisma.itAsset.findMany({
    where: { tenantId: auth.tenantId, holderPartyId: { not: null }, status: { notIn: ['retired', 'disposed'] } },
  });

  let flagged = 0;
  for (const row of rows) {
    const active = await prisma.affiliation.findFirst({
      where: { tenantId: auth.tenantId, partyId: row.holderPartyId!, status: 'active' },
    });
    if (active) continue;

    const deskOwner = await resolveDeskOwnerPartyId();
    await raiseException({
      code: 'IT_AST_ORPHANED',
      label: `${row.tag} is held by someone whose affiliation has ended`,
      severity: 'S3_HIGH_RISK',
      subjectType: 'it_asset',
      subjectId: row.id,
      subjectLabel: row.recordCode,
      domain: IT_DOMAIN,
      detail: `${row.tag} (${row.recordCode}) is still assigned to a party with no active affiliation. Recover it or reassign it.`,
      ownerPartyId: deskOwner,
      triggerFingerprint: 'it_asset_orphaned',
    });
    flagged += 1;
  }

  return { checked: rows.length, flagged };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * The summary is an aggregate over the whole fleet — exactly the case
 * `assertScopeAll` exists for (see its doc comment): an employee's
 * `it_assets:V@own` grant answers "may I view an asset", not "may I know the
 * fleet's book value and who holds the most kit". A caller who does not hold
 * an `@all` view grant gets a summary narrowed to their own assets instead
 * of being flatly refused — the tile is still meaningful, just smaller.
 */
export async function summary() {
  const auth = currentAuth();

  // Throws (WHO axis) if there is no `it_assets:view` grant at all. A grant
  // held at less than `all` scope is a separate, expected case, not an
  // error — caught below to fall back to the narrow summary.
  await assertCan({ resource: RESOURCE, verb: 'view' });
  let ownOnly = false;
  try {
    await assertScopeAll(RESOURCE, 'view');
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      ownOnly = true;
    } else {
      throw err;
    }
  }

  const where = ownOnly ? { tenantId: auth.tenantId, holderPartyId: auth.partyId ?? ' no-party' } : { tenantId: auth.tenantId };

  const total = await prisma.itAsset.count({ where });
  if (total === 0) {
    return {
      notYetMeasured: true,
      total: 0,
      byKind: {},
      byStatus: {},
      warrantyExpiringIn90Days: 0,
      unassignedStock: 0,
      topHolders: [],
      bookValue: 0,
      fixedAssetLinkedCount: 0,
    };
  }

  const rows = await prisma.itAsset.findMany({ where });
  const now = new Date();

  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let warrantyExpiringIn90Days = 0;
  let unassignedStock = 0;
  let fixedAssetLinkedCount = 0;
  const holderCounts = new Map<string, number>();

  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status === 'in_stock') unassignedStock += 1;
    if (r.fixedAssetId) fixedAssetLinkedCount += 1;
    if (r.warrantyEnd && r.status !== 'retired' && r.status !== 'disposed' && daysUntil(r.warrantyEnd, now) <= 90 && daysUntil(r.warrantyEnd, now) >= 0) {
      warrantyExpiringIn90Days += 1;
    }
    if (r.holderPartyId) holderCounts.set(r.holderPartyId, (holderCounts.get(r.holderPartyId) ?? 0) + 1);
  }

  const bookValue = assetBookValue(rows.filter((r) => r.status !== 'disposed').map((r) => (r.purchaseCost ? Number(r.purchaseCost) : null)));

  const topHolderIds = [...holderCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const names = await holderNames(topHolderIds.map(([id]) => id));
  const topHolders = topHolderIds.map(([partyId, count]) => ({
    partyId,
    fullName: names.find((n) => n.id === partyId)?.fullName ?? partyId,
    count,
  }));

  return {
    notYetMeasured: false,
    total,
    byKind,
    byStatus,
    warrantyExpiringIn90Days,
    unassignedStock,
    topHolders,
    bookValue,
    fixedAssetLinkedCount,
  };
}
