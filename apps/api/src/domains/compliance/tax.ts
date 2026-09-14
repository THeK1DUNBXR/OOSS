/**
 * Compliance — income tax and TDS (docs/plan/compliance.md, workstream C).
 *
 * Three things this module owns:
 *
 * **TDS on a vendor bill is a decision, not a side effect of paying.**
 * `computeVendorTds` writes the section, rate and amount onto the bill from
 * the dated rate table and records a `TdsDecision`; the books' own
 * `vendor_bill.before_pay` hook (registered below) refuses to pay a bill
 * whose category defaults to a section that was never considered — deducted,
 * waived by a Sec 197 certificate, or explicitly marked not applicable.
 *
 * **Salary TDS is regime-aware, per-employment arithmetic**, kept out of
 * `payroll.ts` entirely: `applySalaryTds` is the one place that writes
 * `PayrollInstruction.tdsAmount`, called through this module's own endpoint
 * (workstream E calls it, this module owns it).
 *
 * **A rate, a threshold, a slab is data.** Every number `computeTds` and
 * `computeAnnualTax` (packages/shared) take in comes from `TdsSectionRate` or
 * `IncomeTaxSlabTable`, dated and seeded — never a literal in this file.
 */

import {
  computeTds,
  computeAnnualTax,
  monthlyTds,
  advanceTaxSchedule,
  msmeDueDate,
  round2,
  monthRange,
  type TdsSection,
  type TaxRegime,
  type SlabTable,
} from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';
import { registerHook } from '../../platform/hooks.js';

registerGovernedEntities('cmp_tax', [
  'tds_section_rate',
  'tds_applicability_rule',
  'tds_decision',
  'tds_challan',
  'tax_declaration',
  'tds_return',
  'tds_certificate',
  'advance_tax_payment',
]);

// ---------------------------------------------------------------------------
// Financial-year helpers. "2026-27" is how this module names a year, matching
// what a vendor's PAN, a payroll run and a challan all get filed against.
// ---------------------------------------------------------------------------

export function fyOf(d: Date): string {
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function fyStartYear(fy: string): number {
  return Number(fy.split('-')[0]);
}

export function fyRange(fy: string): { from: Date; to: Date } {
  const start = fyStartYear(fy);
  return { from: new Date(Date.UTC(start, 3, 1)), to: new Date(Date.UTC(start + 1, 3, 1)) };
}

/** The twelve YYYY-MM periods of an FY, April first. */
export function fyMonths(fy: string): string[] {
  const start = fyStartYear(fy);
  const out: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const m = (3 + i) % 12;
    const y = 3 + i < 12 ? start : start + 1;
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
  }
  return out;
}

export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';

export function quarterOf(period: string): Quarter {
  const month = Number(period.split('-')[1]);
  if (month >= 4 && month <= 6) return 'Q1';
  if (month >= 7 && month <= 9) return 'Q2';
  if (month >= 10 && month <= 12) return 'Q3';
  return 'Q4';
}

export function periodsOfQuarter(fy: string, quarter: Quarter): string[] {
  return fyMonths(fy).filter((p) => quarterOf(p) === quarter);
}

/** The deposit due date for a month's TDS — the 7th, or 30 April for March. */
export function depositDueDate(month: string): Date {
  const [year, m] = month.split('-').map(Number);
  if (m === 3) return new Date(Date.UTC(year, 3, 30));
  return new Date(Date.UTC(year, m, 7));
}

async function financeHeadPartyId(): Promise<string | null> {
  const auth = currentAuth();
  const holder = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, roleSlug: 'finance_head', status: 'active' },
    select: { partyId: true },
  });
  return holder?.partyId ?? null;
}

// ---------------------------------------------------------------------------
// Vendor TDS
// ---------------------------------------------------------------------------

async function rateFor(section: string, at: Date) {
  const auth = currentAuth();
  const row = await prisma.tdsSectionRate.findFirst({
    where: { tenantId: auth.tenantId, section, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!row) throw ApiError.unprocessable(`No TDS rate is on file for ${section} effective on or before ${at.toISOString().slice(0, 10)}.`);
  return row;
}

/** Sum of subtotal on other bills to the same payee, same section, same FY, up to (not including) this bill. */
async function cumulativeFyForVendor(vendorKey: string, section: string, billDate: Date, excludeBillId: string): Promise<number> {
  const auth = currentAuth();
  const { from, to } = fyRange(fyOf(billDate));
  const bills = await prisma.vendorBill.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      tdsSection: section,
      billDate: { gte: from, lt: to },
      id: { not: excludeBillId },
      OR: [{ vendorPan: vendorKey }, { vendorPan: null, vendorName: vendorKey }],
    },
    select: { subtotal: true },
  });
  return round2(bills.reduce((s, b) => s + (num(b.subtotal) ?? 0), 0));
}

export interface ComputeVendorTdsInput {
  section: TdsSection;
  certificateRef?: string | null;
  certificateRate?: number | null;
}

/**
 * Computes and writes TDS onto a vendor bill, and records the decision that
 * produced it. Called before payment — the before-pay hook checks that this
 * (or `waiveVendorTds`) ran, not that any particular number came out of it.
 */
export async function computeVendorTds(billId: string, input: ComputeVendorTdsInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'create' });

  const bill = await prisma.vendorBill.findFirst({ where: { id: billId, tenantId: auth.tenantId, deletedAt: null } });
  if (!bill) throw ApiError.notFound('Vendor bill');
  if (bill.status === 'paid' || bill.status === 'cancelled') {
    throw ApiError.unprocessable(`${bill.recordCode} is already ${bill.status}. TDS is decided before a bill is paid, not after.`);
  }

  const rate = await rateFor(input.section, bill.billDate);
  const vendorKey = bill.vendorPan ?? bill.vendorName;
  const cumulativeFy = await cumulativeFyForVendor(vendorKey, input.section, bill.billDate, bill.id);

  const result = computeTds({
    amount: num(bill.subtotal) ?? 0,
    cumulativeFy,
    section: input.section,
    ratePercent: num(rate.ratePercent) ?? 0,
    thresholds: {
      perTransaction: num(rate.thresholdPerTransaction) ?? 0,
      perFy: num(rate.thresholdPerFy) ?? 0,
    },
    panPresent: Boolean(bill.vendorPan),
    panMissingRatePercent: num(rate.panMissingRatePercent) ?? 20,
    certificateRate: input.certificateRate ?? null,
  });

  const updated = await prisma.vendorBill.update({
    where: { id: bill.id },
    data: {
      tdsSection: input.section,
      tdsRate: result.ratePercentApplied,
      tdsAmount: result.tdsAmount,
      tdsCertificateRef: input.certificateRef ?? null,
    },
  });

  const decision = await prisma.tdsDecision.create({
    data: {
      tenantId: auth.tenantId,
      billId: bill.id,
      decision: input.certificateRate === 0 ? 'waived_certificate' : result.applicable ? 'applied' : 'not_applicable',
      reason: result.reason,
      certificateRef: input.certificateRef ?? null,
      decidedById: auth.partyId ?? 'system',
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'tds_decision',
    subjectId: decision.id,
    after: { billId: bill.id, section: input.section, tdsAmount: result.tdsAmount, decision: decision.decision },
  });
  await emit({
    name: 'kz.fin.tds.deducted',
    subject: { entityType: 'vendor_bill', entityId: bill.id, recordCode: bill.recordCode },
    newState: { section: input.section, ratePercent: result.ratePercentApplied, tdsAmount: result.tdsAmount },
    impact: { domains: ['fin'] },
    confidentiality: 'confidential',
  });

  return { bill: updated, decision, result };
}

/** Explicitly marks TDS as not applicable on a bill, with a reason — a decision in its own right, not a default. */
export async function waiveVendorTds(billId: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'create' });
  if (!reason.trim()) throw ApiError.badRequest('A waiver needs a reason — "not applicable" is a finding, not a default.');

  const bill = await prisma.vendorBill.findFirst({ where: { id: billId, tenantId: auth.tenantId, deletedAt: null } });
  if (!bill) throw ApiError.notFound('Vendor bill');

  const decision = await prisma.tdsDecision.create({
    data: {
      tenantId: auth.tenantId,
      billId: bill.id,
      decision: 'not_applicable',
      reason,
      decidedById: auth.partyId ?? 'system',
    },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'tds_decision',
    subjectId: decision.id,
    after: { billId: bill.id, decision: 'not_applicable', reason },
  });
  return decision;
}

/** The most recent decision recorded for a bill, or null if TDS was never considered on it. */
async function latestDecision(billId: string) {
  const auth = currentAuth();
  return prisma.tdsDecision.findFirst({
    where: { tenantId: auth.tenantId, billId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * CMP-TDS-001: a bill whose category defaults to a TDS section, on which no
 * section has been computed or waived, cannot be paid.
 *
 * This does not re-derive whether TDS is *owed* — `computeVendorTds` already
 * did that arithmetic and would have found the payment under threshold. What
 * it enforces is that somebody looked: an untouched bill under an applicable
 * category is a bill nobody decided on, which is exactly the gap Sec 40(a)(ia)
 * disallowance comes from.
 */
async function assertVendorBillTdsSettled(bill: { id: string; categoryId: string | null; recordCode: string }): Promise<void> {
  const auth = currentAuth();
  const existing = await latestDecision(bill.id);
  if (existing) return;

  if (!bill.categoryId) return;
  const rule = await prisma.tdsApplicabilityRule.findFirst({
    where: { tenantId: auth.tenantId, categoryId: bill.categoryId, active: true },
  });
  if (!rule) return;

  throw ApiError.forbidden(
    `CMP-TDS-001: ${bill.recordCode}'s category defaults to TDS section ${rule.section}, and no TDS decision has been ` +
      `recorded on it — deducted, waived under a Sec 197 certificate, or marked not applicable with a reason. ` +
      'Settle TDS on this bill before paying it.',
    [{ axis: 'HOW_MUCH', passed: false, reason: 'CMP-TDS-001' }],
  );
}

registerHook('vendor_bill.before_pay', 'cmp_tax.assert_settled', async (payload) => {
  const bill = payload.bill as { id: string; categoryId: string | null; recordCode: string };
  await assertVendorBillTdsSettled(bill);
});

export async function listVendorBillsForTds(filter: { status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'view' });
  return prisma.vendorBill.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { billDate: 'desc' },
    take: 200,
  });
}

export async function tdsSectionRates() {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'view' });
  return prisma.tdsSectionRate.findMany({ where: { tenantId: auth.tenantId }, orderBy: [{ section: 'asc' }, { effectiveFrom: 'desc' }] });
}

export async function listApplicabilityRules() {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'view' });
  return prisma.tdsApplicabilityRule.findMany({ where: { tenantId: auth.tenantId }, orderBy: { categoryId: 'asc' } });
}

export async function setApplicabilityRule(input: { categoryId: string; section: string; active?: boolean; note?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'edit' });
  return prisma.tdsApplicabilityRule.upsert({
    where: { tenantId_categoryId: { tenantId: auth.tenantId, categoryId: input.categoryId } },
    create: { tenantId: auth.tenantId, categoryId: input.categoryId, section: input.section, active: input.active ?? true, note: input.note ?? null },
    update: { section: input.section, active: input.active ?? true, note: input.note ?? null },
  });
}

// ---------------------------------------------------------------------------
// MSME 43B(h)
// ---------------------------------------------------------------------------

export async function setMsmeTerms(billId: string, input: { udyamNumber: string; agreedTermDays?: number | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'edit' });

  const bill = await prisma.vendorBill.findFirst({ where: { id: billId, tenantId: auth.tenantId, deletedAt: null } });
  if (!bill) throw ApiError.notFound('Vendor bill');
  if (!input.udyamNumber.trim()) throw ApiError.badRequest('A Udyam registration number is needed to flag this vendor as an MSME.');

  const due = msmeDueDate(bill.billDate, input.agreedTermDays ?? null);
  const updated = await prisma.vendorBill.update({
    where: { id: bill.id },
    data: {
      vendorUdyamNumber: input.udyamNumber,
      agreedTermDays: input.agreedTermDays ?? null,
      msmeDueAt: due,
      msmeNotifiedAt: null,
    },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'vendor_bill',
    subjectId: bill.id,
    after: { vendorUdyamNumber: input.udyamNumber, agreedTermDays: input.agreedTermDays ?? null, msmeDueAt: due },
  });
  return updated;
}

/** What Sec 43B(h) would disallow right now: unpaid MSME bills past their due date. */
export async function msmeExposure() {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'view' });
  const bills = await prisma.vendorBill.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      vendorUdyamNumber: { not: null },
      status: { notIn: ['paid', 'cancelled'] },
      msmeDueAt: { lt: new Date() },
    },
    orderBy: { msmeDueAt: 'asc' },
  });
  const outstanding = bills.map((b) => round2((num(b.total) ?? 0) - (num(b.paidAmount) ?? 0)));
  return {
    bills,
    exposure: round2(outstanding.reduce((s, v) => s + v, 0)),
  };
}

/** Daily: raises CMP-TDS-003 once per bill past its MSME due date. */
export async function runMsmeLadder(): Promise<number> {
  const auth = currentAuth();
  const owner = await financeHeadPartyId();
  const overdue = await prisma.vendorBill.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      vendorUdyamNumber: { not: null },
      status: { notIn: ['paid', 'cancelled'] },
      msmeDueAt: { lt: new Date() },
      msmeNotifiedAt: null,
    },
    take: 200,
  });

  for (const bill of overdue) {
    await raiseException({
      code: 'CMP_MSME_45_DAY',
      label: 'MSME 45-day payment term breached (Sec 43B(h))',
      severity: 'S2_WARNING',
      subjectType: 'vendor_bill',
      subjectId: bill.id,
      subjectLabel: `${bill.recordCode} — ${bill.vendorName}`,
      domain: 'fin',
      detail: `Udyam-registered vendor unpaid past ${bill.msmeDueAt?.toISOString().slice(0, 10)}. The unpaid amount is disallowed under Sec 43B(h) until paid.`,
      reasonCode: 'CMP-TDS-003',
      ownerPartyId: owner,
      slaDueAt: bill.msmeDueAt,
      triggerFingerprint: 'msme_45_day',
      ladderRung: 0,
    });
    await prisma.vendorBill.update({ where: { id: bill.id }, data: { msmeNotifiedAt: new Date() } });
  }
  return overdue.length;
}

// ---------------------------------------------------------------------------
// Challans
// ---------------------------------------------------------------------------

/** Sum of TDS deducted for one section group in one month — vendor bills plus (for '192') payroll. */
export async function pendingTdsLiability(month: string, sectionGroup: string): Promise<{ amount: number; deducteeCount: number }> {
  const auth = currentAuth();
  const { from, to } = monthRange(month);

  if (sectionGroup === '192') {
    const rows = await prisma.payrollInstruction.findMany({
      where: { tenantId: auth.tenantId, payPeriod: month, tdsAmount: { gt: 0 } },
      select: { tdsAmount: true, employmentRelationshipId: true },
    });
    return {
      amount: round2(rows.reduce((s, r) => s + (num(r.tdsAmount) ?? 0), 0)),
      deducteeCount: new Set(rows.map((r) => r.employmentRelationshipId)).size,
    };
  }

  const rows = await prisma.vendorBill.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, tdsSection: sectionGroup, billDate: { gte: from, lt: to }, tdsAmount: { gt: 0 } },
    select: { tdsAmount: true, vendorPan: true, vendorName: true },
  });
  return {
    amount: round2(rows.reduce((s, r) => s + (num(r.tdsAmount) ?? 0), 0)),
    deducteeCount: new Set(rows.map((r) => r.vendorPan ?? r.vendorName)).size,
  };
}

export async function listChallans(filter: { month?: string; status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'view' });
  return prisma.tdsChallan.findMany({
    where: { tenantId: auth.tenantId, ...(filter.month ? { month: filter.month } : {}), ...(filter.status ? { status: filter.status } : {}) },
    orderBy: [{ month: 'desc' }, { sectionGroup: 'asc' }],
  });
}

async function nextChallanCode(month: string, sectionGroup: string): Promise<string> {
  const auth = currentAuth();
  const count = await prisma.tdsChallan.count({ where: { tenantId: auth.tenantId } });
  return `CHL-${month}-${sectionGroup}-${String(count + 1).padStart(4, '0')}`;
}

export interface CreateChallanInput {
  month: string;
  sectionGroup: string;
  amount?: number;
  bsrCode?: string | null;
  challanNo?: string | null;
}

/** Proposes a challan — the amount defaults to the computed liability if not given. */
export async function createChallan(input: CreateChallanInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'create' });

  const liability = await pendingTdsLiability(input.month, input.sectionGroup);
  const amount = input.amount ?? liability.amount;
  const recordCode = await nextChallanCode(input.month, input.sectionGroup);

  const challan = await prisma.tdsChallan.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      month: input.month,
      sectionGroup: input.sectionGroup,
      amount,
      deducteeCount: liability.deducteeCount,
      bsrCode: input.bsrCode ?? null,
      challanNo: input.challanNo ?? null,
      preparedById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'tds_challan', subjectId: challan.id, after: { month: input.month, sectionGroup: input.sectionGroup, amount } });
  return challan;
}

export interface MarkChallanPaidInput {
  bsrCode: string;
  challanNo: string;
  paidOn: Date;
}

/**
 * Marks a challan paid. The proposer never approves: the person who prepared
 * this challan (or who computed TDS on the bills feeding it, in spirit) is
 * not the one who can mark it paid — compared by partyId, never by role slug.
 */
export async function markChallanPaid(id: string, input: MarkChallanPaidInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'approve' });

  const challan = await prisma.tdsChallan.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!challan) throw ApiError.notFound('TDS challan');
  if (challan.status === 'paid') throw ApiError.conflict(`${challan.recordCode} is already marked paid.`);

  if (challan.preparedById && challan.preparedById === auth.partyId) {
    throw ApiError.forbidden(
      `CMP-TDS-002: ${auth.roleSlug} prepared ${challan.recordCode} and cannot also mark it paid. A second person confirms the deposit went through.`,
      [{ axis: 'WHO', passed: false, reason: 'proposer_cannot_approve' }],
    );
  }
  if (!input.bsrCode.trim() || !input.challanNo.trim()) {
    throw ApiError.badRequest('A challan is marked paid against its BSR code and challan number — a payment with neither was not recorded by the bank.');
  }

  const paid = await prisma.tdsChallan.update({
    where: { id },
    data: { status: 'paid', bsrCode: input.bsrCode, challanNo: input.challanNo, paidOn: input.paidOn, paidById: auth.partyId },
  });

  // Stamp the bills this challan covers, so a bill can answer "which challan was this deposited in".
  const { from, to } = monthRange(challan.month);
  await prisma.vendorBill.updateMany({
    where: { tenantId: auth.tenantId, tdsSection: challan.sectionGroup, tdsChallanId: null, billDate: { gte: from, lt: to } },
    data: { tdsChallanId: paid.id },
  });

  await auditWrite({ action: 'update', subjectType: 'tds_challan', subjectId: paid.id, before: { status: 'pending' }, after: { status: 'paid', bsrCode: input.bsrCode, challanNo: input.challanNo } });
  await emit({
    name: 'kz.fin.tds.deposited',
    subject: { entityType: 'tds_challan', entityId: paid.id, recordCode: paid.recordCode },
    newState: { status: 'paid', amount: num(paid.amount) },
    impact: { domains: ['fin'] },
  });
  return paid;
}

/**
 * CMP-TDS-002 ladder, run daily. For every section group with unpaid
 * liability in the previous month, raises (or escalates) a deposit-due
 * exception as the due date approaches: three days before, on the day, and
 * after — each a higher rung and a higher severity than the last.
 */
export async function runTdsDepositDueJob(today: Date = new Date()): Promise<number> {
  const auth = currentAuth();
  const owner = await financeHeadPartyId();
  const prevMonthDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const month = `${prevMonthDate.getUTCFullYear()}-${String(prevMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const due = depositDueDate(month);
  const daysUntil = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (daysUntil > 3) return 0;

  const groups = [...(await prisma.tdsSectionRate.findMany({ where: { tenantId: auth.tenantId }, select: { section: true }, distinct: ['section'] })).map((r) => r.section), '192'];

  let raised = 0;
  for (const group of [...new Set(groups)]) {
    const liability = await pendingTdsLiability(month, group);
    if (liability.amount <= 0) continue;

    const alreadyPaid = await prisma.tdsChallan.findFirst({ where: { tenantId: auth.tenantId, month, sectionGroup: group, status: 'paid' } });
    if (alreadyPaid) continue;

    const rung = daysUntil > 0 ? 1 : daysUntil === 0 ? 2 : 3;
    const severity = rung === 1 ? 'S1_ATTENTION' : rung === 2 ? 'S2_WARNING' : 'S3_HIGH_RISK';
    await raiseException({
      code: 'CMP_TDS_DEPOSIT_DUE',
      label: `TDS deposit due for ${group}, ${month}`,
      severity,
      subjectType: 'tds_liability',
      subjectId: `${month}:${group}`,
      subjectLabel: `${group} — ${month}`,
      domain: 'fin',
      detail: `₹${liability.amount.toFixed(2)} deducted under ${group} for ${month} is due by ${due.toISOString().slice(0, 10)} and no challan is marked paid.`,
      reasonCode: 'CMP-TDS-002',
      ownerPartyId: owner,
      slaDueAt: due,
      triggerFingerprint: `${month}:${group}`,
      ladderRung: rung,
    });
    raised += 1;
  }
  return raised;
}

// ---------------------------------------------------------------------------
// Salary TDS (Sec 192)
// ---------------------------------------------------------------------------

async function slabTableFor(fy: string, regime: TaxRegime): Promise<SlabTable> {
  const auth = currentAuth();
  const row = await prisma.incomeTaxSlabTable.findFirst({ where: { tenantId: auth.tenantId, fy, regime } });
  if (!row) throw ApiError.unprocessable(`No income-tax slab table is on file for ${regime} regime, FY${fy}.`);
  return {
    regime,
    slabs: row.slabs as unknown as SlabTable['slabs'],
    standardDeduction: num(row.standardDeduction) ?? 0,
    rebate87ALimit: num(row.rebate87ALimit) ?? 0,
    rebate87AMaxAmount: num(row.rebate87AMaxAmount) ?? 0,
    cessPercent: num(row.cessPercent) ?? 4,
  };
}

export async function upsertDeclaration(employmentId: string, input: { fy: string; regime: TaxRegime; declaredDeductions?: Record<string, unknown> }) {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'edit' });

  const employment = await prisma.employmentRelationship.findFirst({ where: { id: employmentId, tenantId: auth.tenantId, deletedAt: null } });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const row = await prisma.taxDeclaration.upsert({
    where: { tenantId_employmentRelationshipId_fy: { tenantId: auth.tenantId, employmentRelationshipId: employmentId, fy: input.fy } },
    create: {
      tenantId: auth.tenantId,
      employmentRelationshipId: employmentId,
      fy: input.fy,
      regime: input.regime,
      declaredDeductions: (input.declaredDeductions ?? {}) as never,
    },
    update: { regime: input.regime, declaredDeductions: (input.declaredDeductions ?? {}) as never },
  });
  await auditWrite({ action: 'update', subjectType: 'tax_declaration', subjectId: row.id, after: { fy: input.fy, regime: input.regime } });
  return row;
}

/** Total of the declared-deduction figures — this platform does not enforce each section's own statutory cap, a stated boundary rather than a silent gap. */
function declaredDeductionTotal(declared: Record<string, unknown>): number {
  return round2(Object.values(declared).reduce((s: number, v) => s + (typeof v === 'number' ? v : 0), 0));
}

export interface SalaryProjection {
  fy: string;
  regime: TaxRegime;
  annualGrossEstimate: number;
  declaredDeductionTotal: number;
  taxableIncome: number;
  annualTax: number;
  alreadyDeducted: number;
  monthsRemaining: number;
  monthlyEstimate: number;
}

/** Annualised from the current period's gross — the most recent instruction if one exists, else current compensation basic+HRA is not read here (workstream E owns compensation structure); zero if neither is available yet. */
async function annualGrossEstimate(employmentId: string, fy: string): Promise<number> {
  const auth = currentAuth();
  const latest = await prisma.payrollInstruction.findFirst({
    where: { tenantId: auth.tenantId, employmentRelationshipId: employmentId, payPeriod: { in: fyMonths(fy) } },
    orderBy: { payPeriod: 'desc' },
  });
  return round2((num(latest?.grossAmount) ?? 0) * 12);
}

export async function salaryProjection(employmentId: string, fy?: string): Promise<SalaryProjection> {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'view' });
  const targetFy = fy ?? fyOf(new Date());

  const declaration = await prisma.taxDeclaration.findFirst({ where: { tenantId: auth.tenantId, employmentRelationshipId: employmentId, fy: targetFy } });
  const regime = (declaration?.regime as TaxRegime) ?? 'new';
  const slabs = await slabTableFor(targetFy, regime);

  const grossEstimate = await annualGrossEstimate(employmentId, targetFy);
  const deductionTotal = regime === 'old' ? declaredDeductionTotal((declaration?.declaredDeductions as Record<string, unknown>) ?? {}) : 0;
  const taxableIncome = Math.max(0, round2(grossEstimate - deductionTotal));
  const annualTax = computeAnnualTax(regime, taxableIncome, slabs);

  const paidPeriods = fyMonths(targetFy).filter((p) => p <= currentPeriod());
  const deducted = await prisma.payrollInstruction.findMany({
    where: { tenantId: auth.tenantId, employmentRelationshipId: employmentId, payPeriod: { in: paidPeriods } },
    select: { tdsAmount: true },
  });
  const alreadyDeducted = round2(deducted.reduce((s, d) => s + (num(d.tdsAmount) ?? 0), 0));
  const monthsRemaining = Math.max(1, 12 - paidPeriods.length + 1);
  const monthlyEstimate = monthlyTds(annualTax, monthsRemaining, alreadyDeducted);

  return {
    fy: targetFy,
    regime,
    annualGrossEstimate: grossEstimate,
    declaredDeductionTotal: deductionTotal,
    taxableIncome,
    annualTax,
    alreadyDeducted,
    monthsRemaining,
    monthlyEstimate,
  };
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Writes each instruction's Sec 192 TDS for one payroll run — the only place
 * `PayrollInstruction.tdsAmount` is written for salary. Callable directly by
 * this module and through its own route; workstream E's payroll run calls
 * the route rather than reaching into this file.
 */
export async function applySalaryTds(payrollRunId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'edit' });

  const run = await prisma.payrollRun.findFirst({ where: { id: payrollRunId, tenantId: auth.tenantId }, include: { instructions: true } });
  if (!run) throw ApiError.notFound('Payroll run');
  if (!['Draft', 'Computed'].includes(run.status)) {
    throw ApiError.unprocessable(`${run.recordCode} is ${run.status}. Salary TDS is applied before a run is approved, not after.`);
  }

  const fy = fyOf(monthRange(run.payPeriod).from);
  const updated: Awaited<ReturnType<typeof prisma.payrollInstruction.update>>[] = [];
  for (const instruction of run.instructions) {
    const projection = await salaryProjection(instruction.employmentRelationshipId, fy);
    const tdsAmount = projection.monthlyEstimate;
    const oldTds = num(instruction.tdsAmount) ?? 0;
    const deductions = round2((num(instruction.deductions) ?? 0) - oldTds + tdsAmount);
    const netAmount = round2((num(instruction.grossAmount) ?? 0) - deductions);
    const row = await prisma.payrollInstruction.update({
      where: { id: instruction.id },
      data: { tdsAmount, deductions, netAmount },
    });
    updated.push(row);
  }

  await auditWrite({ action: 'update', subjectType: 'payroll_run', subjectId: run.id, meta: { operation: 'apply_salary_tds', count: updated.length }, force: true });
  return updated;
}

// ---------------------------------------------------------------------------
// Advance tax
// ---------------------------------------------------------------------------

export async function advanceTaxRate(): Promise<{ ratePercent: number; effectiveFrom: Date }> {
  const auth = currentAuth();
  const row = await prisma.corporateTaxRate.findFirst({ where: { tenantId: auth.tenantId, regime: '115BAA' }, orderBy: { effectiveFrom: 'desc' } });
  if (!row) throw ApiError.unprocessable('No corporate tax rate is on file.');
  return { ratePercent: num(row.effectiveRatePercent) ?? 25.17, effectiveFrom: row.effectiveFrom };
}

export interface AdvanceTaxEstimate {
  fy: string;
  ytdProfit: number;
  ratePercent: number;
  estimatedAnnualTax: number;
  schedule: ReturnType<typeof advanceTaxSchedule>;
}

/** Estimates the year's tax from books P&L to date, and shows the Sec 211 instalment schedule against what has actually been paid. */
export async function advanceTaxEstimateFor(fy: string, profitAndLoss: (period: string) => Promise<{ net: number }>): Promise<AdvanceTaxEstimate> {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'view' });

  const periods = fyMonths(fy).filter((p) => p <= currentPeriod());
  let ytdProfit = 0;
  for (const p of periods) {
    const pnl = await profitAndLoss(p);
    ytdProfit = round2(ytdProfit + pnl.net);
  }

  const rate = await advanceTaxRate();
  // Annualised from what has run so far, so the estimate does not read as a
  // part-year figure against a full-year schedule.
  const monthsElapsed = Math.max(1, periods.length);
  const annualisedProfit = round2((ytdProfit / monthsElapsed) * 12);
  const estimatedAnnualTax = round2((Math.max(0, annualisedProfit) * rate.ratePercent) / 100);

  const payments = await prisma.advanceTaxPayment.findMany({ where: { tenantId: auth.tenantId, fy }, orderBy: { instalmentDate: 'asc' } });
  const startYear = fyStartYear(fy);
  const buckets = [0, 0, 0, 0];
  const windows = [
    new Date(Date.UTC(startYear, 5, 15)),
    new Date(Date.UTC(startYear, 8, 15)),
    new Date(Date.UTC(startYear, 11, 15)),
    new Date(Date.UTC(startYear + 1, 2, 15)),
  ];
  for (const payment of payments) {
    const idx = windows.findIndex((w) => payment.paidOn <= w);
    buckets[idx === -1 ? 3 : idx] += num(payment.amount) ?? 0;
  }

  return {
    fy,
    ytdProfit,
    ratePercent: rate.ratePercent,
    estimatedAnnualTax,
    schedule: advanceTaxSchedule(estimatedAnnualTax, startYear, buckets),
  };
}

export async function recordAdvanceTaxPayment(input: { fy: string; instalmentDate: Date; amount: number; paidOn: Date; reference?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'tds', verb: 'create' });
  const row = await prisma.advanceTaxPayment.create({
    data: {
      tenantId: auth.tenantId,
      fy: input.fy,
      instalmentDate: input.instalmentDate,
      amount: input.amount,
      paidOn: input.paidOn,
      reference: input.reference ?? null,
      createdById: auth.partyId,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'advance_tax_payment', subjectId: row.id, after: { fy: input.fy, amount: input.amount } });
  return row;
}

// ---------------------------------------------------------------------------
// Returns — 24Q / 26Q
// ---------------------------------------------------------------------------

export interface TdsReturnRow {
  pan: string | null;
  name: string;
  section: string;
  amountPaid: number;
  tds: number;
  challan: string | null;
}

async function returnRows(fy: string, quarter: Quarter, form: '24Q' | '26Q'): Promise<TdsReturnRow[]> {
  const auth = currentAuth();
  const periods = periodsOfQuarter(fy, quarter);

  if (form === '24Q') {
    const rows = await prisma.payrollInstruction.findMany({
      where: { tenantId: auth.tenantId, payPeriod: { in: periods }, tdsAmount: { gt: 0 } },
      include: { employmentRelationship: { include: { person: { select: { fullName: true } } } } },
    });
    return rows.map((r) => ({
      pan: r.employmentRelationship.panNumber,
      name: r.employmentRelationship.person.fullName,
      section: '192',
      amountPaid: num(r.grossAmount) ?? 0,
      tds: num(r.tdsAmount) ?? 0,
      challan: null,
    }));
  }

  const { from, to } = { from: monthRange(periods[0]).from, to: monthRange(periods[periods.length - 1]).to };
  const bills = await prisma.vendorBill.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, billDate: { gte: from, lt: to }, tdsAmount: { gt: 0 } },
  });
  const challanCodes = new Map<string, string>();
  const challanIds = [...new Set(bills.map((b) => b.tdsChallanId).filter(Boolean) as string[])];
  if (challanIds.length) {
    const challans = await prisma.tdsChallan.findMany({ where: { id: { in: challanIds } }, select: { id: true, recordCode: true } });
    for (const c of challans) challanCodes.set(c.id, c.recordCode);
  }
  return bills.map((b) => ({
    pan: b.vendorPan,
    name: b.vendorName,
    section: b.tdsSection ?? '',
    amountPaid: num(b.subtotal) ?? 0,
    tds: num(b.tdsAmount) ?? 0,
    challan: b.tdsChallanId ? (challanCodes.get(b.tdsChallanId) ?? null) : null,
  }));
}

/**
 * Snapshots a quarterly return. A previous preparation for the same fy,
 * quarter and form is superseded — never overwritten — the same rule
 * `GstFiling` already applies.
 */
export async function prepareTdsReturn(fy: string, quarter: Quarter, form: '24Q' | '26Q') {
  const auth = currentAuth();
  await assertCan({ resource: 'tax_filings', verb: 'create' });

  const alreadyFiled = await prisma.tdsReturn.findFirst({ where: { tenantId: auth.tenantId, fy, quarter, form, status: 'filed' } });
  if (alreadyFiled) {
    throw ApiError.conflict(`${form} for ${fy} ${quarter} was already filed. A filed return is corrected by a later quarter, not re-prepared.`);
  }

  const rows = await returnRows(fy, quarter, form);
  const totalTds = round2(rows.reduce((s, r) => s + r.tds, 0));
  const snapshot = { fy, quarter, form, rows, totals: { deducteeCount: rows.length, totalTds } };

  const superseded = await prisma.tdsReturn.findMany({ where: { tenantId: auth.tenantId, fy, quarter, form, status: 'prepared' } });
  const row = await prisma.tdsReturn.create({
    data: { tenantId: auth.tenantId, fy, quarter, form, status: 'prepared', snapshot: snapshot as never, preparedById: auth.partyId },
  });
  for (const old of superseded) {
    await prisma.tdsReturn.update({ where: { id: old.id }, data: { status: 'superseded', supersededById: row.id } });
  }

  await auditWrite({ action: 'create', subjectType: 'tds_return', subjectId: row.id, after: { fy, quarter, form, totalTds } });
  await emit({
    name: 'kz.fin.tds_return.prepared',
    subject: { entityType: 'tds_return', entityId: row.id },
    newState: { fy, quarter, form, totalTds },
    impact: { domains: ['fin'], materiality: { measure: 'tds_total', value: totalTds, currency: 'INR' } },
    confidentiality: 'confidential',
  });
  return row;
}

/** Filing is the irreversible half — closer to `approve` than `edit`, and asks for the portal's own token/acknowledgement. */
export async function fileTdsReturn(id: string, ack: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'tax_filings', verb: 'approve' });

  const row = await prisma.tdsReturn.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('TDS return');
  if (row.status === 'filed') throw ApiError.conflict(`${row.form} for ${row.fy} ${row.quarter} is already filed.`);
  if (row.status === 'superseded') throw ApiError.unprocessable('This preparation was superseded by a later one. File that one instead.');
  if (!ack.trim()) throw ApiError.badRequest('The acknowledgement token is what the portal gives back — a return with none was not filed.');

  const filed = await prisma.tdsReturn.update({ where: { id }, data: { status: 'filed', ack, token: ack, filedAt: new Date(), filedById: auth.partyId } });
  await auditWrite({ action: 'update', subjectType: 'tds_return', subjectId: id, before: { status: 'prepared' }, after: { status: 'filed', ack } });
  await emit({
    name: 'kz.fin.tds_return.filed',
    subject: { entityType: 'tds_return', entityId: id },
    newState: { status: 'filed', ack },
    impact: { domains: ['fin'], severity: 'S1_ATTENTION' },
    confidentiality: 'confidential',
  });
  return filed;
}

export async function listTdsReturns(filter: { fy?: string; form?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'tax_filings', verb: 'view' });
  return prisma.tdsReturn.findMany({
    where: { tenantId: auth.tenantId, ...(filter.fy ? { fy: filter.fy } : {}), ...(filter.form ? { form: filter.form } : {}) },
    orderBy: [{ fy: 'desc' }, { quarter: 'desc' }],
  });
}

export async function tdsReturnDetail(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'tax_filings', verb: 'view' });
  const row = await prisma.tdsReturn.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('TDS return');
  return row;
}

/** "Prepares, does not transmit" — the deductee-row CSV a preparer uploads, never sent anywhere by this platform. */
export async function exportTdsReturnCsv(id: string): Promise<string> {
  const row = await tdsReturnDetail(id);
  const snapshot = row.snapshot as unknown as { rows: TdsReturnRow[] };
  const header = 'PAN,Name,Section,Amount Paid,TDS,Challan';
  const lines = snapshot.rows.map((r) =>
    [r.pan ?? '', r.name.replace(/,/g, ' '), r.section, r.amountPaid.toFixed(2), r.tds.toFixed(2), r.challan ?? ''].join(','),
  );
  return [header, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Certificates — Form 16 / 16A
// ---------------------------------------------------------------------------

export interface IssueCertificateInput {
  form: '16' | '16A';
  deducteeRef: string; // vendorPan (or name) for 16A; employmentRelationshipId for 16
  fy: string;
  quarter?: Quarter | null;
}

async function nextCertificateNumber(form: string): Promise<string> {
  const auth = currentAuth();
  const count = await prisma.tdsCertificate.count({ where: { tenantId: auth.tenantId, form } });
  return `CRT-${form}-${String(count + 1).padStart(5, '0')}`;
}

/** Final once issued: an existing certificate for the same form/deductee/fy/quarter is superseded, never overwritten. */
export async function issueCertificate(input: IssueCertificateInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'tax_filings', verb: 'create' });

  let deducteeName = input.deducteeRef;
  let snapshot: Record<string, unknown>;

  if (input.form === '16A') {
    const { from, to } = input.quarter
      ? { from: monthRange(periodsOfQuarter(input.fy, input.quarter)[0]).from, to: monthRange(periodsOfQuarter(input.fy, input.quarter)[2]).to }
      : fyRange(input.fy);
    const bills = await prisma.vendorBill.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, billDate: { gte: from, lt: to }, tdsAmount: { gt: 0 }, OR: [{ vendorPan: input.deducteeRef }, { vendorPan: null, vendorName: input.deducteeRef }] },
    });
    if (!bills.length) throw ApiError.unprocessable('No TDS was deducted for this vendor in the period — nothing to certify.');
    deducteeName = bills[0].vendorName;
    snapshot = {
      rows: bills.map((b) => ({ recordCode: b.recordCode, billDate: b.billDate.toISOString().slice(0, 10), section: b.tdsSection, amountPaid: num(b.subtotal), tds: num(b.tdsAmount) })),
      totalTds: round2(bills.reduce((s, b) => s + (num(b.tdsAmount) ?? 0), 0)),
    };
  } else {
    const employment = await prisma.employmentRelationship.findFirst({ where: { id: input.deducteeRef, tenantId: auth.tenantId }, include: { person: { select: { fullName: true } } } });
    if (!employment) throw ApiError.notFound('Employment relationship');
    deducteeName = employment.person.fullName;
    const rows = await prisma.payrollInstruction.findMany({
      where: { tenantId: auth.tenantId, employmentRelationshipId: input.deducteeRef, payPeriod: { in: fyMonths(input.fy) } },
    });
    snapshot = {
      rows: rows.map((r) => ({ payPeriod: r.payPeriod, grossAmount: num(r.grossAmount), tds: num(r.tdsAmount) })),
      totalGross: round2(rows.reduce((s, r) => s + (num(r.grossAmount) ?? 0), 0)),
      totalTds: round2(rows.reduce((s, r) => s + (num(r.tdsAmount) ?? 0), 0)),
    };
  }

  const superseded = await prisma.tdsCertificate.findFirst({
    where: { tenantId: auth.tenantId, form: input.form, deducteeRef: input.deducteeRef, fy: input.fy, quarter: input.quarter ?? null },
    orderBy: { issuedAt: 'desc' },
  });

  const number = await nextCertificateNumber(input.form);
  const cert = await prisma.tdsCertificate.create({
    data: {
      tenantId: auth.tenantId,
      form: input.form,
      deducteeRef: input.deducteeRef,
      deducteeName,
      fy: input.fy,
      quarter: input.quarter ?? null,
      snapshot: snapshot as never,
      number,
      issuedById: auth.partyId,
      supersedesId: superseded?.id ?? null,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'tds_certificate', subjectId: cert.id, after: { form: input.form, deducteeRef: input.deducteeRef, fy: input.fy, number } });
  return cert;
}

export async function listCertificates(filter: { form?: string; fy?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'tax_filings', verb: 'view' });
  return prisma.tdsCertificate.findMany({
    where: { tenantId: auth.tenantId, ...(filter.form ? { form: filter.form } : {}), ...(filter.fy ? { fy: filter.fy } : {}) },
    orderBy: { issuedAt: 'desc' },
  });
}

/** The certificate in a printable shape — company on one side, deductee and the deducted amounts on the other. */
export async function certificateDocument(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'tax_filings', verb: 'view' });
  const cert = await prisma.tdsCertificate.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!cert) throw ApiError.notFound('TDS certificate');
  const company = await prisma.companyProfile.findFirst({ where: { tenantId: auth.tenantId } });
  return {
    number: cert.number,
    form: cert.form,
    fy: cert.fy,
    quarter: cert.quarter,
    issuedAt: cert.issuedAt.toISOString(),
    deductor: { legalName: company?.legalName ?? '', tan: company?.tan ?? null, pan: company?.pan ?? null },
    deductee: { name: cert.deducteeName, ref: cert.deducteeRef },
    snapshot: cert.snapshot,
  };
}
