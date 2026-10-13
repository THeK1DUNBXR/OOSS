/**
 * FX-22: setInstructionAmounts (PATCH /api/hr/payroll/instructions/:id) changed
 * a payroll instruction's gross, deductions and net with no audit row and no
 * event. It is audited now, in the same transaction.
 */

import { describe, expect, it } from 'vitest';
import { setInstructionAmounts } from '../domains/payroll.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';
import { minorToDecimal } from '../platform/wire.js';

describe('setInstructionAmounts — audit', () => {
  it('changing an instruction amount writes an update audit row against the instruction', async () => {
    const tid = await tenantId();
    const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { tenantId: tid } });
    const payPeriod = `${2100 + Math.floor(Math.random() * 400)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}`;
    const instruction = await unscopedPrisma.payrollInstruction.create({
      data: { tenantId: tid, employmentRelationshipId: employment.id, payPeriod },
    });

    await asUser('chairman@kaizen.co.in', () =>
      setInstructionAmounts(instruction.id, { grossAmount: 50000, deductions: 2000 }),
    );

    const after = await unscopedPrisma.payrollInstruction.findFirstOrThrow({ where: { id: instruction.id } });
    expect(minorToDecimal(after.grossAmountMinor).toString()).toBe('50000');

    const audit = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'payroll_instruction', subjectId: instruction.id },
    });
    expect(audit.map((r) => r.action)).toContain('update');
  });
});
