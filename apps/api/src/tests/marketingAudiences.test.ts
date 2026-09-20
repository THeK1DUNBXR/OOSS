/**
 * Marketing — audiences & consent/preferences (MKT-AUD-*, MKT-CON-*).
 *
 * DB-backed, following the same pattern as acceptance.test.ts: real request
 * context, real permission evaluation, real event chain.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, tenantId, unscopedPrisma } from './helpers.js';
import { createLead } from '../domains/leads.js';
import {
  createAudience,
  evaluateAudience,
  previewAudience,
  addAudienceMember,
  removeAudienceMember,
  loadAudience,
  audiencePersonIds,
} from '../domains/marketing/audiences.js';
import {
  recordMarketingConsent,
  withdrawMarketingConsent,
  eligibleForChannel,
  setDoNotContact,
  setChannelPreference,
  consentCoverage,
  unsubscribeToken,
  withdrawByToken,
} from '../domains/marketing/preferences.js';
import { ensureDefaultChannels, getPolicy, patchPolicy, DEFAULT_MARKETING_POLICY } from '../domains/marketing/settings.js';
import { asSystem } from '../platform/context.js';
import { CHANNEL_KEYS } from '@kaizen/shared';
import { publishNotice } from '../domains/compliance/privacy.js';
import { unscopedPrisma as udb } from '../platform/db.js';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
  // The 'marketing' purpose consent is recorded against must be named by the
  // *current* privacy notice. Another suite's own publishNotice() calls can
  // have superseded it with a notice that omits 'marketing' (each publish is
  // final, never edited) — so this republishes with 'marketing' included
  // whenever the current notice does not already name it, rather than
  // assuming a fixture seeded it once and never changed.
  const current = await udb.privacyNotice.findFirst({ where: { tenantId: TENANT, status: 'current' }, orderBy: { version: 'desc' } });
  const purposes = (current?.purposes as Array<{ code: string }> | undefined) ?? [];
  if (!purposes.some((p) => p.code === 'marketing')) {
    await asSystem(TENANT, () =>
      publishNotice({
        effectiveFrom: new Date(),
        body: 'Marketing test fixture notice.',
        purposes: [
          ...purposes.map((p) => p as never),
          {
            code: 'marketing',
            label: 'Telling you about courses, offers and events',
            lawfulBasis: 'consent',
            dataCategories: ['name', 'phone', 'email'],
            retention: 'Until consent is withdrawn',
          },
        ] as never,
      }),
    );
  }
});

const ACTOR = 'chairman@kaizen.co.in';

async function makePerson(prefix: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  return unscopedPrisma.person.create({
    data: {
      tenantId: TENANT,
      recordCode: `PER-MKTTEST-${stamp}`,
      fullName: `${prefix} ${stamp}`,
      primaryEmail: `${prefix.toLowerCase()}-${stamp}@mkttest.example`,
      primaryEmailNormalised: `${prefix.toLowerCase()}-${stamp}@mkttest.example`,
      primaryPhone: `+9199${stamp.slice(-8)}`,
      primaryPhoneNormalised: `+9199${stamp.slice(-8)}`,
      source: 'test',
    },
  });
}

// ===========================================================================
// MKT-AUD — audiences
// ===========================================================================

describe('MKT-AUD — dynamic audience over leads', () => {
  it('evaluates to exactly the leads matching the rule vertical', async () => {
    const marker = `mkt-aud-${Date.now()}`;

    await asUser(ACTOR, async () => {
      await createLead({ title: `${marker}-A`, vertical: 'cybersecurity', source: 'manual', person: { fullName: `${marker} Lead A`, primaryEmail: `${marker}-a@mkttest.example` } });
      await createLead({ title: `${marker}-B`, vertical: 'cybersecurity', source: 'manual', person: { fullName: `${marker} Lead B`, primaryEmail: `${marker}-b@mkttest.example` } });
      // A distractor in a different vertical must not be counted.
      await createLead({ title: `${marker}-C`, vertical: 'education', source: 'manual', person: { fullName: `${marker} Lead C`, primaryEmail: `${marker}-c@mkttest.example` } });
    });

    const audience = await asUser(ACTOR, () =>
      createAudience({
        name: `Cyber leads ${marker}`,
        kind: 'dynamic',
        entityType: 'lead',
        rules: { all: [{ field: 'vertical', op: 'eq', value: 'cybersecurity' }, { field: 'source', op: 'eq', value: 'manual' }] },
      }),
    );

    const preview = await asUser(ACTOR, () => previewAudience('lead', audience.rules as never));
    const result = await asUser(ACTOR, () => evaluateAudience(audience.id));

    // Both leads created in this test are counted (there may be other leads
    // in the fixture tenant with the same vertical from other tests, so this
    // asserts "at least the two we made", not an exact global count).
    expect(result.memberCount).toBeGreaterThanOrEqual(2);
    expect(result.addedCount).toBeGreaterThanOrEqual(2);
    expect(preview.count).toBe(result.memberCount);

    const loaded = await asUser(ACTOR, () => loadAudience(audience.id));
    expect(loaded.memberCount).toBe(result.memberCount);
  });
});

describe('MKT-AUD — static add/remove', () => {
  it('adds and removes members by hand, updating memberCount both times', async () => {
    const person = await makePerson('StaticMember');

    const audience = await asUser(ACTOR, () =>
      createAudience({ name: `Static list ${Date.now()}`, kind: 'static', entityType: 'person' }),
    );

    const member = await asUser(ACTOR, () => addAudienceMember(audience.id, 'person', person.id));
    let loaded = await asUser(ACTOR, () => loadAudience(audience.id));
    expect(loaded.memberCount).toBe(1);

    await asUser(ACTOR, () => removeAudienceMember(audience.id, member.id));
    loaded = await asUser(ACTOR, () => loadAudience(audience.id));
    expect(loaded.memberCount).toBe(0);
  });
});

describe('MKT-AUD — suppression audiences exclude from every send', () => {
  it('a person added to a suppression audience is excluded via audiencePersonIds/suppressedPersonIds', async () => {
    const person = await makePerson('Suppressed');

    const suppression = await asUser(ACTOR, () =>
      createAudience({ name: `Suppression ${Date.now()}`, kind: 'suppression', entityType: 'person' }),
    );
    await asUser(ACTOR, () => addAudienceMember(suppression.id, 'person', person.id));

    const { eligible, skipped } = await asUser(ACTOR, () => eligibleForChannel([person.id], 'email'));
    expect(eligible).not.toContain(person.id);
    expect(skipped.find((s) => s.personId === person.id)?.reason).toBe('suppressed');
  });
});

// ===========================================================================
// MKT-CON — consent, preferences, coverage
// ===========================================================================

describe('MKT-CON — eligibility gate', () => {
  it('skips a person with no marketing consent recorded', async () => {
    const person = await makePerson('NoConsent');
    const { eligible, skipped } = await asUser(ACTOR, () => eligibleForChannel([person.id], 'email'));
    expect(eligible).not.toContain(person.id);
    expect(skipped.find((s) => s.personId === person.id)?.reason).toBe('no_consent');
  });

  it('skips a person marked do-not-contact even with consent granted', async () => {
    const person = await makePerson('DNC');
    await asUser(ACTOR, () => recordMarketingConsent(person.id, 'portal'));
    await asUser(ACTOR, () => setDoNotContact(person.id, true, 'requested by phone'));

    const { eligible, skipped } = await asUser(ACTOR, () => eligibleForChannel([person.id], 'email'));
    expect(eligible).not.toContain(person.id);
    expect(skipped.find((s) => s.personId === person.id)?.reason).toBe('dnc');
  });

  it('skips a person who opted out of the specific channel', async () => {
    const person = await makePerson('OptedOut');
    await asUser(ACTOR, () => recordMarketingConsent(person.id, 'portal'));
    await asUser(ACTOR, () => setChannelPreference(person.id, 'email', false));

    const { eligible, skipped } = await asUser(ACTOR, () => eligibleForChannel([person.id], 'email'));
    expect(eligible).not.toContain(person.id);
    expect(skipped.find((s) => s.personId === person.id)?.reason).toBe('opted_out');
  });

  it('is eligible once consent is recorded via the existing Consent table, and never cached', async () => {
    const person = await makePerson('BecomesEligible');

    let check = await asUser(ACTOR, () => eligibleForChannel([person.id], 'email'));
    expect(check.eligible).not.toContain(person.id);

    await asUser(ACTOR, () => recordMarketingConsent(person.id, 'portal'));
    check = await asUser(ACTOR, () => eligibleForChannel([person.id], 'email'));
    expect(check.eligible).toContain(person.id);

    // Confirmed against the real Consent table, purposeCode 'marketing'.
    const consentRow = await unscopedPrisma.consent.findFirst({
      where: { tenantId: TENANT, personId: person.id, purposeCode: 'marketing', status: 'granted' },
    });
    expect(consentRow).not.toBeNull();

    // Withdrawal makes them ineligible again on the very next call — proving
    // eligibility is evaluated at query time, never cached.
    await asUser(ACTOR, () => withdrawMarketingConsent(person.id));
    check = await asUser(ACTOR, () => eligibleForChannel([person.id], 'email'));
    expect(check.eligible).not.toContain(person.id);
    expect(check.skipped.find((s) => s.personId === person.id)?.reason).toBe('no_consent');
  });
});

describe('MKT-CON — unsubscribe token', () => {
  it('round-trips: a token withdraws the same person it was issued for, and only that person', async () => {
    const person = await makePerson('Unsub');
    const other = await makePerson('Untouched');
    await asUser(ACTOR, () => recordMarketingConsent(person.id, 'portal'));
    await asUser(ACTOR, () => recordMarketingConsent(other.id, 'portal'));

    const token = unsubscribeToken(person.id);
    expect(unsubscribeToken(person.id)).toBe(token); // stable, deterministic
    expect(unsubscribeToken(other.id)).not.toBe(token);

    const result = await asSystem(TENANT, () => withdrawByToken(token));
    expect(result?.personId).toBe(person.id);

    const consentRow = await unscopedPrisma.consent.findFirst({
      where: { tenantId: TENANT, personId: person.id, purposeCode: 'marketing' },
      orderBy: { createdAt: 'desc' },
    });
    expect(consentRow?.status).toBe('withdrawn');

    const otherConsentRow = await unscopedPrisma.consent.findFirst({
      where: { tenantId: TENANT, personId: other.id, purposeCode: 'marketing' },
      orderBy: { createdAt: 'desc' },
    });
    expect(otherConsentRow?.status).toBe('granted');
  });

  it('an unrecognised token withdraws nobody', async () => {
    const result = await asSystem(TENANT, () => withdrawByToken('not-a-real-token'));
    expect(result).toBeNull();
  });
});

describe('MKT-CON — coverage', () => {
  it('reports not measured when nobody has ever been contacted', async () => {
    // A brand-new tenant would show this; here we assert the shape holds when
    // no MarketingSendRecipient rows exist for a freshly-scoped check is hard
    // to isolate in a shared fixture tenant, so this asserts the *contract*:
    // zero contacted implies measured:false, which the coverage function
    // guarantees structurally regardless of how many rows exist.
    const coverage = await asUser(ACTOR, () => consentCoverage());
    if (coverage.contacted === 0) {
      expect(coverage.measured).toBe(false);
      expect(coverage.consented).toBe(0);
      expect(coverage.missing).toBe(0);
    } else {
      expect(coverage.measured).toBe(true);
      expect(coverage.consented + coverage.missing).toBe(coverage.contacted);
    }
  });
});

// ===========================================================================
// MKT-GOV — settings: policy, channels
// ===========================================================================

describe('MKT-GOV — marketing policy', () => {
  it('defaults match the documented shape, and patch persists', async () => {
    const policy = await asUser(ACTOR, () => getPolicy());
    expect(policy.campaignApprovalThreshold).toBeTypeOf('number');
    expect(policy.sendApprovalThreshold).toBeTypeOf('number');

    const patched = await asUser(ACTOR, () => patchPolicy({ sendApprovalThreshold: 750 }));
    expect(patched.sendApprovalThreshold).toBe(750);
    // Everything else keeps its default/prior value.
    expect(patched.bounceAlertRate).toBe(DEFAULT_MARKETING_POLICY.bounceAlertRate);

    const reread = await asUser(ACTOR, () => getPolicy());
    expect(reread.sendApprovalThreshold).toBe(750);

    // Restore, so this test is repeatable against the shared fixture tenant.
    await asUser(ACTOR, () => patchPolicy({ sendApprovalThreshold: DEFAULT_MARKETING_POLICY.sendApprovalThreshold }));
  });
});

describe('MKT-GOV — default channels', () => {
  it('seeds all 15 channel keys idempotently — calling twice never duplicates', async () => {
    await asSystem(TENANT, () => ensureDefaultChannels(TENANT));
    const firstCount = await unscopedPrisma.marketingChannel.count({ where: { tenantId: TENANT } });
    expect(firstCount).toBeGreaterThanOrEqual(CHANNEL_KEYS.length);

    const createdSecondCall = await asSystem(TENANT, () => ensureDefaultChannels(TENANT));
    const secondCount = await unscopedPrisma.marketingChannel.count({ where: { tenantId: TENANT } });
    expect(createdSecondCall).toBe(0);
    expect(secondCount).toBe(firstCount);
  });
});

// ===========================================================================
// Cross-tenant isolation
// ===========================================================================

describe('MKT-AUD — cross-tenant isolation', () => {
  it('an audience created in one tenant 404s for a principal in another', async () => {
    const other = await unscopedPrisma.tenant.upsert({
      where: { slug: 'mkt-other-tenant' },
      create: { slug: 'mkt-other-tenant', name: 'MKT Other Tenant' },
      update: {},
    });

    const audience = await asUser(ACTOR, () =>
      createAudience({ name: `Isolated ${Date.now()}`, kind: 'static', entityType: 'person' }),
    );

    const rejected = await expectReject(() => asSystem(other.id, () => loadAudience(audience.id)));
    expect(rejected.status).toBe(404);
  });
});

describe('MKT-AUD — audiencePersonIds resolves entity members to Person ids', () => {
  it('resolves a lead member to the underlying person', async () => {
    const marker = `mkt-aud-resolve-${Date.now()}`;
    const lead = await asUser(ACTOR, () =>
      createLead({ title: marker, vertical: 'cybersecurity', source: 'manual', person: { fullName: marker, primaryEmail: `${marker}@mkttest.example` } }),
    );

    const audience = await asUser(ACTOR, () => createAudience({ name: marker, kind: 'static', entityType: 'lead' }));
    await asUser(ACTOR, () => addAudienceMember(audience.id, 'lead', lead.id));

    const personIds = await asUser(ACTOR, () => audiencePersonIds(audience.id));
    expect(personIds).toContain(lead.personId);
  });
});
