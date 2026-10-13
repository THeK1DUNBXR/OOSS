/**
 * The wire sweep for the MONEY-S6 marketing and pipeline columns (ORDERED-PLAN 1.6).
 *
 * The conversion renamed each money column to `<name>Minor` and kept the rupee
 * field on every view. These assertions cover the places the first pass missed:
 * the event transition and cancel responses (raw rows), the budget variance
 * rows, the campaign performance rows, and the emitted event payloads. Each one
 * reads the value back from the response or from the outbox, so it fails on the
 * code that left the field out.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { bigintReplacer } from '../../platform/wire.js';
import { asUser, tenantId, unscopedPrisma } from '../helpers.js';
import { budgetVariance, createBudget, periodFor, recordSpend, updateBudget } from '../../domains/marketing/budget.js';
import { createCampaign, submitCampaign, type CampaignCreateInput } from '../../domains/marketing/campaigns.js';
import { cancelEvent, createEvent, openEvent } from '../../domains/marketing/events.js';
import * as analytics from '../../domains/marketing/analytics.js';

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
    name: `S6 wire ${stamp()}`,
    objective: 'lead_gen',
    division: 'software',
    channelMix: ['email'],
    startAt: new Date(Date.now() - 86_400_000),
    endAt: new Date(Date.now() + 30 * 86_400_000),
    budgetPlanned: 1000.25,
    ...overrides,
  };
}

/** The newest outbox payload for an event name whose envelope names this entity. */
async function outboxPayloadFor(eventName: string, entityId: string): Promise<string | undefined> {
  const rows = await unscopedPrisma.outboxEvent.findMany({
    where: { tenantId: TENANT, eventName },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return rows.map((r) => JSON.stringify(r.payload, bigintReplacer)).find((s) => s.includes(entityId));
}

describe('MONEY-S6 wire sweep: every money column that leaves the API keeps its rupee field and paise sibling', () => {
  it('event open response keeps costPlanned and costActual with their paise strings', async () => {
    const created = await asUser(CHAIRMAN, () =>
      createEvent({ name: `S6 wire open ${stamp()}`, kind: 'webinar', startAt: new Date(), costPlanned: 2500.5 }),
    );
    const opened = wire(await asUser(CHAIRMAN, () => openEvent(created.id)));
    expect(opened.costPlanned).toBe('2500.5');
    expect(opened.costPlannedMinor).toBe('250050');
    expect(opened.costActual).toBe('0');
    expect(opened.costActualMinor).toBe('0');
  });

  it('event cancel response keeps costPlanned and costActual with their paise strings', async () => {
    const created = await asUser(CHAIRMAN, () =>
      createEvent({ name: `S6 wire cancel ${stamp()}`, kind: 'webinar', startAt: new Date(), costPlanned: 75.1 }),
    );
    const cancelled = wire(await asUser(CHAIRMAN, () => cancelEvent(created.id, 'S6 wire sweep')));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.costPlanned).toBe('75.1');
    expect(cancelled.costPlannedMinor).toBe('7510');
    expect(cancelled.costActualMinor).toBe('0');
  });

  it('budget variance rows carry the planned and committed paise strings beside the rupee figures', async () => {
    const period = periodFor(new Date());
    await asUser(CHAIRMAN, () => createBudget({ period, division: 'software', planned: 0.3 }));
    const rows = await asUser(CHAIRMAN, () => budgetVariance({ period, division: 'software' }));
    const row = rows.find((r) => r.plannedMinor === '30');
    expect(row).toBeDefined();
    expect(row!.planned).toBe(0.3);
    expect(row!.committedMinor).toBe('0');
    expect(row!.committed).toBe(0);
  });

  it('campaign performance rows carry budgetPlannedMinor beside budgetPlanned', async () => {
    const created = await asUser(CHAIRMAN, () => createCampaign(campaignInput({ budgetPlanned: 1000.25 })));
    const rows = await asUser(CHAIRMAN, () => analytics.campaigns({}));
    const row = rows.find((r) => r.campaignId === created.id);
    expect(row).toBeDefined();
    expect(row!.budgetPlanned).toBe(1000.25);
    expect(row!.budgetPlannedMinor).toBe('100025');
  });

  it('campaign submit event payload carries budgetPlannedMinor beside budgetPlanned', async () => {
    const created = await asUser(CHAIRMAN, () => createCampaign(campaignInput({ budgetPlanned: 1000.25 })));
    await asUser(CHAIRMAN, () => submitCampaign(created.id));
    const payload = await outboxPayloadFor('kz.mkt.campaign.scheduled', created.id);
    expect(payload).toBeDefined();
    expect(payload).toContain('"budgetPlanned":1000.25');
    expect(payload).toContain('"budgetPlannedMinor":"100025"');
  });

  it('budget update event payload carries plannedMinor beside planned', async () => {
    const period = periodFor(new Date());
    const created = await asUser(CHAIRMAN, () => createBudget({ period, division: 'software', planned: 900.1 }));
    await asUser(CHAIRMAN, () => updateBudget(created.id, { planned: 1500.75 }));
    const payload = await outboxPayloadFor('kz.mkt.budget.set', created.id);
    expect(payload).toBeDefined();
    expect(payload).toContain('"plannedMinor":"150075"');
    expect(payload).toContain('"planned":1500.75');
  });

  it('spend recorded event payload carries amountMinor beside amount', async () => {
    const view = await asUser(CHAIRMAN, () =>
      recordSpend({
        channelKey: 'email',
        division: 'software',
        amount: 300.5,
        spendDate: new Date(),
        description: 'S6 wire sweep',
      }),
    );
    const payload = await outboxPayloadFor('kz.mkt.spend.recorded', view.id);
    expect(payload).toBeDefined();
    expect(payload).toContain('"amount":300.5');
    expect(payload).toContain('"amountMinor":"30050"');
  });
});
