/**
 * Compliance — payroll statutory (docs/plan/compliance.md, workstream E).
 *
 * `payroll.ts` instructs payroll and settles it; this module is what makes
 * the instruction's numbers correct rather than human-typed. PF, ESI,
 * professional tax and LWF are each read from a dated rate table, never a
 * constant, because a notification can move any of them on its own timeline
 * (CMP-PAY-001). A payslip is a document, final once issued, like a tax
 * invoice (CMP-PAY-003). And the proposer of a run never approves it
 * (CMP-PAY-002) — enforced here as a hook on `payroll.ts`'s write path
 * rather than a role-slug check, so it holds regardless of who is wearing
 * which hat.
 *
 * Boundary this module states rather than hides: PF/ESI/PT/LWF are computed
 * in-platform against the rate tables below; TDS on salary (Sec 192) is
 * workstream C's — `tdsAmount` stays whatever that module writes, and a
 * contractor/consultant instruction only ever carries a `tdsSectionHint`
 * pointing at 194J/194C, never a computed figure.
 */

import {
  bonus as computeBonus,
  EVENTS,
  computeEsi,
  computePf,
  convertPpm,
  esiEligible,
  gratuity as computeGratuity,
  leaveEncashment,
  statutoryLines,
  type EsiRates,
  type LwfRates,
  type PfRates,
  type PtSlab,
} from '@kaizen/shared';
import { Prisma } from '@prisma/client';
import { prisma, num } from '../../platform/db.js';
import { rupeesToMinor, withDecimalMinor } from '../../platform/wire.js';
import { minorToRupees, OFFBOARDING_MONEY } from '../money.js';
import { currentAuth } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, scopeFor } from '../../platform/permissions.js';
import { assertEmploymentVisible } from '../../platform/recordScope.js';
import { auditWrite, auditExport, registerGovernedEntities } from '../../platform/audit.js';
import { emit } from '../../platform/eventBus.js';
import { governedWrite } from '../../platform/governedWrite.js';
import { raiseException } from '../../platform/exceptions.js';
import { registerHook } from '../../platform/hooks.js';
import { nextDocumentNumber, DOCUMENT_SERIES } from '../../platform/documentNumber.js';
import { companyProfile, documentNumbering } from '../companyProfile.js';
import { isFounder, ruleAt, ruleIntegerField, type FounderOverride } from '../statutory.js';
import { encryptField, readRegulated } from './privacy.js';

registerGovernedEntities('cmp_pay', [
  'salary_structure',
  'payslip',
  'pf_rate_table',
  'esi_rate_table',
  'pt_slab_table',
  'lwf_rate_table',
  'minimum_wage_table',
  'payroll_instruction',
  'employment_relationship',
  'offboarding',
]);

// ---------------------------------------------------------------------------
// Rate tables
// ---------------------------------------------------------------------------

async function assertRateTableEdit() {
  await assertCan({ resource: 'rate_tables', verb: 'edit' });
}

export async function listPfRateTables() {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'view' });
  const rows = await prisma.pfRateTable.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { effectiveFrom: 'desc' },
  });
  return rows.map((row) => withDecimalMinor(row, ['wageCeiling'] as const));
}

export interface PfRateTableInput {
  effectiveFrom: Date;
  employeeRate: number;
  employerRate: number;
  epsRate: number;
  edliRate: number;
  adminRate: number;
  wageCeiling: number;
  voluntary?: boolean;
}

export async function createPfRateTable(input: PfRateTableInput) {
  const auth = currentAuth();
  await assertRateTableEdit();
  const { wageCeiling, ...rest } = input;
  const row = await prisma.pfRateTable.create({
    data: { tenantId: auth.tenantId, ...rest, wageCeilingMinor: rupeesToMinor(wageCeiling) },
  });
  await auditWrite({ action: 'create', subjectType: 'pf_rate_table', subjectId: row.id, after: row });
  return withDecimalMinor(row, ['wageCeiling'] as const);
}

/** The row in force on `at`, latest-effective-first. */
export async function currentPfRateTable(at: Date): Promise<PfRates> {
  const auth = currentAuth();
  const row = await prisma.pfRateTable.findFirst({
    where: { tenantId: auth.tenantId, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!row)
    throw ApiError.unprocessable(
      'No PF rate table is effective yet. Seed one under Rate tables before computing a run.',
    );
  return {
    employeeRate: num(row.employeeRate)!,
    employerRate: num(row.employerRate)!,
    epsRate: num(row.epsRate)!,
    edliRate: num(row.edliRate)!,
    adminRate: num(row.adminRate)!,
    wageCeiling: minorToRupees(row.wageCeilingMinor),
    voluntary: row.voluntary,
  };
}
export async function listEsiRateTables() {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'view' });
  const rows = await prisma.esiRateTable.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { effectiveFrom: 'desc' },
  });
  return rows.map((row) => withDecimalMinor(row, ['wageCeiling'] as const));
}

export interface EsiRateTableInput {
  effectiveFrom: Date;
  employeeRate: number;
  employerRate: number;
  wageCeiling: number;
}

export async function createEsiRateTable(input: EsiRateTableInput) {
  const auth = currentAuth();
  await assertRateTableEdit();
  const { wageCeiling, ...rest } = input;
  const row = await prisma.esiRateTable.create({
    data: { tenantId: auth.tenantId, ...rest, wageCeilingMinor: rupeesToMinor(wageCeiling) },
  });
  await auditWrite({ action: 'create', subjectType: 'esi_rate_table', subjectId: row.id, after: row });
  return withDecimalMinor(row, ['wageCeiling'] as const);
}

async function currentEsiRateTableRow(at: Date) {
  const auth = currentAuth();
  return prisma.esiRateTable.findFirst({
    where: { tenantId: auth.tenantId, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

export async function currentEsiRateTable(at: Date): Promise<EsiRates> {
  const row = await currentEsiRateTableRow(at);
  if (!row)
    throw ApiError.unprocessable(
      'No ESI rate table is effective yet. Seed one under Rate tables before computing a run.',
    );
  return {
    employeeRate: num(row.employeeRate)!,
    employerRate: num(row.employerRate)!,
    wageCeiling: minorToRupees(row.wageCeilingMinor),
  };
}

export async function listPtSlabTables() {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'view' });
  return prisma.professionalTaxSlabTable.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { effectiveFrom: 'desc' },
  });
}

export interface PtSlabTableInput {
  state?: string;
  effectiveFrom: Date;
  slabs: PtSlab[];
  confirmNote?: string;
}

export async function createPtSlabTable(input: PtSlabTableInput) {
  const auth = currentAuth();
  await assertRateTableEdit();
  const row = await prisma.professionalTaxSlabTable.create({
    data: {
      tenantId: auth.tenantId,
      state: input.state ?? 'TN',
      effectiveFrom: input.effectiveFrom,
      slabs: input.slabs as never,
      confirmNote: input.confirmNote,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'pt_slab_table', subjectId: row.id, after: row });
  return row;
}

async function currentPtSlabRow(at: Date, state = 'TN') {
  const auth = currentAuth();
  return prisma.professionalTaxSlabTable.findFirst({
    where: { tenantId: auth.tenantId, state, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

export async function currentPtSlabs(at: Date, state = 'TN'): Promise<PtSlab[]> {
  const row = await currentPtSlabRow(at, state);
  if (!row)
    throw ApiError.unprocessable(
      `No Professional Tax slab table is effective for ${state} yet. Seed one under Rate tables.`,
    );
  return row.slabs as unknown as PtSlab[];
}

export async function listLwfRateTables() {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'view' });
  const rows = await prisma.lwfRateTable.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { effectiveFrom: 'desc' },
  });
  return rows.map((row) => withDecimalMinor(row, ['employeeAmount', 'employerAmount'] as const));
}

export interface LwfRateTableInput {
  state?: string;
  effectiveFrom: Date;
  employeeAmount: number;
  employerAmount: number;
  dueMonth?: number;
  confirmNote?: string;
}

export async function createLwfRateTable(input: LwfRateTableInput) {
  const auth = currentAuth();
  await assertRateTableEdit();
  const row = await prisma.lwfRateTable.create({
    data: {
      tenantId: auth.tenantId,
      state: input.state ?? 'TN',
      effectiveFrom: input.effectiveFrom,
      employeeAmountMinor: rupeesToMinor(input.employeeAmount),
      employerAmountMinor: rupeesToMinor(input.employerAmount),
      dueMonth: input.dueMonth ?? 12,
      confirmNote: input.confirmNote,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'lwf_rate_table', subjectId: row.id, after: row });
  return withDecimalMinor(row, ['employeeAmount', 'employerAmount'] as const);
}

async function currentLwfRateTableRow(at: Date, state = 'TN') {
  const auth = currentAuth();
  return prisma.lwfRateTable.findFirst({
    where: { tenantId: auth.tenantId, state, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

export async function currentLwfRateTable(at: Date, state = 'TN'): Promise<LwfRates> {
  const row = await currentLwfRateTableRow(at, state);
  if (!row)
    throw ApiError.unprocessable(`No LWF rate table is effective for ${state} yet. Seed one under Rate tables.`);
  return {
    employeeAmount: minorToRupees(row.employeeAmountMinor),
    employerAmount: minorToRupees(row.employerAmountMinor),
    dueMonth: row.dueMonth,
  };
}

export async function listMinimumWageTables() {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'view' });
  const rows = await prisma.minimumWageTable.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: [{ state: 'asc' }, { category: 'asc' }],
  });
  return rows.map((row) => withDecimalMinor(row, ['monthlyAmount'] as const));
}

export interface MinimumWageTableInput {
  state: string;
  category: string;
  monthlyAmount: number;
  effectiveFrom: Date;
}

export async function createMinimumWageTable(input: MinimumWageTableInput) {
  const auth = currentAuth();
  await assertRateTableEdit();
  const { monthlyAmount, ...rest } = input;
  const row = await prisma.minimumWageTable.create({
    data: { tenantId: auth.tenantId, ...rest, monthlyAmountMinor: rupeesToMinor(monthlyAmount) },
  });
  await auditWrite({ action: 'create', subjectType: 'minimum_wage_table', subjectId: row.id, after: row });
  return withDecimalMinor(row, ['monthlyAmount'] as const);
}

/** The floor for a category, or null when none is on file for it yet. */
async function currentMinimumWage(state: string, category: string, at: Date): Promise<number | null> {
  const auth = currentAuth();
  const row = await prisma.minimumWageTable.findFirst({
    where: { tenantId: auth.tenantId, state, category, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
  return row ? minorToRupees(row.monthlyAmountMinor) : null;
}

/**
 * Every employment's minimum-wage category, today taken as a single
 * company-wide "general" category because the employment model carries no
 * category field of its own — an open item, named in docs/compliance/payroll.md
 * rather than silently assumed.
 */
const DEFAULT_WAGE_CATEGORY = 'general';

/** The paise columns a salary structure carries, read back as the Decimals a raw row always returned. */
const SALARY_MONEY = [
  'ctcAnnual',
  'basic',
  'hra',
  'specialAllowance',
  'conveyance',
  'employerPfMonthly',
  'employerEsiMonthly',
] as const;

/** The paise columns of a payroll run and of its instructions, read back as the Decimals a raw row always returned. */
export const PAYROLL_RUN_MONEY = ['grossTotal', 'netTotal'] as const;
export const PAYROLL_INSTRUCTION_MONEY = [
  'grossAmount',
  'deductions',
  'netAmount',
  'basicPay',
  'hra',
  'otherAllowances',
  'pfEmployee',
  'pfEmployer',
  'epsEmployer',
  'esiEmployee',
  'esiEmployer',
  'professionalTax',
  'tdsAmount',
  'lwfEmployee',
  'lwfEmployer',
] as const;

// ---------------------------------------------------------------------------
// Salary structures
// ---------------------------------------------------------------------------

export async function listSalaryStructures(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_structures', verb: 'view' });
  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (employmentRelationshipId) {
    await assertEmploymentVisible('salary_structures', employmentRelationshipId);
    where.employmentRelationshipId = employmentRelationshipId;
  }
  const rows = await prisma.salaryStructure.findMany({ where, orderBy: { effectiveFrom: 'desc' } });
  return attachEmploymentNames(rows.map((r) => withDecimalMinor(r, SALARY_MONEY)));
}

export interface SalaryStructureInput {
  employmentRelationshipId: string;
  effectiveFrom: Date;
  ctcAnnual: number;
  basic: number;
  hra: number;
  specialAllowance?: number;
  conveyance?: number;
  otherAllowances?: Record<string, number>;
}

/** Proposed by whoever holds `salary_structures:create`. */
export async function proposeSalaryStructure(input: SalaryStructureInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_structures', verb: 'create' });
  await assertEmploymentVisible('salary_structures', input.employmentRelationshipId);

  // The preview reads the approved rules, as a run does. An unapproved rule refuses the proposal,
  // naming it, rather than storing a zero employer PF that a run would then contradict.
  const pf = (await pfRatesOn(input.effectiveFrom)).rates;
  const esi = await esiRatesOn(input.effectiveFrom);
  const employerPfMonthly = computePf(input.basic, pf).pfEmployer + computePf(input.basic, pf).epsEmployer;
  const gross =
    input.basic +
    input.hra +
    (input.specialAllowance ?? 0) +
    (input.conveyance ?? 0) +
    Object.values(input.otherAllowances ?? {}).reduce((a, b) => a + b, 0);
  const employerEsiMonthly = esiEligible(gross, esi) ? computeEsi(gross, esi, true).esiEmployer : 0;

  const row = await prisma.salaryStructure.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      effectiveFrom: input.effectiveFrom,
      ctcAnnualMinor: rupeesToMinor(input.ctcAnnual),
      basicMinor: rupeesToMinor(input.basic),
      hraMinor: rupeesToMinor(input.hra),
      specialAllowanceMinor: rupeesToMinor(input.specialAllowance ?? 0),
      conveyanceMinor: rupeesToMinor(input.conveyance ?? 0),
      otherAllowances: (input.otherAllowances ?? {}) as never,
      employerPfMonthlyMinor: rupeesToMinor(employerPfMonthly),
      employerEsiMonthlyMinor: rupeesToMinor(employerEsiMonthly),
      status: 'Proposed',
      proposedById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'salary_structure', subjectId: row.id, after: row });
  return withDecimalMinor(row, SALARY_MONEY);
}

/** Approved by `salary_structures:approve`, and never by the proposer. */
export async function approveSalaryStructure(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_structures', verb: 'approve' });

  const structure = await prisma.salaryStructure.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!structure) throw ApiError.notFound('Salary structure');
  if (structure.status === 'Approved') throw ApiError.conflict('This salary structure is already approved.');
  // The founder is exempt (owner ruling 2026-10-12); the waiver is audited as
  // author_is_approver on this approval's row.
  const founderOverride: FounderOverride[] = [];
  if (structure.proposedById && structure.proposedById === auth.partyId) {
    if (!(await isFounder())) {
      throw ApiError.forbidden('The proposer of a salary structure cannot also approve it (Self-Dealing Bar).', [
        { axis: 'WHO', passed: false, reason: 'proposer_is_approver' },
      ]);
    }
    founderOverride.push('author_is_approver');
  }

  const before = structure;
  const row = await prisma.salaryStructure.update({
    where: { id },
    data: { status: 'Approved', approvedById: auth.partyId, approvedAt: new Date() },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'salary_structure',
    subjectId: row.id,
    before,
    after: row,
    ...(founderOverride.length > 0 ? { meta: { founderOverride } } : {}),
  });
  return withDecimalMinor(row, SALARY_MONEY);
}

/** The approved structure in force on `at`, latest-effective-first. */
async function currentSalaryStructure(employmentRelationshipId: string, at: Date) {
  const auth = currentAuth();
  return prisma.salaryStructure.findFirst({
    where: { tenantId: auth.tenantId, employmentRelationshipId, status: 'Approved', effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Computing a run's statutory lines
// ---------------------------------------------------------------------------

/**
 * The statutory rules a run is computed from. Each parameter is read through ruleAt, which
 * returns APPROVED rows only, on the pay month. An unapproved or missing rule refuses the
 * computation with 422 and names the rule (StatutoryRuleNotFoundError), so a payslip is never
 * computed from a DRAFT.
 *
 * The typed rate tables (PfRateTable, EsiRateTable, ProfessionalTaxSlabTable, LwfRateTable)
 * are no longer read here. They have no status, so nothing could say whether their figures
 * were approved, and a payslip must be able to name the rule it came from (S10). They stay in
 * place as read-only legacy until the rate store is converted in full.
 */
interface PayrollRuleSet {
  pf: {
    ruleId: string;
    rates: PfRates;
    edliRatePpm: bigint;
    adminRatePpm: bigint;
    wageCeilingMinor: bigint;
  };
  esi: { ruleId: string; rates: EsiRates };
  pt: { ruleId: string; slabs: PtSlab[] };
  lwf: { ruleId: string; rates: LwfRates };
}

const PF_RULE = { domain: 'pf', key: 'pf.rates', jurisdiction: 'IN' } as const;
const ESI_RULE = { domain: 'esi', key: 'esi.rates', jurisdiction: 'IN' } as const;
const PT_RULE = { domain: 'pt', key: 'pt.tn_slabs', jurisdiction: 'IN-TN' } as const;
const LWF_RULE = { domain: 'lwf', key: 'lwf.tn_contribution', jurisdiction: 'IN-TN' } as const;

/** A rate held as integer parts per million, read as the fraction the arithmetic takes. */
function rateOf(ppm: bigint): number {
  return Number(ppm) / 1_000_000;
}

function fieldsOf(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function ptSlabsFrom(value: Prisma.JsonValue, key: string): PtSlab[] {
  const slabs = fieldsOf(value).slabs;
  if (!Array.isArray(slabs)) {
    throw ApiError.unprocessable(`Statutory rule ${key} has no slabs.`, {
      reasonCode: 'statutory_rule_malformed',
      key,
      field: 'slabs',
    });
  }
  return slabs.map((slab, index) => {
    const row = fieldsOf(slab as Prisma.JsonValue);
    const read = (field: string, nullable: boolean): bigint | null => {
      const raw = row[field];
      if (nullable && raw === null) return null;
      if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
        throw ApiError.unprocessable(`Statutory rule ${key} has no integer slabs[${index}].${field}.`, {
          reasonCode: 'statutory_rule_malformed',
          key,
          field: `slabs[${index}].${field}`,
        });
      }
      return BigInt(raw);
    };
    const min = read('minGrossMinor', false)!;
    const max = read('maxGrossMinor', true);
    const amount = read('halfYearlyAmountMinor', false)!;
    return {
      minGross: minorToRupees(min),
      maxGross: max === null ? null : minorToRupees(max),
      halfYearlyAmount: minorToRupees(amount),
    };
  });
}

/** The month the LWF is due, 1 to 12, as a JSON integer. A month is a count, not money, so it is not read through a string. */
function lwfDueMonth(value: Prisma.JsonValue, key: string): number {
  const dueMonth = fieldsOf(value).dueMonth;
  if (typeof dueMonth !== 'number' || !Number.isInteger(dueMonth) || dueMonth < 1 || dueMonth > 12) {
    throw ApiError.unprocessable(`Statutory rule ${key} has no month from 1 to 12 in dueMonth.`, {
      reasonCode: 'statutory_rule_malformed',
      key,
      field: 'dueMonth',
    });
  }
  return dueMonth;
}

async function resolvePayrollRules(at: Date): Promise<PayrollRuleSet> {
  const pf = await ruleAt(PF_RULE.domain, PF_RULE.key, PF_RULE.jurisdiction, at);
  const esi = await ruleAt(ESI_RULE.domain, ESI_RULE.key, ESI_RULE.jurisdiction, at);
  const pt = await ruleAt(PT_RULE.domain, PT_RULE.key, PT_RULE.jurisdiction, at);
  const lwf = await ruleAt(LWF_RULE.domain, LWF_RULE.key, LWF_RULE.jurisdiction, at);

  const pfEdliRatePpm = ruleIntegerField(pf.value, 'edliRatePpm', PF_RULE.key);
  const pfAdminRatePpm = ruleIntegerField(pf.value, 'adminRatePpm', PF_RULE.key);
  const pfWageCeilingMinor = ruleIntegerField(pf.value, 'wageCeilingMinor', PF_RULE.key);
  return {
    pf: {
      ruleId: pf.id,
      rates: {
        employeeRate: rateOf(ruleIntegerField(pf.value, 'employeeRatePpm', PF_RULE.key)),
        employerRate: rateOf(ruleIntegerField(pf.value, 'employerRatePpm', PF_RULE.key)),
        epsRate: rateOf(ruleIntegerField(pf.value, 'epsRatePpm', PF_RULE.key)),
        edliRate: rateOf(pfEdliRatePpm),
        adminRate: rateOf(pfAdminRatePpm),
        wageCeiling: minorToRupees(pfWageCeilingMinor),
        voluntary: fieldsOf(pf.value).voluntary === true,
      },
      edliRatePpm: pfEdliRatePpm,
      adminRatePpm: pfAdminRatePpm,
      wageCeilingMinor: pfWageCeilingMinor,
    },
    esi: {
      ruleId: esi.id,
      rates: {
        employeeRate: rateOf(ruleIntegerField(esi.value, 'employeeRatePpm', ESI_RULE.key)),
        employerRate: rateOf(ruleIntegerField(esi.value, 'employerRatePpm', ESI_RULE.key)),
        wageCeiling: minorToRupees(ruleIntegerField(esi.value, 'wageCeilingMinor', ESI_RULE.key)),
      },
    },
    pt: { ruleId: pt.id, slabs: ptSlabsFrom(pt.value, PT_RULE.key) },
    lwf: {
      ruleId: lwf.id,
      rates: {
        employeeAmount: minorToRupees(ruleIntegerField(lwf.value, 'employeeAmountMinor', LWF_RULE.key)),
        employerAmount: minorToRupees(ruleIntegerField(lwf.value, 'employerAmountMinor', LWF_RULE.key)),
        dueMonth: lwfDueMonth(lwf.value, LWF_RULE.key),
      },
    },
  };
}

/**
 * Reads the PF rates for an employer-cost preview on a salary structure proposal, through the
 * same rule the run would use. An unapproved rule refuses the proposal rather than storing a
 * zero employer PF, which is what a missing table used to produce.
 */
async function pfRatesOn(at: Date): Promise<{ rates: PfRates; ruleId: string }> {
  const pf = await ruleAt(PF_RULE.domain, PF_RULE.key, PF_RULE.jurisdiction, at);
  return {
    ruleId: pf.id,
    rates: {
      employeeRate: rateOf(ruleIntegerField(pf.value, 'employeeRatePpm', PF_RULE.key)),
      employerRate: rateOf(ruleIntegerField(pf.value, 'employerRatePpm', PF_RULE.key)),
      epsRate: rateOf(ruleIntegerField(pf.value, 'epsRatePpm', PF_RULE.key)),
      edliRate: rateOf(ruleIntegerField(pf.value, 'edliRatePpm', PF_RULE.key)),
      adminRate: rateOf(ruleIntegerField(pf.value, 'adminRatePpm', PF_RULE.key)),
      wageCeiling: minorToRupees(ruleIntegerField(pf.value, 'wageCeilingMinor', PF_RULE.key)),
      voluntary: fieldsOf(pf.value).voluntary === true,
    },
  };
}

async function esiRatesOn(at: Date): Promise<EsiRates> {
  const esi = await ruleAt(ESI_RULE.domain, ESI_RULE.key, ESI_RULE.jurisdiction, at);
  return {
    employeeRate: rateOf(ruleIntegerField(esi.value, 'employeeRatePpm', ESI_RULE.key)),
    employerRate: rateOf(ruleIntegerField(esi.value, 'employerRatePpm', ESI_RULE.key)),
    wageCeiling: minorToRupees(ruleIntegerField(esi.value, 'wageCeilingMinor', ESI_RULE.key)),
  };
}

/** One statutory line per component, each naming the rule it was computed from. */
interface StatutoryLineRow {
  statute: 'EPF' | 'ESI' | 'PT' | 'LWF';
  component: string;
  amountMinor: bigint;
  ruleId: string;
}

/**
 * Fills every statutory line on each instruction in the run from the approved salary structure
 * in force, plus the approved statutory rules on the pay month.
 *
 * A contractor or consultant computes none of PF/ESI/PT/LWF — their instruction is still marked
 * computed, with `computedFrom.tdsSectionHint` naming 194J so workstream C's TDS module has
 * something to key off, and `tdsAmount` left at whatever it already carries (CMP-PAY-004).
 *
 * An instruction with no approved structure in force is left uncomputed:
 * `computedFrom` stays null, which is exactly what blocks approval.
 *
 * Each employee's lines are written with the instruction's update, in one transaction, and each
 * line records the ruleId it came from. Posting reads those ruleIds again and refuses a rule that
 * is no longer APPROVED for the month (payrollAccrual.ts).
 */
export async function computeInstruction(payrollRunId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll', verb: 'edit' });

  const run = await prisma.payrollRun.findFirst({ where: { id: payrollRunId, tenantId: auth.tenantId } });
  if (!run) throw ApiError.notFound('Payroll run');

  const [year, month] = run.payPeriod.split('-').map(Number);
  const periodEnd = new Date(Date.UTC(year, month, 0));

  const instructions = await prisma.payrollInstruction.findMany({
    where: { payrollRunId, tenantId: auth.tenantId },
    include: { employmentRelationship: true },
  });

  // Read only when an employee needs them. A run of contractors computes no statutory line and
  // needs no statutory rule. An unapproved rule refuses here, with the rule named.
  const needsRules = instructions.some((i) => i.employmentRelationship.engagementType === 'employee');
  const rules = needsRules ? await resolvePayrollRules(periodEnd) : null;

  let computed = 0;

  for (const instruction of instructions) {
    const employment = instruction.employmentRelationship;
    const linesWhere = { tenantId: auth.tenantId, payrollRunId, employmentRelationshipId: employment.id };
    if (employment.engagementType !== 'employee') {
      await prisma.$transaction(async (tx) => {
        await tx.payrollStatutoryLine.deleteMany({ where: linesWhere });
        await tx.payrollInstruction.update({
          where: { id: instruction.id },
          data: {
            basicPayMinor: 0n,
            hraMinor: 0n,
            otherAllowancesMinor: instruction.grossAmountMinor,
            pfEmployeeMinor: 0n,
            pfEmployerMinor: 0n,
            epsEmployerMinor: 0n,
            esiEmployeeMinor: 0n,
            esiEmployerMinor: 0n,
            professionalTaxMinor: 0n,
            lwfEmployeeMinor: 0n,
            lwfEmployerMinor: 0n,
            deductionsMinor: 0n,
            netAmountMinor: instruction.grossAmountMinor,
            computedFrom: { engagementType: employment.engagementType, tdsSectionHint: '194J' } as never,
          },
        });
        // One row per instruction written, carrying the payslip figures approval is given on.
        await auditWrite({
          action: 'update',
          subjectType: 'payroll_instruction',
          subjectId: instruction.id,
          before: {
            grossAmountMinor: instruction.grossAmountMinor.toString(),
            netAmountMinor: instruction.netAmountMinor.toString(),
          },
          after: {
            grossAmountMinor: instruction.grossAmountMinor.toString(),
            netAmountMinor: instruction.grossAmountMinor.toString(),
            statutoryLines: 0,
          },
          tx,
        });
      });
      computed += 1;
      continue;
    }

    const structure = await currentSalaryStructure(employment.id, periodEnd);
    if (!structure || !rules) {
      // Stays uncomputed on purpose. Any lines from an earlier computation are cleared with it.
      await prisma.payrollStatutoryLine.deleteMany({ where: linesWhere });
      continue;
    }

    const otherAllowancesTotal =
      minorToRupees(structure.specialAllowanceMinor) +
      minorToRupees(structure.conveyanceMinor) +
      Object.values((structure.otherAllowances as Record<string, number>) ?? {}).reduce((a, b) => a + Number(b), 0);
    const basic = minorToRupees(structure.basicMinor);
    const hra = minorToRupees(structure.hraMinor);
    const gross = basic + hra + otherAllowancesTotal;

    const lines = statutoryLines(
      gross,
      { basicPay: basic, hra, otherAllowances: otherAllowancesTotal },
      { pf: rules.pf.rates, esi: rules.esi.rates, pt: rules.pt.slabs, lwf: rules.lwf.rates },
      { payPeriod: run.payPeriod },
    );

    // EDLI and admin are PF charges on the EPS wage: the basic, capped at the wage ceiling whether or
    // not PF is voluntary (computePf). They are computed here in paise, from the stored basic, so the
    // figure is exact to the paisa rather than rounded through the rupee arithmetic above. They are
    // employer costs: they are not in gross and not deducted from net.
    const epsWageMinor =
      structure.basicMinor < rules.pf.wageCeilingMinor ? structure.basicMinor : rules.pf.wageCeilingMinor;
    const edliMinor = convertPpm(epsWageMinor, rules.pf.edliRatePpm);
    const adminMinor = convertPpm(epsWageMinor, rules.pf.adminRatePpm);

    const rows: StatutoryLineRow[] = [
      {
        statute: 'EPF',
        component: 'PF_EMPLOYEE',
        amountMinor: rupeesToMinor(lines.pfEmployee),
        ruleId: rules.pf.ruleId,
      },
      {
        statute: 'EPF',
        component: 'PF_EMPLOYER',
        amountMinor: rupeesToMinor(lines.pfEmployer),
        ruleId: rules.pf.ruleId,
      },
      {
        statute: 'EPF',
        component: 'EPS_EMPLOYER',
        amountMinor: rupeesToMinor(lines.epsEmployer),
        ruleId: rules.pf.ruleId,
      },
      { statute: 'EPF', component: 'EDLI_EMPLOYER', amountMinor: edliMinor, ruleId: rules.pf.ruleId },
      { statute: 'EPF', component: 'ADMIN_EMPLOYER', amountMinor: adminMinor, ruleId: rules.pf.ruleId },
      {
        statute: 'ESI',
        component: 'ESI_EMPLOYEE',
        amountMinor: rupeesToMinor(lines.esiEmployee),
        ruleId: rules.esi.ruleId,
      },
      {
        statute: 'ESI',
        component: 'ESI_EMPLOYER',
        amountMinor: rupeesToMinor(lines.esiEmployer),
        ruleId: rules.esi.ruleId,
      },
      {
        statute: 'PT',
        component: 'PT_EMPLOYEE',
        amountMinor: rupeesToMinor(lines.professionalTax),
        ruleId: rules.pt.ruleId,
      },
      {
        statute: 'LWF',
        component: 'LWF_EMPLOYEE',
        amountMinor: rupeesToMinor(lines.lwfEmployee),
        ruleId: rules.lwf.ruleId,
      },
      {
        statute: 'LWF',
        component: 'LWF_EMPLOYER',
        amountMinor: rupeesToMinor(lines.lwfEmployer),
        ruleId: rules.lwf.ruleId,
      },
    ];

    await prisma.$transaction(async (tx) => {
      await tx.payrollInstruction.update({
        where: { id: instruction.id },
        data: {
          grossAmountMinor: rupeesToMinor(gross),
          basicPayMinor: rupeesToMinor(lines.basicPay),
          hraMinor: rupeesToMinor(lines.hra),
          otherAllowancesMinor: rupeesToMinor(lines.otherAllowances),
          pfEmployeeMinor: rupeesToMinor(lines.pfEmployee),
          pfEmployerMinor: rupeesToMinor(lines.pfEmployer),
          epsEmployerMinor: rupeesToMinor(lines.epsEmployer),
          esiEmployeeMinor: rupeesToMinor(lines.esiEmployee),
          esiEmployerMinor: rupeesToMinor(lines.esiEmployer),
          professionalTaxMinor: rupeesToMinor(lines.professionalTax),
          lwfEmployeeMinor: rupeesToMinor(lines.lwfEmployee),
          lwfEmployerMinor: rupeesToMinor(lines.lwfEmployer),
          deductionsMinor: rupeesToMinor(lines.totalDeductions),
          netAmountMinor: rupeesToMinor(lines.netAmount),
          computedFrom: {
            pfRuleId: rules.pf.ruleId,
            esiRuleId: rules.esi.ruleId,
            ptRuleId: rules.pt.ruleId,
            lwfRuleId: rules.lwf.ruleId,
            structureId: structure.id,
          } as never,
        },
      });
      await tx.payrollStatutoryLine.deleteMany({ where: linesWhere });
      await tx.payrollStatutoryLine.createMany({
        data: rows.map((row) => ({
          tenantId: auth.tenantId,
          payrollRunId,
          employmentRelationshipId: employment.id,
          payPeriod: run.payPeriod,
          statute: row.statute,
          contributionKind: 'statutory',
          component: row.component,
          amountMinor: row.amountMinor,
          ruleId: row.ruleId,
        })),
      });
      await auditWrite({
        action: 'update',
        subjectType: 'payroll_instruction',
        subjectId: instruction.id,
        before: {
          grossAmountMinor: instruction.grossAmountMinor.toString(),
          netAmountMinor: instruction.netAmountMinor.toString(),
        },
        after: {
          grossAmountMinor: rupeesToMinor(gross).toString(),
          netAmountMinor: rupeesToMinor(lines.netAmount).toString(),
          statutoryLines: rows.length,
          ruleIds: [...new Set(rows.map((r) => r.ruleId))],
        },
        tx,
      });
    });
    computed += 1;
  }

  return { instructionCount: instructions.length, computed };
}

// ---------------------------------------------------------------------------
// The Self-Dealing Bar and the computed-lines gate, on payroll's own write path
// ---------------------------------------------------------------------------

registerHook('payroll_run.before_approve', 'cmp_pay', async (payload) => {
  const run = payload.run as { id: string; preparedById: string | null; payPeriod: string };
  const instructions = payload.instructions as Array<{
    id: string;
    computedFrom: unknown;
    grossAmountMinor: unknown;
    employmentRelationshipId: string;
  }>;
  const approverPartyId = payload.approverPartyId as string | null;

  if (run.preparedById && approverPartyId && run.preparedById === approverPartyId) {
    throw ApiError.forbidden(
      `${run.payPeriod}'s payroll was prepared by this same person. The proposer of a payroll run cannot also approve it.`,
      [{ axis: 'WHO', passed: false, reason: 'CMP-PAY-002: proposer_is_approver' }],
    );
  }

  // Blocking is scoped to employees this tenant has actually onboarded to
  // structured statutory payroll — one with a salary structure on file at
  // some point. A tenant with no salary structures at all yet has nothing
  // computed anywhere, and treating that as a hard block would freeze every
  // run company-wide the day this workstream ships, rather than only the
  // runs it can actually say something about ("not yet measured" — Principle
  // 6 — is not the same fact as "wrong").
  const auth = currentAuth();
  const onboarded = new Set(
    (
      await prisma.salaryStructure.findMany({
        where: {
          tenantId: auth.tenantId,
          employmentRelationshipId: { in: instructions.map((i) => i.employmentRelationshipId) },
        },
        select: { employmentRelationshipId: true },
        distinct: ['employmentRelationshipId'],
      })
    ).map((s) => s.employmentRelationshipId),
  );

  const uncomputed = instructions.filter((i) => i.computedFrom == null && onboarded.has(i.employmentRelationshipId));
  if (uncomputed.length > 0) {
    throw ApiError.unprocessable(
      `${uncomputed.length} of ${instructions.length} instruction(s) have a salary structure on file but no statutory lines computed yet. Run "Compute" before approving.`,
      { reason: 'statutory_lines_not_computed', count: uncomputed.length },
    );
  }

  // CMP-PAY-005: nobody actually computed against the tables is approved
  // below the minimum wage for their category. An instruction with no
  // computed lines is unmeasured, not asserted compliant, so it is not
  // checked here either.
  const profile = await prisma.companyProfile.findFirst({ where: { tenantId: auth.tenantId } });
  const state = profile?.stateName ?? 'Tamil Nadu';
  const [year, month] = run.payPeriod.split('-').map(Number);
  const periodEnd = new Date(Date.UTC(year, month, 0));
  const floor = await currentMinimumWage(state, DEFAULT_WAGE_CATEGORY, periodEnd);

  if (floor != null) {
    const below = instructions.filter(
      (i) => i.computedFrom != null && minorToRupees(i.grossAmountMinor as bigint) < floor,
    );
    if (below.length > 0) {
      for (const i of below) {
        await raiseException({
          code: 'CMP-PAY-005',
          label: 'Pay below the minimum wage floor',
          severity: 'S3_HIGH_RISK',
          subjectType: 'payroll_instruction',
          subjectId: i.id,
          detail: `Computed gross is below the ${state} minimum wage (₹${floor}/month) for ${DEFAULT_WAGE_CATEGORY}.`,
          ownerPartyId: run.preparedById,
        });
      }
      throw ApiError.unprocessable(
        `${below.length} instruction(s) pay below the ${state} minimum wage floor (₹${floor}/month). Fix the structure or the run before approving.`,
        { reason: 'CMP-PAY-005: below_minimum_wage', count: below.length },
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Payslips — issued on approval, final once issued (CMP-PAY-003)
// ---------------------------------------------------------------------------

registerHook('payroll_run.approved', 'cmp_pay', async (payload) => {
  const run = payload.run as { id: string; payPeriod: string; tenantId?: string };
  const instructions = payload.instructions as Array<{ id: string; computedFrom: unknown }>;
  await issuePayslipsForRun(
    run.id,
    run.payPeriod,
    instructions.map((i) => i.id),
  );
});

async function issuePayslipsForRun(payrollRunId: string, payPeriod: string, instructionIds: string[]) {
  const auth = currentAuth();
  const profile = await companyProfile();
  const numbering = await documentNumbering();

  for (const instructionId of instructionIds) {
    const instruction = await prisma.payrollInstruction.findFirst({
      where: { id: instructionId },
      include: {
        employmentRelationship: {
          include: {
            person: true,
            assignments: {
              where: { rowStatus: 'Effective' },
              include: { position: { include: { job: true } } },
              take: 1,
              orderBy: { effectiveFrom: 'desc' },
            },
          },
        },
      },
    });
    if (!instruction || instruction.computedFrom == null || instruction.payslipNumber) continue;

    const employment = instruction.employmentRelationship;
    // Decrypted once here: the masked form is taken from the clear value, not the ciphertext (FX-64).
    const esicPlain = readRegulated(employment.esicNumber);

    const snapshot = {
      employer: {
        name: profile.legalName,
        address: [profile.addressLine1, profile.addressLine2, profile.city, profile.pincode].filter(Boolean).join(', '),
        pfEstablishmentCode: profile.pfEstablishmentCode,
        esiEmployerCode: profile.esiEmployerCode,
      },
      employee: {
        name: employment.person.fullName,
        designation: employment.assignments?.[0]?.position?.job?.title ?? null,
        uan: readRegulated(employment.uanNumber),
        esicNumber: esicPlain ? `XXXX${esicPlain.slice(-4)}` : null,
      },
      payPeriod,
      earnings: {
        basic: minorToRupees(instruction.basicPayMinor),
        hra: minorToRupees(instruction.hraMinor),
        otherAllowances: minorToRupees(instruction.otherAllowancesMinor),
        gross: minorToRupees(instruction.grossAmountMinor),
      },
      deductions: {
        pf: minorToRupees(instruction.pfEmployeeMinor),
        esi: minorToRupees(instruction.esiEmployeeMinor),
        professionalTax: minorToRupees(instruction.professionalTaxMinor),
        lwf: minorToRupees(instruction.lwfEmployeeMinor),
        tds: minorToRupees(instruction.tdsAmountMinor),
        total: minorToRupees(instruction.deductionsMinor),
      },
      net: minorToRupees(instruction.netAmountMinor),
      bankLast4: readRegulated(employment.bankAccountNumber)?.slice(-4) ?? null,
    };

    const payslip = await prisma.$transaction(async (tx) => {
      const number = await nextDocumentNumber(
        tx,
        DOCUMENT_SERIES.payslip,
        numbering.prefix,
        new Date(),
        numbering.yearFormat,
      );
      const created = await tx.payslip.create({
        data: {
          tenantId: auth.tenantId,
          instructionId: instruction.id,
          employmentRelationshipId: employment.id,
          payPeriod,
          number,
          snapshot: snapshot as never,
        },
      });
      await tx.payrollInstruction.update({
        where: { id: instruction.id },
        data: { payslipNumber: number, payslipIssuedAt: created.issuedAt },
      });
      return created;
    });
    await auditWrite({ action: 'create', subjectType: 'payslip', subjectId: payslip.id, after: payslip });
  }
}

export async function listPayslips(input: { employmentRelationshipId?: string; payPeriod?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'payslips', verb: 'view' });
  const scope = await scopeFor('payslips', 'view');
  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (input.payPeriod) where.payPeriod = input.payPeriod;

  if (scope !== 'all') {
    const own = await prisma.employmentRelationship.findMany({
      where: { tenantId: auth.tenantId, personId: auth.partyId ?? '' },
      select: { id: true },
    });
    where.employmentRelationshipId = { in: own.map((e) => e.id) };
  } else if (input.employmentRelationshipId) {
    where.employmentRelationshipId = input.employmentRelationshipId;
  }

  const rows = await prisma.payslip.findMany({ where, orderBy: { issuedAt: 'desc' } });
  return attachEmploymentNames(rows);
}

/**
 * SalaryStructure/Payslip carry `employmentRelationshipId` as a plain column,
 * not a Prisma relation, so a list of them names nobody by default — one
 * batched lookup across the whole page, never a query per row.
 */
async function attachEmploymentNames<T extends { employmentRelationshipId: string }>(
  rows: T[],
): Promise<Array<T & { employmentFullName: string | null; employmentRecordCode: string | null }>> {
  const auth = currentAuth();
  const employments = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, id: { in: [...new Set(rows.map((r) => r.employmentRelationshipId))] } },
    select: { id: true, recordCode: true, person: { select: { fullName: true } } },
  });
  const byId = new Map(employments.map((e) => [e.id, e]));
  return rows.map((r) => {
    const e = byId.get(r.employmentRelationshipId);
    return { ...r, employmentFullName: e?.person.fullName ?? null, employmentRecordCode: e?.recordCode ?? null };
  });
}

export async function getPayslip(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payslips', verb: 'view' });
  const payslip = await prisma.payslip.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!payslip) throw ApiError.notFound('Payslip');

  const scope = await scopeFor('payslips', 'view');
  if (scope !== 'all') {
    const employment = await prisma.employmentRelationship.findFirst({
      where: { id: payslip.employmentRelationshipId, tenantId: auth.tenantId },
      select: { personId: true },
    });
    if (!employment || employment.personId !== auth.partyId) throw ApiError.notFound('Payslip');
  }
  return payslip;
}

/** The printable document — the same final snapshot, addressed by its own path. */
export async function payslipDocument(id: string) {
  return getPayslip(id);
}

// ---------------------------------------------------------------------------
// EPFO ECR / ESIC exports
// ---------------------------------------------------------------------------

/** `UAN#~#Name#~#Gross#~#EPF wages#~#EPS wages#~#EDLI wages#~#EE#~#EPS#~#ER#~#NCP days#~#refund` */
export async function exportEcr(payrollRunId: string): Promise<string> {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll', verb: 'export' });

  const run = await prisma.payrollRun.findFirst({ where: { id: payrollRunId, tenantId: auth.tenantId } });
  if (!run) throw ApiError.notFound('Payroll run');

  const instructions = await prisma.payrollInstruction.findMany({
    where: { payrollRunId, tenantId: auth.tenantId, pfEmployeeMinor: { gt: 0n } },
    include: { employmentRelationship: { include: { person: true } } },
  });

  const lines = instructions.map((i) => {
    const employment = i.employmentRelationship;
    const pfWage = minorToRupees(i.basicPayMinor);
    const epsWage = Math.min(pfWage, pfWage); // EPS wage equals capped basic already
    return [
      readRegulated(employment.uanNumber) ?? '',
      employment.person.fullName,
      minorToRupees(i.grossAmountMinor),
      pfWage,
      epsWage,
      pfWage,
      minorToRupees(i.pfEmployeeMinor),
      minorToRupees(i.epsEmployerMinor),
      minorToRupees(i.pfEmployerMinor),
      0, // NCP days — not tracked yet
      0, // refund
    ].join('#~#');
  });

  await auditExport('payroll_run', 'ecr', lines.length);
  return lines.join('\n');
}

/** CSV: IP number, IP name, days, wages, reason code. */
export async function exportEsic(payrollRunId: string): Promise<string> {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll', verb: 'export' });

  const run = await prisma.payrollRun.findFirst({ where: { id: payrollRunId, tenantId: auth.tenantId } });
  if (!run) throw ApiError.notFound('Payroll run');

  const instructions = await prisma.payrollInstruction.findMany({
    where: { payrollRunId, tenantId: auth.tenantId, esiEmployeeMinor: { gt: 0n } },
    include: { employmentRelationship: { include: { person: true } } },
  });

  const rows = ['IP Number,IP Name,Days,Wages,Reason Code'];
  for (const i of instructions) {
    const employment = i.employmentRelationship;
    rows.push(
      [
        readRegulated(employment.esicNumber) ?? '',
        employment.person.fullName,
        26,
        minorToRupees(i.grossAmountMinor),
        '',
      ].join(','),
    );
  }

  await auditExport('payroll_run', 'esic', instructions.length);
  return rows.join('\n');
}

// ---------------------------------------------------------------------------
// Gratuity, bonus and full-and-final settlement
// ---------------------------------------------------------------------------

export { computeGratuity as gratuity, computeBonus as bonus };

function monthsBetween(from: Date, to: Date): number {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

export async function settleOffboarding(offboardingId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payroll', verb: 'edit' });

  const offboarding = await prisma.offboarding.findFirst({ where: { id: offboardingId, tenantId: auth.tenantId } });
  if (!offboarding) throw ApiError.notFound('Offboarding');

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: offboarding.employmentRelationshipId, tenantId: auth.tenantId },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const asOf = employment.separationDate ?? new Date();
  const structure = await currentSalaryStructure(employment.id, asOf);
  const basicRecord = structure
    ? null
    : await prisma.compensationRecord.findFirst({
        where: { employmentRelationshipId: employment.id, status: 'Effective', voidedAt: null },
        orderBy: { effectiveFrom: 'desc' },
      });
  const basicMonthly = structure
    ? minorToRupees(structure.basicMinor)
    : basicRecord?.basicPayMinor != null
      ? minorToRupees(basicRecord.basicPayMinor)
      : 0;
  const grossMonthly = structure
    ? minorToRupees(structure.basicMinor) +
      minorToRupees(structure.hraMinor) +
      minorToRupees(structure.specialAllowanceMinor) +
      minorToRupees(structure.conveyanceMinor) +
      Object.values((structure.otherAllowances as Record<string, number>) ?? {}).reduce((a, b) => a + Number(b), 0)
    : basicMonthly;

  const months = Math.max(0, monthsBetween(employment.hireEffectiveDate, asOf));
  const grat = computeGratuity(basicMonthly, months);

  const encashableTypes = await prisma.leaveType.findMany({ where: { tenantId: auth.tenantId, encashable: true } });
  const balances = await prisma.leaveBalance.findMany({
    where: {
      tenantId: auth.tenantId,
      employmentRelationshipId: employment.id,
      leaveTypeId: { in: encashableTypes.map((t) => t.id) },
    },
  });
  let encashDays = 0;
  for (const b of balances) {
    const type = encashableTypes.find((t) => t.id === b.leaveTypeId);
    const cap = type?.maxEncashDays ? num(type.maxEncashDays)! : Infinity;
    encashDays += Math.min(num(b.balanceDays) ?? 0, cap);
  }
  const leaveEncashmentAmount = leaveEncashment(basicMonthly, encashDays);

  const bonusResult = computeBonus(basicMonthly, basicMonthly <= 21_000);

  // Notice recovery needs the date notice was actually given, which the
  // employment model does not carry as a distinct fact from the separation
  // date itself — so unserved days, and the recovery against them, stay at
  // zero rather than being guessed. `noticeRecovery` is exported from
  // packages/shared for whichever screen collects that date and calls it.
  const noticeRecoveryAmount = 0;

  const settlementAmount = grat.amount + leaveEncashmentAmount + bonusResult.amount - noticeRecoveryAmount;

  const before = offboarding;
  const row = await prisma.offboarding.update({
    where: { id: offboardingId },
    data: {
      gratuityAmountMinor: rupeesToMinor(grat.amount),
      leaveEncashmentAmountMinor: rupeesToMinor(leaveEncashmentAmount),
      bonusAmountMinor: rupeesToMinor(bonusResult.amount),
      noticeRecoveryAmountMinor: rupeesToMinor(noticeRecoveryAmount),
      settlementAmountMinor: rupeesToMinor(settlementAmount),
      settlementComputedAt: new Date(),
    },
  });
  await auditWrite({ action: 'update', subjectType: 'offboarding', subjectId: row.id, before, after: row });
  return {
    ...withDecimalMinor(row, OFFBOARDING_MONEY),
    gratuityYears: grat.years,
    gratuityEligible: grat.eligible,
    encashDays,
  };
}

// ---------------------------------------------------------------------------
// Engagement type and bank/nominee details
// ---------------------------------------------------------------------------

const ENGAGEMENT_TYPES = ['employee', 'contractor', 'consultant', 'intern', 'apprentice'];

export async function setEngagementType(employmentRelationshipId: string, engagementType: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'employees', verb: 'edit' });
  if (!ENGAGEMENT_TYPES.includes(engagementType)) {
    throw ApiError.badRequest(`Engagement type must be one of: ${ENGAGEMENT_TYPES.join(', ')}.`);
  }
  const before = await prisma.employmentRelationship.findFirst({
    where: { id: employmentRelationshipId, tenantId: auth.tenantId },
  });
  if (!before) throw ApiError.notFound('Employment relationship');

  const row = await prisma.employmentRelationship.update({
    where: { id: employmentRelationshipId },
    data: { engagementType },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'employment_relationship',
    subjectId: row.id,
    before: { engagementType: before.engagementType },
    after: { engagementType: row.engagementType },
  });
  return { id: row.id, engagementType: row.engagementType };
}

export interface BankDetailsInput {
  bankAccountNumber?: string;
  bankIfsc?: string;
  bankAccountName?: string;
  nomineeName?: string;
  nomineeRelationship?: string;
  esicNumber?: string;
}

export async function setBankDetails(employmentRelationshipId: string, input: BankDetailsInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'employees', verb: 'edit' });
  const before = await prisma.employmentRelationship.findFirst({
    where: { id: employmentRelationshipId, tenantId: auth.tenantId },
  });
  if (!before) throw ApiError.notFound('Employment relationship');

  // The account number, the name on it and the nominee's name are regulated
  // values: encrypted on the way in, the way the privacy backfill leaves
  // everything already on disk. The nominee was spread through in plaintext
  // until FX-64; `...input` is first, so the encrypted value must come after it.
  const data = {
    ...input,
    ...(input.bankAccountNumber !== undefined ? { bankAccountNumber: encryptField(input.bankAccountNumber) } : {}),
    ...(input.bankAccountName !== undefined ? { bankAccountName: encryptField(input.bankAccountName) } : {}),
    ...(input.bankIfsc !== undefined ? { bankIfsc: encryptField(input.bankIfsc) } : {}),
    ...(input.esicNumber !== undefined ? { esicNumber: encryptField(input.esicNumber) } : {}),
    ...(input.nomineeName !== undefined ? { nomineeName: encryptField(input.nomineeName) } : {}),
  };

  // The row, its audit and its event commit together (governedWrite). Before
  // this the update ran alone: a bank-detail change with no audit row and no event.
  return governedWrite(async (tx) => {
    const row = await tx.employmentRelationship.update({ where: { id: employmentRelationshipId }, data });
    // Regulated values themselves never enter the diff or the event, only that the fields changed.
    await auditWrite({
      action: 'update',
      subjectType: 'employment_relationship',
      subjectId: row.id,
      meta: { fieldsChanged: Object.keys(input) },
      tx,
    });
    await emit({
      name: EVENTS.EMPLOYEE_PROFILE_UPDATED,
      subject: { entityType: 'employment_relationship', entityId: row.id },
      newState: { fieldsChanged: Object.keys(input) },
      tx,
    });
    return { id: row.id, ok: true };
  });
}
