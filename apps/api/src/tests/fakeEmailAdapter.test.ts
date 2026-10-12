/**
 * FakeEmailAdapter — the built-in email stand-in selected by
 * MARKETING_EMAIL_ADAPTER=fake. Unit cases call the adapter under a system
 * context with a synthetic tenant id (the adapter touches no DB); the last
 * case runs the real dispatch path, the same one MKT-MSG-005 covers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asUser, prisma, tenantId } from './helpers.js';
import { asSystem } from '../platform/context.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { grantConsent, publishNotice } from '../domains/compliance/privacy.js';
import { PURPOSE_CODES } from '@kaizen/shared';
import { getAdapter, resetAdapterCacheForTests } from '../domains/marketing/adapters/registry.js';
import { clearFakeOutbox, fakeOutbox } from '../domains/marketing/adapters/fake.js';
import {
  createTemplate,
  submitForReview,
  approveTemplate,
  createSend,
  requestSend,
  dispatchSend,
  listSendRecipients,
} from '../domains/marketing/messaging.js';
import type { OutboundMessage } from '../domains/marketing/adapters/types.js';

const CREATOR = 'operations@kaizen.co.in'; // hr_ops_manager: holds marketing_templates/sends VCEDXF,approve
const APPROVER = 'chairman@kaizen.co.in'; // superadmin — a distinct principal from CREATOR
const OTHER_TENANT = '00000000-0000-4000-8000-00000000000b';

const message: OutboundMessage = {
  to: { personId: 'person-1', address: 'recipient@example.com' },
  subject: 'Hello',
  body: 'Body text',
  templateRef: 'tpl-1',
};

let tenantA: string;
let originalNodeEnv: string | undefined;

beforeEach(async () => {
  tenantA = await tenantId();
  originalNodeEnv = process.env.NODE_ENV;
  process.env.MARKETING_EMAIL_ADAPTER = 'fake';
  resetAdapterCacheForTests();
  clearFakeOutbox(tenantA);
  clearFakeOutbox(OTHER_TENANT);
});

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  delete process.env.MARKETING_EMAIL_ADAPTER;
  resetAdapterCacheForTests();
  clearFakeOutbox(tenantA);
  clearFakeOutbox(OTHER_TENANT);
});

describe('FakeEmailAdapter — tenant scoping', () => {
  it('a send under tenant A appears in fakeOutbox(A) and not in fakeOutbox(B)', async () => {
    const result = await asSystem(tenantA, () => getAdapter('email').send(message));

    expect(result.status).toBe('sent');
    expect(result.providerMessageId).toMatch(/^fake-email-/);

    const outA = fakeOutbox(tenantA);
    expect(outA).toHaveLength(1);
    expect(outA[0]).toMatchObject({
      tenantId: tenantA,
      providerMessageId: result.providerMessageId,
      personId: 'person-1',
      address: 'recipient@example.com',
      body: 'Body text',
    });
    expect(fakeOutbox(OTHER_TENANT)).toHaveLength(0);
  });

  it('a send with no tenant context is refused and recorded nowhere', async () => {
    const result = await getAdapter('email').send(message);

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no tenant context/);
    expect(result.providerMessageId).toBeUndefined();
    expect(fakeOutbox(tenantA)).toHaveLength(0);
    expect(fakeOutbox('')).toHaveLength(0);
  });

  it('the outbox keeps only the most recent 500 messages per tenant', async () => {
    const first = await asSystem(tenantA, () => getAdapter('email').send(message));
    for (let i = 0; i < 500; i += 1) {
      await asSystem(tenantA, () => getAdapter('email').send(message));
    }
    const outA = fakeOutbox(tenantA);
    expect(outA).toHaveLength(500);
    expect(outA.some((r) => r.providerMessageId === first.providerMessageId)).toBe(false);
  });

  it('fakeOutbox returns copies, so a caller cannot edit the stored record', async () => {
    await asSystem(tenantA, () => getAdapter('email').send(message));
    fakeOutbox(tenantA)[0].address = 'tampered@example.com';
    expect(fakeOutbox(tenantA)[0].address).toBe('recipient@example.com');
  });
});

describe('FakeEmailAdapter — gating', () => {
  it('is not configured, and sends are not_configured, without MARKETING_EMAIL_ADAPTER=fake', async () => {
    delete process.env.MARKETING_EMAIL_ADAPTER;
    resetAdapterCacheForTests();
    const adapter = getAdapter('email');
    expect(adapter.isConfigured()).toBe(false);

    const result = await asSystem(tenantA, () => adapter.send(message));
    expect(result.status).toBe('not_configured');
    expect(fakeOutbox(tenantA)).toHaveLength(0);
  });

  it('under NODE_ENV=production it is not configured, and a send is refused and recorded nowhere', async () => {
    process.env.NODE_ENV = 'production';
    const adapter = getAdapter('email');
    expect(adapter.isConfigured()).toBe(false);

    const result = await asSystem(tenantA, () => adapter.send(message));
    expect(result.status).toBe('not_configured');
    expect(result.error).toMatch(/production/);
    expect(result.providerMessageId).toBeUndefined();
    expect(fakeOutbox(tenantA)).toHaveLength(0);
  });
});

describe('FakeEmailAdapter — through the campaign send path', () => {
  let noticeEnsured = false;

  // Copied from marketingMessaging.test.ts (MKT-MSG-005) — the send path needs
  // a consented person and an approved template.
  async function makePerson(fullName: string, email: string) {
    return asUser(APPROVER, async (p) => {
      const recordCode = await nextRecordCode('PER');
      return prisma.person.create({
        data: {
          tenantId: p.tenantId,
          recordCode,
          fullName,
          primaryEmail: email,
          primaryEmailNormalised: email,
          primaryPhone: null,
          source: 'test',
        },
      });
    });
  }

  async function ensureMarketingPurposeNotice() {
    if (noticeEnsured) return;
    const codes = await asUser(APPROVER, async () => {
      const { currentNoticePurposeCodes } = await import('../domains/compliance/privacy.js');
      return currentNoticePurposeCodes(await tenantId());
    });
    if (!codes.has('marketing')) {
      await asUser(APPROVER, () =>
        publishNotice({
          effectiveFrom: new Date(),
          body: 'Marketing test fixture notice — covers every purpose this platform processes data for.',
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

  beforeEach(async () => {
    await ensureMarketingPurposeNotice();
  });

  it('a dispatched email lands in the outbox under the sending tenant, with the recipient address', async () => {
    const email = `fake-outbox-${Date.now()}@example.com`;
    const person = await makePerson('Fake Outbox Person', email);
    await asUser(APPROVER, () => grantConsent({ personId: person.id, purposeCode: 'marketing', channel: 'portal' }));

    const created = await asUser(CREATOR, () =>
      createTemplate({
        channelKey: 'email',
        name: `Fake outbox ${Date.now()}`,
        subject: 'Hi {{person.firstName}}',
        body: 'Hello {{person.firstName}}, {{unsubscribeUrl}}',
        language: 'en',
      } as never),
    );
    await asUser(CREATOR, () => submitForReview(created.id));
    await asUser(APPROVER, () => approveTemplate(created.id));

    const send = await asUser(CREATOR, () =>
      createSend({ templateId: created.id, channelKey: 'email', personIds: [person.id] } as never),
    );
    await asUser(CREATOR, () => requestSend(send.id));
    const dispatched = await asUser(CREATOR, () => dispatchSend(send.id));
    expect(dispatched.status).toBe('sent');

    const [recipient] = await asUser(CREATOR, () => listSendRecipients(send.id));
    expect(recipient.providerMessageId).toMatch(/^fake-email-/);

    const outbox = fakeOutbox(await tenantId());
    const record = outbox.find((r) => r.providerMessageId === recipient.providerMessageId);
    expect(record).toBeDefined();
    expect(record?.address).toBe(email);
    expect(record?.personId).toBe(person.id);
  });
});
