/**
 * MARKETING CHANNEL ADAPTER — the pluggable boundary between the Marketing
 * domain (campaigns, templates, sends) and the outside world (SMTP-style
 * email APIs, SMS/DLT gateways, WhatsApp Cloud API, social/ads platforms).
 *
 * The domain code never talks to a provider directly — it asks the registry
 * (`adapters/registry.ts`) for the adapter configured for a channel and calls
 * this interface. That keeps every provider's HTTP quirks, auth scheme, and
 * payload shape out of campaign/send logic, and lets a tenant run in
 * "not configured" mode (EX-MKT-011) or "console" mode (dev/tests) with zero
 * code changes elsewhere.
 */

/** Matches MarketingChannel.key in prisma/schema/marketing.prisma. */
export type ChannelKey =
  | 'email'
  | 'sms'
  | 'whatsapp'
  | 'social_meta'
  | 'social_linkedin'
  | 'social_youtube'
  | 'google_ads'
  | 'website'
  | 'event'
  | 'referral'
  | 'partner'
  | 'print'
  | 'walk_in'
  | 'phone'
  | 'other';

export type ChannelKind = 'email' | 'sms' | 'whatsapp' | 'social' | 'ads';

export interface OutboundMessage {
  to: {
    personId: string;
    /** Email address, E.164 phone number, or WhatsApp-format phone number. */
    address: string;
  };
  subject?: string;
  body: string;
  /** Reference to the MarketingTemplate this was rendered from, if any. */
  templateRef?: string;
  /** Required by msg91.ts (India DLT) for SMS sends. */
  dltTemplateId?: string;
  /** Required by whatsappCloud.ts — the approved WhatsApp template name. */
  waTemplateName?: string;
  metadata?: Record<string, unknown>;
}

export interface SendResult {
  status: 'sent' | 'failed' | 'not_configured';
  providerMessageId?: string;
  error?: string;
}

export interface RenderedMessage {
  subject?: string;
  body: string;
  /** Merge fields referenced in the template that had no value supplied. */
  missing: string[];
}

export interface InboundDeliveryEvent {
  providerMessageId: string;
  kind: 'delivered' | 'opened' | 'clicked' | 'bounced' | 'unsubscribed' | 'failed' | 'replied';
  at: Date;
  detail?: string;
}

export interface ChannelAdapter {
  key: ChannelKey;
  kind: ChannelKind;

  /** Reads its own env config; never throws. */
  isConfigured(): boolean;

  /** Sends a single message. Never throws — failures come back as SendResult. */
  send(msg: OutboundMessage): Promise<SendResult>;

  /**
   * Merge-field substitution for this channel (email may escape HTML; SMS/WA
   * do not). Delegates to merge.ts by default; a provider-specific adapter may
   * override for provider-side templating (e.g. WhatsApp named templates).
   */
  renderTemplate(body: string, subject: string | undefined, mergeData: Record<string, unknown>): RenderedMessage;

  /**
   * Maps a provider's inbound webhook payload into normalised delivery
   * events. Defensive: an unrecognised shape returns [] rather than throwing.
   */
  parseInboundWebhook?(payload: unknown): InboundDeliveryEvent[];
}
