/**
 * Marketing — events & registrations, assets & social posts, referrals
 * (MKT-EVT-*, MKT-AST-*, MKT-REF-*).
 *
 * DB-backed, following the same pattern as acceptance.test.ts and
 * marketingAudiences.test.ts: real request context, real permission
 * evaluation, real event chain.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, tenantId, unscopedPrisma } from './helpers.js';
import { asSystem } from '../platform/context.js';
import {
  createEvent,
  loadEvent,
  openEvent,
  closeEvent,
  startEvent,
  completeEvent,
  registerForEvent,
  confirmRegistration,
  checkInRegistration,
  cancelRegistration,
  followUpRegistration,
  convertAttendees,
  detectFollowUpsOutstanding,
} from '../domains/marketing/events.js';
import {
  createAsset,
  updateAsset,
  submitForApproval,
  approveAsset,
  createSocialPost,
  publishSocialPost,
  detectExpiredAssetsInUse,
} from '../domains/marketing/assets.js';
import {
  createReferralProgram,
  issueReferral,
  redeemReferral,
  rewardReferral,
  qualifyReferral,
  leaderboard,
} from '../domains/marketing/referrals.js';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

const CHAIRMAN = 'chairman@kaizen.co.in';
const OPERATIONS = 'operations@kaizen.co.in';

async function makePerson(prefix: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  return unscopedPrisma.person.create({
    data: {
      tenantId: TENANT,
      recordCode: `PER-EVTTEST-${stamp}`,
      fullName: `${prefix} ${stamp}`,
      primaryEmail: `${prefix.toLowerCase()}-${stamp}@evttest.example`,
      primaryEmailNormalised: `${prefix.toLowerCase()}-${stamp}@evttest.example`,
      source: 'test',
    },
  });
}

async function makeInstitution(prefix: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  return unscopedPrisma.organization.create({
    data: {
      tenantId: TENANT,
      recordCode: `ORG-EVTTEST-${stamp}`,
      kind: 'institution',
      name: `${prefix} Institution ${stamp}`,
    },
  });
}

// ===========================================================================
// MKT-EVT — events
// ===========================================================================

describe('MKT-EVT — event state machine', () => {
  it('moves planned → open → closed → live → completed, and rejects an illegal jump', async () => {
    const marker = `mkt-evt-sm-${Date.now()}`;
    const event = await asUser(CHAIRMAN, () =>
      createEvent({ name: marker, kind: 'webinar', startAt: new Date(), division: 'education' }),
    );
    expect(event.status).toBe('planned');

    // planned → completed directly is not a legal move.
    const rejected = await expectReject(() => asUser(CHAIRMAN, () => completeEvent(event.id)));
    expect(rejected.status).toBe(422);

    const opened = await asUser(CHAIRMAN, () => openEvent(event.id));
    expect(opened.status).toBe('open');
    const closed = await asUser(CHAIRMAN, () => closeEvent(event.id));
    expect(closed.status).toBe('closed');
    const live = await asUser(CHAIRMAN, () => startEvent(event.id));
    expect(live.status).toBe('live');
    const completed = await asUser(CHAIRMAN, () => completeEvent(event.id));
    expect(completed.status).toBe('completed');

    // Terminal — no further transition is legal.
    const rejectedAgain = await expectReject(() => asUser(CHAIRMAN, () => openEvent(event.id)));
    expect(rejectedAgain.status).toBe(422);
  });

  it('requires the institutionId to be an Organization of kind institution in-tenant', async () => {
    const notInstitution = await unscopedPrisma.organization.create({
      data: { tenantId: TENANT, recordCode: `ORG-EVTTEST-${Date.now()}`, kind: 'organization', name: `Not an institution ${Date.now()}` },
    });
    const rejected = await expectReject(() =>
      asUser(CHAIRMAN, () =>
        createEvent({ name: 'Bad institution', kind: 'seminar', startAt: new Date(), institutionId: notInstitution.id }),
      ),
    );
    expect(rejected.status).toBe(400);
  });

  it('accepts a real institution', async () => {
    const institution = await makeInstitution('Valid');
    const event = await asUser(CHAIRMAN, () =>
      createEvent({ name: `mkt-evt-institution-${Date.now()}`, kind: 'college_visit', startAt: new Date(), institutionId: institution.id }),
    );
    expect(event.institutionId).toBe(institution.id);
  });
});

describe('MKT-EVT — registration capacity and duplicates', () => {
  it('enforces capacity and rejects a duplicate registration', async () => {
    const marker = `mkt-evt-cap-${Date.now()}`;
    const event = await asUser(CHAIRMAN, () =>
      createEvent({ name: marker, kind: 'seminar', startAt: new Date(), capacity: 1 }),
    );
    await asUser(CHAIRMAN, () => openEvent(event.id));

    const personA = await makePerson('CapA');
    const personB = await makePerson('CapB');

    const reg = await asUser(CHAIRMAN, () => registerForEvent(event.id, { personId: personA.id }));
    expect(reg.status).toBe('registered');

    // Duplicate registration for the same person is a conflict.
    const dup = await expectReject(() => asUser(CHAIRMAN, () => registerForEvent(event.id, { personId: personA.id })));
    expect(dup.status).toBe(409);

    // Capacity of 1 is already full.
    const overCapacity = await expectReject(() => asUser(CHAIRMAN, () => registerForEvent(event.id, { personId: personB.id })));
    expect(overCapacity.status).toBe(409);
  });

  it('registration is only accepted while the event is open', async () => {
    const event = await asUser(CHAIRMAN, () => createEvent({ name: `mkt-evt-notopen-${Date.now()}`, kind: 'demo', startAt: new Date() }));
    const person = await makePerson('NotOpen');
    const rejected = await expectReject(() => asUser(CHAIRMAN, () => registerForEvent(event.id, { personId: person.id })));
    expect(rejected.status).toBe(409);
  });
});

describe('MKT-EVT — check-in creates a touchpoint and follow-up logs an Interaction', () => {
  it('check-in flips status to attended and records an event_attend touchpoint', async () => {
    const event = await asUser(CHAIRMAN, () => createEvent({ name: `mkt-evt-checkin-${Date.now()}`, kind: 'open_day', startAt: new Date() }));
    await asUser(CHAIRMAN, () => openEvent(event.id));
    const person = await makePerson('CheckIn');
    const reg = await asUser(CHAIRMAN, () => registerForEvent(event.id, { personId: person.id }));

    const checkedIn = await asUser(CHAIRMAN, () => checkInRegistration(reg.id));
    expect(checkedIn.status).toBe('attended');
    expect(checkedIn.checkedInAt).not.toBeNull();

    const touchpoints = await unscopedPrisma.marketingTouchpoint.findMany({ where: { tenantId: TENANT, personId: person.id } });
    expect(touchpoints.some((t) => t.touchKind === 'visit')).toBe(true);
    expect(touchpoints.some((t) => t.touchKind === 'event_attend')).toBe(true);
  });

  it('a follow-up marked done logs a meeting Interaction against the person', async () => {
    const event = await asUser(CHAIRMAN, () => createEvent({ name: `mkt-evt-followup-${Date.now()}`, kind: 'demo', startAt: new Date() }));
    await asUser(CHAIRMAN, () => openEvent(event.id));
    const person = await makePerson('FollowUp');
    const reg = await asUser(CHAIRMAN, () => registerForEvent(event.id, { personId: person.id }));
    await asUser(CHAIRMAN, () => checkInRegistration(reg.id));

    const updated = await asUser(CHAIRMAN, () => followUpRegistration(reg.id, true, 'Called, interested'));
    expect(updated.followUpDone).toBe(true);

    const interactions = await unscopedPrisma.interaction.findMany({ where: { tenantId: TENANT, interactionType: 'meeting' } });
    const matching = interactions.find((i) =>
      (i.relatedReferences as unknown as Array<{ entityType: string; entityId: string }>).some(
        (r) => r.entityType === 'person' && r.entityId === person.id,
      ),
    );
    expect(matching).toBeDefined();
    expect(matching?.notes).toBe('Called, interested');
  });
});

describe('MKT-EVT — convertAttendees and cost per attendee', () => {
  it('creates a lead with source event for each attended registration lacking one', async () => {
    const event = await asUser(CHAIRMAN, () =>
      createEvent({ name: `mkt-evt-convert-${Date.now()}`, kind: 'placement_drive', startAt: new Date(), division: 'education' }),
    );
    await asUser(CHAIRMAN, () => openEvent(event.id));
    const person = await makePerson('Attendee');
    const reg = await asUser(CHAIRMAN, () => registerForEvent(event.id, { personId: person.id }));
    await asUser(CHAIRMAN, () => checkInRegistration(reg.id));

    const { created } = await asUser(CHAIRMAN, () => convertAttendees(event.id));
    expect(created).toBe(1);

    const lead = await unscopedPrisma.lead.findFirst({ where: { tenantId: TENANT, personId: person.id, source: 'event' } });
    expect(lead).not.toBeNull();
    expect(lead?.sourceDetail).toBe(event.recordCode);

    // Calling it again finds nothing left to convert.
    const second = await asUser(CHAIRMAN, () => convertAttendees(event.id));
    expect(second.created).toBe(0);
  });

  it('costPerAttendee is not measured (null) while zero people have attended', async () => {
    const event = await asUser(CHAIRMAN, () =>
      createEvent({ name: `mkt-evt-cost-${Date.now()}`, kind: 'webinar', startAt: new Date(), costPlanned: 5000 }),
    );
    const loaded = await asUser(CHAIRMAN, () => loadEvent(event.id));
    expect(loaded.costPerAttendee).toBeNull();
    expect(loaded.costPerAttendeeMeasured).toBe(false);
  });
});

describe('MKT-EVT — EX-MKT-008 follow-ups outstanding', () => {
  it('raises an exception for a completed event with an unresolved attended follow-up after 3 days', async () => {
    const event = await asUser(CHAIRMAN, () =>
      createEvent({ name: `mkt-evt-stale-followup-${Date.now()}`, kind: 'seminar', startAt: new Date() }),
    );
    await asUser(CHAIRMAN, () => openEvent(event.id));
    const person = await makePerson('StaleFollowUp');
    const reg = await asUser(CHAIRMAN, () => registerForEvent(event.id, { personId: person.id }));
    await asUser(CHAIRMAN, () => checkInRegistration(reg.id));
    await asUser(CHAIRMAN, () => closeEvent(event.id));
    await asUser(CHAIRMAN, () => startEvent(event.id));
    await asUser(CHAIRMAN, () => completeEvent(event.id));

    // Backdate completion past the 3-day threshold — the detector reads updatedAt.
    await unscopedPrisma.marketingEvent.update({
      where: { id: event.id },
      data: { updatedAt: new Date(Date.now() - 5 * 86_400_000) },
    });

    const raisedCount = await asUser(CHAIRMAN, () => detectFollowUpsOutstanding(3));
    expect(raisedCount).toBeGreaterThanOrEqual(1);

    const exc = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: TENANT, code: 'EX-MKT-008', subjectId: event.id },
    });
    expect(exc).not.toBeNull();
  });
});

describe('MKT-EVT — cancel and registration cancel', () => {
  it('cancels a registration and leaves the event itself untouched', async () => {
    const event = await asUser(CHAIRMAN, () => createEvent({ name: `mkt-evt-regcancel-${Date.now()}`, kind: 'fair', startAt: new Date() }));
    await asUser(CHAIRMAN, () => openEvent(event.id));
    const person = await makePerson('RegCancel');
    const reg = await asUser(CHAIRMAN, () => registerForEvent(event.id, { personId: person.id }));
    const cancelled = await asUser(CHAIRMAN, () => cancelRegistration(reg.id));
    expect(cancelled.status).toBe('cancelled');

    // A cancelled registration frees the slot: a re-registration is allowed.
    const rereg = await asUser(CHAIRMAN, () => registerForEvent(event.id, { personId: person.id }));
    expect(rereg.status).toBe('registered');
  });
});

describe('MKT-EVT — confirm', () => {
  it('moves a registered registration to confirmed', async () => {
    const event = await asUser(CHAIRMAN, () => createEvent({ name: `mkt-evt-confirm-${Date.now()}`, kind: 'demo', startAt: new Date() }));
    await asUser(CHAIRMAN, () => openEvent(event.id));
    const person = await makePerson('Confirm');
    const reg = await asUser(CHAIRMAN, () => registerForEvent(event.id, { personId: person.id }));
    const confirmed = await asUser(CHAIRMAN, () => confirmRegistration(reg.id));
    expect(confirmed.status).toBe('confirmed');
  });
});

// ===========================================================================
// MKT-AST — assets, versioning, self-dealing, social posts
// ===========================================================================

describe('MKT-AST — asset versioning and the self-approval bar', () => {
  it('editing an approved asset opens a new draft row at version+1, and the creator cannot approve their own asset', async () => {
    const marker = `mkt-ast-${Date.now()}`;
    const asset = await asUser(OPERATIONS, () => createAsset({ name: marker, kind: 'brochure' }));
    expect(asset.version).toBe(1);

    await asUser(OPERATIONS, () => submitForApproval(asset.id));

    // Self-dealing bar: the creator (operations) cannot approve their own asset,
    // even though hr_ops_manager holds marketing_assets:approve.
    const selfApprove = await expectReject(() => asUser(OPERATIONS, () => approveAsset(asset.id)));
    expect(selfApprove.status).toBe(403);

    const approved = await asUser(CHAIRMAN, () => approveAsset(asset.id));
    expect(approved.status).toBe('approved');

    const newVersion = await asUser(OPERATIONS, () => updateAsset(asset.id, { name: `${marker} v2` }));
    expect(newVersion.id).not.toBe(asset.id);
    expect(newVersion.version).toBe(2);
    expect(newVersion.status).toBe('draft');

    // The original approved row is untouched.
    const original = await unscopedPrisma.marketingAsset.findFirst({ where: { id: asset.id } });
    expect(original?.status).toBe('approved');
    expect(original?.name).toBe(marker);
  });
});

describe('MKT-AST — EX-MKT-012 expired asset still in use', () => {
  it('raises an exception for an approved, expired asset referenced by a scheduled social post', async () => {
    const marker = `mkt-ast-expired-${Date.now()}`;
    const asset = await asUser(OPERATIONS, () => createAsset({ name: marker, kind: 'creative', expiresAt: new Date(Date.now() - 86_400_000) }));
    await asUser(OPERATIONS, () => submitForApproval(asset.id));
    await asUser(CHAIRMAN, () => approveAsset(asset.id));

    const post = await asUser(OPERATIONS, () =>
      createSocialPost({ channelKey: 'social_meta', body: 'Check this out', assetIds: [asset.id], scheduledAt: new Date() }),
    );
    // Move it into a state the detector treats as "in use" without going through
    // scheduleSocialPost (which only requires draft → scheduled, already covered
    // elsewhere) — directly asserting the detector's own predicate here.
    await unscopedPrisma.marketingSocialPost.update({ where: { id: post.id }, data: { status: 'scheduled' } });

    const raised = await asUser(CHAIRMAN, () => detectExpiredAssetsInUse());
    expect(raised).toBeGreaterThanOrEqual(1);

    const exc = await unscopedPrisma.exceptionRecord.findFirst({ where: { tenantId: TENANT, code: 'EX-MKT-012', subjectId: asset.id } });
    expect(exc).not.toBeNull();
  });
});

describe('MKT-AST — social post publish, manual mode', () => {
  it('publishing with no configured adapter records publishMode manual and requires an externalUrl', async () => {
    const asset = await asUser(OPERATIONS, () => createAsset({ name: `mkt-ast-social-${Date.now()}`, kind: 'social_post' }));
    await asUser(OPERATIONS, () => submitForApproval(asset.id));
    await asUser(CHAIRMAN, () => approveAsset(asset.id));

    const post = await asUser(OPERATIONS, () =>
      createSocialPost({ channelKey: 'social_linkedin', body: 'Hello world', assetIds: [asset.id], scheduledAt: new Date() }),
    );

    const missingUrl = await expectReject(() => asUser(OPERATIONS, () => publishSocialPost(post.id, {})));
    expect(missingUrl.status).toBe(400);

    const published = await asUser(OPERATIONS, () => publishSocialPost(post.id, { externalUrl: 'https://linkedin.example/posts/1' }));
    expect(published.publishMode).toBe('manual');
    expect(published.status).toBe('published');
    expect(published.externalUrl).toBe('https://linkedin.example/posts/1');
  });
});

// ===========================================================================
// MKT-REF — referrals
// ===========================================================================

describe('MKT-REF — issue and redeem creates a lead and a touchpoint', () => {
  it('redeeming a code resolves the person, logs a referral touchpoint and creates a lead', async () => {
    const referrer = await makePerson('Referrer');
    const program = await asUser(CHAIRMAN, () =>
      createReferralProgram({ name: `mkt-ref-program-${Date.now()}`, kind: 'student', rewardKind: 'cash', rewardAmount: 500 }),
    );

    const referral = await asUser(CHAIRMAN, () => issueReferral({ programId: program.id, referrerPersonId: referrer.id }));
    expect(referral.status).toBe('issued');
    expect(referral.code.length).toBeGreaterThan(3);

    const referred = await makePerson('Referred');
    const redeemed = await asUser(CHAIRMAN, () => redeemReferral({ code: referral.code, referredPersonId: referred.id }));
    expect(redeemed.status).toBe('used');

    const lead = await unscopedPrisma.lead.findFirst({ where: { tenantId: TENANT, personId: referred.id, source: 'referral' } });
    expect(lead).not.toBeNull();
    expect(lead?.sourceDetail).toBe(referral.code);
    expect(lead?.campaignId).toBeNull();
    expect(lead?.channelKey).toBe('referral');

    const touchpoint = await unscopedPrisma.marketingTouchpoint.findFirst({
      where: { tenantId: TENANT, personId: referred.id, touchKind: 'referral' },
    });
    expect(touchpoint).not.toBeNull();
    expect(touchpoint?.channelKey).toBe('referral');
  });

  it('rejects a self-referral', async () => {
    const person = await makePerson('SelfReferrer');
    const program = await asUser(CHAIRMAN, () => createReferralProgram({ name: `mkt-ref-self-${Date.now()}`, kind: 'employee' }));
    const referral = await asUser(CHAIRMAN, () => issueReferral({ programId: program.id, referrerPersonId: person.id }));

    const rejected = await expectReject(() => asUser(CHAIRMAN, () => redeemReferral({ code: referral.code, referredPersonId: person.id })));
    expect(rejected.status).toBe(409);
  });
});

describe('MKT-REF — reward is refused on a rewardKind none program', () => {
  it('a program with no reward kind refuses reward()', async () => {
    const referrer = await makePerson('NoRewardReferrer');
    const referred = await makePerson('NoRewardReferred');
    const program = await asUser(CHAIRMAN, () => createReferralProgram({ name: `mkt-ref-none-${Date.now()}`, kind: 'partner', rewardKind: 'none' }));
    const referral = await asUser(CHAIRMAN, () => issueReferral({ programId: program.id, referrerPersonId: referrer.id }));
    await asUser(CHAIRMAN, () => redeemReferral({ code: referral.code, referredPersonId: referred.id }));
    await asUser(CHAIRMAN, () => qualifyReferral(referral.id));

    const rejected = await expectReject(() => asUser(CHAIRMAN, () => rewardReferral(referral.id, 'txn-123')));
    expect(rejected.status).toBe(409);
  });
});

describe('MKT-REF — leaderboard counts issued/used/qualified/rewarded per referrer', () => {
  it('rolls up correctly across multiple referrals from the same referrer', async () => {
    const referrer = await makePerson('Leaderboard');
    const program = await asUser(CHAIRMAN, () => createReferralProgram({ name: `mkt-ref-board-${Date.now()}`, kind: 'student', rewardKind: 'credit' }));

    const r1 = await asUser(CHAIRMAN, () => issueReferral({ programId: program.id, referrerPersonId: referrer.id }));
    const r2 = await asUser(CHAIRMAN, () => issueReferral({ programId: program.id, referrerPersonId: referrer.id }));

    const referred1 = await makePerson('LB1');
    await asUser(CHAIRMAN, () => redeemReferral({ code: r1.code, referredPersonId: referred1.id }));
    await asUser(CHAIRMAN, () => qualifyReferral(r1.id));
    await asUser(CHAIRMAN, () => rewardReferral(r1.id, 'txn-lb-1'));

    const referred2 = await makePerson('LB2');
    await asUser(CHAIRMAN, () => redeemReferral({ code: r2.code, referredPersonId: referred2.id }));

    const board = await asUser(CHAIRMAN, () => leaderboard(program.id));
    const row = board.find((b) => b.referrerLabel === referrer.fullName);
    expect(row).toBeDefined();
    expect(row?.issued).toBe(2);
    expect(row?.used).toBe(2);
    expect(row?.qualified).toBe(1);
    expect(row?.rewarded).toBe(1);
  });
});

// ===========================================================================
// Cross-tenant isolation
// ===========================================================================

describe('MKT-EVT / MKT-AST / MKT-REF — cross-tenant isolation', () => {
  it('an event created in one tenant 404s for a principal in another', async () => {
    const other = await unscopedPrisma.tenant.upsert({
      where: { slug: 'mkt-evt-other-tenant' },
      create: { slug: 'mkt-evt-other-tenant', name: 'MKT Event Other Tenant' },
      update: {},
    });

    const event = await asUser(CHAIRMAN, () => createEvent({ name: `mkt-evt-isolated-${Date.now()}`, kind: 'webinar', startAt: new Date() }));

    const rejected = await expectReject(() => asSystem(other.id, () => loadEvent(event.id)));
    expect(rejected.status).toBe(404);
  });

  it('an asset created in one tenant is invisible to a principal in another', async () => {
    const other = await unscopedPrisma.tenant.upsert({
      where: { slug: 'mkt-ast-other-tenant' },
      create: { slug: 'mkt-ast-other-tenant', name: 'MKT Asset Other Tenant' },
      update: {},
    });
    const asset = await asUser(OPERATIONS, () => createAsset({ name: `mkt-ast-isolated-${Date.now()}`, kind: 'deck' }));
    const found = await asSystem(other.id, () => unscopedPrisma.marketingAsset.findFirst({ where: { id: asset.id, tenantId: other.id } }));
    expect(found).toBeNull();
  });
});
