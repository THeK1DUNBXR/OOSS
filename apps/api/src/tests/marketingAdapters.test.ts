/**
 * Marketing channel adapters — MKT-INT.
 *
 * Pure unit tests: no database, no auth context. The adapter layer is
 * designed to be exercised in isolation from the rest of the domain, so
 * these tests construct adapters and call them directly, flipping env vars
 * between cases.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractMergeFields, renderMergeFields } from '../domains/marketing/adapters/merge.js';
import { getAdapter, adapterStatus, resetAdapterCacheForTests } from '../domains/marketing/adapters/registry.js';
import { ConsoleAdapter } from '../domains/marketing/adapters/console.js';
import { Msg91Adapter } from '../domains/marketing/adapters/msg91.js';
import { HttpEmailAdapter } from '../domains/marketing/adapters/httpEmail.js';
import { WhatsAppCloudAdapter } from '../domains/marketing/adapters/whatsappCloud.js';

const ENV_KEYS = [
  'MARKETING_EMAIL_ADAPTER',
  'MARKETING_SMS_ADAPTER',
  'MARKETING_WHATSAPP_ADAPTER',
  'MARKETING_EMAIL_API_URL',
  'MARKETING_EMAIL_API_KEY',
  'MARKETING_MSG91_AUTH_KEY',
  'MARKETING_MSG91_SENDER_ID',
  'MARKETING_WHATSAPP_PHONE_NUMBER_ID',
  'MARKETING_WHATSAPP_ACCESS_TOKEN',
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetAdapterCacheForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetAdapterCacheForTests();
});

describe('merge field rendering', () => {
  it('substitutes dotted paths from the merge data', () => {
    const result = renderMergeFields('Hi {{person.firstName}}, re: {{campaign.name}}', 'Hello {{person.firstName}}', {
      person: { firstName: 'Asha' },
      campaign: { name: 'Autumn Enrolment' },
    });
    expect(result.body).toBe('Hi Asha, re: Autumn Enrolment');
    expect(result.subject).toBe('Hello Asha');
    expect(result.missing).toEqual([]);
  });

  it('renders unknown fields as empty and reports them in missing[]', () => {
    const result = renderMergeFields('Hi {{person.firstName}}, code {{referral.code}}', undefined, {
      person: { firstName: 'Ravi' },
    });
    expect(result.body).toBe('Hi Ravi, code ');
    expect(result.missing).toEqual(['referral.code']);
  });

  it('HTML-escapes values when escape: true', () => {
    const result = renderMergeFields('Hi {{person.firstName}}', undefined, { person: { firstName: '<b>Sam</b> & co' } }, { escape: true });
    expect(result.body).toBe('Hi &lt;b&gt;Sam&lt;/b&gt; &amp; co');
  });

  it('does not escape by default (SMS/WhatsApp plain text)', () => {
    const result = renderMergeFields('Hi {{person.firstName}}', undefined, { person: { firstName: '<b>Sam</b>' } });
    expect(result.body).toBe('Hi <b>Sam</b>');
  });

  it('never executes code — a malicious-looking field is treated as a literal path', () => {
    const result = renderMergeFields('{{constructor.constructor}}', undefined, { person: { firstName: 'x' } });
    expect(result.body).toBe('');
    expect(result.missing).toEqual(['constructor.constructor']);
  });

  it('extractMergeFields lists distinct fields in first-seen order', () => {
    const fields = extractMergeFields('{{person.firstName}} {{person.lastName}} {{person.firstName}}');
    expect(fields).toEqual(['person.firstName', 'person.lastName']);
  });
});

describe('registry defaults', () => {
  it('defaults every channel to not_configured when no env is set', async () => {
    const adapter = getAdapter('email');
    expect(adapter.isConfigured()).toBe(false);
    const result = await adapter.send({ to: { personId: 'p1', address: 'a@b.com' }, body: 'hi' });
    expect(result.status).toBe('not_configured');
    expect(result.error).toMatch(/not configured/i);
  });

  it('adapterStatus reports every channel, none configured by default', () => {
    const status = adapterStatus();
    expect(status.length).toBeGreaterThan(0);
    expect(status.every((s) => s.configured === false)).toBe(true);
    const email = status.find((s) => s.channelKey === 'email');
    expect(email?.provider).toBe('NotConfiguredAdapter');
  });

  it('resetAdapterCacheForTests lets a later env change take effect', async () => {
    expect(getAdapter('email').isConfigured()).toBe(false);
    process.env.MARKETING_EMAIL_ADAPTER = 'console';
    resetAdapterCacheForTests();
    expect(getAdapter('email').isConfigured()).toBe(true);
  });
});

describe('console adapter', () => {
  it('is not configured without the env var', async () => {
    const adapter = new ConsoleAdapter('sms', 'sms');
    expect(adapter.isConfigured()).toBe(false);
    const result = await adapter.send({ to: { personId: 'p1', address: '+911234567890' }, body: 'hi' });
    expect(result.status).toBe('not_configured');
  });

  it('sends and returns a generated id when MARKETING_<KIND>_ADAPTER=console', async () => {
    process.env.MARKETING_SMS_ADAPTER = 'console';
    const adapter = new ConsoleAdapter('sms', 'sms');
    expect(adapter.isConfigured()).toBe(true);
    const result = await adapter.send({ to: { personId: 'p1', address: '+911234567890' }, body: 'hi' });
    expect(result.status).toBe('sent');
    expect(result.providerMessageId).toBeTruthy();
  });

  it('picked up via the registry when MARKETING_EMAIL_ADAPTER=console', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'console';
    resetAdapterCacheForTests();
    const adapter = getAdapter('email');
    expect(adapter).toBeInstanceOf(ConsoleAdapter);
    expect(adapter.isConfigured()).toBe(true);
  });
});

describe('msg91 adapter (India DLT)', () => {
  it('refuses to send without a dltTemplateId, even when otherwise configured', async () => {
    process.env.MARKETING_MSG91_AUTH_KEY = 'key';
    process.env.MARKETING_MSG91_SENDER_ID = 'KZNERP';
    const adapter = new Msg91Adapter();
    expect(adapter.isConfigured()).toBe(true);
    const result = await adapter.send({ to: { personId: 'p1', address: '+911234567890' }, body: 'hi' });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/dlt template/i);
  });

  it('is not_configured without auth key / sender id', async () => {
    const adapter = new Msg91Adapter();
    expect(adapter.isConfigured()).toBe(false);
    const result = await adapter.send({ to: { personId: 'p1', address: '+911234567890' }, body: 'hi', dltTemplateId: 'tpl1' });
    expect(result.status).toBe('not_configured');
  });
});

describe('whatsapp cloud adapter', () => {
  it('refuses to send without a waTemplateName, even when otherwise configured', async () => {
    process.env.MARKETING_WHATSAPP_PHONE_NUMBER_ID = '12345';
    process.env.MARKETING_WHATSAPP_ACCESS_TOKEN = 'token';
    const adapter = new WhatsAppCloudAdapter();
    expect(adapter.isConfigured()).toBe(true);
    const result = await adapter.send({ to: { personId: 'p1', address: '+911234567890' }, body: 'hi' });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/template/i);
  });
});

describe('inbound webhook parsing is defensive', () => {
  it('httpEmail returns [] on garbage payloads', () => {
    const adapter = new HttpEmailAdapter();
    expect(adapter.parseInboundWebhook(null)).toEqual([]);
    expect(adapter.parseInboundWebhook(undefined)).toEqual([]);
    expect(adapter.parseInboundWebhook('not an object')).toEqual([]);
    expect(adapter.parseInboundWebhook({})).toEqual([]);
    expect(adapter.parseInboundWebhook({ events: 'nope' })).toEqual([]);
    expect(adapter.parseInboundWebhook({ events: [{ id: 1, event: 'delivered' }] })).toEqual([]);
  });

  it('httpEmail parses a well-formed payload', () => {
    const adapter = new HttpEmailAdapter();
    const events = adapter.parseInboundWebhook({
      events: [{ id: 'msg-1', event: 'opened', timestamp: '2026-01-01T00:00:00Z' }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('opened');
    expect(events[0].providerMessageId).toBe('msg-1');
  });

  it('msg91 returns [] on garbage payloads', () => {
    const adapter = new Msg91Adapter();
    expect(adapter.parseInboundWebhook(null)).toEqual([]);
    expect(adapter.parseInboundWebhook({ foo: 'bar' })).toEqual([]);
    expect(adapter.parseInboundWebhook({ requestId: 'r1', status: 'WEIRD' })).toEqual([]);
  });

  it('whatsappCloud returns [] on garbage payloads', () => {
    const adapter = new WhatsAppCloudAdapter();
    expect(adapter.parseInboundWebhook(null)).toEqual([]);
    expect(adapter.parseInboundWebhook({ entry: 'nope' })).toEqual([]);
    expect(adapter.parseInboundWebhook({ entry: [{ changes: [{ value: {} }] }] })).toEqual([]);
  });

  it('whatsappCloud parses a well-formed payload', () => {
    const adapter = new WhatsAppCloudAdapter();
    const events = adapter.parseInboundWebhook({
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'read', timestamp: '1700000000' }] } }] }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('opened');
    expect(events[0].providerMessageId).toBe('wamid.1');
  });
});
