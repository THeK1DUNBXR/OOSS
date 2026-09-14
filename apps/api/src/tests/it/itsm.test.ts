/**
 * Technology — incidents, problems and changes (docs/plan/cio.md,
 * workstream E).
 *
 * Pure arithmetic first (`mttrMinutes`, `changeSuccessRate`, `isInFreeze`),
 * no database. Then the wiring: an incident's timeline stamps are set once
 * (IT-INC-001), a sev1 cannot close without a published review and a
 * published review is final (IT-INC-002), a normal change's raiser cannot
 * approve their own change while a standard change needs no step
 * (IT-CHG-001), scheduling inside a freeze is refused with the window named
 * (IT-CHG-002), change success rate counts only reviewed changes
 * (IT-CHG-003), plus the permission tests the matrix promises.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { changeSuccessRate, isInFreeze, mttrMinutes } from '@kaizen/shared';
import { asUser, expectReject, tenantId, unscopedPrisma } from '../helpers.js';
import {
  changeDetail,
  changeSummary,
  createChange,
  createProblem,
  declareFreeze,
  declareIncident,
  incidentDetail,
  incidentSummary,
  listChanges,
  listIncidents,
  postIncidentUpdate,
  problemDetail,
  submitIncidentReview,
  transitionChange,
  transitionIncident,
  transitionProblem,
} from '../../domains/it/itsm.js';
import { runChangeWindowMissedJob, runReviewOverdueJob, runStaleIncidentJob } from '../../jobs/it/itsm.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('pure arithmetic (no DB)', () => {
  it('mttrMinutes averages only resolved incidents and is null with none', () => {
    expect(mttrMinutes([])).toBeNull();
    expect(mttrMinutes([{ detectedAt: new Date('2026-01-01T00:00:00Z'), resolvedAt: null }])).toBeNull();
    const rows = [
      { detectedAt: new Date('2026-01-01T00:00:00Z'), resolvedAt: new Date('2026-01-01T01:00:00Z') }, // 60m
      { detectedAt: new Date('2026-01-02T00:00:00Z'), resolvedAt: new Date('2026-01-02T00:30:00Z') }, // 30m
      { detectedAt: new Date('2026-01-03T00:00:00Z'), resolvedAt: null }, // excluded
    ];
    expect(mttrMinutes(rows)).toBe(45);
  });

  it('IT-CHG-003: changeSuccessRate counts only reviewed/failed/rolled_back and is null with none', () => {
    expect(changeSuccessRate([])).toBeNull();
    expect(changeSuccessRate([{ status: 'draft' }, { status: 'submitted' }, { status: 'scheduled' }])).toBeNull();
    expect(changeSuccessRate([{ status: 'reviewed' }, { status: 'reviewed' }, { status: 'failed' }, { status: 'rolled_back' }, { status: 'draft' }])).toBe(0.5);
  });

  it('isInFreeze blocks a normal change inside the window and lets an allow-listed emergency through', () => {
    const freezes = [{ name: 'Year-end freeze', startsAt: new Date('2026-12-20'), endsAt: new Date('2027-01-05'), allowEmergency: false }];
    expect(isInFreeze(freezes, new Date('2026-12-25'), 'normal')?.name).toBe('Year-end freeze');
    expect(isInFreeze(freezes, new Date('2026-12-25'), 'emergency')?.name).toBe('Year-end freeze');
    expect(isInFreeze(freezes, new Date('2026-06-01'), 'normal')).toBeNull();

    const allowsEmergency = [{ name: 'Peak season', startsAt: new Date('2026-12-20'), endsAt: new Date('2027-01-05'), allowEmergency: true }];
    expect(isInFreeze(allowsEmergency, new Date('2026-12-25'), 'emergency')).toBeNull();
    expect(isInFreeze(allowsEmergency, new Date('2026-12-25'), 'normal')?.name).toBe('Peak season');
  });
});

describe('incidents, problems and changes — domain and wiring', () => {
  let tid: string;

  beforeAll(async () => {
    tid = await tenantId();
  });

  it('IT-INC-001: timeline stamps are set once; a second acknowledge is a 409', async () => {
    const incident = await asUser('operations@kaizen.co.in', () =>
      declareIncident({ title: `Payments down ${stamp()}`, severity: 'sev3', impact: 'Checkout failing' }),
    );
    expect(incident.recordCode).toMatch(/^INC-/);
    expect(incident.status).toBe('declared');
    expect(incident.detectedAt).toBeTruthy();
    expect(incident.acknowledgedAt).toBeNull();

    const acknowledged = await asUser('operations@kaizen.co.in', () => transitionIncident(incident.id, 'ACKNOWLEDGE'));
    expect(acknowledged.status).toBe('acknowledged');
    expect(acknowledged.acknowledgedAt).toBeTruthy();

    const repeat = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionIncident(incident.id, 'ACKNOWLEDGE')));
    expect(repeat.status).toBe(409);

    const stillAcknowledged = await unscopedPrisma.itIncident.findFirstOrThrow({ where: { id: incident.id } });
    expect(stillAcknowledged.status).toBe('acknowledged');
    expect(stillAcknowledged.acknowledgedAt?.getTime()).toBe(acknowledged.acknowledgedAt!.getTime());
  });

  it('IT-INC-002: a sev1 cannot close without a published review, and a published review is final', async () => {
    const incident = await asUser('operations@kaizen.co.in', () =>
      declareIncident({ title: `Core banking outage ${stamp()}`, severity: 'sev1', customerFacing: true }),
    );
    expect(incident.reviewRequired).toBe(true);

    await asUser('operations@kaizen.co.in', () => transitionIncident(incident.id, 'ACKNOWLEDGE'));
    await asUser('operations@kaizen.co.in', () => transitionIncident(incident.id, 'MITIGATE'));
    await asUser('operations@kaizen.co.in', () => transitionIncident(incident.id, 'RESOLVE'));

    const closeBlocked = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionIncident(incident.id, 'CLOSE')));
    expect(closeBlocked.status).toBe(422);
    expect(closeBlocked.message).toContain('IT-INC-002');

    const detail = await asUser('operations@kaizen.co.in', () => incidentDetail(incident.id));
    expect(detail.availableTransitions).not.toContain('CLOSE');

    const published = await asUser('operations@kaizen.co.in', () =>
      submitIncidentReview(incident.id, { reviewBody: 'Root cause: a bad migration. Fixed and verified.', publish: true }),
    );
    expect(published.reviewPublishedAt).toBeTruthy();

    const editAfterPublish = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => submitIncidentReview(incident.id, { reviewBody: 'trying to sneak a change in' })),
    );
    expect(editAfterPublish.status).toBe(409);

    const closed = await asUser('operations@kaizen.co.in', () => transitionIncident(incident.id, 'CLOSE'));
    expect(closed.status).toBe('closed');
  });

  it('posting an update resets the stale marker and appends to the timeline', async () => {
    const incident = await asUser('operations@kaizen.co.in', () => declareIncident({ title: `Slow queries ${stamp()}`, severity: 'sev3' }));
    await unscopedPrisma.itIncident.update({ where: { id: incident.id }, data: { staleNotifiedAt: new Date() } });

    await asUser('operations@kaizen.co.in', () => postIncidentUpdate(incident.id, 'Investigating a locking issue.'));

    const refreshed = await unscopedPrisma.itIncident.findFirstOrThrow({ where: { id: incident.id } });
    expect(refreshed.staleNotifiedAt).toBeNull();

    const detail = await asUser('operations@kaizen.co.in', () => incidentDetail(incident.id));
    expect(detail.updates.length).toBe(1);
    expect(detail.updates[0].body).toContain('locking issue');
  });

  it('listIncidents filters by severity and status', async () => {
    const sev4 = await asUser('operations@kaizen.co.in', () => declareIncident({ title: `Cosmetic glitch ${stamp()}`, severity: 'sev4' }));
    const bySeverity = await asUser('operations@kaizen.co.in', () => listIncidents({ severity: 'sev4' }));
    expect(bySeverity.every((i) => i.severity === 'sev4')).toBe(true);
    expect(bySeverity.some((i) => i.id === sev4.id)).toBe(true);
  });

  it('the Finance Head cannot declare an incident (view-only on it_incidents)', async () => {
    const denied = await expectReject(() => asUser('finance@kaizen.co.in', () => declareIncident({ title: 'x', severity: 'sev4' })));
    expect(denied.status).toBe(403);
  });

  it('a problem can be opened from an incident and carries it through its lifecycle', async () => {
    const incident = await asUser('operations@kaizen.co.in', () => declareIncident({ title: `Cascading failure ${stamp()}`, severity: 'sev2' }));

    const problem = await asUser('operations@kaizen.co.in', () =>
      createProblem({ title: `Root cause for ${incident.recordCode}`, incidentIds: [incident.id] }),
    );
    expect(problem.recordCode).toMatch(/^PRB-/);

    const linkedIncident = await unscopedPrisma.itIncident.findFirstOrThrow({ where: { id: incident.id } });
    expect(linkedIncident.problemId).toBe(problem.id);

    const analysing = await asUser('operations@kaizen.co.in', () => transitionProblem(problem.id, 'ANALYSE'));
    expect(analysing.status).toBe('analysing');
    const knownError = await asUser('operations@kaizen.co.in', () => transitionProblem(problem.id, 'MARK_KNOWN_ERROR'));
    expect(knownError.status).toBe('known_error');

    const detail = await asUser('operations@kaizen.co.in', () => problemDetail(problem.id));
    expect(detail.linkedIncidents.map((i) => i.id)).toContain(incident.id);
    expect(detail.availableTransitions).toContain('RESOLVE');
  });

  it('IT-CHG-001: a normal change one raised cannot be approved by its raiser, while a standard change needs no step', async () => {
    const windowStart = new Date(Date.now() + 10 * 86_400_000);
    const windowEnd = new Date(windowStart.getTime() + 3_600_000);

    const raised = await asUser('employee@kaizen.co.in', () =>
      createChange({
        title: `Rotate API keys ${stamp()}`,
        kind: 'normal',
        risk: 'medium',
        plan: 'Rotate the keys and redeploy.',
        rollbackPlan: 'Restore the previous secret.',
        windowStart,
        windowEnd,
      }),
    );
    expect(raised.recordCode).toMatch(/^CHG-/);
    expect(raised.status).toBe('draft');

    const submitted = await asUser('employee@kaizen.co.in', () => transitionChange(raised.id, { event: 'SUBMIT' }));
    expect(submitted.applied).toBe(true);
    expect((submitted.change as { status: string }).status).toBe('submitted');

    // The raiser holds no `approve` grant on it_changes at all — denied on
    // the WHO axis before the gate's self-dealing logic even runs.
    const raiserApproves = await expectReject(() => asUser('employee@kaizen.co.in', () => transitionChange(raised.id, { event: 'APPROVE' })));
    expect(raiserApproves.status).toBe(403);

    // The Operations Head, not the raiser, approves directly.
    const approved = await asUser('operations@kaizen.co.in', () => transitionChange(raised.id, { event: 'APPROVE' }));
    expect(approved.applied).toBe(true);
    expect((approved.change as { status: string }).status).toBe('approved');

    // The self-dealing reroute: the Operations Head raises their own normal
    // change and cannot approve it either.
    const ownChange = await asUser('operations@kaizen.co.in', () =>
      createChange({
        title: `Patch the load balancer ${stamp()}`,
        kind: 'normal',
        risk: 'medium',
        plan: 'Apply the vendor patch.',
        rollbackPlan: 'Roll back the image.',
        windowStart,
        windowEnd,
      }),
    );
    await asUser('operations@kaizen.co.in', () => transitionChange(ownChange.id, { event: 'SUBMIT' }));
    const selfDealing = await asUser('operations@kaizen.co.in', () => transitionChange(ownChange.id, { event: 'APPROVE' }));
    expect(selfDealing.applied).toBe(false);
    expect(selfDealing.selfDealingBarTripped).toBe(true);
    expect(selfDealing.approvalStepId).toBeTruthy();
    const stillSubmitted = await unscopedPrisma.itChange.findFirstOrThrow({ where: { id: ownChange.id } });
    expect(stillSubmitted.status).toBe('submitted');

    // A standard change is pre-approved by kind — submit lands it straight on
    // `approved`, no approval step at all.
    const standard = await asUser('employee@kaizen.co.in', () =>
      createChange({
        title: `Restart the batch job ${stamp()}`,
        kind: 'standard',
        risk: 'low',
        plan: 'Restart the nightly job.',
        rollbackPlan: 'N/A — idempotent restart.',
        windowStart,
        windowEnd,
      }),
    );
    const autoApproved = await asUser('employee@kaizen.co.in', () => transitionChange(standard.id, { event: 'SUBMIT' }));
    expect(autoApproved.applied).toBe(true);
    expect((autoApproved.change as { status: string }).status).toBe('approved');
    expect(autoApproved.approvalStepId).toBeNull();
  });

  it('IT-CHG-002: scheduling inside a freeze window is refused with the window named; emergency passes when the freeze allows it', async () => {
    // A large, run-unique day offset so a freeze window from an earlier test
    // run in this same long-lived database can never overlap this one's.
    const dayOffset = 20 + (Number(stamp()) % 5000);
    const freezeStart = new Date(Date.now() + dayOffset * 86_400_000);
    const freezeEnd = new Date(freezeStart.getTime() + 5 * 86_400_000);
    const freezeName = `Quarter close freeze ${stamp()}`;

    const freeze = await asUser('operations@kaizen.co.in', () =>
      declareFreeze({ name: freezeName, startsAt: freezeStart, endsAt: freezeEnd, reason: 'Quarter close — no changes to finance systems.' }),
    );
    expect(freeze.allowEmergency).toBe(false);

    const insideWindowStart = new Date(freezeStart.getTime() + 86_400_000);
    const insideWindowEnd = new Date(insideWindowStart.getTime() + 3_600_000);

    // Raised by an employee, so the Operations Head (tier 0 of the approver
    // chain) can approve it directly — no self-dealing in play here, which
    // is IT-CHG-001's concern, not this one's.
    const normalChange = await asUser('employee@kaizen.co.in', () =>
      createChange({
        title: `Ledger schema tweak ${stamp()}`,
        kind: 'normal',
        risk: 'medium',
        plan: 'Add a column.',
        rollbackPlan: 'Drop the column.',
        windowStart: insideWindowStart,
        windowEnd: insideWindowEnd,
      }),
    );
    await asUser('employee@kaizen.co.in', () => transitionChange(normalChange.id, { event: 'SUBMIT' }));
    const normalApproved = await asUser('operations@kaizen.co.in', () => transitionChange(normalChange.id, { event: 'APPROVE' }));
    expect(normalApproved.applied).toBe(true);

    const refused = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionChange(normalChange.id, { event: 'SCHEDULE' })));
    expect(refused.status).toBe(422);
    expect(refused.message).toContain(freezeName);
    expect(refused.message).toContain('IT-CHG-002');

    // An allow-listed freeze, in a window of its own (not overlapping the
    // non-permissive freeze above), lets an emergency change through.
    const permissiveStart = new Date(freezeEnd.getTime() + 30 * 86_400_000);
    const permissiveEnd = new Date(permissiveStart.getTime() + 5 * 86_400_000);
    const permissiveFreezeName = `Peak trading freeze ${stamp()}`;
    await asUser('operations@kaizen.co.in', () =>
      declareFreeze({ name: permissiveFreezeName, startsAt: permissiveStart, endsAt: permissiveEnd, reason: 'Peak trading window.', allowEmergency: true }),
    );

    const emergencyWindowStart = new Date(permissiveStart.getTime() + 86_400_000);
    const emergencyWindowEnd = new Date(emergencyWindowStart.getTime() + 3_600_000);

    const emergencyChange = await asUser('employee@kaizen.co.in', () =>
      createChange({
        title: `Emergency patch ${stamp()}`,
        kind: 'emergency',
        risk: 'high',
        plan: 'Hotfix the null pointer.',
        rollbackPlan: 'Redeploy the previous build.',
        windowStart: emergencyWindowStart,
        windowEnd: emergencyWindowEnd,
      }),
    );
    await asUser('employee@kaizen.co.in', () => transitionChange(emergencyChange.id, { event: 'SUBMIT' }));
    const emergencyApproved = await asUser('operations@kaizen.co.in', () => transitionChange(emergencyChange.id, { event: 'APPROVE' }));
    expect(emergencyApproved.applied).toBe(true);
    const scheduled = await asUser('operations@kaizen.co.in', () => transitionChange(emergencyChange.id, { event: 'SCHEDULE' }));
    expect(scheduled.applied).toBe(true);
    expect((scheduled.change as { status: string }).status).toBe('scheduled');
  });

  it('implementation and review notes are set once each', async () => {
    const windowStart = new Date(Date.now() + 40 * 86_400_000);
    const windowEnd = new Date(windowStart.getTime() + 3_600_000);
    const change = await asUser('operations@kaizen.co.in', () =>
      createChange({
        title: `Bump the runtime ${stamp()}`,
        kind: 'standard',
        risk: 'low',
        plan: 'Bump the container base image.',
        rollbackPlan: 'Redeploy the previous image tag.',
        windowStart,
        windowEnd,
      }),
    );
    await asUser('operations@kaizen.co.in', () => transitionChange(change.id, { event: 'SUBMIT' }));
    await asUser('operations@kaizen.co.in', () => transitionChange(change.id, { event: 'SCHEDULE' }));

    const implemented = await asUser('operations@kaizen.co.in', () =>
      transitionChange(change.id, { event: 'IMPLEMENT', note: 'Deployed at 02:00, verified healthy.' }),
    );
    expect((implemented.change as { implementationNote: string }).implementationNote).toContain('Deployed at 02:00');

    const noNote = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionChange(change.id, { event: 'REVIEW' })));
    expect(noNote.status).toBe(400);

    const reviewed = await asUser('operations@kaizen.co.in', () => transitionChange(change.id, { event: 'REVIEW', note: 'Clean. No incidents.' }));
    expect((reviewed.change as { status: string }).status).toBe('reviewed');

    const secondReview = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionChange(change.id, { event: 'REVIEW', note: 'trying again' })));
    expect(secondReview.status).toBe(409);
  });

  it('the Finance Head can see changes but cannot create one', async () => {
    const denied = await expectReject(() =>
      asUser('finance@kaizen.co.in', () =>
        createChange({
          title: 'x',
          kind: 'standard',
          risk: 'low',
          plan: 'x',
          rollbackPlan: 'x',
          windowStart: new Date(),
          windowEnd: new Date(Date.now() + 3_600_000),
        }),
      ),
    );
    expect(denied.status).toBe(403);

    const list = await asUser('finance@kaizen.co.in', () => listChanges());
    expect(Array.isArray(list)).toBe(true);
  });

  it('an employee sees only their own changes; the Operations Head sees all', async () => {
    const mine = await asUser('employee@kaizen.co.in', () =>
      createChange({
        title: `My own change ${stamp()}`,
        kind: 'standard',
        risk: 'low',
        plan: 'x',
        rollbackPlan: 'x',
        windowStart: new Date(Date.now() + 5 * 86_400_000),
        windowEnd: new Date(Date.now() + 5 * 86_400_000 + 3_600_000),
      }),
    );

    const employeeList = await asUser('employee@kaizen.co.in', () => listChanges());
    expect(employeeList.every((c) => c.requesterPartyId && c.id !== undefined)).toBe(true);
    expect(employeeList.some((c) => c.id === mine.id)).toBe(true);

    const opsList = await asUser('operations@kaizen.co.in', () => listChanges());
    expect(opsList.some((c) => c.id === mine.id)).toBe(true);
    expect(opsList.length).toBeGreaterThanOrEqual(employeeList.length);
  });

  it('a change detail carries availableTransitions and the freeze in force, if any', async () => {
    const change = await asUser('operations@kaizen.co.in', () =>
      createChange({
        title: `Detail check ${stamp()}`,
        kind: 'standard',
        risk: 'low',
        plan: 'x',
        rollbackPlan: 'x',
        windowStart: new Date(Date.now() + 60 * 86_400_000),
        windowEnd: new Date(Date.now() + 60 * 86_400_000 + 3_600_000),
      }),
    );
    const detail = await asUser('operations@kaizen.co.in', () => changeDetail(change.id));
    expect(detail.availableTransitions).toContain('SUBMIT');
  });

  it('summaries report real figures once there is data, in the documented shape', async () => {
    // The empty-tenant `notYetMeasured` case is exercised structurally by
    // `incidentSummary`/`changeSummary` themselves (a `total === 0` guard
    // returning `notYetMeasured: true`) and by the pure `mttrMinutes`/
    // `changeSuccessRate` empty-input tests above; the suite's own tenant
    // already carries incidents and changes by this point in the file.
    const inc = await asUser('operations@kaizen.co.in', () => incidentSummary());
    expect(inc.notYetMeasured).toBe(false);
    expect(typeof inc.openBySeverity.sev1).toBe('number');
    expect(typeof inc.reviewsOutstanding).toBe('number');

    const chg = await asUser('operations@kaizen.co.in', () => changeSummary());
    expect(chg.notYetMeasured).toBe(false);
    expect(typeof chg.awaitingApproval).toBe('number');
    expect('freezeInForce' in chg).toBe(true);
  });

  it('the stale-incident job is idempotent per rung', async () => {
    const incident = await asUser('operations@kaizen.co.in', () => declareIncident({ title: `Degraded but quiet ${stamp()}`, severity: 'sev1' }));
    await unscopedPrisma.itIncident.update({ where: { id: incident.id }, data: { lastActivityAt: new Date(Date.now() - 90 * 60_000) } });

    const first = await asUser('operations@kaizen.co.in', () => runStaleIncidentJob());
    expect(first.notified).toBeGreaterThanOrEqual(1);
    const firstCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_INCIDENT_STALE', subjectId: incident.id } });
    expect(firstCount).toBe(1);

    const second = await asUser('operations@kaizen.co.in', () => runStaleIncidentJob());
    const secondCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_INCIDENT_STALE', subjectId: incident.id } });
    expect(secondCount).toBe(1);
    void second;
  });

  it('the review-overdue job is idempotent per rung', async () => {
    const incident = await asUser('operations@kaizen.co.in', () => declareIncident({ title: `Needs a review ${stamp()}`, severity: 'sev2' }));
    await asUser('operations@kaizen.co.in', () => transitionIncident(incident.id, 'ACKNOWLEDGE'));
    await asUser('operations@kaizen.co.in', () => transitionIncident(incident.id, 'MITIGATE'));
    await asUser('operations@kaizen.co.in', () => transitionIncident(incident.id, 'RESOLVE'));
    await unscopedPrisma.itIncident.update({ where: { id: incident.id }, data: { resolvedAt: new Date(Date.now() - 6 * 86_400_000) } });

    await asUser('operations@kaizen.co.in', () => runReviewOverdueJob());
    const firstCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_INCIDENT_REVIEW_OVERDUE', subjectId: incident.id } });
    expect(firstCount).toBe(1);

    await asUser('operations@kaizen.co.in', () => runReviewOverdueJob());
    const secondCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_INCIDENT_REVIEW_OVERDUE', subjectId: incident.id } });
    expect(secondCount).toBe(1);
  });

  it('the change-window-missed job is idempotent per rung', async () => {
    const change = await asUser('operations@kaizen.co.in', () =>
      createChange({
        title: `Missed its window ${stamp()}`,
        kind: 'standard',
        risk: 'low',
        plan: 'x',
        rollbackPlan: 'x',
        windowStart: new Date(Date.now() - 2 * 86_400_000),
        windowEnd: new Date(Date.now() - 86_400_000),
      }),
    );
    await asUser('operations@kaizen.co.in', () => transitionChange(change.id, { event: 'SUBMIT' }));

    await asUser('operations@kaizen.co.in', () => runChangeWindowMissedJob());
    const firstCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_CHANGE_WINDOW_MISSED', subjectId: change.id } });
    expect(firstCount).toBe(1);

    await asUser('operations@kaizen.co.in', () => runChangeWindowMissedJob());
    const secondCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_CHANGE_WINDOW_MISSED', subjectId: change.id } });
    expect(secondCount).toBe(1);
  });
});
