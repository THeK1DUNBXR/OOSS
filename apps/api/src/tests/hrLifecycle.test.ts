/**
 * The §14.3 lifecycle machines and the §14.6 trust model.
 *
 * These need no database, and that is the point: the machines are pure, so
 * they can be checked directly against the diagrams they were transcribed
 * from. A test that had to stand up Postgres to ask whether Absconded reaches
 * Alumni would be testing the plumbing rather than the diagram.
 *
 * Each test names the diagram or canon rule it verifies. The acceptance suite
 * (`acceptance.test.ts`) covers what these cannot: that the transitions are
 * reachable only through a grant, and that the balance ledger adds up.
 */

import { describe, expect, it } from 'vitest';
import {
  employmentRelationshipMachine,
  leaveRequestMachine,
  requisitionMachine,
  applicationMachine,
  positionMachine,
  assignmentMachine,
  compensationRecordMachine,
  onboardingMachine,
  offboardingMachine,
  goalMachine,
  workAttendanceMachine,
  payrollMachine,
  applicationFunnelBucket,
  isEmployed,
  InvalidTransitionError,
  HrRuleViolationError,
  CONFIDENCE_RANK,
  LEAVE_POSTING_ON_EVENT,
  EMPLOYMENT_EVENT_VERB,
  ORIGINATION_FOR_TIER,
  HR_MACHINES,
  assertVerificationAllowed,
  canEnterNonTierState,
  enterNonTierState,
  classifyContradiction,
  confidenceRank,
  decayedConfidence,
  isMoreConfident,
  tierForLearningCompletion,
} from '@kaizen/shared';

// ---------------------------------------------------------------------------
// Diagram 14.1 — Employment Relationship
// ---------------------------------------------------------------------------

describe('Employment relationship (Diagram 14.1)', () => {
  it('walks hire to alumni', () => {
    const m = employmentRelationshipMachine;
    let s = m.apply('PendingHire', 'ACTIVATE');
    expect(s).toBe('Active');
    s = m.apply(s, 'SUBMIT_RESIGNATION');
    expect(s).toBe('NoticePeriod');
    s = m.apply(s, 'REACH_LAST_WORKING_DAY');
    expect(s).toBe('Terminated');
    expect(m.apply(s, 'RETENTION_TRANSITION')).toBe('Alumni');
  });

  it('records the two ways a hire fails before it starts', () => {
    expect(employmentRelationshipMachine.apply('PendingHire', 'RESCIND_OFFER')).toBe('OfferRescinded');
    expect(employmentRelationshipMachine.apply('PendingHire', 'NO_SHOW')).toBe('NoShow');
  });

  it('takes leave out and back', () => {
    const m = employmentRelationshipMachine;
    const onLeave = m.apply('Active', 'START_LEAVE');
    expect(onLeave).toBe('OnLeave');
    expect(m.apply(onLeave, 'RETURN_FROM_LEAVE')).toBe('Active');
  });

  it('suspends both ways — reinstatement and termination', () => {
    const m = employmentRelationshipMachine;
    const suspended = m.apply('Active', 'SUSPEND');
    expect(m.apply(suspended, 'REINSTATE')).toBe('Active');
    expect(m.apply(suspended, 'TERMINATE_POST_DISCIPLINARY')).toBe('Terminated');
  });

  it('lets somebody resign while on leave', () => {
    expect(employmentRelationshipMachine.apply('OnLeave', 'SUBMIT_RESIGNATION')).toBe('NoticePeriod');
  });

  it('[SUPERSEDES HRM Vol3 §9.2.8] resolves Absconded only to Active or Terminated, never Alumni', () => {
    const m = employmentRelationshipMachine;
    for (const from of ['Active', 'OnLeave', 'NoticePeriod'] as const) {
      expect(m.apply(from, 'ABSENCE_BREACH')).toBe('Absconded');
    }
    expect(m.apply('Absconded', 'EXPLANATION_ACCEPTED')).toBe('Active');
    expect(m.apply('Absconded', 'ABANDONMENT_CONFIRMED')).toBe('Terminated');
    // Someone who stopped coming in is a separation with a reason, not an
    // alumnus. Reaching Alumni has to go through Terminated.
    expect(m.can('Absconded', 'RETENTION_TRANSITION')).toBe(false);
  });

  it('refuses a transition the diagram does not draw', () => {
    expect(() => employmentRelationshipMachine.apply('Active', 'ACTIVATE')).toThrow(InvalidTransitionError);
    expect(() => employmentRelationshipMachine.apply('Alumni', 'ACTIVATE')).toThrow(InvalidTransitionError);
  });

  it('leaves terminal states with nothing outbound', () => {
    for (const terminal of ['OfferRescinded', 'NoShow', 'Alumni'] as const) {
      expect(employmentRelationshipMachine.allowedEvents(terminal)).toEqual([]);
      expect(employmentRelationshipMachine.isTerminal(terminal)).toBe(true);
    }
  });

  it('counts as headcount exactly while somebody is on the books', () => {
    expect(isEmployed('Active')).toBe(true);
    expect(isEmployed('OnLeave')).toBe(true);
    expect(isEmployed('NoticePeriod')).toBe(true);
    expect(isEmployed('Suspended')).toBe(true);
    // Not yet started, and no longer here.
    expect(isEmployed('PendingHire')).toBe(false);
    expect(isEmployed('Terminated')).toBe(false);
    expect(isEmployed('Alumni')).toBe(false);
    expect(isEmployed('Absconded')).toBe(false);
  });

  it('keeps §14 verbatim verbs for the two events the canon quotes', () => {
    expect(EMPLOYMENT_EVENT_VERB.ACTIVATE).toBe('commenced');
    expect(EMPLOYMENT_EVENT_VERB.SUBMIT_RESIGNATION).toBe('resignation_submitted');
  });

  it('names every separation route "separated", however it was reached', () => {
    expect(EMPLOYMENT_EVENT_VERB.TERMINATE_POST_DISCIPLINARY).toBe('separated');
    expect(EMPLOYMENT_EVENT_VERB.REACH_LAST_WORKING_DAY).toBe('separated');
    expect(EMPLOYMENT_EVENT_VERB.ABANDONMENT_CONFIRMED).toBe('separated');
  });
});

// ---------------------------------------------------------------------------
// Diagram 14.2 — Leave Request
// ---------------------------------------------------------------------------

describe('Leave request (Diagram 14.2)', () => {
  it('walks draft to completed', () => {
    const m = leaveRequestMachine;
    let s = m.apply('Draft', 'SUBMIT');
    expect(s).toBe('Submitted');
    s = m.apply(s, 'ROUTE_FOR_APPROVAL');
    expect(s).toBe('PendingApproval');
    s = m.apply(s, 'APPROVE');
    expect(s).toBe('Approved');
    s = m.apply(s, 'START');
    expect(s).toBe('InProgress');
    expect(m.apply(s, 'COMPLETE')).toBe('Completed');
  });

  it('extends and resumes', () => {
    const m = leaveRequestMachine;
    const extended = m.apply('InProgress', 'REQUEST_EXTENSION');
    expect(extended).toBe('Extended');
    expect(m.apply(extended, 'EXTENSION_RUNNING')).toBe('InProgress');
  });

  it('withdraws before approval and cancels after', () => {
    expect(leaveRequestMachine.apply('Submitted', 'WITHDRAW')).toBe('CancelledWithdrawn');
    expect(leaveRequestMachine.apply('Approved', 'CANCEL')).toBe('CancelledWithdrawn');
    // Cancelling is not available before there is anything to cancel.
    expect(leaveRequestMachine.can('Submitted', 'CANCEL')).toBe(false);
  });

  it('moves the balance on exactly three transitions', () => {
    expect(LEAVE_POSTING_ON_EVENT.APPROVE).toBe('hold');
    expect(LEAVE_POSTING_ON_EVENT.COMPLETE).toBe('deduction');
    expect(LEAVE_POSTING_ON_EVENT.WITHDRAW).toBe('reversal');
    expect(LEAVE_POSTING_ON_EVENT.CANCEL).toBe('reversal');
    // Submitting or routing commits nothing, so neither posts.
    expect(LEAVE_POSTING_ON_EVENT.SUBMIT).toBeUndefined();
    expect(LEAVE_POSTING_ON_EVENT.ROUTE_FOR_APPROVAL).toBeUndefined();
    expect(LEAVE_POSTING_ON_EVENT.REJECT).toBeUndefined();
    expect(LEAVE_POSTING_ON_EVENT.START).toBeUndefined();
  });

  it('cannot approve a request that was never routed', () => {
    expect(() => leaveRequestMachine.apply('Submitted', 'APPROVE')).toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// R5 / R3 — hiring
// ---------------------------------------------------------------------------

describe('Requisition (R5)', () => {
  it('walks draft to filled', () => {
    const m = requisitionMachine;
    let s = m.apply('Draft', 'SUBMIT');
    expect(s).toBe('PendingApproval');
    s = m.apply(s, 'APPROVE');
    expect(s).toBe('Approved');
    s = m.apply(s, 'PUBLISH');
    expect(s).toBe('Open');
    expect(m.apply(s, 'FILL')).toBe('Filled');
  });

  it('holds and resumes an open requisition', () => {
    const held = requisitionMachine.apply('Open', 'HOLD');
    expect(held).toBe('OnHold');
    expect(requisitionMachine.apply(held, 'RESUME')).toBe('Open');
  });

  it('cannot publish before approval', () => {
    expect(() => requisitionMachine.apply('Draft', 'PUBLISH')).toThrow(InvalidTransitionError);
  });
});

describe('Application (R3)', () => {
  it('walks applied to joined', () => {
    const m = applicationMachine;
    let s = m.apply('Applied', 'ADVANCE');
    expect(s).toBe('Screening');
    s = m.apply(s, 'ADVANCE');
    expect(s).toBe('Interviewing');
    s = m.apply(s, 'ADVANCE');
    expect(s).toBe('Selected');
    s = m.apply(s, 'EXTEND_OFFER');
    expect(s).toBe('OfferExtended');
    s = m.apply(s, 'ACCEPT_OFFER');
    expect(s).toBe('OfferAccepted');
    expect(m.apply(s, 'JOIN')).toBe('Joined');
  });

  it('keeps the gap between accepting and joining, where the failures live', () => {
    const m = applicationMachine;
    // Accepting an offer is not the same fact as turning up.
    expect(m.apply('OfferAccepted', 'RESCIND_OFFER')).toBe('OfferRescinded');
    expect(m.apply('OfferAccepted', 'NO_SHOW')).toBe('NoShow');
    expect(m.can('Selected', 'JOIN')).toBe(false);
    expect(m.can('OfferExtended', 'JOIN')).toBe(false);
  });

  it('declines an offer distinctly from withdrawing', () => {
    expect(applicationMachine.apply('OfferExtended', 'DECLINE_OFFER')).toBe('OfferDeclined');
    expect(applicationMachine.apply('OfferExtended', 'WITHDRAW')).toBe('Withdrawn');
  });

  it('cannot reject somebody who has only just applied', () => {
    // Nothing has been assessed yet, so there is nothing to reject on.
    expect(applicationMachine.can('Applied', 'REJECT')).toBe(false);
    expect(applicationMachine.can('Screening', 'REJECT')).toBe(true);
  });

  it('projects §9.2.21 funnel buckets from the state rather than storing them', () => {
    expect(applicationFunnelBucket('Applied')).toBe('open');
    expect(applicationFunnelBucket('Interviewing')).toBe('open');
    expect(applicationFunnelBucket('Selected')).toBe('open');
    expect(applicationFunnelBucket('OfferExtended')).toBe('offer');
    expect(applicationFunnelBucket('OfferAccepted')).toBe('offer');
    expect(applicationFunnelBucket('Joined')).toBe('hired');
    expect(applicationFunnelBucket('Rejected')).toBe('closed');
    expect(applicationFunnelBucket('NoShow')).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// R1 / R4 / R2
// ---------------------------------------------------------------------------

describe('Position (R1)', () => {
  it('walks requested to filled and back to open when vacated', () => {
    const m = positionMachine;
    let s = m.apply('Requested', 'APPROVE_BUDGET');
    expect(s).toBe('BudgetApproved');
    s = m.apply(s, 'PUBLISH');
    expect(s).toBe('Open');
    s = m.apply(s, 'FILL');
    expect(s).toBe('Filled');
    expect(m.apply(s, 'VACATE')).toBe('Open');
  });

  it('cannot open a seat nobody has budgeted', () => {
    expect(() => positionMachine.apply('Requested', 'PUBLISH')).toThrow(InvalidTransitionError);
  });
});

describe('Assignment (R4)', () => {
  it('walks draft to effective', () => {
    const m = assignmentMachine;
    let s = m.apply('Draft', 'SUBMIT');
    s = m.apply(s, 'APPROVE');
    s = m.apply(s, 'SCHEDULE');
    expect(s).toBe('Scheduled');
    expect(m.apply(s, 'ACTIVATE')).toBe('Effective');
  });

  it('supersedes only from Effective', () => {
    expect(assignmentMachine.apply('Effective', 'SUPERSEDE')).toBe('Superseded');
    expect(assignmentMachine.can('Scheduled', 'SUPERSEDE')).toBe(false);
  });
});

describe('Compensation record (R2)', () => {
  it('walks all seven states', () => {
    const m = compensationRecordMachine;
    let s = m.apply('Proposed', 'SUBMIT');
    expect(s).toBe('PendingApproval');
    s = m.apply(s, 'APPROVE');
    s = m.apply(s, 'SCHEDULE');
    s = m.apply(s, 'ACTIVATE');
    expect(s).toBe('Effective');
    expect(m.apply(s, 'SUPERSEDE')).toBe('Superseded');
  });

  it('withdraws before approval but not after', () => {
    expect(compensationRecordMachine.apply('PendingApproval', 'WITHDRAW')).toBe('Withdrawn');
    expect(compensationRecordMachine.can('Approved', 'WITHDRAW')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Onboarding, offboarding, goals, attendance, payroll
// ---------------------------------------------------------------------------

describe('Onboarding and offboarding', () => {
  it('walks onboarding to completion', () => {
    const m = onboardingMachine;
    let s = m.apply('Initiated', 'START_PREBOARDING');
    s = m.apply(s, 'ACTIVATE_DAY1');
    s = m.apply(s, 'BEGIN');
    expect(s).toBe('InProgress');
    expect(m.apply(s, 'COMPLETE')).toBe('Completed');
  });

  it('escalates and resumes onboarding', () => {
    const blocked = onboardingMachine.apply('InProgress', 'ESCALATE');
    expect(blocked).toBe('BlockedEscalated');
    expect(onboardingMachine.apply(blocked, 'RESUME')).toBe('InProgress');
  });

  it('walks offboarding through clearance to settlement', () => {
    const m = offboardingMachine;
    let s = m.apply('Initiated', 'START_NOTICE');
    s = m.apply(s, 'REACH_LWD');
    s = m.apply(s, 'BEGIN_CLEARANCE');
    expect(s).toBe('ClearancePending');
    s = m.apply(s, 'CLEARANCE_COMPLETE');
    expect(s).toBe('FFSettlementPending');
    s = m.apply(s, 'DISBURSE');
    expect(s).toBe('FFSettlementCompleted');
    expect(m.apply(s, 'ARCHIVE')).toBe('ClosedArchived');
  });

  it('disputes clearance and returns to it once resolved', () => {
    const disputed = offboardingMachine.apply('ClearancePending', 'DISPUTE');
    expect(disputed).toBe('BlockedDisputed');
    expect(offboardingMachine.apply(disputed, 'RESOLVE')).toBe('ClearancePending');
  });

  it('cannot settle before clearance completes', () => {
    expect(() => offboardingMachine.apply('ClearancePending', 'DISBURSE')).toThrow(InvalidTransitionError);
  });
});

describe('Goal', () => {
  it('walks draft to achieved', () => {
    const m = goalMachine;
    let s = m.apply('Draft', 'AGREE');
    s = m.apply(s, 'START');
    expect(s).toBe('InProgress');
    expect(m.apply(s, 'ACHIEVE')).toBe('Achieved');
  });

  it('flags at risk and recovers', () => {
    const atRisk = goalMachine.apply('InProgress', 'FLAG_AT_RISK');
    expect(atRisk).toBe('AtRisk');
    expect(goalMachine.apply(atRisk, 'RECOVER')).toBe('InProgress');
  });

  it('closes from AtRisk without having to recover first', () => {
    expect(goalMachine.apply('AtRisk', 'PARTIALLY_ACHIEVE')).toBe('PartiallyAchieved');
    expect(goalMachine.apply('AtRisk', 'MISS')).toBe('Missed');
  });
});

describe('Work attendance', () => {
  it('regularises a disputed day and then locks it', () => {
    const m = workAttendanceMachine;
    const disputed = m.apply('Recorded', 'DISPUTE');
    const regularised = m.apply(disputed, 'REGULARISE');
    expect(regularised).toBe('Regularised');
    expect(m.apply(regularised, 'LOCK')).toBe('Locked');
  });

  it('will not lock a day that is still disputed', () => {
    // Payroll reads locked days, so a dispute has to be settled first.
    expect(workAttendanceMachine.can('Disputed', 'LOCK')).toBe(false);
  });

  it('leaves a locked day closed', () => {
    expect(workAttendanceMachine.isTerminal('Locked')).toBe(true);
  });
});

describe('Payroll', () => {
  it('walks draft to locked', () => {
    const m = payrollMachine;
    let s = m.apply('Draft', 'COMPUTE');
    s = m.apply(s, 'SUBMIT_REVIEW');
    expect(s).toBe('UnderReview');
    s = m.apply(s, 'APPROVE');
    s = m.apply(s, 'DISBURSE');
    expect(s).toBe('Disbursed');
    expect(m.apply(s, 'LOCK')).toBe('Locked');
  });

  it('cannot disburse without approval', () => {
    expect(() => payrollMachine.apply('Computed', 'DISBURSE')).toThrow(InvalidTransitionError);
    expect(() => payrollMachine.apply('UnderReview', 'DISBURSE')).toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

describe('The machine register', () => {
  it('holds all twelve machines', () => {
    expect(Object.keys(HR_MACHINES)).toHaveLength(12);
  });

  it('gives every machine at least one terminal state, so nothing loops forever', () => {
    for (const [key, machine] of Object.entries(HR_MACHINES)) {
      const states = Object.keys(machine.transitions);
      const terminals = states.filter((s) => machine.isTerminal(s as never));
      expect(terminals.length, `${key} has no terminal state`).toBeGreaterThan(0);
    }
  });

  it('never names a target state the machine does not declare', () => {
    for (const [key, machine] of Object.entries(HR_MACHINES)) {
      const declared = new Set(Object.keys(machine.transitions));
      for (const [from, events] of Object.entries(machine.transitions)) {
        for (const [event, to] of Object.entries(events as Record<string, string>)) {
          expect(declared.has(to), `${key}: ${from} --${event}--> ${to} is not a declared state`).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Capability Intelligence (§14.6)
// ---------------------------------------------------------------------------

describe('Capability trust tiers (§14.6)', () => {
  it('orders confidence Inferred < Claimed < Assessed < Demonstrated < Verified', () => {
    expect(confidenceRank('inferred')).toBeLessThan(confidenceRank('claimed'));
    expect(confidenceRank('claimed')).toBeLessThan(confidenceRank('assessed'));
    expect(confidenceRank('assessed')).toBeLessThan(confidenceRank('demonstrated'));
    expect(confidenceRank('demonstrated')).toBeLessThan(confidenceRank('verified'));
  });

  it('puts Inferred below Claimed, though it is named second', () => {
    expect(CONFIDENCE_RANK.inferred).toBe(1);
    expect(CONFIDENCE_RANK.claimed).toBe(2);
  });

  it('breaks a tie within a tier on the score', () => {
    expect(
      isMoreConfident({ tier: 'assessed', confidenceScore: 0.9 }, { tier: 'assessed', confidenceScore: 0.4 }),
    ).toBe(true);
  });

  it('lets the tier outrank any score', () => {
    expect(
      isMoreConfident({ tier: 'verified', confidenceScore: 0.1 }, { tier: 'demonstrated', confidenceScore: 0.99 }),
    ).toBe(true);
  });

  it('gives each tier its own way in, so a claim need never have been Claimed', () => {
    // A certificate checked with the issuing university was never somebody's
    // self-report, so it does not have to pass through Claimed to be Verified.
    expect(ORIGINATION_FOR_TIER.verified).toBe('issuer_verification');
    expect(ORIGINATION_FOR_TIER.claimed).toBe('self_report_or_cv_parse');
    expect(ORIGINATION_FOR_TIER.inferred).toBe('extraction_event');
  });

  it('reaches each non-tier state only from the tier that gives it meaning', () => {
    expect(canEnterNonTierState('verified', 'revoked')).toBe(true);
    expect(canEnterNonTierState('claimed', 'revoked')).toBe(false);
    expect(canEnterNonTierState('claimed', 'retracted')).toBe(true);
    expect(canEnterNonTierState('assessed', 'contradicted')).toBe(true);
    expect(canEnterNonTierState('demonstrated', 'superseded')).toBe(true);
  });

  it('refuses a non-tier transition its origin does not allow', () => {
    expect(() => enterNonTierState('claimed', 'revoked')).toThrow(HrRuleViolationError);
    expect(enterNonTierState('verified', 'revoked')).toBe('revoked');
  });

  it('never auto-resolves an identity conflict, whatever it scores', () => {
    expect(classifyContradiction('identity_conflict', 0)).toBe('human_review');
    expect(classifyContradiction('identity_conflict', 1)).toBe('human_review');
  });

  it('always rejects on an issuer conflict — there is nothing to weigh', () => {
    expect(classifyContradiction('issuer_conflict', 0)).toBe('auto_reject');
  });

  it('leaves a wide review band on a level conflict, where optimism is expected', () => {
    expect(classifyContradiction('level_conflict', 0.6)).toBe('human_review');
    expect(classifyContradiction('level_conflict', 0.2)).toBe('auto_accept');
    expect(classifyContradiction('level_conflict', 0.9)).toBe('auto_reject');
  });

  it('lets nobody verify their own claim, at any tier', () => {
    expect(() =>
      assertVerificationAllowed({
        claimantPartyId: 'p1',
        verifierPartyId: 'p1',
        targetTier: 'assessed',
        feedsCompensationOrPromotionOrMobility: false,
        verifierIsManagerOnly: false,
      }),
    ).toThrow(HrRuleViolationError);
  });

  it('lets nobody be the second verifier of their own claim', () => {
    expect(() =>
      assertVerificationAllowed({
        claimantPartyId: 'p1',
        verifierPartyId: 'hrops1',
        secondVerifierPartyId: 'p1',
        targetTier: 'verified',
        feedsCompensationOrPromotionOrMobility: false,
        verifierIsManagerOnly: false,
      }),
    ).toThrow(HrRuleViolationError);
  });

  it('will not take a manager alone for a Verified claim that moves pay or grade', () => {
    expect(() =>
      assertVerificationAllowed({
        claimantPartyId: 'p1',
        verifierPartyId: 'manager1',
        targetTier: 'verified',
        feedsCompensationOrPromotionOrMobility: true,
        verifierIsManagerOnly: true,
      }),
    ).toThrow(HrRuleViolationError);
  });

  it('requires an independent second verifier for a consequential claim', () => {
    const base = {
      claimantPartyId: 'p1',
      verifierPartyId: 'hrops1',
      targetTier: 'verified' as const,
      feedsCompensationOrPromotionOrMobility: true,
      verifierIsManagerOnly: false,
    };
    // Nobody second at all.
    expect(() => assertVerificationAllowed(base)).toThrow(HrRuleViolationError);
    // The same person twice is not two people.
    expect(() => assertVerificationAllowed({ ...base, secondVerifierPartyId: 'hrops1' })).toThrow(
      HrRuleViolationError,
    );
    expect(() => assertVerificationAllowed({ ...base, secondVerifierPartyId: 'hrbp1' })).not.toThrow();
  });

  it('needs no second verifier when the claim carries no consequence', () => {
    expect(() =>
      assertVerificationAllowed({
        claimantPartyId: 'p1',
        verifierPartyId: 'hrops1',
        targetTier: 'verified',
        feedsCompensationOrPromotionOrMobility: false,
        verifierIsManagerOnly: false,
      }),
    ).not.toThrow();
  });

  it('caps learning completion at Assessed', () => {
    // Sitting through training is evidence somebody was taught, not that they
    // can do it.
    expect(tierForLearningCompletion()).toBe('assessed');
  });

  it('decays confidence from the last evidence against the skill half-life', () => {
    const result = decayedConfidence({
      confidenceScore: 0.8,
      lastEvidencedAt: new Date('2025-01-01T00:00:00Z'),
      halfLifeMonths: 12,
      asOf: new Date('2026-01-01T00:00:00Z'),
    });
    expect(result).toBeCloseTo(0.4, 2);
  });

  it('does not decay a claim evidenced after the reference point', () => {
    expect(
      decayedConfidence({
        confidenceScore: 0.8,
        lastEvidencedAt: new Date('2026-06-01T00:00:00Z'),
        halfLifeMonths: 12,
        asOf: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toBe(0.8);
  });
});
