/**
 * Seeds a complete, working tenant: governance, pipelines, catalog, agents,
 * surfaces, and a realistic demo dataset across every domain, so every screen
 * has real data behind it rather than an empty state.
 *
 * Idempotent: safe to re-run. Notably, running the pipeline twice in a row does
 * NOT alter GRANT records — the file-overwrites-database anti-pattern that made
 * the legacy migration a live data-loss hazard is retired.
 */

import { randomUUID } from 'node:crypto';
import {
  AI_TOUCHPOINTS,
  EVENTS,
  type DeliveryModel,
  type RevenueTreatment,
  type Vertical,
} from '@kaizen/shared';
import { prisma, unscopedPrisma } from '../platform/db.js';
import { asSystem, runWithContext, newRequestContext } from '../platform/context.js';
import { hashPassword } from '../lib/auth.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ROLE_DEFINITIONS, ROLE_GRANT_MATRIX, parseCell } from './grants.js';
import { PIPELINE_SEEDS, RETIRED_POST_AWARD_STAGES, transitionsFor } from './pipelines.js';
import { registerSubscribers } from '../events/handlers.js';
import { computeAndPersistAll } from '../domains/health.js';
import { runJobsForTenant } from '../jobs/scheduler.js';
import { findOrCreatePerson } from '../domains/identity.js';

const TENANT_SLUG = 'kaizen';
const PASSWORD = 'kaizen2026';

const TAMIL_NADU_DISTRICTS = [
  'Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem', 'Tirunelveli',
  'Erode', 'Vellore', 'Thanjavur', 'Dindigul', 'Kanchipuram', 'Cuddalore',
];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 86_400_000);
}

async function main() {
  console.log('Seeding the Kaizen platform…\n');

  // -------------------------------------------------------------------------
  // Tenant
  // -------------------------------------------------------------------------
  const tenant = await unscopedPrisma.tenant.upsert({
    where: { slug: TENANT_SLUG },
    create: {
      slug: TENANT_SLUG,
      name: 'Kaizen Infinities',
      status: 'active',
      config: {
        // The explicit bootstrap authority set, owned by SYS: who may create
        // the first POLICY or GRANT for a new tenant. This breaks the
        // circularity of the permission system needing permission to create
        // itself.
        bootstrapAuthoritySet: ['chairman', 'system_admin'],
        forecastPeriod: 'quarter',
        baseCurrency: 'INR',
      },
    },
    update: {},
  });
  console.log(`tenant  ${tenant.name} (${tenant.id})`);

  registerSubscribers();

  await asSystem(tenant.id, async () => {
    await seedThresholds();
    await seedSensitivityRegistrations();
    const { policyVersionId } = await seedGovernance();
    await seedGrants(policyVersionId);
    await seedPipelines();
    const people = await seedPeopleAndUsers();
    await seedAuthorityGrants(people);
    await seedAgents();
    await seedSurfaces();
    const catalog = await seedCatalog();
    await seedTerritoriesAndRouting(people);
    const orgs = await seedOrganizations();
    await seedCommercialDataset(people, orgs, catalog);
    await seedEducation(people, orgs);
    await seedDecisions(people);
    await seedMergeCandidate(people);
    console.log('\ncomputing health scores…');
    await computeAndPersistAll();
  });

  console.log('running detectors so the surfaces have live exceptions…');
  await runJobsForTenant(tenant.id, {
    jobNames: [
      'runMouExpiryJob',
      'runContractExpiryJob',
      'runLeadUntouchedJob',
      'runStageAgeBreachJob',
      'runProposalPendingJob',
      'runPaymentPendingJob',
      'runOfferingCoverageJob',
      'runWinLossOverdueJob',
      'runDailyMetricsJob',
      'runHealthScoreJob',
    ],
  });

  console.log('\n─────────────────────────────────────────────');
  console.log('Sign in at http://localhost:5173');
  console.log(`Password for every account: ${PASSWORD}\n`);
  console.log('  chairman@kaizen.co.in          Chairman — Command Center');
  console.log('  sysadmin@kaizen.co.in          System Administrator (no domain authority)');
  console.log('  bhead@kaizen.co.in             Business Head — first approval tier');
  console.log('  director@kaizen.co.in          Director — second approval tier');
  console.log('  controller@kaizen.co.in        Finance Controller — discount authority');
  console.log('  arun@kaizen.co.in              Sales');
  console.log('  divya@kaizen.co.in             Telecaller (own-scoped)');
  console.log('  meera@kaizen.co.in             Education Counsellor (own_or_unowned)');
  console.log('  ravi@kaizen.co.in              Trainer (batch_member scoped)');
  console.log('  kavitha@kaizen.co.in           Project Manager');
  console.log('  suresh@kaizen.co.in            Workforce & Placement');
  console.log('  priya@kaizen.co.in             Marketing');
  console.log('  latha@kaizen.co.in             Finance');
  console.log('  multi@kaizen.co.in             Holds three affiliations — try the context switcher');
  console.log('─────────────────────────────────────────────\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Thresholds — every unvalidated constant ships as a tunable row from day one
// ---------------------------------------------------------------------------

async function seedThresholds() {
  const tenantId = (await currentTenant()).id;
  const rows = [
    { thresholdKey: 'command_center.materiality_floor', value: 100_000, unit: 'currency', description: 'Below this, a delta item does not earn a place on the Command Center.' },
    { thresholdKey: 'command_center.narrative_window_hours', value: 72, unit: 'hours', description: 'Past this absence, the surface leads with the NARRATIVE object instead of an item list. Flagged as unvalidated — instrument actual return behaviour before trusting it.' },
    { thresholdKey: 'command_center.absence_reset_days', value: 14, unit: 'days', description: 'Beyond this, the watermark resets rather than producing an unreadable delta.' },
    { thresholdKey: 'win_loss_review.value_threshold', value: 500_000, unit: 'currency', description: 'The value half of the mandatoriness OR gate.' },
    { thresholdKey: 'merge_candidate.stale_days', value: 14, unit: 'days', description: 'An unresolved merge candidate older than this raises EX-CRM-002.' },
    { thresholdKey: 'lead.untouched_days', value: 3, unit: 'days', description: 'No recorded interaction in this window raises EX-CRM-010.' },
    { thresholdKey: 'proposal.stalled_business_days', value: 5, unit: 'days', description: 'Weekend-skipping chase threshold for EX-CRM-008.' },
    { thresholdKey: 'h_com.quarter_target', value: 20_000_000, unit: 'currency', description: 'The commercial target the pipeline-coverage factor scores against.' },
    { thresholdKey: 'people.k_anonymity_floor', value: 5, unit: 'count', description: 'Any people-domain figure over fewer than this many persons renders WITHHELD, regardless of who is asking.' },
    { thresholdKey: 'routing.tie_break_margin_points', value: 5, unit: 'points', description: 'Round-robin breaks ties only within this margin of the top soft-factor score.' },
    { thresholdKey: 'approval.escalation_grace_business_days', value: 3, unit: 'days', description: 'AU-CRM-015: an unresolved approval step bumps a tier after this window.' },
    { thresholdKey: 'document.record_of_record_ttl_seconds', value: 60, unit: 'seconds', description: 'A leaked long-lived link to a signed contract is a materially different risk than a leaked scanned ID-proof link.' },
  ];

  for (const r of rows) {
    await prisma.threshold.upsert({
      where: { tenantId_thresholdKey: { tenantId, thresholdKey: r.thresholdKey } },
      create: { tenantId, ...r },
      update: { description: r.description },
    });
  }
  console.log(`  ${rows.length} thresholds`);
}

/**
 * Each context registers the sensitivity of its own entity types. Anything NOT
 * registered defaults to `confidential` and raises S1_ATTENTION — defaulting to
 * internal means every new column ships readable.
 */
async function seedSensitivityRegistrations() {
  const tenantId = (await currentTenant()).id;
  const rows: Array<{ contextCode: string; entityType: string; sensitivityClass: string }> = [
    { contextCode: 'crm', entityType: 'lead', sensitivityClass: 'internal' },
    { contextCode: 'crm', entityType: 'opportunity', sensitivityClass: 'internal' },
    { contextCode: 'crm', entityType: 'account', sensitivityClass: 'internal' },
    { contextCode: 'crm', entityType: 'organization', sensitivityClass: 'internal' },
    { contextCode: 'crm', entityType: 'institution_profile', sensitivityClass: 'internal' },
    { contextCode: 'crm', entityType: 'mou', sensitivityClass: 'restricted' },
    { contextCode: 'crm', entityType: 'contract', sensitivityClass: 'confidential' },
    { contextCode: 'crm', entityType: 'partner_agreement', sensitivityClass: 'restricted' },
    { contextCode: 'idn', entityType: 'person', sensitivityClass: 'internal' },
    { contextCode: 'fin', entityType: 'invoice', sensitivityClass: 'confidential' },
    { contextCode: 'fin', entityType: 'payment', sensitivityClass: 'confidential' },
    { contextCode: 'edu', entityType: 'enrollment', sensitivityClass: 'restricted' },
    // The near-term regulated case: a minor's guardian contact, reached via the
    // admissions pipeline, is exactly the DPDP-covered data the platform calls
    // regulated.
    { contextCode: 'edu', entityType: 'guardian_contact', sensitivityClass: 'regulated' },
    { contextCode: 'prj', entityType: 'project', sensitivityClass: 'internal' },
    { contextCode: 'hr', entityType: 'performance_note', sensitivityClass: 'confidential' },
    { contextCode: 'hr', entityType: 'compensation_record', sensitivityClass: 'regulated' },
    // Deliberately absent: hr.ICC_CASE. Its existence is the sensitive fact, so
    // it is concealed rather than classified — and any unregistered type that
    // reaches the interaction log fails closed at `confidential` anyway.
  ];

  for (const r of rows) {
    await prisma.sensitivityRegistration.upsert({
      where: { tenantId_contextCode_entityType: { tenantId, contextCode: r.contextCode, entityType: r.entityType } },
      create: { tenantId, ...r },
      update: { sensitivityClass: r.sensitivityClass },
    });
  }
  console.log(`  ${rows.length} sensitivity registrations`);
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

async function seedGovernance() {
  const tenantId = (await currentTenant()).id;

  const basePolicy = await prisma.policy.upsert({
    where: { tenantId_policyCode: { tenantId, policyCode: 'POL-PLATFORM-BASE' } },
    create: {
      tenantId,
      policyCode: 'POL-PLATFORM-BASE',
      name: 'Platform base permission policy',
      description: 'The five-axis evaluation rule set every GRANT is issued under. Version 1 is a faithful, behaviour-preserving translation of the legacy 14x10 letter matrix.',
      kind: 'permission',
    },
    update: {},
  });

  let version = await prisma.policyVersion.findFirst({ where: { policyId: basePolicy.id, version: 1 } });
  if (!version) {
    version = await prisma.policyVersion.create({
      data: {
        tenantId,
        policyId: basePolicy.id,
        version: 1,
        content: {
          axes: ['WHO', 'WHERE', 'WHAT', 'HOW_MUCH', 'WHY'],
          evaluationTime: 'query',
          cachedAtLogin: false,
          scopeSemantics: {
            own: 'Narrows mutation to records the requester owns. View and export always resolve to all.',
            own_or_unowned: 'Additionally permits mutation on unowned records, with a same-branch check applied ONLY in the unowned case.',
            all: 'No narrowing.',
          },
          translationNote: 'Behaviour-preserving translation of the legacy 14x10 matrix. Later changes happen only by authoring a new POLICY_VERSION.',
        },
      },
    });
    await prisma.policy.update({ where: { id: basePolicy.id }, data: { currentVersionId: version.id } });
  }

  // The three approval-gate instances. Specified alongside their entities at
  // build time, never retrofitted — instantiate, do not re-derive.
  const gates = [
    {
      code: 'POL-CRM-MOU-APPROVAL',
      name: 'MoU privileged-transition approval',
      requiredPermission: 'mous:approve',
      authorityClass: 'mou_approval',
    },
    {
      code: 'POL-CRM-CONTRACT-APPROVAL',
      name: 'Contract privileged-transition approval',
      requiredPermission: 'contracts:approve',
      authorityClass: 'contract_approval',
    },
    {
      code: 'POL-CRM-PARTNER-APPROVAL',
      name: 'Partner agreement privileged-transition approval',
      requiredPermission: 'partner_agreements:approve',
      authorityClass: 'partner_approval',
    },
  ];

  for (const gate of gates) {
    const policy = await prisma.policy.upsert({
      where: { tenantId_policyCode: { tenantId, policyCode: gate.code } },
      create: { tenantId, policyCode: gate.code, name: gate.name, kind: 'approval_gate' },
      update: {},
    });
    const existing = await prisma.policyVersion.findFirst({ where: { policyId: policy.id, version: 1 } });
    if (existing) continue;

    const pv = await prisma.policyVersion.create({
      data: {
        tenantId,
        policyId: policy.id,
        version: 1,
        content: {
          requiredPermission: gate.requiredPermission,
          authorityClass: gate.authorityClass,
          approverResolution: ['business_head', 'director', 'chairman'],
          // An OR gate, deliberately: a zero-value high-strategic academic MoU
          // escalates to the top tier as readily as a high-value commercial one.
          escalateToTopTierWhen: { strategicValue: 'high', termMonthsOver: 36 },
          selfDealingBar: true,
          // Structurally excluded at every tier — not merely a runtime check
          // that a missed code path could bypass.
          excludedRoles: ['system_admin'],
          // The approval decision is PROHIBITED for any AI principal regardless
          // of AUTHORITY_GRANT size.
          appliesTo: { principalTypes: ['human'] },
          escalationGraceBusinessDays: 3,
        },
      },
    });
    await prisma.policy.update({ where: { id: policy.id }, data: { currentVersionId: pv.id } });
  }

  console.log(`  1 base policy + ${gates.length} approval gates`);
  return { policyVersionId: version.id };
}

async function seedGrants(policyVersionId: string) {
  const tenantId = (await currentTenant()).id;
  let roleCount = 0;
  let grantCount = 0;

  for (const def of ROLE_DEFINITIONS) {
    const role = await prisma.accessRole.upsert({
      where: { tenantId_slug: { tenantId, slug: def.slug } },
      create: {
        tenantId,
        slug: def.slug,
        name: def.name,
        description: def.description,
        archetype: def.archetype,
        classificationCeiling: def.classificationCeiling,
        isSystem: true,
      },
      update: { name: def.name, description: def.description, archetype: def.archetype, classificationCeiling: def.classificationCeiling },
    });
    roleCount += 1;

    for (const spec of ROLE_GRANT_MATRIX[def.slug] ?? []) {
      const parsed = parseCell(spec.cell);
      // An explicit absence is exactly that: no row, not a placeholder.
      if (!parsed) continue;

      const existing = await prisma.grant.findFirst({
        where: { tenantId, roleId: role.id, resource: spec.resource },
      });

      if (existing) {
        // Re-running the deployment pipeline does NOT alter GRANT records.
        continue;
      }

      await prisma.grant.create({
        data: {
          tenantId,
          principalType: 'role',
          roleId: role.id,
          policyVersionId,
          resource: spec.resource,
          verbs: parsed.verbs,
          scope: parsed.scope,
          scopeResolver: spec.scopeResolver ?? null,
          conditions: (spec.conditions ?? {}) as never,
        },
      });
      grantCount += 1;
    }
  }

  console.log(`  ${roleCount} roles, ${grantCount} grants`);
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

async function seedPipelines() {
  const tenantId = (await currentTenant()).id;

  for (const seed of PIPELINE_SEEDS) {
    const existing = await prisma.pipelineDefinition.findFirst({
      where: { tenantId, pipelineCode: seed.pipelineCode },
    });
    if (existing) continue;

    const pipeline = await prisma.pipelineDefinition.create({
      data: {
        tenantId,
        pipelineCode: seed.pipelineCode,
        name: seed.name,
        commercialMotion: seed.commercialMotion,
        appliesToVerticals: seed.appliesToVerticals,
        appliesToAccountKind: seed.appliesToAccountKind,
        defaultForecastMethod: seed.defaultForecastMethod,
        requiresAwardArtefact: seed.requiresAwardArtefact,
        isDefault: seed.isDefault ?? false,
        commitApprovalThreshold: seed.commitApprovalThreshold ?? undefined,
      },
    });

    for (const stage of seed.stages) {
      await prisma.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          stageKey: stage.stageKey,
          label: stage.label,
          sequence: stage.sequence,
          defaultProbability: stage.defaultProbability,
          pipelinePosition: stage.pipelinePosition,
          isOpen: stage.pipelinePosition !== 0 && stage.pipelinePosition !== 90,
          isTerminal: stage.pipelinePosition === 0 || stage.pipelinePosition === 90,
          postAward: stage.postAward ?? false,
          stageAgeBudgetDays: stage.stageAgeBudgetDays,
          requiredFields: stage.requiredFields ?? [],
        },
      });
    }

    // The three retired post-award stages remain DEFINED for reporting on
    // historical rows, but no transition targets them.
    if (seed.pipelineCode === 'PL-ENTERPRISE') {
      for (const stage of RETIRED_POST_AWARD_STAGES) {
        await prisma.pipelineStage.create({
          data: {
            tenantId,
            pipelineId: pipeline.id,
            stageKey: stage.stageKey,
            label: stage.label,
            sequence: stage.sequence,
            defaultProbability: stage.defaultProbability,
            pipelinePosition: stage.pipelinePosition,
            isOpen: false,
            isTerminal: false,
            postAward: true,
            stageAgeBudgetDays: null,
          },
        });
      }
    }

    for (const t of transitionsFor(seed.stages)) {
      await prisma.pipelineTransition.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          fromStageKey: t.fromStageKey,
          toStageKey: t.toStageKey,
          requiresApproval: t.requiresApproval,
          requiredPermission: t.requiredPermission,
          emitsEvent: EVENTS.OPPORTUNITY_STAGE_CHANGED,
        },
      });
    }
  }

  const count = await prisma.pipelineDefinition.count({ where: { tenantId } });
  console.log(`  ${count} pipelines with stages and validated transition graphs`);
}

// ---------------------------------------------------------------------------
// People, affiliations, users
// ---------------------------------------------------------------------------

interface SeededPerson {
  id: string;
  fullName: string;
  email: string;
  roleSlug: string;
  branch: string;
}

async function seedPeopleAndUsers(): Promise<SeededPerson[]> {
  const tenantId = (await currentTenant()).id;
  const passwordHash = await hashPassword(PASSWORD);

  const staff: Array<{ name: string; email: string; role: string; branch: string; phone: string; orgUnit: string }> = [
    { name: 'Ashok Raghunathan', email: 'chairman@kaizen.co.in', role: 'chairman', branch: 'Chennai', phone: '9840000001', orgUnit: 'exec' },
    { name: 'Vinodh Shankar', email: 'sysadmin@kaizen.co.in', role: 'system_admin', branch: 'Chennai', phone: '9840000002', orgUnit: 'platform' },
    { name: 'Nandini Krishnan', email: 'bhead@kaizen.co.in', role: 'business_head', branch: 'Chennai', phone: '9840000003', orgUnit: 'commercial' },
    { name: 'Rajesh Venkataraman', email: 'director@kaizen.co.in', role: 'director', branch: 'Coimbatore', phone: '9840000004', orgUnit: 'commercial' },
    { name: 'Latha Subramanian', email: 'controller@kaizen.co.in', role: 'finance_controller', branch: 'Chennai', phone: '9840000005', orgUnit: 'finance' },
    { name: 'Arun Prakash', email: 'arun@kaizen.co.in', role: 'sales', branch: 'Chennai', phone: '9840000006', orgUnit: 'commercial' },
    { name: 'Sanjay Mehta', email: 'sanjay@kaizen.co.in', role: 'sales', branch: 'Coimbatore', phone: '9840000007', orgUnit: 'commercial' },
    { name: 'Divya Ramesh', email: 'divya@kaizen.co.in', role: 'telecaller', branch: 'Chennai', phone: '9840000008', orgUnit: 'commercial' },
    { name: 'Meera Nair', email: 'meera@kaizen.co.in', role: 'education_counsellor', branch: 'Madurai', phone: '9840000009', orgUnit: 'education' },
    { name: 'Ravi Chandran', email: 'ravi@kaizen.co.in', role: 'trainer', branch: 'Chennai', phone: '9840000010', orgUnit: 'education' },
    { name: 'Kavitha Selvam', email: 'kavitha@kaizen.co.in', role: 'project_manager', branch: 'Chennai', phone: '9840000011', orgUnit: 'delivery' },
    { name: 'Suresh Kumar', email: 'suresh@kaizen.co.in', role: 'workforce_placement', branch: 'Coimbatore', phone: '9840000012', orgUnit: 'placement' },
    { name: 'Priya Balan', email: 'priya@kaizen.co.in', role: 'marketing', branch: 'Chennai', phone: '9840000013', orgUnit: 'marketing' },
    { name: 'Lakshmi Iyer', email: 'latha@kaizen.co.in', role: 'finance', branch: 'Chennai', phone: '9840000014', orgUnit: 'finance' },
    { name: 'Gopal Srinivasan', email: 'multi@kaizen.co.in', role: 'sales', branch: 'Chennai', phone: '9840000015', orgUnit: 'commercial' },
  ];

  const out: SeededPerson[] = [];

  for (const s of staff) {
    let person = await prisma.person.findFirst({ where: { tenantId, primaryEmail: s.email } });
    if (!person) {
      person = await prisma.person.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('PER'),
          fullName: s.name,
          primaryEmail: s.email,
          primaryEmailNormalised: s.email.toLowerCase(),
          primaryPhone: s.phone,
          primaryPhoneNormalised: s.phone,
          source: 'seed',
        },
      });
    }

    const existingAffiliation = await prisma.affiliation.findFirst({
      where: { tenantId, partyId: person.id, roleSlug: s.role },
    });
    if (!existingAffiliation) {
      await prisma.affiliation.create({
        data: {
          tenantId,
          partyId: person.id,
          affiliationType: 'employee',
          counterpartyName: 'Kaizen Infinities',
          roleSlug: s.role,
          primaryFlag: true,
          branch: s.branch,
          orgUnitId: s.orgUnit,
          positionId: `pos_${s.role}`,
          // An employee affiliation carries a statutory retention floor: a
          // dedup match against it never auto-merges.
          statutoryRetentionFloor: true,
        },
      });
    }

    await prisma.user.upsert({
      where: { tenantId_email: { tenantId, email: s.email } },
      create: { tenantId, personId: person.id, email: s.email, passwordHash, branch: s.branch },
      update: { passwordHash, branch: s.branch },
    });

    out.push({ id: person.id, fullName: s.name, email: s.email, roleSlug: s.role, branch: s.branch });
  }

  // A person holding several concurrent affiliations — the canonical case the
  // context switcher exists for. Switching is "which of my relationships am I
  // answerable as", not "which company am I logged into".
  const multi = out.find((p) => p.email === 'multi@kaizen.co.in')!;
  for (const extra of [
    { affiliationType: 'employee', roleSlug: 'project_manager', orgUnit: 'delivery' },
    { affiliationType: 'employee', roleSlug: 'workforce_placement', orgUnit: 'placement' },
  ]) {
    const exists = await prisma.affiliation.findFirst({ where: { tenantId, partyId: multi.id, roleSlug: extra.roleSlug } });
    if (!exists) {
      await prisma.affiliation.create({
        data: {
          tenantId,
          partyId: multi.id,
          affiliationType: extra.affiliationType,
          counterpartyName: 'Kaizen Infinities',
          roleSlug: extra.roleSlug,
          branch: 'Chennai',
          orgUnitId: extra.orgUnit,
          statutoryRetentionFloor: true,
        },
      });
    }
  }

  // Capability claims feed the routing engine's Capability factor. Never
  // auto-asserted at `verified` tier.
  const claims = [
    { email: 'arun@kaizen.co.in', vertical: 'sap_enterprise', tier: 'verified' },
    { email: 'arun@kaizen.co.in', vertical: 'software_ai', tier: 'demonstrated' },
    { email: 'sanjay@kaizen.co.in', vertical: 'cybersecurity', tier: 'assessed' },
    { email: 'sanjay@kaizen.co.in', vertical: 'sap_enterprise', tier: 'assessed' },
    { email: 'meera@kaizen.co.in', vertical: 'education', tier: 'verified' },
    { email: 'meera@kaizen.co.in', vertical: 'partnerships', tier: 'demonstrated' },
    { email: 'suresh@kaizen.co.in', vertical: 'placement', tier: 'verified' },
    { email: 'divya@kaizen.co.in', vertical: 'education', tier: 'claimed' },
  ];
  for (const c of claims) {
    const person = out.find((p) => p.email === c.email);
    if (!person) continue;
    const exists = await prisma.capabilityClaim.findFirst({ where: { tenantId, partyId: person.id, vertical: c.vertical } });
    if (!exists) {
      await prisma.capabilityClaim.create({
        data: { tenantId, partyId: person.id, vertical: c.vertical, tier: c.tier, evidence: 'Seeded from historical win data.' },
      });
    }
  }

  console.log(`  ${out.length} staff with affiliations, users and capability claims`);
  return out;
}

async function seedAuthorityGrants(people: SeededPerson[]) {
  const tenantId = (await currentTenant()).id;

  const grants: Array<{ email: string; authorityClass: string; ceiling: number }> = [
    { email: 'bhead@kaizen.co.in', authorityClass: 'mou_approval', ceiling: 1_000_000 },
    { email: 'bhead@kaizen.co.in', authorityClass: 'contract_approval', ceiling: 2_000_000 },
    { email: 'bhead@kaizen.co.in', authorityClass: 'partner_approval', ceiling: 1_000_000 },
    { email: 'bhead@kaizen.co.in', authorityClass: 'commit_approval', ceiling: 10_000_000 },
    { email: 'director@kaizen.co.in', authorityClass: 'mou_approval', ceiling: 5_000_000 },
    { email: 'director@kaizen.co.in', authorityClass: 'contract_approval', ceiling: 10_000_000 },
    { email: 'director@kaizen.co.in', authorityClass: 'partner_approval', ceiling: 5_000_000 },
    { email: 'chairman@kaizen.co.in', authorityClass: 'mou_approval', ceiling: 100_000_000 },
    { email: 'chairman@kaizen.co.in', authorityClass: 'contract_approval', ceiling: 100_000_000 },
    { email: 'chairman@kaizen.co.in', authorityClass: 'partner_approval', ceiling: 100_000_000 },
    { email: 'chairman@kaizen.co.in', authorityClass: 'commit_approval', ceiling: 100_000_000 },
    { email: 'controller@kaizen.co.in', authorityClass: 'discount_approval', ceiling: 20_000_000 },
    // A rep holds a real but modest ceiling, so an over-ceiling deal opens a
    // step rather than being silently permitted.
    { email: 'arun@kaizen.co.in', authorityClass: 'discount_approval', ceiling: 500_000 },
    { email: 'arun@kaizen.co.in', authorityClass: 'mou_approval', ceiling: 100_000 },
  ];

  let count = 0;
  for (const g of grants) {
    const person = people.find((p) => p.email === g.email);
    if (!person) continue;
    const exists = await prisma.authorityGrant.findFirst({
      where: { tenantId, principalId: person.id, authorityClass: g.authorityClass },
    });
    if (exists) continue;
    await prisma.authorityGrant.create({
      data: {
        tenantId,
        principalType: 'human',
        principalId: person.id,
        principalLabel: person.fullName,
        authorityClass: g.authorityClass,
        ceilingValue: g.ceiling,
        currency: 'INR',
      },
    });
    count += 1;
  }
  console.log(`  ${count} authority grants (the HOW MUCH axis)`);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

async function seedAgents() {
  const tenantId = (await currentTenant()).id;

  const agents = [
    {
      agentKey: 'agent.dedup',
      name: 'Identity Resolution Agent',
      purpose: 'Raises near-duplicate person pairs into human review that the exact-match stage misses.',
      tier: 'RECOMMEND',
      tools: ['tool.idn.suggest_duplicates', 'tool.idn.resolve_person'],
      countCeiling: 200,
    },
    {
      agentKey: 'agent.router',
      name: 'Lead Routing Agent',
      purpose: 'Evaluates the six routing factors and assigns ownership within a transparent, tenant-configured policy.',
      tier: 'AUTONOMOUS_WITHIN_POLICY',
      tools: ['tool.crm.route_lead', 'tool.crm.score_lead'],
      countCeiling: 1000,
    },
    {
      agentKey: 'agent.forecast',
      name: 'Forecast Advisor',
      purpose: 'Flags deals whose activity pattern resembles historically-committed ones. Never writes a forecast category.',
      tier: 'RECOMMEND',
      tools: ['tool.crm.suggest_forecast_category', 'tool.crm.suggest_stage_budget'],
      countCeiling: 100,
    },
    {
      agentKey: 'agent.drafter',
      name: 'Proposal Drafting Agent',
      purpose: 'Drafts proposal narrative from structured opportunity and offering data. A human always sends.',
      tier: 'DRAFT',
      tools: ['tool.pct.draft_proposal', 'tool.pct.flag_clause_risk'],
      countCeiling: 25,
    },
    {
      agentKey: 'agent.owner_resolver',
      name: 'Exception Ownership Agent',
      purpose: 'Resolves an owner for an exception that failed to route. Assigns; never decides or acts on the substance.',
      tier: 'AUTONOMOUS_WITHIN_POLICY',
      tools: ['tool.xcp.resolve_owner'],
      countCeiling: 500,
    },
    {
      agentKey: 'agent.enricher',
      name: 'Institution Registry Enricher',
      purpose: 'Fills AISHE/UDISE+ identifiers from an external provider, above a confidence threshold. Leaves null rather than fabricating.',
      tier: 'AUTONOMOUS_WITHIN_POLICY',
      tools: ['tool.crm.enrich_institution', 'tool.crm.suggest_specialisation'],
      countCeiling: 300,
    },
    {
      agentKey: 'agent.ask_kaizen',
      name: 'Ask Kaizen',
      purpose: 'Answers from governed widget data through the identical five-axis filter. It cannot answer what the surface would withhold.',
      tier: 'READ',
      tools: ['tool.xdm.answer_from_composition', 'tool.mem.render_narrative'],
      countCeiling: null,
    },
  ];

  for (const a of agents) {
    const agent = await prisma.agentPrincipal.upsert({
      where: { tenantId_agentKey: { tenantId, agentKey: a.agentKey } },
      create: {
        tenantId,
        agentKey: a.agentKey,
        name: a.name,
        purpose: a.purpose,
        tier: a.tier,
        declaredTools: a.tools,
      },
      update: { name: a.name, purpose: a.purpose, tier: a.tier, declaredTools: a.tools },
    });

    if (a.countCeiling) {
      const exists = await prisma.authorityGrant.findFirst({
        where: { tenantId, principalId: agent.id, authorityClass: 'agent_action' },
      });
      if (!exists) {
        await prisma.authorityGrant.create({
          data: {
            tenantId,
            principalType: 'agent',
            principalId: agent.id,
            principalLabel: a.name,
            authorityClass: 'agent_action',
            // An agent's bounds are its own — never inherited from a human's.
            countCeiling: a.countCeiling,
            countWindow: 'day',
            riskClassCeiling: 'low',
          },
        });
      }
    }
  }

  console.log(`  ${agents.length} agent principals with declared tools and their own authority grants`);
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

async function seedSurfaces() {
  const tenantId = (await currentTenant()).id;

  const navNodes: Array<{
    nodeKey: string; label: string; icon: string; path: string; group: string;
    position: number; requiredPermission?: string; archetypes?: string[]; synonyms?: string[];
  }> = [
    { nodeKey: 'command', label: 'Today', icon: 'gauge', path: '/command', group: 'main', position: 1, requiredPermission: 'health_scores:V', archetypes: ['command'], synonyms: ['pulse', 'how are we doing', 'state of kaizen'] },
    { nodeKey: 'workspace', label: 'My Workspace', icon: 'home', path: '/workspace', group: 'main', position: 2, synonyms: ['my day', 'my queue', 'home'] },
    { nodeKey: 'crm_leads', label: 'Leads', icon: 'inbox', path: '/crm/leads', group: 'crm', position: 10, requiredPermission: 'leads:V', synonyms: ['enquiries', 'prospects'] },
    { nodeKey: 'crm_pipeline', label: 'Pipeline', icon: 'columns', path: '/crm/pipeline', group: 'crm', position: 11, requiredPermission: 'opportunities:V', synonyms: ['kanban', 'board', 'deals'] },
    { nodeKey: 'crm_opportunities', label: 'Opportunities', icon: 'target', path: '/crm/opportunities', group: 'crm', position: 12, requiredPermission: 'opportunities:V', synonyms: ['deals'] },
    { nodeKey: 'crm_forecast', label: 'Forecast', icon: 'trending', path: '/crm/forecast', group: 'crm', position: 13, requiredPermission: 'opportunities:V', synonyms: ['commit', 'coverage'] },
    { nodeKey: 'crm_accounts', label: 'Accounts & Institutions', icon: 'building', path: '/crm/accounts', group: 'crm', position: 14, requiredPermission: 'organizations:V', synonyms: ['organizations', 'companies', 'colleges'] },
    { nodeKey: 'crm_people', label: 'People', icon: 'users', path: '/crm/people', group: 'crm', position: 15, requiredPermission: 'people:V', synonyms: ['contacts', 'persons'] },
    { nodeKey: 'crm_interactions', label: 'Calls & Meetings', icon: 'message', path: '/crm/interactions', group: 'crm', position: 16, requiredPermission: 'interactions:V', synonyms: ['activity', 'timeline', 'calls'] },
    { nodeKey: 'com_offerings', label: 'What We Sell', icon: 'package', path: '/commercial/offerings', group: 'commercial', position: 20, requiredPermission: 'offerings:V', synonyms: ['products', 'price book', 'catalog'] },
    { nodeKey: 'com_quotes', label: 'Quotes', icon: 'calculator', path: '/commercial/quotes', group: 'commercial', position: 21, requiredPermission: 'quotes:V', synonyms: ['pricing', 'discount'] },
    { nodeKey: 'com_proposals', label: 'Proposals', icon: 'file', path: '/commercial/proposals', group: 'commercial', position: 22, requiredPermission: 'proposals:V' },
    { nodeKey: 'com_agreements', label: 'Agreements', icon: 'scroll', path: '/commercial/agreements', group: 'commercial', position: 23, requiredPermission: 'mous:V', synonyms: ['mou', 'contracts', 'partner agreements'] },
    { nodeKey: 'com_winloss', label: 'Win / Loss', icon: 'clipboard', path: '/commercial/win-loss', group: 'commercial', position: 24, requiredPermission: 'win_loss_reviews:V', synonyms: ['post mortem', 'lessons'] },
    { nodeKey: 'com_approvals', label: 'Approvals', icon: 'shield', path: '/commercial/approvals', group: 'commercial', position: 25, requiredPermission: 'mous:V' },
    { nodeKey: 'fin_invoices', label: 'Invoices', icon: 'receipt', path: '/finance/invoices', group: 'finance', position: 30, requiredPermission: 'invoices:V' },
    { nodeKey: 'fin_payments', label: 'Payments', icon: 'wallet', path: '/finance/payments', group: 'finance', position: 31, requiredPermission: 'payments:V' },
    { nodeKey: 'fin_receivables', label: 'Receivables', icon: 'coins', path: '/finance/receivables', group: 'finance', position: 32, requiredPermission: 'receivables:V' },
    { nodeKey: 'edu_cohorts', label: 'Training Batches', icon: 'graduation', path: '/education/cohorts', group: 'delivery', position: 40, requiredPermission: 'education:V', synonyms: ['batches', 'classes'] },
    { nodeKey: 'edu_enrollments', label: 'Learners', icon: 'badge', path: '/education/enrollments', group: 'delivery', position: 41, requiredPermission: 'education:V', synonyms: ['students', 'learners'] },
    { nodeKey: 'prj_projects', label: 'Projects', icon: 'kanban', path: '/delivery/projects', group: 'delivery', position: 42, requiredPermission: 'projects:V', synonyms: ['delivery'] },
    { nodeKey: 'gov_exceptions', label: 'Problems', icon: 'alert', path: '/exceptions', group: 'governance', position: 50, requiredPermission: 'exceptions:V', synonyms: ['issues', 'attention'] },
    { nodeKey: 'gov_decisions', label: 'Decisions', icon: 'scale', path: '/command/decisions', group: 'governance', position: 51, requiredPermission: 'decisions:V' },
    { nodeKey: 'adm_pipelines', label: 'Pipeline Configuration', icon: 'settings', path: '/admin/pipelines', group: 'admin', position: 60, requiredPermission: 'pipeline_definitions:V' },
    { nodeKey: 'adm_territories', label: 'Territories & Assignment', icon: 'map', path: '/admin/territories', group: 'admin', position: 61, requiredPermission: 'territories:V' },
    { nodeKey: 'adm_governance', label: 'Who Can Do What', icon: 'key', path: '/admin/governance', group: 'admin', position: 62, requiredPermission: 'grants:V' },
    { nodeKey: 'adm_agents', label: 'AI Agents', icon: 'bot', path: '/admin/agents', group: 'admin', position: 63, requiredPermission: 'agents:V' },
    { nodeKey: 'adm_events', label: 'System History', icon: 'activity', path: '/admin/events', group: 'admin', position: 64, requiredPermission: 'events:V' },
    { nodeKey: 'adm_jobs', label: 'Automatic Checks', icon: 'clock', path: '/admin/jobs', group: 'admin', position: 65, requiredPermission: 'jobs:V' },
    { nodeKey: 'adm_audit', label: 'Audit Trail', icon: 'search', path: '/admin/audit', group: 'admin', position: 66, requiredPermission: 'audit:V' },
    { nodeKey: 'adm_platform', label: 'How This Is Built', icon: 'layers', path: '/admin/platform', group: 'admin', position: 67 },
  ];

  for (const n of navNodes) {
    await prisma.navNode.upsert({
      where: { tenantId_nodeKey: { tenantId, nodeKey: n.nodeKey } },
      create: {
        tenantId,
        nodeKey: n.nodeKey,
        label: n.label,
        icon: n.icon,
        path: n.path,
        group: n.group,
        position: n.position,
        requiredPermission: n.requiredPermission ?? null,
        eligibleArchetypes: n.archetypes ?? [],
        searchSynonyms: n.synonyms ?? [],
      },
      update: { label: n.label, path: n.path, position: n.position, requiredPermission: n.requiredPermission ?? null },
    });
  }

  // Every widget declares all seven mandatory fields. A non-empty actions[] is
  // enforced at publish time.
  const widgets = [
    { widgetKey: 'pulse_strip', title: 'Company Pulse', dataSource: 'health.latestPulse', requiredPermission: 'health_scores:V', severityRelevance: 'S1_ATTENTION', actions: [{ label: 'Open factor breakdown', path: '/command/health/:domainCode' }], drillTarget: '/command/health', mobileBehaviour: 'keep', emptyState: 'Not yet measured — no domain has sufficient inputs.' },
    { widgetKey: 'attention_queue', title: 'Attention Queue', dataSource: 'commandCenter.attentionQueue', requiredPermission: 'exceptions:V', severityRelevance: 'S3_HIGH_RISK', actions: [{ label: 'Acknowledge', path: '/exceptions/:id/acknowledge' }, { label: 'Resolve', path: '/exceptions/:id/resolve' }], drillTarget: '/exceptions', mobileBehaviour: 'keep', emptyState: 'Nothing owned by or escalated to you is open above S3.' },
    { widgetKey: 'decision_queue', title: 'Decision Queue', dataSource: 'decisions.decisionQueue', requiredPermission: 'decisions:V', severityRelevance: 'S2_WARNING', actions: [{ label: 'Decide', path: '/command/decisions/:id' }, { label: 'Delegate', path: '/command/decisions/:id' }, { label: 'Defer', path: '/command/decisions/:id' }, { label: 'Request evidence', path: '/command/decisions/:id' }], drillTarget: '/command/decisions', mobileBehaviour: 'keep', emptyState: 'Nothing requires authority that exceeds every grant below you.' },
    { widgetKey: 'what_changed', title: 'What Changed', dataSource: 'commandCenter.whatChanged', requiredPermission: 'events:V', severityRelevance: 'S1_ATTENTION', actions: [{ label: 'Open source event', path: '/admin/events' }], drillTarget: '/admin/events', mobileBehaviour: 'drill_only', emptyState: 'Nothing crossed the materiality floor since you last looked.' },
    { widgetKey: 'live_and_handled', title: 'Live & Handled', dataSource: 'commandCenter.liveAndHandled', requiredPermission: 'jobs:V', severityRelevance: 'S0_INFO', actions: [{ label: 'Inspect authority', path: '/admin/agents' }], drillTarget: '/admin/jobs', mobileBehaviour: 'shed', emptyState: 'Nothing ran. An automation class that normally fires and suddenly does not is itself a signal.' },
    { widgetKey: 'forecast_band', title: 'Forecast', dataSource: 'opportunities.forecastRollup', requiredPermission: 'opportunities:V', severityRelevance: 'S2_WARNING', actions: [{ label: 'Open the model', path: '/crm/forecast' }, { label: 'Set a review date', path: '/command/decisions' }], drillTarget: '/crm/forecast', mobileBehaviour: 'shed', emptyState: 'No forecast with a recorded backtest error. Rendering UNAVAILABLE rather than a confident guess.' },
    { widgetKey: 'people_capability', title: 'People & Capability', dataSource: 'commandCenter.peopleAndCapability', requiredPermission: 'health_scores:V', severityRelevance: 'S1_ATTENTION', actions: [{ label: 'Review unit coverage', path: '/command' }], drillTarget: '/command', mobileBehaviour: 'drill_only', emptyState: 'No org unit clears the k>=5 anonymity floor.' },
    { widgetKey: 'my_queue', title: 'My Queue', dataSource: 'crm.tasks', requiredPermission: 'interactions:V', severityRelevance: 'S1_ATTENTION', actions: [{ label: 'Complete', path: '/workspace' }], drillTarget: '/workspace', mobileBehaviour: 'keep', emptyState: 'Nothing due.' },
    { widgetKey: 'my_pipeline', title: 'My Pipeline', dataSource: 'crm.opportunities', requiredPermission: 'opportunities:V', severityRelevance: 'S1_ATTENTION', actions: [{ label: 'Open board', path: '/crm/pipeline' }], drillTarget: '/crm/pipeline', mobileBehaviour: 'keep', emptyState: 'No open opportunities assigned to you.' },
    { widgetKey: 'unrouted_leads', title: 'Unrouted Leads', dataSource: 'crm.leads?unrouted=true', requiredPermission: 'leads:V', severityRelevance: 'S2_WARNING', actions: [{ label: 'Assign', path: '/crm/leads' }], drillTarget: '/crm/leads?unrouted=true', mobileBehaviour: 'keep', emptyState: 'Every open lead has a resolved owner.', noActionFallback: 'Route to the territory owner with a 4-business-hour SLA.' },
  ];

  for (const w of widgets) {
    await prisma.widgetDefinition.upsert({
      where: { tenantId_widgetKey: { tenantId, widgetKey: w.widgetKey } },
      create: {
        tenantId,
        widgetKey: w.widgetKey,
        title: w.title,
        dataSource: w.dataSource,
        requiredPermission: w.requiredPermission,
        severityRelevance: w.severityRelevance,
        actions: w.actions as never,
        drillTarget: w.drillTarget,
        mobileBehaviour: w.mobileBehaviour,
        emptyState: w.emptyState,
        noActionFallback: (w as { noActionFallback?: string }).noActionFallback ?? null,
      },
      update: { title: w.title, actions: w.actions as never, emptyState: w.emptyState },
    });
  }

  const templates = [
    { templateKey: 'command_center', name: 'Chairman Command Center', archetype: 'command', eligibleRoles: ['chairman', 'founder', 'admin', 'director', 'business_head'], widgets: ['pulse_strip', 'attention_queue', 'decision_queue', 'what_changed', 'live_and_handled', 'forecast_band', 'people_capability'] },
    { templateKey: 'employee_workspace', name: 'Employee & Manager Workspace', archetype: 'workspace', eligibleRoles: [], widgets: ['my_queue', 'my_pipeline', 'unrouted_leads'] },
  ];

  for (const t of templates) {
    const template = await prisma.surfaceTemplate.upsert({
      where: { tenantId_templateKey: { tenantId, templateKey: t.templateKey } },
      create: { tenantId, templateKey: t.templateKey, name: t.name, archetype: t.archetype, eligibleRoles: t.eligibleRoles },
      update: { name: t.name, eligibleRoles: t.eligibleRoles },
    });

    for (const [i, widgetKey] of t.widgets.entries()) {
      const widget = await prisma.widgetDefinition.findFirst({ where: { tenantId, widgetKey } });
      if (!widget) continue;
      await prisma.widgetBinding.upsert({
        where: { templateId_widgetId: { templateId: template.id, widgetId: widget.id } },
        create: { tenantId, templateId: template.id, widgetId: widget.id, position: i },
        update: { position: i },
      });
    }
  }

  console.log(`  ${navNodes.length} nav nodes, ${widgets.length} widgets, ${templates.length} surface templates`);
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface SeededOffering {
  id: string;
  offeringCode: string;
  name: string;
  vertical: string;
  priceBookEntryId: string | null;
  unitPrice: number;
  maxDiscountPct: number;
}

async function seedCatalog(): Promise<SeededOffering[]> {
  const tenantId = (await currentTenant()).id;

  const catalog: Array<{
    code: string; name: string; description: string; vertical: Vertical;
    deliveryModel: DeliveryModel; revenue: RevenueTreatment; price: number;
    frequency: string; maxDiscount: number; publish: boolean;
  }> = [
    { code: 'SAP-S4-IMPL', name: 'SAP S/4HANA Implementation', description: 'End-to-end S/4HANA migration and rollout.', vertical: 'sap_enterprise', deliveryModel: 'professional_services', revenue: 'milestone_based', price: 8_500_000, frequency: 'milestone', maxDiscount: 12, publish: true },
    { code: 'SAP-SUPPORT', name: 'SAP Managed Support (AMS)', description: 'Ongoing application management services.', vertical: 'sap_enterprise', deliveryModel: 'saas_subscription', revenue: 'over_time_ratable', price: 450_000, frequency: 'monthly', maxDiscount: 15, publish: true },
    { code: 'CYBER-SOC', name: 'Managed SOC', description: '24x7 security operations centre.', vertical: 'cybersecurity', deliveryModel: 'saas_subscription', revenue: 'over_time_ratable', price: 650_000, frequency: 'monthly', maxDiscount: 10, publish: true },
    { code: 'CYBER-VAPT', name: 'VAPT Engagement', description: 'Vulnerability assessment and penetration testing.', vertical: 'cybersecurity', deliveryModel: 'professional_services', revenue: 'point_in_time', price: 1_200_000, frequency: 'one_time', maxDiscount: 20, publish: true },
    { code: 'AI-PLATFORM', name: 'AI Platform Build', description: 'Custom AI platform design and delivery.', vertical: 'software_ai', deliveryModel: 'professional_services', revenue: 'milestone_based', price: 6_000_000, frequency: 'milestone', maxDiscount: 15, publish: true },
    { code: 'CT-LEADERSHIP', name: 'Leadership Development Programme', description: 'Cohort-based corporate leadership training.', vertical: 'corporate_training', deliveryModel: 'cohort', revenue: 'over_time_ratable', price: 1_800_000, frequency: 'one_time', maxDiscount: 25, publish: true },
    { code: 'EDU-FSD', name: 'Full Stack Development Programme', description: '24-week full stack cohort with placement support.', vertical: 'education', deliveryModel: 'cohort', revenue: 'over_time_ratable', price: 60_000, frequency: 'one_time', maxDiscount: 30, publish: true },
    { code: 'EDU-DS', name: 'Data Science Programme', description: '20-week data science cohort.', vertical: 'education', deliveryModel: 'cohort', revenue: 'over_time_ratable', price: 75_000, frequency: 'one_time', maxDiscount: 30, publish: true },
    { code: 'PLC-FEE', name: 'Placement Success Fee', description: 'Fee on confirmed placement.', vertical: 'placement', deliveryModel: 'placement_fee', revenue: 'point_in_time', price: 45_000, frequency: 'one_time', maxDiscount: 20, publish: true },
    // Deliberately published with no price book entry, so DET-CRM-OFF-01 has a
    // real coverage gap to detect on first run.
    { code: 'RES-ADVISORY', name: 'Applied Research Advisory', description: 'Advisory retainer for applied research programmes.', vertical: 'research', deliveryModel: 'professional_services', revenue: 'over_time_ratable', price: 0, frequency: 'monthly', maxDiscount: 0, publish: false },
  ];

  const out: SeededOffering[] = [];

  for (const c of catalog) {
    let offering = await prisma.offering.findFirst({ where: { tenantId, offeringCode: c.code } });
    if (!offering) {
      offering = await prisma.offering.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('OFF'),
          offeringCode: c.code,
          name: c.name,
          description: c.description,
          vertical: c.vertical,
          deliveryModel: c.deliveryModel,
          defaultRevenueTreatment: c.revenue,
          status: 'active',
          owningBusinessUnit: 'commercial',
        },
      });
    }

    let entry = await prisma.priceBookEntry.findFirst({ where: { tenantId, offeringId: offering.id, status: 'active' } });
    if (!entry && c.publish) {
      entry = await prisma.priceBookEntry.create({
        data: {
          tenantId,
          offeringId: offering.id,
          priceBookId: 'standard',
          priceBookName: 'Standard List',
          currency: 'INR',
          unitPrice: c.price,
          billingFrequency: c.frequency,
          minQuantity: 1,
          maxDiscountPct: c.maxDiscount,
          status: 'active',
          version: 1,
        },
      });
    }

    out.push({
      id: offering.id,
      offeringCode: c.code,
      name: c.name,
      vertical: c.vertical,
      priceBookEntryId: entry?.id ?? null,
      unitPrice: c.price,
      maxDiscountPct: c.maxDiscount,
    });
  }

  console.log(`  ${out.length} offerings (one deliberately unpriced, so the coverage detector has something real to find)`);
  return out;
}

async function seedTerritoriesAndRouting(people: SeededPerson[]) {
  const tenantId = (await currentTenant()).id;

  const territories = [
    { name: 'Chennai Metro — Enterprise', districts: ['Chennai', 'Kanchipuram'], verticals: ['sap_enterprise', 'cybersecurity', 'software_ai', 'corporate_training'], kind: 'organization', owner: 'bhead@kaizen.co.in', capacity: 40 },
    { name: 'Western TN — Enterprise', districts: ['Coimbatore', 'Erode', 'Salem'], verticals: ['sap_enterprise', 'cybersecurity', 'software_ai'], kind: 'organization', owner: 'director@kaizen.co.in', capacity: 35 },
    { name: 'Southern TN — Institutions', districts: ['Madurai', 'Tirunelveli', 'Dindigul', 'Thanjavur'], verticals: ['partnerships', 'education'], kind: 'institution', owner: 'bhead@kaizen.co.in', capacity: 60 },
    { name: 'State-wide — Placement', districts: [], verticals: ['placement'], kind: 'any', owner: 'director@kaizen.co.in', capacity: 50 },
  ];

  for (const t of territories) {
    const exists = await prisma.territory.findFirst({ where: { tenantId, name: t.name } });
    if (exists) continue;
    const owner = people.find((p) => p.email === t.owner);
    await prisma.territory.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('TER'),
        name: t.name,
        // The hard-coded district constant becomes seed data for a territory
        // row, not a platform-wide constant.
        geoAreaRef: t.districts,
        appliesToVerticals: t.verticals,
        appliesToAccountKind: t.kind,
        ownerPartyId: owner?.id ?? null,
        ownerPositionId: owner ? `pos_${owner.roleSlug}` : null,
        capacityCeiling: t.capacity,
      },
    });
  }

  const ruleExists = await prisma.routingRule.findFirst({ where: { tenantId } });
  if (!ruleExists) {
    await prisma.routingRule.create({
      data: {
        tenantId,
        name: 'Default six-factor routing',
        active: true,
        priority: 100,
        // Relationship strength is weighted equal to capacity deliberately: in
        // the institution motion, a warm existing contact beats an empty diary.
        factorWeights: { capacity: 30, capability: 25, relationship_strength: 30, round_robin: 15 },
        tieBreakMarginPoints: 5,
      },
    });
  }

  console.log(`  ${territories.length} territories and the six-factor routing rule`);
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

interface SeededOrg {
  id: string;
  name: string;
  hasAccount: boolean;
  hasInstitution: boolean;
  district: string;
}

async function seedOrganizations(): Promise<SeededOrg[]> {
  const tenantId = (await currentTenant()).id;

  const orgs: Array<{
    name: string; website: string; account?: { tier: string; terms: number };
    institution?: { type: string; management: string; district: string; students: number; aishe: string | null };
    district: string;
  }> = [
    { name: 'Sundaram Textiles Ltd', website: 'https://sundaramtextiles.example', account: { tier: 'strategic', terms: 45 }, district: 'Coimbatore' },
    { name: 'Meridian Financial Services', website: 'https://meridianfs.example', account: { tier: 'key', terms: 30 }, district: 'Chennai' },
    { name: 'Cauvery Logistics', website: 'https://cauverylogistics.example', account: { tier: 'standard', terms: 30 }, district: 'Tiruchirappalli' },
    { name: 'Nexa Healthcare Systems', website: 'https://nexahealth.example', account: { tier: 'key', terms: 60 }, district: 'Chennai' },
    { name: 'Vaigai Power Solutions', website: 'https://vaigaipower.example', account: { tier: 'standard', terms: 30 }, district: 'Madurai' },
    {
      // The commissioning example: a single legal body that is simultaneously
      // an admissions-partner institution AND a fee-paying corporate training
      // client. The legacy exclusive category enum could not represent this.
      name: 'Anna Institute of Technology',
      website: 'https://ait.example',
      account: { tier: 'key', terms: 45 },
      institution: { type: 'engineering_college', management: 'self_financing', district: 'Chennai', students: 4200, aishe: 'C-12345' },
      district: 'Chennai',
    },
    { name: 'Madurai Kamaraj Arts College', website: 'https://mkac.example', institution: { type: 'arts_science_college', management: 'aided', district: 'Madurai', students: 2800, aishe: 'C-23451' }, district: 'Madurai' },
    { name: 'Government Polytechnic Salem', website: 'https://gpsalem.example', institution: { type: 'polytechnic', management: 'government', district: 'Salem', students: 1400, aishe: null }, district: 'Salem' },
    { name: 'Thanjavur Engineering College', website: 'https://tec.example', institution: { type: 'engineering_college', management: 'self_financing', district: 'Thanjavur', students: 3100, aishe: 'C-34512' }, district: 'Thanjavur' },
    { name: 'Vellore Science Academy', website: 'https://vsa.example', institution: { type: 'arts_science_college', management: 'private', district: 'Vellore', students: 1900, aishe: 'C-45123' }, district: 'Vellore' },
    { name: 'TalentBridge Staffing', website: 'https://talentbridge.example', account: { tier: 'standard', terms: 30 }, district: 'Coimbatore' },
    { name: 'Zenith Manufacturing', website: 'https://zenithmfg.example', account: { tier: 'key', terms: 45 }, district: 'Erode' },
  ];

  const out: SeededOrg[] = [];

  for (const o of orgs) {
    let org = await prisma.organization.findFirst({ where: { tenantId, name: o.name } });
    if (!org) {
      org = await prisma.organization.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('ORG'),
          name: o.name,
          website: o.website,
          tags: [],
          // Retained transitionally for backward-compatible reporting only.
          legacyCategory: o.institution ? 'institution' : 'company',
        },
      });
    }

    if (o.account) {
      const exists = await prisma.account.findFirst({ where: { organizationId: org.id } });
      if (!exists) {
        await prisma.account.create({
          data: {
            tenantId,
            organizationId: org.id,
            tier: o.account.tier,
            paymentTermsDays: o.account.terms,
            billingEmail: `accounts@${o.website.replace('https://', '')}`,
          },
        });
      }
    }

    if (o.institution) {
      const exists = await prisma.institutionProfile.findFirst({ where: { organizationId: org.id } });
      if (!exists) {
        await prisma.institutionProfile.create({
          data: {
            tenantId,
            organizationId: org.id,
            institutionType: o.institution.type,
            managementType: o.institution.management,
            district: o.institution.district,
            state: 'Tamil Nadu',
            studentCount: o.institution.students,
            // Never fabricated: the government polytechnic legitimately has no
            // recorded identifier, so it is left null.
            externalIdentifier: o.institution.aishe,
            establishedYear: 1985 + (o.institution.students % 30),
            departments: ['Computer Science', 'Electronics', 'Mechanical'],
            strategicPriority: o.institution.students > 3000 ? 'high' : 'medium',
          },
        });
      }
    }

    out.push({ id: org.id, name: o.name, hasAccount: Boolean(o.account), hasInstitution: Boolean(o.institution), district: o.district });
  }

  console.log(`  ${out.length} organizations (one carries both specialisations simultaneously)`);
  return out;
}

// ---------------------------------------------------------------------------
// The commercial dataset
// ---------------------------------------------------------------------------

async function seedCommercialDataset(people: SeededPerson[], orgs: SeededOrg[], catalog: SeededOffering[]) {
  const tenantId = (await currentTenant()).id;

  const existingLeads = await prisma.lead.count({ where: { tenantId } });
  if (existingLeads > 0) {
    console.log('  commercial dataset already present — skipping');
    return;
  }

  const sales = people.filter((p) => p.roleSlug === 'sales');
  const counsellor = people.find((p) => p.roleSlug === 'education_counsellor')!;
  const placement = people.find((p) => p.roleSlug === 'workforce_placement')!;
  const telecaller = people.find((p) => p.roleSlug === 'telecaller')!;

  const pipelines = await prisma.pipelineDefinition.findMany({
    where: { tenantId },
    include: { stages: { where: { retiredAt: null, postAward: false }, orderBy: { sequence: 'asc' } } },
  });
  const byCode = new Map(pipelines.map((p) => [p.pipelineCode, p]));

  const accountOrgs = orgs.filter((o) => o.hasAccount);
  const institutionOrgs = orgs.filter((o) => o.hasInstitution);

  // ---- Contact people ------------------------------------------------------
  const contacts: Array<{ id: string; name: string; orgId: string }> = [];
  const contactNames = [
    'Hariharan Muthu', 'Deepa Varma', 'Karthik Raman', 'Sneha Pillai', 'Vignesh Anand',
    'Anjali Menon', 'Prakash Naidu', 'Revathi Iyer', 'Manoj Gupta', 'Shalini Rao',
    'Balaji Narayanan', 'Ritu Sharma',
  ];
  for (const [i, name] of contactNames.entries()) {
    const org = pick(orgs, i);
    const phone = `98${String(41000000 + i * 137).padStart(8, '0')}`;
    const person = await prisma.person.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('PER'),
        fullName: name,
        primaryPhone: phone,
        primaryPhoneNormalised: phone,
        primaryEmail: `${name.split(' ')[0].toLowerCase()}@${org.name.split(' ')[0].toLowerCase()}.example`,
        primaryEmailNormalised: `${name.split(' ')[0].toLowerCase()}@${org.name.split(' ')[0].toLowerCase()}.example`,
        source: 'seed',
      },
    });
    await prisma.affiliation.create({
      data: {
        tenantId,
        partyId: person.id,
        affiliationType: org.hasInstitution && !org.hasAccount ? 'institution_contact' : 'customer_contact',
        counterpartyId: org.id,
        counterpartyName: org.name,
        primaryFlag: true,
      },
    });
    await prisma.relationship.create({
      data: {
        tenantId,
        fromType: 'person',
        fromId: person.id,
        toType: 'organization',
        toId: org.id,
        relationshipType: i % 3 === 0 ? 'decision_maker_for' : 'employed_by',
        role: i % 3 === 0 ? 'Decision Maker' : 'Programme Contact',
        status: 'active',
        strength: i % 4 === 0 ? 'strong' : i % 2 === 0 ? 'moderate' : 'weak',
        ownerPartyId: pick(sales, i).id,
      },
    });
    contacts.push({ id: person.id, name, orgId: org.id });
  }

  // ---- Leads across every motion ------------------------------------------
  const leadSpecs: Array<{ title: string; vertical: Vertical; pipeline: string; orgIdx: number; owner: string | null; stageIdx: number; value: number; source: string; ageDays: number }> = [
    { title: 'S/4HANA migration assessment', vertical: 'sap_enterprise', pipeline: 'PL-ENTERPRISE', orgIdx: 0, owner: sales[0].id, stageIdx: 1, value: 8_500_000, source: 'referral', ageDays: 12 },
    { title: 'SOC evaluation for core banking', vertical: 'cybersecurity', pipeline: 'PL-ENTERPRISE', orgIdx: 1, owner: sales[1].id, stageIdx: 2, value: 7_800_000, source: 'inbound_website', ageDays: 21 },
    { title: 'Fleet telemetry AI pilot', vertical: 'software_ai', pipeline: 'PL-ENTERPRISE', orgIdx: 2, owner: sales[0].id, stageIdx: 0, value: 3_200_000, source: 'event', ageDays: 4 },
    { title: 'Clinical analytics platform', vertical: 'software_ai', pipeline: 'PL-ENTERPRISE', orgIdx: 3, owner: sales[1].id, stageIdx: 3, value: 6_000_000, source: 'referral', ageDays: 30 },
    // Deliberately unrouted at seed, so the unrouted queue and EX-CRM-004 have
    // a real case on first load.
    { title: 'Grid resilience advisory enquiry', vertical: 'research', pipeline: 'PL-ENTERPRISE', orgIdx: 4, owner: null, stageIdx: 0, value: 1_500_000, source: 'inbound_website', ageDays: 6 },
    { title: 'MoU for placement partnership', vertical: 'partnerships', pipeline: 'PL-INSTITUTION', orgIdx: 6, owner: counsellor.id, stageIdx: 1, value: 0, source: 'campaign', ageDays: 45 },
    { title: 'Campus programme partnership', vertical: 'partnerships', pipeline: 'PL-INSTITUTION', orgIdx: 8, owner: counsellor.id, stageIdx: 2, value: 0, source: 'referral', ageDays: 18 },
    { title: 'Full stack admission — Chennai batch', vertical: 'education', pipeline: 'PL-ADMISSION', orgIdx: 5, owner: counsellor.id, stageIdx: 1, value: 60_000, source: 'inbound_website', ageDays: 2 },
    { title: 'Data science admission enquiry', vertical: 'education', pipeline: 'PL-ADMISSION', orgIdx: 9, owner: telecaller.id, stageIdx: 0, value: 75_000, source: 'campaign', ageDays: 7 },
    { title: 'Bulk hiring — 40 developers', vertical: 'placement', pipeline: 'PL-PLACEMENT', orgIdx: 10, owner: placement.id, stageIdx: 2, value: 1_800_000, source: 'referral', ageDays: 14 },
    { title: 'Manufacturing graduate intake', vertical: 'placement', pipeline: 'PL-PLACEMENT', orgIdx: 11, owner: placement.id, stageIdx: 1, value: 900_000, source: 'event', ageDays: 25 },
    { title: 'Leadership programme for senior managers', vertical: 'corporate_training', pipeline: 'PL-ENTERPRISE', orgIdx: 11, owner: sales[0].id, stageIdx: 1, value: 1_800_000, source: 'campaign', ageDays: 9 },
  ];

  for (const [i, spec] of leadSpecs.entries()) {
    const pipeline = byCode.get(spec.pipeline)!;
    const stage = pipeline.stages[spec.stageIdx] ?? pipeline.stages[0];
    const org = orgs[spec.orgIdx];
    const contact = contacts.find((c) => c.orgId === org.id) ?? contacts[i % contacts.length];
    const offering = catalog.find((c) => c.vertical === spec.vertical) ?? catalog[0];
    const stageEnteredAt = new Date(Date.now() - spec.ageDays * 86_400_000);

    const lead = await prisma.lead.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('LEAD'),
        title: spec.title,
        personId: contact.id,
        organizationId: org.id,
        vertical: spec.vertical,
        offeringId: offering.id,
        pipelineId: pipeline.id,
        stageKey: stage.stageKey,
        stageEnteredAt,
        leadStatus: 'open',
        ownerPartyId: spec.owner,
        unroutedReason: spec.owner ? null : 'no_vertical_coverage',
        routedAt: spec.owner ? stageEnteredAt : null,
        score: 40 + ((i * 7) % 55),
        scoreReasons: ['+15 reachable by phone', '+20 linked to a known organization', `+${8 + (i % 12)} source: ${spec.source}`],
        source: spec.source,
        estimatedValue: spec.value || undefined,
        currency: 'INR',
        lastInteractionAt: i % 4 === 0 ? null : new Date(Date.now() - (spec.ageDays - 1) * 86_400_000),
        createdAt: stageEnteredAt,
      },
    });

    // Interactions, so timelines and the untouched detector have real inputs.
    if (i % 4 !== 0) {
      await prisma.interaction.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('INT'),
          interactionType: pick(['call', 'email', 'meeting', 'whatsapp'], i),
          direction: i % 2 === 0 ? 'outbound' : 'inbound',
          occurredAt: new Date(Date.now() - (spec.ageDays - 1) * 86_400_000),
          actorPartyId: spec.owner ?? telecaller.id,
          participantPartyIds: [contact.id],
          durationMinutes: 15 + ((i * 5) % 40),
          subject: `Discovery on ${spec.title}`,
          notes: 'Discussed scope, timeline and the internal approval path.',
          outcome: pick(['connected', 'meeting_scheduled', 'information_shared', 'follow_up_required'], i),
          relatedReferences: [
            { contextCode: 'crm', entityType: 'lead', entityId: lead.id, displayLabel: lead.title, recordCode: lead.recordCode },
            { contextCode: 'idn', entityType: 'person', entityId: contact.id, displayLabel: contact.name },
          ] as never,
          sensitivityClass: 'internal',
        },
      });
    }
  }

  // ---- Opportunities -------------------------------------------------------
  const oppSpecs: Array<{
    title: string; vertical: Vertical; pipeline: string; orgIdx: number; owner: string;
    stageIdx: number; value: number; forecast: string; ageDays: number; closeInDays: number;
    strategic: string | null; outcome?: string;
  }> = [
    { title: 'Sundaram — S/4HANA implementation', vertical: 'sap_enterprise', pipeline: 'PL-ENTERPRISE', orgIdx: 0, owner: sales[0].id, stageIdx: 5, value: 9_200_000, forecast: 'commit', ageDays: 11, closeInDays: 25, strategic: 'high' },
    { title: 'Meridian — managed SOC rollout', vertical: 'cybersecurity', pipeline: 'PL-ENTERPRISE', orgIdx: 1, owner: sales[1].id, stageIdx: 4, value: 7_800_000, forecast: 'best_case', ageDays: 26, closeInDays: 45, strategic: 'high' },
    { title: 'Nexa — clinical analytics platform', vertical: 'software_ai', pipeline: 'PL-ENTERPRISE', orgIdx: 3, owner: sales[1].id, stageIdx: 3, value: 6_000_000, forecast: 'pipeline', ageDays: 34, closeInDays: 70, strategic: 'medium' },
    { title: 'Cauvery — fleet telemetry AI', vertical: 'software_ai', pipeline: 'PL-ENTERPRISE', orgIdx: 2, owner: sales[0].id, stageIdx: 2, value: 3_200_000, forecast: 'pipeline', ageDays: 8, closeInDays: 90, strategic: 'low' },
    { title: 'Zenith — leadership programme', vertical: 'corporate_training', pipeline: 'PL-ENTERPRISE', orgIdx: 11, owner: sales[0].id, stageIdx: 4, value: 1_900_000, forecast: 'best_case', ageDays: 15, closeInDays: 30, strategic: 'medium' },
    // Deliberately stale: expected close date in the past while sitting in
    // commit, so AU-CRM-010 has a real demotion to make on the first job run.
    { title: 'Vaigai — VAPT engagement', vertical: 'cybersecurity', pipeline: 'PL-ENTERPRISE', orgIdx: 4, owner: sales[1].id, stageIdx: 5, value: 1_250_000, forecast: 'commit', ageDays: 40, closeInDays: -8, strategic: 'medium' },
    { title: 'Anna Institute — campus MoU', vertical: 'partnerships', pipeline: 'PL-INSTITUTION', orgIdx: 5, owner: counsellor.id, stageIdx: 4, value: 0, forecast: 'best_case', ageDays: 22, closeInDays: 40, strategic: 'high' },
    { title: 'Madurai Kamaraj — placement MoU', vertical: 'partnerships', pipeline: 'PL-INSTITUTION', orgIdx: 6, owner: counsellor.id, stageIdx: 3, value: 0, forecast: 'pipeline', ageDays: 48, closeInDays: 60, strategic: 'high' },
    { title: 'TalentBridge — 40 developer intake', vertical: 'placement', pipeline: 'PL-PLACEMENT', orgIdx: 10, owner: placement.id, stageIdx: 4, value: 1_800_000, forecast: 'commit', ageDays: 12, closeInDays: 20, strategic: 'medium' },
    { title: 'Zenith — graduate intake 2026', vertical: 'placement', pipeline: 'PL-PLACEMENT', orgIdx: 11, owner: placement.id, stageIdx: 2, value: 900_000, forecast: 'pipeline', ageDays: 27, closeInDays: 75, strategic: 'low' },
    { title: 'Thanjavur Engineering — cohort partnership', vertical: 'partnerships', pipeline: 'PL-INSTITUTION', orgIdx: 8, owner: counsellor.id, stageIdx: 1, value: 0, forecast: 'pipeline', ageDays: 55, closeInDays: 120, strategic: 'medium' },
    { title: 'Vellore Science — admissions channel', vertical: 'partnerships', pipeline: 'PL-INSTITUTION', orgIdx: 9, owner: counsellor.id, stageIdx: 2, value: 0, forecast: 'pipeline', ageDays: 19, closeInDays: 95, strategic: 'low' },
  ];

  const createdOpps: Array<{ id: string; recordCode: string; title: string; orgId: string; value: number; owner: string; strategic: string | null }> = [];

  for (const [i, spec] of oppSpecs.entries()) {
    const pipeline = byCode.get(spec.pipeline)!;
    const stage = pipeline.stages[spec.stageIdx] ?? pipeline.stages[0];
    const org = orgs[spec.orgIdx];
    const contact = contacts.find((c) => c.orgId === org.id) ?? contacts[i % contacts.length];
    const offering = catalog.find((c) => c.vertical === spec.vertical) ?? catalog[0];
    const stageEnteredAt = new Date(Date.now() - spec.ageDays * 86_400_000);

    const opp = await prisma.opportunity.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('OPP'),
        title: spec.title,
        organizationId: org.id,
        primaryContactPersonId: contact.id,
        vertical: spec.vertical,
        offeringId: offering.id,
        pipelineId: pipeline.id,
        stageKey: stage.stageKey,
        stageEnteredAt,
        forecastCategory: spec.forecast,
        forecastCategoryChangedAt: stageEnteredAt,
        expectedValue: spec.value || undefined,
        currency: 'INR',
        expectedCloseDate: daysFromNow(spec.closeInDays),
        ownerPartyId: spec.owner,
        strategicValue: spec.strategic,
        createdAt: stageEnteredAt,
      },
    });

    createdOpps.push({ id: opp.id, recordCode: opp.recordCode, title: opp.title, orgId: org.id, value: spec.value, owner: spec.owner, strategic: spec.strategic });

    await prisma.interaction.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('INT'),
        interactionType: pick(['meeting', 'call', 'demo'], i),
        direction: 'outbound',
        occurredAt: new Date(Date.now() - Math.max(spec.ageDays - 3, 1) * 86_400_000),
        actorPartyId: spec.owner,
        participantPartyIds: [contact.id],
        durationMinutes: 45,
        subject: `Solution review — ${spec.title}`,
        notes: 'Walked the proposed architecture and commercial shape. Committee review scheduled.',
        outcome: 'meeting_scheduled',
        relatedReferences: [
          { contextCode: 'crm', entityType: 'opportunity', entityId: opp.id, displayLabel: opp.title, recordCode: opp.recordCode },
          { contextCode: 'crm', entityType: 'organization', entityId: org.id, displayLabel: org.name },
        ] as never,
        sensitivityClass: 'internal',
      },
    });
  }

  // ---- Won deals, with the award artefact that satisfies the gate ----------
  const wonSpecs = [
    { title: 'Sundaram — AMS renewal FY25', orgIdx: 0, owner: sales[0].id, value: 5_400_000, closedDaysAgo: 40 },
    { title: 'Meridian — VAPT engagement 2025', orgIdx: 1, owner: sales[1].id, value: 1_200_000, closedDaysAgo: 75 },
    { title: 'Nexa — AI readiness assessment', orgIdx: 3, owner: sales[0].id, value: 850_000, closedDaysAgo: 20 },
  ];

  const enterprise = byCode.get('PL-ENTERPRISE')!;
  const wonStage = enterprise.stages.find((s) => s.pipelinePosition === 90)!;

  for (const [i, w] of wonSpecs.entries()) {
    const org = orgs[w.orgIdx];
    const closedAt = new Date(Date.now() - w.closedDaysAgo * 86_400_000);

    const opp = await prisma.opportunity.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('OPP'),
        title: w.title,
        organizationId: org.id,
        vertical: 'sap_enterprise',
        offeringId: catalog[0].id,
        pipelineId: enterprise.id,
        stageKey: wonStage.stageKey,
        stageEnteredAt: closedAt,
        forecastCategory: 'closed_won',
        expectedValue: w.value,
        currency: 'INR',
        expectedCloseDate: closedAt,
        ownerPartyId: w.owner,
        strategicValue: 'medium',
        outcome: 'won',
        closedAt,
        createdAt: new Date(closedAt.getTime() - 60 * 86_400_000),
      },
    });

    // The won-gate is satisfied by a real signed contract, not a document
    // reference — a document's existence proves nothing about signature.
    const contract = await prisma.contract.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('CON'),
        title: w.title,
        organizationId: org.id,
        opportunityId: opp.id,
        status: 'active',
        commercialValue: w.value,
        currency: 'INR',
        strategicValue: 'medium',
        termMonths: 12,
        startDate: closedAt,
        // The first contract expires inside the 120-day ladder, so the expiry
        // detector has a real rung to fire on.
        endDate: daysFromNow(i === 0 ? 85 : 300 + i * 40),
        signedDate: closedAt,
        ownerPartyId: w.owner,
      },
    });

    await prisma.opportunity.update({ where: { id: opp.id }, data: { contractId: contract.id } });

    const project = await prisma.project.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('PRJ'),
        name: w.title,
        organizationId: org.id,
        opportunityId: opp.id,
        contractId: contract.id,
        status: i === 0 ? 'active' : 'planned',
        startDate: closedAt,
        targetEndDate: daysFromNow(120),
        scheduleVariancePct: i * 8,
        healthBand: i === 2 ? 'watch' : 'stable',
        // The third project's handoff is deliberately unaccepted, so
        // EX-CRM-012 and the H_DLV handoff factor have something real.
        handoffAcceptedAt: i === 2 ? null : closedAt,
      },
    });

    // Money: the signed contract's invoice, with partial allocation, so the
    // receipt join has real work to do.
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('INV'),
        organizationId: org.id,
        contractId: contract.id,
        opportunityId: opp.id,
        status: 'issued',
        currency: 'INR',
        issuedDate: closedAt,
        dueDate: new Date(closedAt.getTime() + 30 * 86_400_000),
      },
    });
    await prisma.invoiceLine.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        offeringId: catalog[0].id,
        description: `${contract.recordCode} — ${w.title}`,
        amount: w.value,
        revenueMethod: 'milestone_based',
      },
    });

    if (i < 2) {
      const payment = await prisma.payment.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('PAY'),
          amount: i === 0 ? w.value : w.value * 0.4,
          currency: 'INR',
          gatewayReference: `TXN-${randomUUID().slice(0, 12).toUpperCase()}`,
          receivedAt: new Date(closedAt.getTime() + 12 * 86_400_000),
          status: 'received',
          method: 'bank_transfer',
          payerOrganizationId: org.id,
        },
      });
      await prisma.receipt.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('REC'),
          paymentId: payment.id,
          invoiceId: invoice.id,
          allocatedAmount: i === 0 ? w.value : w.value * 0.4,
        },
      });
      await prisma.invoice.update({ where: { id: invoice.id }, data: { status: i === 0 ? 'settled' : 'part_paid' } });
    }

    await prisma.receivablesProjection.upsert({
      where: { tenantId_subjectType_subjectId: { tenantId, subjectType: 'account', subjectId: org.id } },
      create: {
        tenantId,
        subjectType: 'account',
        subjectId: org.id,
        subjectLabel: org.name,
        amountOutstanding: i === 0 ? 0 : i === 1 ? w.value * 0.6 : w.value,
        currency: 'INR',
        nextDueDate: new Date(closedAt.getTime() + 30 * 86_400_000),
        dunningStage: i === 2 ? 'chase' : i === 1 ? 'reminder' : null,
      },
      update: {},
    });
  }

  // ---- Lost deals with structured post-mortems -----------------------------
  const lostStage = enterprise.stages.find((s) => s.pipelinePosition === 0)!;
  const lostSpecs = [
    { title: 'Cauvery — ERP consolidation', orgIdx: 2, owner: sales[0].id, value: 4_200_000, reason: 'competitor', competitor: 'Larsen Digital', strategic: 'high', complete: true },
    { title: 'Vaigai — cyber posture review', orgIdx: 4, owner: sales[1].id, value: 620_000, reason: 'no_budget', competitor: null, strategic: 'low', complete: false },
  ];

  for (const l of lostSpecs) {
    const org = orgs[l.orgIdx];
    const closedAt = new Date(Date.now() - 30 * 86_400_000);
    const opp = await prisma.opportunity.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('OPP'),
        title: l.title,
        organizationId: org.id,
        vertical: 'sap_enterprise',
        offeringId: catalog[0].id,
        pipelineId: enterprise.id,
        stageKey: lostStage.stageKey,
        stageEnteredAt: closedAt,
        forecastCategory: 'closed_lost',
        expectedValue: l.value,
        currency: 'INR',
        ownerPartyId: l.owner,
        strategicValue: l.strategic,
        outcome: 'lost',
        lostReason: l.reason,
        closedAt,
        createdAt: new Date(closedAt.getTime() - 90 * 86_400_000),
      },
    });

    // The OR gate, computed once at terminal-state entry and frozen.
    const mandatory = l.strategic === 'high' || l.value >= 500_000;
    await prisma.winLossReview.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('WLR'),
        subjectType: 'opportunity',
        subjectId: opp.id,
        subjectLabel: `${opp.recordCode} — ${opp.title}`,
        outcome: 'lost',
        competitorName: l.complete ? l.competitor : null,
        realLostStage: l.complete ? 'solution_shaped' : null,
        lostReason: l.reason,
        lesson: l.complete ? 'We were shaped out at architecture review because the incumbent already held the integration layer. Qualify integration ownership at the qualified stage, not at proposal.' : null,
        mandatory,
        mandatoryBasis: mandatory
          ? [l.strategic === 'high' ? 'strategic_value=high' : null, l.value >= 500_000 ? 'commercial_value>=500000' : null].filter(Boolean).join(' OR ')
          : 'not_mandatory',
        strategicValueSnapshot: l.strategic,
        commercialValueSnapshot: l.value,
        thresholdUsedSnapshot: 500_000,
        completedAt: l.complete ? new Date(closedAt.getTime() + 5 * 86_400_000) : null,
        completedById: l.complete ? l.owner : null,
        // The incomplete one is past its grace period, so the overdue detector
        // has a real case.
        dueAt: mandatory ? new Date(closedAt.getTime() + 10 * 86_400_000) : null,
      },
    });

    if (l.complete) {
      await prisma.lesson.create({
        data: {
          tenantId,
          sourceType: 'win_loss_review',
          sourceId: opp.id,
          title: `Lost: ${opp.title}`,
          body: 'Qualify integration ownership at the qualified stage, not at proposal. An incumbent holding the integration layer shapes the architecture review before we arrive.',
          domain: 'crm',
          tags: ['lost', 'competitor', 'sap_enterprise'],
        },
      });
    }
  }

  // ---- MoUs, including one inside the expiry ladder ------------------------
  const mouSpecs = [
    { title: 'Anna Institute — campus partnership MoU', orgIdx: 5, status: 'active', value: 0, strategic: 'high', endInDays: 25, owner: counsellor.id },
    { title: 'Madurai Kamaraj — placement MoU', orgIdx: 6, status: 'signed', value: 250_000, strategic: 'medium', endInDays: 200, owner: counsellor.id },
    { title: 'Government Polytechnic Salem — skills MoU', orgIdx: 7, status: 'negotiating', value: 0, strategic: 'high', endInDays: 365, owner: counsellor.id },
    { title: 'Vellore Science — admissions channel MoU', orgIdx: 9, status: 'proposed', value: 1_500_000, strategic: 'high', endInDays: 400, owner: counsellor.id },
  ];

  for (const m of mouSpecs) {
    const org = orgs[m.orgIdx];
    await prisma.mou.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('MOU'),
        // The pre-migration three-digit value, preserved verbatim.
        legacyReference: `KAIZEN-2024-${String(101 + m.orgIdx).padStart(3, '0')}`,
        title: m.title,
        organizationId: org.id,
        institutionId: org.hasInstitution ? org.id : null,
        scope: 'Placement support, campus programmes and joint certification.',
        vertical: 'partnerships',
        status: m.status,
        commercialValue: m.value,
        currency: 'INR',
        strategicValue: m.strategic,
        termMonths: 24,
        startDate: daysFromNow(-200),
        endDate: daysFromNow(m.endInDays),
        signedDate: ['signed', 'active'].includes(m.status) ? daysFromNow(-195) : null,
        ownerPartyId: m.owner,
      },
    });
  }

  // ---- Partner agreements --------------------------------------------------
  const partnerOrg = orgs[10];
  const rel = await prisma.relationship.create({
    data: {
      tenantId,
      fromType: 'organization',
      fromId: 'kaizen',
      toType: 'organization',
      toId: partnerOrg.id,
      relationshipType: 'partner_of',
      role: 'placement_channel',
      status: 'active',
      strength: 'strong',
      ownerPartyId: placement.id,
    },
  });
  await prisma.partnerAgreement.create({
    data: {
      tenantId,
      recordCode: await nextRecordCode('PA'),
      title: 'TalentBridge — placement channel agreement',
      partnerOrganizationId: partnerOrg.id,
      relationshipId: rel.id,
      agreementType: 'placement_channel',
      scope: 'Candidate sourcing and placement fulfilment across Tamil Nadu.',
      territoryScope: 'Tamil Nadu',
      status: 'active',
      commercialValue: 2_400_000,
      currency: 'INR',
      strategicValue: 'medium',
      termMonths: 12,
      startDate: daysFromNow(-120),
      endDate: daysFromNow(245),
      signedDate: daysFromNow(-118),
      ownerPartyId: placement.id,
    },
  });

  // ---- Proposals and quotes, including a blocked discount ------------------
  const proposalTargets = createdOpps.slice(0, 4);
  for (const [i, target] of proposalTargets.entries()) {
    const sentAt = new Date(Date.now() - (i === 0 ? 9 : 3 + i) * 86_400_000);
    const proposal = await prisma.proposal.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('PRO'),
        opportunityId: target.id,
        title: `Proposal — ${target.title}`,
        totalValue: target.value || 1_000_000,
        currency: 'INR',
        sentAt,
        validUntil: new Date(sentAt.getTime() + 30 * 86_400_000),
        response: 'pending',
        ownerPartyId: target.owner,
      },
    });
    await prisma.opportunity.update({
      where: { id: target.id },
      data: { proposalId: proposal.id, proposalSentAt: sentAt },
    });
  }

  const sapPrice = catalog.find((c) => c.offeringCode === 'SAP-S4-IMPL')!;
  const cyberPrice = catalog.find((c) => c.offeringCode === 'CYBER-SOC')!;

  if (sapPrice.priceBookEntryId && cyberPrice.priceBookEntryId) {
    // A within-ceiling quote, issued cleanly.
    const okQuote = await prisma.quote.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('QUO'),
        opportunityId: createdOpps[0].id,
        version: 1,
        status: 'issued',
        currency: 'INR',
        subtotal: sapPrice.unitPrice,
        discountTotal: sapPrice.unitPrice * 0.08,
        grandTotal: sapPrice.unitPrice * 0.92,
        issuedAt: daysFromNow(-6),
        validUntil: daysFromNow(24),
        ownerPartyId: createdOpps[0].owner,
      },
    });
    await prisma.quoteLine.create({
      data: {
        tenantId,
        quoteId: okQuote.id,
        priceBookEntryId: sapPrice.priceBookEntryId,
        priceBookEntryVersion: 1,
        quantity: 1,
        listUnitPrice: sapPrice.unitPrice,
        discountPct: 8,
        discountAmount: sapPrice.unitPrice * 0.08,
        lineTotal: sapPrice.unitPrice * 0.92,
      },
    });
    await prisma.opportunity.update({ where: { id: createdOpps[0].id }, data: { quoteId: okQuote.id } });

    // An over-ceiling quote: the WHOLE quote blocks, with an approval step
    // resolved onto the finance controller.
    const controller = people.find((p) => p.roleSlug === 'finance_controller')!;
    const blockedQuote = await prisma.quote.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('QUO'),
        opportunityId: createdOpps[1].id,
        version: 1,
        status: 'blocked',
        currency: 'INR',
        subtotal: cyberPrice.unitPrice * 12,
        discountTotal: cyberPrice.unitPrice * 12 * 0.22,
        grandTotal: cyberPrice.unitPrice * 12 * 0.78,
        blockedReason: `Managed SOC: 22% exceeds the ${cyberPrice.maxDiscountPct}% ceiling`,
        ownerPartyId: createdOpps[1].owner,
      },
    });
    await prisma.quoteLine.create({
      data: {
        tenantId,
        quoteId: blockedQuote.id,
        priceBookEntryId: cyberPrice.priceBookEntryId,
        priceBookEntryVersion: 1,
        quantity: 12,
        listUnitPrice: cyberPrice.unitPrice,
        discountPct: 22,
        discountAmount: cyberPrice.unitPrice * 12 * 0.22,
        lineTotal: cyberPrice.unitPrice * 12 * 0.78,
      },
    });
    const step = await prisma.approvalStep.create({
      data: {
        tenantId,
        subjectType: 'quote',
        subjectId: blockedQuote.id,
        subjectLabel: blockedQuote.recordCode,
        action: 'quote.issue',
        requestedById: createdOpps[1].owner,
        requestedValue: cyberPrice.unitPrice * 12 * 0.78,
        currency: 'INR',
        resolvedApproverId: controller.id,
        resolvedApproverRole: 'finance_controller',
        slaDueAt: daysFromNow(2),
      },
    });
    await prisma.quote.update({ where: { id: blockedQuote.id }, data: { approvalStepId: step.id } });
  }

  // ---- Open tasks ----------------------------------------------------------
  for (const [i, target] of createdOpps.slice(0, 6).entries()) {
    await prisma.task.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('TSK'),
        title: pick(['Send revised commercials', 'Confirm committee date', 'Chase signed NDA', 'Prepare architecture walkthrough'], i),
        assigneePartyId: target.owner,
        ownerPartyId: target.owner,
        dueAt: daysFromNow(i - 2),
        relatedType: 'opportunity',
        relatedId: target.id,
        status: 'open',
      },
    });
  }

  console.log(`  ${leadSpecs.length} leads, ${oppSpecs.length + wonSpecs.length + lostSpecs.length} opportunities, ${mouSpecs.length} MoUs, 3 contracts, quotes, invoices and tasks`);
}

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

async function seedEducation(people: SeededPerson[], orgs: SeededOrg[]) {
  const tenantId = (await currentTenant()).id;
  const existing = await prisma.course.count({ where: { tenantId } });
  if (existing > 0) return;

  const trainer = people.find((p) => p.roleSlug === 'trainer')!;
  const institution = orgs.find((o) => o.hasInstitution)!;

  const courses = [
    { name: 'Full Stack Development', code: 'FSD-24', weeks: 24 },
    { name: 'Applied Data Science', code: 'ADS-20', weeks: 20 },
  ];

  const learnerNames = [
    'Aishwarya Ganesan', 'Bharath Kumar', 'Chitra Devi', 'Dinesh Raj', 'Elakkiya Murugan',
    'Farhan Ahmed', 'Gayathri Selvan', 'Harish Babu', 'Indira Natarajan', 'Jagan Mohan',
    'Kalaivani Rajan', 'Lokesh Prabhu',
  ];

  for (const [ci, c] of courses.entries()) {
    const course = await prisma.course.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('CRS'),
        name: c.name,
        code: c.code,
        description: `${c.weeks}-week cohort programme with placement support.`,
        durationWeeks: c.weeks,
      },
    });

    const cohort = await prisma.cohort.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('COH'),
        courseId: course.id,
        name: `${c.code} — Chennai ${2026 + ci}`,
        startDate: daysFromNow(-60 + ci * 20),
        endDate: daysFromNow(c.weeks * 7 - 60),
        trainerPartyId: trainer.id,
        institutionId: institution.id,
        capacity: 30,
        status: 'active',
      },
    });

    const slice = learnerNames.slice(ci * 6, ci * 6 + 6);
    for (const [li, name] of slice.entries()) {
      const phone = `97${String(31000000 + ci * 1000 + li * 17).padStart(8, '0')}`;
      const person = await prisma.person.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('PER'),
          fullName: name,
          primaryPhone: phone,
          primaryPhoneNormalised: phone,
          source: 'admissions',
        },
      });
      await prisma.affiliation.create({
        data: {
          tenantId,
          partyId: person.id,
          affiliationType: 'student',
          counterpartyName: cohort.name,
          counterpartyId: cohort.id,
          primaryFlag: true,
          // A student affiliation carries a statutory retention floor.
          statutoryRetentionFloor: true,
        },
      });

      const isMinor = li === 0;
      const attendance = li === 1 ? 58 : li === 4 ? 66 : 80 + ((li * 7) % 18);

      await prisma.enrollment.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('ENR'),
          legacyReference: `CERT-${c.code}-${li + 1}`,
          personId: person.id,
          cohortId: cohort.id,
          status: 'active',
          enrolledAt: daysFromNow(-55 + ci * 20),
          progressPct: 30 + ((li * 11) % 50),
          attendancePct: attendance,
          // Attendance below 70% flags risk, computed from records rather than
          // hand-maintained.
          atRisk: attendance < 70,
          isMinor,
          // Regulated (DPDP-covered) — read-audited, structurally excluded from
          // any projection whose viewer's ceiling does not clear it.
          guardianName: isMinor ? 'Ganesan Subramaniam' : null,
          guardianPhone: isMinor ? '9840777001' : null,
          guardianEmail: isMinor ? 'guardian@example.com' : null,
        },
      });
    }
  }

  console.log(`  ${courses.length} courses, 2 cohorts, 12 enrollments (one minor with regulated guardian contact)`);
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * One open MERGE_CANDIDATE, raised the only way one can be: by putting a
 * genuine near-duplicate through `findOrCreatePerson` and letting the resolver
 * refuse it. Seeding the row directly would demonstrate the queue without
 * demonstrating the thing that fills it.
 *
 * The scenario is the ordinary one — the same human reaching the company twice,
 * once through a web enquiry and once through a phone call, with one identifier
 * shared and one differing. That partial match is exactly the case the resolver
 * is biased to refuse.
 */
async function seedMergeCandidate(_people: SeededPerson[]) {
  const shared = '9884412200';

  const first = await findOrCreatePerson({
    fullName: 'Ramesh Kumaravel',
    primaryPhone: shared,
    primaryEmail: 'ramesh.k@vaigaipower.example',
    source: 'web_enquiry',
  });

  try {
    // Same phone, different email: one identifier matches and one does not, so
    // this resolves to neither an existing person nor a new one.
    await findOrCreatePerson({
      fullName: 'R. Kumaravel',
      primaryPhone: shared,
      primaryEmail: 'rameshk@gmail.example',
      source: 'inbound_call',
    });
    console.log('  merge candidate  NOT raised — the resolver auto-merged, which it should not have');
  } catch {
    console.log(`  merge candidate  open, against ${first.person.recordCode} (partial match)`);
  }
}

async function seedDecisions(people: SeededPerson[]) {
  const tenantId = (await currentTenant()).id;
  const existing = await prisma.decision.count({ where: { tenantId } });
  if (existing > 0) return;

  const chairman = people.find((p) => p.roleSlug === 'chairman')!;
  const contract = await prisma.contract.findFirst({ where: { tenantId }, orderBy: { commercialValue: 'desc' } });
  const mou = await prisma.mou.findFirst({ where: { tenantId, strategicValue: 'high' } });

  if (contract) {
    await prisma.decision.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('DEC'),
        question: 'Should we extend payment terms to 90 days for Sundaram Textiles in exchange for a two-year AMS commitment?',
        state: 'AwaitingAuthority',
        subjectType: 'contract',
        subjectId: contract.id,
        subjectLabel: `${contract.recordCode} — ${contract.title}`,
        authorityBasis: 'contract_approval',
        requiredAuthorityValue: 5_400_000,
        currency: 'INR',
        routedToPartyId: chairman.id,
        routedToRole: 'chairman',
        evidenceComplete: true,
        // Seven components, assembled before routing.
        evidencePack: {
          question: 'Extend payment terms to 90 days in exchange for a two-year AMS commitment?',
          rejectedOptions: [
            { option: 'Hold at 45 days', outcome: 'Customer likely re-tenders at renewal', risk: 'Loses a strategic account', cost: 'Nil now, 5.4M at renewal' },
            { option: 'Extend to 60 days only', outcome: 'Partial concession, no commitment secured', risk: 'Concession without reciprocity', cost: 'Working capital, no upside' },
          ],
          noActionOption: { option: 'Take no action', consequence: 'Terms stay at 45 days and the AMS commitment lapses at renewal.', by: 'the renewal date' },
          subjectState: { status: contract.status, commercialValue: 5_400_000 },
          lastFiveTransitions: [],
          nearestPrecedents: [],
          constraintsAndGrant: { constraint: 'Requires contract_approval authority for 5,400,000 INR.', grantExercised: 'contract_approval ceiling 100,000,000' },
          modelView: { label: 'Model view', statement: 'Working capital impact of ~₹6.6L over the extended window, against a two-year commitment worth ₹1.08 Cr.', isModel: true },
          noActionConsequence: { statement: 'Terms stay at 45 days and the AMS commitment lapses at renewal.', by: 'the renewal date' },
          complete: true,
          missingComponents: [],
        } as never,
        pointOfNoReturn: daysFromNow(21),
        slaDueAt: daysFromNow(3),
        raisedAt: daysFromNow(-2),
      },
    });
  }

  if (mou) {
    // Deliberately incomplete: renders `Analysing` with a visible clock rather
    // than presenting as decidable.
    await prisma.decision.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('DEC'),
        question: 'Should the Anna Institute partnership be widened to include a joint certification track?',
        state: 'Analysing',
        subjectType: 'mou',
        subjectId: mou.id,
        subjectLabel: `${mou.recordCode} — ${mou.title}`,
        authorityBasis: 'mou_approval',
        currency: 'INR',
        routedToPartyId: chairman.id,
        routedToRole: 'chairman',
        evidenceComplete: false,
        evidencePack: {
          question: 'Widen the Anna Institute partnership to a joint certification track?',
          rejectedOptions: [],
          noActionOption: { option: 'Take no action', consequence: 'The partnership continues on placement support alone.', by: 'the MoU end date' },
          subjectState: { status: mou.status },
          lastFiveTransitions: [],
          nearestPrecedents: [],
          constraintsAndGrant: { constraint: 'Requires mou_approval authority.', grantExercised: 'mou_approval ceiling 100,000,000' },
          modelView: null,
          noActionConsequence: { statement: 'The partnership continues on placement support alone.', by: 'the MoU end date' },
          complete: false,
          missingComponents: ['question_and_rejected_options', 'three_nearest_precedents'],
        } as never,
        slaDueAt: daysFromNow(5),
        raisedAt: daysFromNow(-1),
      },
    });
  }

  console.log('  2 decisions (one decidable, one Analysing with an incomplete evidence pack)');
}

// ---------------------------------------------------------------------------

async function currentTenant() {
  const t = await unscopedPrisma.tenant.findFirstOrThrow({ where: { slug: TENANT_SLUG } });
  return t;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
