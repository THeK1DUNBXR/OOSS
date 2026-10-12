/**
 * Makes a shared test tenant able to post a payroll run's accrual (FX-73). The
 * payroll posting suites were written before a run's liabilities reached the
 * ledger, and they post into the demo tenant, which has none of what the accrual
 * needs: posting roles for the payroll accounts, an open accounting period for each
 * pay month, a business line for each division, and a ledger entity for each
 * employee. A run with any of those missing refuses, as it should in production.
 *
 * Each row is created only when it is missing, so the call can be repeated. Real
 * Postgres through unscopedPrisma, no mocks; this writes setup rows, never journal rows.
 */
import { randomUUID } from 'node:crypto';
import { unscopedPrisma } from '../helpers.js';

const PAYROLL_ROLE_CLASS: Record<string, 'expense' | 'liability'> = {
  PAYROLL_SALARY_EXPENSE: 'expense',
  PAYROLL_EMPLOYER_CONTRIB_EXPENSE: 'expense',
  PAYROLL_NET_PAY_PAYABLE: 'liability',
  PAYROLL_PF_PAYABLE: 'liability',
  PAYROLL_ESI_PAYABLE: 'liability',
  PAYROLL_PT_PAYABLE: 'liability',
  PAYROLL_TDS_PAYABLE: 'liability',
  PAYROLL_LWF_PAYABLE: 'liability',
};

const FROM = new Date('2000-01-01T00:00:00.000Z');

/** The Indian financial year that holds an IST month: April to March. */
function fyOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const start = m! >= 4 ? y! : y! - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function monthBounds(month: string) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return {
    startsOn: new Date(`${month}-01T00:00:00.000Z`),
    endsOn: new Date(`${month}-${String(last).padStart(2, '0')}T00:00:00.000Z`),
  };
}

export async function readyPayrollPosting(
  tenantId: string,
  opts: { months: readonly string[]; divisions: readonly string[] },
): Promise<void> {
  // The ledger entity every employee is booked to. A tenant has one in the demo seed.
  let entity = await unscopedPrisma.ledgerEntity.findFirst({ where: { tenantId }, orderBy: { code: 'asc' } });
  entity ??= await unscopedPrisma.ledgerEntity.create({
    data: { tenantId, code: 'FX73', legalName: 'FX-73 fixture entity', stateCode: '27' },
  });
  await unscopedPrisma.employmentRelationship.updateMany({
    where: { tenantId, ledgerEntityId: null },
    data: { ledgerEntityId: entity.id },
  });

  for (const role of Object.keys(PAYROLL_ROLE_CLASS)) {
    const name = `FX73 TEST ONLY ${role}`;
    const account =
      (await unscopedPrisma.ledgerAccount.findFirst({ where: { tenantId, name } })) ??
      (await unscopedPrisma.ledgerAccount.create({
        data: { tenantId, name, accountClass: PAYROLL_ROLE_CLASS[role]! },
      }));
    const mapped = await unscopedPrisma.ledgerPostingRole.findFirst({ where: { tenantId, role, scopeKey: '' } });
    if (!mapped) {
      await unscopedPrisma.ledgerPostingRole.create({
        data: { tenantId, role, scopeKey: '', ledgerAccountId: account.id, effectiveFrom: FROM, setById: randomUUID() },
      });
    }
  }

  const line =
    (await unscopedPrisma.businessLine.findFirst({ where: { tenantId, code: 'FX73' } })) ??
    (await unscopedPrisma.businessLine.create({
      data: {
        tenantId,
        code: 'FX73',
        name: 'FX-73 fixture line',
        payerKind: 'corporate',
        revenueModel: 'licence',
        effectiveFrom: FROM,
      },
    }));
  for (const division of opts.divisions) {
    const open = await unscopedPrisma.payrollDivisionLine.findFirst({
      where: { tenantId, division, effectiveTo: null },
    });
    if (!open) {
      await unscopedPrisma.payrollDivisionLine.create({
        data: { tenantId, division, lineId: line.id, effectiveFrom: FROM, createdById: randomUUID() },
      });
    }
  }

  for (const month of opts.months) {
    const exists = await unscopedPrisma.accountingPeriod.findFirst({ where: { tenantId, period: month } });
    if (!exists) {
      await unscopedPrisma.accountingPeriod.create({
        data: { tenantId, entityId: entity.id, period: month, fy: fyOf(month), status: 'open', ...monthBounds(month) },
      });
    }
  }
}
