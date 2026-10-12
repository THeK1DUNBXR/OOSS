/**
 * Marketing messaging & journeys — MKT-MSG-*.
 *
 * DB-backed: every test runs inside a real request context so the grant
 * evaluator, the event chain and the consent gate are all genuinely
 * exercised, per the house convention (see tests/helpers.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from './helpers.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { grantConsent, publishNotice } from '../domains/compliance/privacy.js';
import { EVENTS, PURPOSE_CODES, RECIPIENT_STATUSES } from '@kaizen/shared';
import { MARKETING_JOBS } from '../jobs/marketing.js';
import { resetAdapterCacheForTests } from '../domains/marketing/adapters/registry.js';
import {
  createTemplate,
  submitForReview,
  approveTemplate,
  updateTemplate,
  loadTemplate,
  createSend,
  requestSend,
  approveSend,
  dispatchSend,
  applyDeliveryEvents,
  loadSend,
  listSendRecipients,
} from '../domains/marketing/messaging.js';
import { createJourney, activateJourney, enrolPerson, tick, loadJourney } from '../domains/marketing/journeys.js';
import { FakeEmailAdapter, clearFakeOutbox, fakeOutbox } from '../domains/marketing/adapters/fake.js';
import type { OutboundMessage } from '../domains/marketing/adapters/types.js';

const CREATOR = 'operations@kaizen.co.in'; // hr_ops_manager: holds marketing_templates/sends VCEDXF,approve
const APPROVER = 'chairman@kaizen.co.in'; // superadmin — a distinct principal from CREATOR

async function makePerson(fullName: string, email: string | null, phone: string | null) {
  return asUser(APPROVER, async (p) => {
    const recordCode = await nextRecordCode('PER');
    return prisma.person.create({
      data: {
        tenantId: p.tenantId,
        recordCode,
        fullName,
        primaryEmail: email,
        primaryEmailNormalised: email,
        primaryPhone: phone,
        source: 'test',
      },
    });
  });
}

async function grantMarketingConsent(personId: string) {
  return asUser(APPROVER, () => grantConsent({ personId, purposeCode: 'marketing', channel: 'portal' }));
}

async function makeApprovedTemplate(channelKey: 'email' | 'sms' | 'whatsapp', extra: Record<string, unknown> = {}) {
  const created = await asUser(CREATOR, () =>
    createTemplate({
      channelKey,
      name: `Test ${channelKey} ${Date.now()}`,
      subject: 'Hi {{person.firstName}}',
      body: 'Hello {{person.firstName}}, {{unsubscribeUrl}}',
      language: 'en',
      ...extra,
    } as never),
  );
  await asUser(CREATOR, () => submitForReview(created.id));
  await asUser(APPROVER, () => approveTemplate(created.id));
  return created;
}

let noticeEnsured = false;

/**
 * A prior test run against this persistent DB may have republished the
 * `kaizen` tenant's privacy notice with a narrower purpose list (some other
 * workstream's own scenario). Ensure `marketing` is covered before granting
 * any Consent — done once per file, not per test, since `publishNotice`
 * supersedes rather than edits.
 */
async function ensureMarketingPurposeNotice() {
  if (noticeEnsured) return;
  const codes = await asUser(APPROVER, async () => {
    const { currentNoticePurposeCodes } = await import('../domains/compliance/privacy.js');
    return currentNoticePurposeCodes(await tenantId());
  });
  if (!codes.has('marketing')) {
    await asUser(APPROVER, () =>
      publishNotice({
        effectiveFrom: new Date(),
        body: 'Marketing test fixture notice — covers every purpose this platform processes data for.',
        purposes: PURPOSE_CODES.map((code) => ({
          code,
          label: code,
          lawfulBasis: 'consent',
          dataCategories: ['contact'],
          retention: 'Until consent is withdrawn',
        })),
      }),
    );
  }
  noticeEnsured = true;
}

beforeEach(async () => {
  delete process.env.MARKETING_EMAIL_ADAPTER;
  resetAdapterCacheForTests();
  await ensureMarketingPurposeNotice();
});

describe('MKT-MSG-001/002 — template lifecycle & versioning', () => {
  it('editing an approved template creates a new draft version, and approving it retires the old one', async () => {
    const template = await makeApprovedTemplate('email');
    const v1 = await asUser(CREATOR, () => loadTemplate(template.id));
    expect(v1.status).toBe('approved');
    expect(v1.version).toBe(1);

    const v2 = await asUser(CREATOR, () => updateTemplate(template.id, { body: 'Updated body {{unsubscribeUrl}}' }));
    expect(v2.id).not.toBe(template.id);
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('draft');

    // The original stays approved until the new version clears review.
    const stillApproved = await asUser(CREATOR, () => loadTemplate(template.id));
    expect(stillApproved.status).toBe('approved');

    await asUser(CREATOR, () => submitForReview(v2.id));
    await asUser(APPROVER, () => approveTemplate(v2.id));

    const retired = await asUser(CREATOR, () => loadTemplate(template.id));
    expect(retired.status).toBe('retired');
    const approvedV2 = await asUser(CREATOR, () => loadTemplate(v2.id));
    expect(approvedV2.status).toBe('approved');
  });

  it('an SMS template cannot be approved without a dltTemplateId', async () => {
    const created = await asUser(CREATOR, () =>
      createTemplate({
        channelKey: 'sms',
        name: `SMS ${Date.now()}`,
        body: 'OTP is {{person.firstName}}',
        language: 'en',
      } as never),
    );
    await asUser(CREATOR, () => submitForReview(created.id));
    const err = await expectReject(() => asUser(APPROVER, () => approveTemplate(created.id)));
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/dltTemplateId/i);
  });

  it("a template's creator can never approve it themselves", async () => {
    const created = await asUser(CREATOR, () =>
      createTemplate({
        channelKey: 'email',
        name: `Self ${Date.now()}`,
        subject: 'Hi',
        body: 'Hello {{unsubscribeUrl}}',
        language: 'en',
      } as never),
    );
    await asUser(CREATOR, () => submitForReview(created.id));
    const err = await expectReject(() => asUser(CREATOR, () => approveTemplate(created.id)));
    expect(err.status).toBe(403);
  });
});

describe('MKT-MSG-003/004 — sends exclude non-consenting recipients', () => {
  it('a send lists consented recipients as queued and everyone else as skipped with a reason', async () => {
    const consented1 = await makePerson('Consented One', `c1-${Date.now()}@example.com`, null);
    const consented2 = await makePerson('Consented Two', `c2-${Date.now()}@example.com`, null);
    const noConsent = await makePerson('No Consent', `nc-${Date.now()}@example.com`, null);
    await grantMarketingConsent(consented1.id);
    await grantMarketingConsent(consented2.id);

    const template = await makeApprovedTemplate('email');
    const send = await asUser(CREATOR, () =>
      createSend({
        templateId: template.id,
        channelKey: 'email',
        personIds: [consented1.id, consented2.id, noConsent.id],
      } as never),
    );
    expect(send.recipientCount).toBe(2);

    const recipients = await asUser(CREATOR, () => listSendRecipients(send.id));
    const skipped = recipients.find((r) => r.personId === noConsent.id);
    expect(skipped?.status).toBe('skipped_no_consent');
    expect(skipped?.reason).toBe('no_consent');
    expect(recipients.filter((r) => r.status === 'queued')).toHaveLength(2);
  });
});

describe('MKT-MSG-011 — adapter not configured blocks a send', () => {
  it('requesting a send with no configured adapter raises EX-MKT-011 and leaves it in draft', async () => {
    const person = await makePerson('Blocked Person', `blocked-${Date.now()}@example.com`, null);
    await grantMarketingConsent(person.id);
    const template = await makeApprovedTemplate('email');
    const send = await asUser(CREATOR, () =>
      createSend({ templateId: template.id, channelKey: 'email', personIds: [person.id] } as never),
    );

    const err = await expectReject(() => asUser(CREATOR, () => requestSend(send.id)));
    expect(err.status).toBe(422);

    const reloaded = await asUser(CREATOR, () => loadSend(send.id));
    expect(reloaded.status).toBe('draft');

    const exc = await unscopedPrisma.exceptionRecord.findFirst({
      where: { subjectType: 'marketing_send', subjectId: send.id, code: 'EX-MKT-011' },
    });
    expect(exc).toBeTruthy();
  });
});

describe('MKT-MSG-005 — dispatch with the fake adapter', () => {
  it('marks recipients sent and logs an Interaction against the person', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();

    const person = await makePerson('Dispatch Person', `dispatch-${Date.now()}@example.com`, null);
    await grantMarketingConsent(person.id);
    const template = await makeApprovedTemplate('email');
    const send = await asUser(CREATOR, () =>
      createSend({ templateId: template.id, channelKey: 'email', personIds: [person.id] } as never),
    );

    await asUser(CREATOR, () => requestSend(send.id));
    const dispatched = await asUser(CREATOR, () => dispatchSend(send.id));
    expect(dispatched.status).toBe('sent');

    const recipients = await asUser(CREATOR, () => listSendRecipients(send.id));
    expect(recipients[0].status).toBe('sent');
    expect(recipients[0].providerMessageId).toBeTruthy();

    const interaction = await unscopedPrisma.interaction.findFirst({
      where: { tenantId: await tenantId(), interactionType: 'email' },
      orderBy: { createdAt: 'desc' },
    });
    expect(interaction).toBeTruthy();
    const refs = (interaction?.relatedReferences as unknown as Array<{ entityType: string; entityId: string }>) ?? [];
    expect(refs.some((r) => r.entityType === 'person' && r.entityId === person.id)).toBe(true);
  });

  it('applyDeliveryEvents updates the send counters from a providerMessageId', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();

    const person = await makePerson('Delivery Person', `delivery-${Date.now()}@example.com`, null);
    await grantMarketingConsent(person.id);
    const template = await makeApprovedTemplate('email');
    const send = await asUser(CREATOR, () =>
      createSend({ templateId: template.id, channelKey: 'email', personIds: [person.id] } as never),
    );
    await asUser(CREATOR, () => requestSend(send.id));
    await asUser(CREATOR, () => dispatchSend(send.id));

    const [recipient] = await asUser(CREATOR, () => listSendRecipients(send.id));
    expect(recipient.providerMessageId).toBeTruthy();

    await asUser(CREATOR, () =>
      applyDeliveryEvents('email', [
        { providerMessageId: recipient.providerMessageId!, kind: 'delivered', at: new Date() },
      ]),
    );

    const reloaded = await asUser(CREATOR, () => loadSend(send.id));
    expect(reloaded.deliveredCount).toBe(1);
  });

  it('a bounce rate above the alarm threshold raises EX-MKT-005', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();

    const p1 = await makePerson('Bounce One', `bounce1-${Date.now()}@example.com`, null);
    const p2 = await makePerson('Bounce Two', `bounce2-${Date.now()}@example.com`, null);
    await grantMarketingConsent(p1.id);
    await grantMarketingConsent(p2.id);
    const template = await makeApprovedTemplate('email');
    const send = await asUser(CREATOR, () =>
      createSend({ templateId: template.id, channelKey: 'email', personIds: [p1.id, p2.id] } as never),
    );
    await asUser(CREATOR, () => requestSend(send.id));
    await asUser(CREATOR, () => dispatchSend(send.id));

    const recipients = await asUser(CREATOR, () => listSendRecipients(send.id));
    await asUser(CREATOR, () =>
      applyDeliveryEvents(
        'email',
        recipients.map((r) => ({ providerMessageId: r.providerMessageId!, kind: 'bounced' as const, at: new Date() })),
      ),
    );

    const exc = await unscopedPrisma.exceptionRecord.findFirst({
      where: { subjectType: 'marketing_send', subjectId: send.id, code: 'EX-MKT-005' },
    });
    expect(exc).toBeTruthy();
  });
});

describe('MKT-MSG — sends over the approval threshold need a distinct approver', () => {
  it('the requester of a send can never also approve it', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();

    const person = await makePerson('Threshold Person', `threshold-${Date.now()}@example.com`, null);
    await grantMarketingConsent(person.id);
    const template = await makeApprovedTemplate('email');
    const send = await asUser(CREATOR, () =>
      createSend({ templateId: template.id, channelKey: 'email', personIds: [person.id] } as never),
    );

    // Force the over-threshold branch directly on the row rather than
    // creating 500 real recipients.
    await unscopedPrisma.marketingSend.update({ where: { id: send.id }, data: { recipientCount: 999999 } });
    await asUser(CREATOR, () => requestSend(send.id));

    const stillDraft = await asUser(CREATOR, () => loadSend(send.id));
    expect(stillDraft.status).toBe('draft');

    const err = await expectReject(() => asUser(CREATOR, () => approveSend(send.id)));
    expect(err.status).toBe(403);

    const approved = await asUser(APPROVER, () => approveSend(send.id));
    expect(approved.status).toBe('queued');
  });
});

describe('MKT-MSG-008 — journeys enrol and advance', () => {
  it('tick() sends step 0 then advances to step 1, and enrolling twice never duplicates the active run', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();

    const person = await makePerson('Journey Person', `journey-${Date.now()}@example.com`, null);
    await grantMarketingConsent(person.id);
    const template = await makeApprovedTemplate('email');

    const journey = await asUser(CREATOR, () =>
      createJourney({
        name: `Onboarding ${Date.now()}`,
        triggerKind: 'manual',
        steps: [
          { delayDays: 0, templateId: template.id, channelKey: 'email' },
          { delayDays: 0, templateId: template.id, channelKey: 'email' },
        ],
      }),
    );
    await asUser(CREATOR, () => activateJourney(journey.id));

    const run1 = await asUser(CREATOR, () => enrolPerson(journey.id, person.id));
    expect(run1.currentStep).toBe(0);

    const run2 = await asUser(CREATOR, () => enrolPerson(journey.id, person.id));
    expect(run2.id).toBe(run1.id); // no duplicate active run

    await asUser(CREATOR, () => tick());
    const midRun = await unscopedPrisma.marketingJourneyRun.findFirst({ where: { id: run1.id } });
    expect(midRun?.currentStep).toBe(1);
    expect(midRun?.status).toBe('active');

    await asUser(CREATOR, () => tick());
    const doneRun = await unscopedPrisma.marketingJourneyRun.findFirst({ where: { id: run1.id } });
    expect(doneRun?.status).toBe('completed');

    const loaded = await asUser(CREATOR, () => loadJourney(journey.id));
    expect(loaded.runCounts.completed).toBeGreaterThanOrEqual(1);
  });
});

describe('MKT-MSG — cross-tenant isolation', () => {
  it('a template or send from another tenant resolves as not found', async () => {
    const other = await unscopedPrisma.tenant.upsert({
      where: { slug: 'mkt-other-tenant' },
      create: { slug: 'mkt-other-tenant', name: 'Other Marketing Tenant' },
      update: {},
    });
    const foreignTemplate = await unscopedPrisma.marketingTemplate.create({
      data: {
        tenantId: other.id,
        recordCode: `TPL-2026-9${String(Date.now()).slice(-4)}`,
        channelKey: 'email',
        name: 'Foreign Template',
        body: 'Hi',
        status: 'approved',
      },
    });

    const err = await expectReject(() => asUser(CREATOR, () => loadTemplate(foreignTemplate.id)));
    expect(err.status).toBe(404);
  });
});

/**
 * Counts what reached the fake provider, per recipient, from the fake's own
 * outbox: a recorded message is a message the provider accepted, so the count
 * is the double-send measured at the provider, not a stub. The spy on
 * FakeEmailAdapter.send exists only for the two things an outbox cannot do:
 * `delayMs` widens the window so overlapping runs really overlap, and `crashOn`
 * throws once after the provider has accepted that recipient's message, the
 * crash the marks must survive. The real send runs before either.
 */
async function countAdapterSends(opts: { delayMs?: number; crashOn?: string } = {}) {
  const tid = await tenantId();
  clearFakeOutbox(tid);
  const original = FakeEmailAdapter.prototype.send;
  let crashed = false;
  vi.spyOn(FakeEmailAdapter.prototype, 'send').mockImplementation(async function (
    this: FakeEmailAdapter,
    msg: OutboundMessage,
  ) {
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    const result = await original.call(this, msg);
    if (opts.crashOn === msg.to.personId && !crashed) {
      crashed = true;
      throw new Error('process crashed after the provider accepted the message');
    }
    return result;
  });
  return (personId: string) => fakeOutbox(tid).filter((r) => r.personId === personId).length;
}

describe('MKT-MSG-005a — a recipient is claimed before it is sent, so it is never sent twice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('two overlapping dispatch runs send each recipient exactly once', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();
    const sentTo = await countAdapterSends({ delayMs: 15 });

    // Typed explicitly: an empty array literal here infers never[] and the
    // pushes below fail to typecheck.
    const people: Array<Awaited<ReturnType<typeof makePerson>>> = [];
    for (let i = 0; i < 4; i += 1) {
      const p = await makePerson(`Overlap ${i}`, `overlap-${i}-${Date.now()}@example.com`, null);
      await grantMarketingConsent(p.id);
      people.push(p);
    }
    const template = await makeApprovedTemplate('email');
    const send = await asUser(CREATOR, () =>
      createSend({ templateId: template.id, channelKey: 'email', personIds: people.map((p) => p.id) } as never),
    );
    await asUser(CREATOR, () => requestSend(send.id));

    await Promise.all([asUser(CREATOR, () => dispatchSend(send.id)), asUser(CREATOR, () => dispatchSend(send.id))]);

    for (const p of people) expect(sentTo(p.id)).toBe(1);
    const recipients = await asUser(CREATOR, () => listSendRecipients(send.id));
    expect(recipients.every((r) => r.status === 'sent')).toBe(true);
  });

  it('a crash between the provider accepting a message and the sent mark does not resend on the next run', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();

    const crashing = await makePerson('Crash Target', `crash-${Date.now()}@example.com`, null);
    const other = await makePerson('Crash Other', `crash-other-${Date.now()}@example.com`, null);
    await grantMarketingConsent(crashing.id);
    await grantMarketingConsent(other.id);
    const template = await makeApprovedTemplate('email');
    const send = await asUser(CREATOR, () =>
      createSend({ templateId: template.id, channelKey: 'email', personIds: [crashing.id, other.id] } as never),
    );
    await asUser(CREATOR, () => requestSend(send.id));

    const sentTo = await countAdapterSends({ crashOn: crashing.id });
    await expect(asUser(CREATOR, () => dispatchSend(send.id))).rejects.toThrow('process crashed');
    await asUser(CREATOR, () => dispatchSend(send.id));

    expect(sentTo(crashing.id)).toBe(1);
    expect(sentTo(other.id)).toBe(1);
  });

  it('a claim older than the lease is surfaced as unknown delivery and is not resent', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();

    const person = await makePerson('Stale Claim', `stale-${Date.now()}@example.com`, null);
    await grantMarketingConsent(person.id);
    const template = await makeApprovedTemplate('email');
    const send = await asUser(CREATOR, () =>
      createSend({ templateId: template.id, channelKey: 'email', personIds: [person.id] } as never),
    );
    await asUser(CREATOR, () => requestSend(send.id));
    const recipient = await unscopedPrisma.marketingSendRecipient.findFirst({ where: { sendId: send.id } });
    // A worker that claimed this recipient and died: the claim is hours old.
    await unscopedPrisma.marketingSendRecipient.update({
      where: { id: recipient!.id },
      data: { status: 'sending', claimedAt: new Date(Date.now() - 6 * 60 * 60_000) } as never,
    });

    const sentTo = await countAdapterSends();
    await asUser(CREATOR, () => dispatchSend(send.id));

    expect(sentTo(person.id)).toBe(0);
    const [after] = await asUser(CREATOR, () => listSendRecipients(send.id));
    expect(after.status).toBe('unknown_delivery');
  });
});

describe('MKT-MSG-008a — a journey step is claimed before it is sent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('two overlapping ticks for the same due step send it once', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();
    const sentTo = await countAdapterSends({ delayMs: 15 });

    const person = await makePerson('Step Once', `step-once-${Date.now()}@example.com`, null);
    await grantMarketingConsent(person.id);
    const template = await makeApprovedTemplate('email');
    const journey = await asUser(CREATOR, () =>
      createJourney({
        name: `Single step ${Date.now()}`,
        triggerKind: 'manual',
        steps: [{ delayDays: 0, templateId: template.id, channelKey: 'email' }],
      }),
    );
    await asUser(CREATOR, () => activateJourney(journey.id));
    const run = await asUser(CREATOR, () => enrolPerson(journey.id, person.id));

    await Promise.all([asUser(CREATOR, () => tick()), asUser(CREATOR, () => tick())]);

    expect(sentTo(person.id)).toBe(1);
    const after = await unscopedPrisma.marketingJourneyRun.findFirst({ where: { id: run.id } });
    expect(after?.currentStep).toBe(1);
  });
});

/** A send whose recipient was claimed by a worker that died `ageMs` ago. */
async function sendWithStaleClaim(ageMs: number, sendStatus: 'queued' | 'sending') {
  const person = await makePerson('Expired Claim', `expired-${Date.now()}-${ageMs}@example.com`, null);
  await grantMarketingConsent(person.id);
  const template = await makeApprovedTemplate('email');
  const send = await asUser(CREATOR, () =>
    createSend({ templateId: template.id, channelKey: 'email', personIds: [person.id] } as never),
  );
  await asUser(CREATOR, () => requestSend(send.id));
  await unscopedPrisma.marketingSend.update({ where: { id: send.id }, data: { status: sendStatus } });
  const recipient = await unscopedPrisma.marketingSendRecipient.findFirst({ where: { sendId: send.id } });
  await unscopedPrisma.marketingSendRecipient.update({
    where: { id: recipient!.id },
    data: { status: 'sending', claimedAt: new Date(Date.now() - ageMs) } as never,
  });
  return { send, person, recipientId: recipient!.id };
}

describe('MKT-MSG-005b — an expired claim is an unknown delivery an operator can see', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatch turns an expired sending claim into unknown_delivery, raises EX-MKT-016, and does not resend', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();
    const { send, person } = await sendWithStaleClaim(6 * 60 * 60_000, 'queued');
    const sentTo = await countAdapterSends();

    await asUser(CREATOR, () => dispatchSend(send.id));

    expect(sentTo(person.id)).toBe(0);
    const [after] = await asUser(CREATOR, () => listSendRecipients(send.id));
    expect(after.status).toBe('unknown_delivery');
    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: await tenantId(), code: 'EX-MKT-016', subjectId: send.id },
    });
    expect(exception).toBeTruthy();
  });

  it('the scheduled dispatch job sweeps expired claims even when no send is queued', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();
    const { send, person } = await sendWithStaleClaim(6 * 60 * 60_000, 'sending');
    const sentTo = await countAdapterSends();

    const job = MARKETING_JOBS.find((j) => j.name === 'marketing.sends.dispatch');
    await asUser(CREATOR, () => job!.run(new AbortController().signal));

    expect(sentTo(person.id)).toBe(0);
    const [after] = await asUser(CREATOR, () => listSendRecipients(send.id));
    expect(after.status).toBe('unknown_delivery');
    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: await tenantId(), code: 'EX-MKT-016', subjectId: send.id },
    });
    expect(exception).toBeTruthy();
  });

  it('the recipient status vocabulary includes sending and unknown_delivery, so the Sends filter can select them', () => {
    expect(RECIPIENT_STATUSES).toEqual(expect.arrayContaining(['sending', 'unknown_delivery']));
  });
});

describe('MKT-MSG-008b — a journey exit is claimed like a step, so an overlapping tick exits once', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function exitEvents(runId: string) {
    return unscopedPrisma.eventRecord.count({
      where: { tenantId: await tenantId(), eventName: EVENTS.MKT_JOURNEY_RUN_EXITED, subjectEntityId: runId },
    });
  }

  it('two overlapping ticks exit a run whose step condition is no longer met, with one exit event', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();
    const person = await makePerson('Condition Exit', `cond-exit-${Date.now()}@example.com`, null);
    await grantMarketingConsent(person.id);
    const template = await makeApprovedTemplate('email');
    const journey = await asUser(CREATOR, () =>
      createJourney({
        name: `Condition exit ${Date.now()}`,
        triggerKind: 'manual',
        steps: [
          {
            delayDays: 0,
            templateId: template.id,
            channelKey: 'email',
            condition: { all: [{ field: 'primaryEmail', op: 'eq', value: 'not-this-person@example.com' }] },
          },
        ],
      } as never),
    );
    await asUser(CREATOR, () => activateJourney(journey.id));
    const run = await asUser(CREATOR, () => enrolPerson(journey.id, person.id));

    await Promise.all([asUser(CREATOR, () => tick()), asUser(CREATOR, () => tick())]);

    const after = await unscopedPrisma.marketingJourneyRun.findFirst({ where: { id: run.id } });
    expect(after?.exitedReason).toBe('condition_not_met');
    expect(await exitEvents(run.id)).toBe(1);
  });

  it('two overlapping ticks exit a run with no consent once, with one exit event', async () => {
    process.env.MARKETING_EMAIL_ADAPTER = 'fake';
    resetAdapterCacheForTests();
    const person = await makePerson('No Consent Exit', `no-consent-${Date.now()}@example.com`, null);
    const template = await makeApprovedTemplate('email');
    const journey = await asUser(CREATOR, () =>
      createJourney({
        name: `No consent ${Date.now()}`,
        triggerKind: 'manual',
        steps: [{ delayDays: 0, templateId: template.id, channelKey: 'email' }],
      }),
    );
    await asUser(CREATOR, () => activateJourney(journey.id));
    const run = await asUser(CREATOR, () => enrolPerson(journey.id, person.id));

    await Promise.all([asUser(CREATOR, () => tick()), asUser(CREATOR, () => tick())]);

    const after = await unscopedPrisma.marketingJourneyRun.findFirst({ where: { id: run.id } });
    expect(after?.exitedReason).toBe('no_consent');
    expect(await exitEvents(run.id)).toBe(1);
  });
});
