/**
 * Msg91Adapter — SMS via MSG91 (India), DLT-aware.
 *
 * India's DLT (Distributed Ledger Technology) regime requires every
 * transactional/promotional SMS to carry a registered DLT template id and be
 * sent from a registered sender id — untemplated sends are rejected by
 * carriers, and using a template before it is registered/approved is
 * EX-MKT-009. This adapter therefore REFUSES to send (status: 'failed',
 * never throws) when `dltTemplateId` is missing, or when no sender id is
 * configured.
 *
 * Config (env):
 *   MARKETING_SMS_ADAPTER=msg91
 *   MARKETING_MSG91_AUTH_KEY=<key>        (required)
 *   MARKETING_MSG91_SENDER_ID=<6-char id> (required — the registered DLT sender id)
 *   MARKETING_MSG91_BASE_URL=<url>        (optional, defaults to the MSG91 API host)
 *
 * Request contract: POST {base}/api/v5/flow/ as JSON:
 *   {
 *     "template_id": "<dltTemplateId>",
 *     "sender": "<MARKETING_MSG91_SENDER_ID>",
 *     "short_url": "0",
 *     "recipients": [ { "mobiles": "<address>", ... mergeData flattened as vars } ]
 *   }
 *   Header: `authkey: <MARKETING_MSG91_AUTH_KEY>`, `X-Purpose: marketing`.
 *
 * Expected response contract (2xx): JSON body `{ "type": "success", "message": "<request id>" }`.
 * Any non-2xx, `type !== "success"`, network error, or malformed body yields
 * `{ status: 'failed', error }`.
 *
 * Inbound webhook contract assumed by parseInboundWebhook (defensive):
 *   { "requestId": "<provider message id>", "status": "DELIVERED" | "FAILED" | "SENT",
 *     "date": "<ISO 8601>" }
 * MSG91 delivery callbacks report delivery/failure only (no open/click for SMS).
 */

import type { ChannelAdapter, InboundDeliveryEvent, OutboundMessage, RenderedMessage, SendResult } from './types.js';
import { renderMergeFields } from './merge.js';

const DEFAULT_BASE_URL = 'https://control.msg91.com';

const STATUS_MAP: Record<string, InboundDeliveryEvent['kind']> = {
  DELIVERED: 'delivered',
  SENT: 'delivered',
  FAILED: 'failed',
  UNDELIVERED: 'failed',
};

export class Msg91Adapter implements ChannelAdapter {
  readonly key = 'sms' as const;
  readonly kind = 'sms' as const;

  isConfigured(): boolean {
    return Boolean(process.env.MARKETING_MSG91_AUTH_KEY && process.env.MARKETING_MSG91_SENDER_ID);
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.isConfigured()) {
      return {
        status: 'not_configured',
        error: 'SMS sending is not configured: set MARKETING_MSG91_AUTH_KEY and MARKETING_MSG91_SENDER_ID',
      };
    }

    // DLT compliance gate — refuse rather than send an un-templated / spam-flagged SMS.
    if (!msg.dltTemplateId) {
      return {
        status: 'failed',
        error: 'DLT template id is required for SMS sends in India (dltTemplateId missing) — see EX-MKT-009',
      };
    }

    const authKey = process.env.MARKETING_MSG91_AUTH_KEY as string;
    const senderId = process.env.MARKETING_MSG91_SENDER_ID as string;
    const baseUrl = process.env.MARKETING_MSG91_BASE_URL ?? DEFAULT_BASE_URL;

    try {
      const response = await fetch(`${baseUrl}/api/v5/flow/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authkey: authKey,
          'X-Purpose': 'marketing',
        },
        body: JSON.stringify({
          template_id: msg.dltTemplateId,
          sender: senderId,
          short_url: '0',
          recipients: [
            {
              mobiles: msg.to.address,
              ...(msg.metadata ?? {}),
            },
          ],
        }),
      });

      if (!response.ok) {
        return { status: 'failed', error: `MSG91 API returned ${response.status}` };
      }

      const data = (await response.json().catch(() => null)) as { type?: unknown; message?: unknown } | null;
      if (data?.type !== 'success') {
        return { status: 'failed', error: typeof data?.message === 'string' ? data.message : 'MSG91 send failed' };
      }
      const providerMessageId = typeof data.message === 'string' ? data.message : undefined;
      return { status: 'sent', providerMessageId };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : 'Unknown MSG91 error' };
    }
  }

  renderTemplate(body: string, subject: string | undefined, mergeData: Record<string, unknown>): RenderedMessage {
    return renderMergeFields(body, subject, mergeData, { escape: false });
  }

  parseInboundWebhook(payload: unknown): InboundDeliveryEvent[] {
    try {
      if (!payload || typeof payload !== 'object') return [];
      const rec = payload as Record<string, unknown>;
      const id = rec.requestId;
      const statusRaw = rec.status;
      if (typeof id !== 'string' || typeof statusRaw !== 'string') return [];
      const kind = STATUS_MAP[statusRaw.toUpperCase()];
      if (!kind) return [];
      const timestamp = typeof rec.date === 'string' ? new Date(rec.date) : new Date();
      return [
        {
          providerMessageId: id,
          kind,
          at: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
        },
      ];
    } catch {
      return [];
    }
  }
}
