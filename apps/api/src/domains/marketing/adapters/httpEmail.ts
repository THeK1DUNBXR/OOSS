/**
 * HttpEmailAdapter — a `fetch`-based email adapter for any HTTP email API
 * (a self-hosted send API, or a thin proxy in front of a provider). This
 * substitutes for a raw SMTP implementation, which is out of scope here.
 *
 * Config (env):
 *   MARKETING_EMAIL_ADAPTER=http        (selects this adapter — see registry.ts)
 *   MARKETING_EMAIL_API_URL=<url>        (required — POST endpoint)
 *   MARKETING_EMAIL_API_KEY=<key>        (required — sent as Bearer token)
 *
 * Request contract (what this adapter POSTs, as JSON):
 *   {
 *     "to": "<email address>",
 *     "subject": "<string>",
 *     "html": "<string>",          // rendered body, HTML-escaped merge fields
 *     "personId": "<string>",
 *     "templateRef": "<string?>",
 *     "metadata": { ... }           // OutboundMessage.metadata, passed through
 *   }
 *   Header: `Authorization: Bearer <MARKETING_EMAIL_API_KEY>`
 *   Header: `X-Purpose: marketing`  (per the module's fixed purpose header)
 *
 * Expected response contract (2xx): JSON body
 *   { "id": "<provider message id>" }
 * Any non-2xx, network error, or malformed response body yields
 * `{ status: 'failed', error }` — this adapter never throws.
 *
 * Inbound webhook contract assumed by parseInboundWebhook (defensive — any
 * other shape returns []):
 *   { "events": [ { "id": "<provider message id>", "event": "delivered" | "opened" |
 *       "clicked" | "bounced" | "unsubscribed" | "failed", "timestamp": "<ISO 8601>",
 *       "detail": "<string?>" } ] }
 */

import type { ChannelAdapter, InboundDeliveryEvent, OutboundMessage, RenderedMessage, SendResult } from './types.js';
import { renderMergeFields } from './merge.js';

const EVENT_KIND_MAP: Record<string, InboundDeliveryEvent['kind']> = {
  delivered: 'delivered',
  opened: 'opened',
  clicked: 'clicked',
  bounced: 'bounced',
  unsubscribed: 'unsubscribed',
  failed: 'failed',
  replied: 'replied',
};

export class HttpEmailAdapter implements ChannelAdapter {
  readonly key = 'email' as const;
  readonly kind = 'email' as const;

  isConfigured(): boolean {
    return Boolean(process.env.MARKETING_EMAIL_API_URL && process.env.MARKETING_EMAIL_API_KEY);
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.isConfigured()) {
      return {
        status: 'not_configured',
        error: 'Email sending is not configured: set MARKETING_EMAIL_API_URL and MARKETING_EMAIL_API_KEY',
      };
    }
    const url = process.env.MARKETING_EMAIL_API_URL as string;
    const apiKey = process.env.MARKETING_EMAIL_API_KEY as string;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-Purpose': 'marketing',
        },
        body: JSON.stringify({
          to: msg.to.address,
          subject: msg.subject ?? '',
          html: msg.body,
          personId: msg.to.personId,
          templateRef: msg.templateRef,
          metadata: msg.metadata,
        }),
      });

      if (!response.ok) {
        return { status: 'failed', error: `Email API returned ${response.status}` };
      }

      const data = (await response.json().catch(() => null)) as { id?: unknown } | null;
      const providerMessageId = typeof data?.id === 'string' ? data.id : undefined;
      return { status: 'sent', providerMessageId };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : 'Unknown email API error' };
    }
  }

  renderTemplate(body: string, subject: string | undefined, mergeData: Record<string, unknown>): RenderedMessage {
    return renderMergeFields(body, subject, mergeData, { escape: true });
  }

  parseInboundWebhook(payload: unknown): InboundDeliveryEvent[] {
    try {
      if (!payload || typeof payload !== 'object') return [];
      const events = (payload as Record<string, unknown>).events;
      if (!Array.isArray(events)) return [];

      const out: InboundDeliveryEvent[] = [];
      for (const raw of events) {
        if (!raw || typeof raw !== 'object') continue;
        const rec = raw as Record<string, unknown>;
        const id = rec.id;
        const eventName = rec.event;
        if (typeof id !== 'string' || typeof eventName !== 'string') continue;
        const kind = EVENT_KIND_MAP[eventName];
        if (!kind) continue;
        const timestamp = typeof rec.timestamp === 'string' ? new Date(rec.timestamp) : new Date();
        out.push({
          providerMessageId: id,
          kind,
          at: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
          detail: typeof rec.detail === 'string' ? rec.detail : undefined,
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}
