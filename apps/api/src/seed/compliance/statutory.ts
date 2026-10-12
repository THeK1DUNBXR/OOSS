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
  ];

  for (const rule of rules) {
    const existing = await prisma.statutoryRule.findFirst({
      where: {
        tenantId,
        domain: rule.domain,
        key: rule.key,
        jurisdiction: rule.jurisdiction,
        effectiveFrom: EFFECTIVE_FROM,
      },
    });
    if (!existing) {
      await prisma.statutoryRule.create({
        data: { tenantId, effectiveFrom: EFFECTIVE_FROM, ...rule, status: 'DRAFT', createdBy: SEED_CREATED_BY },
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
