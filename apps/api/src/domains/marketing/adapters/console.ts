/**
 * ConsoleAdapter — a dev/test stand-in for any channel. Configured only when
 * `MARKETING_<KIND>_ADAPTER=console` is set (e.g. `MARKETING_EMAIL_ADAPTER=console`).
 * It logs the outbound message to stdout and returns a fabricated
 * provider message id, so campaign/send flows can be exercised end-to-end
 * without a real provider account.
 *
 * It never runs in production, whatever the env var says. The body is the
 * message itself, which carries personal data, and stdout in a production
 * container ends up in log shipping that no tenant agreed to.
 */

import { randomUUID } from 'node:crypto';
import type {
  ChannelAdapter,
  ChannelKey,
  ChannelKind,
  InboundDeliveryEvent,
  OutboundMessage,
  RenderedMessage,
  SendResult,
} from './types.js';
import { renderMergeFields } from './merge.js';

function envVarFor(kind: ChannelKind): string {
  return `MARKETING_${kind.toUpperCase()}_ADAPTER`;
}

export class ConsoleAdapter implements ChannelAdapter {
  constructor(
    readonly key: ChannelKey,
    readonly kind: ChannelKind,
  ) {}

  /**
   * NODE_ENV is read here rather than from `config` (platform/config.ts): that
   * object is parsed once at import, so a process that changes NODE_ENV after
   * boot — a test, mainly — would not see it. Same source, read at call time.
   */
  isConfigured(): boolean {
    if (process.env.NODE_ENV === 'production') return false;
    return process.env[envVarFor(this.kind)] === 'console';
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (process.env.NODE_ENV === 'production') {
      return {
        status: 'not_configured',
        error: 'Console adapter refused: NODE_ENV is production, and this adapter would print message bodies to stdout',
      };
    }
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
