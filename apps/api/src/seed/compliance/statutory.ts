import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { FOUNDER_DUTY, resolveDutyHolder, STATUTORY_APPROVER_DUTY } from '../../domains/statutory.js';

const EFFECTIVE_FROM = new Date('2025-09-22T00:00:00.000Z');

/**
 * The author of every seeded row. A marker, not a person: no human is the enterer of a
 * seed, so no human approver is ever the author (approveStatutoryRule refuses the
 * author). Every seeded row is DRAFT, and a test asserts that none is APPROVED (G10 c(3)).
 */
export const SEED_CREATED_BY = 'system:statutory-seed';

/**
 * Every seeded source is prefixed UNVERIFIED: and says what it rests on. These are not
 * notification numbers and none has been checked against a gazette. approveStatutoryRule
 * refuses such a row unless the approver supplies a citation to replace it.
 */
const UNVERIFIED = 'UNVERIFIED: ';

/**
 * The payroll rates, moved from the typed rate tables (S10). Each value is copied exactly from
 * seed/compliance/payroll.ts, which is where the tables were seeded: rates are integer parts per
 * million, money is integer paise, and every number is a string, as ruleIntegerField reads it.
 *
 * None of the rate-table seeds carries a notification reference, so each source says so. The
 * UNVERIFIED prefix is what makes approval ask for a citation (approvalSource), which is the point:
 * a rate with no citation is not approved by the seed or by a person who only copies it.
 *
 * The rate tables stay in place and are no longer read by payroll. A row here is the one payroll
 * reads, and only when it is APPROVED and in force on the pay month.
 */
const PAYROLL_EFFECTIVE_FROM = new Date('2024-04-01T00:00:00.000Z');

export const PAYROLL_RULE_SEEDS = [
  {
    domain: 'pf',
    key: 'pf.rates',
    jurisdiction: 'IN',
    effectiveFrom: PAYROLL_EFFECTIVE_FROM,
    value: {
      employeeRatePpm: '120000',
      employerRatePpm: '120000',
      epsRatePpm: '83300',
      edliRatePpm: '5000',
      adminRatePpm: '5000',
      wageCeilingMinor: '1500000',
      voluntary: false,
    },
    source: `${UNVERIFIED}migrated from pfRateTable seed, source not recorded.`,
  },
  {
    domain: 'esi',
    key: 'esi.rates',
    jurisdiction: 'IN',
    effectiveFrom: PAYROLL_EFFECTIVE_FROM,
    value: {
      employeeRatePpm: '7500',
      employerRatePpm: '32500',
      wageCeilingMinor: '2100000',
    },
    source: `${UNVERIFIED}migrated from esiRateTable seed, source not recorded.`,
  },
  {
    domain: 'pt',
    key: 'pt.tn_slabs',
    jurisdiction: 'IN-TN',
    effectiveFrom: PAYROLL_EFFECTIVE_FROM,
    value: {
      state: 'TN',
      slabs: [
        { minGrossMinor: '0', maxGrossMinor: '2100000', halfYearlyAmountMinor: '0' },
        { minGrossMinor: '2100100', maxGrossMinor: '3000000', halfYearlyAmountMinor: '13500' },
        { minGrossMinor: '3000100', maxGrossMinor: '4500000', halfYearlyAmountMinor: '31500' },
        { minGrossMinor: '4500100', maxGrossMinor: '6000000', halfYearlyAmountMinor: '69000' },
        { minGrossMinor: '6000100', maxGrossMinor: '7500000', halfYearlyAmountMinor: '102500' },
        { minGrossMinor: '7500100', maxGrossMinor: null, halfYearlyAmountMinor: '125000' },
      ],
      confirmNote:
        'Confirm against the Greater Chennai Corporation (or the applicable local body) professional tax schedule currently in force.',
    },
    source: `${UNVERIFIED}migrated from professionalTaxSlabTable seed (TN), source not recorded.`,
  },
  {
    domain: 'lwf',
    key: 'lwf.tn_contribution',
    jurisdiction: 'IN-TN',
    effectiveFrom: PAYROLL_EFFECTIVE_FROM,
    value: {
      state: 'TN',
      employeeAmountMinor: '2000',
      employerAmountMinor: '4000',
      dueMonth: 12,
      confirmNote:
        'Confirm the current Tamil Nadu Labour Welfare Fund Act contribution against the latest notification.',
    },
    source: `${UNVERIFIED}migrated from lwfRateTable seed (TN), source not recorded.`,
  },
];

/**
 * The pack is deliberately marked for legal verification. It makes the
 * effective-dated shape available without pretending that this seed is a
 * gazette or a substitute for counsel's sign-off.
 */
export async function seedStatutory(): Promise<void> {
  const tenantId = currentAuth().tenantId;
  const rules = [
    {
      domain: 'gst',
      key: 'gst.rate.slabs',
      jurisdiction: 'IN',
      value: { status: 'needs_legal_verification', rates: ['0', '5', '18', '40'], effectiveDate: '2025-09-22' },
      source: `${UNVERIFIED}Phase 3 brief; verify against the applicable CBIC notification before production use.`,
    },
    {
      domain: 'pf',
      key: 'pf.wage_ceiling',
      jurisdiction: 'IN',
      value: { status: 'needs_legal_verification', amountMinor: '1500000', currency: 'INR' },
      source: `${UNVERIFIED}Phase 3 brief; verify current EPF Scheme notification before production use.`,
    },
    {
      domain: 'esi',
      key: 'esi.contribution_period',
      jurisdiction: 'IN',
      value: { status: 'needs_legal_verification', periods: ['APR-SEP', 'OCT-MAR'] },
      source: `${UNVERIFIED}Phase 3 brief; verify current ESIC notification before production use.`,
    },
    {
      domain: 'pt',
      key: 'pt.local_body_schedule',
      jurisdiction: 'IN-TN',
      value: { status: 'needs_local_body_confirmation', localBodyRequired: true, slabs: [] },
      source: `${UNVERIFIED}Tamil Nadu local-body schedule must be supplied per municipality before payroll use.`,
    },
    {
      domain: 'tds',
      key: 'tds.forms',
      jurisdiction: 'IN',
      value: { status: 'needs_gazette_verification', forms: {} },
      source: `${UNVERIFIED}Read the current Income-tax Rules and notified appendices before generating certificates.`,
    },
    // The two figures that were constants in code (S10). Each carries its own start date, because
    // a rate in force since 2020 must resolve for a transfer made in 2020: the pack's common start
    // would leave every earlier transfer refused.
    {
      domain: 'stamp_duty',
      key: 'stamp_duty.share_transfer_rate',
      jurisdiction: 'IN',
      effectiveFrom: new Date('2020-07-01T00:00:00.000Z'),
      value: { ratePpm: '150' },
      source: `${UNVERIFIED}Indian Stamp Act, 1899, Schedule I (Article 62) as amended by the Finance Act, 2019, w.e.f. 1 July 2020: transfer 0.015%, issue 0.005%. Verify the notification and the state Stamp Act that applies to the company before approval.`,
    },
    {
      domain: 'gratuity',
      key: 'gratuity.factor',
      jurisdiction: 'IN',
      effectiveFrom: new Date('1972-09-16T00:00:00.000Z'),
      value: { daysPerYear: '15', daysPerMonth: '26' },
      source: `${UNVERIFIED}Payment of Gratuity Act, 1972, s.4(2): 15 days' wages per completed year, month taken as 26 days. Commencement date not yet verified.`,
    },
    ...PAYROLL_RULE_SEEDS,
  ];

  for (const rule of rules) {
    const effectiveFrom = rule.effectiveFrom ?? EFFECTIVE_FROM;
    const existing = await prisma.statutoryRule.findFirst({
      where: {
        tenantId,
        domain: rule.domain,
        key: rule.key,
        jurisdiction: rule.jurisdiction,
        effectiveFrom,
      },
    });
    if (!existing) {
      await prisma.statutoryRule.create({
        data: {
          tenantId,
          domain: rule.domain,
          key: rule.key,
          jurisdiction: rule.jurisdiction,
          effectiveFrom,
          value: rule.value,
          source: rule.source,
          status: 'DRAFT',
          createdBy: SEED_CREATED_BY,
        },
      });
    } else if (existing.status === 'DRAFT' && existing.createdBy === null) {
      // A seed row written before the marker existed. Only a DRAFT with no author
      // is touched: a row a person entered has an author and is never overwritten here.
      await prisma.statutoryRule.update({
        where: { id: existing.id },
        data: { source: rule.source, createdBy: SEED_CREATED_BY },
      });
    }
  }
}

/** The assignedBy of a seeded holder row: no human granted it, so no human is named. */
const SEED_DUTY_ASSIGNED_BY = 'system:statutory-seed';

/**
 * Names the owner's person as founder and as statutory approver, once. Owner ruling, 2026-10-12:
 * "the founder (unless changed during onboarding)" holds the approver duty. Onboarding may name
 * another holder, so a tenant that already has a founder is left alone: a second run changes
 * nothing, and a duty onboarding named stays named.
 *
 * Called from bootstrap after the founding accounts are written, not from seedStatutory: the
 * seed runs compliance before the accounts, so the owner's person does not exist yet there.
 *
 * The person is the one bootstrap wrote the owner account to, passed in rather than looked up
 * by role. The role alone is not unique: the demo dataset loads a second active affiliation with
 * the chairman role, so a lookup by role would find two people and name neither. The affiliation
 * is still checked: no active owner-role affiliation means nothing is assigned, and the seed says so.
 */
export async function seedFounderDuty(ownerPartyId: string, ownerRoleSlug: string): Promise<void> {
  const tenantId = currentAuth().tenantId;
  if (await resolveDutyHolder(FOUNDER_DUTY)) return;
  const affiliation = await prisma.affiliation.findFirst({
    where: { tenantId, partyId: ownerPartyId, roleSlug: ownerRoleSlug, status: 'active' },
    select: { id: true },
  });
  if (!affiliation) {
    console.log(`  founder duty not assigned: the owner's person holds no active ${ownerRoleSlug} affiliation`);
    return;
  }
  const founderId = ownerPartyId;
  const effectiveFrom = new Date();
  await prisma.dutyAssignment.create({
    data: { tenantId, dutyKey: FOUNDER_DUTY, partyId: founderId, effectiveFrom, assignedBy: SEED_DUTY_ASSIGNED_BY },
  });
  if (!(await resolveDutyHolder(STATUTORY_APPROVER_DUTY))) {
    await prisma.dutyAssignment.create({
      data: {
        tenantId,
        dutyKey: STATUTORY_APPROVER_DUTY,
        partyId: founderId,
        effectiveFrom,
        assignedBy: SEED_DUTY_ASSIGNED_BY,
      },
    });
  }
}
