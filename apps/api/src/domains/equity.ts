/**
 * The register (bounded context `eqt`) — equity-portal plan §5, phase 1.
 *
 * The register is a ledger; the cap table is its sum (§3.5). `ShareTransaction`
 * is append-only: no function in this file updates `count`, `fromHolderId`,
 * `toHolderId` or `shareClassId` on an existing row. A mistake is rejected and
 * re-proposed, or reversed after it goes effective with a second row carrying
 * `reversalOfId` — the same discipline `Transaction` already keeps for money.
 *
 * EQT never holds money movement; FIN never holds share ownership (§3.6): an
 * allotment for cash points `considerationTransactionId` at the `Transaction`
 * (on a `kind: equity` category) that already lifted cash, rather than posting
 * one itself.
 *
 * Every exported function opens with `assertCan`/`assertScopeAll`; only the
 * scoped `prisma` is used, except `assertNotHoldingsAncestor`, which reads
 * `unscopedPrisma.tenant` — a structural check on the tenant graph, not on
 * this tenant's own data (s.19).
 */

import {
  EVENTS,
  type CapTableInputRow,
  type ShareClassKind,
  type ShareInstrument,
  computeCapTable,
} from '@kaizen/shared';
import { prisma, unscopedPrisma, dec, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { assertCan, assertScopeAll, can, canSeeMoney, scopeFor } from '../platform/permissions.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { nextDocumentNumber, DOCUMENT_SERIES } from '../platform/documentNumber.js';
import { documentPrefix, companyProfile } from './companyProfile.js';
import { findOrCreatePerson } from './identity.js';
import { evaluateApprovalGate } from '../platform/approvals.js';
import { raiseException } from '../platform/exceptions.js';

registerGovernedEntities('eqt', [
  'share_class', 'holder', 'share_transaction', 'share_certificate', 'valuation', 'entity_document',
]);

// ---------------------------------------------------------------------------
// Share classes
// ---------------------------------------------------------------------------

export interface ShareClassInput {
  name: string;
  kind: ShareClassKind;
  instrument: ShareInstrument;
  faceValue: number;
  votesPerShare?: number;
  rights?: Record<string, unknown>;
  conversionTerms?: Record<string, unknown> | null;
  authorisedCount?: number | null;
}

export async function createShareClass(input: ShareClassInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_classes', verb: 'create' });

  const row = await prisma.shareClass.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('SHC'),
      name: input.name,
      kind: input.kind,
      instrument: input.instrument,
      faceValue: dec(input.faceValue)!,
      votesPerShare: dec(input.votesPerShare ?? 1)!,
      rights: (input.rights ?? {}) as never,
      conversionTerms: (input.conversionTerms ?? undefined) as never,
      authorisedCount: input.authorisedCount == null ? null : dec(input.authorisedCount),
    },
  });

  await auditWrite({ action: 'create', subjectType: 'share_class', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.SHARE_CLASS_CREATED,
    subject: { entityType: 'share_class', entityId: row.id, recordCode: row.recordCode },
    newState: { name: row.name, instrument: row.instrument },
  });

  return shareClassView(row);
}

export interface ShareClassUpdateInput {
  rights?: Record<string, unknown>;
  conversionTerms?: Record<string, unknown> | null;
  authorisedCount?: number | null;
  status?: 'active' | 'closed';
}

/**
 * Rights, conversion terms, authorised count and status only. `instrument`
 * and `faceValue` are immutable the moment any effective transaction points
 * at this class — changing what a class of shares *is* after certificates
 * have been printed against it would make every certificate a lie about what
 * it represents.
 */
export async function updateShareClass(id: string, input: ShareClassUpdateInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_classes', verb: 'edit' });

  const existing = await prisma.shareClass.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!existing) throw ApiError.notFound('Share class');

  const updated = await prisma.shareClass.update({
    where: { id },
    data: {
      ...(input.rights !== undefined ? { rights: input.rights as never } : {}),
      ...(input.conversionTerms !== undefined ? { conversionTerms: input.conversionTerms as never } : {}),
      ...(input.authorisedCount !== undefined
        ? { authorisedCount: input.authorisedCount == null ? null : dec(input.authorisedCount) }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'share_class',
    subjectId: id,
    before: existing as never,
    after: updated as never,
  });

  return shareClassView(updated);
}

export async function listShareClasses() {
  const auth = currentAuth();
  await assertScopeAll('share_classes');
  const rows = await prisma.shareClass.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
  return rows.map(shareClassView);
}

function shareClassView(row: {
  id: string; recordCode: string; name: string; kind: string; instrument: string;
  faceValue: unknown; votesPerShare: unknown; rights: unknown; conversionTerms: unknown;
  authorisedCount: unknown; status: string;
}) {
  return {
    id: row.id,
    recordCode: row.recordCode,
    name: row.name,
    kind: row.kind,
    instrument: row.instrument,
    faceValue: num(row.faceValue as never),
    votesPerShare: num(row.votesPerShare as never) ?? 1,
    rights: (row.rights ?? {}) as Record<string, unknown>,
    conversionTerms: (row.conversionTerms ?? null) as Record<string, unknown> | null,
    authorisedCount: num(row.authorisedCount as never),
    status: row.status,
  };
}

// ---------------------------------------------------------------------------
// Holders
// ---------------------------------------------------------------------------

export interface HolderInput {
  kind: 'person' | 'organization' | 'entity';
  personId?: string;
  organizationId?: string;
  heldByTenantId?: string;
  /** Given instead of `personId` for a `kind: 'person'` holder — goes through `findOrCreatePerson`. */
  person?: { fullName: string; email?: string | null; phone?: string | null };
  residency?: 'resident' | 'non_resident';
  investmentBasis?: 'repatriable' | 'non_repatriable' | null;
  panNumber?: string | null;
  nominee?: Record<string, unknown> | null;
  jointHolders?: unknown[] | null;
}

/**
 * Walks `heldByTenantId`'s own `parentTenantId` chain upward, looking for
 * this tenant. s.19: a subsidiary may not hold its holding's shares — refused
 * here, at creation, rather than left to be noticed on a structure chart.
 *
 * Reads `unscopedPrisma.tenant` because the question is about the shape of the
 * tenant graph, not about any row this tenant owns — the one place in this
 * domain that client appears.
 */
async function assertNotHoldingsAncestor(heldByTenantId: string, thisTenantId: string): Promise<void> {
  let cursor: string | null = heldByTenantId;
  let steps = 0;
  while (cursor && steps < 8) {
    if (cursor === thisTenantId) {
      throw ApiError.unprocessable(
        's.19 of the Companies Act: a subsidiary may not hold shares in its own holding company. ' +
          'The entity named here already sits above this one in the group, so this holder cannot be created.',
      );
    }
    const t: { parentTenantId: string | null } | null = await unscopedPrisma.tenant.findFirst({
      where: { id: cursor },
      select: { parentTenantId: true },
    });
    cursor = t?.parentTenantId ?? null;
    steps += 1;
  }
}

export async function createHolder(input: HolderInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'holders', verb: 'create' });

  const set = [input.personId, input.organizationId, input.heldByTenantId, input.person].filter((v) => v !== undefined);
  if (input.kind === 'person' && !input.personId && !input.person) {
    throw ApiError.badRequest('A person holder needs either personId or a {fullName, email, phone} to create one.');
  }
  if (input.kind === 'organization' && !input.organizationId) {
    throw ApiError.badRequest('An organisation holder needs organizationId.');
  }
  if (input.kind === 'entity' && !input.heldByTenantId) {
    throw ApiError.badRequest('An entity holder needs heldByTenantId.');
  }
  if (set.length > 1) {
    throw ApiError.badRequest('A holder is exactly one of a person, an organisation or a group entity — not more than one.');
  }

  if (input.kind === 'entity' && input.heldByTenantId) {
    await assertNotHoldingsAncestor(input.heldByTenantId, auth.tenantId);
  }

  if (input.residency === 'non_resident' && !input.investmentBasis) {
    throw ApiError.unprocessable(
      'A non-resident holder must state the investment basis — repatriable or non-repatriable (Schedule IV) — because it decides the FEMA filing calendar (FC-GPR/FC-TRS/FLA) for every allotment and transfer to them.',
    );
  }

  let personId = input.personId ?? null;
  if (input.kind === 'person' && !personId && input.person) {
    const resolved = await findOrCreatePerson({
      fullName: input.person.fullName,
      primaryEmail: input.person.email ?? null,
      primaryPhone: input.person.phone ?? null,
      source: 'equity',
    });
    personId = resolved.person.id;
  }

  const folioNumber = await nextFolioNumber();

  const row = await prisma.holder.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('HLD'),
      kind: input.kind,
      personId,
      organizationId: input.organizationId ?? null,
      heldByTenantId: input.heldByTenantId ?? null,
      folioNumber,
      residency: input.residency ?? 'resident',
      investmentBasis: input.investmentBasis ?? null,
      panNumber: input.panNumber ?? null,
      nominee: (input.nominee ?? undefined) as never,
      jointHolders: (input.jointHolders ?? undefined) as never,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'holder', subjectId: row.id, after: { folioNumber, kind: row.kind } });
  await emit({
    name: EVENTS.HOLDER_CREATED,
    subject: { entityType: 'holder', entityId: row.id, recordCode: row.recordCode },
    newState: { kind: row.kind, folioNumber },
  });

  return holderView(row);
}

export interface HolderUpdateInput {
  residency?: 'resident' | 'non_resident';
  investmentBasis?: 'repatriable' | 'non_repatriable' | null;
  panNumber?: string | null;
  nominee?: Record<string, unknown> | null;
  jointHolders?: unknown[] | null;
  status?: 'active' | 'ceased';
}

/** Contact/nominee/residency/status. `heldByTenantId` never changes once set. */
export async function updateHolder(id: string, input: HolderUpdateInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'holders', verb: 'edit' });

  const existing = await prisma.holder.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!existing) throw ApiError.notFound('Holder');

  const residency = input.residency ?? existing.residency;
  const investmentBasis = input.investmentBasis !== undefined ? input.investmentBasis : existing.investmentBasis;
  if (residency === 'non_resident' && !investmentBasis) {
    throw ApiError.unprocessable('A non-resident holder must state the investment basis.');
  }

  const updated = await prisma.holder.update({
    where: { id },
    data: {
      ...(input.residency !== undefined ? { residency: input.residency } : {}),
      ...(input.investmentBasis !== undefined ? { investmentBasis: input.investmentBasis } : {}),
      ...(input.panNumber !== undefined ? { panNumber: input.panNumber } : {}),
      ...(input.nominee !== undefined ? { nominee: input.nominee as never } : {}),
      ...(input.jointHolders !== undefined ? { jointHolders: input.jointHolders as never } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  });

  await auditWrite({ action: 'update', subjectType: 'holder', subjectId: id, before: existing as never, after: updated as never });
  return holderView(updated);
}

async function isOwnHolder(holder: { kind: string; personId: string | null; organizationId: string | null }): Promise<boolean> {
  const auth = currentAuth();
  if (!auth.partyId) return false;
  if (holder.kind === 'person') return holder.personId === auth.partyId;
  if (holder.kind === 'organization' && holder.organizationId) {
    const affiliation = await prisma.affiliation.findFirst({
      where: { tenantId: auth.tenantId, partyId: auth.partyId, counterpartyId: holder.organizationId, status: 'active' },
    });
    return Boolean(affiliation);
  }
  return false;
}

export async function listHolders() {
  const auth = currentAuth();
  await assertCan({ resource: 'holders', verb: 'view' });
  const scope = await scopeFor('holders', 'view');
  const rows = await prisma.holder.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
  if (scope === 'all') return Promise.all(rows.map((r) => holderView(r)));
  const own = await Promise.all(rows.map(async (r) => ((await isOwnHolder(r)) ? r : null)));
  return Promise.all(own.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => holderView(r)));
}

export async function holder(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'holders', verb: 'view' });
  const row = await prisma.holder.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!row) throw ApiError.notFound('Holder');
  const scope = await scopeFor('holders', 'view');
  if (scope !== 'all' && !(await isOwnHolder(row))) throw ApiError.notFound('Holder');
  return holderView(row);
}

async function holderView(row: {
  id: string; recordCode: string; kind: string; personId: string | null; organizationId: string | null;
  heldByTenantId: string | null; folioNumber: string; residency: string; investmentBasis: string | null; status: string;
}) {
  let displayName = row.folioNumber;
  if (row.kind === 'person' && row.personId) {
    const p = await prisma.person.findFirst({ where: { id: row.personId }, select: { fullName: true } });
    displayName = p?.fullName ?? displayName;
  } else if (row.kind === 'organization' && row.organizationId) {
    const o = await prisma.organization.findFirst({ where: { id: row.organizationId }, select: { name: true } });
    displayName = o?.name ?? displayName;
  } else if (row.kind === 'entity' && row.heldByTenantId) {
    const t = await unscopedPrisma.tenant.findFirst({ where: { id: row.heldByTenantId }, select: { name: true } });
    displayName = t?.name ?? displayName;
  }
  return {
    id: row.id,
    recordCode: row.recordCode,
    kind: row.kind,
    personId: row.personId,
    organizationId: row.organizationId,
    heldByTenantId: row.heldByTenantId,
    displayName,
    folioNumber: row.folioNumber,
    residency: row.residency,
    investmentBasis: row.investmentBasis,
    status: row.status,
  };
}

/**
 * The `Holder` a share ends up allotted to, found or created — for the ESOP
 * exercise-approval flow (`domains/esop.ts`), which needs a `Holder` for a
 * person who may never have held anything before their first exercise.
 *
 * Gated on `share_ledger:approve`, the same grant `recordExerciseAllotment`
 * and `makeEffective` require, rather than `holders:create` — creating the
 * holder row here is part of completing an already-approved allotment, not
 * the register keeper's general authority to add a holder.
 */
export async function holderForExercise(personId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'approve' });

  const existing = await prisma.holder.findFirst({ where: { tenantId: auth.tenantId, kind: 'person', personId } });
  if (existing) return holderView(existing);

  const folioNumber = await nextFolioNumber();
  const row = await prisma.holder.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('HLD'),
      kind: 'person',
      personId,
      folioNumber,
      residency: 'resident',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'holder', subjectId: row.id, after: { folioNumber, kind: row.kind } });
  await emit({
    name: EVENTS.HOLDER_CREATED,
    subject: { entityType: 'holder', entityId: row.id, recordCode: row.recordCode },
    newState: { kind: row.kind, folioNumber },
  });

  return holderView(row);
}

export interface ExerciseAllotmentInput {
  shareClassId: string;
  toHolderId: string;
  count: number;
  pricePerShare: number;
  effectiveOn: string;
  considerationTransactionId?: string | null;
}

/**
 * Creates an allotment already at `approved`, for a caller — the ESOP
 * exercise-approval flow — that has already gated the underlying decision on
 * its own resource (`option_grants:approve`) and its own self-dealing bar.
 * Held to `share_ledger:approve` (the same grant `makeEffective` itself
 * requires) rather than `share_ledger:create`: an exercise already went
 * through the two-party discipline the manual register's propose/approve
 * split exists for — the employee's own request, and the finance head's
 * approval of it — on `option_grants`, not here.
 */
export async function recordExerciseAllotment(input: ExerciseAllotmentInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'approve' });

  const shareClass = await prisma.shareClass.findFirst({ where: { id: input.shareClassId, tenantId: auth.tenantId } });
  if (!shareClass) throw ApiError.notFound('Share class');
  const toHolder = await prisma.holder.findFirst({ where: { id: input.toHolderId, tenantId: auth.tenantId } });
  if (!toHolder) throw ApiError.notFound('Holder');
  if (input.count <= 0) throw ApiError.badRequest('An allotment must be for a positive number of shares.');

  await assertConsiderationIsEquity(input.considerationTransactionId);

  const row = await prisma.shareTransaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('SHT'),
      type: 'allotment',
      shareClassId: input.shareClassId,
      toHolderId: input.toHolderId,
      count: dec(input.count)!,
      pricePerShare: dec(input.pricePerShare),
      effectiveOn: new Date(input.effectiveOn),
      considerationTransactionId: input.considerationTransactionId ?? null,
      status: 'approved',
      proposedByPartyId: auth.partyId ?? 'system',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'share_transaction', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.ALLOTMENT_PROPOSED,
    subject: { entityType: 'share_transaction', entityId: row.id, recordCode: row.recordCode },
    newState: { shareClassId: row.shareClassId, toHolderId: row.toHolderId, count: input.count, source: 'esop_exercise' },
  });
  await emit({
    name: EVENTS.ALLOTMENT_APPROVED,
    subject: { entityType: 'share_transaction', entityId: row.id, recordCode: row.recordCode },
    newState: { status: 'approved', source: 'esop_exercise' },
  });

  return shareTransactionView(row);
}

export async function nextFolioNumber(): Promise<string> {
  const auth = currentAuth();
  // Its own sequence space, keyed like the document series are (`platform/
  // documentNumber.ts`'s `DOC:${series}` trick) — a folio number never
  // restarts by year, so `year` is pinned at 0 rather than the current one.
  const row = await prisma.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId: auth.tenantId, entityType: 'FOLIO' as never, year: 0 } },
    create: { tenantId: auth.tenantId, entityType: 'FOLIO' as never, year: 0, nextSequence: 2 },
    update: { nextSequence: { increment: 1 } },
    select: { nextSequence: true },
  });
  return `F-${String(row.nextSequence - 1).padStart(5, '0')}`;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

async function assertConsiderationIsEquity(considerationTransactionId: string | null | undefined): Promise<void> {
  if (!considerationTransactionId) return;
  const auth = currentAuth();
  const txn = await prisma.transaction.findFirst({
    where: { tenantId: auth.tenantId, id: considerationTransactionId, deletedAt: null },
    include: { category: true },
  });
  if (!txn) throw ApiError.notFound('Transaction');
  if (txn.category?.kind !== 'equity') {
    throw ApiError.unprocessable(
      "An allotment or a transfer's consideration must reference a Transaction posted to a ledger category of " +
        "kind 'equity' — the rule that keeps EQT from ever holding money movement of its own (§3.6 of the equity-portal plan).",
    );
  }
}

/** Effective balance of one holder in one class: total in minus total out, over effective transactions only. */
async function effectiveBalance(holderId: string, shareClassId: string): Promise<number> {
  const auth = currentAuth();
  const [into, outOf] = await Promise.all([
    prisma.shareTransaction.aggregate({
      where: { tenantId: auth.tenantId, shareClassId, toHolderId: holderId, status: 'effective' },
      _sum: { count: true },
    }),
    prisma.shareTransaction.aggregate({
      where: { tenantId: auth.tenantId, shareClassId, fromHolderId: holderId, status: 'effective' },
      _sum: { count: true },
    }),
  ]);
  return (num(into._sum.count) ?? 0) - (num(outOf._sum.count) ?? 0);
}

export interface ProposeAllotmentInput {
  shareClassId: string;
  toHolderId: string;
  count: number;
  pricePerShare?: number | null;
  effectiveOn: string;
  considerationTransactionId?: string | null;
  boardResolutionRef?: string | null;
}

export async function proposeAllotment(input: ProposeAllotmentInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'create' });

  const shareClass = await prisma.shareClass.findFirst({ where: { id: input.shareClassId, tenantId: auth.tenantId } });
  if (!shareClass) throw ApiError.notFound('Share class');
  const toHolder = await prisma.holder.findFirst({ where: { id: input.toHolderId, tenantId: auth.tenantId } });
  if (!toHolder) throw ApiError.notFound('Holder');
  if (input.count <= 0) throw ApiError.badRequest('An allotment must be for a positive number of shares.');

  await assertConsiderationIsEquity(input.considerationTransactionId);
  const pendingConsideration = Boolean((input.pricePerShare ?? 0) > 0 && !input.considerationTransactionId);

  const row = await prisma.shareTransaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('SHT'),
      type: 'allotment',
      shareClassId: input.shareClassId,
      toHolderId: input.toHolderId,
      count: dec(input.count)!,
      pricePerShare: input.pricePerShare == null ? null : dec(input.pricePerShare),
      effectiveOn: new Date(input.effectiveOn),
      considerationTransactionId: input.considerationTransactionId ?? null,
      boardResolutionRef: input.boardResolutionRef ?? null,
      status: 'proposed',
      proposedByPartyId: auth.partyId ?? 'system',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'share_transaction', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.ALLOTMENT_PROPOSED,
    subject: { entityType: 'share_transaction', entityId: row.id, recordCode: row.recordCode },
    newState: { shareClassId: row.shareClassId, toHolderId: row.toHolderId, count: input.count, pendingConsideration },
  });

  return shareTransactionView(row);
}

export interface ProposeTransferInput {
  shareClassId: string;
  fromHolderId: string;
  toHolderId: string;
  count: number;
  pricePerShare?: number | null;
  effectiveOn: string;
  considerationTransactionId?: string | null;
}

export async function proposeTransfer(input: ProposeTransferInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'create' });

  const shareClass = await prisma.shareClass.findFirst({ where: { id: input.shareClassId, tenantId: auth.tenantId } });
  if (!shareClass) throw ApiError.notFound('Share class');
  const [fromHolder, toHolder] = await Promise.all([
    prisma.holder.findFirst({ where: { id: input.fromHolderId, tenantId: auth.tenantId } }),
    prisma.holder.findFirst({ where: { id: input.toHolderId, tenantId: auth.tenantId } }),
  ]);
  if (!fromHolder) throw ApiError.notFound('Holder');
  if (!toHolder) throw ApiError.notFound('Holder');
  if (input.count <= 0) throw ApiError.badRequest('A transfer must be for a positive number of shares.');

  const balance = await effectiveBalance(input.fromHolderId, input.shareClassId);
  if (balance < input.count) {
    throw ApiError.unprocessable(
      `This holder's effective balance in this class is ${balance} shares, which is below the ${input.count} being transferred.`,
    );
  }

  await assertConsiderationIsEquity(input.considerationTransactionId);

  const row = await prisma.shareTransaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('SHT'),
      type: 'transfer',
      shareClassId: input.shareClassId,
      fromHolderId: input.fromHolderId,
      toHolderId: input.toHolderId,
      count: dec(input.count)!,
      pricePerShare: input.pricePerShare == null ? null : dec(input.pricePerShare),
      effectiveOn: new Date(input.effectiveOn),
      considerationTransactionId: input.considerationTransactionId ?? null,
      status: 'proposed',
      proposedByPartyId: auth.partyId ?? 'system',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'share_transaction', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.TRANSFER_PROPOSED,
    subject: { entityType: 'share_transaction', entityId: row.id, recordCode: row.recordCode },
    newState: { shareClassId: row.shareClassId, fromHolderId: row.fromHolderId, toHolderId: row.toHolderId, count: input.count },
  });

  return shareTransactionView(row);
}

/**
 * Routes through `platform/approvals.ts` on `share_ledger:approve`, with
 * `resource: 'share_ledger'` overriding the gate's default `${type}s`
 * derivation (there is no ungranted `share_transactions` resource).
 *
 * The owner/subject for the self-dealing bar is the party behind `toHolderId`
 * (allotment) or, for a transfer, whichever of `fromHolderId`/`toHolderId`
 * the approver themselves is behind — the gate takes one `ownerPartyId`, so
 * whichever side matches the actor is the one passed. The proposer can never
 * approve their own proposal at all, checked here explicitly because the
 * gate's owner field is otherwise occupied by the holder side of the check.
 */
export async function approveShareTransaction(id: string) {
  const auth = currentAuth();
  const txn = await prisma.shareTransaction.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!txn) throw ApiError.notFound('Share transaction');
  if (txn.status !== 'proposed') throw ApiError.conflict(`This transaction is already ${txn.status}.`);

  if (txn.proposedByPartyId === auth.partyId) {
    throw ApiError.forbidden('The Self-Dealing Bar is unconditional: a requester may never approve their own step.');
  }

  const [toHolder, fromHolder] = await Promise.all([
    txn.toHolderId ? prisma.holder.findFirst({ where: { id: txn.toHolderId } }) : Promise.resolve(null),
    txn.fromHolderId ? prisma.holder.findFirst({ where: { id: txn.fromHolderId } }) : Promise.resolve(null),
  ]);
  const toParty = toHolder?.personId ?? null;
  const fromParty = fromHolder?.personId ?? null;
  const ownerPartyId = [toParty, fromParty].find((p) => p && p === auth.partyId) ?? toParty ?? fromParty ?? null;

  const value = (num(txn.pricePerShare) ?? 0) * (num(txn.count) ?? 0);

  const result = await evaluateApprovalGate(
    'POL-EQT-SHARE-APPROVAL',
    {
      id: txn.id,
      type: 'share_transaction',
      resource: 'share_ledger',
      label: txn.recordCode,
      ownerPartyId,
      commercialValue: value,
      currency: 'INR',
      strategicValue: null,
      termMonths: null,
    },
    'approve',
  );

  if (!result.permitted) {
    throw ApiError.forbidden(result.reason, [{ axis: 'WHO', passed: false, reason: 'self_dealing_or_authority' }]);
  }

  const updated = await prisma.shareTransaction.update({
    where: { id },
    data: { status: 'approved', approvalDecisionId: result.approvalStepId },
  });

  await auditWrite({ action: 'update', subjectType: 'share_transaction', subjectId: id, before: txn as never, after: updated as never });
  await emit({
    name: txn.type === 'allotment' ? EVENTS.ALLOTMENT_APPROVED : EVENTS.TRANSFER_APPROVED,
    subject: { entityType: 'share_transaction', entityId: id, recordCode: txn.recordCode },
    newState: { status: 'approved' },
  });

  return shareTransactionView(updated);
}

export async function rejectShareTransaction(id: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'approve' });

  const txn = await prisma.shareTransaction.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!txn) throw ApiError.notFound('Share transaction');
  if (txn.status !== 'proposed') throw ApiError.conflict(`This transaction is already ${txn.status}.`);

  const updated = await prisma.shareTransaction.update({ where: { id }, data: { status: 'rejected', note: reason } });
  await auditWrite({ action: 'update', subjectType: 'share_transaction', subjectId: id, before: txn as never, after: updated as never });
  await emit({
    name: EVENTS.SHARE_TRANSACTION_REJECTED,
    subject: { entityType: 'share_transaction', entityId: id, recordCode: txn.recordCode },
    newState: { status: 'rejected', reason },
  });
  return shareTransactionView(updated);
}

/** The next unused distinctive number for a class — one after the ledger's own current max. */
async function nextDistinctiveStart(shareClassId: string): Promise<bigint> {
  const auth = currentAuth();
  const agg = await prisma.shareTransaction.aggregate({
    where: { tenantId: auth.tenantId, shareClassId, status: 'effective', distinctiveTo: { not: null } },
    _max: { distinctiveTo: true },
  });
  return (agg._max.distinctiveTo ?? BigInt(0)) + BigInt(1);
}

async function requireTwoSignatories(): Promise<Array<{ name: string; designation: string }>> {
  const profile = await companyProfile();
  const signatories = (profile.certificateSignatories ?? []) as Array<{ name: string; designation: string }>;
  if (signatories.length < 2) {
    throw ApiError.unprocessable(
      's.46 of the Companies Act requires a share certificate to carry at least two signatories. ' +
        'Set them under Company details before a certificate can be issued.',
    );
  }
  return signatories;
}

async function issueCertificateFor(input: {
  holderId: string;
  shareClassId: string;
  distinctiveFrom: bigint;
  distinctiveTo: bigint;
  count: number;
  issuedOn: Date;
  issuedForTransactionId: string;
}) {
  const auth = currentAuth();
  const signatories = await requireTwoSignatories();
  const holder = await prisma.holder.findFirstOrThrow({ where: { id: input.holderId } });
  const view = await holderView(holder);
  const prefix = await documentPrefix();
  const certificateNumber = await nextDocumentNumber(DOCUMENT_SERIES.certificate, prefix, input.issuedOn);

  const cert = await prisma.shareCertificate.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('CRT'),
      certificateNumber,
      holderId: input.holderId,
      shareClassId: input.shareClassId,
      distinctiveFrom: input.distinctiveFrom,
      distinctiveTo: input.distinctiveTo,
      count: dec(input.count)!,
      issuedOn: input.issuedOn,
      status: 'issued',
      issuedForTransactionId: input.issuedForTransactionId,
      signatories: signatories as never,
      holderNameSnapshot: view.displayName,
    },
  });

  await emit({
    name: EVENTS.CERTIFICATE_ISSUED,
    subject: { entityType: 'share_certificate', entityId: cert.id, recordCode: cert.recordCode },
    newState: { certificateNumber, holderId: input.holderId, count: input.count },
  });

  return cert;
}

/**
 * Assigns distinctive numbers gaplessly per class, issues (or supersedes)
 * certificates, and moves the transaction to `effective`.
 *
 * An allotment appends a fresh range after the class's current maximum. A
 * transfer carries the transferor's lowest-numbered ranges first: their
 * existing `issued` certificates are walked oldest-range-first, consumed
 * until `count` is satisfied (splitting the last one touched if it does not
 * divide evenly), each consumed source certificate is superseded, a new
 * certificate is issued to the recipient for each contiguous range taken, and
 * — when a source certificate was only partly consumed — a further new
 * certificate carries the transferor's remainder.
 */
export async function makeEffective(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'approve' });

  const txn = await prisma.shareTransaction.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!txn) throw ApiError.notFound('Share transaction');
  if (txn.status !== 'approved') throw ApiError.conflict('Only an approved transaction can be made effective.');

  const count = num(txn.count)!;

  if (txn.type === 'allotment') {
    const start = await nextDistinctiveStart(txn.shareClassId);
    const end = start + BigInt(count) - BigInt(1);

    const updated = await prisma.shareTransaction.update({
      where: { id },
      data: { status: 'effective', distinctiveFrom: start, distinctiveTo: end },
    });

    await issueCertificateFor({
      holderId: txn.toHolderId!,
      shareClassId: txn.shareClassId,
      distinctiveFrom: start,
      distinctiveTo: end,
      count,
      issuedOn: txn.effectiveOn,
      issuedForTransactionId: txn.id,
    });

    await auditWrite({ action: 'update', subjectType: 'share_transaction', subjectId: id, before: txn as never, after: updated as never });
    await emit({
      name: EVENTS.ALLOTMENT_EFFECTIVE,
      subject: { entityType: 'share_transaction', entityId: id, recordCode: txn.recordCode },
      newState: { status: 'effective', distinctiveFrom: start.toString(), distinctiveTo: end.toString() },
    });

    return shareTransactionView(updated);
  }

  if (txn.type === 'transfer') {
    const sourceCerts = await prisma.shareCertificate.findMany({
      where: { tenantId: auth.tenantId, holderId: txn.fromHolderId!, shareClassId: txn.shareClassId, status: 'issued' },
      orderBy: { distinctiveFrom: 'asc' },
    });

    let remaining = count;
    const takenRanges: Array<{ from: bigint; to: bigint }> = [];

    for (const cert of sourceCerts) {
      if (remaining <= 0) break;
      const certCount = Number(cert.distinctiveTo - cert.distinctiveFrom) + 1;
      const take = Math.min(remaining, certCount);
      const takenFrom = cert.distinctiveFrom;
      const takenTo = cert.distinctiveFrom + BigInt(take) - BigInt(1);
      takenRanges.push({ from: takenFrom, to: takenTo });

      let newRemainderCertId: string | null = null;
      if (take < certCount) {
        const remainderFrom = takenTo + BigInt(1);
        const remainderCount = certCount - take;
        const remainderCert = await issueCertificateFor({
          holderId: txn.fromHolderId!,
          shareClassId: txn.shareClassId,
          distinctiveFrom: remainderFrom,
          distinctiveTo: cert.distinctiveTo,
          count: remainderCount,
          issuedOn: txn.effectiveOn,
          issuedForTransactionId: txn.id,
        });
        newRemainderCertId = remainderCert.id;
      }

      await prisma.shareCertificate.update({
        where: { id: cert.id },
        data: { status: 'surrendered', supersededById: newRemainderCertId },
      });

      remaining -= take;
    }

    if (remaining > 0) {
      throw ApiError.unprocessable(
        "The transferor's issued certificates do not cover the full count being transferred. " +
          'This should not happen once a transfer has passed the balance check at proposal time — reversing and re-proposing is the safe path.',
      );
    }

    // One certificate to the recipient per contiguous range taken.
    let firstFrom: bigint | null = null;
    let lastTo: bigint | null = null;
    for (const range of takenRanges) {
      const rangeCount = Number(range.to - range.from) + 1;
      await issueCertificateFor({
        holderId: txn.toHolderId!,
        shareClassId: txn.shareClassId,
        distinctiveFrom: range.from,
        distinctiveTo: range.to,
        count: rangeCount,
        issuedOn: txn.effectiveOn,
        issuedForTransactionId: txn.id,
      });
      firstFrom = firstFrom === null || range.from < firstFrom ? range.from : firstFrom;
      lastTo = lastTo === null || range.to > lastTo ? range.to : lastTo;
    }

    const updated = await prisma.shareTransaction.update({
      where: { id },
      data: { status: 'effective', distinctiveFrom: firstFrom, distinctiveTo: lastTo },
    });

    await auditWrite({ action: 'update', subjectType: 'share_transaction', subjectId: id, before: txn as never, after: updated as never });
    await emit({
      name: EVENTS.TRANSFER_EFFECTIVE,
      subject: { entityType: 'share_transaction', entityId: id, recordCode: txn.recordCode },
      newState: { status: 'effective' },
    });

    return shareTransactionView(updated);
  }

  throw ApiError.badRequest(`makeEffective is implemented for allotment and transfer only in phase 1; got "${txn.type}".`);
}

/**
 * Both `share_ledger:create` and `share_ledger:approve` are required — the
 * plan asks for "two people or the chairman"; this reads that as `approve`
 * being the deciding grant (the same grant `makeEffective` already needs),
 * with `create` asserted first so a role holding only `approve` (there is
 * none today, but the check should not silently stop meaning anything if one
 * is ever added) cannot reverse the register on its own either.
 */
export async function reverseShareTransaction(id: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'share_ledger', verb: 'create' });
  await assertCan({ resource: 'share_ledger', verb: 'approve' });

  const txn = await prisma.shareTransaction.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!txn) throw ApiError.notFound('Share transaction');
  if (txn.status !== 'effective') throw ApiError.conflict('Only an effective transaction can be reversed.');

  const reversal = await prisma.shareTransaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('SHT'),
      type: txn.type,
      shareClassId: txn.shareClassId,
      // The opposite entry: what came in goes out and back again.
      fromHolderId: txn.toHolderId,
      toHolderId: txn.fromHolderId,
      count: txn.count,
      pricePerShare: txn.pricePerShare,
      distinctiveFrom: txn.distinctiveFrom,
      distinctiveTo: txn.distinctiveTo,
      effectiveOn: new Date(),
      status: 'effective',
      reversalOfId: txn.id,
      proposedByPartyId: auth.partyId ?? 'system',
      note: reason,
    },
  });

  await prisma.shareTransaction.update({ where: { id }, data: { status: 'reversed', reversedById: reversal.id } });

  // Cancel certificates issued for the reversed transaction; restore what it
  // superseded as new certificates rather than un-cancelling them (§6, the
  // register never edits a certificate back into existence).
  const issued = await prisma.shareCertificate.findMany({ where: { tenantId: auth.tenantId, issuedForTransactionId: txn.id } });
  for (const cert of issued) {
    await prisma.shareCertificate.update({ where: { id: cert.id }, data: { status: 'cancelled' } });
    await emit({
      name: EVENTS.CERTIFICATE_CANCELLED,
      subject: { entityType: 'share_certificate', entityId: cert.id, recordCode: cert.recordCode },
      newState: { status: 'cancelled', reason },
    });

    if (cert.supersededById) continue; // superseded onward already, nothing to restore
  }
  const superseded = await prisma.shareCertificate.findMany({
    where: { tenantId: auth.tenantId, supersededById: { in: issued.map((c) => c.id) } },
  });
  for (const old of superseded) {
    await prisma.shareCertificate.update({ where: { id: old.id }, data: { status: 'issued', supersededById: null } });
  }

  await auditWrite({ action: 'update', subjectType: 'share_transaction', subjectId: id, before: txn as never, after: { status: 'reversed' } });
  await emit({
    name: EVENTS.SHARE_TRANSACTION_REVERSED,
    subject: { entityType: 'share_transaction', entityId: id, recordCode: txn.recordCode },
    related: [{ relation: 'reversed_by', entityType: 'share_transaction', entityId: reversal.id }],
    newState: { status: 'reversed', reversalId: reversal.id, reason },
  });

  return { reversed: shareTransactionView(await prisma.shareTransaction.findFirstOrThrow({ where: { id } })), reversal: shareTransactionView(reversal) };
}

function shareTransactionView(row: {
  id: string; recordCode: string; type: string; shareClassId: string; fromHolderId: string | null;
  toHolderId: string | null; count: unknown; pricePerShare: unknown; distinctiveFrom: unknown; distinctiveTo: unknown;
  effectiveOn: Date | null; status: string; considerationTransactionId: string | null; reversalOfId: string | null;
  reversedById: string | null; proposedByPartyId: string; pricePerShareRaw?: never;
}) {
  const pricePerShare = num(row.pricePerShare as never);
  return {
    id: row.id,
    recordCode: row.recordCode,
    type: row.type,
    shareClassId: row.shareClassId,
    fromHolderId: row.fromHolderId,
    toHolderId: row.toHolderId,
    count: num(row.count as never)!,
    pricePerShare,
    distinctiveFrom: row.distinctiveFrom == null ? null : String(row.distinctiveFrom),
    distinctiveTo: row.distinctiveTo == null ? null : String(row.distinctiveTo),
    effectiveOn: row.effectiveOn ? row.effectiveOn.toISOString() : null,
    status: row.status,
    considerationTransactionId: row.considerationTransactionId,
    pendingConsideration: Boolean((pricePerShare ?? 0) > 0 && !row.considerationTransactionId),
    reversalOfId: row.reversalOfId,
    reversedById: row.reversedById,
    proposedByPartyId: row.proposedByPartyId,
  };
}

export async function listShareLedger() {
  const auth = currentAuth();
  await assertScopeAll('share_ledger');
  const rows = await prisma.shareTransaction.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
  return rows.map(shareTransactionView);
}

// ---------------------------------------------------------------------------
// Cap table & holdings
// ---------------------------------------------------------------------------

/** Two months, per SH-1 (s.56). */
const CERTIFICATE_WINDOW_DAYS = 60;

export async function capTable(asOf?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'cap_table', verb: 'view' });
  await assertScopeAll('cap_table');

  const cutoff = asOf ? new Date(asOf) : new Date();
  const seesMoney = await canSeeMoney('cap_table');

  const [transactions, classes, holders, certs] = await Promise.all([
    prisma.shareTransaction.findMany({
      where: { tenantId: auth.tenantId, status: 'effective', effectiveOn: { lte: cutoff } },
    }),
    prisma.shareClass.findMany({ where: { tenantId: auth.tenantId } }),
    prisma.holder.findMany({ where: { tenantId: auth.tenantId } }),
    prisma.shareCertificate.findMany({ where: { tenantId: auth.tenantId, status: 'issued' } }),
  ]);

  const classById = new Map(classes.map((c) => [c.id, c]));
  const holderById = new Map(holders.map((h) => [h.id, h]));

  // The current holding of each holder in each class, netted from the
  // ledger — the same balance computation `effectiveBalance` uses, done once
  // here over every holder/class pair present.
  type Key = string;
  const net = new Map<Key, number>();
  const pending = new Map<Key, boolean>();
  for (const t of transactions) {
    const cls = classById.get(t.shareClassId);
    if (!cls) continue;
    const amount = num(t.count) ?? 0;
    if (t.toHolderId) {
      const k = `${t.toHolderId}::${t.shareClassId}`;
      net.set(k, (net.get(k) ?? 0) + amount);
      const price = num(t.pricePerShare) ?? 0;
      if (price > 0 && !t.considerationTransactionId) pending.set(k, true);
    }
    if (t.fromHolderId) {
      const k = `${t.fromHolderId}::${t.shareClassId}`;
      net.set(k, (net.get(k) ?? 0) - amount);
    }
  }

  const inputRows: CapTableInputRow[] = [];
  const rowMeta: Array<{ holderId: string; shareClassId: string }> = [];
  for (const [key, count] of net) {
    if (count <= 0) continue;
    const [holderId, shareClassId] = key.split('::');
    const cls = classById.get(shareClassId);
    if (!cls) continue;
    inputRows.push({
      holderId,
      shareClassId,
      count,
      instrument: cls.instrument as never,
      classKind: cls.kind as never,
      status: 'effective',
      pendingConsideration: pending.get(key) ?? false,
    });
    rowMeta.push({ holderId, shareClassId });
  }

  const computed = computeCapTable(inputRows);

  const since = transactions.length
    ? transactions.reduce((min, t) => (t.effectiveOn < min ? t.effectiveOn : min), transactions[0].effectiveOn).toISOString()
    : null;

  const rows = computed.rows.map((r, i) => {
    const holderRow = holderById.get(r.holderId);
    const cls = classById.get(r.shareClassId);
    const holderCerts = certs.filter((c) => c.holderId === r.holderId && c.shareClassId === r.shareClassId);
    const overdue = holderCerts.length === 0 && ageDays(transactionEffectiveFor(rowMeta[i], transactions)) > CERTIFICATE_WINDOW_DAYS;
    return {
      holderId: r.holderId,
      holderName: holderRow ? holderFolio(holderRow) : r.holderId,
      shareClassId: r.shareClassId,
      shareClassName: cls?.name ?? r.shareClassId,
      count: r.count,
      issuedPct: r.issuedPct,
      fullyDilutedPct: r.fullyDilutedPct,
      certificateNumbers: holderCerts.map((c) => c.certificateNumber),
      pendingConsideration: r.pendingConsideration,
      certificateOverdue: overdue,
    };
  });

  const holderTotals = computed.holderTotals.map((h) => ({
    holderId: h.holderId,
    holderName: holderById.get(h.holderId) ? holderFolio(holderById.get(h.holderId)!) : h.holderId,
    totalCount: h.totalCount,
    issuedPct: h.issuedPct,
    fullyDilutedPct: h.fullyDilutedPct,
  }));

  const withheld = !seesMoney;
  void withheld; // cap table carries no money field itself (price is on the ledger), documented for the reader

  return { asOf: cutoff.toISOString(), since, rows, holderTotals };
}

function holderFolio(h: { folioNumber: string }): string {
  return h.folioNumber;
}

function transactionEffectiveFor(meta: { holderId: string; shareClassId: string }, transactions: Array<{ toHolderId: string | null; shareClassId: string; effectiveOn: Date }>): Date {
  const matches = transactions.filter((t) => t.toHolderId === meta.holderId && t.shareClassId === meta.shareClassId);
  if (matches.length === 0) return new Date();
  return matches.reduce((latest, t) => (t.effectiveOn > latest ? t.effectiveOn : latest), matches[0].effectiveOn);
}

function ageDays(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

export async function holdingsFor(holderIdOrMe: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'holdings', verb: 'view' });

  let row: Awaited<ReturnType<typeof prisma.holder.findFirst>>;
  if (holderIdOrMe === 'me') {
    if (!auth.partyId) throw ApiError.notFound('Holder');
    row = await prisma.holder.findFirst({ where: { tenantId: auth.tenantId, personId: auth.partyId } });
    if (!row) throw ApiError.notFound('Holder');
  } else {
    row = await prisma.holder.findFirst({ where: { id: holderIdOrMe, tenantId: auth.tenantId } });
    if (!row) throw ApiError.notFound('Holder');
    const scope = await scopeFor('holdings', 'view');
    if (scope !== 'all' && !(await isOwnHolder(row))) throw ApiError.notFound('Holder');
  }

  const [transactions, classes, certs] = await Promise.all([
    prisma.shareTransaction.findMany({ where: { tenantId: auth.tenantId, status: 'effective', OR: [{ toHolderId: row.id }, { fromHolderId: row.id }] } }),
    prisma.shareClass.findMany({ where: { tenantId: auth.tenantId } }),
    prisma.shareCertificate.findMany({ where: { tenantId: auth.tenantId, holderId: row.id, status: 'issued' } }),
  ]);
  const classById = new Map(classes.map((c) => [c.id, c]));

  const byClass = new Map<string, number>();
  for (const t of transactions) {
    const amount = num(t.count) ?? 0;
    if (t.toHolderId === row.id) byClass.set(t.shareClassId, (byClass.get(t.shareClassId) ?? 0) + amount);
    if (t.fromHolderId === row.id) byClass.set(t.shareClassId, (byClass.get(t.shareClassId) ?? 0) - amount);
  }

  const view = await holderView(row);
  return {
    holderId: row.id,
    holderName: view.displayName,
    rows: [...byClass.entries()]
      .filter(([, count]) => count > 0)
      .map(([shareClassId, count]) => ({
        shareClassId,
        shareClassName: classById.get(shareClassId)?.name ?? shareClassId,
        count,
        certificateNumbers: certs.filter((c) => c.shareClassId === shareClassId).map((c) => c.certificateNumber),
      })),
  };
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

export async function certificate(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'certificates', verb: 'view' });
  const row = await prisma.shareCertificate.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Certificate');

  const scope = await scopeFor('certificates', 'view');
  if (scope !== 'all') {
    const holderRow = await prisma.holder.findFirst({ where: { id: row.holderId } });
    if (!holderRow || !(await isOwnHolder(holderRow))) throw ApiError.notFound('Certificate');
  }

  return {
    id: row.id,
    recordCode: row.recordCode,
    certificateNumber: row.certificateNumber,
    imported: row.imported,
    holderId: row.holderId,
    shareClassId: row.shareClassId,
    distinctiveFrom: String(row.distinctiveFrom),
    distinctiveTo: String(row.distinctiveTo),
    count: num(row.count)!,
    issuedOn: row.issuedOn.toISOString(),
    status: row.status,
    supersededById: row.supersededById,
  };
}

/**
 * Everything a printed SH-1 needs, computed server-side from the
 * certificate's own snapshot fields plus the company's registration —
 * nothing here is recomputed from the current cap table, so the view is
 * unchanged by a later transaction against other shares.
 */
export async function certificateDocument(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'certificates', verb: 'view' });
  const row = await prisma.shareCertificate.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Certificate');

  const scope = await scopeFor('certificates', 'view');
  if (scope !== 'all') {
    const holderRow = await prisma.holder.findFirst({ where: { id: row.holderId } });
    if (!holderRow || !(await isOwnHolder(holderRow))) throw ApiError.notFound('Certificate');
  }

  const [profile, shareClass] = await Promise.all([
    companyProfile(),
    prisma.shareClass.findFirstOrThrow({ where: { id: row.shareClassId } }),
  ]);

  const faceValue = num(shareClass.faceValue);
  const count = num(row.count)!;

  return {
    certificateNumber: row.certificateNumber,
    companyLegalName: profile.legalName,
    companyCin: profile.cin,
    registeredAddress: [profile.addressLine1, profile.addressLine2, profile.city, profile.pincode].filter(Boolean).join(', '),
    holderNameSnapshot: row.holderNameSnapshot,
    folioNumber: (await prisma.holder.findFirst({ where: { id: row.holderId }, select: { folioNumber: true } }))?.folioNumber ?? '',
    shareClassName: shareClass.name,
    faceValue,
    count,
    distinctiveFrom: String(row.distinctiveFrom),
    distinctiveTo: String(row.distinctiveTo),
    issuedOn: row.issuedOn.toISOString(),
    signatories: (row.signatories ?? []) as Array<{ name: string; designation: string }>,
    paidUpAmount: faceValue == null ? null : Math.round(faceValue * count * 100) / 100,
  };
}

export async function listCertificates() {
  const auth = currentAuth();
  await assertCan({ resource: 'certificates', verb: 'view' });
  const scope = await scopeFor('certificates', 'view');
  const rows = await prisma.shareCertificate.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { issuedOn: 'desc' } });
  if (scope === 'all') return rows.map(certView);
  const own: typeof rows = [];
  for (const r of rows) {
    const h = await prisma.holder.findFirst({ where: { id: r.holderId } });
    if (h && (await isOwnHolder(h))) own.push(r);
  }
  return own.map(certView);
}

function certView(row: {
  id: string; recordCode: string; certificateNumber: string; imported: boolean; holderId: string; shareClassId: string;
  distinctiveFrom: bigint; distinctiveTo: bigint; count: unknown; issuedOn: Date; status: string; supersededById: string | null;
}) {
  return {
    id: row.id,
    recordCode: row.recordCode,
    certificateNumber: row.certificateNumber,
    imported: row.imported,
    holderId: row.holderId,
    shareClassId: row.shareClassId,
    distinctiveFrom: String(row.distinctiveFrom),
    distinctiveTo: String(row.distinctiveTo),
    count: num(row.count as never)!,
    issuedOn: row.issuedOn.toISOString(),
    status: row.status,
    supersededById: row.supersededById,
  };
}

// ---------------------------------------------------------------------------
// Valuations
// ---------------------------------------------------------------------------

export interface ValuationInput {
  asOf: string;
  basis: string;
  valuerName?: string | null;
  perShareByClass: Record<string, number>;
  equityValue?: number | null;
  reportRef?: string | null;
  validUntil?: string | null;
  note?: string | null;
}

export async function recordValuation(input: ValuationInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'valuations', verb: 'create' });

  const row = await prisma.valuation.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('VAL'),
      asOf: new Date(input.asOf),
      basis: input.basis,
      valuerName: input.valuerName ?? null,
      perShareByClass: input.perShareByClass as never,
      equityValue: input.equityValue == null ? null : dec(input.equityValue),
      reportRef: input.reportRef ?? null,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
      note: input.note ?? null,
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'valuation', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.VALUATION_RECORDED,
    subject: { entityType: 'valuation', entityId: row.id, recordCode: row.recordCode },
    newState: { basis: row.basis, asOf: row.asOf.toISOString() },
  });

  return valuationView(row);
}

export async function listValuations() {
  const auth = currentAuth();
  await assertCan({ resource: 'valuations', verb: 'view' });
  const rows = await prisma.valuation.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { asOf: 'desc' } });
  return rows.map(valuationView);
}

function valuationView(row: {
  id: string; recordCode: string; asOf: Date; basis: string; valuerName: string | null; perShareByClass: unknown;
  equityValue: unknown; reportRef: string | null; validUntil: Date | null; note: string | null;
}) {
  return {
    id: row.id,
    recordCode: row.recordCode,
    asOf: row.asOf.toISOString(),
    basis: row.basis,
    valuerName: row.valuerName,
    perShareByClass: (row.perShareByClass ?? {}) as Record<string, number>,
    equityValue: num(row.equityValue as never),
    reportRef: row.reportRef,
    validUntil: row.validUntil ? row.validUntil.toISOString() : null,
    note: row.note,
  };
}

// ---------------------------------------------------------------------------
// Entity documents
// ---------------------------------------------------------------------------

export interface EntityDocumentInput {
  title: string;
  kind: string;
  audience: 'shareholders' | 'board' | 'secretary';
  fileRef: string;
  relatedType?: string | null;
  relatedId?: string | null;
}

export async function publishDocument(input: EntityDocumentInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'entity_documents', verb: 'create' });

  const row = await prisma.entityDocument.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('DOC'),
      title: input.title,
      kind: input.kind,
      audience: input.audience,
      fileRef: input.fileRef,
      uploadedByPartyId: auth.partyId ?? 'system',
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'entity_document', subjectId: row.id, after: { title: row.title, audience: row.audience } });
  await emit({
    name: EVENTS.ENTITY_DOCUMENT_PUBLISHED,
    subject: { entityType: 'entity_document', entityId: row.id, recordCode: row.recordCode },
    newState: { audience: row.audience, kind: row.kind },
  });

  return entityDocumentView(row);
}

/**
 * A shareholder sees `audience: 'shareholders'` only; a director also
 * `board`; the secretary and chairman see every audience — narrowed by what
 * else the principal is granted, not by comparing a role slug (§7 of the
 * plan: no service code compares one). Everyone who may view entity
 * documents at all sees `shareholders`; also holding a view of the board
 * calendar (`board_meetings:view` — director, secretary, chairman) adds
 * `board`; also holding `entity_documents:create` (the register keepers —
 * secretary, chairman) adds `secretary` too, which between the two grants
 * covers every audience for whoever keeps the register.
 */
export async function listDocuments(audienceFilter?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'entity_documents', verb: 'view' });

  const allowed = new Set<string>(['shareholders']);
  if (await can({ resource: 'board_meetings', verb: 'view' })) allowed.add('board');
  if (await can({ resource: 'entity_documents', verb: 'create' })) {
    allowed.add('board');
    allowed.add('secretary');
  }

  const rows = await prisma.entityDocument.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      audience: { in: [...allowed] },
      ...(audienceFilter ? { audience: audienceFilter } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(entityDocumentView);
}

function entityDocumentView(row: {
  id: string; recordCode: string; title: string; kind: string; audience: string; fileRef: string;
  uploadedByPartyId: string; createdAt: Date;
}) {
  return {
    id: row.id,
    recordCode: row.recordCode,
    title: row.title,
    kind: row.kind,
    audience: row.audience,
    fileRef: row.fileRef,
    uploadedByPartyId: row.uploadedByPartyId,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Compliance: SH-1 within two months (s.56)
// ---------------------------------------------------------------------------

/**
 * Raised once per share transaction (the idempotency fingerprint), by the
 * daily `certificate_window` job in `jobs/scheduler.ts`. Echoed live as
 * `certificateOverdue` on the cap table row so a viewer does not have to wait
 * for the next tick to see it.
 */
export async function detectOverdueCertificates(): Promise<number> {
  const auth = currentAuth();
  const cutoff = new Date(Date.now() - CERTIFICATE_WINDOW_DAYS * 86_400_000);

  const overdue = await prisma.shareTransaction.findMany({
    where: {
      tenantId: auth.tenantId,
      status: 'effective',
      type: { in: ['allotment', 'transfer'] },
      effectiveOn: { lt: cutoff },
    },
  });

  let raised = 0;
  for (const t of overdue) {
    if (!t.toHolderId) continue;
    const covering = await prisma.shareCertificate.findFirst({
      where: { tenantId: auth.tenantId, holderId: t.toHolderId, shareClassId: t.shareClassId, issuedForTransactionId: t.id },
    });
    if (covering) continue;

    await raiseException({
      code: 'EX-EQT-002',
      label: 'Share certificate overdue (SH-1, two months)',
      severity: 'S2_WARNING',
      subjectType: 'share_transaction',
      subjectId: t.id,
      subjectLabel: t.recordCode,
      domain: 'eqt',
      detail: `s.56 requires a certificate within two months of an allotment or transfer going effective. ${t.recordCode} went effective on ${t.effectiveOn.toISOString().slice(0, 10)} and no certificate has been issued against it.`,
      reasonCode: 'sh1_window_exceeded',
      triggerFingerprint: `certificate_overdue:${t.id}`,
    });
    raised += 1;
  }
  return raised;
}
