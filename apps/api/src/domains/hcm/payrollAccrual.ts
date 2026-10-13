/**
 * HCM — payroll accrual (FX-73). A run's liabilities reach the ledger as one
 * balanced entry per ledger entity: salary and employer-contribution expense per
 * business line, then each payable once. Net pay, PF, ESI, PT, LWF and TDS are the
 * amounts the instructions already store; nothing is recomputed here.
 *
 * Called from both payroll posting routes (postPayrollJournal and postPayrollToBooks),
 * inside the transaction that takes the run's lock for posting. Whichever route runs
 * first posts the accrual; the other is refused by that lock, so a run never reaches
 * the cash leg without its liabilities, and never gets two accruals.
 *
 * The run's statutory lines name the rules they were computed from. Before anything is
 * written, each of those rules must still be APPROVED and in force on the pay month, so a
 * rule revoked or superseded since computing refuses the posting rather than booking it.
 *
 * Every refusal happens before a row is written, and names what is missing. A
 * division is never defaulted to a business line, and an employee is never given
 * a ledger entity. Those are finance's decisions, made in the mapping tables.
 */
import {
  buildPayrollAccrualEntry,
  istCivilDay,
  istDateKey,
  istMidnight,
  payrollAccrualRoles,
  postingKeys,
  PostingRuleError,
  type PayrollAccrualLine,
  type PayrollAccrualSource,
} from '@kaizen/shared';
import type { DbTx } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { postInTx } from '../../platform/ledger.js';
import { resolvePostingAccounts } from '../../platform/postingRoles.js';
import { ApiError } from '../../platform/errors.js';

/**
 * The entry date for a pay month: the last IST day of it, as the UTC midnight the
 * journal stores. A run approved or disbursed in the next month still books to the
 * month it pays for, so it lands in that period and not in the clock's.
 */
export function payMonthEnd(payPeriod: string): Date {
  const [year, month] = payPeriod.split('-').map(Number);
  return istCivilDay(new Date(istMidnight(year!, month! + 1, 1).getTime() - 1));
}

/**
 * Posts the run's accrual, one entry per ledger entity, inside `tx`. The caller holds
 * the run's lock for posting. Returns the entry ids in entity order.
 */
export async function accrueRunLiabilities(tx: DbTx, run: { id: string; payPeriod: string }): Promise<string[]> {
  const auth = currentAuth();
  const entryDate = payMonthEnd(run.payPeriod);

  const instructions = await tx.payrollInstruction.findMany({
    where: { tenantId: auth.tenantId, payrollRunId: run.id },
    select: {
      division: true,
      employmentRelationshipId: true,
      grossAmountMinor: true,
      netAmountMinor: true,
      pfEmployeeMinor: true,
      pfEmployerMinor: true,
      epsEmployerMinor: true,
      esiEmployeeMinor: true,
      esiEmployerMinor: true,
      professionalTaxMinor: true,
      lwfEmployeeMinor: true,
      lwfEmployerMinor: true,
      tdsAmountMinor: true,
      employmentRelationship: { select: { ledgerEntityId: true } },
    },
  });
  if (instructions.length === 0) return [];

  // The statutory rules the run was computed from must still be APPROVED, and in force on the entry
  // date, when the liabilities post. A rule revoked or superseded after computing refuses the posting:
  // the books must not hold a liability that nobody approves any more. Every line records its ruleId
  // (computeInstruction), so this reads what the run used, not what is current.
  const statutoryLines = await tx.payrollStatutoryLine.findMany({
    where: { tenantId: auth.tenantId, payrollRunId: run.id },
    select: { employmentRelationshipId: true, component: true, amountMinor: true, ruleId: true },
  });
  const statutoryDue = instructions.some(
    (i) =>
      i.pfEmployeeMinor +
        i.pfEmployerMinor +
        i.epsEmployerMinor +
        i.esiEmployeeMinor +
        i.esiEmployerMinor +
        i.professionalTaxMinor +
        i.lwfEmployeeMinor +
        i.lwfEmployerMinor +
        i.tdsAmountMinor !==
      0n,
  );
  if (statutoryDue && statutoryLines.length === 0) {
    throw ApiError.unprocessable(
      `The ${run.payPeriod} run has statutory amounts but no statutory lines recorded against an approved rule, so it was not computed by the statutory rules. Compute the run again, then post. Nothing was posted.`,
      { reasonCode: 'statutory_lines_missing' },
    );
  }
  if (statutoryLines.some((l) => l.ruleId === null)) {
    throw ApiError.unprocessable(
      `A statutory line on the ${run.payPeriod} run names no rule, so its figure cannot be shown to come from an approved rule. Compute the run again, then post. Nothing was posted.`,
      { reasonCode: 'statutory_line_without_rule' },
    );
  }
  const ruleIds = [...new Set(statutoryLines.map((l) => l.ruleId!))];
  const rules = await tx.statutoryRule.findMany({
    where: { tenantId: auth.tenantId, id: { in: ruleIds } },
  });
  for (const ruleId of ruleIds) {
    const rule = rules.find((r) => r.id === ruleId);
    const inForce =
      rule !== undefined &&
      rule.effectiveFrom <= entryDate &&
      (rule.effectiveTo === null || rule.effectiveTo > entryDate);
    if (!rule || rule.status !== 'APPROVED' || !inForce) {
      const named = rule ? `${rule.key} (${rule.jurisdiction})` : ruleId;
      const why = !rule
        ? 'no longer exists'
        : rule.status !== 'APPROVED'
          ? `is ${rule.status}, not APPROVED`
          : `is not in force on ${istDateKey(entryDate)}`;
      throw ApiError.unprocessable(
        `Statutory rule ${named} that the ${run.payPeriod} run was computed from ${why}. Nothing was posted: approve the rule that covers the pay month, then compute and post the run again.`,
        {
          reasonCode: 'statutory_rule_not_approved',
          key: rule?.key ?? null,
          jurisdiction: rule?.jurisdiction ?? null,
          ruleId,
        },
      );
    }
  }

  // EDLI and the PF admin charge, per employment. They are employer costs: each one is added to the
  // employer contributions expense and to the PF payable, and they are not in gross or net.
  const chargesByEmployment = new Map<string, { edliMinor: bigint; adminMinor: bigint }>();
  for (const line of statutoryLines) {
    if (line.component !== 'EDLI_EMPLOYER' && line.component !== 'ADMIN_EMPLOYER') continue;
    const charges = chargesByEmployment.get(line.employmentRelationshipId) ?? { edliMinor: 0n, adminMinor: 0n };
    if (line.component === 'EDLI_EMPLOYER') charges.edliMinor += line.amountMinor;
    else charges.adminMinor += line.amountMinor;
    chargesByEmployment.set(line.employmentRelationshipId, charges);
  }

  const unmapped = instructions.filter((i) => !i.employmentRelationship.ledgerEntityId).length;
  if (unmapped > 0) {
    throw ApiError.unprocessable(
      `${unmapped} employee${unmapped === 1 ? '' : 's'} on the ${run.payPeriod} run ${unmapped === 1 ? 'has' : 'have'} no ledger entity, so the run cannot be booked. Map ${unmapped === 1 ? 'it' : 'them'} to a ledger entity, then post again. Nothing was posted.`,
    );
  }

  // A division is mapped on the entry date. The null division is the 'shared' line.
  const divisions = [...new Set(instructions.map((i) => i.division ?? 'shared'))];
  const mappings = await tx.payrollDivisionLine.findMany({
    where: {
      tenantId: auth.tenantId,
      division: { in: divisions },
      effectiveFrom: { lte: entryDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: entryDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    select: { division: true, lineId: true },
  });
  const lineByDivision = new Map<string, string>();
  for (const m of mappings) if (!lineByDivision.has(m.division)) lineByDivision.set(m.division, m.lineId);
  for (const division of divisions) {
    if (!lineByDivision.has(division)) {
      throw ApiError.unprocessable(
        `Division "${division}" has no business line on ${istDateKey(entryDate)} (the ${run.payPeriod} pay month). Map it under payroll division lines, then post again. Nothing was posted.`,
      );
    }
  }

  // Per instruction: gross less net is the employee-side deductions. Anything else
  // is a residual, and it is named, not plugged into a line.
  let residualCount = 0;
  let residualTotal = 0n;
  for (const i of instructions) {
    const residual =
      i.grossAmountMinor -
      i.netAmountMinor -
      (i.pfEmployeeMinor + i.esiEmployeeMinor + i.professionalTaxMinor + i.lwfEmployeeMinor + i.tdsAmountMinor);
    if (residual !== 0n) {
      residualCount += 1;
      residualTotal += residual;
    }
  }
  if (residualCount > 0) {
    throw ApiError.unprocessable(
      `${residualCount} instruction${residualCount === 1 ? '' : 's'} on the ${run.payPeriod} run ${residualCount === 1 ? 'does' : 'do'} not reconcile: gross less net differs from the deductions by ${residualTotal} paise in total. Nothing was posted.`,
    );
  }

  // Group by ledger entity. Each group becomes one entry.
  const groups = new Map<
    string,
    {
      byLine: Map<string, PayrollAccrualLine>;
      netPayMinor: bigint;
      pfPayableMinor: bigint;
      esiPayableMinor: bigint;
      ptMinor: bigint;
      lwfPayableMinor: bigint;
      tdsMinor: bigint;
    }
  >();
  for (const i of instructions) {
    const entityId = i.employmentRelationship.ledgerEntityId!;
    const lineId = lineByDivision.get(i.division ?? 'shared')!;
    const charges = chargesByEmployment.get(i.employmentRelationshipId) ?? { edliMinor: 0n, adminMinor: 0n };
    const employerChargesMinor = charges.edliMinor + charges.adminMinor;
    const g = groups.get(entityId) ?? {
      byLine: new Map(),
      netPayMinor: 0n,
      pfPayableMinor: 0n,
      esiPayableMinor: 0n,
      ptMinor: 0n,
      lwfPayableMinor: 0n,
      tdsMinor: 0n,
    };
    groups.set(entityId, g);
    const share = g.byLine.get(lineId) ?? { lineId, grossMinor: 0n, employerMinor: 0n };
    g.byLine.set(lineId, share);
    share.grossMinor += i.grossAmountMinor;
    share.employerMinor +=
      i.pfEmployerMinor + i.epsEmployerMinor + i.esiEmployerMinor + i.lwfEmployerMinor + employerChargesMinor;
    g.netPayMinor += i.netAmountMinor;
    g.pfPayableMinor += i.pfEmployeeMinor + i.pfEmployerMinor + i.epsEmployerMinor + employerChargesMinor;
    g.esiPayableMinor += i.esiEmployeeMinor + i.esiEmployerMinor;
    g.ptMinor += i.professionalTaxMinor;
    g.lwfPayableMinor += i.lwfEmployeeMinor + i.lwfEmployerMinor;
    g.tdsMinor += i.tdsAmountMinor;
  }

  const entityIds = [...groups.keys()].sort();
  const posted: string[] = [];
  for (const entityId of entityIds) {
    const g = groups.get(entityId)!;
    const source: PayrollAccrualSource = {
      byLine: [...g.byLine.values()],
      netPayMinor: g.netPayMinor,
      pfPayableMinor: g.pfPayableMinor,
      esiPayableMinor: g.esiPayableMinor,
      ptMinor: g.ptMinor,
      lwfPayableMinor: g.lwfPayableMinor,
      tdsMinor: g.tdsMinor,
    };

    // Only the roles this entity's non-zero lines use are resolved. A missing one
    // refuses the whole entry, never a partial one.
    const accounts = await resolvePostingAccounts(
      tx,
      payrollAccrualRoles(source).map((role) => ({ role })),
      entryDate,
    );
    let lines;
    try {
      lines = buildPayrollAccrualEntry(source, accounts);
    } catch (err) {
      if (err instanceof PostingRuleError) throw ApiError.unprocessable(`${err.message} Nothing was posted.`);
      throw err;
    }

    const entry = await postInTx(tx, {
      entityId,
      entryDate,
      narration: `Payroll ${run.payPeriod} — liabilities`,
      sourceType: 'payroll_run',
      sourceId: run.id,
      idempotencyKey: postingKeys.payrollRunAccrual(run.id, entityId),
      lines,
    });
    posted.push(entry.id);
  }
  return posted;
}
