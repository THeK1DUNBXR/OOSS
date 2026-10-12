/**
 * FakeEmailAdapter — a built-in stand-in for the email channel that sends
 * nothing anywhere. Configured only when `MARKETING_EMAIL_ADAPTER=fake`.
 *
 * Tests use it so the campaign/send path runs end-to-end without a real
 * provider, and the sent messages can be read back from the per-tenant
 * outbox (`fakeOutbox`). It deliberately logs nothing: the bodies are
 * personal data and a test log is not a place for them.
 *
 * Refused in production. A fake that reports `sent` in production would
 * mark real recipients as delivered and lose their mail without anyone
 * noticing, so the adapter answers `not_configured` there instead, which
 * raises EX-MKT-011 for the operator.
 */

import { randomUUID } from 'node:crypto';
import type {
  ChannelAdapter,
  ChannelKey,
  InboundDeliveryEvent,
  OutboundMessage,
  RenderedMessage,
  SendResult,
} from './types.js';
import { renderMergeFields } from './merge.js';
import { maybeTenantId } from '../../../platform/context.js';

/**
 * The outbox is process-local and grows with every send. A long-running dev
 * process would otherwise accumulate every message it ever sent, so each
 * tenant keeps only the most recent records. Oldest are dropped first.
 */
const MAX_RECORDS_PER_TENANT = 500;

export interface FakeEmailRecord {
  tenantId: string;
  providerMessageId: string;
  personId: string;
  address: string;
  subject?: string;
  body: string;
  templateRef?: string;
  recordedAt: Date;
}

/** Keyed by tenant id. A record never lands under a blank or shared key. */
const outboxByTenant = new Map<string, FakeEmailRecord[]>();

const ENV_VAR = 'MARKETING_EMAIL_ADAPTER';

export class FakeEmailAdapter implements ChannelAdapter {
  readonly kind = 'email' as const;

  constructor(readonly key: ChannelKey) {}

  /**
   * Read at call time, not in the constructor: the registry caches one
   * instance per channel, so a constructor-time check would not see later
   * env changes.
   */
  isConfigured(): boolean {
    return process.env.NODE_ENV !== 'production' && process.env[ENV_VAR] === 'fake';
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (process.env.NODE_ENV === 'production') {
      return {
        status: 'not_configured',
        error: 'Fake email adapter refused: NODE_ENV=production. Configure a real email provider.',
      };
    }
    if (!this.isConfigured()) {
      return { status: 'not_configured', error: `Fake email adapter not enabled: set ${ENV_VAR}=fake` };
    }

    // Tenant comes from the request context only, never from the message.
    // Without one there is no key to file the record under, so it is refused
    // rather than recorded under a blank tenant.
    const tenantId = maybeTenantId();
    if (!tenantId) {
      return { status: 'failed', error: 'Fake email send refused: no tenant context in scope' };
    }

    const providerMessageId = `fake-email-${randomUUID()}`;
    const records = outboxByTenant.get(tenantId) ?? [];
    records.push({
      tenantId,
      providerMessageId,
      personId: msg.to.personId,
      address: msg.to.address,
      subject: msg.subject,
      body: msg.body,
      templateRef: msg.templateRef,
      recordedAt: new Date(),
    });
    if (records.length > MAX_RECORDS_PER_TENANT) {
      records.splice(0, records.length - MAX_RECORDS_PER_TENANT);
    }
    outboxByTenant.set(tenantId, records);

    return { status: 'sent', providerMessageId };
  }

  renderTemplate(body: string, subject: string | undefined, mergeData: Record<string, unknown>): RenderedMessage {
    return renderMergeFields(body, subject, mergeData, { escape: true });
  }

  parseInboundWebhook(_payload: unknown): InboundDeliveryEvent[] {
    return [];
  }
}

/** Copies of one tenant's sent messages, oldest first. Test helper. */
export function fakeOutbox(tenantId: string): FakeEmailRecord[] {
  return (outboxByTenant.get(tenantId) ?? []).map((record) => ({ ...record }));
}

/** Empties one tenant's outbox. Test helper. */
export function clearFakeOutbox(tenantId: string): void {
  outboxByTenant.delete(tenantId);
}
