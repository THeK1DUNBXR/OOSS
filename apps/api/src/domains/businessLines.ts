/**
 * The business-line registry (VERTICAL-TAXONOMY s.6-7; ACCESS-MODEL-PLAN s.10).
 *
 * Every write here is assertCan → write → auditWrite → emit (CLAUDE.md rule 5).
 * The database keeps the invariants that must hold for any writer (immutable
 * keys, overlapping dates, basis points totalling 10,000 at commit); this module
 * adds the checks that need the caller's context and the refusals a person can
 * act on. A retired line takes no new writes (Opus decision N): that is checked
 * here, not in a trigger, and the test asserts it.
 *
 * Dates are IST calendar days, given as YYYY-MM-DD and stored as UTC midnight
 * (CLAUDE.md rule 3). "Today" is today's IST day, so the 00:00-05:30 IST window
 * on the 1st does not fall into the previous month.
 */

import type {
  BusinessLine,
  BusinessLineSuccessor,
  LineDistribution,
  LineDistributionLine,
  Prisma,
} from '@prisma/client';
import { EVENTS, istDateKey } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan } from '../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';

registerGovernedEntities('org', [
  'business_line',
  'business_line_successor',
  'line_distribution',
  'line_distribution_line',
]);

/** Two to twelve characters, uppercase, starting with a letter. A code is a key, read aloud. */
const CODE_PATTERN = /^[A-Z][A-Z0-9]{1,11}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The whole of a split or a distribution, in basis points (1 bp = 0.01%). */
const WHOLE = 10000;

/** An IST calendar day given as YYYY-MM-DD, stored as UTC midnight. */
export function istDay(iso: string): Date {
  if (!ISO_DAY.test(iso)) throw ApiError.badRequest('Dates are IST calendar days, given as YYYY-MM-DD.');
  const d = new Date(`${iso}T00:00:00.000Z`);
  // Date rolls an impossible day such as 2030-02-31 into March; the round trip catches it.
  if (Number.isNaN(d.getTime()) || istDateKey(d) !== iso) {
    throw ApiError.badRequest(`${iso} is not a calendar day.`);
  }
  return d;
}

/** Today's IST day. A UTC read would put 00:00-05:30 IST in yesterday. */
export function todayIst(): Date {
  return istDay(istDateKey(new Date()));
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function reasonOf(text: string): string {
  const note = text.trim();
  if (note.length < 3) throw ApiError.badRequest('Every registry change states why it is made.');
  return note;
}

export function textOf(value: string, field: string, max: number): string {
  const v = value.trim();
  if (v.length === 0 || v.length > max) throw ApiError.badRequest(`${field} is required, at most ${max} characters.`);
  return v;
}

/** Retired on `day` when the end is on or before it. The end is exclusive. */
function retiredOn(line: Pick<BusinessLine, 'effectiveTo'>, day: Date): boolean {
  return line.effectiveTo !== null && line.effectiveTo <= day;
}

/**
 * A line may start a distribution, or receive a successor, on `day` only while
 * it is in force that day. A line not yet in force and a retired line are
 * refused separately so the message says which.
 */
export function assertOpenOn(line: BusinessLine, day: Date, use: string): void {
  if (line.effectiveFrom > day) {
    throw ApiError.conflict(
      `Business line ${line.code} is not in force until ${isoDay(line.effectiveFrom)}, so it cannot take ${use} from ${isoDay(day)}.`,
    );
  }
  if (retiredOn(line, day)) {
    throw ApiError.conflict(
      `Business line ${line.code} retired on ${isoDay(line.effectiveTo!)} and takes no new ${use} from that day.`,
    );
  }
}

async function loadLine(id: string): Promise<BusinessLine> {
  const row = await prisma.businessLine.findFirst({ where: { id } });
  if (!row) throw ApiError.notFound('Business line');
  return row;
}

/**
 * Registry rows name the person who recorded them. An agent principal has no
 * party id, so an agent cannot make a registry change: the row would have no
 * accountable author.
 */
function recorderOf(partyId: string | null): string {
  if (!partyId) throw ApiError.forbidden('A registry change is recorded against a person, not an agent.');
  return partyId;
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** What one distribution write produced: the new header, its shares, and the rows it closed. */
interface WrittenDistribution {
  header: LineDistribution;
  shares: LineDistributionLine[];
  superseded: { before: LineDistribution; after: LineDistribution }[];
}

/**
 * Another writer reached the same subject, line or day first, and the
 * database settled it rather than the read above. That is a loss for this
 * caller, not a fault, so it answers 409 and the caller re-reads and retries.
 * Covered: the exclusion constraint (23P01), a serialization failure (40001),
 * a deadlock (40P01), Prisma's transaction write conflict (P2034), and the
 * deferred share total (raised by line_distributions_check_total when the
 * shares of a header are changed by a racing transaction).
 */
const RACE_CODES = new Set(['23P01', '40001', '40P01', 'P2034']);
const RACE_MESSAGE =
  /exclusion constraint|could not serialize|deadlock detected|must total 10000 basis points|basis points must total/;

export function isRaceLoss(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  if (typeof e.code === 'string' && RACE_CODES.has(e.code)) return true;
  if (typeof e.meta?.code === 'string' && RACE_CODES.has(e.meta.code)) return true;
  return typeof e.message === 'string' && RACE_MESSAGE.test(e.message);
}

export const RACE_MESSAGE_TEXT =
  'Another change to this subject, line or day landed first. Read the current state and try again.';

/** A split states its shares on every successor or on none, and the stated ones total 10,000. */
function checkSuccessorShares(shares: (number | null)[]): void {
  const stated = shares.filter((s): s is number => s !== null);
  if (stated.length !== 0 && stated.length !== shares.length) {
    throw ApiError.badRequest('A split states its basis points on every successor or on none.');
  }
  for (const s of stated) {
    if (!Number.isInteger(s) || s < 1 || s > WHOLE) throw ApiError.badRequest('A share is 1 to 10000 basis points.');
  }
  if (stated.length > 0) {
    const total = stated.reduce((a, b) => a + b, 0);
    if (total !== WHOLE) throw ApiError.badRequest(`A split of basis points must total 10,000, got ${total}.`);
  }
}

function checkDistributionShares(shares: { lineId: string; basisPoints: number }[]): void {
  if (shares.length === 0) throw ApiError.badRequest('A distribution names at least one line.');
  if (new Set(shares.map((s) => s.lineId)).size !== shares.length) {
    throw ApiError.badRequest('A line appears once in a distribution.');
  }
  for (const s of shares) {
    if (!Number.isInteger(s.basisPoints) || s.basisPoints < 1 || s.basisPoints > WHOLE) {
      throw ApiError.badRequest('A share is 1 to 10000 basis points.');
    }
  }
  const total = shares.reduce((a, s) => a + s.basisPoints, 0);
  if (total !== WHOLE) throw ApiError.badRequest(`A distribution of basis points must total 10,000, got ${total}.`);
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export interface CreateBusinessLineInput {
  code: string;
  name: string;
  payerKind: string;
  revenueModel: string;
  /** IST day the line starts. Defaults to today's IST day. */
  effectiveFrom?: string;
  reason: string;
}

export async function createBusinessLine(input: CreateBusinessLineInput): Promise<BusinessLine> {
  await assertCan({ resource: 'org_design', verb: 'create' });
  const auth = currentAuth();
  if (!CODE_PATTERN.test(input.code)) {
    throw ApiError.badRequest('A business-line code is 2 to 12 uppercase letters or digits, starting with a letter.');
  }
  const name = textOf(input.name, 'name', 120);
  const payerKind = textOf(input.payerKind, 'payerKind', 64);
  const revenueModel = textOf(input.revenueModel, 'revenueModel', 64);
  const reason = reasonOf(input.reason);
  const effectiveFrom = input.effectiveFrom ? istDay(input.effectiveFrom) : todayIst();

  // The code is the key forever, so a retired line's code is refused too.
  const taken = await prisma.businessLine.findFirst({ where: { code: input.code } });
  if (taken) throw ApiError.conflict(`Business-line code ${input.code} is already used, retired lines included.`);

  let row: BusinessLine;
  try {
    row = await prisma.businessLine.create({
      data: { tenantId: auth.tenantId, code: input.code, name, payerKind, revenueModel, effectiveFrom },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw ApiError.conflict(`Business-line code ${input.code} is already used.`);
    throw err;
  }
  await auditWrite({
    action: 'create',
    subjectType: 'business_line',
    subjectId: row.id,
    after: row as never,
    meta: { reason },
  });
  await emit({
    name: EVENTS.BUSINESS_LINE_CREATED,
    subject: { entityType: 'business_line', entityId: row.id },
    newState: { code: row.code, name, payerKind, revenueModel, effectiveFrom: isoDay(effectiveFrom) },
    reason: { note: reason },
    impact: { domains: ['org'] },
  });
  return row;
}

/** Changes the name only. The code and id are immutable (database trigger); a rename changes history's label, not its key. */
export async function renameBusinessLine(input: { id: string; name: string; reason: string }): Promise<BusinessLine> {
  await assertCan({ resource: 'org_design', verb: 'edit' });
  const before = await loadLine(input.id);
  const name = textOf(input.name, 'name', 120);
  const reason = reasonOf(input.reason);
  if (retiredOn(before, todayIst())) {
    throw ApiError.conflict(`Business line ${before.code} is retired and takes no further changes.`);
  }
  const after = await prisma.businessLine.update({ where: { id: before.id }, data: { name } });
  await auditWrite({
    action: 'update',
    subjectType: 'business_line',
    subjectId: before.id,
    before: before as never,
    after: after as never,
    meta: { reason },
  });
  await emit({
    name: EVENTS.BUSINESS_LINE_RENAMED,
    subject: { entityType: 'business_line', entityId: before.id },
    previousState: { name: before.name },
    newState: { name },
    reason: { note: reason },
    impact: { domains: ['org'] },
  });
  return after;
}

/**
 * Closes a line from an IST day. The day must be after the line starts and not
 * before today: a retirement is a dated future change, never a backdated edit.
 */
export async function retireBusinessLine(input: {
  id: string;
  effectiveTo: string;
  reason: string;
}): Promise<BusinessLine> {
  await assertCan({ resource: 'org_design', verb: 'edit' });
  const before = await loadLine(input.id);
  const reason = reasonOf(input.reason);
  if (before.effectiveTo !== null) {
    throw ApiError.conflict(`Business line ${before.code} is already retired from ${isoDay(before.effectiveTo)}.`);
  }
  const effectiveTo = istDay(input.effectiveTo);
  if (effectiveTo <= before.effectiveFrom) throw ApiError.badRequest('A line retires on a day after it starts.');
  if (effectiveTo < todayIst()) {
    throw ApiError.badRequest('A retirement cannot be backdated: choose today or a later IST day.');
  }
  const after = await prisma.businessLine.update({ where: { id: before.id }, data: { effectiveTo } });
  await auditWrite({
    action: 'update',
    subjectType: 'business_line',
    subjectId: before.id,
    before: before as never,
    after: after as never,
    meta: { reason },
  });
  await emit({
    name: EVENTS.BUSINESS_LINE_RETIRED,
    subject: { entityType: 'business_line', entityId: before.id },
    previousState: { effectiveTo: null },
    newState: { effectiveTo: isoDay(effectiveTo) },
    reason: { note: reason },
    impact: { domains: ['org'] },
  });
  return after;
}

// ---------------------------------------------------------------------------
// Successors
// ---------------------------------------------------------------------------

export interface SuccessorInput {
  toLineId: string;
  shareBasisPoints: number | null;
}

export interface RecordSuccessionInput {
  /** The line handed on. It may be retired on the successor day itself (a split). */
  fromLineId: string;
  effectiveFrom: string;
  successors: SuccessorInput[];
  reason: string;
}

/**
 * One split or merge leg: `fromLineId` hands `effectiveFrom` onward to each
 * successor. Each row is audited and emitted on its own.
 */
export async function recordSuccession(input: RecordSuccessionInput) {
  await assertCan({ resource: 'org_design', verb: 'create' });
  const auth = currentAuth();
  const reason = reasonOf(input.reason);
  const day = istDay(input.effectiveFrom);
  if (input.successors.length === 0) throw ApiError.badRequest('A succession names at least one successor line.');
  const toIds = input.successors.map((s) => s.toLineId);
  if (new Set(toIds).size !== toIds.length) throw ApiError.badRequest('A successor line appears once per split.');
  if (toIds.includes(input.fromLineId)) throw ApiError.badRequest('A line cannot succeed itself.');
  checkSuccessorShares(input.successors.map((s) => s.shareBasisPoints));

  const from = await loadLine(input.fromLineId);
  // The source may be retired on this very day: that is what a split does.
  if (from.effectiveFrom > day || (from.effectiveTo !== null && from.effectiveTo < day)) {
    throw ApiError.conflict(`Business line ${from.code} is not in force on ${isoDay(day)}, so it cannot be handed on.`);
  }
  const targets = await prisma.businessLine.findMany({ where: { id: { in: toIds } } });
  if (targets.length !== toIds.length) throw ApiError.notFound('Successor business line');
  for (const t of targets) assertOpenOn(t, day, 'a successor');

  let rows: Awaited<ReturnType<typeof createSuccessorRows>>;
  try {
    rows = await createSuccessorRows(auth.tenantId, recorderOf(auth.partyId), from.id, day, input.successors);
  } catch (err) {
    if (isUniqueViolation(err)) throw ApiError.conflict('This succession is already recorded for that day.');
    if (isRaceLoss(err)) throw ApiError.conflict(RACE_MESSAGE_TEXT);
    throw err;
  }
  for (const row of rows) {
    await auditWrite({
      action: 'create',
      subjectType: 'business_line_successor',
      subjectId: row.id,
      after: row as never,
      meta: { reason },
    });
    await emit({
      name: EVENTS.BUSINESS_LINE_SUCCESSOR_RECORDED,
      subject: { entityType: 'business_line_successor', entityId: row.id },
      newState: {
        fromLineId: row.fromLineId,
        toLineId: row.toLineId,
        effectiveFrom: isoDay(day),
        shareBasisPoints: row.shareBasisPoints,
      },
      reason: { note: reason },
      impact: { domains: ['org'] },
    });
  }
  return rows;
}

/** The rows of one split commit together, so the deferred share check sees all of them. */
async function createSuccessorRows(
  tenantId: string,
  recordedById: string,
  fromLineId: string,
  effectiveFrom: Date,
  successors: SuccessorInput[],
): Promise<BusinessLineSuccessor[]> {
  return prisma.$transaction(async (tx) => {
    const out: BusinessLineSuccessor[] = [];
    for (const s of successors) {
      out.push(
        await tx.businessLineSuccessor.create({
          data: {
            tenantId,
            fromLineId,
            toLineId: s.toLineId,
            effectiveFrom,
            shareBasisPoints: s.shareBasisPoints,
            recordedById,
          },
        }),
      );
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

export interface DistributionSubject {
  costCentreId?: string;
  ledgerCategoryId?: string;
  transactionId?: string;
}

export interface DistributionShare {
  lineId: string;
  basisPoints: number;
}

export interface SetLineDistributionInput {
  subject: DistributionSubject;
  effectiveFrom: string;
  shares: DistributionShare[];
  reason: string;
}

type SubjectRef =
  | { kind: 'cost_centre'; id: string; where: { costCentreId: string } }
  | { kind: 'ledger_category'; id: string; where: { ledgerCategoryId: string } }
  | { kind: 'transaction'; id: string; where: { transactionId: string } };

function subjectOf(s: DistributionSubject): SubjectRef {
  const given = [s.costCentreId, s.ledgerCategoryId, s.transactionId].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  if (given.length !== 1) {
    throw ApiError.badRequest(
      'A distribution names exactly one subject: a cost centre, a ledger category or a transaction.',
    );
  }
  if (s.costCentreId) return { kind: 'cost_centre', id: s.costCentreId, where: { costCentreId: s.costCentreId } };
  if (s.ledgerCategoryId) {
    return { kind: 'ledger_category', id: s.ledgerCategoryId, where: { ledgerCategoryId: s.ledgerCategoryId } };
  }
  return { kind: 'transaction', id: s.transactionId!, where: { transactionId: s.transactionId! } };
}

async function assertSubjectExists(subject: SubjectRef): Promise<void> {
  const found =
    subject.kind === 'cost_centre'
      ? await prisma.costCentre.findFirst({ where: { id: subject.id } })
      : subject.kind === 'ledger_category'
        ? await prisma.ledgerCategory.findFirst({ where: { id: subject.id } })
        : await prisma.transaction.findFirst({ where: { id: subject.id } });
  if (!found) throw ApiError.notFound(subject.kind.replace('_', ' '));
}

/**
 * Sets how a subject is split from a day. A distribution in force on that day
 * is closed the day before ("superseded"), never edited, so postings made under
 * it keep their split. The new header and its shares commit together, so the
 * database's total check sees all the shares at once.
 */
export async function setLineDistribution(input: SetLineDistributionInput) {
  await assertCan({ resource: 'org_design', verb: 'edit' });
  const auth = currentAuth();
  const reason = reasonOf(input.reason);
  const subject = subjectOf(input.subject);
  const day = istDay(input.effectiveFrom);
  checkDistributionShares(input.shares);
  await assertSubjectExists(subject);

  const lines = await prisma.businessLine.findMany({ where: { id: { in: input.shares.map((s) => s.lineId) } } });
  if (lines.length !== input.shares.length) throw ApiError.notFound('Business line');
  for (const l of lines) assertOpenOn(l, day, 'a distribution');

  let result: Awaited<ReturnType<typeof writeDistribution>>;
  try {
    result = await writeDistribution(auth.tenantId, recorderOf(auth.partyId), subject, day, input.shares);
  } catch (err) {
    if (isUniqueViolation(err)) throw ApiError.conflict('This distribution is already recorded for that day.');
    if (isRaceLoss(err)) throw ApiError.conflict(RACE_MESSAGE_TEXT);
    throw err;
  }
  const { header, shares, superseded } = result;

  await auditWrite({
    action: 'create',
    subjectType: 'line_distribution',
    subjectId: header.id,
    after: { ...header, shares: shares.map((s) => ({ lineId: s.lineId, basisPoints: s.basisPoints })) } as never,
    meta: { reason },
  });
  await emit({
    name: EVENTS.LINE_DISTRIBUTION_RECORDED,
    subject: { entityType: 'line_distribution', entityId: header.id },
    newState: {
      subjectKind: subject.kind,
      subjectId: subject.id,
      effectiveFrom: isoDay(day),
      shares: shares.map((s) => ({ lineId: s.lineId, basisPoints: s.basisPoints })),
    },
    reason: { note: reason },
    impact: { domains: ['org'] },
  });
  for (const old of superseded) {
    await auditWrite({
      action: 'update',
      subjectType: 'line_distribution',
      subjectId: old.before.id,
      before: old.before as never,
      after: old.after as never,
      meta: { reason },
    });
    await emit({
      name: EVENTS.LINE_DISTRIBUTION_SUPERSEDED,
      subject: { entityType: 'line_distribution', entityId: old.before.id },
      previousState: { effectiveTo: null },
      newState: { effectiveTo: isoDay(day), supersededBy: header.id },
      reason: { note: reason },
      impact: { domains: ['org'] },
    });
  }
  return { header, shares, superseded: superseded.map((s) => s.after) };
}

async function writeDistribution(
  tenantId: string,
  recordedById: string,
  subject: SubjectRef,
  day: Date,
  shares: DistributionShare[],
): Promise<WrittenDistribution> {
  return prisma.$transaction(async (tx) => {
    const superseded: { before: LineDistribution; after: LineDistribution }[] = [];
    const current = await tx.lineDistribution.findMany({
      where: { tenantId, ...subject.where, OR: [{ effectiveTo: null }, { effectiveTo: { gt: day } }] },
    });
    for (const prior of current) {
      if (prior.effectiveFrom >= day) {
        throw ApiError.conflict(
          `A distribution for this subject already starts on ${isoDay(prior.effectiveFrom)}; a new one cannot start on or before it.`,
        );
      }
      const after = await tx.lineDistribution.update({ where: { id: prior.id }, data: { effectiveTo: day } });
      superseded.push({ before: prior, after });
    }
    const data: Prisma.LineDistributionUncheckedCreateInput = {
      tenantId,
      ...subject.where,
      effectiveFrom: day,
      recordedById,
    };
    const header = await tx.lineDistribution.create({ data });
    const created: LineDistributionLine[] = [];
    for (const s of shares) {
      created.push(
        await tx.lineDistributionLine.create({
          data: { tenantId, distributionId: header.id, lineId: s.lineId, basisPoints: s.basisPoints },
        }),
      );
    }
    return { header, shares: created, superseded };
  });
}
