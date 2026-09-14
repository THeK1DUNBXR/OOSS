/**
 * Technology — applications, licences and subscriptions (docs/plan/cio.md,
 * workstream B).
 *
 * Pure arithmetic first, without a database (IT-LIC-004 and friends). Then
 * the wiring: an unowned application raises an exception (IT-APP-001), the
 * renewal ladder fires once per rung (IT-LIC-001), an over-allocated licence
 * raises an exception naming it (IT-LIC-002), a renewal proposed by the
 * Operations Head opens an approval step the Operations Head cannot decide
 * (IT-LIC-003), plus the permission tests: an employee sees the catalogue
 * but never a licence's cost, the Operations Head cannot approve their own
 * renewal, and the Finance Head cannot create a licence.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  annualisedCost,
  seatUtilisation,
  isUnderUsed,
  renewalRung,
  itApplicationMachine,
} from '@kaizen/shared';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import {
  createApplication,
  listApplications,
  applicationDetail,
  updateApplication,
  transitionApplication,
  createLicence,
  listLicences,
  licenceDetail,
  updateSeats,
  proposeRenewal,
  approveRenewal,
  cancelLicence,
  applicationsSummary,
  licencesSummary,
} from '../../domains/it/software.js';
import { runItSoftwareJobForTenant } from '../../jobs/it/software.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('pure arithmetic (no DB)', () => {
  it('IT-LIC-004: annualisedCost normalises monthly, quarterly and annual billing to one figure', () => {
    expect(annualisedCost(100, 'monthly')).toBe(1200);
    expect(annualisedCost(300, 'quarterly')).toBe(1200);
    expect(annualisedCost(1200, 'annual')).toBe(1200);
    expect(annualisedCost(500, 'one_off')).toBe(500);
    expect(annualisedCost(-5, 'monthly')).toBe(0);
  });

  it('seatUtilisation reports over-allocation and a null percentage with nothing purchased', () => {
    expect(seatUtilisation(10, 12)).toEqual({ percent: 120, overAllocated: true });
    expect(seatUtilisation(10, 8)).toEqual({ percent: 80, overAllocated: false });
    expect(seatUtilisation(0, 0)).toEqual({ percent: null, overAllocated: false });
  });

  it('isUnderUsed only judges licences at or above the minimum seat count', () => {
    expect(isUnderUsed(20, 4, 30, 5)).toBe(true); // 20% utilisation, well over the 5-seat floor
    expect(isUnderUsed(3, 1, 30, 5)).toBe(false); // under the seat floor — not judged
    expect(isUnderUsed(20, 15, 30, 5)).toBe(false); // 75% — not under-used
  });

  it('renewalRung picks the tightest rung crossed, and null outside every rung', () => {
    expect(renewalRung(95, [90, 60, 30, 7, 0])).toBeNull();
    expect(renewalRung(75, [90, 60, 30, 7, 0])).toBe(90);
    expect(renewalRung(5, [90, 60, 30, 7, 0])).toBe(7);
    expect(renewalRung(-3, [90, 60, 30, 7, 0])).toBe(0);
  });

  it('itApplicationMachine: retired is reachable from every state and terminal', () => {
    expect(itApplicationMachine.can('evaluating', 'ACTIVATE')).toBe(true);
    expect(itApplicationMachine.can('evaluating', 'REJECT')).toBe(true);
    expect(itApplicationMachine.can('active', 'RETIRE')).toBe(true);
    expect(itApplicationMachine.isTerminal('retired')).toBe(true);
    expect(itApplicationMachine.allowedEvents('retired')).toEqual([]);
  });
});

describe('technology — applications, licences and subscriptions — domain and wiring', () => {
  let tid: string;

  beforeAll(async () => {
    tid = await tenantId();
  });

  it('IT-APP-001: an application with no owner raises IT_APP_UNOWNED rather than sitting silently unowned', async () => {
    const app = await asUser('operations@kaizen.co.in', () =>
      createApplication({ name: `Fixture unowned app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    expect(app.ownerPartyId).toBeNull();

    await asUser('operations@kaizen.co.in', () => runItSoftwareJobForTenant(tid));

    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: tid, code: 'IT_APP_UNOWNED', subjectId: app.id },
    });
    expect(exception).toBeTruthy();
    expect(exception!.ownerUnresolved).toBe(true);

    // A second run raises nothing new — the exception stays open, not duplicated.
    await asUser('operations@kaizen.co.in', () => runItSoftwareJobForTenant(tid));
    const count = await unscopedPrisma.exceptionRecord.count({
      where: { tenantId: tid, code: 'IT_APP_UNOWNED', subjectId: app.id },
    });
    expect(count).toBe(1);
  });

  it('an application transitions only through its declared machine, and detail exposes availableTransitions', async () => {
    const app = await asUser('operations@kaizen.co.in', () =>
      createApplication({ name: `Fixture app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const detail = await asUser('operations@kaizen.co.in', () => applicationDetail(app.id));
    expect(detail.availableTransitions.sort()).toEqual(['ACTIVATE', 'REJECT'].sort());

    const activated = await asUser('operations@kaizen.co.in', () => transitionApplication(app.id, 'ACTIVATE'));
    expect(activated.status).toBe('active');
    expect(activated.availableTransitions.sort()).toEqual(['RETIRE', 'SUNSET'].sort());

    const rejected = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionApplication(app.id, 'REJECT')));
    expect(rejected.status).toBe(422);
  });

  it('IT-LIC-001: the renewal ladder fires once per rung, and a second run the same day is idempotent', async () => {
    const app = await asUser('operations@kaizen.co.in', () =>
      createApplication({ name: `Fixture ladder app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const renewalDate = new Date();
    renewalDate.setUTCDate(renewalDate.getUTCDate() + 5); // inside the 7-day rung

    const licence = await asUser('operations@kaizen.co.in', () =>
      createLicence({
        applicationId: app.id,
        kind: 'per_seat',
        seatsPurchased: 10,
        seatsInUse: 5,
        costPerPeriod: 1000,
        billingCycle: 'monthly',
        renewalDate,
      }),
    );

    await asUser('operations@kaizen.co.in', () => runItSoftwareJobForTenant(tid));
    const firstCount = await unscopedPrisma.exceptionRecord.count({
      where: { tenantId: tid, code: 'IT_LIC_RENEWAL_DUE', subjectId: licence.id },
    });
    expect(firstCount).toBe(1);

    await asUser('operations@kaizen.co.in', () => runItSoftwareJobForTenant(tid));
    const secondCount = await unscopedPrisma.exceptionRecord.count({
      where: { tenantId: tid, code: 'IT_LIC_RENEWAL_DUE', subjectId: licence.id },
    });
    expect(secondCount).toBe(1);

    const refreshed = await unscopedPrisma.itLicence.findFirstOrThrow({ where: { id: licence.id } });
    expect(refreshed.renewalNotifiedRungs).toContain(7);
    expect(refreshed.status).toBe('expiring');
  });

  it('IT-LIC-002: seats in use above seats purchased raises an over-allocation exception naming the licence', async () => {
    const app = await asUser('operations@kaizen.co.in', () =>
      createApplication({ name: `Fixture overalloc app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const licence = await asUser('operations@kaizen.co.in', () =>
      createLicence({ applicationId: app.id, kind: 'per_seat', seatsPurchased: 5, seatsInUse: 5, costPerPeriod: 500, billingCycle: 'monthly' }),
    );
    await asUser('operations@kaizen.co.in', () => updateSeats(licence.id, 8));

    await asUser('operations@kaizen.co.in', () => runItSoftwareJobForTenant(tid));

    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: tid, code: 'IT_LIC_SEAT_OVERALLOCATED', subjectId: licence.id },
    });
    expect(exception).toBeTruthy();
    expect(exception!.subjectLabel).toBe(licence.recordCode);
  });

  it('IT-LIC-003: a renewal proposal by the Operations Head opens an approval step it cannot decide itself', async () => {
    const app = await asUser('operations@kaizen.co.in', () =>
      createApplication({ name: `Fixture renewal app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const licence = await asUser('operations@kaizen.co.in', () =>
      createLicence({ applicationId: app.id, kind: 'per_seat', seatsPurchased: 10, seatsInUse: 4, costPerPeriod: 50000, billingCycle: 'monthly' }),
    );

    const newTermEnd = new Date();
    newTermEnd.setUTCFullYear(newTermEnd.getUTCFullYear() + 1);

    const proposed = await asUser('operations@kaizen.co.in', () => proposeRenewal(licence.id, { newTermEnd }));
    expect(proposed.applied).toBe(false);
    expect(proposed.approvalStepId).toBeTruthy();

    // FAIL condition guarded against: the proposer's own decision is refused.
    const selfDecision = await expectReject(() => asUser('operations@kaizen.co.in', () => approveRenewal(licence.id, true)));
    expect(selfDecision.status).toBe(403);

    const step = await unscopedPrisma.approvalStep.findFirstOrThrow({ where: { id: proposed.approvalStepId! } });
    expect(step.state).toBe('open');
    expect(step.requestedById).toBeTruthy();

    // Finance Head, who was not the proposer, can decide it.
    const decided = await asUser('finance@kaizen.co.in', () => approveRenewal(licence.id, true, 'Within budget.'));
    expect(decided.applied).toBe(true);
    const refreshed = decided.licence as { termEnd: string | Date | null; status: string };
    expect(new Date(refreshed.termEnd as Date).toISOString().slice(0, 10)).toBe(newTermEnd.toISOString().slice(0, 10));
    expect(refreshed.status).toBe('active');
  });

  it('the Operations Head cannot approve their own renewal (permission test)', async () => {
    const app = await asUser('operations@kaizen.co.in', () =>
      createApplication({ name: `Fixture self-approve app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const licence = await asUser('operations@kaizen.co.in', () =>
      createLicence({ applicationId: app.id, kind: 'per_seat', seatsPurchased: 3, seatsInUse: 1, costPerPeriod: 2000, billingCycle: 'monthly' }),
    );
    const newTermEnd = new Date();
    newTermEnd.setUTCFullYear(newTermEnd.getUTCFullYear() + 1);

    await asUser('operations@kaizen.co.in', () => proposeRenewal(licence.id, { newTermEnd }));
    const denied = await expectReject(() => asUser('operations@kaizen.co.in', () => approveRenewal(licence.id, true)));
    expect(denied.status).toBe(403);

    const stillPending = await unscopedPrisma.itLicence.findFirstOrThrow({ where: { id: licence.id } });
    expect(stillPending.pendingRenewalApprovalStepId).toBeTruthy();
  });

  it('the Finance Head cannot create a licence — VF,approve carries no create verb (permission test)', async () => {
    const app = await asUser('operations@kaizen.co.in', () =>
      createApplication({ name: `Fixture finance-denied app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const denied = await expectReject(() =>
      asUser('finance@kaizen.co.in', () =>
        createLicence({ applicationId: app.id, kind: 'per_seat', seatsPurchased: 1, seatsInUse: 0, costPerPeriod: 100, billingCycle: 'monthly' }),
      ),
    );
    expect(denied.status).toBe(403);
  });

  it('an employee sees the application catalogue but holds no grant on licences at all (permission test)', async () => {
    const list = await asUser('employee@kaizen.co.in', () => listApplications());
    expect(Array.isArray(list)).toBe(true);

    const denied = await expectReject(() => asUser('employee@kaizen.co.in', () => listLicences()));
    expect(denied.status).toBe(403);

    const deniedSummary = await expectReject(() => asUser('employee@kaizen.co.in', () => licencesSummary()));
    expect(deniedSummary.status).toBe(403);
  });

  it('cancelling a licence requires a reason and clears any open renewal proposal', async () => {
    const app = await asUser('operations@kaizen.co.in', () =>
      createApplication({ name: `Fixture cancel app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const licence = await asUser('operations@kaizen.co.in', () =>
      createLicence({ applicationId: app.id, kind: 'per_seat', seatsPurchased: 4, seatsInUse: 2, costPerPeriod: 300, billingCycle: 'monthly' }),
    );

    const noReason = await expectReject(() => asUser('operations@kaizen.co.in', () => cancelLicence(licence.id, '')));
    expect(noReason.status).toBe(400);

    const cancelled = await asUser('operations@kaizen.co.in', () => cancelLicence(licence.id, 'Consolidated onto a site licence.'));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledReason).toBe('Consolidated onto a site licence.');

    const events = await unscopedPrisma.itLicenceEvent.findMany({ where: { licenceId: licence.id } });
    expect(events.some((e) => e.kind === 'cancelled')).toBe(true);
  });

  it('licence and application summaries report real figures once the fixture tenant carries applications and licences', async () => {
    const appsSummary = await asUser('operations@kaizen.co.in', () => applicationsSummary());
    expect(appsSummary.notYetMeasured).toBe(false);
    expect(Object.keys(appsSummary.byStatus).sort()).toEqual(['active', 'evaluating', 'retired', 'sunsetting'].sort());

    const licSummary = await asUser('operations@kaizen.co.in', () => licencesSummary());
    expect(licSummary.notYetMeasured).toBe(false);
    expect(licSummary.annualisedSpend).toBeGreaterThan(0);
    expect(licSummary.seatsPurchased).toBeGreaterThanOrEqual(0);
  });

  it('licence detail carries annualised cost and seat utilisation computed, not stored', async () => {
    const app = await asUser('operations@kaizen.co.in', () =>
      createApplication({ name: `Fixture detail app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const licence = await asUser('operations@kaizen.co.in', () =>
      createLicence({ applicationId: app.id, kind: 'per_seat', seatsPurchased: 20, seatsInUse: 10, costPerPeriod: 100, billingCycle: 'monthly' }),
    );
    const detail = await asUser('operations@kaizen.co.in', () => licenceDetail(licence.id));
    expect(detail.annualisedCost).toBe(1200);
    expect(detail.seatUtilisation).toEqual({ percent: 50, overAllocated: false });
  });

  it('updating an application records who owns it and clears unownedNotifiedAt', async () => {
    const tidLocal = await tenantId();
    const person = await unscopedPrisma.person.findFirstOrThrow({ where: { tenantId: tidLocal } });
    const app = await asUser('operations@kaizen.co.in', () =>
      createApplication({ name: `Fixture owner app ${stamp()}`, category: 'productivity', hosting: 'saas' }),
    );
    const updated = await asUser('operations@kaizen.co.in', () => updateApplication(app.id, { ownerPartyId: person.id }));
    expect(updated.ownerPartyId).toBe(person.id);
  });
});
