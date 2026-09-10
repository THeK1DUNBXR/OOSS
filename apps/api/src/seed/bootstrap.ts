/**
 * Bootstrap: everything a brand-new company needs before it holds any data of
 * its own, and nothing else.
 *
 * This file used to seed a demonstration — fifteen invented staff, a fictional
 * pipeline of deals, seven months of somebody else's ledger — so that every
 * screen had something on it. That is a good way to show a platform and a bad
 * way to ship one: the first thing a real company had to do was work out which
 * rows were theirs and delete the rest, and a figure on the founder's dashboard
 * was never trustworthy until they had.
 *
 * So the demonstration moved to `src/tests/fixtures/`, where it is a set of
 * test subjects and cannot reach production, and what remains here is
 * structure:
 *
 *   - the tenant itself
 *   - thresholds, so every tunable constant is a row from the first minute
 *   - sensitivity registrations, so an unregistered entity type fails closed
 *   - the governance policy and the three-role grant matrix
 *   - pipeline definitions, the navigation registry, agent registrations
 *   - statutory leave types
 *   - one account: the chairman, who then invites everybody else
 *
 * None of that is data about the company. It is the shape of the box the
 * company's data goes in, and a tenant without it cannot function.
 *
 * Idempotent by construction: every block checks before it writes, so this runs
 * on every deploy rather than once, and re-running it never alters a GRANT.
 */

import { randomUUID } from 'node:crypto';
import { AI_TOUCHPOINTS, EVENTS } from '@kaizen/shared';
import { prisma, unscopedPrisma } from '../platform/db.js';
import { asSystem } from '../platform/context.js';
import { hashPassword } from '../lib/auth.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ROLE_DEFINITIONS, ROLE_GRANT_MATRIX, parseCell } from './grants.js';
import { PIPELINE_SEEDS, RETIRED_POST_AWARD_STAGES, transitionsFor } from './pipelines.js';
import { registerSubscribers } from '../events/handlers.js';

export const TENANT_SLUG = process.env.TENANT_SLUG ?? 'kaizen';
const TENANT_NAME = process.env.TENANT_NAME ?? 'Kaizen Infinities';

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

      // Keyed on resource AND scope, so one resource can carry two cells —
      // `leads: V@all` beside `leads: CE@own` is "see every lead, edit your
      // own", which needs two rows to say. Keyed on resource alone, the second
      // cell was silently dropped and the matrix quietly disagreed with the
      // database.
      const existing = await prisma.grant.findFirst({
        where: { tenantId, roleId: role.id, resource: spec.resource, scope: parsed.scope },
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

  // Navigation.
  //
  // This was forty-two entries across nine groups, which is a defensible shape
  // for a platform and an obstacle for a company of twelve people: nobody could
  // find anything, and the reason nobody could find anything is that the
  // grouping followed the architecture rather than the work.
  //
  // Six groups now, named for what a person is doing rather than for which
  // bounded context owns the table. `Set up` is last and collapsed by default,
  // because it is where you go twice a year.
  const navNodes: Array<{
    nodeKey: string; label: string; icon: string; path: string; group: string;
    position: number; requiredPermission?: string; archetypes?: string[]; synonyms?: string[];
  }> = [
    // ---- Start here ------------------------------------------------------
    { nodeKey: 'business', label: 'The Business', icon: 'trending', path: '/business', group: 'main', position: 0, requiredPermission: 'transactions:V', synonyms: ['dashboard', 'how are we doing', 'profit', 'runway', 'cash', 'by division', 'p&l'] },
    { nodeKey: 'command', label: 'Needs Attention', icon: 'gauge', path: '/command', group: 'main', position: 1, requiredPermission: 'health_scores:V', synonyms: ['pulse', 'today', 'command centre', 'state of kaizen', 'problems'] },
    { nodeKey: 'workspace', label: 'My Work', icon: 'home', path: '/workspace', group: 'main', position: 2, synonyms: ['my day', 'my queue', 'home', 'workspace'] },
    { nodeKey: 'start', label: 'Getting Started', icon: 'book', path: '/start', group: 'main', position: 3, synonyms: ['setup', 'help', 'tutorial', 'how do i', 'guide', 'onboarding'] },

    // ---- Money -----------------------------------------------------------
    { nodeKey: 'fin_ledger', label: 'Ledger', icon: 'coins', path: '/finance/ledger', group: 'money', position: 10, requiredPermission: 'transactions:V', synonyms: ['transactions', 'cash book', 'spend', 'expenses', 'bank'] },
    { nodeKey: 'fin_invoices', label: 'Invoices', icon: 'receipt', path: '/finance/invoices', group: 'money', position: 11, requiredPermission: 'invoices:V', synonyms: ['bill a customer', 'raise an invoice', 'sales invoice'] },
    { nodeKey: 'fin_payments', label: 'Payments In', icon: 'wallet', path: '/finance/payments', group: 'money', position: 12, requiredPermission: 'payments:V', synonyms: ['receipts', 'money received', 'collections'] },
    { nodeKey: 'fin_payables', label: 'Bills To Pay', icon: 'receipt', path: '/finance/payables', group: 'money', position: 13, requiredPermission: 'vendor_bills:V', synonyms: ['payables', 'supplier bills', 'vendors', 'creditors', 'what we owe'] },
    { nodeKey: 'fin_receivables', label: 'Owed To Us', icon: 'coins', path: '/finance/receivables', group: 'money', position: 14, requiredPermission: 'receivables:V', synonyms: ['receivables', 'debtors', 'outstanding'] },
    { nodeKey: 'fin_budget', label: 'Budget', icon: 'calculator', path: '/finance/budget', group: 'money', position: 15, requiredPermission: 'budgets:V', synonyms: ['plan', 'variance', 'overspend'] },
    { nodeKey: 'fin_assets', label: 'Assets & Loans', icon: 'package', path: '/finance/assets', group: 'money', position: 16, requiredPermission: 'assets:V', synonyms: ['depreciation', 'borrowing', 'emi', 'fixed assets'] },

    // ---- People ----------------------------------------------------------
    { nodeKey: 'hr_people', label: 'Employees', icon: 'users', path: '/people/employees', group: 'people', position: 20, requiredPermission: 'employees:V', synonyms: ['staff', 'team', 'headcount', 'who works here', 'directory'] },
    { nodeKey: 'hr_leave', label: 'Leave', icon: 'clock', path: '/people/leave', group: 'people', position: 21, requiredPermission: 'leave:V', synonyms: ['holiday', 'time off', 'absence', 'casual leave'] },
    { nodeKey: 'hr_attendance', label: 'Attendance', icon: 'clipboard', path: '/people/attendance', group: 'people', position: 22, requiredPermission: 'attendance:V', synonyms: ['timesheet', 'punch', 'hours', 'present'] },
    { nodeKey: 'hr_payroll', label: 'Payroll', icon: 'wallet', path: '/people/payroll', group: 'people', position: 23, requiredPermission: 'payroll:V', synonyms: ['salary', 'pay run', 'wages', 'payslip'] },
    { nodeKey: 'hr_hiring', label: 'Hiring', icon: 'inbox', path: '/people/hiring', group: 'people', position: 24, requiredPermission: 'requisitions:V', synonyms: ['recruitment', 'vacancies', 'candidates', 'applications'] },
    { nodeKey: 'hr_capabilities', label: 'Skills', icon: 'badge', path: '/people/skills', group: 'people', position: 25, requiredPermission: 'capabilities:V', synonyms: ['capability', 'who can do', 'expertise'] },

    // ---- Customers -------------------------------------------------------
    { nodeKey: 'crm_leads', label: 'Leads', icon: 'inbox', path: '/crm/leads', group: 'customers', position: 30, requiredPermission: 'leads:V', synonyms: ['enquiries', 'prospects'] },
    { nodeKey: 'crm_pipeline', label: 'Pipeline', icon: 'columns', path: '/crm/pipeline', group: 'customers', position: 31, requiredPermission: 'opportunities:V', synonyms: ['kanban', 'board', 'deals'] },
    { nodeKey: 'crm_opportunities', label: 'Deals', icon: 'target', path: '/crm/opportunities', group: 'customers', position: 32, requiredPermission: 'opportunities:V', synonyms: ['opportunities'] },
    { nodeKey: 'crm_accounts', label: 'Companies & Colleges', icon: 'building', path: '/crm/accounts', group: 'customers', position: 33, requiredPermission: 'organizations:V', synonyms: ['accounts', 'organizations', 'companies', 'colleges', 'institutions', 'clients', 'customers'] },
    { nodeKey: 'crm_people', label: 'Contacts', icon: 'users', path: '/crm/people', group: 'customers', position: 34, requiredPermission: 'people:V', synonyms: ['persons', 'people'] },
    { nodeKey: 'crm_interactions', label: 'Calls & Meetings', icon: 'message', path: '/crm/interactions', group: 'customers', position: 35, requiredPermission: 'interactions:V', synonyms: ['activity', 'timeline', 'calls'] },
    { nodeKey: 'crm_forecast', label: 'Forecast', icon: 'trending', path: '/crm/forecast', group: 'customers', position: 36, requiredPermission: 'opportunities:V', synonyms: ['commit', 'coverage'] },

    // ---- Selling and delivering -------------------------------------------
    { nodeKey: 'com_offerings', label: 'What We Sell', icon: 'package', path: '/commercial/offerings', group: 'delivery', position: 40, requiredPermission: 'offerings:V', synonyms: ['products', 'price book', 'catalog', 'services'] },
    { nodeKey: 'com_quotes', label: 'Quotes', icon: 'calculator', path: '/commercial/quotes', group: 'delivery', position: 41, requiredPermission: 'quotes:V', synonyms: ['pricing', 'discount'] },
    { nodeKey: 'com_proposals', label: 'Proposals', icon: 'file', path: '/commercial/proposals', group: 'delivery', position: 42, requiredPermission: 'proposals:V' },
    { nodeKey: 'com_agreements', label: 'Agreements', icon: 'scroll', path: '/commercial/agreements', group: 'delivery', position: 43, requiredPermission: 'mous:V', synonyms: ['mou', 'contracts', 'partner agreements'] },
    { nodeKey: 'com_approvals', label: 'Approvals', icon: 'shield', path: '/commercial/approvals', group: 'delivery', position: 44, requiredPermission: 'mous:V', synonyms: ['sign off', 'waiting on me'] },
    { nodeKey: 'prj_projects', label: 'Projects', icon: 'kanban', path: '/delivery/projects', group: 'delivery', position: 45, requiredPermission: 'projects:V', synonyms: ['delivery', 'engagements'] },
    { nodeKey: 'edu_cohorts', label: 'Training Batches', icon: 'graduation', path: '/education/cohorts', group: 'delivery', position: 46, requiredPermission: 'education:V', synonyms: ['batches', 'classes'] },
    { nodeKey: 'edu_enrollments', label: 'Students', icon: 'badge', path: '/education/enrollments', group: 'delivery', position: 47, requiredPermission: 'education:V', synonyms: ['students', 'learners', 'admissions', 'enrolments', 'enrollments'] },
    { nodeKey: 'com_winloss', label: 'Win / Loss', icon: 'clipboard', path: '/commercial/win-loss', group: 'delivery', position: 48, requiredPermission: 'win_loss_reviews:V', synonyms: ['post mortem', 'lessons'] },

    // ---- Set up ----------------------------------------------------------
    { nodeKey: 'data_import', label: 'Import Data', icon: 'inbox', path: '/data/import', group: 'setup', position: 50, requiredPermission: 'imports:V', synonyms: ['tally', 'bank statement', 'excel', 'csv', 'upload', 'migrate', 'bring data in'] },
    { nodeKey: 'gov_decisions', label: 'Decisions', icon: 'scale', path: '/command/decisions', group: 'setup', position: 51, requiredPermission: 'decisions:V' },
    { nodeKey: 'gov_exceptions', label: 'Problems', icon: 'alert', path: '/exceptions', group: 'setup', position: 52, requiredPermission: 'exceptions:V', synonyms: ['issues', 'attention', 'exceptions'] },
    { nodeKey: 'adm_governance', label: 'Who Can Do What', icon: 'shield', path: '/admin/governance', group: 'setup', position: 53, requiredPermission: 'grants:V', synonyms: ['permissions', 'roles', 'grants', 'access'] },
    { nodeKey: 'adm_pipelines', label: 'Pipeline Setup', icon: 'settings', path: '/admin/pipelines', group: 'setup', position: 54, requiredPermission: 'pipeline_definitions:V' },
    { nodeKey: 'adm_territories', label: 'Territories', icon: 'map', path: '/admin/territories', group: 'setup', position: 55, requiredPermission: 'territories:V' },
    { nodeKey: 'adm_agents', label: 'AI Agents', icon: 'sparkle', path: '/admin/agents', group: 'setup', position: 56, requiredPermission: 'agents:V' },
    { nodeKey: 'adm_jobs', label: 'Automatic Checks', icon: 'clock', path: '/admin/jobs', group: 'setup', position: 57, requiredPermission: 'jobs:V' },
    { nodeKey: 'adm_events', label: 'System History', icon: 'list', path: '/admin/events', group: 'setup', position: 58, requiredPermission: 'events:V' },
    { nodeKey: 'adm_audit', label: 'Audit Trail', icon: 'lock', path: '/admin/audit', group: 'setup', position: 59, requiredPermission: 'audit:V' },
    { nodeKey: 'adm_platform', label: 'How This Is Built', icon: 'book', path: '/admin/platform', group: 'setup', position: 60 },
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

async function currentTenant() {
  const t = await unscopedPrisma.tenant.findFirstOrThrow({ where: { slug: TENANT_SLUG } });
  return t;
}
// ---------------------------------------------------------------------------
// Statutory leave types
// ---------------------------------------------------------------------------

/**
 * The five leave types Indian employment ordinarily runs on. These are
 * structure rather than data: a tenant with no leave types cannot accept a
 * leave request at all, and a company that wants different ones edits these
 * rather than inventing the concept.
 */
async function seedLeaveTypes() {
  const tenantId = (await currentTenant()).id;
  const specs = [
    { code: 'CL', name: 'Casual Leave', annualEntitlementDays: 12, statutory: false, employmentStateAffecting: false },
    { code: 'SL', name: 'Sick Leave', annualEntitlementDays: 12, statutory: true, employmentStateAffecting: false },
    { code: 'EL', name: 'Earned Leave', annualEntitlementDays: 15, statutory: true, employmentStateAffecting: false },
    // Long leave takes somebody off the roll while it runs, so the employment
    // relationship moves with it.
    { code: 'ML', name: 'Maternity Leave', annualEntitlementDays: 182, statutory: true, employmentStateAffecting: true },
    { code: 'LOP', name: 'Loss of Pay', annualEntitlementDays: 0, statutory: false, employmentStateAffecting: false },
  ];
  let created = 0;
  for (const spec of specs) {
    const existing = await prisma.leaveType.findFirst({ where: { tenantId, code: spec.code } });
    if (existing) continue;
    await prisma.leaveType.create({ data: { tenantId, ...spec } });
    created += 1;
  }
  console.log(`  ${created} leave types (${specs.length} declared)`);
}

// ---------------------------------------------------------------------------
// The first account
// ---------------------------------------------------------------------------

/**
 * One account, holding the chairman role, from which every other account is
 * created inside the product.
 *
 * The password comes from the environment or is generated and printed once. It
 * is never a constant in this file: a known default password in a seed script
 * is a known default password in production, and "it is only the demo one" has
 * never once been true by the time it mattered.
 */
async function seedOwner(): Promise<{ email: string; password: string | null }> {
  const tenantId = (await currentTenant()).id;
  const email = (process.env.OWNER_EMAIL ?? 'chairman@kaizen.co.in').toLowerCase();
  const fullName = process.env.OWNER_NAME ?? 'Chairman';

  const existingUser = await prisma.user.findFirst({ where: { tenantId, email } });

  let person = await prisma.person.findFirst({ where: { tenantId, primaryEmail: email } });
  if (!person) {
    person = await prisma.person.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('PER'),
        fullName,
        primaryEmail: email,
        primaryEmailNormalised: email,
        source: 'bootstrap',
      },
    });
  }

  // Checked and repaired rather than created once beside the user, because the
  // two can come apart: a run that fails between the two writes leaves an
  // account that can authenticate and then resolves to no affiliation, which
  // presents as a login that succeeds and a session with no authority at all.
  const affiliation = await prisma.affiliation.findFirst({
    where: { tenantId, partyId: person.id, roleSlug: 'chairman' },
  });
  if (!affiliation) {
    await prisma.affiliation.create({
      data: {
        tenantId,
        partyId: person.id,
        affiliationType: 'employee',
        counterpartyName: TENANT_NAME,
        roleSlug: 'chairman',
        primaryFlag: true,
        status: 'active',
        // An employee affiliation carries a statutory retention floor: a dedup
        // match against it never auto-merges.
        statutoryRetentionFloor: true,
      },
    });
  }

  if (existingUser) {
    console.log(`  owner ${email} already exists — password left untouched`);
    return { email, password: null };
  }

  const password = process.env.OWNER_PASSWORD ?? randomUUID().replace(/-/g, '').slice(0, 16);
  await prisma.user.create({
    data: { tenantId, personId: person.id, email, passwordHash: await hashPassword(password) },
  });

  console.log(`  owner ${email} created`);
  return { email, password: process.env.OWNER_PASSWORD ? null : password };
}

// ---------------------------------------------------------------------------

export async function seedBootstrap(): Promise<{ tenantId: string; owner: { email: string; password: string | null } }> {
  const tenant = await unscopedPrisma.tenant.upsert({
    where: { slug: TENANT_SLUG },
    create: {
      slug: TENANT_SLUG,
      name: TENANT_NAME,
      status: 'active',
      config: {
        // The explicit bootstrap authority set, owned by SYS: who may create
        // the first POLICY or GRANT for a new tenant. This breaks the
        // circularity of the permission system needing permission to create
        // itself.
        bootstrapAuthoritySet: ['chairman'],
        forecastPeriod: 'quarter',
        baseCurrency: 'INR',
        // Flipped by the onboarding checklist once the company has been set up.
        // Until then the product leads with setup rather than with empty
        // dashboards.
        onboardingComplete: false,
      },
    },
    update: {},
  });

  registerSubscribers();

  let owner: { email: string; password: string | null } = { email: '', password: null };
  await asSystem(tenant.id, async () => {
    await seedThresholds();
    await seedSensitivityRegistrations();
    const { policyVersionId } = await seedGovernance();
    await seedGrants(policyVersionId);
    await seedPipelines();
    await seedSurfaces();
    await seedAgents();
    await seedLeaveTypes();
    owner = await seedOwner();
  });

  return { tenantId: tenant.id, owner };
}
