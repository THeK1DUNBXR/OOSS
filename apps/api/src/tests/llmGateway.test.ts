/**
 * The model gateway is the only route personal data can take to an inference
 * API (CLAUDE.md, Never: personal data goes out only through applyFieldVisibility,
 * and never to a non-India region for a tenant requiring India inference). These
 * tests pin what the payload that leaves the gateway may contain. FX-65.
 *
 * Pure functions, no database: the gateway is what is under test, and it does
 * not touch one.
 */

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ModelGateway, PERSONAL_DATA_FIELDS } from '../platform/llm.js';

const BASE = { provider: 'test', model: 'test-model', tenantId: 'tenant-1' };

const PERSON_PAYLOAD = {
  id: 'per_1',
  recordCode: 'PER-0001',
  fullName: 'Asha Rao',
  primaryEmail: 'asha@example.com',
  primaryPhone: '9800000000',
  bloodGroup: 'O+',
  notes: 'Prefers calls after six',
  externalIds: [{ system: 'hris', id: 'E-42' }],
};

describe('FX-65: the personal fields that leave the gateway', () => {
  it('a Person payload reaching the model carries no email, phone, blood group, notes or external ids', () => {
    const gateway = new ModelGateway({ ...BASE, classificationCeiling: 'regulated' });
    const { redacted } = gateway.preparePayload('briefing', { ...PERSON_PAYLOAD }, 'read_only_summary');

    expect(JSON.stringify(redacted)).not.toContain('asha@example.com');
    expect(JSON.stringify(redacted)).not.toContain('9800000000');
    expect(JSON.stringify(redacted)).not.toContain('O+');
    expect(JSON.stringify(redacted)).not.toContain('Prefers calls after six');
    expect(JSON.stringify(redacted)).not.toContain('E-42');
    expect(JSON.stringify(redacted)).not.toContain('Asha Rao');
  });

  it('every Person column is either a personal field the gateway redacts or an explicit non-personal one', () => {
    // A new Person column that is personal and not added here is the defect
    // this test exists for: it would reach the model unredacted.
    const nonPersonal = new Set([
      'id',
      'tenantId',
      'recordCode',
      'dedupeStatus',
      'mergedIntoId',
      'fieldClassifications',
      'createdById',
      'updatedById',
      'source',
      'deletedAt',
      'createdAt',
      'updatedAt',
    ]);
    const columns = Object.values(Prisma.PersonScalarFieldEnum) as string[];
    const unaccounted = columns.filter((c) => !nonPersonal.has(c) && !PERSONAL_DATA_FIELDS.has(c));
    expect(unaccounted).toEqual([]);
  });

  it('an unclassified field is withheld, not passed to the model as public', () => {
    const gateway = new ModelGateway({ ...BASE, classificationCeiling: 'restricted' });
    const { redacted } = gateway.preparePayload('briefing', { unclassifiedThing: 'visible?' }, 'read_only_summary');
    expect(redacted.unclassifiedThing ?? null).toBeNull();
  });

  it('the ceiling is the caller grant, not a constant: an internal field is withheld from a public-ceiling caller', () => {
    const gateway = new ModelGateway({
      ...BASE,
      classificationCeiling: 'public',
      fieldClassifications: { teamNote: 'internal' },
    });
    const { redacted } = gateway.preparePayload('briefing', { teamNote: 'for staff only' }, 'read_only_summary');
    expect(redacted.teamNote ?? null).toBeNull();
  });
});
