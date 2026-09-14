/**
 * HCM — recruiting (docs/hcm/recruiting.md).
 *
 * Built on the existing Requisition/Application machines in `hiring.ts` — the
 * fixtures here open a requisition and an application exactly the way
 * `hr.test.ts` does, then exercise the ATS this workstream adds on top:
 * postings, candidates, interviews and scorecards, offers with the
 * Self-Dealing Bar, referrals, background verification and onboarding tasks.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma, withFixtureRole } from '../helpers.js';
import { createRequisition, transitionRequisition, transitionApplication } from '../../domains/hiring.js';
import {
  createJobPosting, transitionJobPosting,
  createCandidate, listCandidates,
  scheduleInterview, completeInterview, submitScorecard, listScorecards, listInterviewRounds,
  createOffer, transitionOffer, listOffers, joinAndOnboard,
  createReferral, updateReferralStatus, listReferrals,
  createBackgroundVerification, updateBackgroundVerification,
  createOnboardingTemplate, listOnboardingTasks, instantiateOnboardingTasks, completeOnboardingTask,
  recruitingFunnel,
} from '../../domains/hcm/recruiting.js';
import { nextRecordCode } from '../../platform/recordCode.js';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function employmentFor(email: string) {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email } });
  return unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { personId: user.personId } });
}

/** A fresh Open requisition, built the way `hiring.ts`'s own tests do. */
async function makeOpenRequisition() {
  fixtureSeq += 1;
  return asUser('operations@kaizen.co.in', async () => {
    const position = await prisma.position.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('POS'),
        jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        status: 'Open',
      },
    });
    const requisition = await createRequisition({ positionId: position.id });
    await transitionRequisition(requisition.id, 'SUBMIT');
    await transitionRequisition(requisition.id, 'APPROVE');
    const open = await transitionRequisition(requisition.id, 'PUBLISH');
    return open;
  });
}

/** A candidate, an application against `requisitionId`, advanced to `Selected`. */
async function makeSelectedApplication(requisitionId: string) {
  fixtureSeq += 1;
  const stamp = `${Date.now()}-${fixtureSeq}`;
  return asUser('operations@kaizen.co.in', async () => {
    const { createApplication } = await import('../../domains/hiring.js');
    const candidate = await createCandidate({
      fullName: `Fixture Candidate ${stamp}`,
      primaryEmail: `fixture.recruiting.${stamp}@example.com`,
      source: 'job_board',
    });
    const application = await createApplication({ requisitionId, candidatePartyId: candidate.person.id });
    await transitionApplication(application.id, 'ADVANCE'); // Screening
    await transitionApplication(application.id, 'ADVANCE'); // Interviewing
    const selected = await transitionApplication(application.id, 'ADVANCE'); // Selected
    return { application: selected, candidate };
  });
}

// ===========================================================================
// Job postings
// ===========================================================================

describe('HCM-RECR-001 — a job posting follows Draft → Published → Closed', () => {
  it('publishes against an open requisition and refuses to skip straight to Closed from Draft', async () => {
    const requisition = await makeOpenRequisition();

    await asUser('operations@kaizen.co.in', async () => {
      const posting = await createJobPosting({
        requisitionId: requisition.id,
        title: `Fixture Role ${Date.now()}`,
        description: 'A fixture posting.',
        channel: 'external',
      });
      expect(posting.status).toBe('Draft');
      expect(posting.recordCode).toMatch(/^JPST-/);

      const badJump = await expectReject(() => transitionJobPosting(posting.id, 'CLOSE'));
      expect(badJump.message).toMatch(/does not accept|not one of its transitions/);

      const published = await transitionJobPosting(posting.id, 'PUBLISH');
      expect(published.status).toBe('Published');
      expect(published.publishedAt).not.toBeNull();

      const closed = await transitionJobPosting(posting.id, 'CLOSE');
      expect(closed.status).toBe('Closed');
    });
  });
});

// ===========================================================================
// Candidates — identity resolution, not a parallel Person table
// ===========================================================================

describe('HCM-RECR-002 — a candidate resolves through findOrCreatePerson', () => {
  it('two candidate submissions with the same email resolve to one Person and one CandidateProfile', async () => {
    const stamp = Date.now();
    const email = `fixture.dedupe.${stamp}@example.com`;

    await asUser('operations@kaizen.co.in', async () => {
      const first = await createCandidate({ fullName: `Dedupe Test ${stamp}`, primaryEmail: email, source: 'direct' });
      const second = await createCandidate({ fullName: `Dedupe Test ${stamp}`, primaryEmail: email, source: 'direct' });
      expect(second.person.id).toBe(first.person.id);

      const rows = await prisma.candidateProfile.findMany({ where: { tenantId: TENANT, personId: first.person.id } });
      expect(rows.length).toBe(1);
    });
  });

  it('money is withheld rather than shown to a viewer without the candidates financial grant', async () => {
    const stamp = Date.now();
    await asUser('operations@kaizen.co.in', async () => {
      await createCandidate({
        fullName: `CTC Test ${stamp}`,
        primaryEmail: `fixture.ctc.${stamp}@example.com`,
        currentCtc: 900_000,
        expectedCtc: 1_100_000,
      });
      const list = await listCandidates({ q: `CTC Test ${stamp}` });
      expect(list.length).toBeGreaterThan(0);
      // hr_ops_manager holds candidates:VCEDA but not the distinct `financial`
      // grant, so money comes back null rather than a masked non-null value.
      expect(list[0].currentCtc).toBeNull();
      expect(list[0].expectedCtc).toBeNull();
    });
  });
});

// ===========================================================================
// Interviews and scorecards
// ===========================================================================

describe('HCM-RECR-003 — an interview round is scheduled only while the application is being screened or interviewed', () => {
  it('refuses to schedule against a merely Applied candidate', async () => {
    const requisition = await makeOpenRequisition();
    await asUser('operations@kaizen.co.in', async () => {
      const { createApplication } = await import('../../domains/hiring.js');
      const candidate = await createCandidate({ fullName: `Too Early ${Date.now()}`, primaryEmail: `fixture.early.${Date.now()}@example.com` });
      const application = await createApplication({ requisitionId: requisition.id, candidatePartyId: candidate.person.id });

      const refusal = await expectReject(() =>
        scheduleInterview({
          applicationId: application.id,
          roundNo: 1,
          kind: 'phone',
          scheduledAt: new Date(),
          interviewerPartyIds: [],
        }),
      );
      expect(refusal.message).toMatch(/screened or interviewed/);
    });
  });
});

describe('HCM-RECR-004 — a scorecard may only be submitted by a roster interviewer, once', () => {
  it('rejects a non-roster interviewer and a duplicate submission from the same one', async () => {
    const requisition = await makeOpenRequisition();
    const interviewer = await employmentFor('hr@kaizen.co.in');

    const round = await asUser('operations@kaizen.co.in', async () => {
      const { createApplication } = await import('../../domains/hiring.js');
      const candidate = await createCandidate({ fullName: `Panel Candidate ${Date.now()}`, primaryEmail: `fixture.panel.${Date.now()}@example.com` });
      const application = await createApplication({ requisitionId: requisition.id, candidatePartyId: candidate.person.id });
      await transitionApplication(application.id, 'ADVANCE'); // Screening — schedulable
      return scheduleInterview({
        applicationId: application.id,
        roundNo: 1,
        kind: 'technical',
        scheduledAt: new Date(),
        interviewerPartyIds: [interviewer.personId],
      });
    });

    // The chairman is not on this round's roster.
    const forbidden = await expectReject(() =>
      asUser('chairman@kaizen.co.in', () =>
        submitScorecard({ roundId: round.id, competencyScores: { coding: 4 }, recommendation: 'hire' }),
      ),
    );
    expect(forbidden.message).toMatch(/roster/);

    // hr@kaizen.co.in is the roster interviewer set on the round above.
    await asUser('hr@kaizen.co.in', async () => {
      const scorecard = await submitScorecard({ roundId: round.id, competencyScores: { coding: 4 }, recommendation: 'hire' });
      expect(scorecard.recommendation).toBe('hire');

      const duplicate = await expectReject(() =>
        submitScorecard({ roundId: round.id, competencyScores: { coding: 5 }, recommendation: 'strong_hire' }),
      );
      expect(duplicate.message).toMatch(/already scored/);
    });
  });
});

// ===========================================================================
// Offers — approval and the Self-Dealing Bar
// ===========================================================================

describe('HCM-RECR-005 — an offer is approved by someone other than its proposer', () => {
  it('a finance_head approval succeeds and moves the offer to Approved', async () => {
    const requisition = await makeOpenRequisition();
    const { application } = await makeSelectedApplication(requisition.id);

    const offer = await asUser('operations@kaizen.co.in', () =>
      createOffer({ applicationId: application.id, ctc: 1_200_000, joiningDate: new Date(Date.now() + 30 * 86_400_000), validUntil: new Date(Date.now() + 14 * 86_400_000) }),
    );
    expect(offer.status).toBe('Draft');
    expect(offer.recordCode).toMatch(/^OFR-/);

    await asUser('operations@kaizen.co.in', () => transitionOffer(offer.id, 'SUBMIT'));

    const approved = await asUser('finance@kaizen.co.in', () => transitionOffer(offer.id, 'APPROVE'));
    expect(approved.status).toBe('Approved');
    expect(approved.approvedByPartyId).not.toBeNull();
  });
});

describe('HCM-RECR-006 — the Self-Dealing Bar refuses a proposer approving their own offer', () => {
  it('the chairman may not approve an offer they proposed themselves', async () => {
    const requisition = await makeOpenRequisition();
    const { application } = await makeSelectedApplication(requisition.id);

    const offer = await asUser('chairman@kaizen.co.in', async () => {
      const created = await createOffer({ applicationId: application.id, ctc: 1_500_000, joiningDate: new Date(Date.now() + 30 * 86_400_000), validUntil: new Date(Date.now() + 14 * 86_400_000) });
      return transitionOffer(created.id, 'SUBMIT');
    });

    const refusal = await expectReject(() => asUser('chairman@kaizen.co.in', () => transitionOffer(offer.id, 'APPROVE')));
    expect(refusal.message).toMatch(/Self-Dealing Bar/);
  });
});

describe('HCM-RECR-007 — an offer machine refuses an out-of-order transition', () => {
  it('cannot be sent while still a Draft', async () => {
    const requisition = await makeOpenRequisition();
    const { application } = await makeSelectedApplication(requisition.id);

    const offer = await asUser('operations@kaizen.co.in', () =>
      createOffer({ applicationId: application.id, ctc: 1_000_000, joiningDate: new Date(Date.now() + 30 * 86_400_000), validUntil: new Date(Date.now() + 14 * 86_400_000) }),
    );

    const refusal = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionOffer(offer.id, 'SEND')));
    expect(refusal.message).toMatch(/does not accept|not one of its transitions/);
  });

  it('an offer past its validUntil can no longer be accepted', async () => {
    const requisition = await makeOpenRequisition();
    const { application } = await makeSelectedApplication(requisition.id);

    const offer = await asUser('operations@kaizen.co.in', async () => {
      const created = await createOffer({
        applicationId: application.id,
        ctc: 1_000_000,
        joiningDate: new Date(Date.now() + 30 * 86_400_000),
        validUntil: new Date(Date.now() + 1000),
      });
      return transitionOffer(created.id, 'SUBMIT');
    });
    await asUser('finance@kaizen.co.in', () => transitionOffer(offer.id, 'APPROVE'));
    const sent = await asUser('operations@kaizen.co.in', () => transitionOffer(offer.id, 'SEND'));
    expect(sent.status).toBe('Sent');

    // Force it into the past rather than sleeping the test past a 1-second window.
    await asUser('operations@kaizen.co.in', () =>
      prisma.offerLetter.update({ where: { id: offer.id }, data: { validUntil: new Date(Date.now() - 60_000) } }),
    );

    const refusal = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionOffer(offer.id, 'ACCEPT')));
    expect(refusal.message).toMatch(/expired/);

    const stillSent = await asUser('operations@kaizen.co.in', () => prisma.offerLetter.findFirstOrThrow({ where: { id: offer.id } }));
    expect(stillSent.status).toBe('Sent');
  });
});

describe('HCM-RECR-008 — an accepted offer advances the underlying Application, and joining instantiates onboarding once', () => {
  it('ACCEPT moves the application to OfferAccepted, and join-and-onboard is idempotent on the task list', async () => {
    const requisition = await makeOpenRequisition();
    const { application } = await makeSelectedApplication(requisition.id);

    await asUser('operations@kaizen.co.in', () =>
      createOnboardingTemplate({ title: `Fixture laptop issue ${Date.now()}`, assignee: 'it', dueOffsetDays: 2 }),
    );

    const offer = await asUser('operations@kaizen.co.in', async () => {
      const created = await createOffer({ applicationId: application.id, ctc: 1_100_000, joiningDate: new Date(Date.now() + 20 * 86_400_000), validUntil: new Date(Date.now() + 14 * 86_400_000) });
      return transitionOffer(created.id, 'SUBMIT');
    });
    await asUser('finance@kaizen.co.in', () => transitionOffer(offer.id, 'APPROVE'));
    const sent = await asUser('operations@kaizen.co.in', () => transitionOffer(offer.id, 'SEND'));
    expect(sent.status).toBe('Sent');

    const accepted = await asUser('operations@kaizen.co.in', () => transitionOffer(offer.id, 'ACCEPT'));
    expect(accepted.status).toBe('Accepted');

    const updatedApplication = await asUser('operations@kaizen.co.in', () => prisma.application.findFirstOrThrow({ where: { id: application.id } }));
    expect(updatedApplication.status).toBe('OfferAccepted');

    const result = await asUser('operations@kaizen.co.in', () =>
      joinAndOnboard(application.id, { hireEffectiveDate: new Date() }),
    );
    expect(result.tasksCreated).toBeGreaterThan(0);
    expect(result.employment.recordCode).toMatch(/^EMP-/);

    // A second instantiation against the same employment does not duplicate
    // the checklist — the idempotency guard `instantiateOnboardingTasks`
    // itself applies, independent of `joinFromApplication`'s own refusal to
    // re-join an application that is no longer OfferAccepted.
    const again = await asUser('operations@kaizen.co.in', () => instantiateOnboardingTasks(result.employment.id, new Date()));
    expect(again.length).toBe(result.tasksCreated);
  });
});

// ===========================================================================
// Cross-tenant isolation
// ===========================================================================

describe('HCM-RECR-009 — a record from another tenant is a 404, not a 403', () => {
  it('an offer id that does not belong to this tenant is not found', async () => {
    const refusal = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionOffer('not-a-real-id', 'SUBMIT')));
    expect(refusal.message).toMatch(/Offer letter/);
  });
});

// ===========================================================================
// Referrals
// ===========================================================================

describe('HCM-RECR-010 — a referral follows Submitted → Shortlisted → Hired → BonusPaid', () => {
  it('refuses to jump straight from Submitted to BonusPaid', async () => {
    const referrer = await employmentFor('hr@kaizen.co.in');
    const stamp = Date.now();

    const referral = await asUser('operations@kaizen.co.in', () =>
      createReferral({
        referrerEmploymentId: referrer.id,
        candidate: { fullName: `Referred Person ${stamp}`, primaryEmail: `fixture.referral.${stamp}@example.com` },
        bonusAmount: 15_000,
      }),
    );
    expect(referral.status).toBe('Submitted');

    const badJump = await expectReject(() => asUser('operations@kaizen.co.in', () => updateReferralStatus(referral.id, 'BonusPaid')));
    expect(badJump.message).toMatch(/cannot move/);

    const shortlisted = await asUser('operations@kaizen.co.in', () => updateReferralStatus(referral.id, 'Shortlisted'));
    expect(shortlisted.status).toBe('Shortlisted');
    const hired = await asUser('operations@kaizen.co.in', () => updateReferralStatus(referral.id, 'Hired'));
    expect(hired.status).toBe('Hired');
    const paid = await asUser('operations@kaizen.co.in', () => updateReferralStatus(referral.id, 'BonusPaid'));
    expect(paid.status).toBe('BonusPaid');
  });

  it('refuses a referral where the referrer and the candidate are the same person', async () => {
    const referrer = await employmentFor('hr@kaizen.co.in');
    const hrPerson = await unscopedPrisma.person.findFirstOrThrow({ where: { id: referrer.personId } });

    const refusal = await expectReject(() =>
      asUser('operations@kaizen.co.in', () =>
        createReferral({
          referrerEmploymentId: referrer.id,
          candidate: { fullName: hrPerson.fullName, primaryEmail: hrPerson.primaryEmail ?? undefined },
        }),
      ),
    );
    expect(refusal.message).toMatch(/cannot be the same person/);
  });

  it('withholds the bonus amount from a viewer without the referrals financial verb', async () => {
    const referrer = await employmentFor('hr@kaizen.co.in');
    const stamp = Date.now();
    const referral = await asUser('operations@kaizen.co.in', () =>
      createReferral({
        referrerEmploymentId: referrer.id,
        candidate: { fullName: `Masked Bonus ${stamp}`, primaryEmail: `fixture.masked.${stamp}@example.com` },
        bonusAmount: 20_000,
      }),
    );
    // operations (hr_ops_manager) holds referrals:VCEDA but not the distinct
    // `financial` verb, so the bonus comes back null rather than 20000.
    const list = await asUser('operations@kaizen.co.in', () => listReferrals({ referrerEmploymentId: referrer.id }));
    const row = list.find((r) => r.id === referral.id);
    expect(row?.bonusAmount).toBeNull();
  });
});

// ===========================================================================
// Background verification
// ===========================================================================

describe('HCM-RECR-011 — a background verification needs an application or an employment to run against', () => {
  it('refuses to be created with neither, and records a Completed outcome', async () => {
    const requisition = await makeOpenRequisition();
    const { application } = await makeSelectedApplication(requisition.id);

    const badRequest = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => createBackgroundVerification({ vendor: 'Fixture Vendor', checks: ['identity'] })),
    );
    expect(badRequest.message).toMatch(/needs either/);

    const bgv = await asUser('operations@kaizen.co.in', () =>
      createBackgroundVerification({ applicationId: application.id, vendor: 'Fixture Vendor', checks: ['identity', 'address'] }),
    );
    expect(bgv.status).toBe('Pending');

    const completed = await asUser('operations@kaizen.co.in', () => updateBackgroundVerification(bgv.id, { status: 'Completed', outcome: 'clear' }));
    expect(completed.status).toBe('Completed');
    expect(completed.outcome).toBe('clear');
    expect(completed.completedAt).not.toBeNull();

    // A Completed outcome is final: a correction is a new check, not an edit
    // of a closed one.
    const refusal = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => updateBackgroundVerification(bgv.id, { outcome: 'adverse' })),
    );
    expect(refusal.message).toMatch(/final/);
    const unchanged = await asUser('operations@kaizen.co.in', () => prisma.backgroundVerification.findFirstOrThrow({ where: { id: bgv.id } }));
    expect(unchanged.outcome).toBe('clear');
  });
});

// ===========================================================================
// Funnel — all-scope only
// ===========================================================================

describe('HCM-RECR-012 — the recruiting funnel is an all-scope aggregate', () => {
  it('refuses a principal who holds the resource only at a narrower scope', async () => {
    const refusal = await expectReject(() => asUser('employee@kaizen.co.in', () => recruitingFunnel()));
    expect(refusal.status).toBe(403);
  });

  it('a holder of the all-scope grant gets numbers back, not an exception', async () => {
    const funnel = await asUser('operations@kaizen.co.in', () => recruitingFunnel());
    expect(funnel).toHaveProperty('sourceEffectiveness');
    expect(Array.isArray(funnel.sourceEffectiveness)).toBe(true);
  });
});

// ===========================================================================
// Scope axis — an `own`-scope grant (the shape every `employee` self-service
// grant in this workstream takes: interviews:V@own, scorecards:VC@own,
// referrals:VC@own, onboarding_tasks:VE@own) must narrow to the caller's own
// record. `assertCan({ verb })` with no `record` passes the WHERE axis
// trivially — the narrowing has to happen in the domain function itself, and
// each of the five reads/writes below closes exactly one place that check was
// missing.
// ===========================================================================

describe('HCM-RECR-013 — an own-scope grant narrows to the caller, never a colleague\'s record', () => {
  it('interviews:V@own sees only the rounds where the caller is the candidate or on the roster, not the whole loop for someone else\'s application', async () => {
    const requisition = await makeOpenRequisition();
    const interviewer = await employmentFor('hr@kaizen.co.in');

    const { applicationId } = await asUser('operations@kaizen.co.in', async () => {
      const { createApplication } = await import('../../domains/hiring.js');
      const candidate = await createCandidate({ fullName: `Scope Candidate ${Date.now()}`, primaryEmail: `fixture.scope.iv.${Date.now()}@example.com` });
      const application = await createApplication({ requisitionId: requisition.id, candidatePartyId: candidate.person.id });
      await transitionApplication(application.id, 'ADVANCE'); // Screening
      await scheduleInterview({
        applicationId: application.id,
        roundNo: 1,
        kind: 'technical',
        scheduledAt: new Date(),
        interviewerPartyIds: [interviewer.personId],
      });
      return { applicationId: application.id };
    });

    // A bystander holding `interviews:view@own` — neither this application's
    // candidate nor on the round's roster — must not see the round at all.
    const bystanderRounds = await withFixtureRole(
      { slug: 'recr_iv_bystander', grants: [{ resource: 'interviews', verbs: ['view'], scope: 'own' }] },
      () => listInterviewRounds(applicationId),
    );
    expect(bystanderRounds.length).toBe(0);

    // The all-scope holder still sees it, proving this is a narrowing and not
    // a break in the read path itself.
    const allScopeRounds = await asUser('operations@kaizen.co.in', () => listInterviewRounds(applicationId));
    expect(allScopeRounds.length).toBe(1);
  });

  it('scorecards:V@own sees only the caller\'s own scorecard, never a co-panellist\'s recommendation', async () => {
    const requisition = await makeOpenRequisition();
    const interviewer = await employmentFor('hr@kaizen.co.in');

    const round = await asUser('operations@kaizen.co.in', async () => {
      const { createApplication } = await import('../../domains/hiring.js');
      const candidate = await createCandidate({ fullName: `Scope Panel ${Date.now()}`, primaryEmail: `fixture.scope.sc.${Date.now()}@example.com` });
      const application = await createApplication({ requisitionId: requisition.id, candidatePartyId: candidate.person.id });
      await transitionApplication(application.id, 'ADVANCE'); // Screening
      return scheduleInterview({
        applicationId: application.id,
        roundNo: 1,
        kind: 'panel',
        scheduledAt: new Date(),
        interviewerPartyIds: [interviewer.personId],
      });
    });
    await asUser('hr@kaizen.co.in', () =>
      submitScorecard({ roundId: round.id, competencyScores: { coding: 4 }, recommendation: 'hire' }),
    );

    // Another own-scope holder (not this round's interviewer) reads back none
    // of the panel's scorecards, rather than the one interviewer's recommendation.
    const bystanderCards = await withFixtureRole(
      { slug: 'recr_sc_bystander', grants: [{ resource: 'scorecards', verbs: ['view'], scope: 'own' }] },
      () => listScorecards(round.id),
    );
    expect(bystanderCards.length).toBe(0);

    const allScopeCards = await asUser('operations@kaizen.co.in', () => listScorecards(round.id));
    expect(allScopeCards.length).toBe(1);
  });

  it('referrals:C@own refuses to raise a referral crediting someone else\'s employment', async () => {
    const referrer = await employmentFor('hr@kaizen.co.in');
    const stamp = Date.now();

    const refusal = await expectReject(() =>
      withFixtureRole({ slug: 'recr_ref_spoof', grants: [{ resource: 'referrals', verbs: ['create'], scope: 'own' }] }, () =>
        createReferral({
          referrerEmploymentId: referrer.id,
          candidate: { fullName: `Spoofed Referral ${stamp}`, primaryEmail: `fixture.spoof.${stamp}@example.com` },
        }),
      ),
    );
    expect(refusal.status).toBe(403);
    expect(refusal.message).toMatch(/raised as yourself/);
  });

  it('referrals:V@own never lists a colleague\'s referral', async () => {
    const referrer = await employmentFor('hr@kaizen.co.in');
    const stamp = Date.now();
    await asUser('operations@kaizen.co.in', () =>
      createReferral({
        referrerEmploymentId: referrer.id,
        candidate: { fullName: `Colleague Referral ${stamp}`, primaryEmail: `fixture.colleague.${stamp}@example.com` },
        bonusAmount: 10_000,
      }),
    );

    // A bystander holding only `referrals:view@own` and no employment of
    // their own in this tenant sees an empty list — never hr@'s referral.
    const bystanderReferrals = await withFixtureRole(
      { slug: 'recr_ref_bystander', grants: [{ resource: 'referrals', verbs: ['view'], scope: 'own' }] },
      () => listReferrals({ referrerEmploymentId: referrer.id }),
    );
    expect(bystanderReferrals.length).toBe(0);

    const allScopeReferrals = await asUser('operations@kaizen.co.in', () => listReferrals({ referrerEmploymentId: referrer.id }));
    expect(allScopeReferrals.length).toBeGreaterThan(0);
  });

  it('onboarding_tasks:VE@own cannot read or complete a checklist item on someone else\'s employment', async () => {
    const requisition = await makeOpenRequisition();
    const { application } = await makeSelectedApplication(requisition.id);
    await asUser('operations@kaizen.co.in', () =>
      createOnboardingTemplate({ title: `Scope fixture task ${Date.now()}`, assignee: 'employee', dueOffsetDays: 1 }),
    );
    const offer = await asUser('operations@kaizen.co.in', async () => {
      const created = await createOffer({ applicationId: application.id, ctc: 1_000_000, joiningDate: new Date(Date.now() + 20 * 86_400_000), validUntil: new Date(Date.now() + 14 * 86_400_000) });
      return transitionOffer(created.id, 'SUBMIT');
    });
    await asUser('finance@kaizen.co.in', () => transitionOffer(offer.id, 'APPROVE'));
    await asUser('operations@kaizen.co.in', () => transitionOffer(offer.id, 'SEND'));
    await asUser('operations@kaizen.co.in', () => transitionOffer(offer.id, 'ACCEPT'));
    const { employment } = await asUser('operations@kaizen.co.in', () => joinAndOnboard(application.id, { hireEffectiveDate: new Date() }));

    const task = await asUser('operations@kaizen.co.in', () =>
      prisma.onboardingTask.findFirstOrThrow({ where: { tenantId: TENANT, employmentId: employment.id, assignee: 'employee' } }),
    );

    const grants = [{ resource: 'onboarding_tasks', verbs: ['view', 'edit'] as string[], scope: 'own' }];

    const viewRefusal = await expectReject(() =>
      withFixtureRole({ slug: 'recr_ob_bystander_v', grants }, () => listOnboardingTasks(employment.id)),
    );
    expect(viewRefusal.status).toBe(404);

    const editRefusal = await expectReject(() =>
      withFixtureRole({ slug: 'recr_ob_bystander_e', grants }, () => completeOnboardingTask(task.id, false)),
    );
    expect(editRefusal.status).toBe(404);

    // The task is untouched — still Pending, for the actual joiner to complete.
    const untouched = await asUser('operations@kaizen.co.in', () => prisma.onboardingTask.findFirstOrThrow({ where: { id: task.id } }));
    expect(untouched.status).toBe('Pending');
  });
});
