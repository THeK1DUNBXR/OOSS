/**
 * Characterisation of the CompensationRecord and LearningActivity money figures on
 * the wire (ORDERED-PLAN 1.6, the HCM slice that follows MONEY-S8-HCM).
 *
 * CompensationRecord.amount and basicPay, and LearningActivity.cost, are rupee
 * Decimals today. Every rupee field this file pins is asserted on the Decimal string
 * (or the number, where the route has always sent one) that the old code sends, and
 * those assertions pass both before and after the conversion. The `*Minor` siblings
 * are new: they fail on the old code, which is the point of them.
 *
 * The viewer without the `financial` verb is a fixture role that can view the
 * employment and its compensation and holds no money verb on it. The demo HR ops
 * head holds `compensation:F` (analytics.test.ts sees the amount for that reason), so
 * is not a viewer without the grant. The paise figures are withheld for that viewer
 * exactly where the rupee figures are.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server.js';
import { bigintReplacer } from '../../platform/wire.js';
import {
  sessionToken,
  asUser,
  prisma,
  tenantId,
  unscopedPrisma,
  principalFor,
  withFixtureRole,
  type TestPrincipal,
} from '../helpers.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import {
  hire,
  transitionEmployment,
  getEmployment,
  currentCompensation,
  listCompensationForEmployment,
  headcountByDivision,
} from '../../domains/employment.js';
import {
  createPayGrade,
  compaRatioFor,
  createRevisionCycle,
  addRevisionLine,
  listRevisionLines,
  proposeCycle,
  approveRevisionLine,
  approveCycle,
  applyCycle,
} from '../../domains/hcm/compensation.js';
import { createLearningActivity, listLearningActivities, enrolInLearning } from '../../domains/performance.js';
import { rupeesToMinor } from '../../platform/wire.js';

/** What `res.json` sends: Prisma Decimals become their JSON string, BigInt its digits. */
const wire = <T>(value: T): any => JSON.parse(JSON.stringify(value, bigintReplacer));

const CHAIRMAN = 'chairman@kaizen.co.in';
const OPERATIONS = 'operations@kaizen.co.in';

/** A fixture role that can view employments and their pay, and holds no `financial` verb. */
const VIEW_ONLY_GRANTS = [
  { resource: 'employees', verbs: ['view'], scope: 'all' },
  { resource: 'compensation', verbs: ['view'], scope: 'all' },
];

let TENANT: string;
let server: Server;
let base: string;
let chairmanToken: string;
let seq = 0;
const stamp = () => `${Date.now()}-${++seq}`;

beforeAll(async () => {
  TENANT = await tenantId();
  const chairman: TestPrincipal = await principalFor(CHAIRMAN);
  chairmanToken = await sessionToken({
    userId: chairman.userId,
    tenantId: chairman.tenantId,
    affiliationId: chairman.affiliationId,
    stepUp: true,
  });
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(() => {
  server?.close();
});

/** A GET as the given token, with the JSON body and status. */
async function get(token: string, path: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * A throwaway employee, hired and activated, with an Effective compensation record
 * of 12345.67 and a basic of 10001.01. The record is written directly: the approval
 * path is exercised by the cycle test below, not as a setup step.
 */
async function makeEmployee(label: string) {
  const s = stamp();
  return asUser(OPERATIONS, async () => {
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
        fullName: `Compensation Characterisation ${label} ${s}`,
        primaryEmail: `compensation.characterisation.${label}.${s}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    await prisma.compensationRecord.create({
      data: {
        tenantId: TENANT,
        employmentRelationshipId: employment.id,
        revisionReason: 'hire',
        amountMinor: rupeesToMinor(12345.67),
        basicPayMinor: rupeesToMinor(10001.01),
        status: 'Effective',
        effectiveFrom: new Date(Date.now() - 30 * 86_400_000),
      },
    });
    return employment;
  });
}

describe('ORDERED-PLAN 1.6 HCM slice: CompensationRecord and LearningActivity money, characterised', () => {
  describe('CompensationRecord, as the domain returns it', () => {
    it('listCompensationForEmployment and currentCompensation keep the Decimal string for amount and basicPay', async () => {
      const employment = await makeEmployee('domain');
      const rows = wire(await asUser(CHAIRMAN, () => listCompensationForEmployment(employment.id)));
      expect(rows[0].amount).toBe('12345.67');
      expect(rows[0].basicPay).toBe('10001.01');
      expect(rows[0].amountMinor).toBe('1234567');
      expect(rows[0].basicPayMinor).toBe('1000101');

      const current = wire(await asUser(CHAIRMAN, () => currentCompensation(employment.id)));
      expect(current.amount).toBe('12345.67');
      expect(current.amountMinor).toBe('1234567');
    });

    it('compaRatioFor reads the current figure as the rupee number the screen has always had', async () => {
      const employment = await makeEmployee('compa');
      const grade = await asUser(CHAIRMAN, () =>
        createPayGrade({ code: `CHAR-${stamp()}`, level: 1, minPay: 10000, midPay: 12000, maxPay: 14000 }),
      );
      const result = await asUser(CHAIRMAN, () => compaRatioFor(employment.id, grade.id));
      expect(result.currentCtc).toBe(12345.67);
    });

    it('an applied revision line writes the paise figure into the record, and the audit row and event carry the same figure', async () => {
      const employment = await makeEmployee('applied');
      const cycle = await asUser(OPERATIONS, () =>
        createRevisionCycle({ name: `Applied paise ${stamp()}`, effectiveDate: new Date(), budgetPct: 20 }),
      );
      await asUser(OPERATIONS, () =>
        addRevisionLine({
          cycleId: cycle.id,
          employmentRelationshipId: employment.id,
          currentCtc: 12345.67,
          proposedPct: 10,
        }),
      );
      await asUser(OPERATIONS, () => proposeCycle(cycle.id));
      const [line] = await asUser('finance@kaizen.co.in', () => listRevisionLines(cycle.id));
      await asUser('finance@kaizen.co.in', () => approveRevisionLine(line!.id));
      await asUser('finance@kaizen.co.in', () => approveCycle(cycle.id));
      const { linesApplied } = await asUser(OPERATIONS, () => applyCycle(cycle.id));
      expect(linesApplied).toBe(1);

      const rows = wire(await asUser(CHAIRMAN, () => listCompensationForEmployment(employment.id)));
      const applied = rows.find((r: any) => r.revisionReason === 'annual_cycle' && r.status === 'Effective');
      // 12345.67 grown by 10% is 13580.237, rounded once to paise: 13580.24.
      expect(applied.amount).toBe('13580.24');
      expect(applied.amountMinor).toBe('1358024');

      const audit = await unscopedPrisma.auditRecord.findFirstOrThrow({
        where: { subjectType: 'compensation_record', subjectId: applied.id, action: 'create' },
      });
      expect(wire(audit.diff).amount).toBe('13580.24');
      expect(wire(audit.diff).amountMinor).toBe('1358024');

      const event = await unscopedPrisma.eventRecord.findFirstOrThrow({
        where: { tenantId: TENANT, eventName: 'kz.hr.compensation.created', subjectEntityId: applied.id },
      });
      expect((event.newState as any).amount).toBe(13580.24);
      expect((event.newState as any).amountMinor).toBe('1358024');
    });
  });

  describe('CompensationRecord, on the wire', () => {
    it('GET /hr/employees/:id/compensation: a viewer with financial sees the rupee number and the paise string', async () => {
      const employment = await makeEmployee('wire');
      const res = await get(chairmanToken, `/hr/employees/${employment.id}/compensation`);
      expect(res.status).toBe(200);
      const row = res.body[0];
      expect(row.amount).toBe(12345.67);
      expect(row.basicPay).toBe(10001.01);
      expect(row.amountMinor).toBe('1234567');
      expect(row.basicPayMinor).toBe('1000101');
    });

    it('GET /hr/employees/:id/compensation: a viewer without financial gets the rupee fields and their paise siblings as null', async () => {
      const employment = await makeEmployee('withheld');
      await withFixtureRole({ slug: 'comp_view_only', grants: VIEW_ONLY_GRANTS }, async (fixture) => {
        const token = await sessionToken({
          userId: fixture.userId,
          tenantId: fixture.tenantId,
          affiliationId: fixture.affiliationId,
          stepUp: true,
        });
        const res = await get(token, `/hr/employees/${employment.id}/compensation`);
        expect(res.status).toBe(200);
        const row = res.body[0];
        expect(row.amount).toBeNull();
        expect(row.basicPay).toBeNull();
        expect(row).toHaveProperty('amountMinor', null);
        expect(row).toHaveProperty('basicPayMinor', null);
      });
    });

    it('GET /hr/employees/:id: currentCompensation carries the figure to a financial viewer and nothing to one without', async () => {
      const employment = await makeEmployee('current');
      const withMoney = await get(chairmanToken, `/hr/employees/${employment.id}`);
      expect(withMoney.body.payVisible).toBe(true);
      expect(withMoney.body.currentCompensation.amount).toBe(12345.67);
      expect(withMoney.body.currentCompensation.amountMinor).toBe('1234567');

      await withFixtureRole({ slug: 'comp_view_only_current', grants: VIEW_ONLY_GRANTS }, async (fixture) => {
        const token = await sessionToken({
          userId: fixture.userId,
          tenantId: fixture.tenantId,
          affiliationId: fixture.affiliationId,
          stepUp: true,
        });
        const withoutMoney = await get(token, `/hr/employees/${employment.id}`);
        expect(withoutMoney.body.payVisible).toBe(false);
        expect(withoutMoney.body.currentCompensation).toBeNull();
      });
    });

    it('headcountByDivision: a financial viewer gets the pay total, and a viewer without it gets null, never zero', async () => {
      const before = await asUser(CHAIRMAN, () => headcountByDivision());
      const sumBefore = before.reduce((acc, row) => acc + (row.monthlyCost ?? 0), 0);
      await makeEmployee('headcount');
      const after = await asUser(CHAIRMAN, () => headcountByDivision());
      const sumAfter = after.reduce((acc, row) => acc + (row.monthlyCost ?? 0), 0);
      expect(sumAfter - sumBefore).toBeCloseTo(12345.67, 2);

      await withFixtureRole({ slug: 'comp_view_only_hc', grants: VIEW_ONLY_GRANTS }, async () => {
        const withheld = await headcountByDivision();
        expect(withheld.length).toBeGreaterThan(0);
        for (const row of withheld) {
          expect(row.monthlyCost).toBeNull();
          expect(row).toHaveProperty('monthlyCostMinor', null);
        }
      });
    });
  });

  describe('LearningActivity.cost', () => {
    it('the create, the list and the nested learning record keep the Decimal string, with the paise sibling beside it', async () => {
      const activity = wire(
        await asUser(CHAIRMAN, () => createLearningActivity({ title: `Paise course ${stamp()}`, cost: 1234.5 })),
      );
      expect(activity.cost).toBe('1234.5');
      expect(activity.costMinor).toBe('123450');

      const listed = wire(await asUser(CHAIRMAN, () => listLearningActivities()));
      const found = listed.find((a: any) => a.id === activity.id);
      expect(found.cost).toBe('1234.5');
      expect(found.costMinor).toBe('123450');

      const employment = await makeEmployee('learning');
      await asUser(CHAIRMAN, () =>
        enrolInLearning({ employmentRelationshipId: employment.id, learningActivityId: activity.id }),
      );
      const nested = wire(await asUser(CHAIRMAN, () => getEmployment(employment.id)));
      const record = nested.learningRecords.find((r: any) => r.learningActivityId === activity.id);
      expect(record.learningActivity.cost).toBe('1234.5');
      expect(record.learningActivity.costMinor).toBe('123450');
    });
  });
});
