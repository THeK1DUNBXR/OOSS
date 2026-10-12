/**
 * Inbound marketing webhooks are authenticated by a per-tenant HMAC, not by a
 * header. The tenant comes from the endpoint the request was signed for; a body
 * is applied only when its signature verifies and its timestamp is fresh; a
 * provider event id is applied once (FX-50).
 *
 * Exercised over HTTP through createApp() so the raw-body capture and the
 * route's status codes are the ones a provider actually sees.
 */

import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asUser, prisma, tenantId, unscopedPrisma } from './helpers.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { grantConsent, publishNotice, currentNoticePurposeCodes, encryptField } from '../domains/compliance/privacy.js';
import { PURPOSE_CODES } from '@kaizen/shared';
import { resetAdapterCacheForTests } from '../domains/marketing/adapters/registry.js';
import {
  createTemplate,
  submitForReview,
  approveTemplate,
  createSend,
  requestSend,
  dispatchSend,
  listSendRecipients,
  loadSend,
} from '../domains/marketing/messaging.js';
import { createWebhookEndpoint } from '../domains/marketing/capture.js';
import { applyDeliveryEvents, markRecipientDispatched } from '../domains/marketing/messaging.js';
import { createApp } from '../server.js';

const CREATOR = 'operations@kaizen.co.in';
const APPROVER = 'chairman@kaizen.co.in';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  resetAdapterCacheForTests();
  await ensureMarketingPurposeNotice();
});

let noticeEnsured = false;
async function ensureMarketingPurposeNotice() {
  if (noticeEnsured) return;
  const codes = await asUser(APPROVER, async () => currentNoticePurposeCodes(await tenantId()));
  if (!codes.has('marketing')) {
    await asUser(APPROVER, () =>
      publishNotice({
        effectiveFrom: new Date(),
        body: 'Marketing webhook test fixture notice.',
        purposes: PURPOSE_CODES.map((code) => ({
          code,
          label: code,
          lawfulBasis: 'consent',
          dataCategories: ['contact'],
          retention: 'Until consent is withdrawn',
        })),
      }),
    );
  }
  noticeEnsured = true;
}

/**
 * A marketing email already dispatched, so its recipient carries a
 * providerMessageId that a delivery webhook can name. Dispatch runs against the
 * fake adapter; the webhook is parsed by the http adapter (the only email
 * adapter whose parseInboundWebhook reads a payload).
 */
async function dispatchedRecipient(): Promise<{ personId: string; sendId: string; providerMessageId: string }> {
  const person = await asUser(APPROVER, async (p) =>
    prisma.person.create({
      data: {
        tenantId: p.tenantId,
        recordCode: await nextRecordCode('PER'),
        fullName: 'Webhook Subject',
        primaryEmail: `hook-${Date.now()}-${Math.random()}@example.com`,
        primaryEmailNormalised: `hook-${Date.now()}-${Math.random()}@example.com`,
        source: 'test',
      },
    }),
  );
  await asUser(APPROVER, () => grantConsent({ personId: person.id, purposeCode: 'marketing', channel: 'portal' }));

  const template = await asUser(CREATOR, () =>
    createTemplate({
      channelKey: 'email',
      name: `Hook ${Date.now()}`,
      subject: 'Hi',
      body: 'Hello {{unsubscribeUrl}}',
      language: 'en',
    } as never),
  );
  await asUser(CREATOR, () => submitForReview(template.id));
  await asUser(APPROVER, () => approveTemplate(template.id));

  process.env.MARKETING_EMAIL_ADAPTER = 'fake';
  resetAdapterCacheForTests();
  const send = await asUser(CREATOR, () =>
    createSend({ templateId: template.id, channelKey: 'email', personIds: [person.id] } as never),
  );
  await asUser(CREATOR, () => requestSend(send.id));
  await asUser(CREATOR, () => dispatchSend(send.id));
  const [recipient] = await asUser(CREATOR, () => listSendRecipients(send.id));
  if (!recipient.providerMessageId) throw new Error('fixture: recipient was not dispatched');

  process.env.MARKETING_EMAIL_ADAPTER = 'http';
  resetAdapterCacheForTests();
  return { personId: person.id, sendId: send.id, providerMessageId: recipient.providerMessageId };
}

/** Provisions the kaizen tenant's email endpoint, replacing any left by an earlier run. */
async function provisionKaizenEmailEndpoint() {
  const tid = await tenantId();
  await unscopedPrisma.marketingWebhookEndpoint.deleteMany({ where: { tenantId: tid, provider: 'email' } });
  return asUser(APPROVER, () => createWebhookEndpoint('email'));
}

function sign(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const hex = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { 'x-kai-timestamp': String(timestamp), 'x-kai-signature': `sha256=${hex}` };
}

function deliveryBody(eventId: string, providerMessageId: string, event: string): string {
  return JSON.stringify({
    eventId,
    events: [{ id: providerMessageId, event, timestamp: new Date().toISOString() }],
  });
}

async function postWebhook(token: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/marketing/public/webhooks/email/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

async function marketingConsentStatus(personId: string): Promise<string | undefined> {
  const row = await unscopedPrisma.consent.findFirst({
    where: { personId, purposeCode: 'marketing' },
    orderBy: { createdAt: 'desc' },
  });
  return row?.status;
}

describe('FX-50 — forged webhook cannot withdraw consent', () => {
  it('an unsigned unsubscribe, even with a tenant header, is refused and consent stands', async () => {
    const { personId, providerMessageId } = await dispatchedRecipient();
    expect(await marketingConsentStatus(personId)).toBe('granted');

    // The old contract: tenant from X-Kai-Tenant, no signature. Any non-2xx is
    // acceptable (the route moved to a token path, so this may be a 404), but
    // a 2xx would mean the header was trusted.
    const res = await fetch(`${base}/api/marketing/public/webhooks/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kai-tenant': 'kaizen' },
      body: deliveryBody(`forged-${Date.now()}`, providerMessageId, 'unsubscribed'),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await marketingConsentStatus(personId)).toBe('granted');
  });

  it('an unsubscribe signed with another tenant’s secret is refused with 401 and consent stands', async () => {
    const { personId, providerMessageId } = await dispatchedRecipient();
    const mine = await provisionKaizenEmailEndpoint();

    const other = await unscopedPrisma.tenant.upsert({
      where: { slug: 'mkt-webhook-other-tenant' },
      create: { slug: 'mkt-webhook-other-tenant', name: 'Other Tenant (marketing webhook tests)' },
      update: {},
    });
    const otherSecret = 'other-tenant-secret-0123456789abcdef';
    await unscopedPrisma.marketingWebhookEndpoint.deleteMany({ where: { tenantId: other.id, provider: 'email' } });
    await unscopedPrisma.marketingWebhookEndpoint.create({
      data: {
        tenantId: other.id,
        recordCode: `WHK-OTHER-${Date.now()}`,
        provider: 'email',
        token: `other-${Date.now()}`,
        secretCipher: encryptField(otherSecret),
      },
    });

    const body = deliveryBody(`cross-${Date.now()}`, providerMessageId, 'unsubscribed');
    const res = await postWebhook(mine.token, body, sign(otherSecret, body));
    expect(res.status).toBe(401);
    expect(await marketingConsentStatus(personId)).toBe('granted');
  });

  it('a correctly signed unsubscribe is applied, so the refusals above are about the signature and not a dead route', async () => {
    const { personId, providerMessageId } = await dispatchedRecipient();
    const endpoint = await provisionKaizenEmailEndpoint();

    const body = deliveryBody(`legit-unsub-${Date.now()}`, providerMessageId, 'unsubscribed');
    const res = await postWebhook(endpoint.token, body, sign(endpoint.signingSecret, body));
    expect(res.status).toBe(202);
    expect(await marketingConsentStatus(personId)).toBe('withdrawn');
  });
});

describe('FX-50 — signature, timestamp and replay', () => {
  it('a body signed with the right secret but a stale timestamp is refused (replay window)', async () => {
    const { sendId, providerMessageId } = await dispatchedRecipient();
    const endpoint = await provisionKaizenEmailEndpoint();

    const body = deliveryBody(`stale-${Date.now()}`, providerMessageId, 'delivered');
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    const res = await postWebhook(endpoint.token, body, sign(endpoint.signingSecret, body, hourAgo));
    expect(res.status).toBe(401);
    expect((await asUser(APPROVER, () => loadSend(sendId))).deliveredCount).toBe(0);
  });

  it('a replayed delivery event is applied once: second delivery answers 200 and the counter stays at 1', async () => {
    const { sendId, providerMessageId } = await dispatchedRecipient();
    const endpoint = await provisionKaizenEmailEndpoint();

    const body = deliveryBody(`replay-${Date.now()}`, providerMessageId, 'delivered');
    const headers = sign(endpoint.signingSecret, body);

    const first = await postWebhook(endpoint.token, body, headers);
    expect(first.status).toBe(202);
    const second = await postWebhook(endpoint.token, body, headers);
    expect(second.status).toBe(200);

    expect((await asUser(APPROVER, () => loadSend(sendId))).deliveredCount).toBe(1);
  });
});

describe('FX-50 follow-up — delivery status only moves forward', () => {
  async function recipientStatus(providerMessageId: string): Promise<string> {
    const row = await unscopedPrisma.marketingSendRecipient.findFirstOrThrow({ where: { providerMessageId } });
    return row.status;
  }

  it('a late delivered after opened does not move the recipient back', async () => {
    const { providerMessageId } = await dispatchedRecipient();
    const at = new Date();
    await asUser(APPROVER, () =>
      applyDeliveryEvents('email', [{ providerMessageId, kind: 'opened', at, eventId: `o-${Date.now()}` }]),
    );
    await asUser(APPROVER, () =>
      applyDeliveryEvents('email', [{ providerMessageId, kind: 'delivered', at, eventId: `d-${Date.now()}` }]),
    );
    expect(await recipientStatus(providerMessageId)).toBe('opened');
  });

  it('a late delivered after bounced leaves the recipient bounced (a terminal failure is not overwritten)', async () => {
    const { providerMessageId } = await dispatchedRecipient();
    const at = new Date();
    await asUser(APPROVER, () =>
      applyDeliveryEvents('email', [{ providerMessageId, kind: 'bounced', at, eventId: `b-${Date.now()}` }]),
    );
    await asUser(APPROVER, () =>
      applyDeliveryEvents('email', [{ providerMessageId, kind: 'delivered', at, eventId: `d-${Date.now()}` }]),
    );
    expect(await recipientStatus(providerMessageId)).toBe('bounced');
  });

  it('delivered then a late sent stays delivered', async () => {
    const { providerMessageId } = await dispatchedRecipient();
    const at = new Date();
    await asUser(APPROVER, () =>
      applyDeliveryEvents('email', [{ providerMessageId, kind: 'delivered', at, eventId: `d-${Date.now()}` }]),
    );
    await asUser(APPROVER, () =>
      applyDeliveryEvents('email', [{ providerMessageId, kind: 'sent', at, eventId: `s-${Date.now()}` }]),
    );
    expect(await recipientStatus(providerMessageId)).toBe('delivered');
  });
});

describe('FX-50 follow-up — dispatch write cannot regress a recipient', () => {
  it('a dispatch write after delivered keeps delivered and keeps the first providerMessageId', async () => {
    const { providerMessageId } = await dispatchedRecipient();
    await asUser(APPROVER, () =>
      applyDeliveryEvents('email', [
        { providerMessageId, kind: 'delivered', at: new Date(), eventId: `dd-${Date.now()}` },
      ]),
    );
    const row = await unscopedPrisma.marketingSendRecipient.findFirstOrThrow({ where: { providerMessageId } });

    await asUser(CREATOR, () => markRecipientDispatched(row.id, `second-${Date.now()}`));

    const after = await unscopedPrisma.marketingSendRecipient.findFirstOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('delivered');
    expect(after.providerMessageId).toBe(providerMessageId);
  });
});

describe('FX-50 follow-up — a provider event applied twice changes state once', () => {
  it('the same eventId and kind applied twice counts delivered once', async () => {
    const { sendId, providerMessageId } = await dispatchedRecipient();
    const event = { providerMessageId, kind: 'delivered' as const, at: new Date(), eventId: `dup-${Date.now()}` };
    await asUser(APPROVER, () => applyDeliveryEvents('email', [event]));
    const second = await asUser(APPROVER, () => applyDeliveryEvents('email', [event]));
    expect(second.applied).toBe(0);
    expect((await asUser(APPROVER, () => loadSend(sendId))).deliveredCount).toBe(1);
  });
});
