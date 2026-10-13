/**
 * Characterisation of the marketing and pipeline money columns as they reach
 * the wire today (ORDERED-PLAN 1.6, MONEY-S6, subset: the 13 columns that
 * demoDataset.ts does not write).
 *
 * Pins the TYPE and VALUE of each money field on the paths that read or write
 * MarketingBudget.planned and committed, MarketingSpend.amount,
 * MarketingCampaign.budgetPlanned, budgetCommitted, budgetActual and
 * targetPipelineValue, MarketingCampaignApproval.thresholdAmount,
 * MarketingEvent.costPlanned and costActual, MarketingReferralProgram.rewardAmount,
 * MarketingTouchpoint.cost, and PipelineDefinition.commitApprovalThreshold.
 *
 * Amounts are binary-exact (x.25, x.5, x.75) so the float sums on the old path
 * and the paise sums on the new one agree figure for figure. Where a boundary
 * is decided by comparison (campaign approval threshold, over-budget detector,
 * the commit approval threshold), the test pins equal, one paisa over and one
 * paisa under.
 *
 * These assertions must pass on the Decimal and Number columns and, unchanged,
 * on the BigInt `*Minor` columns. The `*Minor` siblings are asserted in
 * moneyColumns.minor.test.ts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { bigintReplacer } from '../../platform/wire.js';
import { asPrincipal, asUser, authFor, expectReject, tenantId, unscopedPrisma, withFixtureRole } from '../helpers.js';
import {
  createBudget,
  updateBudget,
  approveBudget,
  recordSpend,
  budgetVariance,
  detectOverBudget,
  detectSpendWithoutBudget,
  periodFor,
} from '../../domains/marketing/budget.js';
import {
  createCampaign,
  updateCampaign,
  getCampaign,
  listCampaigns,
  submitCampaign,
  getMarketingPolicy,
  type CampaignCreateInput,
} from '../../domains/marketing/campaigns.js';
import { createEvent, loadEvent, listEvents, updateEvent } from '../../domains/marketing/events.js';
import {
  createReferralProgram,
  listReferralPrograms,
  updateReferralProgram,
} from '../../domains/marketing/referrals.js';
import { recordTouchpoint } from '../../domains/marketing/attribution.js';
import * as analytics from '../../domains/marketing/analytics.js';
import { createPipeline, loadPipelineWithStages } from '../../domains/pipelines.js';
import { changeForecastCategory } from '../../domains/opportunities.js';

/** What `res.json` sends: Prisma Decimals become their JSON string, BigInt its digits. */
const wire = <T>(value: T): any => JSON.parse(JSON.stringify(value, bigintReplacer));

const CHAIRMAN = 'chairman@kaizen.co.in';
const FINANCE = 'finance@kaizen.co.in';

let TENANT: string;
let seq = 0;
const stamp = () => `${Date.now()}-${++seq}`;

beforeAll(async () => {
  TENANT = await tenantId();
});

function campaignInput(overrides: Partial<CampaignCreateInput> = {}): CampaignCreateInput {
  return {
    name: `S6 characterisation ${stamp()}`,
    objective: 'lead_gen',
    division: 'software',
    channelMix: ['email'],
    startAt: new Date(Date.now() - 86_400_000),
    endAt: new Date(Date.now() + 30 * 86_400_000),
    budgetPlanned: 1000,
    ...overrides,
  };
}

async function campaignWith(budgetPlanned: number) {
  return asUser(CHAIRMAN, async () => {
    const created = await createCampaign(campaignInput({ budgetPlanned }));
    return submitCampaign(created.id).then(() => created.id);
  });
}

/** Ends a pipeline this test created, so the tenant keeps the five seeded pipelines as its current set. */
async function retire(id: string) {
  await unscopedPrisma.pipelineDefinition.update({ where: { id }, data: { effectiveTo: new Date() } });
}

async function spendOn(campaignId: string, amount: number) {
  return asUser(CHAIRMAN, () =>
    recordSpend({
      campaignId,
      channelKey: 'email',
      division: 'software',
      amount,
      spendDate: new Date(),
      description: `S6 characterisation ${stamp()}`,
    }),
  );
}

describe('MONEY-S6 marketing and pipeline: wire characterisation (pre-conversion)', () => {
  let campaignId: string;
  let budgetId: string;
  const period = periodFor(new Date());

  it('budget: planned, committed, spent and remaining are JavaScript numbers on the view', async () => {
    const campaign = await asUser(CHAIRMAN, () => createCampaign(campaignInput({ budgetPlanned: 1000.25 })));
    campaignId = campaign.id;

    const view = await asUser(CHAIRMAN, () =>
      createBudget({ period, division: 'software', planned: 1000.25, campaignId }),
    );
    budgetId = view.id;
    expect(typeof view.planned).toBe('number');
    expect(view.planned).toBe(1000.25);
    expect(view.committed).toBe(0);
    expect(view.spent).toBe(0);
    expect(view.remaining).toBe(1000.25);
    expect(view.approved).toBe(false);
  });

  it('budget: an edit writes the audit diff as the Decimal string the column printed', async () => {
    const updated = await asUser(CHAIRMAN, () => updateBudget(budgetId, { planned: 1500.75 }));
    expect(updated.planned).toBe(1500.75);

    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TENANT, subjectType: 'marketing_budget', subjectId: budgetId, action: 'update' },
      orderBy: { seq: 'desc' },
    });
    expect((audit?.diff as Record<string, { from: unknown; to: unknown }>).planned).toStrictEqual({
      from: '1000.25',
      to: '1500.75',
    });
  });

  it('spend: amount is a number on the view, and the campaign actual follows it in the same transaction', async () => {
    const view = await spendOn(campaignId, 300.5);
    expect(typeof view.amount).toBe('number');
    expect(view.amount).toBe(300.5);

    const after1 = await asUser(CHAIRMAN, () => getCampaign(campaignId));
    expect(typeof after1.budgetActual).toBe('number');
    expect(after1.budgetActual).toBe(300.5);
    expect(after1.spendTotal).toBe(300.5);

    await spendOn(campaignId, 0.25);
    const after2 = await asUser(CHAIRMAN, () => getCampaign(campaignId));
    expect(after2.budgetActual).toBe(300.75);
  });

  it('variance: planned, committed, actual and variance on the row', async () => {
    const rows = await asUser(CHAIRMAN, () => budgetVariance({ period, division: 'software' }));
    const row = rows.find((r) => r.campaignId === campaignId);
    expect(row).toBeDefined();
    expect(row!.planned).toBe(1500.75);
    expect(row!.committed).toBe(0);
    expect(row!.actual).toBe(300.75);
    expect(row!.variance).toBe(1200);
    expect(row!.measured).toBe(false);
  });

  it('approval: a FINANCE approval turns measured on and approved on the budget view', async () => {
    const approved = await asUser(FINANCE, () => approveBudget(budgetId));
    expect(approved.approved).toBe(true);
    const rows = await asUser(CHAIRMAN, () => budgetVariance({ period, division: 'software' }));
    expect(rows.find((r) => r.campaignId === campaignId)!.measured).toBe(true);
  });

  it('spend without budget: the exception detail prints the spend amount', async () => {
    const division = `s6-undivided-${stamp()}`;
    const view = await asUser(CHAIRMAN, () =>
      recordSpend({
        channelKey: 'phone',
        division,
        amount: 77.5,
        spendDate: new Date(),
        description: 'S6 characterisation',
      }),
    );
    await asUser(CHAIRMAN, () => detectSpendWithoutBudget());
    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: TENANT, code: 'EX-MKT-014', subjectId: view.id },
    });
    expect(exception?.detail).toBe(`Spend of 77.5 recorded against ${period}/${division} with no approved budget.`);
  });

  it('over-budget detector: equal spend is not over, one paisa over is, one paisa under is not', async () => {
    const cases: Array<{ planned: number; spent: number; raised: 0 | 1 }> = [
      { planned: 1000, spent: 1000, raised: 0 },
      { planned: 1000, spent: 1000.01, raised: 1 },
      { planned: 1000, spent: 999.99, raised: 0 },
    ];
    for (const c of cases) {
      const before = await asUser(CHAIRMAN, () => detectOverBudget());
      const id = await campaignWith(c.planned);
      await spendOn(id, c.spent);
      const after = await asUser(CHAIRMAN, () => detectOverBudget());
      expect(after - before).toBe(c.raised);
      if (c.raised === 1) {
        const exception = await unscopedPrisma.exceptionRecord.findFirst({
          where: { tenantId: TENANT, code: 'EX-MKT-002', subjectId: id },
        });
        expect(exception?.detail).toBe(`Spend ${c.spent} exceeds planned budget ${c.planned}.`);
      }
    }
  });

  it('campaign: budget, actual and target pipeline are numbers, and a null target stays null', async () => {
    const created = await asUser(CHAIRMAN, () =>
      createCampaign(campaignInput({ budgetPlanned: 1000.25, targetPipelineValue: 250000.75 })),
    );
    expect(typeof created.budgetPlanned).toBe('number');
    expect(created.budgetPlanned).toBe(1000.25);
    expect(created.budgetCommitted).toBe(0);
    expect(created.budgetActual).toBe(0);
    expect(created.targetPipelineValue).toBe(250000.75);

    const bare = await asUser(CHAIRMAN, () => createCampaign(campaignInput({ budgetPlanned: 10 })));
    expect(bare.targetPipelineValue).toBeNull();

    const patched = await asUser(CHAIRMAN, () => updateCampaign(created.id, { targetPipelineValue: 300000.5 }));
    expect(patched.targetPipelineValue).toBe(300000.5);
    expect(typeof patched.targetPipelineValue).toBe('number');
  });

  it('campaign list: the list view carries the same numbers', async () => {
    const page = await asUser(CHAIRMAN, () => listCampaigns({ pageSize: 200 }));
    const row = page.items.find((c) => c.id === campaignId);
    expect(row).toBeDefined();
    expect(row!.budgetPlanned).toBe(1000.25);
    expect(row!.budgetActual).toBe(300.75);
    expect(row!.budgetCommitted).toBe(0);
  });

  it('campaign approval threshold: equal to the policy is scheduled; one paisa over needs approval; one paisa under is scheduled', async () => {
    const threshold = (await asUser(CHAIRMAN, () => getMarketingPolicy(TENANT))).campaignApprovalThreshold;
    expect(Number.isInteger(threshold * 100)).toBe(true);

    const equal = await asUser(CHAIRMAN, async () => {
      const id = (await createCampaign(campaignInput({ budgetPlanned: threshold }))).id;
      return submitCampaign(id);
    });
    expect(equal.status).toBe('scheduled');
    expect(equal.approvalRequired).toBe(false);

    const under = await asUser(CHAIRMAN, async () => {
      const id = (await createCampaign(campaignInput({ budgetPlanned: threshold - 0.01 }))).id;
      return submitCampaign(id);
    });
    expect(under.status).toBe('scheduled');

    const over = await asUser(CHAIRMAN, async () => {
      const id = (await createCampaign(campaignInput({ budgetPlanned: threshold + 0.01 }))).id;
      return submitCampaign(id);
    });
    expect(over.status).toBe('pending_approval');
    expect(over.approvalRequired).toBe(true);
    expect(over.approvals).toHaveLength(1);
    expect(typeof over.approvals[0]!.thresholdAmount).toBe('number');
    expect(over.approvals[0]!.thresholdAmount).toBe(threshold);
  });

  it('event: costPlanned and costActual reach the wire as Decimal strings on a raw row', async () => {
    const created = await asUser(CHAIRMAN, () =>
      createEvent({ name: `S6 event ${stamp()}`, kind: 'webinar', startAt: new Date(), costPlanned: 2500.5 }),
    );
    const w = wire(created);
    expect(w.costPlanned).toBe('2500.5');
    expect(w.costActual).toBe('0');

    const bare = wire(
      await asUser(CHAIRMAN, () => createEvent({ name: `S6 bare ${stamp()}`, kind: 'webinar', startAt: new Date() })),
    );
    expect(bare.costPlanned).toBe('0');
  });

  it('event: the view has costPlanned and costActual as numbers, and no cost per head until someone attends', async () => {
    const created = await asUser(CHAIRMAN, () =>
      createEvent({ name: `S6 view ${stamp()}`, kind: 'webinar', startAt: new Date(), costPlanned: 800.25 }),
    );
    const view = await asUser(CHAIRMAN, () => loadEvent(created.id));
    expect(typeof view.costPlanned).toBe('number');
    expect(view.costPlanned).toBe(800.25);
    expect(view.costActual).toBe(0);
    expect(view.costPerAttendee).toBeNull();
    expect(view.costPerAttendeeMeasured).toBe(false);
  });

  it('event update and list: costPlanned keeps its Decimal string on the raw row', async () => {
    const created = await asUser(CHAIRMAN, () =>
      createEvent({ name: `S6 update ${stamp()}`, kind: 'webinar', startAt: new Date(), costPlanned: 2500.5 }),
    );
    const updated = await asUser(CHAIRMAN, () => updateEvent(created.id, { costPlanned: 3000.25 }));
    expect(wire(updated).costPlanned).toBe('3000.25');

    const page = await asUser(CHAIRMAN, () => listEvents({ pageSize: 200 }));
    const listed = wire(page.items.find((e) => e.id === created.id));
    expect(listed.costPlanned).toBe('3000.25');
    expect(listed.costActual).toBe('0');
  });

  it('referral program: rewardAmount is a Decimal string on the raw row, null when absent', async () => {
    const program = await asUser(CHAIRMAN, () =>
      createReferralProgram({
        name: `S6 program ${stamp()}`,
        kind: 'referral',
        rewardKind: 'credit',
        rewardAmount: 150.75,
      }),
    );
    expect(wire(program).rewardAmount).toBe('150.75');

    const bare = await asUser(CHAIRMAN, () => createReferralProgram({ name: `S6 bare ${stamp()}`, kind: 'referral' }));
    expect(wire(bare).rewardAmount).toBeNull();

    const listed = await asUser(CHAIRMAN, () => listReferralPrograms({}));
    expect(wire(listed.find((p) => p.id === program.id)).rewardAmount).toBe('150.75');

    const updated = await asUser(CHAIRMAN, () => updateReferralProgram(program.id, { rewardAmount: 200.5 }));
    expect(wire(updated).rewardAmount).toBe('200.5');
  });

  it('touchpoint: cost is a Decimal string on the raw row, null when no cost was recorded', async () => {
    const priced = await asUser(CHAIRMAN, () =>
      recordTouchpoint({ channelKey: 'email', touchKind: 'open', cost: 42.5, campaignId }),
    );
    expect(wire(priced).cost).toBe('42.5');

    const free = await asUser(CHAIRMAN, () => recordTouchpoint({ channelKey: 'email', touchKind: 'open', campaignId }));
    expect(wire(free).cost).toBeNull();
  });

  it('channel analytics: spend is the sum of the channel rows as a number', async () => {
    const window = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) };
    const before = (await asUser(CHAIRMAN, () => analytics.channels(window))).find((r) => r.channelKey === 'other');
    const baseSpend = before?.spend ?? 0;

    await asUser(CHAIRMAN, () =>
      recordSpend({
        channelKey: 'other',
        division: 'software',
        amount: 100.25,
        spendDate: new Date(),
        description: 'a',
      }),
    );
    await asUser(CHAIRMAN, () =>
      recordSpend({ channelKey: 'other', division: 'software', amount: 0.5, spendDate: new Date(), description: 'b' }),
    );
    const row = (await asUser(CHAIRMAN, () => analytics.channels(window))).find((r) => r.channelKey === 'other');
    expect(typeof row!.spend).toBe('number');
    expect(row!.spend - baseSpend).toBe(100.75);
  });

  it('campaign analytics: spend and budgetPlanned are numbers, and romi is zero with no pipeline', async () => {
    const rows = await asUser(CHAIRMAN, () => analytics.campaigns({}));
    const row = rows.find((r) => r.campaignId === campaignId);
    expect(row).toBeDefined();
    expect(row!.spend).toBe(300.75);
    expect(row!.budgetPlanned).toBe(1000.25);
    expect(row!.costPerLead).toBeNull();
    expect(row!.romi).toBe(0);
  });

  it('overview: the over-budget attention count moves by one when a campaign is spent past its plan', async () => {
    const attention = async () =>
      (await asUser(CHAIRMAN, () => analytics.overview())).attention.find((a) => a.code === 'over_budget')?.count ?? 0;
    const before = await attention();
    const id = await campaignWith(100);
    await spendOn(id, 100.01);
    expect((await attention()) - before).toBe(1);
  });

  it('pipeline definition: commitApprovalThreshold is a Decimal string, null when unset', async () => {
    const withThreshold = await asUser(CHAIRMAN, () =>
      createPipeline({
        pipelineCode: `PL-S6-${stamp()}`,
        name: 'S6 characterisation',
        commercialMotion: 'enterprise',
        appliesToVerticals: ['software'],
        commitApprovalThreshold: 5000000.5,
      }),
    );
    await retire(withThreshold.id);
    expect(wire(withThreshold).commitApprovalThreshold).toBe('5000000.5');

    const loaded = await asUser(CHAIRMAN, () => loadPipelineWithStages(withThreshold.id));
    expect(wire(loaded).commitApprovalThreshold).toBe('5000000.5');

    const unset = await asUser(CHAIRMAN, () =>
      createPipeline({
        pipelineCode: `PL-S6-${stamp()}`,
        name: 'S6 characterisation unset',
        commercialMotion: 'enterprise',
        appliesToVerticals: ['software'],
      }),
    );
    await retire(unset.id);
    expect(wire(unset).commitApprovalThreshold).toBeNull();
  });

  it('commit gate: equal to the pipeline threshold passes, one paisa over is asked of an approver', async () => {
    const pipeline = await unscopedPrisma.pipelineDefinition.findFirstOrThrow({
      where: { tenantId: TENANT, pipelineCode: 'PL-ENTERPRISE', effectiveTo: null },
      include: { stages: { where: { retiredAt: null } } },
    });
    const original = pipeline.commitApprovalThresholdMinor;
    const shaped = pipeline.stages.find((s) => s.pipelinePosition === 40);
    if (!shaped) throw new Error('PL-ENTERPRISE has no position-40 stage in this database');

    // A clerk who may edit opportunities but not approve them: the commit gate's
    // approve check is the only thing that can refuse it.
    const asClerk = <T>(fn: () => Promise<T>) =>
      withFixtureRole(
        {
          slug: 's6_commit_clerk',
          classificationCeiling: 'regulated',
          grants: [{ resource: 'opportunities', verbs: ['view', 'edit'] }],
        },
        (p) => asPrincipal(authFor(p), fn),
      );

    const opp = await unscopedPrisma.opportunity.findFirstOrThrow({
      where: { tenantId: TENANT, pipelineId: pipeline.id, outcome: null, deletedAt: null },
    });
    const reset = () =>
      unscopedPrisma.opportunity.update({
        where: { id: opp.id },
        data: {
          stageKey: shaped.stageKey,
          forecastCategory: 'best_case',
          expectedCloseDate: new Date(Date.now() + 30 * 86_400_000),
        },
      });

    try {
      await unscopedPrisma.pipelineDefinition.update({
        where: { id: pipeline.id },
        data: { commitApprovalThresholdMinor: 100000000n },
      });

      await reset();
      await unscopedPrisma.opportunity.update({ where: { id: opp.id }, data: { expectedValueMinor: 100000000n } });
      const equal = await asClerk(() => changeForecastCategory({ opportunityId: opp.id, to: 'commit' }));
      expect(equal.forecastCategory).toBe('commit');

      await reset();
      await unscopedPrisma.opportunity.update({ where: { id: opp.id }, data: { expectedValueMinor: 100000001n } });
      const over = await expectReject(() =>
        asClerk(() => changeForecastCategory({ opportunityId: opp.id, to: 'commit' })),
      );
      expect(over.status).toBe(403);

      await reset();
      await unscopedPrisma.opportunity.update({ where: { id: opp.id }, data: { expectedValueMinor: 99999999n } });
      const under = await asClerk(() => changeForecastCategory({ opportunityId: opp.id, to: 'commit' }));
      expect(under.forecastCategory).toBe('commit');
    } finally {
      await unscopedPrisma.pipelineDefinition.update({
        where: { id: pipeline.id },
        data: { commitApprovalThresholdMinor: original },
      });
    }
  });
});
