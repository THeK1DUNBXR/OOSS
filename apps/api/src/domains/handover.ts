/**
 * The handover gate (Wave 6, SPINE-CONTRACT 1.7; OPUS decision 14).
 *
 * An exit (the offboarding settlement, FFSettlementCompleted, which runs the
 * access-revocation hook) is refused while the leaver still owns an
 * open Commitment, Case or Lead, or holds an asset in custody, with no successor
 * named for it. There is no table for this: the gate reads the rows, under FOR
 * UPDATE, in the same transaction as the exit, so the check and the transition
 * cannot be separated by a concurrent assignment (ownership.ts says how).
 *
 * The two halves run at different points in that transaction, on purpose:
 *   - planHandover runs in the transition's `write` step, before the status change
 *     and before any audit or event. It locks, validates, and refuses (409) or
 *     plans. It emits nothing, because the lock order requires the transition's
 *     audit to be the first lock taken after it.
 *   - executeHandover runs in `after`, once the transition's audit and event are
 *     written. Each move goes through its domain's governed path (assertCan was
 *     checked outside, then the write, audit and event inside).
 */
import type { AssetAssignment, Case, Commitment, Lead } from '@prisma/client';
import { EVENTS } from '@kaizen/shared';
import { Prisma, type DbTx } from '../platform/db.js';
import { auditWrite } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { ApiError } from '../platform/errors.js';
import { can, scopeFor } from '../platform/permissions.js';
import { authoriseCaseHandover, handOverCaseInTx, OPEN_CASE_STATES } from './cases.js';
import { authoriseCommitmentHandover, handOverCommitmentInTx, OPEN_COMMITMENT_STATES } from './commitments.js';
import { authoriseCustodyHandover, transferCustodyInTx } from './hcm/assets.js';
import { authoriseLeadHandover, handOverLeadInTx } from './leads.js';
import { partyStatus } from './ownership.js';

export const HANDOVER_KINDS = ['commitment', 'case', 'lead', 'asset_custody'] as const;
export type HandoverKind = (typeof HANDOVER_KINDS)[number];

/** One open row the leaver still owns. This is the shape the 409 and the override audit name each row by. */
export interface HandoverRowRef {
  kind: HandoverKind;
  id: string;
  recordCode: string | null;
}

/**
 * What the 409 shows for a kind the caller may not view: how many rows, and nothing that
 * identifies them. The gate counts every row either way; this only decides what is shown.
 */
export interface HandoverWithheld {
  kind: HandoverKind;
  count: number;
  withheld: true;
}

export interface HandoverRowInput {
  kind: HandoverKind;
  id: string;
  successorPartyId: string;
}

/** A successor for every open row (`successorPartyId`), or one per row (`rows`), which wins over it. */
export interface HandoverInput {
  successorPartyId?: string;
  rows?: HandoverRowInput[];
}

/** A waiver: the exit goes ahead with the rows that have no successor left with the leaver. */
export interface HandoverOverrideInput {
  reason: string;
}

/** A minimum that a reason has to clear, counted without whitespace. Short reasons are not reasons. */
export const OVERRIDE_REASON_MIN_CHARS = 20;

type LockedRow =
  | { kind: 'commitment'; ref: HandoverRowRef; row: Commitment }
  | { kind: 'case'; ref: HandoverRowRef; row: Case }
  | { kind: 'lead'; ref: HandoverRowRef; row: Lead }
  | { kind: 'asset_custody'; ref: HandoverRowRef; row: AssetAssignment };

export interface HandoverPlan {
  moves: Array<{ locked: LockedRow; successorPartyId: string; successorEmploymentId: string | null }>;
  unhanded: HandoverRowRef[];
}

const rowKey = (kind: string, id: string) => `${kind}:${id}`;

/**
 * The grants for every kind the handover touches, checked before the transaction.
 * The grant check reads on the scoped client, which cannot run inside a transaction
 * this code did not open, so it runs here, as the transition's own check does.
 */
export async function authoriseHandover(handover: HandoverInput): Promise<void> {
  if (handover.successorPartyId !== undefined && !handover.successorPartyId.trim()) {
    throw ApiError.unprocessable('A successor must name a person.');
  }
  const seen = new Set<string>();
  for (const r of handover.rows ?? []) {
    if (!r.successorPartyId?.trim()) throw ApiError.unprocessable('Each row needs a successor named.', { row: r });
    if (seen.has(rowKey(r.kind, r.id)))
      throw ApiError.unprocessable('A row is named twice in the handover.', { row: r });
    seen.add(rowKey(r.kind, r.id));
  }

  const kinds = new Set<HandoverKind>(handover.successorPartyId !== undefined ? HANDOVER_KINDS : []);
  for (const r of handover.rows ?? []) kinds.add(r.kind);
  if (kinds.has('commitment')) await authoriseCommitmentHandover();
  if (kinds.has('case')) await authoriseCaseHandover();
  if (kinds.has('lead')) await authoriseLeadHandover();
  if (kinds.has('asset_custody')) await authoriseCustodyHandover();
}

/**
 * The kinds of blocker the caller may see named. Each kind uses the check its own list
 * route makes, so the 409 never shows a row the caller could not list:
 *   commitment  listCommitments, commitments.ts:256-257 (assertCan view)
 *   case        listCases, cases.ts:327-329 (assertCan view)
 *   lead        listLeads, leads.ts:460-463 (scopeFor view, forbidden when null)
 *   asset_custody  listAssetAssignments, hcm/assets.ts:189-191 (assertCan view)
 * Read before the transaction: these reads go through the scoped client, which cannot
 * run inside a transaction this code did not open (as authoriseHandover says).
 */
export async function viewableHandoverKinds(): Promise<ReadonlySet<HandoverKind>> {
  const kinds = new Set<HandoverKind>();
  if (await can({ resource: 'commitments', verb: 'view' })) kinds.add('commitment');
  if (await can({ resource: 'cases', verb: 'view' })) kinds.add('case');
  if ((await scopeFor('leads', 'view')) !== null) kinds.add('lead');
  if (await can({ resource: 'asset_assignments', verb: 'view' })) kinds.add('asset_custody');
  return kinds;
}

/**
 * The blocker list for the 409. A row of a kind the caller may view is named as it
 * always was. Every row of a kind the caller may not view is folded into one
 * `{ kind, count, withheld }` entry, at the place that kind first appears.
 */
export function blockersFor(
  unhanded: HandoverRowRef[],
  viewable: ReadonlySet<HandoverKind>,
): Array<HandoverRowRef | HandoverWithheld> {
  const entries: Array<HandoverRowRef | HandoverWithheld> = [];
  const withheld = new Map<HandoverKind, HandoverWithheld>();
  for (const row of unhanded) {
    if (viewable.has(row.kind)) {
      entries.push(row);
      continue;
    }
    let entry = withheld.get(row.kind);
    if (!entry) {
      entry = { kind: row.kind, count: 0, withheld: true };
      withheld.set(row.kind, entry);
      entries.push(entry);
    }
    entry.count += 1;
  }
  return entries;
}

/**
 * Locks the leaver and every named successor, then the leaver's open rows, and
 * works out where each one goes. Refuses (409, the blockers listed) when a row has
 * no successor and no waiver allows it to stay with the leaver.
 */
export async function planHandover(
  tx: DbTx,
  args: {
    tenantId: string;
    leaverPersonId: string;
    handover?: HandoverInput;
    allowUnhanded: boolean;
    /** The kinds the caller may view, from viewableHandoverKinds. Decides what the 409 names, never whether it refuses. */
    viewable: ReadonlySet<HandoverKind>;
  },
): Promise<HandoverPlan> {
  const { tenantId, leaverPersonId, handover } = args;
  const successorIds = [
    ...new Set(
      [handover?.successorPartyId, ...(handover?.rows ?? []).map((r) => r.successorPartyId)].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];

  // The people first, in one statement in id order. Any two exits that lock the same
  // pair of people take them in the same order, so they cannot wait on each other.
  const parties = [...new Set([leaverPersonId, ...successorIds])];
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM people WHERE "tenantId" = ${tenantId} AND id IN (${Prisma.join(parties)}) ORDER BY id FOR UPDATE`,
  );

  const rows = await lockOpenRows(tx, tenantId, leaverPersonId);
  const byKey = new Map(rows.map((r) => [rowKey(r.ref.kind, r.ref.id), r]));

  const named = new Map<string, HandoverRowInput>();
  for (const r of handover?.rows ?? []) {
    const key = rowKey(r.kind, r.id);
    if (!byKey.has(key)) {
      throw ApiError.unprocessable('A row named in the handover is not an open row this person owns.', {
        kind: r.kind,
        id: r.id,
      });
    }
    named.set(key, r);
  }

  const activeEmployment = new Map<string, string | null>();
  const moves: HandoverPlan['moves'] = [];
  const unhanded: HandoverRowRef[] = [];
  for (const locked of rows) {
    const successorPartyId =
      named.get(rowKey(locked.ref.kind, locked.ref.id))?.successorPartyId ?? handover?.successorPartyId ?? null;
    if (successorPartyId === null) {
      unhanded.push(locked.ref);
      continue;
    }
    if (!activeEmployment.has(successorPartyId)) {
      activeEmployment.set(successorPartyId, await checkSuccessor(tx, tenantId, leaverPersonId, successorPartyId));
    }
    const successorEmploymentId = activeEmployment.get(successorPartyId) ?? null;
    if (locked.kind === 'asset_custody' && successorEmploymentId === null) {
      throw ApiError.unprocessable(
        'The successor has no active employment, so cannot hold an asset in custody. Name a different successor for the asset.',
        { kind: locked.kind, id: locked.ref.id },
      );
    }
    moves.push({ locked, successorPartyId, successorEmploymentId });
  }

  if (unhanded.length > 0 && !args.allowUnhanded) {
    throw ApiError.conflict(
      `This person still owns ${unhanded.length} open row${unhanded.length === 1 ? '' : 's'} with no successor. ` +
        'Name a successor for each, or record a handover override with a reason.',
      { blockers: blockersFor(unhanded, args.viewable) },
    );
  }
  return { moves, unhanded };
}

/**
 * Makes each move through its domain's governed path, in the exit's transaction.
 * The leaver's rows that were not handed over are left as they were, and are the
 * waiver's concern, not this function's.
 */
export async function executeHandover(tx: DbTx, plan: HandoverPlan, reason: string): Promise<void> {
  for (const move of plan.moves) {
    const { locked, successorPartyId, successorEmploymentId } = move;
    switch (locked.kind) {
      case 'commitment':
        await handOverCommitmentInTx(tx, locked.row, successorPartyId, reason);
        break;
      case 'case':
        await handOverCaseInTx(tx, locked.row, successorPartyId, reason);
        break;
      case 'lead':
        await handOverLeadInTx(tx, locked.row, successorPartyId, reason);
        break;
      case 'asset_custody':
        if (successorEmploymentId === null) throw ApiError.unprocessable('The successor has no active employment.');
        await transferCustodyInTx(tx, locked.row, successorEmploymentId, reason);
        break;
    }
  }
}

/** The override's audit row: the reason, and the rows left with the leaver. The transition's own audit row is separate. */
export async function recordHandoverOverride(
  tx: DbTx,
  args: { offboardingId: string; leaverPersonId: string; reason: string; rowsLeftOpen: HandoverRowRef[] },
): Promise<void> {
  await auditWrite({
    action: 'update',
    subjectType: 'offboarding',
    subjectId: args.offboardingId,
    meta: { handoverOverride: { reason: args.reason, rowsLeftOpen: args.rowsLeftOpen } },
    tx,
  });
  await emit({
    name: EVENTS.OFFBOARDING_HANDOVER_OVERRIDE_RECORDED,
    subject: { entityType: 'offboarding', entityId: args.offboardingId },
    newState: { rowsLeftOpen: args.rowsLeftOpen.length },
    reason: { reasonCode: 'handover_override', note: args.reason },
    owner: { partyId: args.leaverPersonId },
    impact: { domains: ['hr'] },
    tx,
  });
}

/**
 * Reads and locks the leaver's open rows, in a fixed order: commitments, cases,
 * leads, then custody. A row that is not open is not a blocker, so its state is
 * part of each query, using the same lists the domains use.
 */
async function lockOpenRows(tx: DbTx, tenantId: string, personId: string): Promise<LockedRow[]> {
  const ids = async (sql: Prisma.Sql) => (await tx.$queryRaw<{ id: string }[]>(sql)).map((r) => r.id);

  const commitmentIds = await ids(
    Prisma.sql`SELECT id FROM commitments WHERE "tenantId" = ${tenantId} AND "ownerPartyId" = ${personId} AND state IN (${Prisma.join(OPEN_COMMITMENT_STATES)}) ORDER BY id FOR UPDATE`,
  );
  const caseIds = await ids(
    Prisma.sql`SELECT id FROM cases WHERE "tenantId" = ${tenantId} AND "ownerPartyId" = ${personId} AND state IN (${Prisma.join(OPEN_CASE_STATES)}) ORDER BY id FOR UPDATE`,
  );
  const leadIds = await ids(
    Prisma.sql`SELECT id FROM leads WHERE "tenantId" = ${tenantId} AND "ownerPartyId" = ${personId} AND "leadStatus" = 'open' ORDER BY id FOR UPDATE`,
  );
  const employments = await tx.employmentRelationship.findMany({
    where: { tenantId, personId },
    select: { id: true },
  });
  const assignmentIds =
    employments.length === 0
      ? []
      : await ids(
          Prisma.sql`SELECT id FROM hcm_assets_asset_assignments WHERE "tenantId" = ${tenantId} AND "employmentRelationshipId" IN (${Prisma.join(employments.map((e) => e.id))}) AND "returnedOn" IS NULL ORDER BY id FOR UPDATE`,
        );

  const commitments = commitmentIds.length
    ? await tx.commitment.findMany({ where: { id: { in: commitmentIds } }, orderBy: { id: 'asc' } })
    : [];
  const cases = caseIds.length
    ? await tx.case.findMany({ where: { id: { in: caseIds } }, orderBy: { id: 'asc' } })
    : [];
  const leads = leadIds.length
    ? await tx.lead.findMany({ where: { id: { in: leadIds } }, orderBy: { id: 'asc' } })
    : [];
  const assignments = assignmentIds.length
    ? await tx.assetAssignment.findMany({
        where: { id: { in: assignmentIds } },
        include: { asset: true },
        orderBy: { id: 'asc' },
      })
    : [];

  return [
    ...commitments.map((row): LockedRow => ({
      kind: 'commitment',
      ref: { kind: 'commitment', id: row.id, recordCode: row.recordCode },
      row,
    })),
    ...cases.map((row): LockedRow => ({
      kind: 'case',
      ref: { kind: 'case', id: row.id, recordCode: row.recordCode },
      row,
    })),
    ...leads.map((row): LockedRow => ({
      kind: 'lead',
      ref: { kind: 'lead', id: row.id, recordCode: row.recordCode },
      row,
    })),
    ...assignments.map(({ asset, ...row }): LockedRow => ({
      kind: 'asset_custody',
      ref: { kind: 'asset_custody', id: row.id, recordCode: asset.recordCode },
      row,
    })),
  ];
}

/**
 * A successor must be an active person in this tenant: not the leaver, not a
 * merged duplicate, and not someone leaving or gone. Returns the employment that
 * would hold custody, when they have an active one.
 */
async function checkSuccessor(
  tx: DbTx,
  tenantId: string,
  leaverPersonId: string,
  successorPartyId: string,
): Promise<string | null> {
  if (successorPartyId === leaverPersonId) {
    throw ApiError.unprocessable('The person leaving cannot take over their own rows.');
  }
  const person = await tx.person.findFirst({
    where: { id: successorPartyId, tenantId, deletedAt: null },
    select: { dedupeStatus: true },
  });
  if (!person) throw ApiError.notFound('Successor');
  if (person.dedupeStatus !== 'active') {
    throw ApiError.unprocessable('The successor is a merged or flagged duplicate, not an active person.');
  }
  const status = await partyStatus(tx, tenantId, successorPartyId);
  if (status !== 'active') {
    throw ApiError.unprocessable(
      `The successor is ${status === 'leaving' ? 'leaving' : 'no longer with the company'}, so cannot take over rows.`,
    );
  }
  const employment = await tx.employmentRelationship.findFirst({
    where: { tenantId, personId: successorPartyId, status: 'Active' },
    select: { id: true },
  });
  return employment?.id ?? null;
}
