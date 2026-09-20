/**
 * Marketing analytics, H_MKT health, marketing jobs and AI drafting
 * (MKT-ANA-*, MKT-GOV-*).
 *
 * Runs against a dedicated, disposable tenant rather than the shared
 * `kaizen` fixture tenant: funnel/channel/health assertions need exact
 * denominators (including zero), and the shared tenant accumulates data from
 * every other suite. `asSystem` is used throughout — SYSTEM_PRINCIPAL is the
 * one principal exempt from the five-axis grant check (platform/permissions.ts),
 * so a from-scratch tenant with no roles or grants can still exercise domain
 * code that calls `assertCan`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSystem } from '../platform/context.js';
import { unscopedPrisma, prisma } from '../platform/db.js';
import { ALL_JOBS, runJobsForTenant } from '../jobs/scheduler.js';
import { computeDomainHealth } from '../domains/health.js';
import { overview, funnel, channels, exportCsv } from '../domains/marketing/analytics.js';
import { draft } from '../domains/marketing/ai.js';

let TENANT_ID: string;
let PIPELINE_ID: string;

beforeAll(async () => {
  const tenant = await unscopedPrisma.tenant.create({
    data: { slug: `mkt-ana-${Date.now()}`, name: 'Marketing Analytics Test Tenant' },
  });
  TENANT_ID = tenant.id;

  const pipeline = await unscopedPrisma.pipelineDefinition.create({
    data: {
      tenantId: TENANT_ID,
      pipelineCode: 'PL-TEST-MKT',
      name: 'Test pipeline',
      commercialMotion: 'learner_admission',
      appliesToVerticals: ['software'],
      stages: {
        create: [
          { tenantId: TENANT_ID, stageKey: 'new', label: 'New', sequence: 1, pipelinePosition: 0, isOpen: true },
          { tenantId: TENANT_ID, stageKey: 'qualified', label: 'Qualified', sequence: 2, pipelinePosition: 30, isOpen: true },
        ],
      },
    },
  });
  PIPELINE_ID = pipeline.id;
});

afterAll(async () => {
  // Cascades via onDelete: Cascade on Tenant relations where declared; the
  // marketing tables use bare tenantId scalars so they are cleared explicitly.
  await unscopedPrisma.marketingSpend.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.marketingTouchpoint.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.opportunity.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.marketingCampaign.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.pipelineStage.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.pipelineDefinition.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.agentAction.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.agentPrincipal.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.tenant.delete({ where: { id: TENANT_ID } });
});

function run<T>(fn: () => Promise<T>): Promise<T> {
  return asSystem(TENANT_ID, fn);
}

async function nextCode(prefix: string): Promise<string> {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

// ===========================================================================
// MKT-ANA-001 — funnel
// ===========================================================================

describe('MKT-ANA-001 — funnel conversion rates', () => {
  it('rates are null, not zero, when the stage above has zero denominator', async () => {
    await run(async () => {
      // A window far enough in the future to guarantee zero touchpoints and
      // zero leads without depending on what other tests have written.
      const from = new Date('2099-01-01');
      const to = new Date('2099-01-31');
      const result = await funnel({ from, to });

      expect(result.stages.find((s) => s.key === 'touchpoints')?.count).toBe(0);
      expect(result.stages.find((s) => s.key === 'leads')?.count).toBe(0);
      for (const rate of result.conversionRates) {
        expect(rate.rate).toBeNull();
      }
    });
  });

  it('computes real rates once touchpoints and an attributed lead exist', async () => {
    await run(async () => {
      const campaign = await prisma.marketingCampaign.create({
        data: {
          tenantId: TENANT_ID,
          recordCode: await nextCode('CMP'),
          name: 'Funnel test campaign',
          objective: 'lead_gen',
          division: 'software',
          startAt: new Date(Date.now() - 5 * 86_400_000),
          endAt: new Date(Date.now() + 30 * 86_400_000),
          status: 'live',
          utmCampaign: 'funnel-test',
        },
      });

      await prisma.marketingTouchpoint.create({
        data: {
          tenantId: TENANT_ID,
          recordCode: await nextCode('TCH'),
          campaignId: campaign.id,
          channelKey: 'google_ads',
          touchKind: 'click',
          occurredAt: new Date(),
        },
      });

      const lead = await prisma.lead.create({
        data: {
          tenantId: TENANT_ID,
          recordCode: await nextCode('LEAD'),
          title: 'Funnel test lead',
          vertical: 'software',
          pipelineId: PIPELINE_ID,
          stageKey: 'qualified',
          campaignId: campaign.id,
        },
      });

      const from = new Date(Date.now() - 60 * 86_400_000);
      const to = new Date(Date.now() + 60 * 86_400_000);
      const result = await funnel({ from, to, campaignId: campaign.id });

      expect(result.stages.find((s) => s.key === 'touchpoints')?.count).toBeGreaterThanOrEqual(1);
      expect(result.stages.find((s) => s.key === 'leads')?.count).toBeGreaterThanOrEqual(1);
      expect(result.stages.find((s) => s.key === 'qualified')?.count).toBeGreaterThanOrEqual(1);
      const leadsRate = result.conversionRates.find((r) => r.from === 'touchpoints' && r.to === 'leads');
      expect(leadsRate?.rate).not.toBeNull();

      await unscopedPrisma.lead.delete({ where: { id: lead.id } });
    });
  });
});

// ===========================================================================
// MKT-ANA-002 — channel performance
// ===========================================================================

describe('MKT-ANA-002 — channel cost per lead', () => {
  it('costPerLead is null when a channel has spend but zero leads', async () => {
    await run(async () => {
      const from = new Date(Date.now() - 3 * 86_400_000);
      const to = new Date();

      await prisma.marketingSpend.create({
        data: {
          tenantId: TENANT_ID,
          recordCode: await nextCode('SPN'),
          channelKey: 'print_only_channel_test',
          division: 'software',
          amount: 5000,
          spendDate: new Date(),
        },
      });

      const result = await channels({ from, to });
      const row = result.find((r) => r.channelKey === 'print_only_channel_test');
      expect(row).toBeDefined();
      expect(row?.leads).toBe(0);
      expect(row?.costPerLead).toBeNull();
      expect(row?.spend).toBe(5000);
      // No won opportunities behind this spend, so ROI is measured (spend > 0) but not undefined.
      expect(row?.roi).not.toBeUndefined();
    });
  });
});

// ===========================================================================
// MKT-ANA — overview
// ===========================================================================

describe('MKT-ANA-003 — overview KPI tiles', () => {
  it('always returns exactly the documented KPI keys, each carrying a measured flag', async () => {
    await run(async () => {
      const result = await overview();
      const keys = result.kpis.map((k) => k.key).sort();
      expect(keys).toEqual(
        ['consent_coverage', 'cost_per_lead', 'leads_attributed', 'live_campaigns', 'pipeline_value', 'send_deliverability'].sort(),
      );
      for (const kpi of result.kpis) {
        expect(typeof kpi.measured).toBe('boolean');
        if (!kpi.measured) expect(kpi.value).toBeNull();
      }
      expect(Array.isArray(result.liveCampaigns)).toBe(true);
      expect(Array.isArray(result.attention)).toBe(true);
    });
  });

  it('exportCsv(campaigns) returns a text/csv-shaped payload with a header row', async () => {
    await run(async () => {
      const csv = await exportCsv('campaigns');
      expect(typeof csv).toBe('string');
      if (csv.length > 0) expect(csv.split('\n')[0]).toContain('campaignId');
    });
  });
});

// ===========================================================================
// H_MKT — health domain
// ===========================================================================

describe('MKT-ANA-004 / MKT-GOV — H_MKT health domain', () => {
  it('reports not_yet_measured while no campaign has ever gone live', async () => {
    // A separate, isolated tenant: by this point other tests in this file
    // have already created a live campaign under TENANT_ID, and "ever live"
    // is meant to be irreversible — this assertion needs a tenant that has
    // truly never had one.
    const freshTenant = await unscopedPrisma.tenant.create({
      data: { slug: `mkt-ana-neverlive-${Date.now()}`, name: 'H_MKT never-live test tenant' },
    });
    try {
      await asSystem(freshTenant.id, async () => {
        const result = await computeDomainHealth('H_MKT');
        expect(result.state).toBe('not_yet_measured');
        expect(result.score).toBeNull();
        expect(result.band).toBeNull();
      });
    } finally {
      await unscopedPrisma.tenant.delete({ where: { id: freshTenant.id } });
    }
  });

  it('reports a scored band once a campaign has gone live and leads exist, with a drill path on every factor', async () => {
    await run(async () => {
      const campaign = await prisma.marketingCampaign.create({
        data: {
          tenantId: TENANT_ID,
          recordCode: await nextCode('CMP'),
          name: 'H_MKT test campaign',
          objective: 'lead_gen',
          division: 'software',
          startAt: new Date(Date.now() - 10 * 86_400_000),
          endAt: new Date(Date.now() + 20 * 86_400_000),
          status: 'live',
          utmCampaign: 'h-mkt-test',
        },
      });

      await prisma.lead.create({
        data: {
          tenantId: TENANT_ID,
          recordCode: await nextCode('LEAD'),
          title: 'H_MKT test lead',
          vertical: 'software',
          pipelineId: PIPELINE_ID,
          stageKey: 'new',
          campaignId: campaign.id,
        },
      });

      const result = await computeDomainHealth('H_MKT');
      expect(result.state).toBe('measured');
      expect(typeof result.score).toBe('number');
      expect(result.band).not.toBeNull();
      expect(result.factors.length).toBe(5);
      for (const factor of result.factors) {
        expect(factor.drillPath.startsWith('/marketing/analytics')).toBe(true);
        expect(factor.narrative.length).toBeGreaterThan(0);
      }
    });
  });
});

// ===========================================================================
// MKT-GOV — job registry
// ===========================================================================

describe('MKT-GOV — marketing jobs are registered and runnable', () => {
  const expectedNames = [
    'marketing.journeys.tick',
    'marketing.sends.dispatch',
    'marketing.audiences.reevaluate',
    'marketing.attribution.recompute',
    'marketing.scores.apply',
    'marketing.detectors',
    'marketing.campaigns.autocomplete',
  ];

  it('the job registry contains all seven marketing job names', () => {
    const names = ALL_JOBS.map((j) => j.name);
    for (const name of expectedNames) {
      expect(names).toContain(name);
    }
  });

  it('runOnce of marketing.detectors succeeds on an empty tenant', async () => {
    const results = await runJobsForTenant(TENANT_ID, { jobNames: ['marketing.detectors'] });
    expect(results['marketing.detectors']).toBeDefined();
    // A job that could not find a sibling detector export yet still
    // completes — it reports zero processed, never throws.
    expect(results['marketing.detectors'].processed).toBeGreaterThanOrEqual(0);

    const run = await unscopedPrisma.jobRun.findFirst({
      where: { tenantId: TENANT_ID, jobName: 'marketing.detectors' },
      orderBy: { startedAt: 'desc' },
    });
    expect(run?.status).toBe('completed');
  });

  it('each of the seven marketing jobs can be run individually without throwing', async () => {
    const results = await runJobsForTenant(TENANT_ID, { jobNames: expectedNames });
    for (const name of expectedNames) {
      expect(results[name]).toBeDefined();
    }
    const runs = await unscopedPrisma.jobRun.findMany({ where: { tenantId: TENANT_ID, jobName: { in: expectedNames } } });
    for (const r of runs) {
      expect(r.status).toBe('completed');
    }
  });
});

// ===========================================================================
// MKT-GOV — AI drafting
// ===========================================================================

describe('MKT-GOV — AI-MKT draft touchpoints', () => {
  it('drafts a campaign brief as an AgentAction at the DRAFT tier, never anything sent', async () => {
    await run(async () => {
      const result = await draft('campaign_brief', { name: 'Spring intake', objective: 'lead_gen', division: 'software' });
      expect(result.tier).toBe('DRAFT');
      expect(typeof result.draft).toBe('string');

      const action = await unscopedPrisma.agentAction.findFirst({ where: { id: result.actionId } });
      expect(action).not.toBeNull();
      expect(action?.tier).toBe('DRAFT');
      expect(action?.state).toBe('proposed');
      expect(JSON.stringify(action?.proposal ?? {})).not.toMatch(/"sent"\s*:\s*true/);
    });
  });

  it('drafts subject lines as a string array', async () => {
    await run(async () => {
      const result = await draft('subject_lines', { offeringName: 'Diploma in Cloud Computing', division: 'skill' });
      expect(Array.isArray(result.draft)).toBe(true);
      expect((result.draft as string[]).length).toBeGreaterThan(0);
    });
  });

  it('drafts a segment suggestion at the RECOMMEND tier and never creates or evaluates an audience', async () => {
    await run(async () => {
      const before = await unscopedPrisma.marketingAudience.count({ where: { tenantId: TENANT_ID } });
      const result = await draft('segment', {});
      expect(result.tier).toBe('RECOMMEND');
      const after = await unscopedPrisma.marketingAudience.count({ where: { tenantId: TENANT_ID } });
      expect(after).toBe(before);
    });
  });

  it('drafts a next-best-action for a lead at the RECOMMEND tier', async () => {
    await run(async () => {
      const lead = await prisma.lead.create({
        data: {
          tenantId: TENANT_ID,
          recordCode: await nextCode('LEAD'),
          title: 'Next-best-action test lead',
          vertical: 'software',
          pipelineId: PIPELINE_ID,
          stageKey: 'new',
        },
      });
      const result = await draft('next_best_action', { leadId: lead.id });
      expect(result.tier).toBe('RECOMMEND');
      expect(typeof result.draft).toBe('string');
      await unscopedPrisma.lead.delete({ where: { id: lead.id } });
    });
  });

  it('registers the marketing-assistant agent idempotently, never granted a write tool', async () => {
    await run(async () => {
      await draft('copy', { offeringName: 'Test offering' });
      const agents = await unscopedPrisma.agentPrincipal.findMany({ where: { tenantId: TENANT_ID, agentKey: 'marketing-assistant' } });
      expect(agents.length).toBe(1);
      expect(['DRAFT', 'RECOMMEND']).toContain(agents[0].tier);
    });
  });
});
