/**
 * FX-22: updateCalibrationDecisions (PATCH /api/hr/performance/calibrations/:id)
 * and updateOneOnOne (PATCH /api/hr/performance/one-on-ones/:id) wrote rows with
 * no audit row and no event. Both now audit the update in the same transaction.
 */

import { describe, expect, it } from 'vitest';
import { updateCalibrationDecisions, updateOneOnOne } from '../domains/hcm/performance.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';

describe('performance updates — audit', () => {
  it('recording calibration decisions writes an update audit row against the session', async () => {
    const tid = await tenantId();
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const cycle = await unscopedPrisma.reviewCycle.create({
      data: {
        tenantId: tid,
        recordCode: `CYC-FX22-${stamp}`,
        name: 'FX-22 cycle',
        kind: 'annual',
        periodLabel: `FX22-${stamp}`,
        startsOn: new Date('2099-01-01T00:00:00Z'),
        endsOn: new Date('2099-12-31T00:00:00Z'),
      },
    });
    const session = await unscopedPrisma.calibrationSession.create({
      data: { tenantId: tid, cycleId: cycle.id, participants: [] },
    });

    await asUser('chairman@kaizen.co.in', () => updateCalibrationDecisions(session.id, []));

    const audit = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'calibration_session', subjectId: session.id },
    });
    expect(audit.map((r) => r.action)).toContain('update');
  });

  it('updating a one-on-one writes an update audit row against it', async () => {
    const tid = await tenantId();
    const [manager, report] = await unscopedPrisma.employmentRelationship.findMany({
      where: { tenantId: tid },
      take: 2,
    });
    const oneOnOne = await unscopedPrisma.oneOnOne.create({
      data: {
        tenantId: tid,
        managerEmploymentRelationshipId: manager!.id,
        managerPartyId: manager!.personId,
        reportEmploymentRelationshipId: report!.id,
        reportPartyId: report!.personId,
        scheduledAt: new Date('2099-01-01T04:00:00Z'),
      },
    });

    await asUser('chairman@kaizen.co.in', () => updateOneOnOne(oneOnOne.id, { status: 'completed' }));

    const audit = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'one_on_one', subjectId: oneOnOne.id },
    });
    expect(audit.map((r) => r.action)).toContain('update');
  });
});
