/**
 * Defects the HCM money conversion (MONEY-S8-HCM) corrects. Each test fails on
 * the float code it replaces and passes on the paise code, and each names the
 * consequence it had. The characterisation file pins everything else unchanged.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import { addRevisionLine, createRevisionCycle } from '../../domains/hcm/compensation.js';

let TENANT: string;
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function freshEmployment(label: string) {
  const s = stamp();
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
    const person = await prisma.person.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('PER'),
        fullName: `Money Defect ${label} ${s}`,
        primaryEmail: `money.defect.${label}.${s}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return employment;
  });
}

describe('HCM money defects', () => {
  it('a revision line proposal on an exact half-paisa is rounded half up, not down by a float (250090 at +0.25% is 250715.225)', async () => {
    // The float path computed Math.round(250090 * 1.0025 * 100) / 100, and the
    // double for 250715.225 sits a hair under the tie, so the proposal was one
    // paisa short of the exact figure the cycle's budget check and the applied
    // CompensationRecord both then carried.
    const employment = await freshEmployment('tie');
    const cycle = await asUser('operations@kaizen.co.in', () =>
      createRevisionCycle({ name: `Tie cycle ${stamp()}`, effectiveDate: new Date(), budgetPct: 20 }),
    );
    const line = await asUser('operations@kaizen.co.in', () =>
      addRevisionLine({
        cycleId: cycle.id,
        employmentRelationshipId: employment.id,
        currentCtc: 250090,
        proposedPct: 0.25,
      }),
    );
    expect(line.proposedCtc?.toFixed(2)).toBe('250715.23');
    const stored = await unscopedPrisma.salaryRevisionLine.findFirstOrThrow({ where: { id: line.id } });
    expect(stored.proposedCtcMinor).toBe(25071523n);
  });
});
