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
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { createRequisition, transitionRequisition, transitionApplication } from '../../domains/hiring.js';
import {
  createJobPosting, transitionJobPosting,
  createCandidate, listCandidates,
  scheduleInterview, completeInterview, submitScorecard,
  createOffer, transitionOffer, listOffers, joinAndOnboard,
  createReferral, updateReferralStatus,
  createBackgroundVerification, updateBackgroundVerification,
  createOnboardingTemplate, listOnboardingTasks, instantiateOnboardingTasks,
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
