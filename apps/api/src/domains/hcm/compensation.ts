/**
 * HCM — WS7 compensation (docs/hcm/compensation.md).
 *
 * Pay grades, salary revision cycles (the Self-Dealing Bar on every line:
 * proposer, approver and the employee the line is about must be three
 * different parties, following `approveSalaryStructure` in
 * compliance/payroll.ts and `transitionCompensation` in employment.ts),
 * variable pay, benefits, employee loans and expense claims.
 *
 * Applying an approved revision line writes a `CompensationRecord` directly
 * as `Effective` — the same shape the compliance-labour test fixtures use —
 * rather than re-running it through `proposeCompensation`/`transitionCompensation`,
 * because the line has already been through its own two-party approval and a
 * second full state-machine round trip would ask a second pair of humans to
 * approve the same money a second time.
 */

import {
  compaBand,
  compaRatio,
  computeVariablePayout,
  emiSchedule,
  revisionBudgetCheck,
  type VariablePayFormula,
} from '@kaizen/shared';
import { EVENTS } from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, canSeeMoney } from '../../platform/permissions.js';
import { assertEmploymentVisible } from '../../platform/recordScope.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { nextRecordCode } from '../../platform/recordCode.js';

registerGovernedEntities('hcm_compensation', [
  'pay_grade',
  'salary_revision_cycle',
  'salary_revision_line',
  'variable_pay_plan',
  'variable_payout',
  'benefit_plan',
  'benefit_enrollment',
  'employee_loan',
  'expense_claim',
]);

/** Withholds a money field for a caller who cannot see it — null, never zero, with a reason. */
function money(value: unknown, visible: boolean): { amount: number | null; withheldReason: string | null } {
  if (visible) return { amount: num(value as never), withheldReason: null };
  return { amount: null, withheldReason: 'no_permission' };
}

/**
 * Resolves the caller's own employment relationship id — what `/me/money`
 * needs before it can call any of the `@own`-scoped endpoints below. This is
 * "find my own record", not a listing of anyone else's, so it does not go
 * through the `employees:view` grant at all; every subsequent call still
 * enforces its own resource grant via `assertEmploymentVisible`.
 */
export async function myEmploymentId(): Promise<string | null> {
  const auth = currentAuth();
  if (!auth.partyId) return null;
  const employment = await prisma.employmentRelationship.findFirst({
    where: { tenantId: auth.tenantId, personId: auth.partyId, deletedAt: null },
    orderBy: { hireEffectiveDate: 'desc' },
    select: { id: true },
  });
  return employment?.id ?? null;
}

async function employmentPersonId(id: string): Promise<string> {
  const auth = currentAuth();
  const employment = await prisma.employmentRelationship.findFirst({
    where: { id, tenantId: auth.tenantId },
    select: { personId: true },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');
  return employment.personId;
}

// ---------------------------------------------------------------------------
// Pay grades
// ---------------------------------------------------------------------------

export async function listPayGrades() {
  const auth = currentAuth();
  await assertCan({ resource: 'pay_grades', verb: 'view' });
  return prisma.payGrade.findMany({ where: { tenantId: auth.tenantId }, orderBy: { level: 'asc' } });
}

export interface PayGradeInput {
  code: string;
  level: number;
  minPay: number;
  midPay: number;
  maxPay: number;
  currency?: string;
  note?: string | null;
}

export async function createPayGrade(input: PayGradeInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'pay_grades', verb: 'create' });
  if (!(input.minPay <= input.midPay && input.midPay <= input.maxPay)) {
    throw ApiError.badRequest('A pay grade needs minPay <= midPay <= maxPay.');
  }
  const row = await prisma.payGrade.create({
    data: {
      tenantId: auth.tenantId,
      code: input.code,
      level: input.level,
      minPay: input.minPay,
      midPay: input.midPay,
      maxPay: input.maxPay,
      currency: input.currency ?? 'INR',
      note: input.note ?? null,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'pay_grade', subjectId: row.id, after: row, force: true });
  return row;
}

export async function updatePayGrade(id: string, patch: Partial<PayGradeInput>) {
  const auth = currentAuth();
  await assertCan({ resource: 'pay_grades', verb: 'edit' });
  const before = await prisma.payGrade.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw ApiError.notFound('Pay grade');
  const row = await prisma.payGrade.update({
    where: { id },
    data: {
      code: patch.code ?? undefined,
      level: patch.level ?? undefined,
      minPay: patch.minPay ?? undefined,
      midPay: patch.midPay ?? undefined,
      maxPay: patch.maxPay ?? undefined,
      currency: patch.currency ?? undefined,
      note: patch.note === undefined ? undefined : patch.note,
    },
  });
  await auditWrite({ action: 'update', subjectType: 'pay_grade', subjectId: id, before, after: row, force: true });
  return row;
}

/** Compa-ratio for one employment against one grade — the pure logic plus the grant check. */
export async function compaRatioFor(employmentRelationshipId: string, payGradeId: string) {
  await assertEmploymentVisible('compensation', employmentRelationshipId);
  const auth = currentAuth();
  const [grade, record] = await Promise.all([
    prisma.payGrade.findFirst({ where: { id: payGradeId, tenantId: auth.tenantId } }),
    prisma.compensationRecord.findFirst({
      where: { tenantId: auth.tenantId, employmentRelationshipId, status: 'Effective' },
      orderBy: { effectiveFrom: 'desc' },
    }),
  ]);
  if (!grade) throw ApiError.notFound('Pay grade');
  const current = num(record?.amount) ?? 0;
  const ratio = compaRatio(current, num(grade.midPay) ?? 0);
  return {
    currentCtc: current,
    grade,
    ratio,
    band: ratio === null ? null : compaBand(ratio, num(grade.minPay) ?? 0, num(grade.midPay) ?? 0, num(grade.maxPay) ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Salary revision cycles
// ---------------------------------------------------------------------------

export async function listRevisionCycles() {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_revisions', verb: 'view' });
  return prisma.salaryRevisionCycle.findMany({ where: { tenantId: auth.tenantId }, orderBy: { effectiveDate: 'desc' } });
}

export async function getRevisionCycle(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_revisions', verb: 'view' });
  const cycle = await prisma.salaryRevisionCycle.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!cycle) throw ApiError.notFound('Salary revision cycle');
  const lines = await prisma.salaryRevisionLine.findMany({ where: { tenantId: auth.tenantId, cycleId: id } });
  const visible = await canSeeMoney('salary_revisions');
  const budget = revisionBudgetCheck(
    lines.map((l) => ({ currentCtc: num(l.currentCtc) ?? 0, proposedCtc: num(l.proposedCtc) ?? 0 })),
    num(cycle.budgetPct) ?? 0,
  );
  return {
    cycle,
    lineCount: lines.length,
    budget: visible ? budget : { ...budget, totalCurrent: null, totalProposed: null, increaseAmount: null, withheldReason: 'no_permission' },
  };
}

export interface RevisionCycleInput {
  name: string;
  effectiveDate: Date;
  budgetPct: number;
}

export async function createRevisionCycle(input: RevisionCycleInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_revisions', verb: 'create' });
  const recordCode = await nextRecordCode('SREV');
  const row = await prisma.salaryRevisionCycle.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      name: input.name,
      effectiveDate: input.effectiveDate,
      budgetPct: input.budgetPct,
      status: 'draft',
      proposedById: auth.partyId,
    },
  });
  await emit({
    name: EVENTS.SALARY_REVISION_PROPOSED,
    subject: { entityType: 'salary_revision_cycle', entityId: row.id, recordCode },
    newState: { status: 'draft', name: input.name, budgetPct: input.budgetPct },
    impact: { domains: ['hr', 'fin'] },
    confidentiality: 'confidential',
  });
  return row;
}

export interface RevisionLineInput {
  cycleId: string;
  employmentRelationshipId: string;
  currentCtc: number;
  proposedPct: number;
  ratingLink?: string | null;
  note?: string | null;
}

/** Adds or replaces one employment's line in a cycle still in `draft`. */
export async function addRevisionLine(input: RevisionLineInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_revisions', verb: 'create' });
  const cycle = await prisma.salaryRevisionCycle.findFirst({ where: { id: input.cycleId, tenantId: auth.tenantId } });
  if (!cycle) throw ApiError.notFound('Salary revision cycle');
  if (cycle.status !== 'draft') {
    throw ApiError.conflict(`Lines can only be added while the cycle is draft (currently ${cycle.status}).`);
  }
  await assertEmploymentVisible('salary_revisions', input.employmentRelationshipId);

  const proposedCtc = Math.round(input.currentCtc * (1 + input.proposedPct / 100) * 100) / 100;
  const row = await prisma.salaryRevisionLine.upsert({
    where: { tenantId_cycleId_employmentRelationshipId: { tenantId: auth.tenantId, cycleId: input.cycleId, employmentRelationshipId: input.employmentRelationshipId } },
    create: {
      tenantId: auth.tenantId,
      cycleId: input.cycleId,
      employmentRelationshipId: input.employmentRelationshipId,
      currentCtc: input.currentCtc,
      proposedPct: input.proposedPct,
      proposedCtc,
      ratingLink: input.ratingLink ?? null,
      note: input.note ?? null,
      status: 'proposed',
      proposedById: auth.partyId,
    },
    update: {
      currentCtc: input.currentCtc,
      proposedPct: input.proposedPct,
      proposedCtc,
      ratingLink: input.ratingLink ?? null,
      note: input.note ?? null,
      status: 'proposed',
      proposedById: auth.partyId,
      approvedById: null,
      approvedCtc: null,
      decidedAt: null,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'salary_revision_line', subjectId: row.id, after: row, force: true });
  return row;
}

export async function listRevisionLines(cycleId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_revisions', verb: 'view' });
  const visible = await canSeeMoney('salary_revisions');
  const lines = await prisma.salaryRevisionLine.findMany({ where: { tenantId: auth.tenantId, cycleId }, orderBy: { createdAt: 'asc' } });
  return lines.map((l) => ({
    ...l,
    currentCtc: money(l.currentCtc, visible).amount,
    proposedCtc: money(l.proposedCtc, visible).amount,
    approvedCtc: l.approvedCtc === null ? null : money(l.approvedCtc, visible).amount,
    moneyWithheldReason: visible ? null : 'no_permission',
  }));
}

/** Moves a draft cycle to `proposed` — nothing more may be added after this. */
export async function proposeCycle(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_revisions', verb: 'edit' });
  const cycle = await prisma.salaryRevisionCycle.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!cycle) throw ApiError.notFound('Salary revision cycle');
  if (cycle.status !== 'draft') throw ApiError.conflict(`Cycle is already ${cycle.status}.`);
  const lineCount = await prisma.salaryRevisionLine.count({ where: { tenantId: auth.tenantId, cycleId: id } });
  if (lineCount === 0) throw ApiError.unprocessable('A cycle with no lines has nothing to propose.');
  const row = await prisma.salaryRevisionCycle.update({ where: { id }, data: { status: 'proposed' } });
  return row;
}

/**
 * Approves one line. The Self-Dealing Bar: the approver may be neither the
 * line's proposer nor the employee the line is about, at any amount — the
 * same unconditional bar `transitionCompensation` applies to a plain
 * compensation record.
 */
export async function approveRevisionLine(lineId: string, approvedCtc?: number, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_revisions', verb: 'approve' });
  const line = await prisma.salaryRevisionLine.findFirst({ where: { id: lineId, tenantId: auth.tenantId } });
  if (!line) throw ApiError.notFound('Salary revision line');
  if (line.status !== 'proposed') throw ApiError.conflict(`Line is already ${line.status}.`);

  const subjectPersonId = await employmentPersonId(line.employmentRelationshipId);
  if (subjectPersonId === auth.partyId) {
    throw ApiError.forbidden(
      'A salary revision line about you cannot be approved by you, at any amount.',
      [{ axis: 'WHO', passed: false, reason: 'self_dealing_bar_compensation' }],
    );
  }
  if (line.proposedById && line.proposedById === auth.partyId) {
    throw ApiError.forbidden(
      'The proposer of a salary revision line cannot also approve it (Self-Dealing Bar).',
      [{ axis: 'WHO', passed: false, reason: 'proposer_is_approver' }],
    );
  }

  const finalCtc = approvedCtc ?? num(line.proposedCtc) ?? 0;
  const row = await prisma.salaryRevisionLine.update({
    where: { id: lineId },
    data: { status: 'approved', approvedById: auth.partyId, approvedCtc: finalCtc, decidedAt: new Date(), note: note ?? line.note },
  });
  await auditWrite({ action: 'update', subjectType: 'salary_revision_line', subjectId: lineId, before: line, after: row, force: true });
  return row;
}

export async function rejectRevisionLine(lineId: string, note: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_revisions', verb: 'approve' });
  const line = await prisma.salaryRevisionLine.findFirst({ where: { id: lineId, tenantId: auth.tenantId } });
  if (!line) throw ApiError.notFound('Salary revision line');
  if (line.status !== 'proposed') throw ApiError.conflict(`Line is already ${line.status}.`);
  const subjectPersonId = await employmentPersonId(line.employmentRelationshipId);
  if (subjectPersonId === auth.partyId) {
    throw ApiError.forbidden(
      'A salary revision line about you cannot be decided by you, at any amount.',
      [{ axis: 'WHO', passed: false, reason: 'self_dealing_bar_compensation' }],
    );
  }
  if (line.proposedById && line.proposedById === auth.partyId) {
    throw ApiError.forbidden('The proposer of a salary revision line cannot also decide it (Self-Dealing Bar).', [
      { axis: 'WHO', passed: false, reason: 'proposer_is_approver' },
    ]);
  }
  const row = await prisma.salaryRevisionLine.update({
    where: { id: lineId },
    data: { status: 'rejected', approvedById: auth.partyId, decidedAt: new Date(), note },
  });
  return row;
}

/**
 * Approves the cycle itself once every line has been decided, and refuses to
 * run over its own declared budget. Approving the cycle is a distinct act
 * from approving each line — a cycle-level approver who proposed the cycle
 * cannot also be the one who signs it off.
 */
export async function approveCycle(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_revisions', verb: 'approve' });
  const cycle = await prisma.salaryRevisionCycle.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!cycle) throw ApiError.notFound('Salary revision cycle');
  if (cycle.status !== 'proposed') throw ApiError.conflict(`Cycle must be proposed before it can be approved (currently ${cycle.status}).`);
  if (cycle.proposedById && cycle.proposedById === auth.partyId) {
    throw ApiError.forbidden('The proposer of a revision cycle cannot also approve it (Self-Dealing Bar).', [
      { axis: 'WHO', passed: false, reason: 'proposer_is_approver' },
    ]);
  }
  const lines = await prisma.salaryRevisionLine.findMany({ where: { tenantId: auth.tenantId, cycleId: id } });
  if (lines.some((l) => l.status === 'proposed')) {
    throw ApiError.unprocessable('Every line must be approved or rejected before the cycle can be approved.');
  }
  const approvedLines = lines.filter((l) => l.status === 'approved');
  const budget = revisionBudgetCheck(
    approvedLines.map((l) => ({ currentCtc: num(l.currentCtc) ?? 0, proposedCtc: num(l.approvedCtc ?? l.proposedCtc) ?? 0 })),
    num(cycle.budgetPct) ?? 0,
  );
  if (!budget.withinBudget) {
    throw ApiError.unprocessable(
      `Approved lines total a ${budget.increasePct}% increase, over the cycle's ${num(cycle.budgetPct)}% budget.`,
    );
  }

  const row = await prisma.salaryRevisionCycle.update({ where: { id }, data: { status: 'approved', approvedById: auth.partyId } });
  await emit({
    name: EVENTS.SALARY_REVISION_APPROVED,
    subject: { entityType: 'salary_revision_cycle', entityId: id, recordCode: cycle.recordCode },
    newState: { status: 'approved', increasePct: budget.increasePct },
    impact: { domains: ['hr', 'fin'] },
    confidentiality: 'confidential',
  });
  return row;
}

/**
 * Applies an approved cycle: every approved line writes a new, Effective
 * `CompensationRecord` (superseding whatever was Effective before it), so
 * payroll picks up the new figure from the very next run.
 */
export async function applyCycle(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_revisions', verb: 'edit' });
  // Applying writes directly into `CompensationRecord`, a table `compensation`
  // (not `salary_revisions`) governs — so the caller needs that resource's own
  // write grant too, not only the revision-cycle grant. Without this a role
  // holding `salary_revisions:edit` alone could write into a table it has no
  // grant on at all.
  await assertCan({ resource: 'compensation', verb: 'edit' });
  const cycle = await prisma.salaryRevisionCycle.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!cycle) throw ApiError.notFound('Salary revision cycle');
  if (cycle.status !== 'approved') throw ApiError.conflict(`Cycle must be approved before it can be applied (currently ${cycle.status}).`);

  const lines = await prisma.salaryRevisionLine.findMany({ where: { tenantId: auth.tenantId, cycleId: id, status: 'approved' } });
  let applied = 0;
  for (const line of lines) {
    const amount = num(line.approvedCtc ?? line.proposedCtc) ?? 0;
    const record = await prisma.$transaction(async (tx) => {
      await tx.compensationRecord.updateMany({
        where: { tenantId: auth.tenantId, employmentRelationshipId: line.employmentRelationshipId, status: 'Effective' },
        data: { status: 'Superseded', effectiveTo: cycle.effectiveDate },
      });
      return tx.compensationRecord.create({
        data: {
          tenantId: auth.tenantId,
          employmentRelationshipId: line.employmentRelationshipId,
          revisionReason: 'annual_cycle',
          amount,
          currency: 'INR',
          status: 'Effective',
          effectiveFrom: cycle.effectiveDate,
        },
      });
    });
    await prisma.salaryRevisionLine.update({ where: { id: line.id }, data: { status: 'applied', appliedAt: new Date(), compensationRecordId: record.id } });
    await emit({
      name: EVENTS.COMPENSATION_RECORD_CREATED,
      subject: { entityType: 'compensation_record', entityId: record.id },
      related: [
        { relation: 'pays', entityType: 'employment_relationship', entityId: line.employmentRelationshipId },
        { relation: 'applies', entityType: 'salary_revision_line', entityId: line.id },
      ],
      newState: { status: 'Effective', amount, revisionReason: 'annual_cycle' },
      confidentiality: 'confidential',
      impact: { domains: ['hr', 'fin'] },
    });
    applied += 1;
  }
  const row = await prisma.salaryRevisionCycle.update({ where: { id }, data: { status: 'applied', appliedAt: new Date() } });
  await emit({
    name: EVENTS.SALARY_REVISION_APPLIED,
    subject: { entityType: 'salary_revision_cycle', entityId: id, recordCode: cycle.recordCode },
    newState: { status: 'applied', linesApplied: applied },
    impact: { domains: ['hr', 'fin'] },
    confidentiality: 'confidential',
  });
  return { cycle: row, linesApplied: applied };
}

/** My own revision lines, across cycles — what `/me/money` reads. */
export async function myRevisionLines(employmentRelationshipId: string) {
  await assertEmploymentVisible('salary_revisions', employmentRelationshipId);
  const auth = currentAuth();
  return prisma.salaryRevisionLine.findMany({ where: { tenantId: auth.tenantId, employmentRelationshipId }, orderBy: { createdAt: 'desc' } });
}

// ---------------------------------------------------------------------------
// Variable pay
// ---------------------------------------------------------------------------

export interface VariablePayPlanInput {
  name: string;
  kind: 'bonus' | 'commission' | 'incentive';
  period: 'monthly' | 'quarterly' | 'annual';
  formula: VariablePayFormula;
}

export async function listVariablePayPlans() {
  const auth = currentAuth();
  await assertCan({ resource: 'variable_pay', verb: 'view' });
  return prisma.variablePayPlan.findMany({ where: { tenantId: auth.tenantId }, orderBy: { createdAt: 'desc' } });
}

export async function createVariablePayPlan(input: VariablePayPlanInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'variable_pay', verb: 'create' });
  if (!['bonus', 'commission', 'incentive'].includes(input.kind)) {
    throw ApiError.badRequest(`"${input.kind}" is not a variable pay kind.`);
  }
  const row = await prisma.variablePayPlan.create({
    data: { tenantId: auth.tenantId, name: input.name, kind: input.kind, period: input.period, formula: input.formula as never },
  });
  return row;
}

/** Computes (and stores as `computed`) one employment's payout for one period from the plan's formula and a supplied base figure. */
export async function computePayout(planId: string, employmentRelationshipId: string, period: string, base: number) {
  const auth = currentAuth();
  await assertCan({ resource: 'variable_pay', verb: 'create' });
  await assertEmploymentVisible('variable_pay', employmentRelationshipId);
  const plan = await prisma.variablePayPlan.findFirst({ where: { id: planId, tenantId: auth.tenantId } });
  if (!plan) throw ApiError.notFound('Variable pay plan');
  const computedAmount = computeVariablePayout(base, plan.formula as unknown as VariablePayFormula);
  const row = await prisma.variablePayout.upsert({
    where: { tenantId_planId_employmentRelationshipId_period: { tenantId: auth.tenantId, planId, employmentRelationshipId, period } },
    create: { tenantId: auth.tenantId, planId, employmentRelationshipId, period, computedAmount, status: 'computed', computedById: auth.partyId },
    update: { computedAmount, status: 'computed', approvedAmount: null, approvedById: null, computedById: auth.partyId },
  });
  return row;
}

export async function listVariablePayouts(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'variable_pay', verb: 'view' });
  const visible = await canSeeMoney('variable_pay');
  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (employmentRelationshipId) {
    await assertEmploymentVisible('variable_pay', employmentRelationshipId);
    where.employmentRelationshipId = employmentRelationshipId;
  }
  const rows = await prisma.variablePayout.findMany({ where, orderBy: { createdAt: 'desc' } });
  return rows.map((r) => ({
    ...r,
    computedAmount: money(r.computedAmount, visible).amount,
    approvedAmount: r.approvedAmount === null ? null : money(r.approvedAmount, visible).amount,
    moneyWithheldReason: visible ? null : 'no_permission',
  }));
}

/** The Self-Dealing Bar on variable pay, same shape as a salary revision line. */
export async function approvePayout(id: string, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'variable_pay', verb: 'approve' });
  const payout = await prisma.variablePayout.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!payout) throw ApiError.notFound('Variable payout');
  if (payout.status !== 'computed') throw ApiError.conflict(`Payout is already ${payout.status}.`);
  const subjectPersonId = await employmentPersonId(payout.employmentRelationshipId);
  if (subjectPersonId === auth.partyId) {
    throw ApiError.forbidden('A payout about you cannot be approved by you.', [
      { axis: 'WHO', passed: false, reason: 'self_dealing_bar_compensation' },
    ]);
  }
  if (payout.computedById && payout.computedById === auth.partyId) {
    throw ApiError.forbidden('Whoever computed a payout cannot also approve it (Self-Dealing Bar).', [
      { axis: 'WHO', passed: false, reason: 'proposer_is_approver' },
    ]);
  }
  const row = await prisma.variablePayout.update({
    where: { id },
    data: { status: 'approved', approvedById: auth.partyId, approvedAmount: payout.computedAmount, note: note ?? payout.note },
  });
  await emit({
    name: EVENTS.VARIABLE_PAY_APPROVED,
    subject: { entityType: 'variable_payout', entityId: id },
    newState: { status: 'approved' },
    confidentiality: 'confidential',
    impact: { domains: ['hr', 'fin'] },
  });
  return row;
}

/** Marks a payout as paid — the hook payroll's ad-hoc line reads from. */
export async function markPayoutPaid(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'variable_pay', verb: 'edit' });
  const payout = await prisma.variablePayout.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!payout) throw ApiError.notFound('Variable payout');
  if (payout.status !== 'approved') throw ApiError.conflict('Only an approved payout can be marked paid.');
  const row = await prisma.variablePayout.update({ where: { id }, data: { status: 'paid', paidAt: new Date() } });
  await emit({
    name: EVENTS.VARIABLE_PAY_PAID,
    subject: { entityType: 'variable_payout', entityId: id },
    newState: { status: 'paid' },
    confidentiality: 'confidential',
    impact: { domains: ['hr', 'fin'] },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Benefits
// ---------------------------------------------------------------------------

export interface BenefitPlanInput {
  name: string;
  kind: 'health' | 'life' | 'accident' | 'meal' | 'fuel' | 'nps' | 'other';
  provider?: string | null;
  employerContribution: number;
  employeeContribution: number;
  enrolmentOpensOn?: Date | null;
  enrolmentClosesOn?: Date | null;
}

export async function listBenefitPlans(activeOnly = false) {
  const auth = currentAuth();
  await assertCan({ resource: 'benefit_plans', verb: 'view' });
  return prisma.benefitPlan.findMany({ where: { tenantId: auth.tenantId, ...(activeOnly ? { active: true } : {}) }, orderBy: { name: 'asc' } });
}

export async function createBenefitPlan(input: BenefitPlanInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'benefit_plans', verb: 'create' });
  const row = await prisma.benefitPlan.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name,
      kind: input.kind,
      provider: input.provider ?? null,
      employerContribution: input.employerContribution,
      employeeContribution: input.employeeContribution,
      enrolmentOpensOn: input.enrolmentOpensOn ?? null,
      enrolmentClosesOn: input.enrolmentClosesOn ?? null,
    },
  });
  return row;
}

export async function enrolInBenefit(planId: string, employmentRelationshipId: string, dependants: unknown[] = []) {
  const auth = currentAuth();
  await assertCan({ resource: 'benefit_enrollments', verb: 'create' });
  await assertEmploymentVisible('benefit_enrollments', employmentRelationshipId);
  const plan = await prisma.benefitPlan.findFirst({ where: { id: planId, tenantId: auth.tenantId } });
  if (!plan) throw ApiError.notFound('Benefit plan');
  if (!plan.active) throw ApiError.unprocessable('This benefit plan is not currently open for enrolment.');
  const now = new Date();
  const status = plan.enrolmentOpensOn && plan.enrolmentClosesOn && (now < plan.enrolmentOpensOn || now > plan.enrolmentClosesOn) ? 'waitlisted' : 'enrolled';
  const row = await prisma.benefitEnrollment.upsert({
    where: { tenantId_planId_employmentRelationshipId: { tenantId: auth.tenantId, planId, employmentRelationshipId } },
    create: { tenantId: auth.tenantId, planId, employmentRelationshipId, dependants: dependants as never, status },
    update: { dependants: dependants as never, status, cancelledAt: null },
  });
  await emit({
    name: EVENTS.BENEFIT_ENROLLMENT_CREATED,
    subject: { entityType: 'benefit_enrollment', entityId: row.id },
    newState: { status },
    impact: { domains: ['hr'] },
  });
  return row;
}

export async function cancelBenefitEnrollment(id: string) {
  const auth = currentAuth();
  const row = await prisma.benefitEnrollment.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Benefit enrollment');
  await assertEmploymentVisible('benefit_enrollments', row.employmentRelationshipId, 'edit');
  return prisma.benefitEnrollment.update({ where: { id }, data: { status: 'cancelled', cancelledAt: new Date() } });
}

/** Every enrolment in a plan — what the admin-side Benefits tab lists. */
export async function listBenefitEnrollments(planId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'benefit_enrollments', verb: 'view' });
  return prisma.benefitEnrollment.findMany({
    where: { tenantId: auth.tenantId, ...(planId ? { planId } : {}) },
    orderBy: { enrolledAt: 'desc' },
  });
}

export async function listMyBenefitEnrollments(employmentRelationshipId: string) {
  const auth = currentAuth();
  await assertEmploymentVisible('benefit_enrollments', employmentRelationshipId);
  return prisma.benefitEnrollment.findMany({ where: { tenantId: auth.tenantId, employmentRelationshipId }, orderBy: { enrolledAt: 'desc' } });
}

// ---------------------------------------------------------------------------
// Employee loans
// ---------------------------------------------------------------------------

export interface LoanRequestInput {
  employmentRelationshipId: string;
  principal: number;
  interestPct: number;
  tenureMonths: number;
}

export async function scheduleFor(principal: number, interestPct: number, tenureMonths: number) {
  return emiSchedule(principal, interestPct, tenureMonths);
}

export async function requestLoan(input: LoanRequestInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'employee_loans', verb: 'create' });
  await assertEmploymentVisible('employee_loans', input.employmentRelationshipId);
  if (input.principal <= 0) throw ApiError.badRequest('A loan needs a principal above zero.');
  if (input.tenureMonths <= 0 || input.tenureMonths > 120) throw ApiError.badRequest('Tenure must be between 1 and 120 months.');
  const { emi } = emiSchedule(input.principal, input.interestPct, input.tenureMonths);
  const recordCode = await nextRecordCode('LOAN');
  const row = await prisma.employeeLoan.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      employmentRelationshipId: input.employmentRelationshipId,
      principal: input.principal,
      interestPct: input.interestPct,
      tenureMonths: input.tenureMonths,
      emi,
      outstandingPrincipal: input.principal,
      status: 'requested',
      requestedById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'employee_loan', subjectId: row.id, after: row, force: true });
  return row;
}

export async function listLoans(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'employee_loans', verb: 'view' });
  const visible = await canSeeMoney('employee_loans');
  // A viewer without `financial` still typed their own loan's numbers in when
  // they requested it — withholding a person's own figures from themselves is
  // not a confidentiality control, only a broken screen. `myEmploymentId`
  // mirrors what `/me/money` itself resolves before calling this.
  const myId = auth.partyId ? await myEmploymentId() : null;
  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (employmentRelationshipId) {
    await assertEmploymentVisible('employee_loans', employmentRelationshipId);
    where.employmentRelationshipId = employmentRelationshipId;
  }
  const rows = await prisma.employeeLoan.findMany({ where, orderBy: { createdAt: 'desc' } });
  return rows.map((r) => {
    const rowVisible = visible || (myId !== null && r.employmentRelationshipId === myId);
    return {
      ...r,
      principal: money(r.principal, rowVisible).amount,
      emi: money(r.emi, rowVisible).amount,
      outstandingPrincipal: money(r.outstandingPrincipal, rowVisible).amount,
      moneyWithheldReason: rowVisible ? null : 'no_permission',
    };
  });
}

/** The Self-Dealing Bar on a loan: the approver may be neither the requester nor the employee it is for. */
export async function approveLoan(id: string, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'employee_loans', verb: 'approve' });
  const loan = await prisma.employeeLoan.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!loan) throw ApiError.notFound('Employee loan');
  if (loan.status !== 'requested') throw ApiError.conflict(`Loan is already ${loan.status}.`);
  const subjectPersonId = await employmentPersonId(loan.employmentRelationshipId);
  if (subjectPersonId === auth.partyId) {
    throw ApiError.forbidden('A loan for you cannot be approved by you, at any amount.', [
      { axis: 'WHO', passed: false, reason: 'self_dealing_bar_compensation' },
    ]);
  }
  if (loan.requestedById && loan.requestedById === auth.partyId) {
    throw ApiError.forbidden('The requester of a loan cannot also approve it (Self-Dealing Bar).', [
      { axis: 'WHO', passed: false, reason: 'proposer_is_approver' },
    ]);
  }
  const row = await prisma.employeeLoan.update({
    where: { id },
    data: { status: 'approved', approvedById: auth.partyId, decidedAt: new Date(), note: note ?? loan.note },
  });
  await emit({
    name: EVENTS.EMPLOYEE_LOAN_APPROVED,
    subject: { entityType: 'employee_loan', entityId: id, recordCode: loan.recordCode },
    newState: { status: 'approved' },
    confidentiality: 'confidential',
    impact: { domains: ['hr', 'fin'] },
  });
  return row;
}

export async function rejectLoan(id: string, note: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'employee_loans', verb: 'approve' });
  const loan = await prisma.employeeLoan.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!loan) throw ApiError.notFound('Employee loan');
  if (loan.status !== 'requested') throw ApiError.conflict(`Loan is already ${loan.status}.`);
  const subjectPersonId = await employmentPersonId(loan.employmentRelationshipId);
  if (subjectPersonId === auth.partyId) {
    throw ApiError.forbidden('A loan for you cannot be decided by you, at any amount.', [
      { axis: 'WHO', passed: false, reason: 'self_dealing_bar_compensation' },
    ]);
  }
  if (loan.requestedById && loan.requestedById === auth.partyId) {
    throw ApiError.forbidden('The requester of a loan cannot also decide it (Self-Dealing Bar).', [
      { axis: 'WHO', passed: false, reason: 'proposer_is_approver' },
    ]);
  }
  return prisma.employeeLoan.update({ where: { id }, data: { status: 'rejected', approvedById: auth.partyId, decidedAt: new Date(), note } });
}

export async function disburseLoan(id: string, startDate: Date) {
  const auth = currentAuth();
  await assertCan({ resource: 'employee_loans', verb: 'edit' });
  const loan = await prisma.employeeLoan.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!loan) throw ApiError.notFound('Employee loan');
  if (loan.status !== 'approved') throw ApiError.conflict('Only an approved loan can be disbursed.');
  const row = await prisma.employeeLoan.update({ where: { id }, data: { status: 'disbursed', disbursedAt: new Date(), startDate } });
  await emit({
    name: EVENTS.EMPLOYEE_LOAN_DISBURSED,
    subject: { entityType: 'employee_loan', entityId: id, recordCode: loan.recordCode },
    newState: { status: 'disbursed' },
    confidentiality: 'confidential',
    impact: { domains: ['hr', 'fin'] },
  });
  return row;
}

/** Records a repayment against the outstanding balance; closes the loan once it reaches zero. */
export async function recordLoanRepayment(id: string, amount: number) {
  const auth = currentAuth();
  await assertCan({ resource: 'employee_loans', verb: 'edit' });
  const loan = await prisma.employeeLoan.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!loan) throw ApiError.notFound('Employee loan');
  if (loan.status !== 'disbursed') throw ApiError.conflict('Only a disbursed loan can take a repayment.');
  const outstanding = Math.max((num(loan.outstandingPrincipal) ?? 0) - amount, 0);
  const closing = outstanding <= 0;
  const row = await prisma.employeeLoan.update({
    where: { id },
    data: { outstandingPrincipal: outstanding, ...(closing ? { status: 'closed', closedAt: new Date() } : {}) },
  });
  if (closing) {
    await emit({
      name: EVENTS.EMPLOYEE_LOAN_CLOSED,
      subject: { entityType: 'employee_loan', entityId: id, recordCode: loan.recordCode },
      newState: { status: 'closed' },
      confidentiality: 'confidential',
      impact: { domains: ['hr', 'fin'] },
    });
  }
  return row;
}

// ---------------------------------------------------------------------------
// Expense claims
// ---------------------------------------------------------------------------

export interface ExpenseClaimInput {
  employmentRelationshipId: string;
  category: 'travel' | 'food' | 'phone' | 'other';
  amount: number;
  receipts?: unknown[];
  note?: string | null;
}

export async function submitExpenseClaim(input: ExpenseClaimInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'expense_claims', verb: 'create' });
  await assertEmploymentVisible('expense_claims', input.employmentRelationshipId);
  if (input.amount <= 0) throw ApiError.badRequest('An expense claim needs an amount above zero.');
  const recordCode = await nextRecordCode('EXP');
  const row = await prisma.expenseClaim.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      employmentRelationshipId: input.employmentRelationshipId,
      category: input.category,
      amount: input.amount,
      receipts: (input.receipts ?? []) as never,
      note: input.note ?? null,
      status: 'submitted',
      submittedById: auth.partyId,
    },
  });
  await emit({
    name: EVENTS.EXPENSE_CLAIM_SUBMITTED,
    subject: { entityType: 'expense_claim', entityId: row.id, recordCode },
    newState: { status: 'submitted', category: input.category },
    impact: { domains: ['hr', 'fin'] },
  });
  return row;
}

export async function listExpenseClaims(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'expense_claims', verb: 'view' });
  const visible = await canSeeMoney('expense_claims');
  // Same reasoning as `listLoans`: a claimant already knows the amount they
  // submitted, so their own claim is not withheld from them even without the
  // `financial` verb.
  const myId = auth.partyId ? await myEmploymentId() : null;
  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (employmentRelationshipId) {
    await assertEmploymentVisible('expense_claims', employmentRelationshipId);
    where.employmentRelationshipId = employmentRelationshipId;
  }
  const rows = await prisma.expenseClaim.findMany({ where, orderBy: { createdAt: 'desc' } });
  return rows.map((r) => {
    const rowVisible = visible || (myId !== null && r.employmentRelationshipId === myId);
    return { ...r, amount: money(r.amount, rowVisible).amount, moneyWithheldReason: rowVisible ? null : 'no_permission' };
  });
}

/** The Self-Dealing Bar on an expense claim: the approver may be neither the submitter nor the employee it is for. */
export async function approveExpenseClaim(id: string, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'expense_claims', verb: 'approve' });
  const claim = await prisma.expenseClaim.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!claim) throw ApiError.notFound('Expense claim');
  if (claim.status !== 'submitted') throw ApiError.conflict(`Claim is already ${claim.status}.`);
  const subjectPersonId = await employmentPersonId(claim.employmentRelationshipId);
  if (subjectPersonId === auth.partyId) {
    throw ApiError.forbidden('An expense claim of yours cannot be approved by you, at any amount.', [
      { axis: 'WHO', passed: false, reason: 'self_dealing_bar_compensation' },
    ]);
  }
  if (claim.submittedById && claim.submittedById === auth.partyId) {
    throw ApiError.forbidden('The submitter of an expense claim cannot also approve it (Self-Dealing Bar).', [
      { axis: 'WHO', passed: false, reason: 'proposer_is_approver' },
    ]);
  }
  const row = await prisma.expenseClaim.update({
    where: { id },
    data: { status: 'approved', approvedById: auth.partyId, decidedAt: new Date(), note: note ?? claim.note },
  });
  await emit({
    name: EVENTS.EXPENSE_CLAIM_APPROVED,
    subject: { entityType: 'expense_claim', entityId: id, recordCode: claim.recordCode },
    newState: { status: 'approved' },
    impact: { domains: ['hr', 'fin'] },
  });
  return row;
}

export async function rejectExpenseClaim(id: string, note: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'expense_claims', verb: 'approve' });
  const claim = await prisma.expenseClaim.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!claim) throw ApiError.notFound('Expense claim');
  if (claim.status !== 'submitted') throw ApiError.conflict(`Claim is already ${claim.status}.`);
  const subjectPersonId = await employmentPersonId(claim.employmentRelationshipId);
  if (subjectPersonId === auth.partyId) {
    throw ApiError.forbidden('An expense claim of yours cannot be decided by you, at any amount.', [
      { axis: 'WHO', passed: false, reason: 'self_dealing_bar_compensation' },
    ]);
  }
  if (claim.submittedById && claim.submittedById === auth.partyId) {
    throw ApiError.forbidden('The submitter of an expense claim cannot also decide it (Self-Dealing Bar).', [
      { axis: 'WHO', passed: false, reason: 'proposer_is_approver' },
    ]);
  }
  const row = await prisma.expenseClaim.update({
    where: { id },
    data: { status: 'rejected', approvedById: auth.partyId, decidedAt: new Date(), note },
  });
  await emit({
    name: EVENTS.EXPENSE_CLAIM_REJECTED,
    subject: { entityType: 'expense_claim', entityId: id, recordCode: claim.recordCode },
    newState: { status: 'rejected', note },
    impact: { domains: ['hr', 'fin'] },
  });
  return row;
}

/**
 * Marks an approved claim reimbursed. WS8 payrollops owns the ad-hoc pay line
 * and journal that actually move the money; this is the claim's own record of
 * having been paid, carrying the note of how (payroll run reference, bank
 * transfer id) rather than posting a ledger entry itself.
 */
export async function reimburseExpenseClaim(id: string, note?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'expense_claims', verb: 'edit' });
  const claim = await prisma.expenseClaim.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!claim) throw ApiError.notFound('Expense claim');
  if (claim.status !== 'approved') throw ApiError.conflict('Only an approved claim can be marked reimbursed.');
  const row = await prisma.expenseClaim.update({
    where: { id },
    data: { status: 'reimbursed', reimbursedAt: new Date(), note: note ?? claim.note },
  });
  await emit({
    name: EVENTS.EXPENSE_CLAIM_REIMBURSED,
    subject: { entityType: 'expense_claim', entityId: id, recordCode: claim.recordCode },
    newState: { status: 'reimbursed' },
    impact: { domains: ['hr', 'fin'] },
  });
  return row;
}
