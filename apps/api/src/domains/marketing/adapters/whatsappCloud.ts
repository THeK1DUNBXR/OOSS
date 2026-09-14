/**
 * WhatsAppCloudAdapter — Meta's WhatsApp Cloud API.
 *
 * Outside a user-initiated 24-hour session window, WhatsApp requires an
 * approved message TEMPLATE (name + language) rather than free-form body
 * text; tracking whether a given recipient is inside that window is the
 * CALLER's concern (MarketingSendRecipient / journey state), not this
 * adapter's — this adapter only refuses to send a template message without a
 * template name, mirroring EX-MKT-009 (template used before
 * registration/approval is a separate governance check upstream).
 *
 * Config (env):
 *   MARKETING_WHATSAPP_ADAPTER=cloud
 *   MARKETING_WHATSAPP_PHONE_NUMBER_ID=<id>   (required)
 *   MARKETING_WHATSAPP_ACCESS_TOKEN=<token>   (required)
 *   MARKETING_WHATSAPP_API_VERSION=<v>        (optional, default "v19.0")
 *   MARKETING_WHATSAPP_LANGUAGE=<code>        (optional, default "en")
 *
 * Request contract: POST https://graph.facebook.com/{version}/{phoneNumberId}/messages
 *   {
 *     "messaging_product": "whatsapp",
 *     "to": "<address>",
 *     "type": "template",
 *     "template": {
 *       "name": "<waTemplateName>",
 *       "language": { "code": "<MARKETING_WHATSAPP_LANGUAGE>" },
 *       "components": [ { "type": "body", "parameters": [ ...mergeData values as {type:"text",text} ] } ]
 *     }
 *   }
 *   Header: `Authorization: Bearer <MARKETING_WHATSAPP_ACCESS_TOKEN>`, `X-Purpose: marketing`.
 *
 * Expected response contract (2xx): `{ "messages": [ { "id": "<wamid>" } ] }`.
 * Any non-2xx, network error, or malformed body yields `{ status: 'failed', error }`.
 *
 * Inbound webhook contract assumed by parseInboundWebhook (Meta's actual
 * webhook shape, matched defensively — anything else returns []):
 *   { "entry": [ { "changes": [ { "value": { "statuses": [
 *       { "id": "<wamid>", "status": "sent"|"delivered"|"read"|"failed", "timestamp": "<unix seconds>" }
 *   ] } } ] } ] }
 * "read" maps to 'opened'; WhatsApp has no click-tracking primitive of its
 * own, so 'clicked' is never produced from this payload shape.
 */

import type { ChannelAdapter, InboundDeliveryEvent, OutboundMessage, RenderedMessage, SendResult } from './types.js';
import { renderMergeFields } from './merge.js';

const DEFAULT_API_VERSION = 'v19.0';
const DEFAULT_LANGUAGE = 'en';

const STATUS_MAP: Record<string, InboundDeliveryEvent['kind']> = {
  sent: 'delivered',
  delivered: 'delivered',
  read: 'opened',
  failed: 'failed',
};

export class WhatsAppCloudAdapter implements ChannelAdapter {
  readonly key = 'whatsapp' as const;
  readonly kind = 'whatsapp' as const;

  isConfigured(): boolean {
    return Boolean(process.env.MARKETING_WHATSAPP_PHONE_NUMBER_ID && process.env.MARKETING_WHATSAPP_ACCESS_TOKEN);
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.isConfigured()) {
      return {
        status: 'not_configured',
        error:
          'WhatsApp sending is not configured: set MARKETING_WHATSAPP_PHONE_NUMBER_ID and MARKETING_WHATSAPP_ACCESS_TOKEN',
      };
    }

    if (!msg.waTemplateName) {
      return {
        status: 'failed',
        error: 'A registered WhatsApp template name (waTemplateName) is required to send outside the 24h session window',
      };
    }

    const phoneNumberId = process.env.MARKETING_WHATSAPP_PHONE_NUMBER_ID as string;
    const accessToken = process.env.MARKETING_WHATSAPP_ACCESS_TOKEN as string;
    const apiVersion = process.env.MARKETING_WHATSAPP_API_VERSION ?? DEFAULT_API_VERSION;
    const language = process.env.MARKETING_WHATSAPP_LANGUAGE ?? DEFAULT_LANGUAGE;

    try {
      const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Purpose': 'marketing',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: msg.to.address,
          type: 'template',
          template: {
            name: msg.waTemplateName,
            language: { code: language },
            components: buildComponents(msg.metadata),
          },
        }),
      });

      if (!response.ok) {
        return { status: 'failed', error: `WhatsApp Cloud API returned ${response.status}` };
      }

      const data = (await response.json().catch(() => null)) as { messages?: Array<{ id?: unknown }> } | null;
      const providerMessageId =
        Array.isArray(data?.messages) && typeof data.messages[0]?.id === 'string' ? (data.messages[0].id as string) : undefined;
      return { status: 'sent', providerMessageId };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : 'Unknown WhatsApp Cloud API error' };
    }
  }

  renderTemplate(body: string, subject: string | undefined, mergeData: Record<string, unknown>): RenderedMessage {
    return renderMergeFields(body, subject, mergeData, { escape: false });
  }

  parseInboundWebhook(payload: unknown): InboundDeliveryEvent[] {
    try {
      if (!payload || typeof payload !== 'object') return [];
      const entries = (payload as Record<string, unknown>).entry;
      if (!Array.isArray(entries)) return [];

      const out: InboundDeliveryEvent[] = [];
      for (const entry of entries) {
        const changes = (entry as Record<string, unknown> | null)?.changes;
        if (!Array.isArray(changes)) continue;
        for (const change of changes) {
          const statuses = (change as Record<string, unknown> | null)?.value as Record<string, unknown> | undefined;
          const statusList = statuses?.statuses;
          if (!Array.isArray(statusList)) continue;
          for (const s of statusList) {
            const rec = s as Record<string, unknown>;
            const id = rec.id;
            const statusRaw = rec.status;
            if (typeof id !== 'string' || typeof statusRaw !== 'string') continue;
            const kind = STATUS_MAP[statusRaw.toLowerCase()];
            if (!kind) continue;
            const ts = rec.timestamp;
            const at =
              typeof ts === 'string' || typeof ts === 'number'
                ? new Date(Number(ts) * 1000)
                : new Date();
            out.push({ providerMessageId: id, kind, at: Number.isNaN(at.getTime()) ? new Date() : at });
          }
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}

function buildComponents(metadata: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  if (!metadata || Object.keys(metadata).length === 0) return [];
  const parameters = Object.values(metadata).map((value) => ({ type: 'text', text: String(value) }));
  return [{ type: 'body', parameters }];
}
