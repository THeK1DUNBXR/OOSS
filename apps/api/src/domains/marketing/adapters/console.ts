/**
 * ConsoleAdapter — a dev/test stand-in for any channel. Configured only when
 * `MARKETING_<KIND>_ADAPTER=console` is set (e.g. `MARKETING_EMAIL_ADAPTER=console`).
 * It logs the outbound message to stdout and returns a fabricated
 * provider message id, so campaign/send flows can be exercised end-to-end
 * without a real provider account.
 */

import { randomUUID } from 'node:crypto';
import type { ChannelAdapter, ChannelKey, ChannelKind, InboundDeliveryEvent, OutboundMessage, RenderedMessage, SendResult } from './types.js';
import { renderMergeFields } from './merge.js';

function envVarFor(kind: ChannelKind): string {
  return `MARKETING_${kind.toUpperCase()}_ADAPTER`;
}

export class ConsoleAdapter implements ChannelAdapter {
  constructor(
    readonly key: ChannelKey,
    readonly kind: ChannelKind,
  ) {}

  isConfigured(): boolean {
    return process.env[envVarFor(this.kind)] === 'console';
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.isConfigured()) {
      return { status: 'not_configured', error: `Console adapter not enabled: set ${envVarFor(this.kind)}=console` };
    }
    const providerMessageId = `console-${this.kind}-${randomUUID()}`;
    // eslint-disable-next-line no-console
    console.log(`[marketing:console:${this.kind}] -> ${msg.to.address}`, {
      providerMessageId,
      subject: msg.subject,
      body: msg.body,
      templateRef: msg.templateRef,
    });
    return { status: 'sent', providerMessageId };
  }

  renderTemplate(body: string, subject: string | undefined, mergeData: Record<string, unknown>): RenderedMessage {
    return renderMergeFields(body, subject, mergeData, { escape: this.kind === 'email' });
  }

  parseInboundWebhook(_payload: unknown): InboundDeliveryEvent[] {
    return [];
  }
}
