/**
 * Compliance calendar — the statutory obligation set (docs/plan/compliance.md,
 * workstream A). Idempotent upserts by `code`, so re-running the seed against
 * a tenant that already has these types only ever updates them in place.
 *
 * Due-date arithmetic is data here, never a constant in domain code
 * (Principle 1) — see `nextDueDates` in
 * `packages/shared/src/compliance/calendar.ts` for how each `dueRule` shape
 * is read.
 */

import { unscopedPrisma } from '../../platform/db.js';
import { currentTenantId } from '../../platform/context.js';
import type { Prisma } from '@prisma/client';

interface TypeSeed {
  code: string;
  label: string;
  governingLaw: string;
  section: string;
  domain: 'fin' | 'hr' | 'gov' | 'edu';
  recurrence: 'monthly' | 'quarterly' | 'half_yearly' | 'annual' | 'one_off';
  dueRule: Prisma.InputJsonValue;
  ownerRoleSlug: string;
  evidenceRequired: boolean;
  note?: string;
}

const TYPES: TypeSeed[] = [
  {
    code: 'GSTR1',
    label: 'GSTR-1 — outward supplies',
    governingLaw: 'CGST Act 2017',
    section: 'Sec 37',
    domain: 'fin',
    recurrence: 'monthly',
    dueRule: { day: 11 },
    ownerRoleSlug: 'finance_head',
    evidenceRequired: false,
  },
  {
    code: 'GSTR3B',
    label: 'GSTR-3B — monthly summary return',
    governingLaw: 'CGST Act 2017',
    section: 'Sec 39',
    domain: 'fin',
    recurrence: 'monthly',
    dueRule: { day: 20 },
    ownerRoleSlug: 'finance_head',
    evidenceRequired: false,
  },
  {
    code: 'TDS_DEPOSIT',
    label: 'TDS deposit (challan)',
    governingLaw: 'Income-tax Act 1961',
    section: 'Sec 200',
    domain: 'fin',
    recurrence: 'monthly',
    // The 7th of next month, except March's deduction, deposited by 30 April.
    dueRule: { day: 7, overrides: { '3': { month: 4, day: 30 } } },
    ownerRoleSlug: 'finance_head',
    evidenceRequired: false,
  },
  {
    code: 'TDS_24Q',
    label: 'TDS return 24Q (salary)',
    governingLaw: 'Income-tax Act 1961',
    section: 'Sec 200(3)',
    domain: 'fin',
    recurrence: 'quarterly',
    // Calendar quarters Q1 Jan-Mar..Q4 Oct-Dec due 31 May / 31 Jul / 31 Oct / 31 Jan(+1y).
    dueRule: {
      quarterDates: [
        { month: 5, day: 31 },
        { month: 7, day: 31 },
        { month: 10, day: 31 },
        { month: 1, day: 31, yearOffset: 1 },
      ],
    },
    ownerRoleSlug: 'finance_head',
    evidenceRequired: false,
  },
  {
    code: 'TDS_26Q',
    label: 'TDS return 26Q (non-salary)',
    governingLaw: 'Income-tax Act 1961',
    section: 'Sec 200(3)',
    domain: 'fin',
    recurrence: 'quarterly',
    dueRule: {
      quarterDates: [
        { month: 5, day: 31 },
        { month: 7, day: 31 },
        { month: 10, day: 31 },
        { month: 1, day: 31, yearOffset: 1 },
      ],
    },
    ownerRoleSlug: 'finance_head',
    evidenceRequired: false,
  },
  {
    code: 'PF_ECR',
    label: 'PF ECR',
    governingLaw: 'EPF & MP Act 1952',
    section: 'Para 38',
    domain: 'hr',
    recurrence: 'monthly',
    dueRule: { day: 15 },
    ownerRoleSlug: 'hr_ops_manager',
    evidenceRequired: false,
  },
  {
    code: 'ESI_CONTRIB',
    label: 'ESI contribution',
    governingLaw: 'ESI Act 1948',
    section: 'Reg 31',
    domain: 'hr',
    recurrence: 'monthly',
    dueRule: { day: 15 },
    ownerRoleSlug: 'hr_ops_manager',
    evidenceRequired: false,
  },
  {
    code: 'PT_TN',
    label: 'Tamil Nadu Professional Tax',
    governingLaw: 'Tamil Nadu Tax on Professions, Trades, Callings and Employments Act 1992',
    section: '-',
    domain: 'hr',
    recurrence: 'half_yearly',
    // H1 (Apr-Sep) due 30 Sep, H2 (Oct-Mar) due 31 Mar the following year.
    dueRule: { halfYearDates: [{ month: 9, day: 30 }, { month: 3, day: 31, yearOffset: 1 }] },
    ownerRoleSlug: 'hr_ops_manager',
    evidenceRequired: false,
    note: "Half-yearly due dates are the common Tamil Nadu corporation schedule — confirm against the company's own PT enrolment and municipal jurisdiction before relying on them.",
  },
  {
    code: 'ADVANCE_TAX',
    label: 'Advance tax instalment',
    governingLaw: 'Income-tax Act 1961',
    section: 'Sec 211',
    domain: 'fin',
    recurrence: 'quarterly',
    dueRule: {
      quarterDates: [
        { month: 3, day: 15 },
        { month: 6, day: 15 },
        { month: 9, day: 15 },
        { month: 12, day: 15 },
      ],
    },
    ownerRoleSlug: 'finance_head',
    evidenceRequired: false,
  },
  {
    code: 'AOC4',
    label: 'AOC-4 — financial statements filing',
    governingLaw: 'Companies Act 2013',
    section: 'Sec 137',
    domain: 'gov',
    recurrence: 'annual',
    // Statutorily 30 days after the AGM; 30 Oct is the default assuming a 30
    // September AGM, and is only that — a default.
    dueRule: { month: 10, day: 30 },
    ownerRoleSlug: 'finance_head',
    evidenceRequired: true,
    note: 'Due 30 days after the AGM. 30 October assumes the AGM was held by 30 September — recompute against the actual AGM date each year.',
  },
  {
    code: 'MGT7',
    label: 'MGT-7 — annual return',
    governingLaw: 'Companies Act 2013',
    section: 'Sec 92',
    domain: 'gov',
    recurrence: 'annual',
    // 60 days after the AGM; 29 Nov assumes the same 30 September AGM.
    dueRule: { month: 11, day: 29 },
    ownerRoleSlug: 'finance_head',
    evidenceRequired: true,
    note: 'Due 60 days after the AGM. 29 November assumes the AGM was held by 30 September — recompute against the actual AGM date each year.',
  },
  {
    code: 'DIR3_KYC',
    label: 'DIR-3 KYC',
    governingLaw: 'Companies Act 2013',
    section: 'Rule 12A, Companies (Appointment and Qualification of Directors) Rules 2014',
    domain: 'gov',
    recurrence: 'annual',
    dueRule: { month: 9, day: 30 },
    ownerRoleSlug: 'finance_head',
    evidenceRequired: false,
  },
  {
    code: 'POSH_ANNUAL',
    label: 'POSH annual report',
    governingLaw: 'Sexual Harassment of Women at Workplace (Prevention, Prohibition and Redressal) Act 2013',
    section: 'Sec 21',
    domain: 'hr',
    recurrence: 'annual',
    // Filed for the calendar year, by 31 January of the following year.
    dueRule: { month: 1, day: 31 },
    ownerRoleSlug: 'hr_ops_manager',
    evidenceRequired: true,
  },
  {
    code: 'ITR_COMPANY',
    label: 'Income tax return (company)',
    governingLaw: 'Income-tax Act 1961',
    section: 'Sec 139',
    domain: 'fin',
    recurrence: 'annual',
    dueRule: { month: 10, day: 31 },
    ownerRoleSlug: 'finance_head',
    evidenceRequired: true,
  },
  {
    code: 'FORM16',
    label: 'Form 16 issue',
    governingLaw: 'Income-tax Act 1961',
    section: 'Sec 203',
    domain: 'fin',
    recurrence: 'annual',
    dueRule: { month: 6, day: 15 },
    ownerRoleSlug: 'finance_head',
    evidenceRequired: true,
  },
  {
    code: 'GSTR9',
    label: 'GSTR-9 — annual return',
    governingLaw: 'CGST Act 2017',
    section: 'Sec 44',
    domain: 'fin',
    recurrence: 'annual',
    dueRule: { month: 12, day: 31 },
    ownerRoleSlug: 'finance_head',
    evidenceRequired: false,
  },
];

export async function seedCalendar(): Promise<void> {
  const tenantId = currentTenantId();
  for (const t of TYPES) {
    await unscopedPrisma.complianceObligationType.upsert({
      where: { tenantId_code: { tenantId, code: t.code } },
      create: {
        tenantId,
        code: t.code,
        label: t.label,
        governingLaw: t.governingLaw,
        section: t.section,
        domain: t.domain,
        recurrence: t.recurrence,
        dueRule: t.dueRule,
        ownerRoleSlug: t.ownerRoleSlug,
        evidenceRequired: t.evidenceRequired,
        active: true,
        note: t.note ?? null,
      },
      update: {
        label: t.label,
        governingLaw: t.governingLaw,
        section: t.section,
        domain: t.domain,
        recurrence: t.recurrence,
        dueRule: t.dueRule,
        ownerRoleSlug: t.ownerRoleSlug,
        evidenceRequired: t.evidenceRequired,
        note: t.note ?? null,
      },
    });
  }
}
