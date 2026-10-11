/**
 * The founder exception view (OP:120; SPINE-CONTRACT 1.6).
 *
 * Reads only. It writes no row, emits no event and records no audit entry,
 * because a list of what needs a person is not a change to anything.
 *
 * Each source is checked in the same order, and the order is the point:
 *   1. the caller's view on the source's resource. A refusal is `withheld`, and
 *      the table is not touched, so a caller learns nothing about what exists;
 *   2. the table is present in this database. A missing table is `not_measured`
 *      and is never counted as zero;
 *   3. the count and the first rows, in the caller's tenant and visibility.
 *      A read that fails is `not_measured` too: a source that could not be read
 *      has not been measured, whatever the database happens to hold.
 *
 * The state lists are the ones the owning domains already act on, imported
 * rather than copied, so this view and the queue that acts on the same rows
 * cannot disagree about what is open.
 */

import { Prisma } from '@prisma/client';
import type {
  FounderRow,
  FounderSourceKind,
  FounderSourceStatus,
  FounderViewResponse,
  Resource,
} from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { can, visibilityWhere } from '../platform/permissions.js';
import { OPEN_STATES } from '../platform/exceptions.js';
import { OPEN_DECISION_STATES } from './decisions.js';
import { tiersClearedBy } from './cases.js';

/** Rows shown per source. The count is always the whole number, never this cap. */
const ROW_CAP = 50;

/** A row as a source reads it. The owner's name is added once, for all sources together. */
type SourceRow = Omit<FounderRow, 'ownerName'>;

interface SourceLoad {
  count: number;
  rows: SourceRow[];
}

export interface FounderSource {
  kind: FounderSourceKind;
  /** The resource whose `view` the caller must hold before this source is read. */
  gate: Resource;
  /** The physical table, checked for existence before the source is read. */
  table: string;
  load(now: Date): Promise<SourceLoad>;
}

/**
 * Exceptions still open. A raised exception is open until it is resolved; the
 * natural-key guard in platform/exceptions.ts counts the same three states.
 */
const exceptionSource: FounderSource = {
  kind: 'exception',
  gate: 'exceptions',
  table: 'exception_records',
  async load() {
    const auth = currentAuth();
    const where: Prisma.ExceptionRecordWhereInput = {
      AND: [
        { tenantId: auth.tenantId },
        { state: { in: [...OPEN_STATES] } },
        (await visibilityWhere('exceptions', 'ownerPartyId')) as Prisma.ExceptionRecordWhereInput,
      ],
    };
    const [count, rows] = await Promise.all([
      prisma.exceptionRecord.count({ where }),
      prisma.exceptionRecord.findMany({ where, orderBy: [{ raisedAt: 'asc' }], take: ROW_CAP }),
    ]);
    return {
      count,
      rows: rows.map((r): SourceRow => ({
        sourceKind: 'exception',
        sourceId: r.id,
        recordCode: r.recordCode,
        title: r.label,
        state: r.state,
        ownerPartyId: r.ownerPartyId,
        timestamp: r.raisedAt.toISOString(),
        timestampKind: 'raised_at',
        escalationRung: r.escalationRung,
        drillTo: `/exceptions/${r.id}`,
      })),
    };
  },
};

/**
 * A commitment is overdue when it was confirmed and its due instant has passed,
 * whether or not the scheduled job has yet marked it missed. A proposal is not a
 * promise anyone has accepted, so it is never on this view.
 */
const commitmentSource: FounderSource = {
  kind: 'commitment',
  gate: 'commitments',
  table: 'commitments',
  async load(now) {
    const auth = currentAuth();
    const where: Prisma.CommitmentWhereInput = {
      AND: [
        { tenantId: auth.tenantId },
        (await visibilityWhere('commitments', 'ownerPartyId')) as Prisma.CommitmentWhereInput,
        { OR: [{ state: 'missed' }, { state: 'confirmed', dueAt: { lt: now } }] },
      ],
    };
    const [count, rows] = await Promise.all([
      prisma.commitment.count({ where }),
      prisma.commitment.findMany({ where, orderBy: [{ dueAt: 'asc' }], take: ROW_CAP }),
    ]);
    return {
      count,
      rows: rows.map((c): SourceRow => ({
        sourceKind: 'commitment',
        sourceId: c.id,
        recordCode: c.recordCode,
        title: c.title,
        state: c.state,
        ownerPartyId: c.ownerPartyId,
        timestamp: c.dueAt.toISOString(),
        timestampKind: 'due_at',
        escalationRung: null,
        // No commitments screen exists on main yet (apps/web/src/main.tsx has no
        // such route), so the row lands on system history, which does not filter by it.
        drillTo: '/admin/events',
      })),
    };
  },
};

/** A decision awaiting a disposition: the states the decision queue acts on. */
const decisionSource: FounderSource = {
  kind: 'decision',
  gate: 'decisions',
  table: 'decisions',
  async load() {
    const auth = currentAuth();
    const where: Prisma.DecisionWhereInput = {
      AND: [
        { tenantId: auth.tenantId },
        (await visibilityWhere('decisions', 'routedToPartyId')) as Prisma.DecisionWhereInput,
        { state: { in: [...OPEN_DECISION_STATES] } },
      ],
    };
    const [count, rows] = await Promise.all([
      prisma.decision.count({ where }),
      prisma.decision.findMany({ where, orderBy: [{ raisedAt: 'asc' }], take: ROW_CAP }),
    ]);
    return {
      count,
      rows: rows.map((d): SourceRow => ({
        sourceKind: 'decision',
        sourceId: d.id,
        recordCode: d.recordCode,
        title: d.question,
        state: d.state,
        ownerPartyId: d.routedToPartyId,
        timestamp: d.raisedAt.toISOString(),
        timestampKind: 'raised_at',
        escalationRung: null,
        drillTo: '/command/decisions',
      })),
    };
  },
};

/**
 * A pending approval step: open, or escalated to the next rung and still open.
 * The step's own permission resource is checked per row when it is decided
 * (platform/approvals.ts), not here, so this source is gated on founder_view
 * alone. Rows the caller could not decide appear here; the drill target refuses them.
 */
const approvalSource: FounderSource = {
  kind: 'approval_step',
  gate: 'founder_view',
  table: 'approval_steps',
  async load() {
    const auth = currentAuth();
    const where: Prisma.ApprovalStepWhereInput = {
      tenantId: auth.tenantId,
      state: { in: ['open', 'escalated'] },
    };
    const [count, rows] = await Promise.all([
      prisma.approvalStep.count({ where }),
      prisma.approvalStep.findMany({ where, orderBy: [{ requestedAt: 'asc' }], take: ROW_CAP }),
    ]);
    return {
      count,
      rows: rows.map((s): SourceRow => ({
        sourceKind: 'approval_step',
        sourceId: s.id,
        recordCode: null,
        title: `${s.action} · ${s.subjectLabel ?? s.subjectId}`,
        state: s.state,
        ownerPartyId: s.resolvedApproverId,
        timestamp: s.requestedAt.toISOString(),
        timestampKind: 'requested_at',
        escalationRung: s.escalationRung,
        drillTo: `/approvals/${s.id}`,
      })),
    };
  },
};

/**
 * An open case past its response due instant, or one the overdue job has
 * flagged. Only a case still `open` is overdue: an acknowledged case has been
 * answered, and the WHAT axis hides every tier above the caller's ceiling.
 */
const caseSource: FounderSource = {
  kind: 'case',
  gate: 'cases',
  table: 'cases',
  async load(now) {
    const auth = currentAuth();
    const where: Prisma.CaseWhereInput = {
      AND: [
        { tenantId: auth.tenantId },
        (await visibilityWhere('cases', 'ownerPartyId')) as Prisma.CaseWhereInput,
        { visibilityTier: { in: tiersClearedBy(auth.classificationCeiling) } },
        { state: 'open' },
        { OR: [{ responseDueAt: { lt: now } }, { overdueFlaggedAt: { not: null } }] },
      ],
    };
    const [count, rows] = await Promise.all([
      prisma.case.count({ where }),
      prisma.case.findMany({ where, orderBy: [{ responseDueAt: 'asc' }], take: ROW_CAP }),
    ]);
    return {
      count,
      rows: rows.map((k): SourceRow => ({
        sourceKind: 'case',
        sourceId: k.id,
        recordCode: k.recordCode,
        title: k.title,
        state: k.state,
        ownerPartyId: k.ownerPartyId,
        timestamp: k.responseDueAt.toISOString(),
        timestampKind: 'response_due_at',
        escalationRung: null,
        drillTo: '/admin/events',
      })),
    };
  },
};

export const FOUNDER_SOURCES: readonly FounderSource[] = [
  exceptionSource,
  commitmentSource,
  decisionSource,
  approvalSource,
  caseSource,
];

async function tableExists(table: string): Promise<boolean> {
  // to_regclass answers null for an absent table rather than raising, so the
  // missing-table case is a value the view can report, not an error it must catch.
  const rows = await prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass(${table}) IS NOT NULL AS present`;
  return rows[0]?.present === true;
}

async function ownerNamesFor(ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const people = await prisma.person.findMany({
    where: { tenantId: currentAuth().tenantId, id: { in: unique } },
    select: { id: true, fullName: true },
  });
  return new Map(people.map((p) => [p.id, p.fullName]));
}

async function readSource(source: FounderSource, now: Date, into: SourceRow[]): Promise<FounderSourceStatus> {
  if (!(await can({ resource: source.gate, verb: 'view' }))) {
    return { status: 'withheld', reason: `Your role does not hold view on ${source.gate}.` };
  }
  if (!(await tableExists(source.table))) {
    return { status: 'not_measured', reason: `The ${source.table} table is not in this database.` };
  }
  try {
    const loaded = await source.load(now);
    into.push(...loaded.rows);
    return { status: 'measured', count: loaded.count, shown: loaded.rows.length };
  } catch {
    return { status: 'not_measured', reason: `The ${source.table} table could not be read in this session.` };
  }
}

/**
 * The view for the caller's tenant. `sources` is the production list by default;
 * a test passes an altered copy to exercise the missing-table path against the
 * real database.
 */
export async function founderView(sources: readonly FounderSource[] = FOUNDER_SOURCES): Promise<FounderViewResponse> {
  const now = new Date();
  const statuses = {} as Record<FounderSourceKind, FounderSourceStatus>;
  const found: SourceRow[] = [];
  for (const source of sources) {
    statuses[source.kind] = await readSource(source, now, found);
  }
  const names = await ownerNamesFor(found.map((r) => r.ownerPartyId));
  // ISO instants in UTC sort correctly as strings, so the merged list reads oldest first.
  const rows: FounderRow[] = found
    .map((r) => ({ ...r, ownerName: r.ownerPartyId ? (names.get(r.ownerPartyId) ?? null) : null }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { asOf: now.toISOString(), scope: 'tenant', sources: statuses, rows };
}
