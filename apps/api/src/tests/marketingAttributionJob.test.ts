/**
 * The scheduled attribution recompute (marketing.attribution.recompute) against
 * real Postgres.
 *
 * Before the fix the job called `computeAttribution(leadId, model)` — a
 * signature that does not exist — and `callDetector` swallowed the Prisma
 * rejection, so the run reported `completed` with zero rows written. These
 * tests pin the three things that had to be true instead: rows are produced,
 * a rerun reproduces them exactly, and a concurrent overlap cannot duplicate
 * them. The last test pins that a real write failure marks the JobRun failed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSystem } from '../platform/context.js';
import { unscopedPrisma } from '../platform/db.js';
import { runJobsForTenant } from '../jobs/scheduler.js';
import { computeAttribution } from '../domains/marketing/attribution.js';
import { ATTRIBUTION_MODELS } from '@kaizen/shared';

const JOB = 'marketing.attribution.recompute';
const DAY_MS = 86_400_000;

let TENANT_ID: string;
let LEAD_ID: string;

beforeAll(async () => {
  const tenant = await unscopedPrisma.tenant.create({
    data: { slug: `mkt-attr-job-${Date.now()}`, name: 'Attribution Job Test Tenant' },
  });
  TENANT_ID = tenant.id;

  const pipeline = await unscopedPrisma.pipelineDefinition.create({
    data: {
      tenantId: TENANT_ID,
      pipelineCode: 'PL-ATTR-JOB',
      name: 'Attribution job pipeline',
      commercialMotion: 'learner_admission',
      appliesToVerticals: ['software'],
      stages: {
        create: [
          { tenantId: TENANT_ID, stageKey: 'new', label: 'New', sequence: 1, pipelinePosition: 0, isOpen: true },
        ],
      },
    },
  });

  const person = await unscopedPrisma.person.create({
    data: { tenantId: TENANT_ID, recordCode: 'PER-ATTR-JOB-1', fullName: 'Attribution Test Person' },
  });

  const campaign = await unscopedPrisma.marketingCampaign.create({
    data: {
      tenantId: TENANT_ID,
      recordCode: 'CMP-ATTR-JOB-1',
      name: 'Attribution job campaign',
      objective: 'lead_gen',
      division: 'software',
      startAt: new Date(Date.now() - 30 * DAY_MS),
      endAt: new Date(Date.now() + 30 * DAY_MS),
      status: 'live',
      utmCampaign: 'attr-job',
    },
  });

  // Two touches before the lead, so every model has more than one row to weight.
  await unscopedPrisma.marketingTouchpoint.create({
    data: {
      tenantId: TENANT_ID,
      recordCode: 'TCH-ATTR-JOB-1',
      personId: person.id,
      campaignId: campaign.id,
      channelKey: 'google_ads',
      touchKind: 'click',
      occurredAt: new Date(Date.now() - 3 * DAY_MS),
    },
  });
  await unscopedPrisma.marketingTouchpoint.create({
    data: {
      tenantId: TENANT_ID,
      recordCode: 'TCH-ATTR-JOB-2',
      personId: person.id,
      campaignId: campaign.id,
      channelKey: 'email',
      touchKind: 'open',
      occurredAt: new Date(Date.now() - 1 * DAY_MS),
    },
  });

  const lead = await unscopedPrisma.lead.create({
    data: {
      tenantId: TENANT_ID,
      recordCode: 'LEAD-ATTR-JOB-1',
      title: 'Attribution job lead',
      vertical: 'software',
      pipelineId: pipeline.id,
      stageKey: 'new',
      personId: person.id,
      campaignId: campaign.id,
      channelKey: 'google_ads',
    },
  });
  LEAD_ID = lead.id;
});

afterAll(async () => {
  await unscopedPrisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS mkt_attr_job_fail ON mkt_attributions');
  await unscopedPrisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS mkt_attr_job_fail_fn()');
  await unscopedPrisma.marketingAttribution.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.jobRun.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.automationDefinition.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.marketingTouchpoint.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.marketingCampaign.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.person.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.pipelineStage.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.pipelineDefinition.deleteMany({ where: { tenantId: TENANT_ID } });
  await unscopedPrisma.tenant.delete({ where: { id: TENANT_ID } });
});

/** Rows for the seeded lead, reduced to the fields that define an attribution result. */
async function leadRows(): Promise<string[]> {
  const rows = await unscopedPrisma.marketingAttribution.findMany({
    where: { tenantId: TENANT_ID, leadId: LEAD_ID, deletedAt: null },
    select: { model: true, channelKey: true, campaignId: true, weight: true },
  });
  return rows.map((r) => `${r.model}|${r.channelKey}|${r.campaignId ?? ''}|${r.weight.toString()}`).sort();
}

describe('marketing.attribution.recompute', () => {
  it('writes attribution rows for every model for a lead with touchpoints', async () => {
    const results = await runJobsForTenant(TENANT_ID, { jobNames: [JOB] });

    expect(results[JOB].errors).toEqual([]);
    expect(results[JOB].processed).toBeGreaterThan(0);

    const rows = await leadRows();
    for (const model of ATTRIBUTION_MODELS) {
      expect(rows.some((r) => r.startsWith(`${model}|`))).toBe(true);
    }
    // Two touchpoints plus the lead's own campaign touch are three touches,
    // so first_touch carries exactly one row for the lead.
    expect(rows.filter((r) => r.startsWith('first_touch|'))).toHaveLength(1);
  });

  it('a rerun reproduces identical rows and counts', async () => {
    const before = await leadRows();
    const results = await runJobsForTenant(TENANT_ID, { jobNames: [JOB] });
    expect(results[JOB].errors).toEqual([]);
    const after = await leadRows();

    expect(after).toEqual(before);
    expect(after.length).toBe(before.length);
  });

  it('two overlapping computeAttribution calls leave no duplicate rows', async () => {
    const from = new Date(Date.now() - 90 * DAY_MS);
    const to = new Date();

    await asSystem(TENANT_ID, () => computeAttribution(from, to));
    const single = await leadRows();

    await Promise.all([
      asSystem(TENANT_ID, () => computeAttribution(from, to)),
      asSystem(TENANT_ID, () => computeAttribution(from, to)),
    ]);
    const overlapped = await leadRows();

    expect(overlapped).toEqual(single);
    expect(overlapped.length).toBe(single.length);
  });

  it('a real write failure marks the JobRun failed rather than completed', async () => {
    await unscopedPrisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION mkt_attr_job_fail_fn() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'attribution write refused by test trigger';
      END;
      $$ LANGUAGE plpgsql
    `);
    await unscopedPrisma.$executeRawUnsafe(
      'CREATE TRIGGER mkt_attr_job_fail BEFORE INSERT ON mkt_attributions FOR EACH ROW EXECUTE FUNCTION mkt_attr_job_fail_fn()',
    );
    try {
      await runJobsForTenant(TENANT_ID, { jobNames: [JOB] });
    } finally {
      await unscopedPrisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS mkt_attr_job_fail ON mkt_attributions');
      await unscopedPrisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS mkt_attr_job_fail_fn()');
    }

    const run = await unscopedPrisma.jobRun.findFirst({
      where: { tenantId: TENANT_ID, jobName: JOB },
      orderBy: { startedAt: 'desc' },
    });
    expect(run?.status).toBe('failed');
    expect(run?.errors.join(' ')).toContain('attribution write refused by test trigger');
  });
});
