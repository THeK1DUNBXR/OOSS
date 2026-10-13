/**
 * HCM — payroll division lines (FX-73). Finance's map from a payroll division to
 * the business line its pay cost is booked under. A run posts its accrual through
 * this map, and a division with no mapping on the pay month refuses the posting
 * (payrollAccrual.ts). Nothing defaults a division to a line.
 *
 * Insert-only in the database: a change is a new row from a later date, and an
 * end is one update that sets effectiveTo on an open row (the migration's guard).
 */
import { EVENTS, istDateKey } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { governedWrite } from '../../platform/governedWrite.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';

registerGovernedEntities('hcm_payroll', ['payroll_division_line']);

/** A civil day as UTC midnight, from a YYYY-MM-DD key. Refuses a day that does not exist. */
function dayOf(key: string): Date {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(key) ? new Date(`${key}T00:00:00.000Z`) : null;
  if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== key) {
    throw ApiError.badRequest(`"${key}" is not a calendar day (YYYY-MM-DD).`);
  }
  return day;
}

export async function listPayrollDivisionLines() {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'view' });
  return prisma.payrollDivisionLine.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: [{ division: 'asc' }, { effectiveFrom: 'desc' }],
  });
}

export interface PayrollDivisionLineInput {
  /** The instruction's division, or 'shared' for an instruction with none. */
  division: string;
  lineId: string;
  /** The first IST day the mapping applies, YYYY-MM-DD. */
  effectiveFrom: string;
}

/**
 * Maps a division to a business line from `effectiveFrom`. The open mapping it
 * replaces, if there is one, is ended on the same day in the same write, so a
 * division never has two open mappings.
 */
export async function setPayrollDivisionLine(input: PayrollDivisionLineInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'create' });
  const division = input.division.trim();
  if (!division) throw ApiError.badRequest('A division is required. "shared" names the instructions with none.');
  const effectiveFrom = dayOf(input.effectiveFrom);
  if (!auth.partyId)
    throw ApiError.forbidden('A payroll division line is recorded against a person, and this session has none.');
  const createdById = auth.partyId;

  return governedWrite(async (tx) => {
    const line = await tx.businessLine.findFirst({
      where: { tenantId: auth.tenantId, id: input.lineId },
      select: { id: true },
    });
    if (!line) throw ApiError.unprocessable('That business line is not in the tenant registry.');

    const open = await tx.payrollDivisionLine.findFirst({
      where: { tenantId: auth.tenantId, division, effectiveTo: null },
    });
    if (open && open.effectiveFrom >= effectiveFrom) {
      throw ApiError.unprocessable(
        `${division} already has a mapping from ${istDateKey(open.effectiveFrom)}. A new mapping must start after it.`,
      );
    }
    const superseded = open
      ? await tx.payrollDivisionLine.update({ where: { id: open.id }, data: { effectiveTo: effectiveFrom } })
      : null;

    const row = await tx.payrollDivisionLine.create({
      data: { tenantId: auth.tenantId, division, lineId: input.lineId, effectiveFrom, createdById },
    });
    await auditWrite({
      action: 'create',
      subjectType: 'payroll_division_line',
      subjectId: row.id,
      after: row as never,
      tx,
    });
    if (superseded) {
      await auditWrite({
        action: 'update',
        subjectType: 'payroll_division_line',
        subjectId: superseded.id,
        before: open as never,
        after: superseded as never,
        tx,
      });
    }
    await emit({
      name: EVENTS.PAYROLL_DIVISION_LINE_MAPPED,
      subject: { entityType: 'payroll_division_line', entityId: row.id },
      newState: { division, lineId: input.lineId, effectiveFrom: input.effectiveFrom },
      confidentiality: 'confidential',
      impact: { domains: ['hr', 'fin'] },
      tx,
    });
    return row;
  });
}

/** Ends an open mapping: from `effectiveTo` (exclusive) the division has no line until a new mapping is set. */
export async function endPayrollDivisionLine(id: string, effectiveTo: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'transactions', verb: 'edit' });
  const end = dayOf(effectiveTo);

  return governedWrite(async (tx) => {
    const before = await tx.payrollDivisionLine.findFirst({ where: { tenantId: auth.tenantId, id } });
    if (!before) throw ApiError.notFound('Payroll division line');
    if (before.effectiveTo) throw ApiError.conflict('This mapping has already ended.');
    if (end <= before.effectiveFrom) {
      throw ApiError.unprocessable('A mapping ends after the day it starts. Nothing was changed.');
    }
    const row = await tx.payrollDivisionLine.update({ where: { id }, data: { effectiveTo: end } });
    await auditWrite({
      action: 'update',
      subjectType: 'payroll_division_line',
      subjectId: id,
      before: before as never,
      after: row as never,
      tx,
    });
    await emit({
      name: EVENTS.PAYROLL_DIVISION_LINE_ENDED,
      subject: { entityType: 'payroll_division_line', entityId: id },
      newState: { division: row.division, effectiveTo: effectiveTo },
      confidentiality: 'confidential',
      impact: { domains: ['hr', 'fin'] },
      tx,
    });
    return row;
  });
}
