/**
 * Payroll (Canon §14.2, §14.4 row 13).
 *
 * This system instructs payroll; it is not the payroll engine. What it owns is
 * the instruction per employee per period, the run that settles them, and the
 * audit trail joining the two — which is the part that has to survive a
 * question from an auditor two years later.
 *
 * Pay figures are money, so they reach the same masking path as every other
 * money field. A manager who can see that a run happened cannot thereby see
 * what anyone in it was paid.
 */

import { EVENTS, payrollMachine, PAYROLL_EVENT_VERB, type PayrollState, type PayrollEvent } from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { assertCan } from '../platform/permissions.js';
import { transition } from '../platform/lifecycle.js';
import { currentCompensation } from './employment.js';

const PAY_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertPayPeriod(payPeriod: string): void {
  if (!PAY_PERIOD.test(payPeriod)) {
    throw ApiError.badRequest(`"${payPeriod}" is not a pay period. Use YYYY-MM.`);
  }
}

export async function listPayrollRuns() {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll', verb: 'view' });
  return prisma.payrollRun.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { payPeriod: 'desc' },
    take: 36,
  });
}

export async function getPayrollRun(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll', verb: 'view' });

  const run = await prisma.payrollRun.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: {
      instructions: {
        include: {
          employmentRelationship: {
            include: { person: { select: { id: true, fullName: true } } },
          },
        },
      },
    },
  });
  if (!run) throw ApiError.notFound('Payroll run');
  return run;
}

/**
 * Opens a run and drafts one instruction per employee who was on the books in
 * that period, at the compensation in force on the last day of it.
 *
 * "In force on the last day" rather than "in force today" is what makes a run
 * re-openable: recomputing March in June must produce March's numbers, not
 * June's.
 */
export async function openPayrollRun(payPeriod: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll', verb: 'create' });
  assertPayPeriod(payPeriod);

  const existing = await prisma.payrollRun.findFirst({ where: { tenantId: auth.tenantId, payPeriod } });
  if (existing) {
    throw ApiError.conflict(`Payroll for ${payPeriod} is already open as ${existing.recordCode} (${existing.status}).`, {
      payrollRunId: existing.id,
    });
  }

  const [year, month] = payPeriod.split('-').map(Number);
  const periodEnd = new Date(Date.UTC(year, month, 0));

  const employments = await prisma.employmentRelationship.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      status: { in: ['Active', 'OnLeave', 'Suspended', 'NoticePeriod'] },
      hireEffectiveDate: { lte: periodEnd },
    },
    include: {
      assignments: {
        where: { rowStatus: 'Effective' },
        include: { position: { include: { orgUnit: true } } },
        take: 1,
        orderBy: { effectiveFrom: 'desc' },
      },
    },
  });

  const recordCode = await nextRecordCode('PRN');

  const run = await prisma.payrollRun.create({
    data: { tenantId: auth.tenantId, recordCode, payPeriod },
  });

  let grossTotal = 0;
  let headcount = 0;

  for (const employment of employments) {
    const pay = await currentCompensation(employment.id, periodEnd);
    // Somebody with no compensation in force is still listed, at zero, rather
    // than dropped: an employee missing from a run is invisible, and a zero
    // beside their name is not. `detectMissingCompensation` raises it too.
    const gross = num(pay?.amount) ?? 0;
    const division = employment.assignments[0]?.position.orgUnit.division ?? 'shared';

    await prisma.payrollInstruction.create({
      data: {
        tenantId: auth.tenantId,
        employmentRelationshipId: employment.id,
        payrollRunId: run.id,
        payPeriod,
        grossAmount: gross,
        netAmount: gross,
        division,
      },
    });

    grossTotal += gross;
    headcount += 1;
  }

  const updated = await prisma.payrollRun.update({
    where: { id: run.id },
    data: { grossTotal, netTotal: grossTotal, headcount },
  });

  await emit({
    name: EVENTS.PAYROLL_RUN_CREATED,
    subject: { entityType: 'payroll_run', entityId: run.id, recordCode },
    newState: { payPeriod, headcount, status: 'Draft' },
    confidentiality: 'confidential',
    impact: { domains: ['hr', 'fin'] },
  });

  return updated;
}

/** Records deductions against one instruction, before the run is approved. */
export async function setInstructionAmounts(
  id: string,
  input: { grossAmount?: number; deductions?: number },
) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll', verb: 'edit' });

  const instruction = await prisma.payrollInstruction.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { payrollRun: true },
  });
  if (!instruction) throw ApiError.notFound('Payroll instruction');

  // Once a run is approved its numbers are what was signed off. Changing one
  // afterwards would make the approval a statement about figures that no
  // longer exist.
  const runStatus = instruction.payrollRun?.status;
  if (runStatus && !['Draft', 'Computed'].includes(runStatus)) {
    throw ApiError.unprocessable(
      `The run is ${runStatus}. Amounts can only be changed while it is Draft or Computed; after that it is what was approved.`,
    );
  }

  const gross = input.grossAmount ?? num(instruction.grossAmount) ?? 0;
  const deductions = input.deductions ?? num(instruction.deductions) ?? 0;

  return prisma.payrollInstruction.update({
    where: { id },
    data: { grossAmount: gross, deductions, netAmount: gross - deductions },
  });
}

/**
 * Moves the run and every instruction in it together. They share the payroll
 * machine, and a run whose instructions were in a different state from it
 * would make "was this approved" unanswerable.
 */
export async function transitionPayrollRun(id: string, event: PayrollEvent, note?: string) {
  const auth = currentAuth();
  const run = await prisma.payrollRun.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!run) throw ApiError.notFound('Payroll run');

  const result = await transition({
    machine: payrollMachine,
    eventObject: 'payroll_run',
    verbs: PAYROLL_EVENT_VERB,
    resource: 'payroll',
    verb: event === 'APPROVE' || event === 'REJECT' ? 'approve' : 'edit',
    subjectType: 'payroll_run',
    subjectId: id,
    recordCode: run.recordCode,
    from: run.status as PayrollState,
    event,
    detail: { payPeriod: run.payPeriod, headcount: run.headcount },
    reasonNote: note ?? null,
  });

  return prisma.$transaction(async (tx) => {
    // Recompute the totals from the instructions at the moment of computing,
    // so an edited instruction is reflected in the figure that gets approved.
    if (event === 'COMPUTE') {
      const totals = await tx.payrollInstruction.aggregate({
        where: { payrollRunId: id },
        _sum: { grossAmount: true, netAmount: true },
        _count: { _all: true },
      });
      await tx.payrollRun.update({
        where: { id },
        data: {
          grossTotal: num(totals._sum.grossAmount) ?? 0,
          netTotal: num(totals._sum.netAmount) ?? 0,
          headcount: totals._count._all,
        },
      });
    }

    await tx.payrollInstruction.updateMany({ where: { payrollRunId: id }, data: { status: result.to } });

    return tx.payrollRun.update({
      where: { id },
      data: {
        status: result.to,
        ...(event === 'APPROVE' ? { approvedById: auth.partyId, approvedAt: new Date() } : {}),
        ...(event === 'DISBURSE' ? { disbursedAt: new Date() } : {}),
      },
    });
  });
}

/** Monthly pay cost by division — what the Command Center cuts revenue against. */
export async function payrollCostByDivision(payPeriod: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll', verb: 'view' });
  assertPayPeriod(payPeriod);

  const rows = await prisma.payrollInstruction.groupBy({
    by: ['division'],
    where: { tenantId: auth.tenantId, payPeriod },
    _sum: { grossAmount: true, netAmount: true },
    _count: { _all: true },
  });

  return rows.map((row) => ({
    division: row.division ?? 'shared',
    headcount: row._count._all,
    gross: num(row._sum.grossAmount) ?? 0,
    net: num(row._sum.netAmount) ?? 0,
  }));
}

/** The pay cost trend, for the executive dashboard. */
export async function payrollTrend(months = 12) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll', verb: 'view' });

  const runs = await prisma.payrollRun.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { payPeriod: 'desc' },
    take: months,
  });

  return runs
    .map((run) => ({
      payPeriod: run.payPeriod,
      gross: num(run.grossTotal) ?? 0,
      net: num(run.netTotal) ?? 0,
      headcount: run.headcount,
      status: run.status,
    }))
    .reverse();
}
