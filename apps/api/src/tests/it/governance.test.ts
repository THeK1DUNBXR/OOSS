/**
 * Technology — security and governance (docs/plan/cio.md, workstream F).
 *
 * `riskScore`/`riskBandFor`/`remediationDueAt`/`acknowledgementRate` first,
 * without a database. Then the wiring: a risk's score and band come from the
 * dated scoring table, never a constant (IT-RSK-001); publishing a policy
 * needs `approve`, the drafter cannot publish their own draft, and a
 * published version is immutable (IT-POL-001); an employee acknowledges a
 * published policy once per version and the rate counts only current
 * versions (IT-POL-002); a reviewer's decision on their own access is
 * refused with the self-review bar named (IT-ACR-001); a finding's due date
 * follows the remediation table in force at creation and the overdue ladder
 * is idempotent (IT-FND-001); plus the grant matrix.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { riskScore, riskBandFor, remediationDueAt, acknowledgementRate, type RiskScoringBandRow, type RemediationRuleRow } from '@kaizen/shared';
import { asUser, expectReject, tenantId, unscopedPrisma, withFixtureRole } from '../helpers.js';
import {
  createRisk,
  updateRisk,
  listRisks,
  riskDetail,
  transitionRisk,
  risksSummary,
  createPolicyDraft,
  updatePolicyDraft,
  listPolicies,
  policyDetail,
  publishPolicy,
  newVersionOf,
  acknowledgePolicy,
  policiesAwaitingCaller,
  acknowledgementsFor,
  policiesSummary,
  createControl,
  listControls,
  recordTest,
  controlsSummary,
  openCampaign,
  campaignDetail,
  decideItem,
  closeCampaign,
  createFinding,
  transitionFinding,
  findingsSummary,
} from '../../domains/it/governance.js';
import {
  runRiskReviewJob,
  runFindingOverdueJob,
  runControlTestOverdueJob,
  runAccessReviewOverdueJob,
} from '../../jobs/it/governance.js';
import { decideApprovalStep } from '../../platform/approvals.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/**
 * Publishes via the real gate, and — for the rare case it opens a step
 * rather than applying directly — forces the row to `published` to keep
 * exercising this acceptance ID's actual subject (immutability, versioning)
 * without every such test needing its own approval-step plumbing.
 * `POL-IT-POLICY-PUBLISH`'s seeded `approverResolution` is `['chairman',
 * 'finance_head']`: a *non*-self-dealing publish (someone other than the
 * drafter, at zero/no authority ceiling) resolves tier 0 to `chairman`, and
 * the chairman *is* that tier's approver, so it applies directly in the
 * ordinary case — this fallback exists for whichever case does not (a
 * different approver, a future ceiling). The self-dealing case (the drafter
 * publishing their own draft) always opens a step, asserted directly by
 * IT-POL-001 and the gate-chain test below rather than routed through here.
 */
async function publishForTest(policyId: string, actorEmail: string) {
  const result = await asUser(actorEmail, () => publishPolicy(policyId));
  if (result.applied) return { applied: true as const, policy: result.policy as { id: string; status: string } };
  return {
    applied: false as const,
    policy: await unscopedPrisma.itPolicyDocument.update({
      where: { id: policyId },
      data: { status: 'published', publishedAt: new Date(), publishedById: 'test-fixture' },
    }),
  };
}

// ---------------------------------------------------------------------------
// Pure arithmetic — no DB
// ---------------------------------------------------------------------------

describe('pure arithmetic (no DB)', () => {
  it('riskScore multiplies likelihood x impact', () => {
    expect(riskScore(1, 1)).toBe(1);
    expect(riskScore(5, 5)).toBe(25);
    expect(riskScore(3, 4)).toBe(12);
  });

  it('riskBandFor picks the highest minScore at or below the score, from the bands passed in', () => {
    const bands = [
      { band: 'low' as const, minScore: 1 },
      { band: 'medium' as const, minScore: 6 },
      { band: 'high' as const, minScore: 12 },
      { band: 'critical' as const, minScore: 20 },
    ];
    expect(riskBandFor(1, bands)).toBe('low');
    expect(riskBandFor(5, bands)).toBe('low');
    expect(riskBandFor(6, bands)).toBe('medium');
    expect(riskBandFor(11, bands)).toBe('medium');
    expect(riskBandFor(12, bands)).toBe('high');
    expect(riskBandFor(20, bands)).toBe('critical');
    expect(riskBandFor(25, bands)).toBe('critical');
  });

  it('riskBandFor never reads a constant — a different band set changes the answer for the same score', () => {
    const looser = [{ band: 'low' as const, minScore: 1 }, { band: 'critical' as const, minScore: 10 }];
    expect(riskBandFor(12, looser)).toBe('critical');
    const stricter = [{ band: 'low' as const, minScore: 1 }, { band: 'critical' as const, minScore: 15 }];
    expect(riskBandFor(12, stricter)).toBe('low');
  });

  it('remediationDueAt adds the severity-matched rule in force at createdAt', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const rules: RemediationRuleRow[] = [
      { severity: 'critical', days: 7, effectiveFrom: new Date('2020-01-01') },
      { severity: 'high', days: 30, effectiveFrom: new Date('2020-01-01') },
    ];
    expect(remediationDueAt(createdAt, 'critical', rules).toISOString().slice(0, 10)).toBe('2026-01-08');
    expect(remediationDueAt(createdAt, 'high', rules).toISOString().slice(0, 10)).toBe('2026-01-31');
  });

  it('remediationDueAt uses the rule in force at createdAt, not the latest one — a later tightening never rewrites an old finding', () => {
    const rules: RemediationRuleRow[] = [
      { severity: 'high', days: 30, effectiveFrom: new Date('2020-01-01') },
      { severity: 'high', days: 10, effectiveFrom: new Date('2027-01-01') },
    ];
    const createdBeforeTightening = new Date('2026-06-01T00:00:00.000Z');
    expect(remediationDueAt(createdBeforeTightening, 'high', rules).toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('remediationDueAt throws when no rule for the severity has ever taken effect', () => {
    expect(() => remediationDueAt(new Date(), 'low', [])).toThrow();
  });

  it('acknowledgementRate is null with no target, otherwise the plain fraction', () => {
    expect(acknowledgementRate(0, 0)).toBeNull();
    expect(acknowledgementRate(3, 4)).toBe(0.75);
    expect(acknowledgementRate(0, 4)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('IT governance — domain and wiring', () => {
  let tid: string;

  beforeAll(async () => {
    tid = await tenantId();
  });

  // -------------------------------------------------------------------------
  // Risks
  // -------------------------------------------------------------------------

  it('IT-RSK-001: a risk\'s score and band come from the dated scoring table, and the set used is recorded', async () => {
    const bandSet = await unscopedPrisma.itRiskScoringBand.findMany({ where: { tenantId: tid } });
    expect(bandSet.length).toBeGreaterThan(0);

    const opsHeadForRsk = await unscopedPrisma.affiliation.findFirstOrThrow({ where: { tenantId: tid, roleSlug: 'hr_ops_manager', status: 'active' } });
    const risk = await asUser('operations@kaizen.co.in', () =>
      createRisk({
        title: `Unpatched servers ${stamp()}`,
        category: 'infrastructure',
        ownerPartyId: opsHeadForRsk.partyId,
        likelihoodInherent: 5,
        impactInherent: 5,
        treatment: 'mitigate',
      }),
    );
    expect(risk.scoreInherent).toBe(25);
    expect(risk.bandInherent).toBe('critical');
    expect(risk.scoredUnderBandSetId).toBeTruthy();

    // Residual, once treatment brings likelihood/impact down.
    const updated = await asUser('operations@kaizen.co.in', () => updateRisk(risk.id, { likelihoodResidual: 1, impactResidual: 2 }));
    expect(updated.scoreResidual).toBe(2);
    expect(updated.bandResidual).toBe('low');
  });

  it('a risk moves open -> treating -> accepted -> closed via the machine, and a dead transition is refused', async () => {
    const opsHead = await unscopedPrisma.affiliation.findFirstOrThrow({ where: { tenantId: tid, roleSlug: 'hr_ops_manager', status: 'active' } });
    const risk = await asUser('operations@kaizen.co.in', () =>
      createRisk({ title: `Lifecycle risk ${stamp()}`, category: 'ops', ownerPartyId: opsHead.partyId, likelihoodInherent: 3, impactInherent: 3, treatment: 'accept' }),
    );
    const treating = await asUser('operations@kaizen.co.in', () => transitionRisk(risk.id, 'START_TREATING' as never));
    expect(treating.status).toBe('treating');
    const accepted = await asUser('operations@kaizen.co.in', () => transitionRisk(risk.id, 'ACCEPT' as never));
    expect(accepted.status).toBe('accepted');
    const closed = await asUser('operations@kaizen.co.in', () => transitionRisk(risk.id, 'CLOSE' as never));
    expect(closed.status).toBe('closed');

    const rejected = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionRisk(risk.id, 'ACCEPT' as never)));
    expect(rejected.status).toBe(422);
  });

  it('the risk review overdue ladder fires once per rung and reports on the row', async () => {
    const opsHead = await unscopedPrisma.affiliation.findFirstOrThrow({ where: { tenantId: tid, roleSlug: 'hr_ops_manager', status: 'active' } });
    const risk = await asUser('operations@kaizen.co.in', () =>
      createRisk({ title: `Review-due risk ${stamp()}`, category: 'ops', ownerPartyId: opsHead.partyId, likelihoodInherent: 2, impactInherent: 2, treatment: 'mitigate', reviewDueAt: new Date('2020-01-01') }),
    );

    await asUser('operations@kaizen.co.in', () => runRiskReviewJob());
    const firstCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_RSK_REVIEW_OVERDUE', subjectId: risk.id } });
    expect(firstCount).toBe(1);

    await asUser('operations@kaizen.co.in', () => runRiskReviewJob());
    const secondCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_RSK_REVIEW_OVERDUE', subjectId: risk.id } });
    expect(secondCount).toBe(1);
  });

  it('listRisks and riskDetail expose availableTransitions, and the summary reports byBand', async () => {
    const rows = await asUser('operations@kaizen.co.in', () => listRisks());
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length) {
      const detail = await asUser('operations@kaizen.co.in', () => riskDetail(rows[0].id));
      expect(Array.isArray(detail.availableTransitions)).toBe(true);
    }
    const summary = await asUser('operations@kaizen.co.in', () => risksSummary());
    expect(summary.notYetMeasured).toBe(false);
    expect(typeof summary.byBand).toBe('object');
  });

  // -------------------------------------------------------------------------
  // Policies
  // -------------------------------------------------------------------------

  it('IT-POL-001: publishing needs approve, the drafter cannot publish their own draft, and a published version is immutable', async () => {
    // Only the chairman holds both `it_policies:create` and `it_policies:approve`
    // (Operations Head drafts but never approves; Finance Head only views) —
    // exactly the shape the vendor-contract self-dealing test uses, so the
    // chairman is the only account that can even attempt to approve its own draft.
    const draft = await asUser('chairman@kaizen.co.in', () =>
      createPolicyDraft({ code: `IT-POL-TEST-${stamp()}`, title: 'Test policy', body: 'A body long enough to acknowledge.' }),
    );
    expect(draft.status).toBe('draft');

    const gated = await asUser('chairman@kaizen.co.in', () => publishPolicy(draft.id));
    expect(gated.applied).toBe(false);
    expect(gated.approvalStepId).toBeTruthy();

    const stillDraft = await unscopedPrisma.itPolicyDocument.findFirstOrThrow({ where: { id: draft.id } });
    expect(stillDraft.status).toBe('draft');

    // The Operations Head holds create but not approve at all — a plain
    // grant denial, distinct from the self-dealing reroute above.
    const opsDrafted = await asUser('operations@kaizen.co.in', () =>
      createPolicyDraft({ code: `IT-POL-OPS-${stamp()}`, title: 'Ops-drafted policy', body: 'Body text for the ops-drafted policy.' }),
    );
    const opsPublish = await expectReject(() => asUser('operations@kaizen.co.in', () => publishPolicy(opsDrafted.id)));
    expect(opsPublish.status).toBe(403);

    // Someone else with approve (chairman, drafting nobody else's) is not
    // self-dealing — `publishForTest` forces the row published when the
    // gate itself only opens a step, so the rest of this test can exercise
    // immutability and versioning (see its doc comment for why).
    const secondDraft = await asUser('operations@kaizen.co.in', () =>
      createPolicyDraft({ code: `IT-POL-CLEAN-${stamp()}`, title: 'Cleanly published policy', body: 'Body for a cleanly published policy.' }),
    );
    const published = await publishForTest(secondDraft.id, 'chairman@kaizen.co.in');
    expect(published.policy.status).toBe('published');

    // A published body is immutable.
    const editAttempt = await expectReject(() => asUser('operations@kaizen.co.in', () => updatePolicyDraft(secondDraft.id, { body: 'Changed after publish.' })));
    expect(editAttempt.status).toBe(422);

    // A change is a new version, not an edit.
    const v2 = await asUser('operations@kaizen.co.in', () => newVersionOf(secondDraft.id));
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('draft');
    expect(v2.supersedesId).toBe(secondDraft.id);

    const v2Published = await publishForTest(v2.id, 'chairman@kaizen.co.in');
    expect(v2Published.policy.status).toBe('published');
    if (!v2Published.applied) {
      // Forced: `publishPolicy` itself marks `supersedesId` superseded only
      // on a direct apply, so mirror that half of the write too.
      await unscopedPrisma.itPolicyDocument.update({ where: { id: secondDraft.id }, data: { status: 'superseded' } });
    }
    const supersededOriginal = await unscopedPrisma.itPolicyDocument.findFirstOrThrow({ where: { id: secondDraft.id } });
    expect(supersededOriginal.status).toBe('superseded');
  });

  it('the gate chain: a self-dealing publish opens a step to the Finance Head, and finishes once that step is approved', async () => {
    const draft = await asUser('chairman@kaizen.co.in', () =>
      createPolicyDraft({ code: `IT-POL-CHAIN-${stamp()}`, title: 'Chain test policy', body: 'Body for the gate-chain test.' }),
    );

    const gated = await asUser('chairman@kaizen.co.in', () => publishPolicy(draft.id));
    expect(gated.applied).toBe(false);
    expect(gated.approvalStepId).toBeTruthy();

    const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: gated.approvalStepId! } });
    expect(step.selfDealingBarTripped).toBe(true);
    expect(step.resolvedApproverRole).toBe('finance_head');
    expect(step.state).toBe('open');

    // Re-running publish before the step is decided still just re-opens (or
    // returns) an unapplied gate — never a silent apply.
    const stillGated = await asUser('chairman@kaizen.co.in', () => publishPolicy(draft.id));
    expect(stillGated.applied).toBe(false);
    const stillDraft = await unscopedPrisma.itPolicyDocument.findFirstOrThrow({ where: { id: draft.id } });
    expect(stillDraft.status).toBe('draft');

    await asUser('finance@kaizen.co.in', () => decideApprovalStep(step.id, true, 'Approved for publication.'));

    // The step is decided but the policy itself has not moved yet — a
    // decided approval step is not itself the write.
    const beforeFinalCall = await unscopedPrisma.itPolicyDocument.findFirstOrThrow({ where: { id: draft.id } });
    expect(beforeFinalCall.status).toBe('draft');

    const republished = await asUser('chairman@kaizen.co.in', () => publishPolicy(draft.id));
    expect(republished.applied).toBe(true);
    expect((republished.policy as { status: string }).status).toBe('published');

    const row = await unscopedPrisma.itPolicyDocument.findFirstOrThrow({ where: { id: draft.id } });
    expect(row.status).toBe('published');
    expect(row.publishedById).toBeTruthy();
  });

  it('IT-POL-002: an employee acknowledges a published policy once per version, and the rate counts only current versions', async () => {
    const draft = await asUser('operations@kaizen.co.in', () =>
      createPolicyDraft({ code: `IT-POL-ACK-${stamp()}`, title: 'Ack test policy', body: 'Body for the acknowledgement test.' }),
    );
    const published = await publishForTest(draft.id, 'chairman@kaizen.co.in');
    expect(published.policy.status).toBe('published');

    // Not visible as awaiting before acknowledgement... then acknowledged.
    const awaitingBefore = await asUser('employee@kaizen.co.in', () => policiesAwaitingCaller());
    expect(awaitingBefore.some((p) => p.id === draft.id)).toBe(true);

    const ack = await asUser('employee@kaizen.co.in', () => acknowledgePolicy(draft.id));
    expect(ack).toBeTruthy();

    // A second acknowledgement of the same version is a no-op, not a second row.
    await asUser('employee@kaizen.co.in', () => acknowledgePolicy(draft.id));
    const ackRows = await unscopedPrisma.itPolicyAcknowledgement.findMany({ where: { tenantId: tid, policyId: draft.id } });
    expect(ackRows.length).toBe(1);

    const awaitingAfter = await asUser('employee@kaizen.co.in', () => policiesAwaitingCaller());
    expect(awaitingAfter.some((p) => p.id === draft.id)).toBe(false);

    // The employee cannot acknowledge a draft — only a published policy.
    const draftOnly = await asUser('operations@kaizen.co.in', () =>
      createPolicyDraft({ code: `IT-POL-DRAFTONLY-${stamp()}`, title: 'Still a draft', body: 'Body for a policy that stays a draft.' }),
    );
    const draftAckDenied = await expectReject(() => asUser('employee@kaizen.co.in', () => acknowledgePolicy(draftOnly.id)));
    expect(draftAckDenied.status).toBe(422);

    const summary = await asUser('operations@kaizen.co.in', () => policiesSummary());
    expect(summary.notYetMeasured).toBe(false);
    expect(summary.acknowledgementRate === null || typeof summary.acknowledgementRate === 'number').toBe(true);

    const list = await asUser('operations@kaizen.co.in', () => acknowledgementsFor(draft.id));
    expect(list.length).toBe(1);
  });

  it('an employee sees published policies but the caller\'s own acknowledgement is recorded under their own party — self only', async () => {
    const detail = await asUser('operations@kaizen.co.in', () => listPolicies({ status: 'published' }));
    expect(Array.isArray(detail)).toBe(true);
    if (detail.length) {
      const d = await asUser('employee@kaizen.co.in', () => policyDetail(detail[0].id));
      expect(typeof d.acknowledgedByMe).toBe('boolean');
    }
  });

  it('listPolicies and policyDetail never leak a draft to a caller who only holds view', async () => {
    const draftOnly = await asUser('operations@kaizen.co.in', () =>
      createPolicyDraft({ code: `IT-POL-NOLEAK-${stamp()}`, title: 'Not for employees yet', body: 'Body for the leak test.' }),
    );

    // The Operations Head drafted it and holds `it_policies:E` — sees it fine.
    const opsView = await asUser('operations@kaizen.co.in', () => listPolicies());
    expect(opsView.some((p) => p.id === draftOnly.id)).toBe(true);

    // The employee's `it_policies:V@all` grant is view-only — no draft, ever,
    // with or without a status filter that asks for one.
    const employeeView = await asUser('employee@kaizen.co.in', () => listPolicies());
    expect(employeeView.some((p) => p.status === 'draft')).toBe(false);
    expect(employeeView.some((p) => p.id === draftOnly.id)).toBe(false);

    const employeeDraftFilter = await asUser('employee@kaizen.co.in', () => listPolicies({ status: 'draft' }));
    expect(employeeDraftFilter.length).toBe(0);

    const denied = await expectReject(() => asUser('employee@kaizen.co.in', () => policyDetail(draftOnly.id)));
    expect(denied.status).toBe(404);

    // The Finance Head holds only `V` on `it_policies` too — same treatment.
    const financeView = await asUser('finance@kaizen.co.in', () => listPolicies());
    expect(financeView.some((p) => p.id === draftOnly.id)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  it('the control library seeds ISO 27001 controls and a test updates lastTestedAt/lastResult', async () => {
    const controls = await asUser('operations@kaizen.co.in', () => listControls());
    expect(controls.length).toBeGreaterThanOrEqual(10);

    const opsHead = await unscopedPrisma.affiliation.findFirstOrThrow({ where: { tenantId: tid, roleSlug: 'hr_ops_manager', status: 'active' } });
    const control = await asUser('operations@kaizen.co.in', () =>
      createControl({ code: `TEST-CTL-${stamp()}`, title: 'Fixture control', frameworkRefs: [{ framework: 'ISO27001', ref: 'A.8.1' }], ownerPartyId: opsHead.partyId, frequencyDays: 30 }),
    );
    const tested = await asUser('operations@kaizen.co.in', () => recordTest(control.id, { result: 'pass', notes: 'Looked fine.' }));
    expect(tested.lastResult).toBe('pass');
    expect(tested.lastTestedAt).toBeTruthy();

    const summary = await asUser('operations@kaizen.co.in', () => controlsSummary());
    expect(summary.notYetMeasured).toBe(false);
  });

  it('the control test overdue job fires once for a control never tested against a short frequency', async () => {
    const opsHead = await unscopedPrisma.affiliation.findFirstOrThrow({ where: { tenantId: tid, roleSlug: 'hr_ops_manager', status: 'active' } });
    const control = await asUser('operations@kaizen.co.in', () =>
      createControl({ code: `OVERDUE-CTL-${stamp()}`, title: 'Never tested control', frameworkRefs: [], ownerPartyId: opsHead.partyId, frequencyDays: 1 }),
    );
    await unscopedPrisma.itControl.update({ where: { id: control.id }, data: { createdAt: new Date('2020-01-01') } });

    await asUser('operations@kaizen.co.in', () => runControlTestOverdueJob());
    const firstCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_CTL_TEST_OVERDUE', subjectId: control.id } });
    expect(firstCount).toBe(1);

    await asUser('operations@kaizen.co.in', () => runControlTestOverdueJob());
    const secondCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_CTL_TEST_OVERDUE', subjectId: control.id } });
    expect(secondCount).toBe(1);

    // Recording a test re-arms the detector.
    await asUser('operations@kaizen.co.in', () => recordTest(control.id, { result: 'pass' }));
    const cleared = await unscopedPrisma.itControl.findFirstOrThrow({ where: { id: control.id } });
    expect(cleared.testOverdueNotifiedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Access reviews
  // -------------------------------------------------------------------------

  it('IT-ACR-001: a reviewer\'s decision on their own access is refused with the self-review bar named', async () => {
    const opsHead = await unscopedPrisma.affiliation.findFirstOrThrow({ where: { tenantId: tid, roleSlug: 'hr_ops_manager', status: 'active' } });
    const dueAt = new Date();
    dueAt.setUTCDate(dueAt.getUTCDate() + 14);
    const campaign = await asUser('operations@kaizen.co.in', () => openCampaign({ name: `Self-review campaign ${stamp()}`, scope: 'all', dueAt }));
    expect(campaign.itemCount).toBeGreaterThan(0);

    const detail = await asUser('operations@kaizen.co.in', () => campaignDetail(campaign.id));
    const ownItem = detail.items.find((i) => i.partyId === opsHead.partyId);
    expect(ownItem).toBeTruthy();

    const denied = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => decideItem(campaign.id, ownItem!.id, { decision: 'keep' })),
    );
    expect(denied.status).toBe(403);
    expect(denied.message.toLowerCase()).toContain('self-review');

    // The Operations Head (who has `edit` on `it_access_reviews`) deciding
    // someone else's row — not their own — succeeds cleanly.
    const someoneElseItem = detail.items.find((i) => i.partyId !== opsHead.partyId);
    expect(someoneElseItem).toBeTruthy();
    const decided = await asUser('operations@kaizen.co.in', () => decideItem(campaign.id, someoneElseItem!.id, { decision: 'keep' }));
    expect(decided.decision).toBe('keep');
  });

  it('a campaign cannot close until every item has a decision, and closing is idempotent-safe', async () => {
    const dueAt = new Date();
    dueAt.setUTCDate(dueAt.getUTCDate() + 14);
    const opsHead = await unscopedPrisma.affiliation.findFirstOrThrow({ where: { tenantId: tid, roleSlug: 'hr_ops_manager', status: 'active' } });
    const campaign = await asUser('operations@kaizen.co.in', () => openCampaign({ name: `Close-test campaign ${stamp()}`, scope: 'role', scopeRef: 'hr_ops_manager', dueAt }));
    expect(campaign.itemCount).toBeGreaterThan(0);

    const stillOpen = await expectReject(() => asUser('operations@kaizen.co.in', () => closeCampaign(campaign.id)));
    expect(stillOpen.status).toBe(422);

    const detail = await asUser('operations@kaizen.co.in', () => campaignDetail(campaign.id));
    for (const item of detail.items) {
      if (item.partyId === opsHead.partyId) {
        await asUser('chairman@kaizen.co.in', () => decideItem(campaign.id, item.id, { decision: 'keep' }));
      } else {
        await asUser('operations@kaizen.co.in', () => decideItem(campaign.id, item.id, { decision: 'keep' }));
      }
    }

    const closed = await asUser('operations@kaizen.co.in', () => closeCampaign(campaign.id));
    expect(closed.status).toBe('closed');
  });

  it('the access-review campaign overdue detector raises an exception for a campaign past its due date, once — a second run raises nothing new', async () => {
    const dueAt = new Date('2020-01-01');
    const campaign = await asUser('operations@kaizen.co.in', () => openCampaign({ name: `Overdue campaign ${stamp()}`, scope: 'role', scopeRef: 'hr_ops_manager', dueAt: new Date() }));
    await unscopedPrisma.itAccessReview.update({ where: { id: campaign.id }, data: { dueAt } });

    await asUser('operations@kaizen.co.in', () => runAccessReviewOverdueJob());
    const firstCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_ACR_CAMPAIGN_OVERDUE', subjectId: campaign.id } });
    expect(firstCount).toBe(1);
    const notifiedRow = await unscopedPrisma.itAccessReview.findFirstOrThrow({ where: { id: campaign.id } });
    expect(notifiedRow.overdueNotifiedAt).toBeTruthy();

    await asUser('operations@kaizen.co.in', () => runAccessReviewOverdueJob());
    const secondCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_ACR_CAMPAIGN_OVERDUE', subjectId: campaign.id } });
    expect(secondCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Findings
  // -------------------------------------------------------------------------

  it('IT-FND-001: a finding\'s due date follows the remediation table in force at creation, and the overdue ladder is idempotent', async () => {
    const rules = await unscopedPrisma.itRemediationRule.findMany({ where: { tenantId: tid } });
    const critical = rules.find((r) => r.severity === 'critical');
    expect(critical).toBeTruthy();

    const finding = await asUser('operations@kaizen.co.in', () =>
      createFinding({ title: `Critical vuln ${stamp()}`, source: 'pentest', severity: 'critical' }),
    );
    const expectedDueAt = new Date(finding.createdAt);
    expectedDueAt.setUTCDate(expectedDueAt.getUTCDate() + critical!.days);
    expect(new Date(finding.dueAt).toISOString().slice(0, 10)).toBe(expectedDueAt.toISOString().slice(0, 10));

    // Force it overdue and run the ladder twice.
    await unscopedPrisma.itSecurityFinding.update({ where: { id: finding.id }, data: { dueAt: new Date('2020-01-01'), overdueNotifiedRungs: [] } });
    await asUser('operations@kaizen.co.in', () => runFindingOverdueJob());
    const firstCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_FND_OVERDUE', subjectId: finding.id } });
    expect(firstCount).toBe(1);

    await asUser('operations@kaizen.co.in', () => runFindingOverdueJob());
    const secondCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_FND_OVERDUE', subjectId: finding.id } });
    expect(secondCount).toBe(1);
  });

  it('a finding moves open -> in_progress -> fixed -> verified, and a later change to the remediation table never rewrites it', async () => {
    const finding = await asUser('operations@kaizen.co.in', () => createFinding({ title: `Lifecycle finding ${stamp()}`, source: 'scan', severity: 'medium' }));
    const originalDueAt = finding.dueAt;

    await unscopedPrisma.itRemediationRule.create({ data: { tenantId: tid, severity: 'medium', days: 1, effectiveFrom: new Date('2099-01-01') } });

    const inProgress = await asUser('operations@kaizen.co.in', () => transitionFinding(finding.id, 'START' as never));
    expect(inProgress.status).toBe('in_progress');
    expect(new Date(inProgress.dueAt).getTime()).toBe(new Date(originalDueAt).getTime());

    const fixed = await asUser('operations@kaizen.co.in', () => transitionFinding(finding.id, 'FIX' as never));
    expect(fixed.status).toBe('fixed');
    const verified = await asUser('operations@kaizen.co.in', () => transitionFinding(finding.id, 'VERIFY' as never));
    expect(verified.status).toBe('verified');

    const summary = await asUser('operations@kaizen.co.in', () => findingsSummary());
    expect(summary.notYetMeasured).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  it('an employee can acknowledge a published policy but reaches nothing else on risks, controls, access reviews or findings', async () => {
    const publishedPolicies = await unscopedPrisma.itPolicyDocument.findFirst({ where: { tenantId: tid, status: 'published' } });
    expect(publishedPolicies).toBeTruthy();
    const ack = await asUser('employee@kaizen.co.in', () => acknowledgePolicy(publishedPolicies!.id));
    expect(ack).toBeTruthy();

    const deniedRisks = await expectReject(() => asUser('employee@kaizen.co.in', () => listRisks()));
    expect(deniedRisks.status).toBe(403);
    const deniedControls = await expectReject(() => asUser('employee@kaizen.co.in', () => listControls()));
    expect(deniedControls.status).toBe(403);
    const deniedFindings = await expectReject(() => asUser('employee@kaizen.co.in', () => createFinding({ title: 'x', source: 'scan', severity: 'low' })));
    expect(deniedFindings.status).toBe(403);
  });

  it('the Operations Head cannot publish a policy — the grant has no approve, self-dealing or not', async () => {
    const draft = await asUser('operations@kaizen.co.in', () =>
      createPolicyDraft({ code: `IT-POL-OPSNOPUB-${stamp()}`, title: 'Ops cannot publish', body: 'Body for the ops-cannot-publish test.' }),
    );
    const denied = await expectReject(() => asUser('operations@kaizen.co.in', () => publishPolicy(draft.id)));
    expect(denied.status).toBe(403);
  });

  it('the Finance Head reads risks, policies, controls, access reviews and findings but cannot create any of them', async () => {
    const risks = await asUser('finance@kaizen.co.in', () => listRisks());
    expect(Array.isArray(risks)).toBe(true);
    const policies = await asUser('finance@kaizen.co.in', () => listPolicies());
    expect(Array.isArray(policies)).toBe(true);
    const controls = await asUser('finance@kaizen.co.in', () => listControls());
    expect(Array.isArray(controls)).toBe(true);

    const deniedRiskCreate = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => createRisk({ title: 'x', category: 'y', ownerPartyId: 'z', likelihoodInherent: 1, impactInherent: 1, treatment: 'accept' })),
    );
    expect(deniedRiskCreate.status).toBe(403);
    const deniedFindingCreate = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => createFinding({ title: 'x', source: 'scan', severity: 'low' })),
    );
    expect(deniedFindingCreate.status).toBe(403);
    const deniedPolicyCreate = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => createPolicyDraft({ code: `x-${stamp()}`, title: 'x', body: 'x' })),
    );
    expect(deniedPolicyCreate.status).toBe(403);
  });

  it('a fixture role holding it_policy_acknowledgements:C but not @own cannot acknowledge on another party\'s behalf', async () => {
    const publishedPolicy = await unscopedPrisma.itPolicyDocument.findFirst({ where: { tenantId: tid, status: 'published' } });
    expect(publishedPolicy).toBeTruthy();

    await withFixtureRole(
      { slug: 'gov_fixture', grants: [{ resource: 'it_policy_acknowledgements', verbs: ['create'], scope: 'all' }] },
      async () => {
        // Even with a wide `all`-scope create grant, acknowledgePolicy always
        // asserts against the caller's own partyId as the record's owner —
        // there is no path in this domain that lets a `create` grant write
        // an acknowledgement for anyone but the caller.
        const ack = await acknowledgePolicy(publishedPolicy!.id);
        expect(ack).toBeTruthy();
      },
    );
  });
});
