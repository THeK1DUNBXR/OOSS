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
  computeEsi,
  computePf,
  esiEligible,
  gratuity as computeGratuity,
  leaveEncashment,
  statutoryLines,
  type EsiRates,
  type LwfRates,
  type PfRates,
  type PtSlab,
} from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, scopeFor } from '../../platform/permissions.js';
import { assertEmploymentVisible } from '../../platform/recordScope.js';
import { auditWrite, auditExport, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';
import { registerHook } from '../../platform/hooks.js';
import { nextDocumentNumber, DOCUMENT_SERIES } from '../../platform/documentNumber.js';
import { companyProfile, documentNumbering } from '../companyProfile.js';
import { encryptField, readRegulated } from './privacy.js';

registerGovernedEntities('cmp_pay', [
  'salary_structure',
  'payslip',
  'pf_rate_table',
  'esi_rate_table',
  'pt_slab_table',
  'lwf_rate_table',
  'minimum_wage_table',
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
  return prisma.pfRateTable.findMany({ where: { tenantId: auth.tenantId }, orderBy: { effectiveFrom: 'desc' } });
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
  const row = await prisma.pfRateTable.create({ data: { tenantId: auth.tenantId, ...input } });
  await auditWrite({ action: 'create', subjectType: 'pf_rate_table', subjectId: row.id, after: row, force: true });
  return row;
}

/** The row in force on `at`, latest-effective-first. */
export async function currentPfRateTable(at: Date): Promise<PfRates> {
  const auth = currentAuth();
  const row = await prisma.pfRateTable.findFirst({
    where: { tenantId: auth.tenantId, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!row) throw ApiError.unprocessable('No PF rate table is effective yet. Seed one under Rate tables before computing a run.');
  return {
    employeeRate: num(row.employeeRate)!,
    employerRate: num(row.employerRate)!,
    epsRate: num(row.epsRate)!,
    edliRate: num(row.edliRate)!,
    adminRate: num(row.adminRate)!,
    wageCeiling: num(row.wageCeiling)!,
    voluntary: row.voluntary,
  };
}
async function currentPfRateTableRow(at: Date) {
  const auth = currentAuth();
  return prisma.pfRateTable.findFirst({ where: { tenantId: auth.tenantId, effectiveFrom: { lte: at } }, orderBy: { effectiveFrom: 'desc' } });
}

export async function listEsiRateTables() {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'view' });
  return prisma.esiRateTable.findMany({ where: { tenantId: auth.tenantId }, orderBy: { effectiveFrom: 'desc' } });
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
  const row = await prisma.esiRateTable.create({ data: { tenantId: auth.tenantId, ...input } });
  await auditWrite({ action: 'create', subjectType: 'esi_rate_table', subjectId: row.id, after: row, force: true });
  return row;
}

async function currentEsiRateTableRow(at: Date) {
  const auth = currentAuth();
  return prisma.esiRateTable.findFirst({ where: { tenantId: auth.tenantId, effectiveFrom: { lte: at } }, orderBy: { effectiveFrom: 'desc' } });
}

export async function currentEsiRateTable(at: Date): Promise<EsiRates> {
  const row = await currentEsiRateTableRow(at);
  if (!row) throw ApiError.unprocessable('No ESI rate table is effective yet. Seed one under Rate tables before computing a run.');
  return { employeeRate: num(row.employeeRate)!, employerRate: num(row.employerRate)!, wageCeiling: num(row.wageCeiling)! };
}

export async function listPtSlabTables() {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'view' });
  return prisma.professionalTaxSlabTable.findMany({ where: { tenantId: auth.tenantId }, orderBy: { effectiveFrom: 'desc' } });
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
    data: { tenantId: auth.tenantId, state: input.state ?? 'TN', effectiveFrom: input.effectiveFrom, slabs: input.slabs as never, confirmNote: input.confirmNote },
  });
  await auditWrite({ action: 'create', subjectType: 'pt_slab_table', subjectId: row.id, after: row, force: true });
  return row;
}

async function currentPtSlabRow(at: Date, state = 'TN') {
  const auth = currentAuth();
  return prisma.professionalTaxSlabTable.findFirst({ where: { tenantId: auth.tenantId, state, effectiveFrom: { lte: at } }, orderBy: { effectiveFrom: 'desc' } });
}

export async function currentPtSlabs(at: Date, state = 'TN'): Promise<PtSlab[]> {
  const row = await currentPtSlabRow(at, state);
  if (!row) throw ApiError.unprocessable(`No Professional Tax slab table is effective for ${state} yet. Seed one under Rate tables.`);
  return row.slabs as unknown as PtSlab[];
}

export async function listLwfRateTables() {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'view' });
  return prisma.lwfRateTable.findMany({ where: { tenantId: auth.tenantId }, orderBy: { effectiveFrom: 'desc' } });
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
      employeeAmount: input.employeeAmount,
      employerAmount: input.employerAmount,
      dueMonth: input.dueMonth ?? 12,
      confirmNote: input.confirmNote,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'lwf_rate_table', subjectId: row.id, after: row, force: true });
  return row;
}

async function currentLwfRateTableRow(at: Date, state = 'TN') {
  const auth = currentAuth();
  return prisma.lwfRateTable.findFirst({ where: { tenantId: auth.tenantId, state, effectiveFrom: { lte: at } }, orderBy: { effectiveFrom: 'desc' } });
}

export async function currentLwfRateTable(at: Date, state = 'TN'): Promise<LwfRates> {
  const row = await currentLwfRateTableRow(at, state);
  if (!row) throw ApiError.unprocessable(`No LWF rate table is effective for ${state} yet. Seed one under Rate tables.`);
  return { employeeAmount: num(row.employeeAmount)!, employerAmount: num(row.employerAmount)!, dueMonth: row.dueMonth };
}

export async function listMinimumWageTables() {
  const auth = currentAuth();
  await assertCan({ resource: 'rate_tables', verb: 'view' });
  return prisma.minimumWageTable.findMany({ where: { tenantId: auth.tenantId }, orderBy: [{ state: 'asc' }, { category: 'asc' }] });
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
  const row = await prisma.minimumWageTable.create({ data: { tenantId: auth.tenantId, ...input } });
  await auditWrite({ action: 'create', subjectType: 'minimum_wage_table', subjectId: row.id, after: row, force: true });
  return row;
}

/** The floor for a category, or null when none is on file for it yet. */
async function currentMinimumWage(state: string, category: string, at: Date): Promise<number | null> {
  const auth = currentAuth();
  const row = await prisma.minimumWageTable.findFirst({
    where: { tenantId: auth.tenantId, state, category, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
  return row ? num(row.monthlyAmount) : null;
}

/**
 * Every employment's minimum-wage category, today taken as a single
 * company-wide "general" category because the employment model carries no
 * category field of its own — an open item, named in docs/compliance/payroll.md
 * rather than silently assumed.
 */
const DEFAULT_WAGE_CATEGORY = 'general';

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
  return prisma.salaryStructure.findMany({ where, orderBy: { effectiveFrom: 'desc' } });
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

  const pf = await currentPfRateTable(input.effectiveFrom).catch(() => null);
  const esi = await currentEsiRateTable(input.effectiveFrom).catch(() => null);
  const employerPfMonthly = pf ? computePf(input.basic, pf).pfEmployer + computePf(input.basic, pf).epsEmployer : 0;
  const gross = input.basic + input.hra + (input.specialAllowance ?? 0) + (input.conveyance ?? 0) +
    Object.values(input.otherAllowances ?? {}).reduce((a, b) => a + b, 0);
  const employerEsiMonthly = esi && esiEligible(gross, esi) ? computeEsi(gross, esi, true).esiEmployer : 0;

  const row = await prisma.salaryStructure.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      effectiveFrom: input.effectiveFrom,
      ctcAnnual: input.ctcAnnual,
      basic: input.basic,
      hra: input.hra,
      specialAllowance: input.specialAllowance ?? 0,
      conveyance: input.conveyance ?? 0,
      otherAllowances: (input.otherAllowances ?? {}) as never,
      employerPfMonthly,
      employerEsiMonthly,
      status: 'Proposed',
      proposedById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'salary_structure', subjectId: row.id, after: row, force: true });
  return row;
}

/** Approved by `salary_structures:approve`, and never by the proposer. */
export async function approveSalaryStructure(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'salary_structures', verb: 'approve' });

  const structure = await prisma.salaryStructure.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!structure) throw ApiError.notFound('Salary structure');
  if (structure.status === 'Approved') throw ApiError.conflict('This salary structure is already approved.');
  if (structure.proposedById && structure.proposedById === auth.partyId) {
    throw ApiError.forbidden(
      'The proposer of a salary structure cannot also approve it (Self-Dealing Bar).',
      [{ axis: 'WHO', passed: false, reason: 'proposer_is_approver' }],
    );
  }

  const before = structure;
  const row = await prisma.salaryStructure.update({
    where: { id },
    data: { status: 'Approved', approvedById: auth.partyId, approvedAt: new Date() },
  });
  await auditWrite({ action: 'update', subjectType: 'salary_structure', subjectId: row.id, before, after: row, force: true });
  return row;
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
 * Fills every statutory line on each instruction in the run from the
 * approved salary structure in force plus the dated rate tables.
 *
 * A contractor or consultant computes none of PF/ESI/PT/LWF — their
 * instruction is still marked computed, with `computedFrom.tdsSectionHint`
 * naming 194J so workstream C's TDS module has something to key off, and
 * `tdsAmount` left at whatever it already carries (CMP-PAY-004).
 *
 * An instruction with no approved structure in force is left uncomputed:
 * `computedFrom` stays null, which is exactly what blocks approval.
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

  const pfRow = await currentPfRateTableRow(periodEnd);
  const esiRow = await currentEsiRateTableRow(periodEnd);
  const ptRow = await currentPtSlabRow(periodEnd);
  const lwfRow = await currentLwfRateTableRow(periodEnd);

  let computed = 0;

  for (const instruction of instructions) {
    const employment = instruction.employmentRelationship;
    if (employment.engagementType !== 'employee') {
      await prisma.payrollInstruction.update({
        where: { id: instruction.id },
        data: {
          basicPay: 0,
          hra: 0,
          otherAllowances: instruction.grossAmount,
          pfEmployee: 0,
          pfEmployer: 0,
          epsEmployer: 0,
          esiEmployee: 0,
          esiEmployer: 0,
          professionalTax: 0,
          lwfEmployee: 0,
          lwfEmployer: 0,
          deductions: 0,
          netAmount: instruction.grossAmount,
          computedFrom: { engagementType: employment.engagementType, tdsSectionHint: '194J' } as never,
        },
      });
      computed += 1;
      continue;
    }

    const structure = await currentSalaryStructure(employment.id, periodEnd);
    if (!structure || !pfRow || !esiRow || !ptRow || !lwfRow) continue; // stays uncomputed on purpose

    const otherAllowancesTotal =
      num(structure.specialAllowance)! + num(structure.conveyance)! +
      Object.values((structure.otherAllowances as Record<string, number>) ?? {}).reduce((a, b) => a + Number(b), 0);
    const basic = num(structure.basic)!;
    const hra = num(structure.hra)!;
    const gross = basic + hra + otherAllowancesTotal;

    const tables = {
      pf: { employeeRate: num(pfRow.employeeRate)!, employerRate: num(pfRow.employerRate)!, epsRate: num(pfRow.epsRate)!, edliRate: num(pfRow.edliRate)!, adminRate: num(pfRow.adminRate)!, wageCeiling: num(pfRow.wageCeiling)!, voluntary: pfRow.voluntary },
      esi: { employeeRate: num(esiRow.employeeRate)!, employerRate: num(esiRow.employerRate)!, wageCeiling: num(esiRow.wageCeiling)! },
      pt: ptRow.slabs as unknown as PtSlab[],
      lwf: { employeeAmount: num(lwfRow.employeeAmount)!, employerAmount: num(lwfRow.employerAmount)!, dueMonth: lwfRow.dueMonth },
    };

    const lines = statutoryLines(gross, { basicPay: basic, hra, otherAllowances: otherAllowancesTotal }, tables, { payPeriod: run.payPeriod });

    await prisma.payrollInstruction.update({
      where: { id: instruction.id },
      data: {
        grossAmount: gross,
        basicPay: lines.basicPay,
        hra: lines.hra,
        otherAllowances: lines.otherAllowances,
        pfEmployee: lines.pfEmployee,
        pfEmployer: lines.pfEmployer,
        epsEmployer: lines.epsEmployer,
        esiEmployee: lines.esiEmployee,
        esiEmployer: lines.esiEmployer,
        professionalTax: lines.professionalTax,
        lwfEmployee: lines.lwfEmployee,
        lwfEmployer: lines.lwfEmployer,
        deductions: lines.totalDeductions,
        netAmount: lines.netAmount,
        computedFrom: { pfTableId: pfRow.id, esiTableId: esiRow.id, ptTableId: ptRow.id, lwfTableId: lwfRow.id, structureId: structure.id } as never,
      },
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
    grossAmount: unknown;
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
        where: { tenantId: auth.tenantId, employmentRelationshipId: { in: instructions.map((i) => i.employmentRelationshipId) } },
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
    const below = instructions.filter((i) => i.computedFrom != null && num(i.grossAmount as never)! < floor);
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
  await issuePayslipsForRun(run.id, run.payPeriod, instructions.map((i) => i.id));
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
            assignments: { where: { rowStatus: 'Effective' }, include: { position: { include: { job: true } } }, take: 1, orderBy: { effectiveFrom: 'desc' } },
          },
        },
      },
    });
    if (!instruction || instruction.computedFrom == null || instruction.payslipNumber) continue;

    const employment = instruction.employmentRelationship;
    const number = await nextDocumentNumber(DOCUMENT_SERIES.payslip, numbering.prefix, new Date(), numbering.yearFormat);

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
        uan: employment.uanNumber ?? null,
        esicNumber: employment.esicNumber ? `XXXX${employment.esicNumber.slice(-4)}` : null,
      },
      payPeriod,
      earnings: {
        basic: num(instruction.basicPay),
        hra: num(instruction.hra),
        otherAllowances: num(instruction.otherAllowances),
        gross: num(instruction.grossAmount),
      },
      deductions: {
        pf: num(instruction.pfEmployee),
        esi: num(instruction.esiEmployee),
        professionalTax: num(instruction.professionalTax),
        lwf: num(instruction.lwfEmployee),
        tds: num(instruction.tdsAmount),
        total: num(instruction.deductions),
      },
      net: num(instruction.netAmount),
      bankLast4: readRegulated(employment.bankAccountNumber)?.slice(-4) ?? null,
    };

    const payslip = await prisma.payslip.create({
      data: {
        tenantId: auth.tenantId,
        instructionId: instruction.id,
        employmentRelationshipId: employment.id,
        payPeriod,
        number,
        snapshot: snapshot as never,
      },
    });
    await prisma.payrollInstruction.update({ where: { id: instruction.id }, data: { payslipNumber: number, payslipIssuedAt: payslip.issuedAt } });
    await auditWrite({ action: 'create', subjectType: 'payslip', subjectId: payslip.id, after: payslip, force: true });
  }
}

export async function listPayslips(input: { employmentRelationshipId?: string; payPeriod?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'payslips', verb: 'view' });
  const scope = await scopeFor('payslips', 'view');
  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (input.payPeriod) where.payPeriod = input.payPeriod;

  if (scope !== 'all') {
    const own = await prisma.employmentRelationship.findMany({ where: { tenantId: auth.tenantId, personId: auth.partyId ?? '' }, select: { id: true } });
    where.employmentRelationshipId = { in: own.map((e) => e.id) };
  } else if (input.employmentRelationshipId) {
    where.employmentRelationshipId = input.employmentRelationshipId;
  }

  return prisma.payslip.findMany({ where, orderBy: { issuedAt: 'desc' } });
}

export async function getPayslip(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'payslips', verb: 'view' });
  const payslip = await prisma.payslip.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!payslip) throw ApiError.notFound('Payslip');

  const scope = await scopeFor('payslips', 'view');
  if (scope !== 'all') {
    const employment = await prisma.employmentRelationship.findFirst({ where: { id: payslip.employmentRelationshipId, tenantId: auth.tenantId }, select: { personId: true } });
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
    where: { payrollRunId, tenantId: auth.tenantId, pfEmployee: { gt: 0 } },
    include: { employmentRelationship: { include: { person: true } } },
  });

  const lines = instructions.map((i) => {
    const employment = i.employmentRelationship;
    const pfWage = num(i.basicPay) ?? 0;
    const epsWage = Math.min(pfWage, pfWage); // EPS wage equals capped basic already
    return [
      employment.uanNumber ?? '',
      employment.person.fullName,
      num(i.grossAmount),
      pfWage,
      epsWage,
      pfWage,
      num(i.pfEmployee),
      num(i.epsEmployer),
      num(i.pfEmployer),
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
    where: { payrollRunId, tenantId: auth.tenantId, esiEmployee: { gt: 0 } },
    include: { employmentRelationship: { include: { person: true } } },
  });

  const rows = ['IP Number,IP Name,Days,Wages,Reason Code'];
  for (const i of instructions) {
    const employment = i.employmentRelationship;
    rows.push([employment.esicNumber ?? '', employment.person.fullName, 26, num(i.grossAmount), ''].join(','));
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

  const employment = await prisma.employmentRelationship.findFirst({ where: { id: offboarding.employmentRelationshipId, tenantId: auth.tenantId } });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const asOf = employment.separationDate ?? new Date();
  const structure = await currentSalaryStructure(employment.id, asOf);
  const basicMonthly = structure ? num(structure.basic)! : num((await prisma.compensationRecord.findFirst({ where: { employmentRelationshipId: employment.id, status: 'Effective' }, orderBy: { effectiveFrom: 'desc' } }))?.basicPay) ?? 0;
  const grossMonthly = structure
    ? num(structure.basic)! + num(structure.hra)! + num(structure.specialAllowance)! + num(structure.conveyance)! +
      Object.values((structure.otherAllowances as Record<string, number>) ?? {}).reduce((a, b) => a + Number(b), 0)
    : basicMonthly;

  const months = Math.max(0, monthsBetween(employment.hireEffectiveDate, asOf));
  const grat = computeGratuity(basicMonthly, months);

  const encashableTypes = await prisma.leaveType.findMany({ where: { tenantId: auth.tenantId, encashable: true } });
  const balances = await prisma.leaveBalance.findMany({
    where: { tenantId: auth.tenantId, employmentRelationshipId: employment.id, leaveTypeId: { in: encashableTypes.map((t) => t.id) } },
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
      gratuityAmount: grat.amount,
      leaveEncashmentAmount,
      bonusAmount: bonusResult.amount,
      noticeRecoveryAmount,
      settlementAmount,
      settlementComputedAt: new Date(),
    },
  });
  await auditWrite({ action: 'update', subjectType: 'offboarding', subjectId: row.id, before, after: row, force: true });
  return { ...row, gratuityYears: grat.years, gratuityEligible: grat.eligible, encashDays };
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
  const before = await prisma.employmentRelationship.findFirst({ where: { id: employmentRelationshipId, tenantId: auth.tenantId } });
  if (!before) throw ApiError.notFound('Employment relationship');

  const row = await prisma.employmentRelationship.update({ where: { id: employmentRelationshipId }, data: { engagementType } });
  await auditWrite({ action: 'update', subjectType: 'employment_relationship', subjectId: row.id, before: { engagementType: before.engagementType }, after: { engagementType: row.engagementType }, force: true });
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
  const before = await prisma.employmentRelationship.findFirst({ where: { id: employmentRelationshipId, tenantId: auth.tenantId } });
  if (!before) throw ApiError.notFound('Employment relationship');

  // The account number and the name on it are regulated values: encrypted on
  // the way in, the way the privacy backfill leaves everything already on disk.
  const data = {
    ...input,
    ...(input.bankAccountNumber !== undefined ? { bankAccountNumber: encryptField(input.bankAccountNumber) } : {}),
    ...(input.bankAccountName !== undefined ? { bankAccountName: encryptField(input.bankAccountName) } : {}),
    ...(input.bankIfsc !== undefined ? { bankIfsc: encryptField(input.bankIfsc) } : {}),
  };
  const row = await prisma.employmentRelationship.update({ where: { id: employmentRelationshipId }, data });
  // Regulated values themselves never enter the diff — only that the fields changed.
  await auditWrite({
    action: 'update',
    subjectType: 'employment_relationship',
    subjectId: row.id,
    meta: { fieldsChanged: Object.keys(input) },
    force: true,
  });
  return { id: row.id, ok: true };
}
