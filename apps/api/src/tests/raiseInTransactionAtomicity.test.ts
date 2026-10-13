/**
 * An exception raised as a consequence of a governed write commits or vanishes
 * with that write.
 *
 * When a write and the exception it implies were separate transactions, the
 * write could commit and the raise then fail, leaving a changed row with no
 * exception to act on. These tests make the audit insert for `exception` rows
 * fail on purpose (a test-only trigger, installed for one call) and check that
 * the domain row is back where it was once the call rejects.
 *
 * The trigger is scoped to exception audit rows, so the domain write's own audit
 * row still succeeds: on the old code the domain write commits and only the
 * raise fails, which is the orphan this file is about.
 *
 * Real Postgres and the real decision paths. The trigger is a fault injection,
 * not a mock: the insert really is refused by the database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  asUser,
  booksTenant,
  closeThrough,
  expectReject,
  prisma,
  principalFor,
  reopenLatestFirst,
  tenantId,
  unscopedPrisma,
  type BooksTenant,
} from './helpers.js';
import { markChallanPaid } from '../domains/compliance/tax.js';
import { closeRound, createRound } from '../domains/rounds.js';
import { accrueEntitlement, createLeaveRequest, transitionLeaveRequest, leaveBalances } from '../domains/leave.js';
import { hire, transitionEmployment } from '../domains/employment.js';
import { createPartnerAgreement } from '../domains/agreements.js';
import { createApplication, createLicence, proposeRenewal } from '../domains/it/software.js';
import { createPlan, recordTest, transitionPlan } from '../domains/it/continuity.js';
import { campaignDetail, decideItem, openCampaign } from '../domains/it/governance.js';
import { rejectRegularisation, submitRegularisation } from '../domains/hcm/time.js';
import { changeForecastCategory } from '../domains/opportunities.js';
import { decideApprovalStep } from '../platform/approvals.js';
import { submitResignation } from '../domains/hcm/separations.js';
import { createQuote, issueQuote } from '../domains/commercial.js';
import { nextRecordCode } from '../platform/recordCode.js';

const CLOSED = '2017-10';
const FINANCE = 'finance@kaizen.co.in';
const CHAIRMAN = 'chairman@kaizen.co.in';
const INJECTED = 'injected exception audit failure';

let TENANT: string;

async function refuseExceptionAudit(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION w2_refuse_exception_audit() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION '${INJECTED}'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER w2_refuse_exception_audit BEFORE INSERT ON audit_records
     FOR EACH ROW WHEN (NEW."subjectType" = 'exception')
     EXECUTE FUNCTION w2_refuse_exception_audit()`,
  );
}

async function restoreExceptionAudit(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w2_refuse_exception_audit ON audit_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w2_refuse_exception_audit()`);
}

async function refuseNotificationInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION w2_refuse_notification_insert() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION '${INJECTED}'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER w2_refuse_notification_insert BEFORE INSERT ON notifications
     FOR EACH ROW EXECUTE FUNCTION w2_refuse_notification_insert()`,
  );
}

async function restoreNotificationInserts(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w2_refuse_notification_insert ON notifications`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w2_refuse_notification_insert()`);
}

afterEach(async () => {
  await restoreExceptionAudit();
  await restoreNotificationInserts();
});

beforeAll(async () => {
  TENANT = await tenantId();
});

function unique(label: string): string {
  return `${label} ${Math.random().toString(36).slice(2, 10)}`;
}

describe('a challan paid in a closed period raises EX-FIN-008 in the same transaction', () => {
  // Its own books tenant: this is the only block that needs 2017-10 closed, and a close in `kaizen`
  // freezes every row-less month below it for every other file (W7-F4).
  let BOOKS: BooksTenant;

  beforeAll(async () => {
    BOOKS = await booksTenant('raise-atomic-test');
    await reopenLatestFirst(BOOKS, 'Test fixture reset at the start of the run');
    await closeThrough(BOOKS, CLOSED);
  });

  afterAll(async () => {
    await reopenLatestFirst(BOOKS, 'Challan atomicity test finished; reopening the months it closed');
  });

  it('when the raise cannot be recorded, the challan stays unpaid and the call rejects', async () => {
    const challan = await unscopedPrisma.tdsChallan.create({
      data: {
        tenantId: BOOKS.tenantId,
        recordCode: unique('W2-ATOMIC-CHALLAN'),
        month: '2026-09',
        sectionGroup: '194C_IND',
        amountMinor: 10000n,
        deducteeCount: 1,
      },
    });

    await refuseExceptionAudit();
    await expectReject(() =>
      asUser(BOOKS.chairman, () =>
        markChallanPaid(challan.id, {
          bsrCode: '0000000',
          challanNo: unique('W2-ATOMIC'),
          paidOn: new Date('2017-10-15T06:00:00Z'),
        }),
      ),
    );

    const after = await unscopedPrisma.tdsChallan.findUniqueOrThrow({ where: { id: challan.id } });
    expect(after.status).not.toBe('paid');
    expect(after.paidOn).toBeNull();
    expect(
      await unscopedPrisma.exceptionRecord.count({
        where: { tenantId: BOOKS.tenantId, code: 'EX-FIN-008', subjectId: challan.id },
      }),
    ).toBe(0);
  });
});

describe('closing a funding round raises the PAS-3 return exception in the same transaction', () => {
  it('when the raise cannot be recorded, the round stays open and the call rejects', async () => {
    const round = await asUser(CHAIRMAN, () => createRound({ name: unique('W2-ATOMIC-ROUND'), kind: 'rights_issue' }));
    await unscopedPrisma.fundingRound.update({ where: { id: round.id }, data: { status: 'open' } });

    await refuseExceptionAudit();
    await expectReject(() => asUser(CHAIRMAN, () => closeRound(round.id)));

    const after = await unscopedPrisma.fundingRound.findUniqueOrThrow({ where: { id: round.id } });
    expect(after.status).toBe('open');
    expect(after.closedOn).toBeNull();
    expect(
      await unscopedPrisma.exceptionRecord.count({
        where: { tenantId: TENANT, code: 'EX-EQT-003', subjectId: round.id },
      }),
    ).toBe(0);
  });
});

describe('approving leave taken beyond entitlement raises EX-HR-004 in the same transaction', () => {
  it('when the raise cannot be recorded, the request is not approved and no hold is posted', async () => {
    const HR = 'hr@kaizen.co.in';
    // A throwaway employee: a request approved here would leave a hold on a seeded
    // person that the other leave tests read.
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { employment, leaveType } = await asUser(HR, async () => {
      const position = await prisma.position.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('POS'),
          jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
          orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
          status: 'Open',
        },
      });
      const person = await prisma.person.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('PER'),
          fullName: `Atomicity leave ${stamp}`,
          primaryEmail: `atomic.leave.${stamp}@example.com`,
          source: 'test',
        },
      });
      const hired = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
      await transitionEmployment(hired.id, 'ACTIVATE');
      const type = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: TENANT, code: 'CL' } });
      await accrueEntitlement({ employmentRelationshipId: hired.id, leaveTypeId: type.id, days: 2 });
      return { employment: hired, leaveType: type };
    });

    // Far more days than the two accrued, so the approval's hold takes the balance negative.
    const request = await asUser(HR, () =>
      createLeaveRequest({
        employmentRelationshipId: employment.id,
        leaveTypeId: leaveType.id,
        startDate: new Date(Date.now() + 90 * 86_400_000),
        endDate: new Date(Date.now() + 900 * 86_400_000),
        days: 500,
      }),
    );
    await asUser(HR, async () => {
      await transitionLeaveRequest(request.id, 'SUBMIT');
      await transitionLeaveRequest(request.id, 'ROUTE_FOR_APPROVAL');
    });
    const before = await unscopedPrisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    const balanceBefore = await asUser(HR, () => leaveBalances(employment.id));

    await refuseExceptionAudit();
    await expectReject(() => asUser(HR, () => transitionLeaveRequest(request.id, 'APPROVE')));

    const after = await unscopedPrisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.status).toBe(before.status);
    const balanceAfter = await asUser(HR, () => leaveBalances(employment.id));
    const balanceOf = (rows: { leaveTypeId: string; balanceDays: unknown }[]) =>
      Number(rows.find((b) => b.leaveTypeId === leaveType.id)?.balanceDays ?? 0);
    expect(balanceOf(balanceAfter)).toBe(balanceOf(balanceBefore));
    expect(
      await unscopedPrisma.exceptionRecord.count({
        where: { tenantId: TENANT, code: 'EX-HR-004', subjectId: request.id },
      }),
    ).toBe(0);
  });
});

describe('a partner agreement that duplicates an active channel raises EX-CRM-013 in the same transaction', () => {
  it('when the raise cannot be recorded, no agreement is written', async () => {
    const active = await unscopedPrisma.partnerAgreement.findFirstOrThrow({
      where: { tenantId: TENANT, status: { in: ['signed', 'active'] }, deletedAt: null },
    });
    const title = unique('W2-ATOMIC-AGREEMENT');
    const before = await unscopedPrisma.partnerAgreement.count({ where: { tenantId: TENANT, title } });

    await refuseExceptionAudit();
    await expectReject(() =>
      asUser(CHAIRMAN, () =>
        createPartnerAgreement({
          title,
          partnerOrganizationId: active.partnerOrganizationId,
          agreementType: active.agreementType as never,
        }),
      ),
    );

    expect(await unscopedPrisma.partnerAgreement.count({ where: { tenantId: TENANT, title } })).toBe(before);
    expect(
      await unscopedPrisma.exceptionRecord.count({
        where: { tenantId: TENANT, code: 'EX-CRM-013', subjectLabel: { startsWith: title } },
      }),
    ).toBe(0);
  });
});

describe('proposing an IT licence renewal notifies the approver in the same transaction', () => {
  it('when the notification cannot be recorded, no renewal approval step is written and the licence is unchanged', async () => {
    const OPS = 'operations@kaizen.co.in';
    const app = await asUser(OPS, () =>
      createApplication({ name: unique('W2-ATOMIC-APP'), category: 'productivity', hosting: 'saas' }),
    );
    const licence = await asUser(OPS, () =>
      createLicence({
        applicationId: app.id,
        kind: 'per_seat',
        seatsPurchased: 5,
        seatsInUse: 2,
        costPerPeriod: 10000,
        billingCycle: 'monthly',
      }),
    );
    const newTermEnd = new Date();
    newTermEnd.setUTCFullYear(newTermEnd.getUTCFullYear() + 1);

    await refuseNotificationInserts();
    await expectReject(() => asUser(OPS, () => proposeRenewal(licence.id, { newTermEnd })));

    const after = await unscopedPrisma.itLicence.findUniqueOrThrow({ where: { id: licence.id } });
    expect(after.pendingRenewalApprovalStepId).toBeNull();
    expect(
      await unscopedPrisma.approvalStep.count({
        where: { tenantId: TENANT, subjectType: 'it_licence', subjectId: licence.id },
      }),
    ).toBe(0);
  });
});

describe('recording a DR test that breaches its RTO raises IT_DR_RTO_EXCEEDED in the same transaction', () => {
  it('when the raise cannot be recorded, no test row is written', async () => {
    const OPS = 'operations@kaizen.co.in';
    const plan = await asUser(OPS, () =>
      createPlan({
        applicationId: unique('w2-atomic-app'),
        applicationName: 'Atomicity order service',
        applicationTier: 2,
        rtoMinutes: 60,
        rpoMinutes: 15,
        backupMethod: 'nightly snapshot',
        backupFrequency: 'daily',
      }),
    );
    await asUser(OPS, () => transitionPlan(plan.id, 'active'));

    await refuseExceptionAudit();
    await expectReject(() =>
      asUser(OPS, () =>
        recordTest(plan.id, { kind: 'restore', outcome: 'fail', actualRecoveryMinutes: 500, actualDataLossMinutes: 5 }),
      ),
    );

    expect(await unscopedPrisma.itContinuityTest.count({ where: { tenantId: TENANT, planId: plan.id } })).toBe(0);
  });
});

describe('a revoke decision in an access review raises IT_ACR_REVOKE_REQUESTED in the same transaction', () => {
  it('when the raise cannot be recorded, the decision is not recorded', async () => {
    const OPS = 'operations@kaizen.co.in';
    const dueAt = new Date();
    dueAt.setUTCDate(dueAt.getUTCDate() + 14);
    const campaign = await asUser(OPS, () => openCampaign({ name: unique('W2-ATOMIC-CAMPAIGN'), scope: 'all', dueAt }));
    const detail = await asUser(OPS, () => campaignDetail(campaign.id));
    const item = detail.items.find((i) => i.decision == null && i.partyId !== undefined);
    expect(item).toBeTruthy();

    await refuseExceptionAudit();
    await expectReject(() => asUser(OPS, () => decideItem(campaign.id, item!.id, { decision: 'revoke' })));

    const after = await unscopedPrisma.itAccessReviewItem.findUniqueOrThrow({ where: { id: item!.id } });
    expect(after.decision).toBeNull();
    expect(
      await unscopedPrisma.exceptionRecord.count({
        where: { tenantId: TENANT, code: 'IT_ACR_REVOKE_REQUESTED', subjectId: item!.id },
      }),
    ).toBe(0);
  });
});

describe('declining an attendance regularisation raises EX-HR-006 in the same transaction', () => {
  it('when the raise cannot be recorded, the request stays submitted', async () => {
    const DIVYA = 'divya@kaizen.co.in';
    const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email: DIVYA, tenant: { slug: 'kaizen' } } });
    const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({
      where: { tenantId: TENANT, personId: user.personId },
    });
    // A far-off day, different each run, so a rerun does not meet an exception an
    // earlier run left open on its own day (the old code committed those).
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() + 30 + Math.floor(Math.random() * 30));
    d.setUTCDate(d.getUTCDate() + Math.floor(Math.random() * 300));
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const request = await asUser(DIVYA, () =>
      submitRegularisation({ employmentRelationshipId: employment.id, date, reason: 'Atomicity probe.' }),
    );
    const before = await unscopedPrisma.attendanceRegularisation.findUniqueOrThrow({ where: { id: request.id } });

    await refuseExceptionAudit();
    await expectReject(() => asUser('hr@kaizen.co.in', () => rejectRegularisation(request.id, 'Not on the log.')));

    const after = await unscopedPrisma.attendanceRegularisation.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.status).toBe(before.status);
    expect(after.decidedAt).toBeNull();
    expect(
      await unscopedPrisma.exceptionRecord.count({
        where: { tenantId: TENANT, code: 'EX-HR-006', subjectId: before.workAttendanceId },
      }),
    ).toBe(0);
  });
});

describe('a forecast demotion notifies the deal owner in the same transaction', () => {
  it('when the notification cannot be recorded, the forecast category is unchanged', async () => {
    const opp = await unscopedPrisma.opportunity.findFirst({
      where: { tenantId: TENANT, outcome: null, forecastCategory: 'best_case', ownerPartyId: { not: null } },
    });
    expect(opp).toBeTruthy();

    await refuseNotificationInserts();
    await expectReject(() =>
      asUser(CHAIRMAN, () =>
        changeForecastCategory({ opportunityId: opp!.id, to: 'pipeline', reason: 'Atomicity probe.' }),
      ),
    );

    const after = await unscopedPrisma.opportunity.findUniqueOrThrow({ where: { id: opp!.id } });
    expect(after.forecastCategory).toBe('best_case');
  });
});

describe('deciding an approval step notifies the requester in the same transaction', () => {
  it('when the notification cannot be recorded, the step is not decided', async () => {
    const requester = await principalFor('chairman@kaizen.co.in');
    const approver = await principalFor('finance@kaizen.co.in');
    const step = await unscopedPrisma.approvalStep.create({
      data: {
        tenantId: TENANT,
        subjectType: 'it_licence',
        subjectId: unique('w2-atomic-step'),
        subjectLabel: 'Atomicity probe licence',
        action: 'it_licence.renew',
        resource: 'it_licences',
        requestedById: requester.partyId,
        resolvedApproverId: approver.partyId,
        resolvedApproverRole: 'finance_head',
        resolutionTier: 0,
      },
    });

    await refuseNotificationInserts();
    await expectReject(() => asUser(FINANCE, () => decideApprovalStep(step.id, true, 'atomicity probe')));

    const after = await unscopedPrisma.approvalStep.findUniqueOrThrow({ where: { id: step.id } });
    expect(after.state).toBe(step.state);
    expect(after.state).not.toBe('approved');
  });
});

describe('submitting a resignation notifies HR ops in the same transaction', () => {
  it('when the notification cannot be recorded, no resignation is written', async () => {
    const DIVYA = 'divya@kaizen.co.in';
    const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email: DIVYA, tenant: { slug: 'kaizen' } } });
    const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({
      where: { tenantId: TENANT, personId: user.personId },
    });
    const before = await unscopedPrisma.resignation.count({
      where: { tenantId: TENANT, employmentRelationshipId: employment.id },
    });

    await refuseNotificationInserts();
    await expectReject(() =>
      asUser(DIVYA, () =>
        submitResignation({
          employmentRelationshipId: employment.id,
          requestedLastDay: new Date(Date.now() + 30 * 86_400_000),
          reasonCategory: 'career_growth',
        }),
      ),
    );

    expect(
      await unscopedPrisma.resignation.count({ where: { tenantId: TENANT, employmentRelationshipId: employment.id } }),
    ).toBe(before);
  });
});

describe('blocking a quote for discount approval notifies the approver in the same transaction', () => {
  it('when the notification cannot be recorded, the quote is not blocked and no approval step is written', async () => {
    const ARUN = 'arun@kaizen.co.in';
    const entry = await unscopedPrisma.priceBookEntry.findFirstOrThrow({
      where: { status: 'active', maxDiscountPct: { gte: 10 } },
    });
    const opp = await unscopedPrisma.opportunity.findFirstOrThrow({ where: { outcome: null } });
    const quote = await asUser(ARUN, () =>
      createQuote(opp.id, [
        { priceBookEntryId: entry.id, quantity: 1, discountPct: Math.min(entry.maxDiscountPct + 15, 100) },
      ]),
    );
    const before = await unscopedPrisma.quote.findUniqueOrThrow({ where: { id: quote.id } });

    await refuseNotificationInserts();
    await expectReject(() => asUser(ARUN, () => issueQuote(quote.id)));

    const after = await unscopedPrisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(after.status).toBe(before.status);
    expect(
      await unscopedPrisma.approvalStep.count({
        where: { tenantId: TENANT, subjectType: 'quote', subjectId: quote.id },
      }),
    ).toBe(0);
  });
});
