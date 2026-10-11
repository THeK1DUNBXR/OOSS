/**
 * Marketing governed writes commit with their audit row and event, or not at all.
 *
 * Two representative functions per marketing file group. Each runs with a
 * test-only trigger on audit_records that refuses every insert, so the audit
 * write fails after the domain write has run inside its transaction. The domain
 * row must be back where it was and no outbox row may exist for the event.
 *
 * Real Postgres and the real decision paths throughout; the trigger is a fault
 * injection the database itself enforces, not a mock.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS } from '@kaizen/shared';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';
import { createAsset, submitForApproval } from '../domains/marketing/assets.js';
import { createCampaign } from '../domains/marketing/campaigns.js';
import { recordSpend } from '../domains/marketing/budget.js';
import { createTemplate, submitForReview } from '../domains/marketing/messaging.js';
import { createEvent, openEvent } from '../domains/marketing/events.js';
import { createForm, publishForm } from '../domains/marketing/capture.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const CREATOR = 'operations@kaizen.co.in';
const INJECTED = 'injected audit failure';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function refuseAuditInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION w2_mkt_refuse_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION '${INJECTED}'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER w2_mkt_refuse_audit_insert BEFORE INSERT ON audit_records
     FOR EACH ROW EXECUTE FUNCTION w2_mkt_refuse_audit_insert()`,
  );
}

async function restoreAuditInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w2_mkt_refuse_audit_insert ON audit_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w2_mkt_refuse_audit_insert()`);
}

afterEach(restoreAuditInserts);

async function outboxCount(eventName: string): Promise<number> {
  return unscopedPrisma.outboxEvent.count({ where: { tenantId: await tenantId(), eventName } });
}

/** Runs `fn` with audit inserts refused, and expects the injected failure to surface. */
async function withRefusedAudit(fn: () => Promise<unknown>): Promise<void> {
  await refuseAuditInserts();
  try {
    await expect(fn()).rejects.toThrow(INJECTED);
  } finally {
    await restoreAuditInserts();
  }
}

describe('marketing assets: a failed audit leaves the asset and its event unwritten', () => {
  it('createAsset: no asset row and no MKT_ASSET_CREATED outbox event', async () => {
    const name = `w2-mkt-atomic-asset-${stamp()}`;
    const before = await outboxCount(EVENTS.MKT_ASSET_CREATED);

    await withRefusedAudit(() =>
      asUser(CHAIRMAN, () => createAsset({ name, kind: 'image', url: 'https://example.invalid/a.png' })),
    );

    expect(await unscopedPrisma.marketingAsset.count({ where: { name } })).toBe(0);
    expect(await outboxCount(EVENTS.MKT_ASSET_CREATED)).toBe(before);
  });

  it('submitForApproval: the asset stays draft and no MKT_ASSET_SUBMITTED outbox event is written', async () => {
    const name = `w2-mkt-atomic-submit-${stamp()}`;
    const asset = await asUser(CREATOR, () => createAsset({ name, kind: 'image' }));
    const before = await outboxCount(EVENTS.MKT_ASSET_SUBMITTED);

    await withRefusedAudit(() => asUser(CREATOR, () => submitForApproval(asset.id)));

    const after = await unscopedPrisma.marketingAsset.findFirstOrThrow({ where: { id: asset.id } });
    expect(after.status).toBe('draft');
    expect(await outboxCount(EVENTS.MKT_ASSET_SUBMITTED)).toBe(before);
  });
});

describe('marketing campaigns and budgets: a failed audit leaves the row and its event unwritten', () => {
  it('createCampaign: no campaign row and no MKT_CAMPAIGN_CREATED outbox event', async () => {
    const name = `w2-mkt-atomic-campaign-${stamp()}`;
    const before = await outboxCount(EVENTS.MKT_CAMPAIGN_CREATED);
    const startAt = new Date(Date.now() + 86_400_000);
    const endAt = new Date(Date.now() + 2 * 86_400_000);

    await withRefusedAudit(() =>
      asUser(CHAIRMAN, () =>
        createCampaign({
          name,
          objective: 'awareness',
          channelMix: ['email'],
          division: 'education',
          startAt,
          endAt,
          budgetPlanned: 1_000,
        } as never),
      ),
    );

    expect(await unscopedPrisma.marketingCampaign.count({ where: { name } })).toBe(0);
    expect(await outboxCount(EVENTS.MKT_CAMPAIGN_CREATED)).toBe(before);
  });

  it('recordSpend: no spend row and no MKT_SPEND_RECORDED outbox event', async () => {
    const description = `w2-mkt-atomic-spend-${stamp()}`;
    const before = await outboxCount(EVENTS.MKT_SPEND_RECORDED);

    await withRefusedAudit(() =>
      asUser(CHAIRMAN, () =>
        recordSpend({
          channelKey: 'email',
          division: 'education',
          amount: 250,
          spendDate: new Date(),
          description,
        } as never),
      ),
    );

    expect(await unscopedPrisma.marketingSpend.count({ where: { description } })).toBe(0);
    expect(await outboxCount(EVENTS.MKT_SPEND_RECORDED)).toBe(before);
  });
});

describe('marketing messaging: a failed audit leaves the template and its event unwritten', () => {
  it('createTemplate: no template row and no MKT_TEMPLATE_CREATED outbox event', async () => {
    const name = `w2-mkt-atomic-template-${stamp()}`;
    const before = await outboxCount(EVENTS.MKT_TEMPLATE_CREATED);

    await withRefusedAudit(() =>
      asUser(CREATOR, () =>
        createTemplate({
          channelKey: 'email',
          name,
          subject: 'Hello',
          body: 'Body {{person.firstName}} {{unsubscribeUrl}}',
          language: 'en',
        } as never),
      ),
    );

    expect(await unscopedPrisma.marketingTemplate.count({ where: { name } })).toBe(0);
    expect(await outboxCount(EVENTS.MKT_TEMPLATE_CREATED)).toBe(before);
  });

  it('submitForReview: the template stays draft and no MKT_TEMPLATE_SUBMITTED outbox event is written', async () => {
    const created = await asUser(CREATOR, () =>
      createTemplate({
        channelKey: 'email',
        name: `w2-mkt-atomic-review-${stamp()}`,
        subject: 'Hello',
        body: 'Body {{person.firstName}} {{unsubscribeUrl}}',
        language: 'en',
      } as never),
    );
    const before = await outboxCount(EVENTS.MKT_TEMPLATE_SUBMITTED);

    await withRefusedAudit(() => asUser(CREATOR, () => submitForReview(created.id)));

    const after = await unscopedPrisma.marketingTemplate.findFirstOrThrow({ where: { id: created.id } });
    expect(after.status).toBe('draft');
    expect(await outboxCount(EVENTS.MKT_TEMPLATE_SUBMITTED)).toBe(before);
  });
});

describe('marketing events and forms: a failed audit leaves the row and its event unwritten', () => {
  it('createEvent: no event row and no MKT_EVENT_CREATED outbox event', async () => {
    const name = `w2-mkt-atomic-event-${stamp()}`;
    const before = await outboxCount(EVENTS.MKT_EVENT_CREATED);

    await withRefusedAudit(() =>
      asUser(CHAIRMAN, () => createEvent({ name, kind: 'webinar', startAt: new Date(), division: 'education' })),
    );

    expect(await unscopedPrisma.marketingEvent.count({ where: { name } })).toBe(0);
    expect(await outboxCount(EVENTS.MKT_EVENT_CREATED)).toBe(before);
  });

  it('openEvent: the event stays planned and no MKT_EVENT_OPENED outbox event is written', async () => {
    const created = await asUser(CHAIRMAN, () =>
      createEvent({
        name: `w2-mkt-atomic-open-${stamp()}`,
        kind: 'webinar',
        startAt: new Date(),
        division: 'education',
      }),
    );
    const before = await outboxCount(EVENTS.MKT_EVENT_OPENED);

    await withRefusedAudit(() => asUser(CHAIRMAN, () => openEvent(created.id)));

    const after = await unscopedPrisma.marketingEvent.findFirstOrThrow({ where: { id: created.id } });
    expect(after.status).toBe('planned');
    expect(await outboxCount(EVENTS.MKT_EVENT_OPENED)).toBe(before);
  });
});

describe('marketing capture: a failed audit leaves the form and its event unwritten', () => {
  it('createForm: no form row and no MKT_FORM_CREATED outbox event', async () => {
    const name = `w2-mkt-atomic-form-${stamp()}`;
    const before = await outboxCount(EVENTS.MKT_FORM_CREATED);

    await withRefusedAudit(() =>
      asUser(CHAIRMAN, () =>
        createForm({
          name,
          fields: [{ key: 'email', label: 'Email', type: 'email', required: true }],
          vertical: 'education',
        } as never),
      ),
    );

    expect(await unscopedPrisma.marketingForm.count({ where: { name } })).toBe(0);
    expect(await outboxCount(EVENTS.MKT_FORM_CREATED)).toBe(before);
  });

  it('publishForm: the form stays inactive and no MKT_FORM_PUBLISHED outbox event is written', async () => {
    const created = await asUser(CHAIRMAN, () =>
      createForm({
        name: `w2-mkt-atomic-publish-${stamp()}`,
        fields: [{ key: 'email', label: 'Email', type: 'email', required: true }],
        vertical: 'education',
      } as never),
    );
    const before = await outboxCount(EVENTS.MKT_FORM_PUBLISHED);

    await withRefusedAudit(() => asUser(CHAIRMAN, () => publishForm(created.id)));

    const after = await unscopedPrisma.marketingForm.findFirstOrThrow({ where: { id: created.id } });
    expect(after.active).toBe(false);
    expect(await outboxCount(EVENTS.MKT_FORM_PUBLISHED)).toBe(before);
  });
});
