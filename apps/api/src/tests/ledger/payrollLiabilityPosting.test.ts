/**
 * FX-73 liabilities against the statutory rules (S10). A run's PF, ESI, PT, LWF and the PF
 * charges are computed from APPROVED rules; each statutory line names the rule it came from;
 * and posting refuses a rule that is no longer APPROVED and in force on the pay month, so a
 * half-posted or unapproved payroll never reaches the books.
 *
 * Real Postgres, real contexts, no mocks. Each test is a tenant of its own (booksTenant), so
 * no other suite's rules, runs or entries are in its balances.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { unscopedPrisma } from '../../platform/db.js';
import { asSystem } from '../../platform/context.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { asUser, booksTenant, expectReject, type BooksTenant } from '../helpers.js';
import { readyPayrollPosting } from '../hcm/payrollLedgerFixture.js';
import { postPayrollToBooks } from '../../domains/books.js';
import { computeInstruction } from '../../domains/compliance/payroll.js';
import { approveStatutoryRule, createStatutoryRule, holdStatutoryRule } from '../../domains/statutory.js';
import { PAYROLL_RULE_SEEDS, seedStatutory } from '../../seed/compliance/statutory.js';

const RUN = randomUUID().slice(0, 8);
const ALL_TIME = new Date('9999-12-31T00:00:00.000Z');
const MONTH = '2041-03';
const MONTHS = ['2041-03', '2041-04'];
const SUPERSEDING_CITATION =
  'TEST FIXTURE: a superseding rule for the supersession test. Not a notification reference.';

/** The rule key each statute's lines name. Matches STATUTE_RULE_KEY in the fixture and PAYROLL_RULE_SEEDS. */
const KEY_OF_STATUTE: Record<string, string> = {
  EPF: 'pf.rates',
  ESI: 'esi.rates',
  PT: 'pt.tn_slabs',
  LWF: 'lwf.tn_contribution',
};

interface Tenant {
  t: BooksTenant;
  email: string;
}

/** A tenant with the payroll posting setup and its statutory rules approved, by the chairman (the founder here). */
async function postingTenant(slug: string): Promise<Tenant> {
  const t = await booksTenant(slug);
  const email = `chairman@${slug}.books.test`;
  await readyPayrollPosting(t.tenantId, { months: MONTHS, divisions: ['software'], approverEmail: email });
  return { t, email };
}

/** An employee in the tenant's ledger entity, with an approved salary structure of `basicMinor` paise of basic. */
async function employeeOn(tn: Tenant, basicMinor: bigint): Promise<string> {
  const tid = tn.t.tenantId;
  const stamp = randomUUID().slice(0, 8);
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-${stamp}`,
      fullName: `FX73 liability ${stamp}`,
      primaryEmail: `fx73.${stamp}@example.com`,
      source: 'test',
    },
  });
  const employment = await unscopedPrisma.employmentRelationship.create({
    data: {
      tenantId: tid,
      recordCode: `EMP-${stamp}`,
      personId: person.id,
      hireEffectiveDate: new Date('2020-01-01T00:00:00.000Z'),
      status: 'Active',
      ledgerEntityId: tn.t.entityId,
    },
  });
  await unscopedPrisma.salaryStructure.create({
    data: {
      tenantId: tid,
      employmentRelationshipId: employment.id,
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      status: 'Approved',
      ctcAnnualMinor: basicMinor * 12n,
      basicMinor,
      hraMinor: 0n,
    },
  });
  return employment.id;
}

/** A run for MONTH with one instruction per employment, in the software division, not yet computed. */
async function uncomputedRun(tn: Tenant, employmentIds: string[], payPeriod = MONTH) {
  const tid = tn.t.tenantId;
  const run = await unscopedPrisma.payrollRun.create({
    data: {
      tenantId: tid,
      recordCode: `PRN-${payPeriod}-${randomUUID().slice(0, 6)}`,
      payPeriod,
      status: 'Approved',
      headcount: employmentIds.length,
      grossTotalMinor: 0n,
      netTotalMinor: 0n,
    },
  });
  for (const employmentRelationshipId of employmentIds) {
    await unscopedPrisma.payrollInstruction.create({
      data: {
        tenantId: tid,
        employmentRelationshipId,
        payrollRunId: run.id,
        payPeriod,
        division: 'software',
        status: 'Approved',
        grossAmountMinor: 0n,
        netAmountMinor: 0n,
      },
    });
  }
  return run;
}

/** Marks a computed run disbursed in its pay month, so the books post path accepts it. */
async function markDisbursed(runId: string, payPeriod: string) {
  await unscopedPrisma.payrollRun.update({
    where: { id: runId },
    data: { status: 'Disbursed', disbursedAt: new Date(`${payPeriod}-28T10:00:00.000Z`) },
  });
}

async function approvedRuleId(tid: string, key: string): Promise<string> {
  const rule = await unscopedPrisma.statutoryRule.findFirstOrThrow({
    where: { tenantId: tid, key, status: 'APPROVED', effectiveTo: null },
  });
  return rule.id;
}

async function accountIdFor(tid: string, role: string): Promise<string> {
  const account = await unscopedPrisma.ledgerAccount.findFirstOrThrow({
    where: { tenantId: tid, name: `FX73 TEST ONLY ${role}` },
  });
  return account.id;
}

describe('FX-73 liabilities: computing a run needs approved statutory rules', () => {
  it('computing with a DRAFT rule refuses with 422 naming the rule, and writes no statutory line', async () => {
    // A tenant with only the seeded pack: every payroll rule is DRAFT, none APPROVED.
    const t = await booksTenant(`pay-fx73-draft-${RUN}`);
    await asSystem(t.tenantId, () => seedStatutory());
    const email = `chairman@pay-fx73-draft-${RUN}.books.test`;
    const employment = await employeeOn({ t, email }, 2_000_000n);
    const run = await uncomputedRun({ t, email }, [employment]);

    const err = await expectReject(() => asUser(email, () => computeInstruction(run.id)));
    expect(err.status).toBe(422);
    expect(err.message).toContain('pf.rates');

    expect(
      await unscopedPrisma.payrollStatutoryLine.count({ where: { tenantId: t.tenantId, payrollRunId: run.id } }),
    ).toBe(0);
    const instruction = await unscopedPrisma.payrollInstruction.findFirstOrThrow({ where: { payrollRunId: run.id } });
    expect(instruction.computedFrom).toBeNull();
  });
});

describe('FX-73 liabilities: posting re-checks the rules the run was computed from', () => {
  it('posting after a rule is held refuses with 422, and posts no entry and no cash', async () => {
    const tn = await postingTenant(`pay-fx73-held-${RUN}`);
    const { t, email } = tn;
    const employment = await employeeOn(tn, 2_000_000n);
    const run = await uncomputedRun(tn, [employment]);
    await asUser(email, () => computeInstruction(run.id));
    await markDisbursed(run.id, MONTH);

    const pfRuleId = await approvedRuleId(t.tenantId, 'pf.rates');
    await asUser(email, () => holdStatutoryRule(pfRuleId));

    const err = await expectReject(() => asUser(email, () => postPayrollToBooks(run.id, t.bankAccountId)));
    expect(err.status).toBe(422);
    expect(err.message).toContain('pf.rates');
    expect(err.message).toContain('HOLD');
    expect(
      await unscopedPrisma.journalEntry.count({
        where: { tenantId: t.tenantId, sourceType: 'payroll_run', sourceId: run.id },
      }),
    ).toBe(0);
    expect(await unscopedPrisma.transaction.count({ where: { tenantId: t.tenantId, payrollRunId: run.id } })).toBe(0);
  });

  it('posting after a rule is superseded from inside the pay month refuses with 422, and posts no entry', async () => {
    const tn = await postingTenant(`pay-fx73-super-${RUN}`);
    const { t, email } = tn;
    const employment = await employeeOn(tn, 2_000_000n);
    const run = await uncomputedRun(tn, [employment]);
    await asUser(email, () => computeInstruction(run.id));
    await markDisbursed(run.id, MONTH);

    // A new open-ended rule from the first of the pay month ends the one the run used on that day.
    const pfSeed = PAYROLL_RULE_SEEDS.find((s) => s.key === 'pf.rates')!;
    const successor = await asUser(email, () =>
      createStatutoryRule({
        domain: pfSeed.domain,
        key: pfSeed.key,
        jurisdiction: pfSeed.jurisdiction,
        effectiveFrom: new Date(`${MONTH}-01T00:00:00.000Z`),
        value: pfSeed.value as Prisma.InputJsonValue,
        source: SUPERSEDING_CITATION,
      }),
    );
    await asUser(email, () => approveStatutoryRule(successor.id));

    const err = await expectReject(() => asUser(email, () => postPayrollToBooks(run.id, t.bankAccountId)));
    expect(err.status).toBe(422);
    expect(err.message).toContain('pf.rates');
    expect(err.message).toContain(`${MONTH}-31`);
    expect(
      await unscopedPrisma.journalEntry.count({
        where: { tenantId: t.tenantId, sourceType: 'payroll_run', sourceId: run.id },
      }),
    ).toBe(0);
  });
});

describe('FX-73 liabilities: EDLI and the PF admin charge', () => {
  it('stores each on the EPS wage with the rule it came from, posts them, and the trial balance holds', async () => {
    const tn = await postingTenant(`pay-fx73-edli-${RUN}`);
    const { t, email } = tn;
    // Basic 20,000 is above the 15,000 PF ceiling, so its EPS wage is 15,000; basic 10,000 is below it.
    const capped = await employeeOn(tn, 2_000_000n);
    const uncapped = await employeeOn(tn, 1_000_000n);
    const run = await uncomputedRun(tn, [capped, uncapped]);
    await asUser(email, () => computeInstruction(run.id));

    const lines = await unscopedPrisma.payrollStatutoryLine.findMany({
      where: { tenantId: t.tenantId, payrollRunId: run.id },
    });
    // Ten components per employee, each naming an APPROVED rule of its statute.
    expect(lines).toHaveLength(20);
    for (const line of lines) {
      expect(line.ruleId).toBe(await approvedRuleId(t.tenantId, KEY_OF_STATUTE[line.statute]!));
    }

    // 0.5% of 15,000 is 75.00 (7,500 paise); 0.5% of 10,000 is 50.00 (5,000 paise).
    const edliOf = (employmentId: string, component: string) =>
      lines.find((l) => l.employmentRelationshipId === employmentId && l.component === component)!.amountMinor;
    expect(edliOf(capped, 'EDLI_EMPLOYER')).toBe(7_500n);
    expect(edliOf(capped, 'ADMIN_EMPLOYER')).toBe(7_500n);
    expect(edliOf(uncapped, 'EDLI_EMPLOYER')).toBe(5_000n);
    expect(edliOf(uncapped, 'ADMIN_EMPLOYER')).toBe(5_000n);

    await markDisbursed(run.id, MONTH);
    await asUser(email, () => postPayrollToBooks(run.id, t.bankAccountId));

    const instructions = await unscopedPrisma.payrollInstruction.findMany({ where: { payrollRunId: run.id } });
    const entries = await unscopedPrisma.journalEntry.findMany({
      where: { tenantId: t.tenantId, sourceType: 'payroll_run', sourceId: run.id },
      include: { lines: true },
    });
    expect(entries).toHaveLength(1);
    const allLines = entries[0]!.lines;

    // The PF payable carries the employee and employer PF and EPS, plus EDLI and the admin charge (25,000 paise).
    const pfPayable = await accountIdFor(t.tenantId, 'PAYROLL_PF_PAYABLE');
    const pfExpected =
      instructions.reduce((s, i) => s + i.pfEmployeeMinor + i.pfEmployerMinor + i.epsEmployerMinor, 0n) + 25_000n;
    const pfCredited = allLines.filter((l) => l.accountId === pfPayable).reduce((s, l) => s + l.amountMinor, 0n);
    expect(-pfCredited).toBe(pfExpected);

    // The employer contributions expense carries the same charges, as a debit.
    const employerExpense = await accountIdFor(t.tenantId, 'PAYROLL_EMPLOYER_CONTRIB_EXPENSE');
    const employerExpected =
      instructions.reduce(
        (s, i) => s + i.pfEmployerMinor + i.epsEmployerMinor + i.esiEmployerMinor + i.lwfEmployerMinor,
        0n,
      ) + 25_000n;
    const employerDebited = allLines
      .filter((l) => l.accountId === employerExpense)
      .reduce((s, l) => s + l.amountMinor, 0n);
    expect(employerDebited).toBe(employerExpected);

    assertTrialBalance(await asUser(email, () => journalTrialBalance(ALL_TIME)));
  });
});
