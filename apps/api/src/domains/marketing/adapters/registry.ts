/**
 * Adapter registry — the single place that decides, from env, which
 * ChannelAdapter backs each channel. Domain code (sends, journeys, settings)
 * calls `getAdapter(channelKey)` and never constructs an adapter itself.
 *
 * Selection env vars:
 *   MARKETING_EMAIL_ADAPTER     = 'http' | 'console'   (default: not configured)
 *   MARKETING_SMS_ADAPTER       = 'msg91' | 'console'  (default: not configured)
 *   MARKETING_WHATSAPP_ADAPTER  = 'cloud' | 'console'  (default: not configured)
 * Every other channel key (social/ads/etc.) currently has no provider
 * implementation and always resolves to NotConfiguredAdapter.
 *
 * Adapters are cached per ChannelKey once constructed (constructing an
 * adapter is cheap and side-effect-free, but the cache keeps `getAdapter`
 * returning a stable instance within a process). `resetAdapterCacheForTests`
 * clears that cache so tests can flip env vars between cases.
 */

import type { ChannelAdapter, ChannelKey, ChannelKind } from './types.js';
import { NotConfiguredAdapter } from './notConfigured.js';
import { ConsoleAdapter } from './console.js';
import { HttpEmailAdapter } from './httpEmail.js';
import { Msg91Adapter } from './msg91.js';
import { WhatsAppCloudAdapter } from './whatsappCloud.js';

/** Maps every MarketingChannel.key (registry.prisma enum) to its adapter kind. */
const CHANNEL_KIND: Record<ChannelKey, ChannelKind> = {
  email: 'email',
  sms: 'sms',
  whatsapp: 'whatsapp',
  social_meta: 'social',
  social_linkedin: 'social',
  social_youtube: 'social',
  google_ads: 'ads',
  website: 'social',
  event: 'social',
  referral: 'social',
  partner: 'social',
  print: 'social',
  walk_in: 'social',
  phone: 'social',
  other: 'social',
};

let cache = new Map<ChannelKey, ChannelAdapter>();

function buildAdapter(channelKey: ChannelKey): ChannelAdapter {
  const kind = CHANNEL_KIND[channelKey] ?? 'social';

  if (kind === 'email') {
    const selection = process.env.MARKETING_EMAIL_ADAPTER;
    if (selection === 'http') return new HttpEmailAdapter();
    if (selection === 'console') return new ConsoleAdapter(channelKey, 'email');
    return new NotConfiguredAdapter(channelKey, 'email');
  }

  if (kind === 'sms') {
    const selection = process.env.MARKETING_SMS_ADAPTER;
    if (selection === 'msg91') return new Msg91Adapter();
    if (selection === 'console') return new ConsoleAdapter(channelKey, 'sms');
    return new NotConfiguredAdapter(channelKey, 'sms');
  }

  if (kind === 'whatsapp') {
    const selection = process.env.MARKETING_WHATSAPP_ADAPTER;
    if (selection === 'cloud') return new WhatsAppCloudAdapter();
    if (selection === 'console') return new ConsoleAdapter(channelKey, 'whatsapp');
    return new NotConfiguredAdapter(channelKey, 'whatsapp');
  }

  // No provider implementations yet for social/ads channels.
  return new NotConfiguredAdapter(channelKey, kind);
}

/** Returns the configured adapter for a channel, constructing (and caching) it on first use. */
export function getAdapter(channelKey: ChannelKey): ChannelAdapter {
  const cached = cache.get(channelKey);
  if (cached) return cached;
  const adapter = buildAdapter(channelKey);
  cache.set(channelKey, adapter);
  return adapter;
}

/** For the marketing settings screen: which channels are usable and by which provider. */
export function adapterStatus(): Array<{ channelKey: ChannelKey; configured: boolean; provider: string }> {
  return (Object.keys(CHANNEL_KIND) as ChannelKey[]).map((channelKey) => {
    const adapter = getAdapter(channelKey);
    return {
      channelKey,
      configured: adapter.isConfigured(),
      provider: adapter.constructor.name,
    };
  });
}

/** Clears the adapter cache so tests can change env vars between cases. */
export function resetAdapterCacheForTests(): void {
  cache = new Map<ChannelKey, ChannelAdapter>();
}
