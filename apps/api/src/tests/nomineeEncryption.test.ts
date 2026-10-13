/**
 * FX-64 — the nominee's name is a regulated value like the bank account beside
 * it. It is encrypted on the way in, the write is governed (audit and event in
 * the same transaction), and the employment read projection does not return it.
 *
 * Before this fix `setBankDetails` spread `nomineeName` through `...input`
 * unencrypted, wrote the update with no audit and no event, and the employment
 * projection passed the column through to every reader.
 */

import { randomUUID } from 'node:crypto';
import { EVENTS, isEncryptedFieldValue } from '@kaizen/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { setBankDetails } from '../domains/compliance/payroll.js';
import { readRegulated } from '../domains/compliance/privacy.js';
import { redactRegulatedEmploymentFields } from '../domains/employment.js';
import { unscopedPrisma } from '../platform/db.js';
import { tenantId, withFixtureRole } from './helpers.js';

const createdEmploymentIds: string[] = [];
const createdPersonIds: string[] = [];

async function fixtureEmployment(tid: string) {
  const stamp = randomUUID().slice(0, 8);
  const person = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-FX64-${stamp}`,
      fullName: `FX64 nominee ${stamp}`,
      primaryEmail: `fx64.${stamp}@fixture.test`,
      source: 'test',
    },
  });
  createdPersonIds.push(person.id);
  const employment = await unscopedPrisma.employmentRelationship.create({
    data: {
      tenantId: tid,
      recordCode: `EMP-FX64-${stamp}`,
      personId: person.id,
      hireEffectiveDate: new Date('2021-04-01T00:00:00.000Z'),
      status: 'Active',
    },
  });
  createdEmploymentIds.push(employment.id);
  return employment;
}

afterAll(async () => {
  await unscopedPrisma.employmentRelationship
    .deleteMany({ where: { id: { in: createdEmploymentIds } } })
    .catch(() => {});
  await unscopedPrisma.person.deleteMany({ where: { id: { in: createdPersonIds } } }).catch(() => {});
});

describe('FX-64 nominee name', () => {
  it('is stored encrypted, audited and emitted, and reads back through readRegulated', async () => {
    const tid = await tenantId();
    await withFixtureRole(
      { slug: 'fx64_nominee_editor', grants: [{ resource: 'employees', verbs: ['view', 'edit'], scope: 'all' }] },
      async () => {
        const employment = await fixtureEmployment(tid);

        await setBankDetails(employment.id, { nomineeName: 'Meera Rao', nomineeRelationship: 'spouse' });

        const raw = await unscopedPrisma.employmentRelationship.findUniqueOrThrow({ where: { id: employment.id } });
        expect(isEncryptedFieldValue(raw.nomineeName ?? '')).toBe(true);
        expect(raw.nomineeName ?? '').not.toContain('Meera Rao');
        expect(readRegulated(raw.nomineeName)).toBe('Meera Rao');

        // The audit row names the fields that changed, never their values.
        const audit = await unscopedPrisma.auditRecord.findMany({
          where: { tenantId: tid, subjectType: 'employment_relationship', subjectId: employment.id },
        });
        expect(audit.length).toBe(1);
        expect(JSON.stringify(audit[0].meta)).toContain('nomineeName');
        expect(JSON.stringify(audit[0].meta)).not.toContain('Meera Rao');

        const events = await unscopedPrisma.eventRecord.findMany({
          where: { tenantId: tid, subjectEntityId: employment.id, eventName: EVENTS.EMPLOYEE_PROFILE_UPDATED },
        });
        expect(events.length).toBe(1);
      },
    );
  });

  it('the employment projection withholds the nominee name from every reader', () => {
    // Pure function: the projection is what every employment read returns.
    const projected = redactRegulatedEmploymentFields({
      panNumber: null,
      uanNumber: null,
      esicNumber: null,
      bankAccountNumber: null,
      bankIfsc: null,
      bankAccountName: null,
      nomineeName: 'enc:v1:ciphertext-for-a-nominee',
      person: { bloodGroup: null },
    });
    expect(projected.nomineeName).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain('enc:v1:');
  });
});
