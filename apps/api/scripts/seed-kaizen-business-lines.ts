/**
 * One-off: enters Kaizen's five business lines (VERTICAL-TAXONOMY s.4.2) through
 * the governed createBusinessLine, so each one is permitted, audited and emitted
 * like any other registry write. Opus decision L: no migration seeds lines, and
 * no line literal lives in app code. This script is the only place the five
 * codes appear, and it is run by hand, once, by the owner.
 *
 *   tsx scripts/seed-kaizen-business-lines.ts \
 *     --tenant <slug> --as <founder-email> --effective-from YYYY-MM-DD --reason "<why>"
 *
 * The effective date and the reason have no default: the owner supplies both.
 * The actor needs org_design create. The script builds a human context without
 * step-up, so a grant that requires step-up refuses it, which is the intent.
 *
 * Re-running is safe. A code already in the registry is refused with a 409 and
 * reported as such; nothing is changed.
 */

import { unscopedPrisma } from '../src/platform/db.js';
import { newRequestContext, runWithContext, type AuthContext } from '../src/platform/context.js';
import { createBusinessLine } from '../src/domains/businessLines.js';
import { ROLE_CLASSIFICATION_CEILING, type SensitivityClass } from '@kaizen/shared';

const LINES = [
  {
    code: 'SKL',
    name: 'Skill Development',
    payerKind: 'sponsor_scheme_or_csr',
    revenueModel: 'programme_fees_in_tranches',
  },
  {
    code: 'EDU',
    name: 'Education',
    payerKind: 'self_paying_learner_or_institution',
    revenueModel: 'learner_fees_and_instalments',
  },
  {
    code: 'CLR',
    name: 'Corporate Learning',
    payerKind: 'enterprise_buying_for_own_staff',
    revenueModel: 'per_engagement_or_per_seat',
  },
  {
    code: 'TEC',
    name: 'Technology Services',
    payerKind: 'business_customer',
    revenueModel: 'project_subscription_managed_service',
  },
  {
    code: 'WFS',
    name: 'Workforce Solutions',
    payerKind: 'employer_on_joining',
    revenueModel: 'placement_fee_or_staffing_margin',
  },
] as const;

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

async function authFor(tenantSlug: string, email: string): Promise<AuthContext> {
  const tenant = await unscopedPrisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) throw new Error(`No tenant with slug "${tenantSlug}".`);
  const user = await unscopedPrisma.user.findFirst({
    where: { tenantId: tenant.id, email },
    include: { person: true },
  });
  if (!user) throw new Error(`${email} has no account in ${tenantSlug}.`);
  const affiliation = await unscopedPrisma.affiliation.findFirst({
    where: { partyId: user.personId, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  if (!affiliation) throw new Error(`${email} has no active affiliation in ${tenantSlug}.`);
  const roleSlug = affiliation.roleSlug ?? 'none';
  return {
    tenantId: tenant.id,
    principalType: 'human',
    partyId: user.personId,
    userId: user.id,
    agentId: null,
    onBehalfOfPartyId: null,
    affiliationId: affiliation.id,
    roleSlug,
    branch: user.branch,
    orgUnitId: null,
    classificationCeiling: (ROLE_CLASSIFICATION_CEILING[roleSlug] ?? 'internal') as SensitivityClass,
    purpose: 'operational',
    consentCodes: [],
    stepUpVerified: false,
  };
}

async function main() {
  const auth = await authFor(arg('tenant'), arg('as'));
  const effectiveFrom = arg('effective-from');
  const reason = arg('reason');
  for (const line of LINES) {
    try {
      const row = await runWithContext(newRequestContext({ auth }), () =>
        createBusinessLine({ ...line, effectiveFrom, reason }),
      );
      console.log(`created ${row.code} (${row.id})`);
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`not created ${line.code}: ${status ?? 'error'} ${message}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => unscopedPrisma.$disconnect());
