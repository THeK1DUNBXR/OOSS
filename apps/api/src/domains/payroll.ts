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
import { assertCan, assertScopeAll } from '../platform/permissions.js';
import { transition } from '../platform/lifecycle.js';
import { currentCompensation } from './employment.js';
import { runHooks } from '../platform/hooks.js';
import { computeInstruction, PAYROLL_INSTRUCTION_MONEY, PAYROLL_RUN_MONEY } from './compliance/payroll.js';
import { rupeesToMinor, withDecimalMinor } from '../platform/wire.js';
import { minorToRupees } from './money.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { governedWrite } from '../platform/governedWrite.js';

registerGovernedEntities('hcm_payroll', ['payroll_run', 'payroll_instruction']);

const PAY_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertPayPeriod(payPeriod: string): void {
  if (!PAY_PERIOD.test(payPeriod)) {
    throw ApiError.badRequest(`"${payPeriod}" is not a pay period. Use YYYY-MM.`);
  }
}

export async function listPayrollRuns() {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll', verb: 'view' });
  const rows = await prisma.payrollRun.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { payPeriod: 'desc' },
    take: 36,
  });
  return rows.map((row) => withDecimalMinor(row, PAYROLL_RUN_MONEY));
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
  return {
    ...withDecimalMinor(run, PAYROLL_RUN_MONEY),
    instructions: run.instructions.map((i) => withDecimalMinor(i, PAYROLL_INSTRUCTION_MONEY)),
  };
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
    throw ApiError.conflict(
      `Payroll for ${payPeriod} is already open as ${existing.recordCode} (${existing.status}).`,
      {
        payrollRunId: existing.id,
      },
    );
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

  // Compensation is read before the run opens. The reads go through the scoped
  // client, which refuses to run inside the transaction below.
  const lines: Array<{ employmentRelationshipId: string; gross: number; division: string }> = [];
  for (const employment of employments) {
    const pay = await currentCompensation(employment.id, periodEnd);
    // Somebody with no compensation in force is still listed, at zero, rather
    // than dropped: an employee missing from a run is invisible, and a zero
    // beside their name is not. `detectMissingCompensation` raises it too.
    const gross = num(pay?.amount) ?? 0;
    const division = employment.assignments[0]?.position.orgUnit.division ?? 'shared';
    lines.push({ employmentRelationshipId: employment.id, gross, division });
  }
  const grossTotal = lines.reduce((sum, l) => sum + l.gross, 0);
  const headcount = lines.length;

  return governedWrite(async (tx) => {
    const recordCode = await nextRecordCode('PRN', undefined, tx);
    const run = await tx.payrollRun.create({
      data: { tenantId: auth.tenantId, recordCode, payPeriod, preparedById: auth.partyId },
    });

    for (const line of lines) {
      await tx.payrollInstruction.create({
        data: {
          tenantId: auth.tenantId,
          employmentRelationshipId: line.employmentRelationshipId,
          payrollRunId: run.id,
          payPeriod,
          grossAmountMinor: rupeesToMinor(line.gross),
          netAmountMinor: rupeesToMinor(line.gross),
          division: line.division,
        },
      });
    }

    const updated = await tx.payrollRun.update({
      where: { id: run.id },
      data: { grossTotalMinor: rupeesToMinor(grossTotal), netTotalMinor: rupeesToMinor(grossTotal), headcount },
    });

    await auditWrite({
      action: 'create',
      subjectType: 'payroll_run',
      subjectId: run.id,
      after: { recordCode, payPeriod, headcount, status: 'Draft' },
      tx,
    });

    await emit({
      name: EVENTS.PAYROLL_RUN_CREATED,
      subject: { entityType: 'payroll_run', entityId: run.id, recordCode },
      newState: { payPeriod, headcount, status: 'Draft' },
      confidentiality: 'confidential',
      impact: { domains: ['hr', 'fin'] },
      tx,
    });

    return withDecimalMinor(updated, PAYROLL_RUN_MONEY);
  });
}

/** Records deductions against one instruction, before the run is approved. */
export async function setInstructionAmounts(id: string, input: { grossAmount?: number; deductions?: number }) {
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

  const gross = input.grossAmount ?? minorToRupees(instruction.grossAmountMinor);
  const deductions = input.deductions ?? minorToRupees(instruction.deductionsMinor);

  return governedWrite(async (tx) => {
    const updated = await tx.payrollInstruction.update({
      where: { id },
      data: {
        grossAmountMinor: rupeesToMinor(gross),
        deductionsMinor: rupeesToMinor(deductions),
        netAmountMinor: rupeesToMinor(gross - deductions),
      },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'payroll_instruction',
      subjectId: id,
      before: {
        grossAmount: String(minorToRupees(instruction.grossAmountMinor)),
        deductions: String(minorToRupees(instruction.deductionsMinor)),
      },
      after: { grossAmount: String(gross), deductions: String(deductions) },
      tx,
    });
    await emit({
      name: EVENTS.PAYROLL_INSTRUCTION_UPDATED,
      subject: { entityType: 'payroll_instruction', entityId: id },
      impact: { domains: ['hr'] },
      tx,
    });
    return withDecimalMinor(updated, PAYROLL_INSTRUCTION_MONEY);
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

  if (event === 'COMPUTE') {
    // Statutory lines (workstream E) are filled before the totals are rolled
    // up below. Whoever ran Compute is recorded as the preparer — the last
    // person to touch the figures is who the Self-Dealing Bar bars from
    // approving them.
    await computeInstruction(id);
    await prisma.payrollRun.update({ where: { id }, data: { preparedById: auth.partyId } });
  }

  if (event === 'APPROVE') {
    // Nobody approves the run they prepared, and the statutory lines must be computed (workstream E).
    const instructions = await prisma.payrollInstruction.findMany({ where: { payrollRunId: id } });
    await runHooks('payroll_run.before_approve', { run, instructions, approverPartyId: auth.partyId });
  }

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

  const updated = await prisma.$transaction(async (tx) => {
    // Recompute the totals from the instructions at the moment of computing,
    // so an edited instruction is reflected in the figure that gets approved.
    if (event === 'COMPUTE') {
      const totals = await tx.payrollInstruction.aggregate({
        where: { payrollRunId: id },
        _sum: { grossAmountMinor: true, netAmountMinor: true },
        _count: { _all: true },
      });
      await tx.payrollRun.update({
        where: { id },
        data: {
          grossTotalMinor: totals._sum.grossAmountMinor ?? 0n,
          netTotalMinor: totals._sum.netAmountMinor ?? 0n,
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

  if (event === 'APPROVE') {
    // Issuing payslips (workstream E) reads the company profile and takes a
    // document number per instruction — real work, not a fast row update —
    // so it runs after the state change commits rather than inside the same
    // transaction, where it would risk the interactive-transaction timeout.
    const instructions = await prisma.payrollInstruction.findMany({ where: { payrollRunId: id } });
    await runHooks('payroll_run.approved', { run: updated, instructions });
  }

  return withDecimalMinor(updated, PAYROLL_RUN_MONEY);
}

/** Monthly pay cost by division — what the Command Center cuts revenue against. */
export async function payrollCostByDivision(payPeriod: string) {
  const auth = currentAuth();
  await assertScopeAll('payroll');
  assertPayPeriod(payPeriod);

  const rows = await prisma.payrollInstruction.groupBy({
    by: ['division'],
    where: { tenantId: auth.tenantId, payPeriod },
    _sum: { grossAmountMinor: true, netAmountMinor: true },
    _count: { _all: true },
  });

  return rows.map((row) => ({
    division: row.division ?? 'shared',
    headcount: row._count._all,
    gross: minorToRupees(row._sum.grossAmountMinor ?? 0n),
    net: minorToRupees(row._sum.netAmountMinor ?? 0n),
  }));
}

/** The pay cost trend, for the executive dashboard. */
export async function payrollTrend(months = 12) {
  const auth = currentAuth();
  await assertScopeAll('payroll');

  const runs = await prisma.payrollRun.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { payPeriod: 'desc' },
    take: months,
  });

  return runs
    .map((run) => ({
      payPeriod: run.payPeriod,
      gross: minorToRupees(run.grossTotalMinor),
      net: minorToRupees(run.netTotalMinor),
      headcount: run.headcount,
      status: run.status,
    }))
    .reverse();
}
