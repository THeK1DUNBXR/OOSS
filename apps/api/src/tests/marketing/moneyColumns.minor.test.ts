/**
 * The marketing and pipeline money columns in paise (ORDERED-PLAN 1.6, MONEY-S6).
 *
 * Two kinds of assertion. The first pins what is stored: each converted column
 * holds the paise the rupee figure rounds to, read from the row. The second pins
 * what the wire carries next to the unchanged rupee field: each `<name>Minor` is
 * the paise as a decimal string.
 *
 * The defects block pins two places where the old path summed or subtracted
 * money as JavaScript floats. Those assertions are exact, so they fail on the
 * old code: 0.30 - 0.10 is 0.19999999999999998 in floats, and 0.10 + 0.20 is
 * 0.30000000000000004. The characterisation file pins every other figure as it
 * was, and it passes unchanged on this code.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { bigintReplacer } from '../../platform/wire.js';
import { asUser, tenantId, unscopedPrisma } from '../helpers.js';
import {
  createBudget,
  budgetVariance,
  listBudgets,
  periodFor,
  recordSpend,
  updateBudget,
} from '../../domains/marketing/budget.js';
import {
  createCampaign,
  getCampaign,
  getMarketingPolicy,
  submitCampaign,
  type CampaignCreateInput,
} from '../../domains/marketing/campaigns.js';
import { createEvent, loadEvent } from '../../domains/marketing/events.js';
import { createReferralProgram } from '../../domains/marketing/referrals.js';
import { recordTouchpoint } from '../../domains/marketing/attribution.js';
import * as analytics from '../../domains/marketing/analytics.js';
import { createPipeline } from '../../domains/pipelines.js';

const wire = <T>(value: T): any => JSON.parse(JSON.stringify(value, bigintReplacer));
const CHAIRMAN = 'chairman@kaizen.co.in';

let TENANT: string;
let seq = 0;
const stamp = () => `${Date.now()}-${++seq}`;

beforeAll(async () => {
  TENANT = await tenantId();
});

function campaignInput(overrides: Partial<CampaignCreateInput> = {}): CampaignCreateInput {
  return {
    name: `S6 minor ${stamp()}`,
    objective: 'lead_gen',
    division: 'software',
    channelMix: ['email'],
    startAt: new Date(Date.now() - 86_400_000),
    endAt: new Date(Date.now() + 30 * 86_400_000),
    budgetPlanned: 1000,
    ...overrides,
  };
}

describe('MONEY-S6 marketing and pipeline: paise storage and wire siblings', () => {
  let campaignId: string;
  let budgetId: string;

  it('budget: planned and committed are stored as paise and the view carries their paise strings', async () => {
    const campaign = await asUser(CHAIRMAN, () => createCampaign(campaignInput({ budgetPlanned: 1000.25 })));
    campaignId = campaign.id;
    const view = await asUser(CHAIRMAN, () =>
      createBudget({ period: periodFor(new Date()), division: 'software', planned: 1000.25, campaignId }),
    );
    budgetId = view.id;
    expect(view.planned).toBe(1000.25);
    expect(view.plannedMinor).toBe('100025');
    expect(view.committedMinor).toBe('0');

    const row = await unscopedPrisma.marketingBudget.findUniqueOrThrow({ where: { id: budgetId } });
    expect(row.plannedMinor).toBe(100025n);
    expect(row.committedMinor).toBe(0n);
  });

  it('budget update: the new planned figure is stored in paise', async () => {
    const view = await asUser(CHAIRMAN, () => updateBudget(budgetId, { planned: 1500.75 }));
    expect(view.plannedMinor).toBe('150075');
    const row = await unscopedPrisma.marketingBudget.findUniqueOrThrow({ where: { id: budgetId } });
    expect(row.plannedMinor).toBe(150075n);
  });

  it('spend: amount is stored in paise and the view carries the paise string', async () => {
    const view = await asUser(CHAIRMAN, () =>
      recordSpend({
        campaignId,
        channelKey: 'email',
        division: 'software',
        amount: 300.5,
        spendDate: new Date(),
        description: 'S6',
      }),
    );
    expect(view.amount).toBe(300.5);
    expect(view.amountMinor).toBe('30050');
    const row = await unscopedPrisma.marketingSpend.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.amountMinor).toBe(30050n);
  });

  it('campaign: the four money columns are stored in paise and the view carries their strings', async () => {
    const created = await asUser(CHAIRMAN, () =>
      createCampaign(campaignInput({ budgetPlanned: 1000.25, targetPipelineValue: 250000.75 })),
    );
    expect(created.budgetPlannedMinor).toBe('100025');
    expect(created.budgetCommittedMinor).toBe('0');
    expect(created.budgetActualMinor).toBe('0');
    expect(created.targetPipelineValueMinor).toBe('25000075');

    const row = await unscopedPrisma.marketingCampaign.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.budgetPlannedMinor).toBe(100025n);
    expect(row.targetPipelineValueMinor).toBe(25000075n);
  });

  it('campaign approval: thresholdAmountMinor is the policy threshold in paise', async () => {
    const threshold = (await asUser(CHAIRMAN, () => getMarketingPolicy(TENANT))).campaignApprovalThreshold;
    const id = await asUser(CHAIRMAN, async () => {
      const c = await createCampaign(campaignInput({ budgetPlanned: threshold + 0.01 }));
      await submitCampaign(c.id);
      return c.id;
    });
    const detail = await asUser(CHAIRMAN, () => getCampaign(id));
    expect(detail.approvals).toHaveLength(1);
    expect(detail.approvals[0]!.thresholdAmountMinor).toBe((threshold * 100).toString());
    expect(detail.approvals[0]!.thresholdAmount).toBe(threshold);
  });

  it('event: costPlanned is stored in paise and both the raw row and the view carry the paise', async () => {
    const created = await asUser(CHAIRMAN, () =>
      createEvent({ name: `S6 minor event ${stamp()}`, kind: 'webinar', startAt: new Date(), costPlanned: 2500.5 }),
    );
    expect(wire(created).costPlannedMinor).toBe('250050');
    expect(wire(created).costActualMinor).toBe('0');
    const view = await asUser(CHAIRMAN, () => loadEvent(created.id));
    expect(view.costPlanned).toBe(2500.5);
    expect(view.costPlannedMinor).toBe('250050');
    expect(view.costActualMinor).toBe('0');
  });

  it('referral program: rewardAmount is stored in paise, and null is stored as null', async () => {
    const program = await asUser(CHAIRMAN, () =>
      createReferralProgram({
        name: `S6 minor ${stamp()}`,
        kind: 'referral',
        rewardKind: 'credit',
        rewardAmount: 150.75,
      }),
    );
    expect(wire(program).rewardAmountMinor).toBe('15075');
    const bare = await asUser(CHAIRMAN, () => createReferralProgram({ name: `S6 bare ${stamp()}`, kind: 'referral' }));
    expect(wire(bare).rewardAmountMinor).toBeNull();
  });

  it('touchpoint: cost is stored in paise, null when absent', async () => {
    const priced = await asUser(CHAIRMAN, () =>
      recordTouchpoint({ channelKey: 'email', touchKind: 'open', cost: 42.5, campaignId }),
    );
    expect(wire(priced).costMinor).toBe('4250');
    const free = await asUser(CHAIRMAN, () => recordTouchpoint({ channelKey: 'email', touchKind: 'open', campaignId }));
    expect(wire(free).costMinor).toBeNull();
  });

  it('pipeline definition: commitApprovalThreshold is stored in paise, and the wire carries both forms', async () => {
    const created = await asUser(CHAIRMAN, () =>
      createPipeline({
        pipelineCode: `PL-S6-MINOR-${stamp()}`,
        name: 'S6 minor',
        commercialMotion: 'enterprise',
        appliesToVerticals: ['software'],
        commitApprovalThreshold: 5000000.5,
      }),
    );
    await unscopedPrisma.pipelineDefinition.update({ where: { id: created.id }, data: { effectiveTo: new Date() } });
    expect(wire(created).commitApprovalThreshold).toBe('5000000.5');
    expect(wire(created).commitApprovalThresholdMinor).toBe('500000050');
    const row = await unscopedPrisma.pipelineDefinition.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.commitApprovalThresholdMinor).toBe(500000050n);
  });
});

describe('MONEY-S6 defects: float arithmetic on money that the paise columns remove', () => {
  it('budget remaining is exact: 0.30 planned less 0.10 spent is 0.20', async () => {
    const campaign = await asUser(CHAIRMAN, () => createCampaign(campaignInput({ budgetPlanned: 0.3 })));
    const view = await asUser(CHAIRMAN, () =>
      createBudget({ period: periodFor(new Date()), division: 'software', planned: 0.3, campaignId: campaign.id }),
    );
    await asUser(CHAIRMAN, () =>
      recordSpend({
        campaignId: campaign.id,
        channelKey: 'email',
        division: 'software',
        amount: 0.1,
        spendDate: new Date(),
        description: 'd',
      }),
    );
    const rows = await asUser(CHAIRMAN, () => budgetVariance({ period: periodFor(new Date()), division: 'software' }));
    const row = rows.find((r) => r.campaignId === campaign.id)!;
    expect(row.variance).toBe(0.2);
    expect(row.planned).toBe(0.3);
    const listed = await asUser(CHAIRMAN, () => listBudgets({ period: periodFor(new Date()), division: 'software' }));
    expect(listed.find((b) => b.id === view.id)!.remaining).toBe(0.2);
  });

  it('a channel spend is the exact paise sum: 0.10 and 0.20 on one channel are 0.30', async () => {
    // A year no other test writes to, and one per run, so the sum is this test's
    // alone and the test can be run again on the same database.
    const year = 2100 + (Date.now() % 7000);
    const window = { from: new Date(Date.UTC(year, 0, 1)), to: new Date(Date.UTC(year, 11, 31, 23, 59, 59)) };
    for (const amount of [0.1, 0.2]) {
      await asUser(CHAIRMAN, () =>
        recordSpend({
          channelKey: 'print',
          division: 'software',
          amount,
          spendDate: new Date(Date.UTC(year, 5, 15)),
          description: 'defect',
        }),
      );
    }
    const row = (await asUser(CHAIRMAN, () => analytics.channels(window))).find((r) => r.channelKey === 'print');
    expect(row).toBeDefined();
    expect(row!.spend).toBe(0.3);
  });
});
