/**
 * FX-22: removeTimesheetEntry (DELETE /api/hr/time/timesheets/entries/:id) hard
 * deleted an entry with no audit row. The delete is now audited, in the same
 * transaction, against the entry that was removed.
 */

import { describe, expect, it } from 'vitest';
import { removeTimesheetEntry } from '../domains/hcm/time.js';
import { asUser, tenantId, unscopedPrisma } from './helpers.js';

describe('removeTimesheetEntry — audit', () => {
  it('removing a draft timesheet entry writes a delete audit row against the entry', async () => {
    const tid = await tenantId();
    const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { tenantId: tid } });
    const timesheet = await unscopedPrisma.timesheet.create({
      data: {
        tenantId: tid,
        employmentRelationshipId: employment.id,
        weekStart: new Date(Date.UTC(2080, 0, 1) + Math.floor(Math.random() * 100000) * 86400000),
        recordCode: `TS-FX22-${Date.now()}`,
      },
    });
    const entry = await unscopedPrisma.timesheetEntry.create({
      data: { tenantId: tid, timesheetId: timesheet.id, date: timesheet.weekStart, hours: 1 },
    });

    await asUser('chairman@kaizen.co.in', () => removeTimesheetEntry(entry.id));

    expect(await unscopedPrisma.timesheetEntry.findFirst({ where: { id: entry.id } })).toBeNull();
    const audit = await unscopedPrisma.auditRecord.findMany({
      where: { tenantId: tid, subjectType: 'timesheet_entry', subjectId: entry.id },
    });
    expect(audit.map((r) => r.action)).toContain('delete');
  });
});
