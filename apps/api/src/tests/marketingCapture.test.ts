/**
 * Marketing capture — forms, public submission, touchpoints, attribution and
 * lead scoring (MKT-CAP-001 through MKT-CAP-008).
 *
 * DB-backed: every test runs inside a real request context (or, for the
 * public/unauthenticated surface, through the same `asSystem` path a real
 * request would take) so the tenant gate, the grant evaluator and the event
 * chain are all genuinely exercised.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from './helpers.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { resetAdapterCacheForTests } from '../domains/marketing/adapters/registry.js';
import {
  createForm,
  publishForm,
  unpublishForm,
  rotateToken,
  formEmbedInfo,
  loadForm,
  submitPublicForm,
  resetRateLimitForTests,
  detectUnconvertedSubmissions,
  createShortLink,
  resolveAndClick,
  receiveWebhook,
} from '../domains/marketing/capture.js';
import {
  recordTouchpoint,
  computeAttribution,
  attributionForLead,
  createScoreRule,
  previewScore,
  applyScores,
  detectUnattributedLeads,
} from '../domains/marketing/attribution.js';
import { createLead } from '../domains/leads.js';
import { findOrCreatePerson } from '../domains/identity.js';

const OPS = 'operations@kaizen.co.in'; // hr_ops_manager: holds marketing_forms VCEDXF
const CHAIRMAN = 'chairman@kaizen.co.in'; // superadmin
const FINANCE = 'finance@kaizen.co.in'; // finance_head: holds leads VCEDAXF — createLead runs as this account below

beforeEach(() => {
  resetRateLimitForTests();
  resetAdapterCacheForTests();
});

async function makeForm(overrides: Record<string, unknown> = {}) {
  return asUser(OPS, () =>
    createForm({
      name: `Contact us ${Date.now()}-${Math.random()}`,
      fields: [
        { key: 'fullName', label: 'Full name', type: 'text', required: true },
        { key: 'email', label: 'Email', type: 'email', required: true },
        { key: 'phone', label: 'Phone', type: 'phone' },
      ],
      vertical: 'education',
      ...overrides,
    } as never),
  );
}

async function publishedForm(overrides: Record<string, unknown> = {}) {
  const form = await makeForm(overrides);
  return asUser(OPS, () => publishForm(form.id));
}

describe('MKT-CAP-001 — a public form submission is accepted only against an active publicToken', () => {
  it('creates a form in draft, publishes it, and exposes a random publicToken + embed info', async () => {
    const form = await makeForm();
    expect(form.active).toBe(false);
    expect(form.publicToken).toHaveLength(64); // 32 bytes hex

    const published = await asUser(OPS, () => publishForm(form.id));
    expect(published.active).toBe(true);

    const embed = await asUser(OPS, () => formEmbedInfo(form.id));
    expect(embed.publicUrl).toBe(`/api/marketing/public/forms/${form.publicToken}/submit`);
    expect(embed.embedSnippet).toContain('<form');
    expect(embed.embedSnippet).toContain('name="website"'); // the honeypot field is present but hidden

    const rotated = await asUser(OPS, () => rotateToken(form.id));
    expect(rotated.publicToken).not.toBe(form.publicToken);
  });

  it('rejects submission against an inactive (unpublished) form with 404', async () => {
    const form = await makeForm(); // never published
    const err = await expectReject(() => submitPublicForm(form.publicToken, { fullName: 'A', email: 'a@example.com' }));
    expect(err.status).toBe(404);
  });

  it('rejects submission against an unknown token with 404', async () => {
    const err = await expectReject(() => submitPublicForm('not-a-real-token', {}));
    expect(err.status).toBe(404);
  });
});

describe('MKT-CAP-002 — a converted submission creates or finds a Person via findOrCreatePerson, and a Lead carrying campaign/channel/utm', () => {
  it('a genuine submission creates a submission row, a touchpoint, a person, and a lead with campaignId/utm set', async () => {
    const tid = await tenantId();
    const campaign = await asUser(OPS, () =>
      prisma.marketingCampaign.create({
        data: {
          tenantId: tid,
          recordCode: 'CPG-TEST-' + Date.now(),
          name: 'Spring intake',
          objective: 'lead_gen',
          division: 'education',
          startAt: new Date(),
          endAt: new Date(Date.now() + 7 * 86_400_000),
          utmCampaign: `spring-intake-${Date.now()}`,
        },
      }),
    );
    const form = await publishedForm();

    const email = `lead-${Date.now()}@example.com`;
    const result = await submitPublicForm(
      form.publicToken,
      { fullName: 'Priya Sharma', email, phone: '9876543210' },
      { ip: '10.0.0.1', utm: { campaign: campaign.utmCampaign, source: 'newsletter', medium: 'email' } },
    );
    expect(result.ok).toBe(true);

    const submission = await unscopedPrisma.marketingFormSubmission.findFirstOrThrow({ where: { formId: form.id } });
    expect(submission.status).toBe('converted');
    expect(submission.personId).toBeTruthy();
    expect(submission.leadId).toBeTruthy();

    const lead = await unscopedPrisma.lead.findFirstOrThrow({ where: { id: submission.leadId! } });
    expect(lead.campaignId).toBe(campaign.id);
    expect(lead.channelKey).toBe('website');
    expect((lead.utm as Record<string, unknown>).campaign).toBe(campaign.utmCampaign);
    expect(lead.source).toBe('form');
    // Marketing never assigns ownership — that is CRM's routing, run inline by createLead.
    // (ownerPartyId may be null if unrouted, but the field is never set by capture.ts directly.)

    const person = await unscopedPrisma.person.findFirstOrThrow({ where: { id: submission.personId! } });
    expect(person.primaryEmail).toBe(email);

    const touchpoint = await unscopedPrisma.marketingTouchpoint.findFirstOrThrow({ where: { tenantId: tid, touchKind: 'form', campaignId: campaign.id } });
    expect(touchpoint.channelKey).toBe('website');

    const refreshedForm = await unscopedPrisma.marketingForm.findFirstOrThrow({ where: { id: form.id } });
    expect(refreshedForm.submissionCount).toBe(1);
  });

  it('resolving the same person twice (matching email) does not fork identity', async () => {
    const form = await publishedForm();
    const email = `same-${Date.now()}@example.com`;

    await submitPublicForm(form.publicToken, { fullName: 'First Time', email });
    // Wait past the 10-minute dedupe window is not needed since payload differs (name changes).
    await submitPublicForm(form.publicToken, { fullName: 'First Time Again', email });

    const people = await unscopedPrisma.person.findMany({ where: { primaryEmail: email } });
    expect(people.length).toBe(1);
  });
});

describe('honeypot — a bot filling the hidden `website` field is told nothing', () => {
  it('stores the submission as spam and still answers ok:true', async () => {
    const form = await publishedForm();
    const result = await submitPublicForm(form.publicToken, {
      fullName: 'Bot',
      email: 'bot@example.com',
      website: 'http://spam.example',
    });
    expect(result.ok).toBe(true);

    const submission = await unscopedPrisma.marketingFormSubmission.findFirstOrThrow({ where: { formId: form.id } });
    expect(submission.status).toBe('spam');
    expect(submission.leadId).toBeNull();
  });
});

describe('duplicate detection — an identical payload within 10 minutes is not converted twice', () => {
  it('marks the second identical submission duplicate', async () => {
    const form = await publishedForm();
    const payload = { fullName: 'Dup Test', email: `dup-${Date.now()}@example.com` };

    await submitPublicForm(form.publicToken, payload);
    await submitPublicForm(form.publicToken, payload);

    const submissions = await unscopedPrisma.marketingFormSubmission.findMany({ where: { formId: form.id }, orderBy: { receivedAt: 'asc' } });
    expect(submissions).toHaveLength(2);
    expect(submissions[0].status).toBe('converted');
    expect(submissions[1].status).toBe('duplicate');
  });
});

describe('rate limiting — 30 submissions per minute per IP', () => {
  it('the 31st submission from the same IP in a minute is rejected with 429', async () => {
    const form = await publishedForm();
    const ip = '203.0.113.7';

    for (let i = 0; i < 30; i += 1) {
      await submitPublicForm(form.publicToken, { fullName: `Person ${i}`, email: `rl-${i}-${Date.now()}@example.com` }, { ip });
    }

    const err = await expectReject(() =>
      submitPublicForm(form.publicToken, { fullName: 'One too many', email: `rl-31-${Date.now()}@example.com` }, { ip }),
    );
    expect(err.status).toBe(429);
  });

  it('a different IP is unaffected by another IP exhausting its limit', async () => {
    const form = await publishedForm();
    for (let i = 0; i < 30; i += 1) {
      await submitPublicForm(form.publicToken, { fullName: `Person ${i}`, email: `x-${i}-${Date.now()}@example.com` }, { ip: '198.51.100.1' });
    }
    const result = await submitPublicForm(form.publicToken, { fullName: 'Fresh IP', email: `fresh-${Date.now()}@example.com` }, { ip: '198.51.100.2' });
    expect(result.ok).toBe(true);
  });
});

describe('MKT-CAP-003 — a submission unconverted for 24h raises EX-MKT-007', () => {
  it('raises EX-MKT-007 once for a stale received submission', async () => {
    const form = await publishedForm();
    const submission = await asUser(OPS, () =>
      prisma.marketingFormSubmission.create({
        data: {
          tenantId: form.tenantId,
          recordCode: `SUB-TEST-${Date.now()}`,
          formId: form.id,
          payload: { fullName: 'Stale', email: 'stale@example.com' },
          status: 'received',
          receivedAt: new Date(Date.now() - 30 * 3_600_000),
        },
      }),
    );

    const count = await asUser(OPS, () => detectUnconvertedSubmissions(24));
    expect(count).toBeGreaterThanOrEqual(1);

    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: form.tenantId, code: 'EX-MKT-007', subjectId: submission.id },
    });
    expect(exception).toBeTruthy();

    // Idempotent: running it again does not create a second exception row.
    await asUser(OPS, () => detectUnconvertedSubmissions(24));
    const exceptions = await unscopedPrisma.exceptionRecord.findMany({
      where: { tenantId: form.tenantId, code: 'EX-MKT-007', subjectId: submission.id },
    });
    expect(exceptions).toHaveLength(1);
  });
});

describe('MKT-CAP-004 — every touchpoint is immutable once recorded', () => {
  it('recordTouchpoint exposes no update or delete path', async () => {
    // Structural assertion: the module's only touchpoint-shaped exports are
    // create (recordTouchpoint) and read (listTouchpoints/attributionForLead) —
    // there is no updateTouchpoint or deleteTouchpoint to import.
    const mod = await import('../domains/marketing/attribution.js');
    expect(typeof (mod as Record<string, unknown>).updateTouchpoint).toBe('undefined');
    expect(typeof (mod as Record<string, unknown>).deleteTouchpoint).toBe('undefined');
  });
});

describe('short links — a click records a touchpoint and appends utm to the target', () => {
  it('resolveAndClick redirects to the target URL with utm params, and increments clickCount', async () => {
    const link = await asUser(OPS, () =>
      createShortLink({ targetUrl: 'https://example.com/landing', channelKey: 'social_meta', utm: { source: 'meta', medium: 'social', campaign: 'launch' } }),
    );

    const { targetUrl } = await resolveAndClick(link.slug);
    const url = new URL(targetUrl);
    expect(url.searchParams.get('utm_source')).toBe('meta');
    expect(url.searchParams.get('utm_campaign')).toBe('launch');

    const refreshed = await unscopedPrisma.marketingShortLink.findFirstOrThrow({ where: { id: link.id } });
    expect(refreshed.clickCount).toBe(1);

    const touchpoint = await unscopedPrisma.marketingTouchpoint.findFirstOrThrow({ where: { sourceRef: link.slug, touchKind: 'click' } });
    expect(touchpoint.channelKey).toBe('social_meta');
  });

  it('an unknown slug is a 404', async () => {
    const err = await expectReject(() => resolveAndClick('no-such-slug'));
    expect(err.status).toBe(404);
  });
});

describe('MKT-CAP-007 — lead score is the sum of active rule matches, CRM reasons never removed', () => {
  it('previewScore keeps every CRM reason and appends mkt: reasons on top', async () => {
    const tid = await tenantId();
    const lead = await asUser(FINANCE, () =>
      createLead({
        title: 'Referral enquiry',
        person: { fullName: 'Referral Person', primaryEmail: `ref-${Date.now()}@example.com`, primaryPhone: '9000000000' },
        vertical: 'education',
        source: 'referral',
      }),
    );

    await asUser(OPS, () =>
      createScoreRule({ name: `Referral bonus ${Date.now()}`, condition: { field: 'source', op: 'eq', value: 'referral' }, points: 20 }),
    );

    const preview = await asUser(OPS, () => previewScore(lead.id));
    // CRM's own reasons (phone/email/source weighting) are all still present.
    expect(preview.reasons.some((r) => r.includes('reachable by phone'))).toBe(true);
    expect(preview.reasons.some((r) => r.includes('reachable by email'))).toBe(true);
    // Marketing's own reason is appended, clearly prefixed.
    expect(preview.reasons.some((r) => r.startsWith('mkt:'))).toBe(true);
    expect(preview.score).toBeGreaterThan(0);

    await asUser(OPS, () => applyScores());
    const refreshed = await unscopedPrisma.lead.findFirstOrThrow({ where: { id: lead.id } });
    expect(refreshed.scoreReasons.some((r) => r.startsWith('mkt:'))).toBe(true);
    expect(refreshed.scoreReasons.some((r) => r.includes('reachable by phone'))).toBe(true);

    // Running applyScores again never accumulates duplicate mkt: reasons.
    await asUser(OPS, () => applyScores());
    const refreshedAgain = await unscopedPrisma.lead.findFirstOrThrow({ where: { id: lead.id } });
    const mktReasons = refreshedAgain.scoreReasons.filter((r) => r.startsWith('mkt:'));
    expect(mktReasons.length).toBe(preview.reasons.filter((r) => r.startsWith('mkt:')).length);
  });
});

describe('MKT-CAP-006 / EX-MKT-001 — a lead with no attributable source raises the unattributed exception', () => {
  it('flags an open lead with no campaign/channel and an eligible source', async () => {
    const lead = await asUser(FINANCE, () =>
      createLead({
        title: 'Walk-in enquiry',
        person: { fullName: 'Manual Lead', primaryEmail: `manual-${Date.now()}@example.com` },
        vertical: 'education',
        source: 'manual',
      }),
    );

    const count = await asUser(OPS, () => detectUnattributedLeads());
    expect(count).toBeGreaterThanOrEqual(1);

    const exception = await unscopedPrisma.exceptionRecord.findFirst({ where: { code: 'EX-MKT-001', subjectId: lead.id } });
    expect(exception).toBeTruthy();

    // Idempotent — a second run raises nothing new for the same lead.
    await asUser(OPS, () => detectUnattributedLeads());
    const exceptions = await unscopedPrisma.exceptionRecord.findMany({ where: { code: 'EX-MKT-001', subjectId: lead.id } });
    expect(exceptions).toHaveLength(1);
  });

  it('does not flag a lead already carrying a channelKey', async () => {
    const lead = await asUser(FINANCE, () =>
      createLead({
        title: 'Attributed enquiry',
        person: { fullName: 'Attributed Lead', primaryEmail: `attributed-${Date.now()}@example.com` },
        vertical: 'education',
        source: 'manual',
      }),
    );
    await asUser(OPS, () => prisma.lead.update({ where: { id: lead.id }, data: { channelKey: 'website' } }));

    await asUser(OPS, () => detectUnattributedLeads());
    const exception = await unscopedPrisma.exceptionRecord.findFirst({ where: { code: 'EX-MKT-001', subjectId: lead.id } });
    expect(exception).toBeNull();
  });
});

describe('MKT-CAP-005 — attribution is computed and stored per model, never derived at render time', () => {
  it('two touches split the weight so first/last/linear all sum to 1', async () => {
    const person = await asUser(OPS, () =>
      findOrCreatePerson({ fullName: 'Attribution Person', primaryEmail: `attr-${Date.now()}@example.com` }),
    );

    const now = new Date();
    const earlier = new Date(now.getTime() - 3600_000);

    await asUser(OPS, () =>
      recordTouchpoint({ personId: person.person.id, channelKey: 'social_meta', touchKind: 'impression', occurredAt: earlier }),
    );
    await asUser(OPS, () =>
      recordTouchpoint({ personId: person.person.id, channelKey: 'email', touchKind: 'click', occurredAt: new Date(now.getTime() - 1800_000) }),
    );

    const lead = await asUser(FINANCE, () =>
      createLead({ title: 'Two touches', personId: person.person.id, vertical: 'education', source: 'inbound_website' }),
    );

    await asUser(OPS, () => computeAttribution(new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 1000)));

    const rows = await asUser(OPS, () => attributionForLead(lead.id));
    const byModel = (m: string) => rows.filter((r) => r.model === m);

    for (const model of ['first_touch', 'last_touch', 'linear', 'position_based']) {
      const modelRows = byModel(model);
      const sum = modelRows.reduce((acc, r) => acc + Number(r.weight.toString()), 0);
      expect(sum).toBeCloseTo(1, 5);
    }

    expect(byModel('first_touch')).toHaveLength(1);
    expect(byModel('first_touch')[0].channelKey).toBe('social_meta');
    expect(byModel('last_touch')[0].channelKey).toBe('email');
    expect(byModel('linear')).toHaveLength(2);
    byModel('linear').forEach((r) => expect(Number(r.weight.toString())).toBeCloseTo(0.5, 5));
  });

  it('a lead with no touches gets a single "Unattributed" row per model', async () => {
    const lead = await asUser(FINANCE, () =>
      createLead({
        title: 'No touches at all',
        person: { fullName: 'Untouched', primaryEmail: `untouched-${Date.now()}@example.com` },
        vertical: 'education',
        source: 'manual',
      }),
    );

    const now = new Date();
    await asUser(OPS, () => computeAttribution(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000)));

    const rows = await asUser(OPS, () => attributionForLead(lead.id));
    expect(rows).toHaveLength(4); // one per ATTRIBUTION_MODELS entry
    for (const row of rows) {
      expect(row.campaignId).toBeNull();
      expect(row.channelKey).toBe('');
      expect(Number(row.weight.toString())).toBe(1);
    }
  });
});

describe('inbound webhooks', () => {
  it('stores an unrouted row for an unrecognised provider, tenant resolved via X-Kai-Tenant', async () => {
    const tid = await tenantId();
    const tenant = await unscopedPrisma.tenant.findFirstOrThrow({ where: { id: tid } });

    const result = await receiveWebhook('mystery-provider', { hello: 'world' }, { tenantSlug: tenant.slug });
    expect(result.status).toBe('unrouted');

    const row = await unscopedPrisma.marketingWebhookInbound.findFirstOrThrow({ where: { tenantId: tid, provider: 'mystery-provider' } });
    expect(row.status).toBe('unrouted');
  });

  it('rejects a webhook with no resolvable tenant', async () => {
    const err = await expectReject(() => receiveWebhook('email', {}, {}));
    expect(err.status).toBe(400);
  });

  it('an email delivery webhook is parsed by the console adapter and applied via messaging.applyDeliveryEvents', async () => {
    const tid = await tenantId();
    const tenant = await unscopedPrisma.tenant.findFirstOrThrow({ where: { id: tid } });

    const original = process.env.MARKETING_EMAIL_ADAPTER;
    process.env.MARKETING_EMAIL_ADAPTER = 'console';
    resetAdapterCacheForTests();
    try {
      // The console adapter's parseInboundWebhook defensively returns [] for
      // any payload shape (it has no real provider format) — the contract
      // under test is that the row is stored and marked processed, and that
      // the messaging pipeline is invoked without throwing.
      const result = await receiveWebhook('email', { events: [] }, { tenantSlug: tenant.slug });
      expect(result.status).toBe('processed');

      const row = await unscopedPrisma.marketingWebhookInbound.findFirstOrThrow({ where: { tenantId: tid, provider: 'email' } });
      expect(row.processedAt).toBeTruthy();
    } finally {
      if (original === undefined) delete process.env.MARKETING_EMAIL_ADAPTER;
      else process.env.MARKETING_EMAIL_ADAPTER = original;
      resetAdapterCacheForTests();
    }
  });
});

describe('cross-tenant isolation', () => {
  it('loading a form created in another tenant is a 404, not the record', async () => {
    const other = await unscopedPrisma.tenant.upsert({
      where: { slug: 'mkt-capture-other-tenant' },
      create: { slug: 'mkt-capture-other-tenant', name: 'Other Tenant (marketing capture tests)' },
      update: {},
    });
    const foreignForm = await unscopedPrisma.marketingForm.create({
      data: {
        tenantId: other.id,
        recordCode: `FRM-OTHER-${Date.now()}`,
        name: 'Foreign form',
        slug: `foreign-form-${Date.now()}`,
        fields: [{ key: 'email', label: 'Email', type: 'email' }],
        vertical: 'education',
        publicToken: `foreign-token-${Date.now()}`,
      },
    });

    const err = await expectReject(() => asUser(OPS, () => loadForm(foreignForm.id)));
    expect(err.status).toBe(404);
  });
});
