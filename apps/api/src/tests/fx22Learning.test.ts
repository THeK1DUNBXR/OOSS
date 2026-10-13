/**
 * FX-22: setProgramActive (PATCH /api/hr/learning/programs/:id) changed
 * training_programs.is_active with no audit row and no event. The write now
 * goes through governedWrite with auditWrite and emit.
 */

import { describe, expect, it } from 'vitest';
import { createProgram, setProgramActive } from '../domains/hcm/learning.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';

describe('setProgramActive — audit', () => {
  it('deactivating a training program writes an update audit row against that program', async () => {
    const tid = await tenantId();
    const program = await asUser('chairman@kaizen.co.in', () =>
      createProgram({ title: 'FX-22 learning audit probe', kind: 'classroom' }),
    );

    await asUser('chairman@kaizen.co.in', () => setProgramActive(program.id, false));

    const after = await unscopedPrisma.trainingProgram.findFirstOrThrow({ where: { id: program.id } });
    expect(after.isActive).toBe(false);

    const audit = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'training_program', subjectId: program.id },
    });
    expect(audit.map((r) => r.action)).toContain('update');
  });
});
