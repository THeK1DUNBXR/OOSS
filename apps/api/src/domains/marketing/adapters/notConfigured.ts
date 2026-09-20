/**
 * NotConfiguredAdapter — the default for every channel that has no
 * `MARKETING_<KIND>_ADAPTER` env var set. It never throws: a send simply
 * comes back `not_configured` with an honest, actionable message, which is
 * what lets the caller raise EX-MKT-011 ("channel adapter not configured but
 * send requested") instead of a stack trace reaching an operator.
 */

import type { ChannelAdapter, ChannelKey, ChannelKind, InboundDeliveryEvent, OutboundMessage, RenderedMessage, SendResult } from './types.js';
import { renderMergeFields } from './merge.js';

export class NotConfiguredAdapter implements ChannelAdapter {
  constructor(
    readonly key: ChannelKey,
    readonly kind: ChannelKind,
  ) {}

  isConfigured(): boolean {
    return false;
  }

  async send(_msg: OutboundMessage): Promise<SendResult> {
    const envVar = `MARKETING_${this.kind.toUpperCase()}_ADAPTER`;
    return {
      status: 'not_configured',
      error: `${capitalize(this.kind)} sending is not configured: set ${envVar}`,
    };
  }

  renderTemplate(body: string, subject: string | undefined, mergeData: Record<string, unknown>): RenderedMessage {
    return renderMergeFields(body, subject, mergeData, { escape: this.kind === 'email' });
  }

  parseInboundWebhook(_payload: unknown): InboundDeliveryEvent[] {
    return [];
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}
