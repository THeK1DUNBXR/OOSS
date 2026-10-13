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
import { asUser, unscopedPrisma } from '../helpers.js';
import {
  approveStatutoryRule,
  createStatutoryRule,
  FOUNDER_DUTY,
  STATUTORY_APPROVER_DUTY,
} from '../../domains/statutory.js';
import { PAYROLL_RULE_SEEDS } from '../../seed/compliance/statutory.js';

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

/**
 * Test-only citation, given when a seeded rule is approved. It is not a legal source: the fixture
 * approves rules so the payroll code can run, and it never stands in for the accountant's check.
 */
const FIXTURE_CITATION =
  'TEST FIXTURE: approved so a payroll suite can compute and post. Not a notification reference.';

const DUTY_EPOCH = new Date('2000-01-01T00:00:00.000Z');

/**
 * The payroll suites run pay months from 2015, and the seeded rules take effect on 2024-04-01. Before
 * FX-73 each rate was a constant that applied on every date, so these suites were written against one
 * figure throughout. The fixture therefore approves the same values for a bounded history, from
 * 2000-01-01 up to the seeded row's own date. The history row ends where the seeded row begins, so it
 * never overlaps it, and the two can be approved in either order.
 */
const HISTORY_FROM = new Date('2000-01-01T00:00:00.000Z');

/**
 * Makes one rule APPROVED for a tenant, through the domain path: createStatutoryRule as the approver,
 * then approveStatutoryRule as the approver (the founder, who may approve his own rule, audited as
 * author_is_approver). Idempotent: an APPROVED row with the same series and dates is left as it is.
 */
async function approveFixtureRule(
  tenantId: string,
  approverEmail: string,
  seed: (typeof PAYROLL_RULE_SEEDS)[number],
  effectiveFrom: Date,
  effectiveTo: Date | null,
): Promise<void> {
  const approved = await unscopedPrisma.statutoryRule.findFirst({
    where: {
      tenantId,
      domain: seed.domain,
      key: seed.key,
      jurisdiction: seed.jurisdiction,
      status: 'APPROVED',
      effectiveFrom,
      effectiveTo,
    },
  });
  if (approved) return;
  const draft = await asUser(approverEmail, () =>
    createStatutoryRule({
      domain: seed.domain,
      key: seed.key,
      jurisdiction: seed.jurisdiction,
      effectiveFrom,
      effectiveTo,
      value: seed.value,
      source: seed.source,
    }),
  );
  await asUser(approverEmail, () => approveStatutoryRule(draft.id, { source: FIXTURE_CITATION }));
}

/**
 * Makes the payroll statutory rules APPROVED for a tenant, through the domain path (approveFixtureRule).
 *
 * The seed rows stay DRAFT. The G10 check counts every seed-marked row and needs none APPROVED, so the
 * fixture creates its own rows from the same values (PAYROLL_RULE_SEEDS) and approves those.
 *
 * A tenant with no open founder or statutory approver gets the approver written into both duties, as
 * setup, because the domain refuses to name a person to a duty they would then exercise. A tenant that
 * already has a holder keeps it. Idempotent: a series already APPROVED is left as it is.
 */
export async function approvePayrollRules(tenantId: string, approverEmail: string): Promise<void> {
  const approverId = await asUser(approverEmail, async (p) => p.partyId);
  for (const dutyKey of [FOUNDER_DUTY, STATUTORY_APPROVER_DUTY]) {
    const open = await unscopedPrisma.dutyAssignment.findFirst({ where: { tenantId, dutyKey, effectiveTo: null } });
    if (!open) {
      await unscopedPrisma.dutyAssignment.create({
        data: { tenantId, dutyKey, partyId: approverId, effectiveFrom: DUTY_EPOCH, assignedBy: approverId },
      });
    }
  }
  for (const seed of PAYROLL_RULE_SEEDS) {
    await approveFixtureRule(tenantId, approverEmail, seed, HISTORY_FROM, seed.effectiveFrom);
    await approveFixtureRule(tenantId, approverEmail, seed, seed.effectiveFrom, null);
  }
}

const STATUTE_RULE_KEY: Record<string, string> = {
  EPF: 'pf.rates',
  ESI: 'esi.rates',
  PT: 'pt.tn_slabs',
  LWF: 'lwf.tn_contribution',
};

const STATUTORY_COMPONENTS: Array<[statute: string, component: string]> = [
  ['EPF', 'PF_EMPLOYEE'],
  ['EPF', 'PF_EMPLOYER'],
  ['EPF', 'EPS_EMPLOYER'],
  ['EPF', 'EDLI_EMPLOYER'],
  ['EPF', 'ADMIN_EMPLOYER'],
  ['ESI', 'ESI_EMPLOYEE'],
  ['ESI', 'ESI_EMPLOYER'],
  ['PT', 'PT_EMPLOYEE'],
  ['LWF', 'LWF_EMPLOYEE'],
  ['LWF', 'LWF_EMPLOYER'],
];

/**
 * The statutory lines computeInstruction writes for one employee, for an instruction a test builds
 * by hand: every component, zero where the test sets no amount, each naming the APPROVED rule it
 * came from. Posting reads these, so a hand-built run needs them as a computed run does.
 */
export async function recordStatutoryLines(args: {
  tenantId: string;
  payrollRunId: string;
  payPeriod: string;
  employmentId: string;
  amounts: Partial<Record<string, bigint>>;
}): Promise<void> {
  const ruleIdByStatute: Record<string, string> = {};
  for (const [statute, key] of Object.entries(STATUTE_RULE_KEY)) {
    const rule = await unscopedPrisma.statutoryRule.findFirst({
      where: { tenantId: args.tenantId, key, status: 'APPROVED', effectiveTo: null },
    });
    if (!rule)
      throw new Error(`recordStatutoryLines: ${key} is not APPROVED for this tenant. Call approvePayrollRules first.`);
    ruleIdByStatute[statute] = rule.id;
  }
  await unscopedPrisma.payrollStatutoryLine.createMany({
    data: STATUTORY_COMPONENTS.map(([statute, component]) => ({
      tenantId: args.tenantId,
      payrollRunId: args.payrollRunId,
      employmentRelationshipId: args.employmentId,
      payPeriod: args.payPeriod,
      statute,
      contributionKind: 'statutory',
      component,
      amountMinor: args.amounts[component] ?? 0n,
      ruleId: ruleIdByStatute[statute]!,
    })),
  });
}

export async function readyPayrollPosting(
  tenantId: string,
  opts: { months: readonly string[]; divisions: readonly string[]; approverEmail: string },
): Promise<void> {
  await approvePayrollRules(tenantId, opts.approverEmail);
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
