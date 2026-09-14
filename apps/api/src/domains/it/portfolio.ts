/**
 * Technology — portfolio and budget (docs/plan/cio.md, workstream G).
 *
 * An `ItInitiative` runs through `idea -> assessed -> approved -> in_flight
 * -> delivered -> benefits_realised` (or `cancelled` short of delivery).
 * Approving out of `assessed` runs `POL-IT-INITIATIVE-APPROVAL` on the
 * Self-Dealing Bar, keyed on `sponsorPartyId` — the accountable requester —
 * exactly the shape `transitionAgreement` in `domains/agreements.ts` runs
 * for MoUs and contracts. Spend to date and a budget line's actual are never
 * stored: both are summed over the books at read time.
 *
 * `platform/lifecycle.ts`'s `transition()` now takes an `eventPrefix`/
 * `impactDomain`, so it could carry `kz.it.*` events too — but `APPROVE`
 * needs the gate branch (`evaluateApprovalGate`, returning `{ applied:
 * false, ... }` on an unpermitted step rather than throwing) that
 * `transition()` does not run, so every other transition would still need
 * its own path anyway. This file keeps one local implementation for both:
 * the state-machine mechanics (`can`/`apply`, `availableTransitions`) come
 * from the machines in `@kaizen/shared`; assert/audit/emit run here under
 * the correct `IT_*` event names.
 */

import {
  EVENTS,
  IT_DOMAIN,
  IT_THEMES,
  IT_RAG_STATUSES,
  IT_BUDGET_CATEGORIES,
  IT_BUDGET_KINDS,
  IT_TECH_DEBT_SEVERITIES,
  itInitiativeMachine,
  itTechDebtMachine,
  IT_INITIATIVE_VERBS,
  IT_TECH_DEBT_VERBS,
  fyWindow,
  fyElapsedFraction,
  fyFor,
  parseFy,
  ragRollup,
  type ItInitiativeStage,
  type ItInitiativeEvent,
  type ItTechDebtStatus,
  type ItTechDebtEvent,
  type ItTheme,
  type ItPortfolioSummary,
  type ItBudgetSummary,
  type ItBudgetCategoryLine,
  type ItBudgetDivisionLine,
  type ItTechDebtSummary,
} from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, canSeeMoney } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { evaluateApprovalGate } from '../../platform/approvals.js';
import { availableTransitions } from '../../platform/lifecycle.js';

registerGovernedEntities('it_portfolio', [
  'it_initiative',
  'it_initiative_update',
  'it_roadmap_item',
  'it_budget_line',
  'it_tech_debt_item',
]);

// ---------------------------------------------------------------------------
// Money masking: the Operations Head holds `it_budgets:VCE` — create, edit,
// view — but not `F` (financial); the Finance Head and chairman hold both.
// None of this workstream's own field names (`planned`, `actual`,
// `variance`, `plannedTotal`, `actualTotal`, `spendToDate`) are in the
// platform's shared `MONEY_FIELDS` list, so `applyFieldVisibility` would not
// mask them on its own — this is a manual masker keyed to those names,
// mirroring `maskContractMoney` in `domains/it/vendors.ts`, deep-walked
// because a budget summary nests money inside `byCategory`/`byDivision`.
// ---------------------------------------------------------------------------

const BUDGET_MONEY_FIELDS = ['planned', 'actual', 'variance', 'plannedTotal', 'actualTotal', 'spendToDate'] as const;

function walkMaskBudget(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walkMaskBudget);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = (BUDGET_MONEY_FIELDS as readonly string[]).includes(key) ? null : walkMaskBudget(v);
  }
  return out;
}

/** Present-but-withheld, never a silently zeroed figure: nulls
 * `BUDGET_MONEY_FIELDS` wherever they occur, however deep. A no-op when the
 * viewer holds `it_budgets:F`. */
function maskBudgetMoney<T>(value: T, seesMoney: boolean): T {
  return seesMoney ? value : (walkMaskBudget(value) as T);
}

// ---------------------------------------------------------------------------
// Dated settings (Principle 4): stale-initiative days, budget-burn margin.
// ---------------------------------------------------------------------------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const auth = currentAuth();
  const row = await prisma.itPortfolioSetting.findFirst({
    where: { tenantId: auth.tenantId, key, effectiveFrom: { lte: new Date() } },
    orderBy: { effectiveFrom: 'desc' },
  });
  return row ? (row.value as T) : fallback;
}

// ---------------------------------------------------------------------------
// Initiatives
// ---------------------------------------------------------------------------

export interface CreateInitiativeInput {
  title: string;
  theme: ItTheme;
  sponsorPartyId: string;
  ownerPartyId: string;
  businessCase?: string | null;
  expectedBenefit?: string | null;
  budget: number;
  currency?: string;
  targetQuarter?: string | null;
  projectId?: string | null;
}

function assertTheme(theme: string): asserts theme is ItTheme {
  if (!(IT_THEMES as readonly string[]).includes(theme)) {
    throw ApiError.badRequest(`'${theme}' is not a theme. Choose one of: ${IT_THEMES.join(', ')}.`);
  }
}

export async function createInitiative(input: CreateInitiativeInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_initiatives', verb: 'create' });
  assertTheme(input.theme);

  if (!input.title.trim()) throw ApiError.badRequest('An initiative needs a title.');
  if (!(input.budget >= 0)) throw ApiError.badRequest('Budget cannot be negative.');
  if (!input.sponsorPartyId) throw ApiError.badRequest('An initiative needs a sponsor — the person accountable for its funding.');
  if (!input.ownerPartyId) throw ApiError.badRequest('An initiative needs an owner — the person accountable for delivering it.');

  const recordCode = await nextRecordCode('ITI');
  const initiative = await prisma.itInitiative.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title.trim(),
      theme: input.theme,
      sponsorPartyId: input.sponsorPartyId,
      ownerPartyId: input.ownerPartyId,
      businessCase: input.businessCase ?? null,
      expectedBenefit: input.expectedBenefit ?? null,
      budget: input.budget,
      currency: input.currency ?? 'INR',
      stage: 'idea',
      rag: 'green',
      ragReason: 'Newly proposed.',
      ragSetAt: new Date(),
      targetQuarter: input.targetQuarter ?? null,
      projectId: input.projectId ?? null,
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_initiative', subjectId: initiative.id, after: { recordCode, title: initiative.title } });
  await emit({
    name: EVENTS.IT_INITIATIVE_CREATED,
    subject: { entityType: 'it_initiative', entityId: initiative.id, recordCode },
    newState: { stage: 'idea', theme: initiative.theme, budget: input.budget },
    owner: { partyId: initiative.ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return initiative;
}

export interface InitiativeFilter {
  stage?: string;
  theme?: string;
  rag?: string;
}

export async function listInitiatives(filter: InitiativeFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_initiatives', verb: 'view' });
  return prisma.itInitiative.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.stage ? { stage: filter.stage } : {}),
      ...(filter.theme ? { theme: filter.theme } : {}),
      ...(filter.rag ? { rag: filter.rag } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

/** Spend to date: a sum over the `VendorBill` rows the initiative names —
 * never over licences, which may not exist at typecheck time (see the
 * schema's doc comment and docs/it/portfolio.md). Scoped to the current
 * tenant, live rows only, and only bills that are actually spend (a
 * `draft` bill is not yet a commitment and a `cancelled` one never was). */
export async function computeInitiativeSpend(initiative: { vendorBillIds: string[] }): Promise<number> {
  if (initiative.vendorBillIds.length === 0) return 0;
  const auth = currentAuth();
  const bills = await prisma.vendorBill.findMany({
    where: {
      tenantId: auth.tenantId,
      id: { in: initiative.vendorBillIds },
      deletedAt: null,
      status: { in: ['open', 'part_paid', 'paid'] },
    },
  });
  return bills.reduce((sum, b) => sum + (num(b.total) ?? 0), 0);
}

export async function initiativeDetail(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_initiatives', verb: 'view' });
  const initiative = await prisma.itInitiative.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { updates: { orderBy: { at: 'desc' } } },
  });
  if (!initiative) throw ApiError.notFound('Initiative');

  const spendToDate = await computeInitiativeSpend(initiative);
  // Spend is budget money: gated on `it_budgets:F`, the same verb a budget
  // line's actual is gated on, not on `it_initiatives` (which has no F verb
  // for anyone but the chairman) — seeing what an initiative has spent is
  // the same "financial visibility" as seeing what a budget line has spent.
  const seesMoney = await canSeeMoney('it_budgets');
  return {
    ...initiative,
    spendToDate: seesMoney ? spendToDate : null,
    availableTransitions: availableTransitions(itInitiativeMachine, initiative.stage as ItInitiativeStage),
  };
}

export interface InitiativeTransitionResult {
  applied: boolean;
  initiative: unknown;
  approvalStepId: string | null;
  reason: string | null;
}

/**
 * Runs a stage transition. `APPROVE` (assessed -> approved) is privileged:
 * it goes through `evaluateApprovalGate('POL-IT-INITIATIVE-APPROVAL', ...)`
 * keyed on `sponsorPartyId`, mirroring `transitionAgreement` — a non-permitted
 * gate opens an approval step and returns `{ applied: false, ... }` rather
 * than throwing. Every other transition is a plain governed edit.
 */
export async function transitionInitiative(id: string, event: ItInitiativeEvent, note = ''): Promise<InitiativeTransitionResult> {
  const auth = currentAuth();
  const initiative = await prisma.itInitiative.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!initiative) throw ApiError.notFound('Initiative');

  const from = initiative.stage as ItInitiativeStage;
  if (!itInitiativeMachine.can(from, event)) {
    throw ApiError.unprocessable(
      `An initiative in '${from}' does not accept ${event}. From here it accepts: ${
        itInitiativeMachine.allowedEvents(from).join(', ') || 'nothing — this is final'
      }.`,
    );
  }
  const to = itInitiativeMachine.apply(from, event);

  if (event === 'APPROVE') {
    const gate = await evaluateApprovalGate(
      'POL-IT-INITIATIVE-APPROVAL',
      {
        id,
        type: 'it_initiative',
        label: `${initiative.recordCode} — ${initiative.title}`,
        ownerPartyId: initiative.sponsorPartyId,
        commercialValue: num(initiative.budget),
        currency: initiative.currency,
        strategicValue: null,
        termMonths: null,
      },
      'it_initiative.approve',
    );
    if (!gate.permitted) {
      return { applied: false, initiative, approvalStepId: gate.approvalStepId, reason: gate.reason };
    }
  } else {
    await assertCan({ resource: 'it_initiatives', verb: 'edit', record: { ownerPartyId: initiative.ownerPartyId } });
  }

  const updated = await prisma.itInitiative.update({ where: { id }, data: { stage: to } });

  await auditWrite({
    action: 'update',
    subjectType: 'it_initiative',
    subjectId: id,
    before: { stage: from },
    after: { stage: to },
    meta: { transition: event, note },
  });
  await emit({
    name: EVENTS.IT_INITIATIVE_TRANSITIONED,
    subject: { entityType: 'it_initiative', entityId: id, recordCode: initiative.recordCode },
    previousState: { stage: from },
    newState: { stage: to },
    reason: note ? { reasonCode: event, note } : { reasonCode: event },
    owner: { partyId: initiative.ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return { applied: true, initiative: updated, approvalStepId: null, reason: null };
}

export interface PostUpdateInput {
  body: string;
  rag: string;
}

/** Append-only status report. Also refreshes the initiative's own live RAG
 * band and clears `staleNotifiedAt`, so a quiet initiative that speaks up
 * again is eligible for the stale ladder a second time. */
export async function postInitiativeUpdate(initiativeId: string, input: PostUpdateInput) {
  const auth = currentAuth();
  const initiative = await prisma.itInitiative.findFirst({ where: { id: initiativeId, tenantId: auth.tenantId } });
  if (!initiative) throw ApiError.notFound('Initiative');
  await assertCan({ resource: 'it_initiatives', verb: 'edit', record: { ownerPartyId: initiative.ownerPartyId } });

  if (!input.body.trim()) throw ApiError.badRequest('An update needs a body.');
  if (!(IT_RAG_STATUSES as readonly string[]).includes(input.rag)) {
    throw ApiError.badRequest(`'${input.rag}' is not a RAG status. Choose one of: ${IT_RAG_STATUSES.join(', ')}.`);
  }

  const update = await prisma.itInitiativeUpdate.create({
    data: {
      tenantId: auth.tenantId,
      initiativeId,
      body: input.body.trim(),
      rag: input.rag,
      authorPartyId: auth.partyId,
    },
  });

  await prisma.itInitiative.update({
    where: { id: initiativeId },
    data: { rag: input.rag, ragReason: input.body.trim(), ragSetAt: update.at, staleNotifiedAt: null },
  });

  await auditWrite({ action: 'create', subjectType: 'it_initiative_update', subjectId: update.id, after: { initiativeId, rag: input.rag } });
  await emit({
    name: EVENTS.IT_INITIATIVE_UPDATED,
    subject: { entityType: 'it_initiative', entityId: initiativeId, recordCode: initiative.recordCode },
    newState: { rag: input.rag },
    owner: { partyId: initiative.ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return update;
}

export async function listInitiativeUpdates(initiativeId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_initiatives', verb: 'view' });
  return prisma.itInitiativeUpdate.findMany({ where: { tenantId: auth.tenantId, initiativeId }, orderBy: { at: 'desc' } });
}

export async function portfolioSummary(): Promise<ItPortfolioSummary> {
  const auth = currentAuth();
  await assertCan({ resource: 'it_initiatives', verb: 'view' });

  const rows = await prisma.itInitiative.findMany({ where: { tenantId: auth.tenantId }, select: { stage: true, rag: true } });
  if (rows.length === 0) {
    return {
      notYetMeasured: true,
      byStage: emptyStageCounts(),
      byRag: { green: 0, amber: 0, red: 0, total: 0, worst: null },
    };
  }

  const byStage = emptyStageCounts();
  for (const r of rows) {
    const stage = r.stage as ItInitiativeStage;
    byStage[stage] = (byStage[stage] ?? 0) + 1;
  }

  return { notYetMeasured: false, byStage, byRag: ragRollup(rows) };
}

function emptyStageCounts(): Record<ItInitiativeStage, number> {
  return { idea: 0, assessed: 0, approved: 0, in_flight: 0, delivered: 0, benefits_realised: 0, cancelled: 0 };
}

// ---------------------------------------------------------------------------
// Roadmap
// ---------------------------------------------------------------------------

export interface CreateRoadmapItemInput {
  quarter: string;
  theme: ItTheme;
  initiativeId?: string | null;
  milestone: string;
  dueAt?: Date | null;
}

export async function createRoadmapItem(input: CreateRoadmapItemInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_initiatives', verb: 'create' });
  assertTheme(input.theme);
  if (!input.milestone.trim()) throw ApiError.badRequest('A roadmap item needs a milestone.');

  const item = await prisma.itRoadmapItem.create({
    data: {
      tenantId: auth.tenantId,
      quarter: input.quarter,
      theme: input.theme,
      initiativeId: input.initiativeId ?? null,
      milestone: input.milestone.trim(),
      dueAt: input.dueAt ?? null,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_roadmap_item', subjectId: item.id, after: { quarter: item.quarter, theme: item.theme } });
  return item;
}

export interface RoadmapFilter {
  quarter?: string;
  theme?: string;
}

export async function listRoadmap(filter: RoadmapFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_initiatives', verb: 'view' });
  return prisma.itRoadmapItem.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.quarter ? { quarter: filter.quarter } : {}),
      ...(filter.theme ? { theme: filter.theme } : {}),
    },
    orderBy: [{ quarter: 'asc' }, { theme: 'asc' }],
  });
}

export async function setRoadmapItemDone(id: string, done: boolean) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_initiatives', verb: 'edit' });
  const item = await prisma.itRoadmapItem.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!item) throw ApiError.notFound('Roadmap item');
  const updated = await prisma.itRoadmapItem.update({ where: { id }, data: { done } });
  await auditWrite({ action: 'update', subjectType: 'it_roadmap_item', subjectId: id, before: { done: item.done }, after: { done } });
  return updated;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface CreateBudgetLineInput {
  fy: string;
  category: string;
  division?: string | null;
  kind: string;
  planned: number;
  currency?: string;
  bookCategoryIds?: string[];
}

function assertFy(fy: string): void {
  if (parseFy(fy) === null) throw ApiError.badRequest(`'${fy}' is not a financial year in the FYyyyy-yy shape, e.g. 'FY2026-27'.`);
}

function assertCategory(category: string): void {
  if (!(IT_BUDGET_CATEGORIES as readonly string[]).includes(category)) {
    throw ApiError.badRequest(`'${category}' is not a budget category. Choose one of: ${IT_BUDGET_CATEGORIES.join(', ')}.`);
  }
}

function assertKind(kind: string): void {
  if (!(IT_BUDGET_KINDS as readonly string[]).includes(kind)) {
    throw ApiError.badRequest(`'${kind}' is not run or grow.`);
  }
}

export async function createBudgetLine(input: CreateBudgetLineInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_budgets', verb: 'create' });
  assertFy(input.fy);
  assertCategory(input.category);
  assertKind(input.kind);
  if (!(input.planned >= 0)) throw ApiError.badRequest('Planned amount cannot be negative.');

  const line = await prisma.itBudgetLine.create({
    data: {
      tenantId: auth.tenantId,
      fy: input.fy,
      category: input.category,
      division: input.division ?? null,
      kind: input.kind,
      planned: input.planned,
      currency: input.currency ?? 'INR',
      bookCategoryIds: input.bookCategoryIds ?? [],
      status: 'draft',
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_budget_line', subjectId: line.id, after: { fy: line.fy, category: line.category, planned: input.planned } });
  await emit({
    name: EVENTS.IT_BUDGET_LINE_SET,
    subject: { entityType: 'it_budget_line', entityId: line.id },
    newState: { fy: line.fy, category: line.category, kind: line.kind, planned: input.planned, status: 'draft' },
    impact: { domains: [IT_DOMAIN] },
  });

  return line;
}

export interface UpdateBudgetLineInput {
  planned?: number;
  division?: string | null;
  bookCategoryIds?: string[];
}

export async function updateBudgetLine(id: string, input: UpdateBudgetLineInput) {
  const auth = currentAuth();
  const line = await prisma.itBudgetLine.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!line) throw ApiError.notFound('Budget line');
  await assertCan({ resource: 'it_budgets', verb: 'edit' });

  if (input.planned !== undefined && !(input.planned >= 0)) throw ApiError.badRequest('Planned amount cannot be negative.');

  const updated = await prisma.itBudgetLine.update({
    where: { id },
    data: {
      ...(input.planned !== undefined ? { planned: input.planned } : {}),
      ...(input.division !== undefined ? { division: input.division } : {}),
      ...(input.bookCategoryIds !== undefined ? { bookCategoryIds: input.bookCategoryIds } : {}),
    },
  });

  await auditWrite({ action: 'update', subjectType: 'it_budget_line', subjectId: id, before: { planned: num(line.planned) }, after: { planned: input.planned ?? num(line.planned) } });
  return updated;
}

/**
 * Approving a budget line needs `it_budgets:approve` and is refused to the
 * line's own creator by hand — a budget line has no commercial-value gate
 * of its own to run `evaluateApprovalGate` against, but the same rule (the
 * proposer never approves) still applies.
 */
export async function approveBudgetLine(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_budgets', verb: 'approve' });

  const line = await prisma.itBudgetLine.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!line) throw ApiError.notFound('Budget line');
  if (line.status === 'approved') throw ApiError.conflict('This budget line is already approved.');
  if (line.createdById && line.createdById === auth.partyId) {
    throw ApiError.forbidden('The proposer never approves: you proposed this budget line, so you cannot be the one who approves it.', [
      { axis: 'WHO', passed: false, reason: 'self_dealing_bar' },
    ]);
  }

  const updated = await prisma.itBudgetLine.update({
    where: { id },
    data: { status: 'approved', approvedById: auth.partyId, approvedAt: new Date() },
  });

  await auditWrite({ action: 'update', subjectType: 'it_budget_line', subjectId: id, before: { status: 'draft' }, after: { status: 'approved' } });
  await emit({
    name: EVENTS.IT_BUDGET_LINE_SET,
    subject: { entityType: 'it_budget_line', entityId: id },
    newState: { status: 'approved' },
    impact: { domains: [IT_DOMAIN] },
  });

  return updated;
}

export async function budgetLineDetail(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_budgets', verb: 'view' });
  const line = await prisma.itBudgetLine.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!line) throw ApiError.notFound('Budget line');
  const actual = await computeBudgetActual(line);
  const seesMoney = await canSeeMoney('it_budgets');
  return maskBudgetMoney({ ...line, actual, variance: (num(line.planned) ?? 0) - actual }, seesMoney);
}

/**
 * A budget line's actual: the sum of `Transaction` (outward) and `VendorBill`
 * rows whose `categoryId` is one of `bookCategoryIds`, dated inside the
 * line's own FY window, narrowed to the line's division when one is set,
 * scoped to the current tenant. Only bills that are actually spend count —
 * `draft` (not yet committed) and `cancelled` (never was) are excluded, the
 * same set `domains/books.ts` treats as live, plus `paid` (a paid bill is
 * still spend, just settled). Never stored — a late bill moves this the
 * next time anyone asks (IT-BUD-001).
 */
export async function computeBudgetActual(line: { fy: string; division: string | null; bookCategoryIds: string[] }): Promise<number> {
  if (line.bookCategoryIds.length === 0) return 0;
  const auth = currentAuth();
  const { start, end } = fyWindow(line.fy);

  const [txns, bills] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        tenantId: auth.tenantId,
        categoryId: { in: line.bookCategoryIds },
        direction: 'out',
        txnDate: { gte: start, lt: end },
        deletedAt: null,
        ...(line.division ? { division: line.division } : {}),
      },
      select: { amount: true },
    }),
    prisma.vendorBill.findMany({
      where: {
        tenantId: auth.tenantId,
        categoryId: { in: line.bookCategoryIds },
        billDate: { gte: start, lt: end },
        deletedAt: null,
        status: { in: ['open', 'part_paid', 'paid'] },
        ...(line.division ? { division: line.division } : {}),
      },
      select: { total: true },
    }),
  ]);

  const txnTotal = txns.reduce((sum, t) => sum + (num(t.amount) ?? 0), 0);
  const billTotal = bills.reduce((sum, b) => sum + (num(b.total) ?? 0), 0);
  return txnTotal + billTotal;
}

export interface BudgetForFy {
  fy: string;
  lines: Array<{ id: string; category: string; division: string | null; kind: string; planned: number | null; actual: number | null; variance: number | null; status: string }>;
  plannedTotal: number | null;
  actualTotal: number | null;
}

export async function budgetForFy(fy: string): Promise<BudgetForFy> {
  const auth = currentAuth();
  await assertCan({ resource: 'it_budgets', verb: 'view' });
  assertFy(fy);

  const lines = await prisma.itBudgetLine.findMany({ where: { tenantId: auth.tenantId, fy }, orderBy: [{ category: 'asc' }, { division: 'asc' }] });
  const withActuals = await Promise.all(
    lines.map(async (l) => {
      const actual = await computeBudgetActual(l);
      const planned = num(l.planned) ?? 0;
      return { id: l.id, category: l.category, division: l.division, kind: l.kind, planned, actual, variance: planned - actual, status: l.status };
    }),
  );

  const seesMoney = await canSeeMoney('it_budgets');
  return maskBudgetMoney(
    {
      fy,
      lines: withActuals,
      plannedTotal: withActuals.reduce((s, l) => s + l.planned, 0),
      actualTotal: withActuals.reduce((s, l) => s + l.actual, 0),
    },
    seesMoney,
  );
}

export async function budgetSummary(fy?: string): Promise<ItBudgetSummary> {
  const auth = currentAuth();
  await assertCan({ resource: 'it_budgets', verb: 'view' });

  const targetFy = fy ?? fyFor(new Date());
  const lines = await prisma.itBudgetLine.findMany({ where: { tenantId: auth.tenantId, fy: targetFy } });

  if (lines.length === 0) {
    return {
      notYetMeasured: true,
      fy: targetFy,
      plannedTotal: 0,
      actualTotal: 0,
      byCategory: [],
      byDivision: [],
      runTotal: 0,
      growTotal: 0,
    };
  }

  const withActuals = await Promise.all(
    lines.map(async (l) => ({ line: l, planned: num(l.planned) ?? 0, actual: await computeBudgetActual(l) })),
  );

  // Accumulated as plain (never-null) numbers regardless of who is asking —
  // `ItBudgetCategoryLine`/`ItBudgetDivisionLine` allow `null` because the
  // *response* may withhold money, not because the arithmetic building it
  // should ever carry a null through a running total. Masking happens once,
  // on the way out.
  interface CategoryAcc { category: string; planned: number; actual: number; variance: number }
  interface DivisionAcc { division: string; planned: number; actual: number; variance: number; run: number; grow: number }
  const byCategoryMap = new Map<string, CategoryAcc>();
  const byDivisionMap = new Map<string, DivisionAcc>();
  let runTotal = 0;
  let growTotal = 0;

  for (const { line, planned, actual } of withActuals) {
    const cat = byCategoryMap.get(line.category) ?? { category: line.category as never, planned: 0, actual: 0, variance: 0 };
    cat.planned += planned;
    cat.actual += actual;
    cat.variance = cat.planned - cat.actual;
    byCategoryMap.set(line.category, cat);

    const divKey = line.division ?? 'shared';
    const div = byDivisionMap.get(divKey) ?? { division: divKey, planned: 0, actual: 0, variance: 0, run: 0, grow: 0 };
    div.planned += planned;
    div.actual += actual;
    div.variance = div.planned - div.actual;
    if (line.kind === 'run') div.run += planned;
    else div.grow += planned;
    byDivisionMap.set(divKey, div);

    if (line.kind === 'run') runTotal += planned;
    else growTotal += planned;
  }

  const seesMoney = await canSeeMoney('it_budgets');
  return maskBudgetMoney(
    {
      notYetMeasured: false,
      fy: targetFy,
      plannedTotal: withActuals.reduce((s, l) => s + l.planned, 0),
      actualTotal: withActuals.reduce((s, l) => s + l.actual, 0),
      byCategory: [...byCategoryMap.values()] as unknown as ItBudgetCategoryLine[],
      byDivision: [...byDivisionMap.values()] as unknown as ItBudgetDivisionLine[],
      runTotal,
      growTotal,
    },
    seesMoney,
  );
}

// ---------------------------------------------------------------------------
// Technical debt
// ---------------------------------------------------------------------------

export interface CreateTechDebtInput {
  title: string;
  applicationId?: string | null;
  severity: string;
  effortDays?: number | null;
  interest?: string | null;
  initiativeId?: string | null;
}

function assertSeverity(severity: string): void {
  if (!(IT_TECH_DEBT_SEVERITIES as readonly string[]).includes(severity)) {
    throw ApiError.badRequest(`'${severity}' is not a severity. Choose one of: ${IT_TECH_DEBT_SEVERITIES.join(', ')}.`);
  }
}

export async function createTechDebtItem(input: CreateTechDebtInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_tech_debt', verb: 'create' });
  assertSeverity(input.severity);
  if (!input.title.trim()) throw ApiError.badRequest('A technical-debt item needs a title.');

  const recordCode = await nextRecordCode('TDB');
  const item = await prisma.itTechDebtItem.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      title: input.title.trim(),
      applicationId: input.applicationId ?? null,
      severity: input.severity,
      effortDays: input.effortDays ?? null,
      interest: input.interest ?? null,
      initiativeId: input.initiativeId ?? null,
      status: 'open',
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'it_tech_debt_item', subjectId: item.id, after: { recordCode, severity: item.severity } });
  await emit({
    name: EVENTS.IT_TECH_DEBT_CREATED,
    subject: { entityType: 'it_tech_debt_item', entityId: item.id, recordCode },
    newState: { status: 'open', severity: item.severity },
    impact: { domains: [IT_DOMAIN] },
  });

  return item;
}

export interface TechDebtFilter {
  status?: string;
  severity?: string;
  applicationId?: string;
}

export async function listTechDebt(filter: TechDebtFilter = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_tech_debt', verb: 'view' });
  return prisma.itTechDebtItem.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.severity ? { severity: filter.severity } : {}),
      ...(filter.applicationId ? { applicationId: filter.applicationId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function techDebtDetail(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'it_tech_debt', verb: 'view' });
  const item = await prisma.itTechDebtItem.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!item) throw ApiError.notFound('Technical-debt item');
  return { ...item, availableTransitions: availableTransitions(itTechDebtMachine, item.status as ItTechDebtStatus) };
}

export async function transitionTechDebt(id: string, event: ItTechDebtEvent, note = '') {
  const auth = currentAuth();
  const item = await prisma.itTechDebtItem.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!item) throw ApiError.notFound('Technical-debt item');
  await assertCan({ resource: 'it_tech_debt', verb: 'edit' });

  const from = item.status as ItTechDebtStatus;
  if (!itTechDebtMachine.can(from, event)) {
    throw ApiError.unprocessable(
      `A technical-debt item in '${from}' does not accept ${event}. From here it accepts: ${
        itTechDebtMachine.allowedEvents(from).join(', ') || 'nothing — this is final'
      }.`,
    );
  }
  const to = itTechDebtMachine.apply(from, event);

  const updated = await prisma.itTechDebtItem.update({ where: { id }, data: { status: to } });

  await auditWrite({ action: 'update', subjectType: 'it_tech_debt_item', subjectId: id, before: { status: from }, after: { status: to }, meta: { transition: event, note } });
  await emit({
    name: EVENTS.IT_TECH_DEBT_TRANSITIONED,
    subject: { entityType: 'it_tech_debt_item', entityId: id, recordCode: item.recordCode },
    previousState: { status: from },
    newState: { status: to },
    reason: note ? { reasonCode: event, note } : { reasonCode: event },
    impact: { domains: [IT_DOMAIN] },
  });

  return updated;
}

export async function techDebtSummary(): Promise<ItTechDebtSummary> {
  const auth = currentAuth();
  await assertCan({ resource: 'it_tech_debt', verb: 'view' });

  const rows = await prisma.itTechDebtItem.findMany({ where: { tenantId: auth.tenantId }, select: { severity: true, status: true } });
  if (rows.length === 0) {
    return { notYetMeasured: true, bySeverity: { low: 0, medium: 0, high: 0, critical: 0 }, openCount: 0 };
  }

  const bySeverity: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  let openCount = 0;
  for (const r of rows) {
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
    if (r.status !== 'retired') openCount += 1;
  }

  return { notYetMeasured: false, bySeverity: bySeverity as ItTechDebtSummary['bySeverity'], openCount };
}

export { itInitiativeMachine, itTechDebtMachine, IT_INITIATIVE_VERBS, IT_TECH_DEBT_VERBS };
