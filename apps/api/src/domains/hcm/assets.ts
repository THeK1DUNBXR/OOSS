/**
 * HCM — WS11 assets (docs/hcm/assets.md). Mounted at /api/hcm/assets.
 *
 * Physical inventory (Asset/AssetAssignment), travel requests approved under
 * the Self-Dealing Bar, letter requests fulfilled through
 * `compliance/labour.ts`'s `issueLetter` where its `HrLetterKind` covers the
 * request and through this workstream's own snapshot where it does not, and
 * ID card issuance.
 */

import {
  ASSET_CATEGORIES,
  ASSET_CONDITIONS,
  buildOwnLetterBody,
  canTransitionAsset,
  canTransitionLetterRequest,
  canTransitionTravelRequest,
  fulfilsViaHrLetter,
  isSelfDealingApproval,
  LETTER_REQUEST_KINDS,
  TRAVEL_MODES,
  type AssetCategory,
  type AssetCondition,
  type AssetStatus,
  type LetterRequestKind,
  type LetterRequestStatus,
  type TravelMode,
  type TravelRequestStatus,
} from '@kaizen/shared';
import { HR_LETTER_KINDS, type HrLetterKind } from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, canSeeMoney } from '../../platform/permissions.js';
import { assertEmploymentVisible, employmentVisibilityWhere } from '../../platform/recordScope.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { issueLetter, listLetters as listHrLetters } from '../compliance/labour.js';

registerGovernedEntities('hcm_assets', ['asset', 'asset_assignment', 'travel_request', 'letter_request', 'id_card']);

/** Nulls `cost` (and estimated/advance money on travel) in place for a viewer without financial visibility on the resource. */
function maskCost<T extends Record<string, unknown>>(row: T, canSee: boolean, fields: string[]): T {
  if (canSee) return row;
  const out = { ...row };
  for (const f of fields) (out as Record<string, unknown>)[f] = null;
  return out;
}

async function employmentOrThrow(employmentRelationshipId: string) {
  const auth = currentAuth();
  const row = await prisma.employmentRelationship.findFirst({
    where: { id: employmentRelationshipId, tenantId: auth.tenantId },
    select: { id: true, personId: true, legalEntity: true },
  });
  if (!row) throw ApiError.notFound('Employment relationship');
  return row;
}

// ---------------------------------------------------------------------------
// Assets — inventory
// ---------------------------------------------------------------------------

export async function listAssets(filter: { status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'hcm_assets', verb: 'view' });
  const canSee = await canSeeMoney('hcm_assets');
  const rows = await prisma.asset.findMany({
    where: { tenantId: auth.tenantId, ...(filter.status ? { status: filter.status } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => maskCost(r, canSee, ['cost']));
}

export async function createAsset(input: {
  tag: string;
  category: AssetCategory;
  serial?: string | null;
  purchaseDate?: Date | null;
  cost?: number | null;
  note?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'hcm_assets', verb: 'create' });
  if (!ASSET_CATEGORIES.includes(input.category)) {
    throw ApiError.badRequest(`"${input.category}" is not an asset category. Expected one of ${ASSET_CATEGORIES.join(', ')}.`);
  }
  const recordCode = await nextRecordCode('AST');
  const row = await prisma.asset.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      tag: input.tag,
      category: input.category,
      serial: input.serial ?? null,
      purchaseDate: input.purchaseDate ?? null,
      cost: input.cost ?? null,
      note: input.note ?? null,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'asset', subjectId: row.id, after: row as never });
  const canSee = await canSeeMoney('hcm_assets');
  return maskCost(row, canSee, ['cost']);
}

async function loadAsset(id: string) {
  const auth = currentAuth();
  const row = await prisma.asset.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Asset');
  return row;
}

/** Any non-assignment status move: `in_stock -> retired`, `repair -> in_stock`, `repair -> retired`. Never touches `assigned` — that only changes via assign/return. */
export async function transitionAsset(id: string, to: Exclude<AssetStatus, 'assigned'>) {
  const auth = currentAuth();
  await assertCan({ resource: 'hcm_assets', verb: 'edit' });
  const asset = await loadAsset(id);
  const from = asset.status as AssetStatus;
  if (!canTransitionAsset(from, to)) {
    throw ApiError.unprocessable(`An asset in "${from}" cannot move to "${to}".`);
  }
  const updated = await prisma.asset.update({ where: { id }, data: { status: to } });
  await auditWrite({ action: 'update', subjectType: 'asset', subjectId: id, before: { status: from }, after: { status: to } });
  return updated;
}

// ---------------------------------------------------------------------------
// Asset assignments
// ---------------------------------------------------------------------------

export async function listAssetAssignments(filter: { employmentRelationshipId?: string; assetId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'asset_assignments', verb: 'view' });
  const where = await employmentVisibilityWhere('asset_assignments');
  return prisma.assetAssignment.findMany({
    where: {
      tenantId: auth.tenantId,
      ...where,
      ...(filter.employmentRelationshipId ? { employmentRelationshipId: filter.employmentRelationshipId } : {}),
      ...(filter.assetId ? { assetId: filter.assetId } : {}),
    },
    include: { asset: true },
    orderBy: { issuedOn: 'desc' },
  });
}

/** Issues an in-stock asset to an employment. Refuses an asset that is not `in_stock`. */
export async function assignAsset(input: { assetId: string; employmentRelationshipId: string; condition?: AssetCondition; note?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'asset_assignments', verb: 'create' });
  const asset = await loadAsset(input.assetId);
  if (asset.status !== 'in_stock') {
    throw ApiError.unprocessable(`Asset ${asset.tag} is "${asset.status}", not in stock, and cannot be assigned.`);
  }
  const employment = await employmentOrThrow(input.employmentRelationshipId);
  const condition = input.condition ?? 'good';
  if (!ASSET_CONDITIONS.includes(condition)) {
    throw ApiError.badRequest(`"${condition}" is not a condition. Expected one of ${ASSET_CONDITIONS.join(', ')}.`);
  }

  const [assignment] = await prisma.$transaction([
    prisma.assetAssignment.create({
      data: {
        tenantId: auth.tenantId,
        assetId: input.assetId,
        employmentRelationshipId: input.employmentRelationshipId,
        condition,
        note: input.note ?? null,
      },
    }),
    prisma.asset.update({ where: { id: input.assetId }, data: { status: 'assigned' } }),
  ]);

  await auditWrite({ action: 'create', subjectType: 'asset_assignment', subjectId: assignment.id, after: assignment as never });
  await emit({
    name: 'kz.hr.asset.assigned',
    subject: { entityType: 'asset_assignment', entityId: assignment.id },
    related: [
      { relation: 'asset', entityType: 'asset', entityId: input.assetId },
      { relation: 'about', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
    ],
    newState: { assetId: input.assetId, employmentRelationshipId: input.employmentRelationshipId },
    owner: { partyId: employment.personId },
    impact: { domains: ['hr'] },
  });
  return assignment;
}

/** Returns an open assignment. `condition` on return decides whether the asset goes back to stock or to repair. */
export async function returnAsset(assignmentId: string, input: { condition: AssetCondition; note?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'asset_assignments', verb: 'edit' });
  const assignment = await prisma.assetAssignment.findFirst({ where: { id: assignmentId, tenantId: auth.tenantId } });
  if (!assignment) throw ApiError.notFound('Asset assignment');
  if (assignment.returnedOn) throw ApiError.unprocessable('This assignment was already returned.');
  if (!ASSET_CONDITIONS.includes(input.condition)) {
    throw ApiError.badRequest(`"${input.condition}" is not a condition. Expected one of ${ASSET_CONDITIONS.join(', ')}.`);
  }

  const nextAssetStatus = input.condition === 'poor' ? 'repair' : 'in_stock';
  const [updated] = await prisma.$transaction([
    prisma.assetAssignment.update({
      where: { id: assignmentId },
      data: { returnedOn: new Date(), condition: input.condition, note: input.note ?? assignment.note },
    }),
    prisma.asset.update({ where: { id: assignment.assetId }, data: { status: nextAssetStatus } }),
  ]);

  await auditWrite({
    action: 'update',
    subjectType: 'asset_assignment',
    subjectId: assignmentId,
    before: { returnedOn: null },
    after: { returnedOn: updated.returnedOn, condition: input.condition },
  });
  await emit({
    name: 'kz.hr.asset.returned',
    subject: { entityType: 'asset_assignment', entityId: assignmentId },
    related: [{ relation: 'asset', entityType: 'asset', entityId: assignment.assetId }],
    newState: { condition: input.condition, assetStatus: nextAssetStatus },
    impact: { domains: ['hr'] },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Travel requests
// ---------------------------------------------------------------------------

export async function listTravelRequests(filter: { employmentRelationshipId?: string; status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'travel_requests', verb: 'view' });
  const where = await employmentVisibilityWhere('travel_requests');
  const canSee = await canSeeMoney('travel_requests');
  const rows = await prisma.travelRequest.findMany({
    where: {
      tenantId: auth.tenantId,
      ...where,
      ...(filter.employmentRelationshipId ? { employmentRelationshipId: filter.employmentRelationshipId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => maskCost(r, canSee, ['estimatedCost', 'advanceRequested']));
}

export async function createTravelRequest(input: {
  employmentRelationshipId: string;
  purpose: string;
  fromLocation: string;
  toLocation: string;
  startDate: Date;
  endDate: Date;
  mode: TravelMode;
  estimatedCost: number;
  advanceRequested?: number | null;
  note?: string | null;
}) {
  const auth = currentAuth();
  await assertEmploymentVisible('travel_requests', input.employmentRelationshipId, 'create');
  if (!TRAVEL_MODES.includes(input.mode)) {
    throw ApiError.badRequest(`"${input.mode}" is not a travel mode. Expected one of ${TRAVEL_MODES.join(', ')}.`);
  }
  if (input.endDate < input.startDate) {
    throw ApiError.badRequest('The return date cannot be before the departure date.');
  }
  const recordCode = await nextRecordCode('TRV');
  const row = await prisma.travelRequest.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      employmentRelationshipId: input.employmentRelationshipId,
      purpose: input.purpose,
      fromLocation: input.fromLocation,
      toLocation: input.toLocation,
      startDate: input.startDate,
      endDate: input.endDate,
      mode: input.mode,
      estimatedCost: input.estimatedCost,
      advanceRequested: input.advanceRequested ?? null,
      note: input.note ?? null,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'travel_request', subjectId: row.id, after: row as never });
  await emit({
    name: 'kz.hr.travel_request.submitted',
    subject: { entityType: 'travel_request', entityId: row.id, recordCode },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { status: 'submitted' },
    impact: { domains: ['hr'] },
  });
  return row;
}

async function loadTravelRequest(id: string) {
  const auth = currentAuth();
  const row = await prisma.travelRequest.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Travel request');
  return row;
}

/** Decides a submitted travel request. Self-Dealing Bar: the approver may never be the traveller. */
export async function decideTravelRequest(id: string, decision: 'approved' | 'rejected', note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'travel_requests', verb: 'approve' });
  if (!auth.partyId) throw ApiError.forbidden('A decision requires a human principal.');

  const request = await loadTravelRequest(id);
  const from = request.status as TravelRequestStatus;
  if (!canTransitionTravelRequest(from, decision)) {
    throw ApiError.unprocessable(`A travel request in "${from}" cannot be moved to "${decision}".`);
  }

  const employment = await employmentOrThrow(request.employmentRelationshipId);
  if (isSelfDealingApproval(auth.partyId, employment.personId)) {
    throw ApiError.forbidden('The Self-Dealing Bar is unconditional: you may never decide your own travel request.');
  }

  const updated = await prisma.travelRequest.update({
    where: { id },
    data: { status: decision, approverPartyId: auth.partyId, decidedAt: new Date(), decisionNote: note ?? null },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'travel_request',
    subjectId: id,
    before: { status: from },
    after: { status: decision },
  });
  if (decision === 'approved') {
    await emit({
      name: 'kz.hr.travel_request.approved',
      subject: { entityType: 'travel_request', entityId: id, recordCode: updated.recordCode },
      newState: { status: 'approved' },
      owner: { partyId: employment.personId },
      impact: { domains: ['hr'] },
    });
  }
  return updated;
}

/** Records the settlement of an approved, travelled request — by id only, into WS7's ExpenseClaim. */
export async function settleTravelRequest(id: string, expenseClaimId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'travel_requests', verb: 'edit' });
  const request = await loadTravelRequest(id);
  const from = request.status as TravelRequestStatus;
  if (!canTransitionTravelRequest(from, 'settled')) {
    throw ApiError.unprocessable(`A travel request in "${from}" cannot be settled — it must be approved first.`);
  }
  const updated = await prisma.travelRequest.update({ where: { id }, data: { status: 'settled', expenseClaimId } });
  await auditWrite({
    action: 'update',
    subjectType: 'travel_request',
    subjectId: id,
    before: { status: from, expenseClaimId: null },
    after: { status: 'settled', expenseClaimId },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Letter requests
// ---------------------------------------------------------------------------

async function nextLetterRequestNumber(): Promise<string> {
  const auth = currentAuth();
  const year = new Date().getUTCFullYear();
  const row = await prisma.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId: auth.tenantId, entityType: 'HCM:LREQ', year } },
    create: { tenantId: auth.tenantId, entityType: 'HCM:LREQ', year, nextSequence: 2 },
    update: { nextSequence: { increment: 1 } },
    select: { nextSequence: true },
  });
  return `LREQ-${year}-${String(row.nextSequence - 1).padStart(4, '0')}`;
}

export async function listLetterRequests(filter: { employmentRelationshipId?: string; status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'letter_requests', verb: 'view' });
  const where = await employmentVisibilityWhere('letter_requests');
  return prisma.letterRequest.findMany({
    where: {
      tenantId: auth.tenantId,
      ...where,
      ...(filter.employmentRelationshipId ? { employmentRelationshipId: filter.employmentRelationshipId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createLetterRequest(input: { employmentRelationshipId: string; kind: LetterRequestKind; note?: string | null }) {
  const auth = currentAuth();
  await assertEmploymentVisible('letter_requests', input.employmentRelationshipId, 'create');
  if (!LETTER_REQUEST_KINDS.includes(input.kind)) {
    throw ApiError.badRequest(`"${input.kind}" is not a letter kind. Expected one of ${LETTER_REQUEST_KINDS.join(', ')}.`);
  }
  const row = await prisma.letterRequest.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      requestedById: auth.partyId,
      kind: input.kind,
      decisionNote: input.note ?? null,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'letter_request', subjectId: row.id, after: row as never });
  await emit({
    name: 'kz.hr.letter_request.submitted',
    subject: { entityType: 'letter_request', entityId: row.id },
    related: [{ relation: 'about', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { status: 'requested', kind: input.kind },
    impact: { domains: ['hr'] },
  });
  return row;
}

async function loadLetterRequest(id: string) {
  const auth = currentAuth();
  const row = await prisma.letterRequest.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Letter request');
  return row;
}

/**
 * Fulfils a requested letter. For `experience` (the one kind
 * `compliance/labour.ts`'s `HrLetterKind` also names) this calls its exported
 * `issueLetter` so the letter lands as a real, immutable `HrLetter`; every
 * other kind gets this workstream's own snapshot, built from the same
 * `employeeName`/`legalEntity`/`designation` facts.
 */
export async function fulfilLetterRequest(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'letter_requests', verb: 'edit' });
  if (!auth.partyId) throw ApiError.forbidden('Fulfilment requires a human principal.');

  const request = await loadLetterRequest(id);
  const from = request.status as LetterRequestStatus;
  if (!canTransitionLetterRequest(from, 'fulfilled')) {
    throw ApiError.unprocessable(`A letter request in "${from}" cannot be fulfilled.`);
  }

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: request.employmentRelationshipId, tenantId: auth.tenantId },
    include: { person: true, assignments: { where: { rowStatus: 'Effective' }, include: { position: { include: { job: true } } }, take: 1, orderBy: { effectiveFrom: 'desc' } } },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const kind = request.kind as LetterRequestKind;
  const employeeName = employment.person.fullName;
  const designation = employment.assignments[0]?.position.job.title ?? null;
  const issuedOn = new Date().toISOString().slice(0, 10);

  let updated;
  if (fulfilsViaHrLetter(kind)) {
    if (!HR_LETTER_KINDS.includes(kind as HrLetterKind)) {
      throw ApiError.internal(`"${kind}" was marked as issuable via HrLetter but is not one of compliance labour's kinds.`);
    }
    const letter = await issueLetter({
      kind: kind as HrLetterKind,
      employmentRelationshipId: employment.id,
      employeeName,
      legalEntity: employment.legalEntity,
      designation,
    });
    updated = await prisma.letterRequest.update({
      where: { id },
      data: { status: 'fulfilled', hrLetterId: letter.id, number: letter.number, fulfilledAt: new Date(), fulfilledById: auth.partyId },
    });
  } else {
    const number = await nextLetterRequestNumber();
    const body = buildOwnLetterBody(kind as Exclude<LetterRequestKind, 'experience'>, {
      employeeName,
      legalEntity: employment.legalEntity,
      designation,
      issuedOn,
      number,
    });
    updated = await prisma.letterRequest.update({
      where: { id },
      data: {
        status: 'fulfilled',
        number,
        snapshot: { body, issuedOn } as never,
        fulfilledAt: new Date(),
        fulfilledById: auth.partyId,
      },
    });
  }

  await auditWrite({ action: 'update', subjectType: 'letter_request', subjectId: id, before: { status: from }, after: { status: 'fulfilled' } });
  await emit({
    name: 'kz.hr.letter_request.issued',
    subject: { entityType: 'letter_request', entityId: id, recordCode: updated.number },
    newState: { status: 'fulfilled', kind },
    owner: { partyId: employment.personId },
    impact: { domains: ['hr'] },
  });
  return updated;
}

export async function rejectLetterRequest(id: string, note: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'letter_requests', verb: 'edit' });
  const request = await loadLetterRequest(id);
  const from = request.status as LetterRequestStatus;
  if (!canTransitionLetterRequest(from, 'rejected')) {
    throw ApiError.unprocessable(`A letter request in "${from}" cannot be rejected.`);
  }
  const updated = await prisma.letterRequest.update({
    where: { id },
    data: { status: 'rejected', decisionNote: note, fulfilledById: auth.partyId, fulfilledAt: new Date() },
  });
  await auditWrite({ action: 'update', subjectType: 'letter_request', subjectId: id, before: { status: from }, after: { status: 'rejected' } });
  return updated;
}

/** Re-exported so a surface can list HrLetters alongside letter requests without owning `compliance/labour.ts` itself. */
export async function listIssuedHrLetters(employmentRelationshipId: string) {
  return listHrLetters({ employmentRelationshipId });
}

// ---------------------------------------------------------------------------
// ID cards
// ---------------------------------------------------------------------------

async function nextIdCardNumber(): Promise<string> {
  const auth = currentAuth();
  const year = new Date().getUTCFullYear();
  const row = await prisma.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId: auth.tenantId, entityType: 'HCM:IDC', year } },
    create: { tenantId: auth.tenantId, entityType: 'HCM:IDC', year, nextSequence: 2 },
    update: { nextSequence: { increment: 1 } },
    select: { nextSequence: true },
  });
  return `IDC-${year}-${String(row.nextSequence - 1).padStart(4, '0')}`;
}

export async function listIdCards(filter: { employmentRelationshipId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'hcm_assets', verb: 'view' });
  return prisma.idCard.findMany({
    where: { tenantId: auth.tenantId, ...(filter.employmentRelationshipId ? { employmentRelationshipId: filter.employmentRelationshipId } : {}) },
    orderBy: { issuedOn: 'desc' },
  });
}

export async function issueIdCard(employmentRelationshipId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'hcm_assets', verb: 'create' });
  await employmentOrThrow(employmentRelationshipId);
  const cardNumber = await nextIdCardNumber();
  const row = await prisma.idCard.create({
    data: { tenantId: auth.tenantId, employmentRelationshipId, cardNumber },
  });
  await auditWrite({ action: 'create', subjectType: 'id_card', subjectId: row.id, after: row as never });
  return row;
}

/** Marks a card lost, then immediately issues its replacement — two rows, so the history of what happened to the old card is never overwritten. */
export async function reportIdCardLost(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'hcm_assets', verb: 'edit' });
  const card = await prisma.idCard.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!card) throw ApiError.notFound('ID card');
  if (card.status !== 'issued') throw ApiError.unprocessable(`This card is "${card.status}", not currently issued.`);

  const [lost, reissued] = await prisma.$transaction([
    prisma.idCard.update({ where: { id }, data: { status: 'lost', returnedOn: new Date() } }),
    prisma.idCard.create({
      data: {
        tenantId: auth.tenantId,
        employmentRelationshipId: card.employmentRelationshipId,
        cardNumber: await nextIdCardNumber(),
        status: 'reissued',
      },
    }),
  ]);
  await auditWrite({ action: 'update', subjectType: 'id_card', subjectId: id, before: { status: 'issued' }, after: { status: 'lost' } });
  await auditWrite({ action: 'create', subjectType: 'id_card', subjectId: reissued.id, after: reissued as never });
  return { lost, reissued };
}

export async function returnIdCard(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'hcm_assets', verb: 'edit' });
  const card = await prisma.idCard.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!card) throw ApiError.notFound('ID card');
  if (card.status !== 'issued') throw ApiError.unprocessable(`This card is "${card.status}", not currently issued.`);
  const updated = await prisma.idCard.update({ where: { id }, data: { status: 'returned', returnedOn: new Date() } });
  await auditWrite({ action: 'update', subjectType: 'id_card', subjectId: id, before: { status: 'issued' }, after: { status: 'returned' } });
  return updated;
}

// ---------------------------------------------------------------------------
// "Me" lookups — /me/requests resolves its own employment id before it can
// ask for anything self-service.
// ---------------------------------------------------------------------------

export async function myEmployment() {
  const auth = currentAuth();
  if (!auth.partyId) throw ApiError.badRequest('No person behind this session.');
  const employment = await prisma.employmentRelationship.findFirst({
    where: { tenantId: auth.tenantId, personId: auth.partyId, deletedAt: null },
    orderBy: { hireEffectiveDate: 'desc' },
    select: { id: true, status: true },
  });
  if (!employment) throw ApiError.notFound('Your employment relationship');
  return employment;
}

// ---------------------------------------------------------------------------
// Command-center numbers
// ---------------------------------------------------------------------------

/** Pending items awaiting HR action — the count Assets & Requests leads with. */
export async function assetsPendingCount() {
  const auth = currentAuth();
  await assertCan({ resource: 'hcm_assets', verb: 'view' });
  const [travel, letters] = await Promise.all([
    prisma.travelRequest.count({ where: { tenantId: auth.tenantId, status: 'submitted' } }),
    prisma.letterRequest.count({ where: { tenantId: auth.tenantId, status: 'requested' } }),
  ]);
  return { travelRequestsPending: travel, letterRequestsPending: letters };
}

/** The count WS10's separations screen reads for an employment's pending asset returns. */
export async function assetsPendingForEmployment(employmentRelationshipId: string): Promise<number> {
  const auth = currentAuth();
  return prisma.assetAssignment.count({
    where: { tenantId: auth.tenantId, employmentRelationshipId, returnedOn: null },
  });
}
