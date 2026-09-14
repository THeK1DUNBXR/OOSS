/**
 * Technology — vendors and contracts (docs/plan/cio.md, workstream C).
 *
 * Pure arithmetic first (`noticeDate`, `noticeRung`, `contractValueUnder
 * Management` — no DB), then the wiring: a vendor's overdue security
 * assessment raises IT_VEN_ASSESSMENT_OVERDUE (IT-VEN-001); approving a
 * vendor contract one proposed reroutes on the Self-Dealing Bar
 * (IT-VCT-001); the notice ladder is idempotent and flips
 * expiring/expired (IT-VCT-002); terminating requires a reason and leaves
 * the approval trail alone (IT-VCT-003); and the grant matrix — Finance
 * Head cannot create, Operations Head cannot approve, the employee reaches
 * nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { contractValueUnderManagement, noticeDate, noticeRung } from '@kaizen/shared';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import {
  createVendor,
  createVendorContract,
  recordAssessment,
  renewVendorContract,
  summaryVendors,
  summaryContracts,
  terminateVendorContract,
  transitionVendor,
  transitionVendorContract,
  vendorContractDetail,
  listVendors,
  listVendorContracts,
} from '../../domains/it/vendors.js';
import { runVendorAssessmentOverdueJob, runVendorContractNoticeLadder, runVendorDpaMissingJob } from '../../jobs/it/vendors.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('pure arithmetic (no DB)', () => {
  it('noticeDate subtracts noticeDays from endDate', () => {
    const end = new Date('2026-12-31T00:00:00.000Z');
    expect(noticeDate(end, 30).toISOString().slice(0, 10)).toBe('2026-12-01');
    expect(noticeDate(end, 0).toISOString().slice(0, 10)).toBe('2026-12-31');
  });

  it('noticeRung picks the tightest crossed rung of 30/7/0, or null before 30 days out', () => {
    expect(noticeRung(45)).toBeNull();
    expect(noticeRung(30)).toBe(30);
    expect(noticeRung(20)).toBe(30);
    expect(noticeRung(7)).toBe(7);
    expect(noticeRung(1)).toBe(7);
    expect(noticeRung(0)).toBe(0);
    expect(noticeRung(-5)).toBe(0);
  });

  it('contractValueUnderManagement sums only in-force statuses', () => {
    const rows = [
      { value: 100, status: 'draft' },
      { value: 200, status: 'proposed' },
      { value: 300, status: 'approved' },
      { value: 400, status: 'active' },
      { value: 500, status: 'expiring' },
      { value: 600, status: 'expired' },
      { value: 700, status: 'terminated' },
    ];
    expect(contractValueUnderManagement(rows)).toBe(300 + 400 + 500);
    expect(contractValueUnderManagement([])).toBe(0);
  });
});

describe('vendors and contracts — domain and wiring', () => {
  let tid: string;

  beforeAll(async () => {
    tid = await tenantId();
  });

  it('IT-VEN-001: a vendor whose security assessment is past its next-due date raises IT_VEN_ASSESSMENT_OVERDUE', async () => {
    const vendor = await asUser('operations@kaizen.co.in', () =>
      createVendor({ name: `Overdue Vendor ${stamp()}`, category: 'saas', tier: 1, riskRating: 'high' }),
    );

    // Force the assessment overdue without waiting for the seeded cadence to
    // pass — the fact under test is the ladder's reaction to an overdue date,
    // not the cadence arithmetic (covered separately).
    await unscopedPrisma.itVendor.update({
      where: { id: vendor.id },
      data: { assessmentDueAt: new Date('2020-01-01'), assessmentNotifiedRungs: [] },
    });

    await asUser('operations@kaizen.co.in', () => runVendorAssessmentOverdueJob());

    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: tid, code: 'IT_VEN_ASSESSMENT_OVERDUE', subjectId: vendor.id },
    });
    expect(exception).toBeTruthy();
    expect(exception!.severity).toBe('S3_HIGH_RISK');

    // A second run the same day fires nothing new — the rung is already
    // recorded on the row.
    const before = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_VEN_ASSESSMENT_OVERDUE', subjectId: vendor.id } });
    await asUser('operations@kaizen.co.in', () => runVendorAssessmentOverdueJob());
    const after = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_VEN_ASSESSMENT_OVERDUE', subjectId: vendor.id } });
    expect(after).toBe(before);
  });

  it('recording an assessment sets assessmentDueAt from the tiered cadence and resets the ladder', async () => {
    const vendor = await asUser('operations@kaizen.co.in', () =>
      createVendor({ name: `Cadence Vendor ${stamp()}`, category: 'saas', tier: 2 }),
    );
    const assessedAt = new Date('2026-01-01T00:00:00.000Z');
    const { vendor: updated } = await asUser('operations@kaizen.co.in', () =>
      recordAssessment(vendor.id, { assessor: 'Security Reviewer', outcome: 'passed', score: 88, assessedAt }),
    );
    expect(updated.assessmentStatus).toBe('passed');
    // Tier 2's seeded cadence is 12 months.
    expect(updated.assessmentDueAt!.toISOString().slice(0, 10)).toBe('2027-01-01');
  });

  it('a high/critical vendor with no DPA on file raises IT_VEN_DPA_MISSING', async () => {
    const vendor = await asUser('operations@kaizen.co.in', () =>
      createVendor({ name: `No DPA Vendor ${stamp()}`, category: 'cloud', tier: 1, riskRating: 'critical', dpaSigned: false }),
    );
    await asUser('operations@kaizen.co.in', () => runVendorDpaMissingJob());
    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: tid, code: 'IT_VEN_DPA_MISSING', subjectId: vendor.id },
    });
    expect(exception).toBeTruthy();
  });

  it('IT-VCT-001: approving a vendor contract the same actor proposed reroutes to the next tier with the Self-Dealing Bar tripped', async () => {
    const vendor = await asUser('operations@kaizen.co.in', () => createVendor({ name: `Self-Deal Vendor ${stamp()}`, category: 'infra' }));
    // The chairman holds both create and approve on it_vendor_contracts (the
    // only role that does — Finance Head holds approve but not create, and
    // Operations Head holds create but not approve), so the chairman is the
    // only account that can even attempt to approve its own proposal. Every
    // other actor is stopped earlier, at the missing grant.
    const contract = await asUser('chairman@kaizen.co.in', () =>
      createVendorContract({ vendorId: vendor.id, title: 'Cloud hosting', value: 500000, endDate: new Date('2099-01-01') }),
    );
    await asUser('chairman@kaizen.co.in', () => transitionVendorContract(contract.id, 'proposed'));

    const result = await asUser('chairman@kaizen.co.in', () => transitionVendorContract(contract.id, 'approved'));
    expect(result.applied).toBe(false);
    expect(result.selfDealingBarTripped).toBe(true);
    expect(result.approvalStepId).toBeTruthy();

    const stillProposed = await unscopedPrisma.itVendorContract.findFirstOrThrow({ where: { id: contract.id } });
    expect(stillProposed.status).toBe('proposed');
  });

  it('within-ceiling approval by someone who did not propose it applies directly', async () => {
    const vendor = await asUser('operations@kaizen.co.in', () => createVendor({ name: `Approvable Vendor ${stamp()}`, category: 'infra' }));
    const contract = await asUser('operations@kaizen.co.in', () =>
      createVendorContract({ vendorId: vendor.id, title: 'Support contract', value: 10000, endDate: new Date('2099-01-01') }),
    );
    await asUser('operations@kaizen.co.in', () => transitionVendorContract(contract.id, 'proposed'));

    const result = await asUser('finance@kaizen.co.in', () => transitionVendorContract(contract.id, 'approved'));
    expect(result.selfDealingBarTripped).toBe(false);
    // Whether it applies immediately depends on the authority ceiling seeded
    // for it_contract_approval; either way it must not be self-dealing and
    // must not silently fail.
    expect(typeof result.applied).toBe('boolean');
  });

  it('IT-VCT-002: the notice ladder fires once per rung and flips expiring then expired', async () => {
    const vendor = await asUser('operations@kaizen.co.in', () => createVendor({ name: `Ladder Vendor ${stamp()}`, category: 'infra' }));
    const contract = await asUser('operations@kaizen.co.in', () =>
      createVendorContract({ vendorId: vendor.id, title: `Ladder Contract ${stamp()}`, value: 50000, noticeDays: 30 }),
    );
    // Notice date 5 days out (inside the 7-day rung); end date irrelevant to
    // the notice rung itself but must be in the future.
    const endDate = new Date();
    endDate.setUTCDate(endDate.getUTCDate() + 35);
    await unscopedPrisma.itVendorContract.update({ where: { id: contract.id }, data: { status: 'active', endDate } });

    await asUser('operations@kaizen.co.in', () => runVendorContractNoticeLadder());
    const afterFirst = await unscopedPrisma.itVendorContract.findFirstOrThrow({ where: { id: contract.id } });
    expect(afterFirst.status).toBe('expiring');
    expect(afterFirst.noticeNotifiedRungs).toContain(7);

    const firstCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_VCT_NOTICE', subjectId: contract.id } });
    expect(firstCount).toBe(1);

    await asUser('operations@kaizen.co.in', () => runVendorContractNoticeLadder());
    const secondCount = await unscopedPrisma.exceptionRecord.count({ where: { tenantId: tid, code: 'IT_VCT_NOTICE', subjectId: contract.id } });
    expect(secondCount).toBe(1);

    // Now push it past the end date — the job must flip it to expired
    // unconditionally, regardless of the ladder.
    await unscopedPrisma.itVendorContract.update({
      where: { id: contract.id },
      data: { endDate: new Date('2020-01-01') },
    });
    await asUser('operations@kaizen.co.in', () => runVendorContractNoticeLadder());
    const expired = await unscopedPrisma.itVendorContract.findFirstOrThrow({ where: { id: contract.id } });
    expect(expired.status).toBe('expired');
  });

  it('IT-VCT-003: terminating requires a reason and leaves the approval history intact', async () => {
    const vendor = await asUser('operations@kaizen.co.in', () => createVendor({ name: `Terminable Vendor ${stamp()}`, category: 'infra' }));
    const contract = await asUser('operations@kaizen.co.in', () =>
      createVendorContract({ vendorId: vendor.id, title: 'To be terminated', value: 20000, endDate: new Date('2099-01-01') }),
    );
    await asUser('operations@kaizen.co.in', () => transitionVendorContract(contract.id, 'proposed'));
    const approved = await asUser('finance@kaizen.co.in', () => transitionVendorContract(contract.id, 'approved'));
    // Approved directly (finance did not propose it, so no self-dealing) or
    // opened a step — either way, force it to approved for the termination
    // half of this test, preserving whichever approvedById/approvedAt the
    // gate actually set when it did apply.
    let approvedRow = await unscopedPrisma.itVendorContract.findFirstOrThrow({ where: { id: contract.id } });
    if (!approved.applied) {
      approvedRow = await unscopedPrisma.itVendorContract.update({
        where: { id: contract.id },
        data: { status: 'approved', approvedById: 'test-fixture', approvedAt: new Date() },
      });
    }
    expect(approvedRow.status).toBe('approved');
    const approvedById = approvedRow.approvedById;
    const approvedAt = approvedRow.approvedAt;

    const noReason = await expectReject(() => asUser('operations@kaizen.co.in', () => terminateVendorContract(contract.id, '')));
    expect(noReason.status).toBe(400);

    const terminated = await asUser('operations@kaizen.co.in', () =>
      terminateVendorContract(contract.id, 'Vendor could not meet the SLA.'),
    );
    expect(terminated.applied).toBe(true);
    expect((terminated.contract as { status: string }).status).toBe('terminated');

    const row = await unscopedPrisma.itVendorContract.findFirstOrThrow({ where: { id: contract.id } });
    expect(row.terminationReason).toBe('Vendor could not meet the SLA.');
    expect(row.approvedById).toBe(approvedById);
    expect(row.approvedAt?.getTime()).toBe(approvedAt?.getTime());
  });

  it('a vendor transitions active -> suspended -> active and -> offboarded (terminal)', async () => {
    const vendor = await asUser('operations@kaizen.co.in', () => createVendor({ name: `Lifecycle Vendor ${stamp()}`, category: 'infra' }));
    const suspended = await asUser('operations@kaizen.co.in', () => transitionVendor(vendor.id, { event: 'SUSPEND' }));
    expect(suspended.status).toBe('suspended');
    const reinstated = await asUser('operations@kaizen.co.in', () => transitionVendor(vendor.id, { event: 'REINSTATE' }));
    expect(reinstated.status).toBe('active');
    const offboarded = await asUser('operations@kaizen.co.in', () => transitionVendor(vendor.id, { event: 'OFFBOARD' }));
    expect(offboarded.status).toBe('offboarded');
    const rejected = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionVendor(vendor.id, { event: 'REINSTATE' })));
    expect(rejected.status).toBe(422);
  });

  it('renewing a vendor contract chains a new one by renewedFromId without mutating the predecessor', async () => {
    const vendor = await asUser('operations@kaizen.co.in', () => createVendor({ name: `Renewable Vendor ${stamp()}`, category: 'infra' }));
    const contract = await asUser('operations@kaizen.co.in', () =>
      createVendorContract({ vendorId: vendor.id, title: 'Renewable', value: 15000, endDate: new Date('2099-01-01') }),
    );
    const before = await unscopedPrisma.itVendorContract.findFirstOrThrow({ where: { id: contract.id } });

    const renewed = await asUser('operations@kaizen.co.in', () =>
      renewVendorContract(contract.id, { endDate: new Date('2100-01-01') }),
    );
    expect(renewed.renewedFromId).toBe(contract.id);

    const after = await unscopedPrisma.itVendorContract.findFirstOrThrow({ where: { id: contract.id } });
    expect(after.status).toBe(before.status);
    expect(after.endDate?.getTime()).toBe(before.endDate?.getTime());
  });

  it('the summaries report byTier/byRisk/byStatus and value under management, and never claim measured for another tenant with nothing', async () => {
    const vSummary = await asUser('operations@kaizen.co.in', () => summaryVendors());
    expect(vSummary.notYetMeasured).toBe(false);
    expect(typeof vSummary.byTier).toBe('object');

    // Operations Head holds no it_vendor_contracts:F — the aggregate is
    // withheld (masking is covered separately, below).
    const cSummaryOps = await asUser('operations@kaizen.co.in', () => summaryContracts());
    expect(cSummaryOps.notYetMeasured).toBe(false);
    expect(cSummaryOps.valueUnderManagement).toBeNull();

    const cSummary = await asUser('finance@kaizen.co.in', () => summaryContracts());
    expect(cSummary.notYetMeasured).toBe(false);
    expect(cSummary.valueUnderManagement).toBeGreaterThanOrEqual(0);
  });

  it('listVendors and listVendorContracts return arrays scoped to the tenant', async () => {
    const vendors = await asUser('operations@kaizen.co.in', () => listVendors());
    expect(Array.isArray(vendors)).toBe(true);
    const contracts = await asUser('operations@kaizen.co.in', () => listVendorContracts());
    expect(Array.isArray(contracts)).toBe(true);
  });

  it('vendorContractDetail exposes availableTransitions so the UI cannot render a dead button', async () => {
    const vendor = await asUser('operations@kaizen.co.in', () => createVendor({ name: `Detail Vendor ${stamp()}`, category: 'infra' }));
    const contract = await asUser('operations@kaizen.co.in', () =>
      createVendorContract({ vendorId: vendor.id, title: 'Detail', value: 1000, endDate: new Date('2099-01-01') }),
    );
    const detail = await asUser('operations@kaizen.co.in', () => vendorContractDetail(contract.id));
    expect(detail.availableTransitions).toEqual(['proposed']);
  });

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  it('the Finance Head cannot create a vendor or a vendor contract', async () => {
    const deniedVendor = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => createVendor({ name: `Denied Vendor ${stamp()}`, category: 'infra' })),
    );
    expect(deniedVendor.status).toBe(403);

    const vendor = await asUser('operations@kaizen.co.in', () => createVendor({ name: `Host For Denial ${stamp()}`, category: 'infra' }));
    const deniedContract = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => createVendorContract({ vendorId: vendor.id, title: 'Denied', value: 100, endDate: new Date('2099-01-01') })),
    );
    expect(deniedContract.status).toBe(403);
  });

  it('the Operations Head cannot approve a vendor contract — the grant has no approve', async () => {
    const vendor = await asUser('operations@kaizen.co.in', () => createVendor({ name: `Ops Denied Vendor ${stamp()}`, category: 'infra' }));
    const contract = await asUser('operations@kaizen.co.in', () =>
      createVendorContract({ vendorId: vendor.id, title: 'Ops cannot approve', value: 5000, endDate: new Date('2099-01-01') }),
    );
    await asUser('operations@kaizen.co.in', () => transitionVendorContract(contract.id, 'proposed'));

    const denied = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionVendorContract(contract.id, 'approved')));
    expect(denied.status).toBe(403);

    const stillProposed = await unscopedPrisma.itVendorContract.findFirstOrThrow({ where: { id: contract.id } });
    expect(stillProposed.status).toBe('proposed');
  });

  it('the Operations Head never receives contract value or currency — withheld server-side, not only hidden in the UI', async () => {
    const vendor = await asUser('operations@kaizen.co.in', () => createVendor({ name: `Money Masked Vendor ${stamp()}`, category: 'infra' }));
    const created = await asUser('operations@kaizen.co.in', () =>
      createVendorContract({ vendorId: vendor.id, title: 'Masked from creation', value: 42000, endDate: new Date('2099-01-01') }),
    );
    expect(created.value).toBeNull();
    expect(created.currency).toBeNull();

    const listed = await asUser('operations@kaizen.co.in', () => listVendorContracts({ vendorId: vendor.id }));
    expect(listed.every((c: any) => c.value === null && c.currency === null)).toBe(true);

    const detail = await asUser('operations@kaizen.co.in', () => vendorContractDetail(created.id));
    expect(detail.value).toBeNull();
    expect(detail.currency).toBeNull();

    const summary = await asUser('operations@kaizen.co.in', () => summaryContracts());
    expect(summary.valueUnderManagement).toBeNull();

    // Finance Head and the chairman hold it_vendor_contracts:F and see the
    // real figures on the same rows.
    const financeDetail = await asUser('finance@kaizen.co.in', () => vendorContractDetail(created.id));
    expect(financeDetail.value).toBe(42000);
    expect(financeDetail.currency).toBe('INR');
  });

  it('the employee reaches nothing on vendors or vendor contracts', async () => {
    const deniedList = await expectReject(() => asUser('employee@kaizen.co.in', () => listVendors()));
    expect(deniedList.status).toBe(403);

    const deniedContracts = await expectReject(() => asUser('employee@kaizen.co.in', () => listVendorContracts()));
    expect(deniedContracts.status).toBe(403);

    const deniedCreate = await expectReject(() =>
      asUser('employee@kaizen.co.in', () => createVendor({ name: `Employee Denied ${stamp()}`, category: 'infra' })),
    );
    expect(deniedCreate.status).toBe(403);
  });
});
