/**
 * FX-22: eleven marketing update and delete handlers wrote rows with no audit
 * row. Each domain function now audits the write (update, or delete for the
 * soft deletes) against the row it changed, in the same transaction.
 */

import { describe, expect, it } from 'vitest';
import { updateSocialPost } from '../domains/marketing/assets.js';
import { removeAudienceMember } from '../domains/marketing/audiences.js';
import { updateVendor } from '../domains/marketing/budget.js';
import { deleteCampaign, updateCampaign } from '../domains/marketing/campaigns.js';
import { updateForm } from '../domains/marketing/capture.js';
import { deleteScoreRule, updateScoreRule } from '../domains/marketing/attribution.js';
import { updateEvent } from '../domains/marketing/events.js';
import { updateJourney } from '../domains/marketing/journeys.js';
import { updateReferralProgram } from '../domains/marketing/referrals.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

async function auditActions(tid: string, subjectType: string, subjectId: string): Promise<string[]> {
  const rows = await unscopedPrisma.auditRecord.findMany({ where: { tenantId: tid, subjectType, subjectId } });
  return rows.map((r) => r.action);
}

describe('marketing updates and deletes — audit', () => {
  it('updateSocialPost audits an update against the post', async () => {
    const tid = await tenantId();
    const post = await unscopedPrisma.marketingSocialPost.create({
      data: {
        tenantId: tid,
        recordCode: `SOC-FX22-${stamp()}`,
        channelKey: 'linkedin',
        body: 'FX-22 probe',
        scheduledAt: new Date('2099-01-01T04:00:00Z'),
        status: 'draft',
      },
    });
    await asUser(CHAIRMAN, () => updateSocialPost(post.id, { body: 'FX-22 probe, edited' }));
    expect(await auditActions(tid, 'social_post', post.id)).toContain('update');
  });

  it('removeAudienceMember audits a delete against the member removed', async () => {
    const tid = await tenantId();
    const audience = await unscopedPrisma.marketingAudience.create({
      data: { tenantId: tid, recordCode: `AUD-FX22-${stamp()}`, name: 'FX-22 audience', entityType: 'person' },
    });
    const member = await unscopedPrisma.marketingAudienceMember.create({
      data: {
        tenantId: tid,
        recordCode: `AMB-FX22-${stamp()}`,
        audienceId: audience.id,
        entityType: 'person',
        entityId: `person-${stamp()}`,
      },
    });
    await asUser(CHAIRMAN, () => removeAudienceMember(audience.id, member.id));
    expect(await auditActions(tid, 'audience_member', member.id)).toContain('delete');
  });

  it('updateVendor audits an update against the vendor', async () => {
    const tid = await tenantId();
    const org = await unscopedPrisma.organization.findFirstOrThrow({ where: { tenantId: tid } });
    const vendor = await unscopedPrisma.marketingVendor.create({
      data: { tenantId: tid, recordCode: `VEN-FX22-${stamp()}`, organizationId: org.id },
    });
    await asUser(CHAIRMAN, () => updateVendor(vendor.id, { active: false }));
    expect(await auditActions(tid, 'marketing_vendor', vendor.id)).toContain('update');
  });

  it('updateCampaign audits an update against the campaign', async () => {
    const tid = await tenantId();
    const campaign = await unscopedPrisma.marketingCampaign.create({
      data: {
        tenantId: tid,
        recordCode: `CMP-FX22-${stamp()}`,
        name: 'FX-22 campaign',
        objective: 'awareness',
        division: 'education',
        startAt: new Date('2099-01-01T00:00:00Z'),
        endAt: new Date('2099-02-01T00:00:00Z'),
        utmCampaign: `fx22-${stamp()}`,
      },
    });
    await asUser(CHAIRMAN, () => updateCampaign(campaign.id, { name: 'FX-22 campaign, renamed' }));
    expect(await auditActions(tid, 'marketing_campaign', campaign.id)).toContain('update');
  });

  it('deleteCampaign audits a delete against the draft campaign', async () => {
    const tid = await tenantId();
    const campaign = await unscopedPrisma.marketingCampaign.create({
      data: {
        tenantId: tid,
        recordCode: `CMP-FX22-${stamp()}`,
        name: 'FX-22 campaign to delete',
        objective: 'awareness',
        division: 'education',
        startAt: new Date('2099-01-01T00:00:00Z'),
        endAt: new Date('2099-02-01T00:00:00Z'),
        utmCampaign: `fx22-${stamp()}`,
      },
    });
    await asUser(CHAIRMAN, () => deleteCampaign(campaign.id));
    expect(await auditActions(tid, 'marketing_campaign', campaign.id)).toContain('delete');
  });

  it('updateForm audits an update against the form', async () => {
    const tid = await tenantId();
    const form = await unscopedPrisma.marketingForm.create({
      data: {
        tenantId: tid,
        recordCode: `FRM-FX22-${stamp()}`,
        name: 'FX-22 form',
        slug: `fx22-form-${stamp()}`,
        publicToken: `fx22-token-${stamp()}`,
      },
    });
    await asUser(CHAIRMAN, () => updateForm(form.id, { name: 'FX-22 form, renamed' }));
    expect(await auditActions(tid, 'marketing_form', form.id)).toContain('update');
  });

  it('updateScoreRule audits an update against the rule', async () => {
    const tid = await tenantId();
    const rule = await unscopedPrisma.marketingLeadScoreRule.create({
      data: { tenantId: tid, recordCode: `SCR-FX22-${stamp()}`, name: 'FX-22 rule' },
    });
    await asUser(CHAIRMAN, () => updateScoreRule(rule.id, { points: 7 }));
    expect(await auditActions(tid, 'marketing_score_rule', rule.id)).toContain('update');
  });

  it('deleteScoreRule audits a delete against the rule', async () => {
    const tid = await tenantId();
    const rule = await unscopedPrisma.marketingLeadScoreRule.create({
      data: { tenantId: tid, recordCode: `SCR-FX22-${stamp()}`, name: 'FX-22 rule to delete' },
    });
    await asUser(CHAIRMAN, () => deleteScoreRule(rule.id));
    expect(await auditActions(tid, 'marketing_score_rule', rule.id)).toContain('delete');
  });

  it('updateEvent audits an update against the event', async () => {
    const tid = await tenantId();
    const event = await unscopedPrisma.marketingEvent.create({
      data: {
        tenantId: tid,
        recordCode: `EVT-FX22-${stamp()}`,
        name: 'FX-22 event',
        kind: 'webinar',
        startAt: new Date('2099-01-01T04:00:00Z'),
      },
    });
    await asUser(CHAIRMAN, () => updateEvent(event.id, { name: 'FX-22 event, renamed' }));
    expect(await auditActions(tid, 'marketing_event', event.id)).toContain('update');
  });

  it('updateJourney audits an update against the journey', async () => {
    const tid = await tenantId();
    const journey = await unscopedPrisma.marketingJourney.create({
      data: { tenantId: tid, recordCode: `JRN-FX22-${stamp()}`, name: 'FX-22 journey', triggerKind: 'manual' },
    });
    await asUser(CHAIRMAN, () => updateJourney(journey.id, { name: 'FX-22 journey, renamed' }));
    expect(await auditActions(tid, 'marketing_journey', journey.id)).toContain('update');
  });

  it('updateReferralProgram audits an update against the program', async () => {
    const tid = await tenantId();
    const program = await unscopedPrisma.marketingReferralProgram.create({
      data: { tenantId: tid, recordCode: `RFP-FX22-${stamp()}`, name: 'FX-22 program', kind: 'customer' },
    });
    await asUser(CHAIRMAN, () => updateReferralProgram(program.id, { name: 'FX-22 program, renamed' }));
    expect(await auditActions(tid, 'marketing_referral_program', program.id)).toContain('update');
  });
});
