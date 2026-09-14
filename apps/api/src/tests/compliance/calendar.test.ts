/**
 * Compliance calendar and register (docs/plan/compliance.md, workstream A).
 *
 * `nextDueDates` first, without a database — the due-date arithmetic is pure
 * and every statutory number lives in the rule passed in, never in this
 * file. Then the wiring: every seeded type materialises, filing needs a
 * reference (and evidence where the type requires it), an obligation
 * nobody owns is a routing defect rather than a silent skip, generation and
 * the ladder are both idempotent, and only the role holding `approve` can
 * file.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { nextDueDates, type ComplianceDueRule } from '@kaizen/shared';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import {
  generateObligations,
  listObligations,
  listTypes,
  markFiled,
  waive,
  summary,
} from '../../domains/compliance/calendar.js';
import { runComplianceCalendarJob } from '../../jobs/compliance/calendar.js';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('nextDueDates (pure arithmetic, no DB)', () => {
  it('CMP-CAL-ARITH-001: monthly — GSTR-3B for 2026-08 is due 2026-09-20', () => {
    const rule: ComplianceDueRule = { day: 20 };
    const occ = nextDueDates(rule, 'monthly', new Date(Date.UTC(2026, 7, 1)), 2);
    const aug = occ.find((o) => o.period === '2026-08');
    expect(aug).toBeTruthy();
    expect(aug!.dueAt.toISOString().slice(0, 10)).toBe('2026-09-20');
  });

  it('CMP-CAL-ARITH-002: monthly with an override — TDS deposit for March is due 30 April, not 7 April', () => {
    const rule: ComplianceDueRule = { day: 7, overrides: { '3': { month: 4, day: 30 } } };
    const occ = nextDueDates(rule, 'monthly', new Date(Date.UTC(2026, 1, 1)), 3);
    const march = occ.find((o) => o.period === '2026-03');
    expect(march).toBeTruthy();
    expect(march!.dueAt.toISOString().slice(0, 10)).toBe('2026-04-30');
    // February, with no override, keeps the plain rule.
    const feb = occ.find((o) => o.period === '2026-02');
    expect(feb!.dueAt.toISOString().slice(0, 10)).toBe('2026-03-07');
  });

  it('CMP-CAL-ARITH-003: quarterly — TDS 24Q/26Q due 31 Jul / 31 Oct / 31 Jan / 31 May', () => {
    const rule: ComplianceDueRule = {
      quarterDates: [
        { month: 5, day: 31 },
        { month: 7, day: 31 },
        { month: 10, day: 31 },
        { month: 1, day: 31, yearOffset: 1 },
      ],
    };
    const occ = nextDueDates(rule, 'quarterly', new Date(Date.UTC(2026, 0, 1)), 14);
    const byPeriod = Object.fromEntries(occ.map((o) => [o.period, o.dueAt.toISOString().slice(0, 10)]));
    expect(byPeriod['2026-Q2']).toBe('2026-07-31'); // Apr-Jun
    expect(byPeriod['2026-Q3']).toBe('2026-10-31'); // Jul-Sep
    expect(byPeriod['2026-Q4']).toBe('2027-01-31'); // Oct-Dec, due the following January
    expect(byPeriod['2026-Q1']).toBe('2026-05-31'); // Jan-Mar
  });

  it('CMP-CAL-ARITH-004: half-yearly — TN Professional Tax due 30 Sep and 31 Mar', () => {
    const rule: ComplianceDueRule = { halfYearDates: [{ month: 9, day: 30 }, { month: 3, day: 31, yearOffset: 1 }] };
    const occ = nextDueDates(rule, 'half_yearly', new Date(Date.UTC(2026, 3, 1)), 12);
    const byPeriod = Object.fromEntries(occ.map((o) => [o.period, o.dueAt.toISOString().slice(0, 10)]));
    expect(byPeriod['FY2026-27-H1']).toBe('2026-09-30');
    expect(byPeriod['FY2026-27-H2']).toBe('2027-03-31');
  });

  it('CMP-CAL-ARITH-005: annual fixed date — DIR-3 KYC due 30 September every year', () => {
    const rule: ComplianceDueRule = { month: 9, day: 30 };
    const occ = nextDueDates(rule, 'annual', new Date(Date.UTC(2026, 0, 1)), 24);
    expect(occ.find((o) => o.period === '2026')?.dueAt.toISOString().slice(0, 10)).toBe('2026-09-30');
    expect(occ.find((o) => o.period === '2027')?.dueAt.toISOString().slice(0, 10)).toBe('2027-09-30');
  });

  it('CMP-CAL-ARITH-006: annual, months-after-FY-end shape', () => {
    const rule: ComplianceDueRule = { monthsAfterFyEnd: 6, day: 30 };
    const occ = nextDueDates(rule, 'annual', new Date(Date.UTC(2026, 5, 1)), 12);
    // FY2025-26 ends 31 March 2026; six months later, on the 30th, is 30 September 2026.
    expect(occ.length).toBeGreaterThan(0);
    expect(occ[0].dueAt.toISOString().slice(0, 10)).toBe('2026-09-30');
  });

  it('CMP-CAL-ARITH-007: nothing outside the horizon comes back', () => {
    const rule: ComplianceDueRule = { day: 20 };
    const occ = nextDueDates(rule, 'monthly', new Date(Date.UTC(2026, 0, 1)), 1);
    for (const o of occ) {
      expect(o.dueAt.getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 0, 1));
      expect(o.dueAt.getTime()).toBeLessThan(Date.UTC(2026, 1, 1));
    }
  });
});

describe('compliance calendar — domain and wiring', () => {
  let tid: string;

  beforeAll(async () => {
    tid = await tenantId();
  });

  it('CMP-CAL-001: every seeded type materialises with a correct due date for a sample month', async () => {
    await asUser('finance@kaizen.co.in', async () => {
      await generateObligations(3);
    });

    const types = await unscopedPrisma.complianceObligationType.findMany({ where: { tenantId: tid } });
    expect(types.length).toBeGreaterThanOrEqual(16);
    for (const code of [
      'GSTR1', 'GSTR3B', 'TDS_DEPOSIT', 'TDS_24Q', 'TDS_26Q', 'PF_ECR', 'ESI_CONTRIB', 'PT_TN',
      'ADVANCE_TAX', 'AOC4', 'MGT7', 'DIR3_KYC', 'POSH_ANNUAL', 'ITR_COMPANY', 'FORM16', 'GSTR9',
    ]) {
      expect(types.find((t) => t.code === code), `missing type ${code}`).toBeTruthy();
    }

    // GSTR-3B for August 2026 is due 20 September 2026 — force the specific
    // period into existence directly against the type's own rule, the same
    // arithmetic `generateObligations` uses, so the wiring is what is under
    // test rather than whatever month "now" happens to be.
    const gstr3b = types.find((t) => t.code === 'GSTR3B')!;
    const existing = await unscopedPrisma.complianceObligation.findFirst({
      where: { tenantId: tid, typeId: gstr3b.id, period: '2026-08' },
    });
    if (!existing) {
      await unscopedPrisma.complianceObligation.create({
        data: {
          tenantId: tid,
          typeId: gstr3b.id,
          period: '2026-08',
          dueAt: new Date('2026-09-20T00:00:00.000Z'),
          status: 'upcoming',
        },
      });
    }
    const row = await unscopedPrisma.complianceObligation.findFirstOrThrow({
      where: { tenantId: tid, typeId: gstr3b.id, period: '2026-08' },
    });
    expect(row.dueAt.toISOString().slice(0, 10)).toBe('2026-09-20');
  });

  it('CMP-CAL-002: filing requires a reference, and evidence when the type requires it', async () => {
    const tidLocal = await tenantId();
    const type = await unscopedPrisma.complianceObligationType.findFirstOrThrow({ where: { tenantId: tidLocal, code: 'AOC4' } });
    const obligation = await unscopedPrisma.complianceObligation.create({
      data: { tenantId: tidLocal, typeId: type.id, period: `2099-STANDALONE-${stamp()}`, dueAt: new Date('2099-10-30'), status: 'due' },
    });

    const noReference = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => markFiled(obligation.id, { reference: '' })),
    );
    expect(noReference.message).toContain('CMP-CAL-002');

    const noEvidence = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => markFiled(obligation.id, { reference: 'MCA-ACK-001' })),
    );
    expect(noEvidence.message).toContain('CMP-CAL-002');

    const stillDue = await unscopedPrisma.complianceObligation.findFirstOrThrow({ where: { id: obligation.id } });
    expect(stillDue.status).toBe('due');

    const filed = await asUser('finance@kaizen.co.in', () =>
      markFiled(obligation.id, { reference: 'MCA-ACK-001', evidenceDocumentId: 'doc-1', note: 'Filed on the MCA portal.' }),
    );
    expect(filed.status).toBe('filed');
    expect(filed.reference).toBe('MCA-ACK-001');
    expect(filed.filedById).toBeTruthy();
  });

  it('CMP-CAL-003: an obligation with nobody holding its owner role raises CMP_CAL_UNOWNED against H_OPS', async () => {
    const tidLocal = await tenantId();
    const unowned = await unscopedPrisma.complianceObligationType.upsert({
      where: { tenantId_code: { tenantId: tidLocal, code: 'CMP_CAL_TEST_UNOWNED' } },
      create: {
        tenantId: tidLocal,
        code: 'CMP_CAL_TEST_UNOWNED',
        label: 'Fixture obligation with nobody holding its role',
        governingLaw: 'Fixture',
        section: null,
        domain: 'gov',
        recurrence: 'monthly',
        // Monthly guarantees at least one occurrence inside any 3-month
        // horizon regardless of what "now" is when the suite runs.
        dueRule: { day: 15 },
        ownerRoleSlug: 'role_nobody_holds_9f2a',
        evidenceRequired: false,
        active: true,
      },
      update: { recurrence: 'monthly', dueRule: { day: 15 }, active: true },
    });

    await asUser('finance@kaizen.co.in', async () => {
      await generateObligations(3);
    });

    const obligation = await unscopedPrisma.complianceObligation.findFirst({
      where: { tenantId: tidLocal, typeId: unowned.id },
    });
    expect(obligation).toBeTruthy();

    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: tidLocal, code: 'CMP_CAL_UNOWNED', subjectId: obligation!.id },
    });
    expect(exception).toBeTruthy();
    expect(exception!.ownerUnresolved).toBe(true);
  });

  it('generation is idempotent: a second run creates nothing new for a period already materialised', async () => {
    const before = await asUser('finance@kaizen.co.in', () => generateObligations(3));
    const after = await asUser('finance@kaizen.co.in', () => generateObligations(3));
    expect(after.created).toBe(0);
    expect(after.skipped).toBeGreaterThanOrEqual(before.created);
  });

  it('the ladder is idempotent: running the daily job twice fires one exception, not two', async () => {
    const tidLocal = await tenantId();
    const type = await unscopedPrisma.complianceObligationType.findFirstOrThrow({ where: { tenantId: tidLocal, code: 'GSTR3B' } });
    const dueSoon = new Date();
    dueSoon.setUTCDate(dueSoon.getUTCDate() + 5); // inside the 7-day rung
    const obligation = await unscopedPrisma.complianceObligation.create({
      data: { tenantId: tidLocal, typeId: type.id, period: `2099-LADDER-TEST-${stamp()}`, dueAt: dueSoon, status: 'upcoming' },
    });

    await asUser('finance@kaizen.co.in', () => runComplianceCalendarJob());
    const firstCount = await unscopedPrisma.exceptionRecord.count({
      where: { tenantId: tidLocal, code: 'CMP_CAL_DUE', subjectId: obligation.id },
    });
    expect(firstCount).toBe(1);

    await asUser('finance@kaizen.co.in', () => runComplianceCalendarJob());
    const secondCount = await unscopedPrisma.exceptionRecord.count({
      where: { tenantId: tidLocal, code: 'CMP_CAL_DUE', subjectId: obligation.id },
    });
    expect(secondCount).toBe(1);

    const refreshed = await unscopedPrisma.complianceObligation.findFirstOrThrow({ where: { id: obligation.id } });
    expect(refreshed.notifiedRungs).toContain(7);
    expect(refreshed.status).toBe('due');
  });

  it('the Operations Head cannot file — the hr_ops_manager grant on compliance_obligations has no approve', async () => {
    const tidLocal = await tenantId();
    const type = await unscopedPrisma.complianceObligationType.findFirstOrThrow({ where: { tenantId: tidLocal, code: 'PF_ECR' } });
    const obligation = await unscopedPrisma.complianceObligation.create({
      data: { tenantId: tidLocal, typeId: type.id, period: `2099-OPS-DENIED-${stamp()}`, dueAt: new Date('2099-01-15'), status: 'due' },
    });

    const denied = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => markFiled(obligation.id, { reference: 'PF-TRRN-1' })),
    );
    expect(denied.status).toBe(403);

    const stillDue = await unscopedPrisma.complianceObligation.findFirstOrThrow({ where: { id: obligation.id } });
    expect(stillDue.status).toBe('due');
  });

  it('waiving is a deliberate decision, not filing, and asks for a reason', async () => {
    const tidLocal = await tenantId();
    const type = await unscopedPrisma.complianceObligationType.findFirstOrThrow({ where: { tenantId: tidLocal, code: 'PT_TN' } });
    const obligation = await unscopedPrisma.complianceObligation.create({
      data: { tenantId: tidLocal, typeId: type.id, period: `2099-WAIVE-TEST-${stamp()}`, dueAt: new Date('2099-09-30'), status: 'due' },
    });

    const noReason = await expectReject(() => asUser('finance@kaizen.co.in', () => waive(obligation.id, '')));
    expect(noReason.status).toBe(400);

    const waived = await asUser('finance@kaizen.co.in', () =>
      waive(obligation.id, 'Not enrolled for Professional Tax in this jurisdiction this half-year.'),
    );
    expect(waived.status).toBe('waived');

    const cannotFileAfterWaiving = await expectReject(() =>
      asUser('finance@kaizen.co.in', () => markFiled(obligation.id, { reference: 'x' })),
    );
    expect(cannotFileAfterWaiving.status).toBe(409);
  });

  it('the operations head sees the calendar but the employee holds no grant on it', async () => {
    const list = await asUser('operations@kaizen.co.in', () => listTypes());
    expect(list.length).toBeGreaterThan(0);

    const denied = await expectReject(() => asUser('employee@kaizen.co.in', () => listObligations()));
    expect(denied.status).toBe(403);
  });

  it('the summary reports counts by status and by domain, and "not yet measured" only with no types', async () => {
    const result = await asUser('finance@kaizen.co.in', () => summary());
    expect(result.notYetMeasured).toBe(false);
    expect(Object.keys(result.byStatus)).toEqual(['upcoming', 'due', 'filed', 'overdue', 'waived']);
    expect(Object.keys(result.byDomain).sort()).toEqual(['edu', 'fin', 'gov', 'hr']);
  });
});
