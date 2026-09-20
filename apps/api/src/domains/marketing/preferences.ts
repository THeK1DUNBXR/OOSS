/**
 * Consent & channel preferences (MKT-CON-001…). Canon: docs/plan/marketing-skeleton.md.
 *
 * Lawful basis for the `marketing` purpose is the existing `Consent` model
 * (compliance/privacy.ts, purposeCode 'marketing') — never duplicated here.
 * `MarketingPreference` is channel-level bookkeeping layered on top: which
 * channels a person has opted into, and a do-not-contact flag that overrides
 * everything regardless of consent.
 *
 * `eligibleForChannel` is the single gate messaging (sends/journeys) must call
 * before addressing anyone — it is evaluated at query time on every call,
 * never cached, so a withdrawal is honoured on the very next send.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { EVENTS, type ChannelKey } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { grantConsent, withdrawConsent, listConsentsForPerson } from '../compliance/privacy.js';
import { suppressedPersonIds } from './audiences.js';

registerGovernedEntities('mkt', ['preference']);

const MARKETING_PURPOSE = 'marketing';

// ---------------------------------------------------------------------------
// Consent (reuses the compliance Consent model — never duplicated here)
// ---------------------------------------------------------------------------

export async function recordMarketingConsent(personId: string, channel: string, evidence?: Record<string, unknown>) {
  // grantConsent already: checks the `consents:create` grant, validates the
  // purpose against the current privacy notice, writes the Consent row,
  // audits it, and emits `kz.cmp.consent.granted` — so no separate
  // `kz.mkt.consent.recorded` is emitted here (the skeleton says to emit one
  // only where the compliance domain does not already cover it; it does).
  return grantConsent({ personId, purposeCode: MARKETING_PURPOSE, channel, evidence });
}

/** Withdraws every currently-granted marketing consent row for this person. */
export async function withdrawMarketingConsent(personId: string, reason?: string) {
  const consents = await listConsentsForPerson(personId);
  const granted = consents.filter((c) => c.purposeCode === MARKETING_PURPOSE && c.status === 'granted');
  const withdrawn: Awaited<ReturnType<typeof withdrawConsent>>[] = [];
  for (const c of granted) withdrawn.push(await withdrawConsent(c.id, reason));
  return withdrawn;
}

async function currentMarketingConsent(personId: string) {
  const auth = currentAuth();
  return prisma.consent.findFirst({
    where: { tenantId: auth.tenantId, personId, purposeCode: MARKETING_PURPOSE },
    orderBy: { createdAt: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Channel preferences & do-not-contact
// ---------------------------------------------------------------------------

export async function setChannelPreference(personId: string, channelKey: string, optedIn: boolean, source = 'admin') {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_settings', verb: 'edit' });

  const recordCode = await nextRecordCode('SND'); // no dedicated prefix registered for preferences; reuses the send-series pool, distinguished by table.
  const pref = await prisma.marketingPreference.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      personId,
      channelKey,
      optedIn,
      source,
      changedAt: new Date(),
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'preference', subjectId: pref.id, after: { channelKey, optedIn } });
  await emit({
    name: EVENTS.MKT_PREFERENCE_CHANGED,
    subject: { entityType: 'preference', entityId: pref.id, recordCode },
    related: [{ relation: 'subject', entityType: 'person', entityId: personId }],
    newState: { channelKey, optedIn },
    owner: { partyId: personId },
    impact: { domains: ['mkt'] },
  });

  return pref;
}

export async function setDoNotContact(personId: string, doNotContact: boolean, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_settings', verb: 'edit' });
  if (doNotContact && !reason?.trim()) throw ApiError.badRequest('A reason is required to set do-not-contact.');

  const recordCode = await nextRecordCode('SND');
  const pref = await prisma.marketingPreference.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      personId,
      channelKey: 'all',
      optedIn: !doNotContact,
      doNotContact,
      reason: reason || null,
      changedAt: new Date(),
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'preference', subjectId: pref.id, after: { doNotContact, reason } });
  await emit({
    name: EVENTS.MKT_PREFERENCE_CHANGED,
    subject: { entityType: 'preference', entityId: pref.id, recordCode },
    related: [{ relation: 'subject', entityType: 'person', entityId: personId }],
    newState: { doNotContact },
    reason: reason ? { reasonCode: 'do_not_contact', note: reason } : null,
    owner: { partyId: personId },
    impact: { domains: ['mkt'] },
  });

  return pref;
}

/** Most recent preference row per channel — preferences are append-only history, this is the current state. */
async function currentPreferences(personId: string) {
  const auth = currentAuth();
  const rows = await prisma.marketingPreference.findMany({
    where: { tenantId: auth.tenantId, personId, deletedAt: null },
    orderBy: { changedAt: 'desc' },
  });
  const byChannel = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!byChannel.has(r.channelKey)) byChannel.set(r.channelKey, r);
  return [...byChannel.values()];
}

async function isDoNotContact(personId: string): Promise<boolean> {
  const auth = currentAuth();
  const latest = await prisma.marketingPreference.findFirst({
    where: { tenantId: auth.tenantId, personId, deletedAt: null },
    orderBy: { changedAt: 'desc' },
  });
  return latest?.doNotContact ?? false;
}

export async function getPreferences(personId: string) {
  await assertCan({ resource: 'audiences', verb: 'view' });
  const [consent, channels, doNotContact] = await Promise.all([
    currentMarketingConsent(personId),
    currentPreferences(personId),
    isDoNotContact(personId),
  ]);

  return {
    personId,
    consent: consent
      ? { status: consent.status, purposeCode: consent.purposeCode, recordedAt: consent.grantedAt, channel: consent.channel, evidence: consent.evidence }
      : null,
    channels,
    doNotContact,
  };
}

// ---------------------------------------------------------------------------
// Coverage — the H_MKT "consent coverage of contacted people" factor
// ---------------------------------------------------------------------------

export async function consentCoverage() {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_analytics', verb: 'view' });

  const contactedRows = await prisma.marketingSendRecipient.findMany({
    where: { tenantId: auth.tenantId, status: { in: ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'unsubscribed'] } },
    select: { personId: true },
    distinct: ['personId'],
  });
  const contactedIds = contactedRows.map((r) => r.personId);
  const contacted = contactedIds.length;

  if (contacted === 0) return { contacted: 0, consented: 0, missing: 0, measured: false };

  const consented = await prisma.consent.count({
    where: { tenantId: auth.tenantId, personId: { in: contactedIds }, purposeCode: MARKETING_PURPOSE, status: 'granted' },
  });

  return { contacted, consented, missing: contacted - consented, measured: true };
}

// ---------------------------------------------------------------------------
// The send-time gate — every send/journey must call this before addressing
// anyone, and never cache the result.
// ---------------------------------------------------------------------------

export interface EligibilitySkip {
  personId: string;
  reason: 'no_consent' | 'dnc' | 'opted_out' | 'suppressed' | 'no_address';
}

export async function eligibleForChannel(personIds: string[], channelKey: ChannelKey | string): Promise<{ eligible: string[]; skipped: EligibilitySkip[] }> {
  const auth = currentAuth();
  if (!personIds.length) return { eligible: [], skipped: [] };

  const [consents, prefs, people, suppressed] = await Promise.all([
    prisma.consent.findMany({
      where: { tenantId: auth.tenantId, personId: { in: personIds }, purposeCode: MARKETING_PURPOSE, status: 'granted' },
      select: { personId: true },
    }),
    prisma.marketingPreference.findMany({
      where: { tenantId: auth.tenantId, personId: { in: personIds }, deletedAt: null },
      orderBy: { changedAt: 'desc' },
    }),
    prisma.person.findMany({ where: { tenantId: auth.tenantId, id: { in: personIds } }, select: { id: true, primaryEmail: true, primaryPhone: true } }),
    suppressedPersonIds(),
  ]);

  const consentedIds = new Set(consents.map((c) => c.personId));
  const peopleById = new Map(people.map((p) => [p.id, p]));

  // Latest row per (person, channel) and latest row per person for DNC.
  const latestByPersonChannel = new Map<string, (typeof prefs)[number]>();
  const latestByPerson = new Map<string, (typeof prefs)[number]>();
  for (const p of prefs) {
    const key = `${p.personId}:${p.channelKey}`;
    if (!latestByPersonChannel.has(key)) latestByPersonChannel.set(key, p);
    if (!latestByPerson.has(p.personId)) latestByPerson.set(p.personId, p);
  }

  const eligible: string[] = [];
  const skipped: EligibilitySkip[] = [];

  for (const personId of personIds) {
    if (suppressed.has(personId)) {
      skipped.push({ personId, reason: 'suppressed' });
      continue;
    }
    if (latestByPerson.get(personId)?.doNotContact) {
      skipped.push({ personId, reason: 'dnc' });
      continue;
    }
    if (!consentedIds.has(personId)) {
      skipped.push({ personId, reason: 'no_consent' });
      continue;
    }
    const channelPref = latestByPersonChannel.get(`${personId}:${channelKey}`);
    if (channelPref && !channelPref.optedIn) {
      skipped.push({ personId, reason: 'opted_out' });
      continue;
    }
    const person = peopleById.get(personId);
    const needsEmail = channelKey === 'email';
    const needsPhone = ['sms', 'whatsapp', 'phone'].includes(channelKey as string);
    if ((needsEmail && !person?.primaryEmail) || (needsPhone && !person?.primaryPhone)) {
      skipped.push({ personId, reason: 'no_address' });
      continue;
    }
    eligible.push(personId);
  }

  return { eligible, skipped };
}

// ---------------------------------------------------------------------------
// Unsubscribe tokens — the public, no-auth unsubscribe link
// ---------------------------------------------------------------------------

function unsubscribeSecret(): string {
  return process.env.MARKETING_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || 'dev-secret-change-me';
}

/** HMAC-SHA256 over the personId — stable, non-expiring, never reversible. */
export function unsubscribeToken(personId: string): string {
  return createHmac('sha256', unsubscribeSecret()).update(personId).digest('hex');
}

function tokenMatches(personId: string, token: string): boolean {
  const expected = Buffer.from(unsubscribeToken(personId), 'hex');
  let given: Buffer;
  try {
    given = Buffer.from(token, 'hex');
  } catch {
    return false;
  }
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Resolves and withdraws by token alone — the caller (public route) has no
 * auth context and no personId; every person in the tenant is checked against
 * the token's HMAC. Runs as the caller's own request context (a system
 * context supplied by the public route), never requiring a signed-in user.
 */
export async function withdrawByToken(token: string): Promise<{ personId: string } | null> {
  const auth = currentAuth();
  // A full table scan of Person is wasteful at scale; in practice the caller
  // narrows this from a recent-recipient list before falling back here. For
  // correctness first: check consented people first (the only ones a token
  // withdrawal can meaningfully act on).
  const candidates = await prisma.consent.findMany({
    where: { tenantId: auth.tenantId, purposeCode: MARKETING_PURPOSE, status: 'granted' },
    select: { personId: true },
    distinct: ['personId'],
  });

  for (const { personId } of candidates) {
    if (tokenMatches(personId, token)) {
      await withdrawMarketingConsent(personId, 'unsubscribe_link');
      await setDoNotContactSystem(personId, 'unsubscribe_link');
      return { personId };
    }
  }
  return null;
}

/** Internal: do-not-contact set from the unsubscribe link itself, bypassing the `marketing_settings:edit` grant a public route holds no principal for. */
async function setDoNotContactSystem(personId: string, reason: string) {
  const auth = currentAuth();
  const recordCode = await nextRecordCode('SND');
  await prisma.marketingPreference.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      personId,
      channelKey: 'all',
      optedIn: false,
      doNotContact: true,
      reason,
      changedAt: new Date(),
    },
  });
}
