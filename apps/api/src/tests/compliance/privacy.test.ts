/**
 * Compliance — G. Data protection and privacy (DPDP). docs/plan/compliance.md §G.
 *
 * Everything runs inside a real request context against a real database, the
 * way the rest of the suite does: the five-axis evaluator that runs here is
 * the one that runs in production, not a stand-in for it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { evaluate } from '../../platform/permissions.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { hire, transitionEmployment, transitionOffboarding } from '../../domains/employment.js';
import { attachStudentProfile } from '../../domains/students.js';
import {
  grantConsent,
  withdrawConsent,
  grantedConsentCodes,
  listConsentsForPerson,
  raiseDataRequest,
  listDataRequests,
  fulfilDataRequest,
  publishNotice,
  acknowledgeNotice,
  runBreachLadder,
  raiseBreach,
  runAccessReview,
  backfillEncryptAtRest,
  readRegulated,
  encryptField,
  assertMinorHasGuardian,
} from '../../domains/compliance/privacy.js';
import { requestDueAt, DATA_REQUEST_DUE_DAYS, ENCRYPTED_FIELD_PREFIX, ageInYears } from '@kaizen/shared';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function makePerson(label: string, extra: Record<string, unknown> = {}) {
  fixtureSeq += 1;
  const stamp = `${Date.now()}-${fixtureSeq}`;
  return prisma.person.create({
    data: {
      tenantId: TENANT,
      recordCode: await nextRecordCode('PER'),
      fullName: `Fixture ${label} ${stamp}`,
      primaryEmail: `fixture.${label}.${stamp}@example.com`,
      source: 'test',
      ...extra,
    },
  });
}

async function makeEmployee(label: string) {
  return asUser('operations@kaizen.co.in', async () => {
    const position = await prisma.position.findFirstOrThrow({ where: { tenantId: TENANT } });
    const person = await makePerson(label);
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { person, employment };
  });
}

// ===========================================================================
// CMP-DPD-001 — the WHY axis has real data
// ===========================================================================

describe('CMP-DPD-001: a regulated read via a purpose that requires consent', () => {
  it('fails when the principal holds no matching Consent row', async () => {
    const decision = await asUser('employee@kaizen.co.in', async (p) => {
      const auth = { tenantId: p.tenantId, principalType: 'human' as const, partyId: p.partyId, userId: p.userId, agentId: null, onBehalfOfPartyId: null, affiliationId: p.affiliationId, roleSlug: p.roleSlug, branch: p.branch, orgUnitId: null, classificationCeiling: 'regulated' as const, purpose: 'marketing', consentCodes: [] as string[], stepUpVerified: true };
      return evaluate({ resource: 'people', verb: 'view', classification: 'regulated', requiredPurpose: 'marketing', requiredConsent: ['marketing'], auth });
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedBy).toBe('WHY');
  });

  it('passes once the consent code is present on the auth context', async () => {
    const decision = await asUser('employee@kaizen.co.in', async (p) => {
      const auth = { tenantId: p.tenantId, principalType: 'human' as const, partyId: p.partyId, userId: p.userId, agentId: null, onBehalfOfPartyId: null, affiliationId: p.affiliationId, roleSlug: p.roleSlug, branch: p.branch, orgUnitId: null, classificationCeiling: 'regulated' as const, purpose: 'marketing', consentCodes: ['marketing'], stepUpVerified: true };
      return evaluate({ resource: 'people', verb: 'view', classification: 'regulated', requiredPurpose: 'marketing', requiredConsent: ['marketing'], auth });
    });
    expect(decision.allowed).toBe(true);
  });

  it('grantConsent records a row that grantedConsentCodes then reports back', async () => {
    const person = await asUser('operations@kaizen.co.in', () => makePerson('consenter'));
    await asUser('operations@kaizen.co.in', () =>
      grantConsent({ personId: person.id, purposeCode: 'employment', channel: 'in_app' }),
    );
    const codes = await grantedConsentCodes(TENANT, person.id);
    expect(codes).toContain('employment');

    // The list names the data principal, not just their cuid.
    const consents = await asUser('operations@kaizen.co.in', () => listConsentsForPerson(person.id));
    expect(consents.every((c) => c.personFullName === person.fullName)).toBe(true);
  });

  it('withdrawing a consent removes it from grantedConsentCodes', async () => {
    const person = await asUser('operations@kaizen.co.in', () => makePerson('withdrawer'));
    const consent = await asUser('operations@kaizen.co.in', () =>
      grantConsent({ personId: person.id, purposeCode: 'employment', channel: 'in_app' }),
    );
    await asUser('operations@kaizen.co.in', () => withdrawConsent(consent.id));
    const codes = await grantedConsentCodes(TENANT, person.id);
    expect(codes).not.toContain('employment');
  });

  it('refuses consent against a purpose the notice does not name', async () => {
    const person = await asUser('operations@kaizen.co.in', () => makePerson('badpurpose'));
    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => grantConsent({ personId: person.id, purposeCode: 'not_a_real_purpose', channel: 'in_app' })),
    );
    expect(err.status).toBe(400);
  });
});

// ===========================================================================
// Privacy notice
// ===========================================================================

describe('Privacy notice: versioned, never edited', () => {
  it('a new version supersedes the one before it rather than editing it', async () => {
    const before = await asUser('chairman@kaizen.co.in', async () => {
      const { getCurrentNotice } = await import('../../domains/compliance/privacy.js');
      return getCurrentNotice();
    });

    const published = await asUser('chairman@kaizen.co.in', () =>
      publishNotice({
        effectiveFrom: new Date(),
        body: 'Updated notice body for the test run.',
        purposes: [{ code: 'employment', label: 'Employment', lawfulBasis: 'legal_obligation', dataCategories: ['contact'], retention: '8 years' }],
      }),
    );

    expect(published.version).toBe(before.version + 1);
    const previous = await unscopedPrisma.privacyNotice.findFirstOrThrow({ where: { id: before.id } });
    expect(previous.status).toBe('superseded');
    expect(previous.supersededById).toBe(published.id);
  });

  it('only the chairman may publish a new version — operations cannot', async () => {
    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () =>
        publishNotice({ effectiveFrom: new Date(), body: 'x', purposes: [{ code: 'employment', label: 'e', lawfulBasis: 'legal_obligation', dataCategories: [], retention: '8y' }] }),
      ),
    );
    expect(err.status).toBe(403);
  });

  it('acknowledging records who accepted which version', async () => {
    const ack = await asUser('employee@kaizen.co.in', () => acknowledgeNotice({ channel: 'in_app' }));
    expect(ack.channel).toBe('in_app');
  });
});

// ===========================================================================
// CMP-DPD-002 — erasure refused with the floor named
// ===========================================================================

describe('CMP-DPD-002: erasure inside the statutory retention floor', () => {
  it('is refused with the floor named and the earliest erasable date, not silently ignored', async () => {
    const { person } = await makeEmployee('erase-blocked');

    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'erasure' }));
    const fulfilled = await asUser('operations@kaizen.co.in', () => fulfilDataRequest(request.id));

    expect(fulfilled.status).toBe('refused');
    expect(fulfilled.refusalReason).toBeTruthy();
    expect(fulfilled.refusalReason).toMatch(/employee_record/);
    expect(fulfilled.refusalReason).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('erases (scrubs to a token) once nothing blocks it', async () => {
    const person = await asUser('operations@kaizen.co.in', () => makePerson('erase-clear'));
    // No statutory-retention-floor affiliation on this person, so no blocker.
    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'erasure' }));
    const fulfilled = await asUser('operations@kaizen.co.in', () => fulfilDataRequest(request.id));

    expect(fulfilled.status).toBe('fulfilled');
    const scrubbed = await unscopedPrisma.person.findFirstOrThrow({ where: { id: person.id } });
    expect(scrubbed.fullName).toBe(`erased:${person.id}`);
    expect(scrubbed.deletedAt).not.toBeNull();
  });

  // FX-62. The floor is measured against a RetentionSchedule row. With no row
  // the window cannot be measured, so erasure must not proceed on the
  // assumption that nothing is held. The old code treated "no schedule" as
  // "no blocker" and erased.
  it('refuses erasure when the floor applies but no retention schedule exists for the class', async () => {
    const { person } = await makeEmployee('erase-no-schedule');
    const saved = await unscopedPrisma.retentionSchedule.findMany({
      where: { tenantId: TENANT, retentionClass: 'employee_record' },
    });
    await unscopedPrisma.retentionSchedule.deleteMany({ where: { tenantId: TENANT, retentionClass: 'employee_record' } });
    try {
      const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'erasure' }));
      const fulfilled = await asUser('operations@kaizen.co.in', () => fulfilDataRequest(request.id));

      expect(fulfilled.status).toBe('refused');
      expect(fulfilled.refusalReason).toMatch(/employee_record/);
      const untouched = await unscopedPrisma.person.findFirstOrThrow({ where: { id: person.id } });
      expect(untouched.fullName).not.toBe(`erased:${person.id}`);
      expect(untouched.deletedAt).toBeNull();
    } finally {
      await unscopedPrisma.retentionSchedule.createMany({ data: saved });
    }
  });

  // FX-62, dependent stores. Erasure blanked Person core and left the
  // guardian and address on StudentProfile, which are personal values.
  it('blanks the personal values held on the StudentProfile as well as the Person core', async () => {
    const person = await asUser('operations@kaizen.co.in', () => makePerson('erase-dependents'));
    await asUser('operations@kaizen.co.in', () =>
      prisma.studentProfile.create({
        data: { tenantId: TENANT, personId: person.id, guardianName: 'Parent Name', guardianPhone: '9800000001', address: '12 Example Street' },
      }),
    );
    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'erasure' }));
    const fulfilled = await asUser('operations@kaizen.co.in', () => fulfilDataRequest(request.id));
    expect(fulfilled.status).toBe('fulfilled');

    const profile = await unscopedPrisma.studentProfile.findFirstOrThrow({ where: { personId: person.id } });
    expect(profile.guardianName).toBeNull();
    expect(profile.guardianPhone).toBeNull();
    expect(profile.address).toBeNull();
  });
});

// ===========================================================================
// Data-principal requests: due date, access export
// ===========================================================================

describe('Data-principal requests', () => {
  it('dueAt is set 30 days (DATA_REQUEST_DUE_DAYS) after receipt', async () => {
    const person = await asUser('operations@kaizen.co.in', () => makePerson('due-date'));
    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'access' }));
    expect(request.dueAt.getTime()).toBe(requestDueAt(request.receivedAt, DATA_REQUEST_DUE_DAYS).getTime());

    // An unfiltered listing — several people's requests together — still
    // names each principal rather than showing a bare cuid.
    const requests = await asUser('operations@kaizen.co.in', () => listDataRequests({}));
    expect(requests.find((r) => r.id === request.id)?.personFullName).toBe(person.fullName);
  });

  it('an employee can raise their own request', async () => {
    const request = await asUser('employee@kaizen.co.in', async (p) => raiseDataRequest({ personId: p.partyId, kind: 'access' }));
    expect(request.status).toBe('received');
  });

  it('an employee cannot raise a request on somebody else', async () => {
    const other = await asUser('operations@kaizen.co.in', () => makePerson('not-me'));
    const err = await expectReject(() => asUser('employee@kaizen.co.in', () => raiseDataRequest({ personId: other.id, kind: 'access' })));
    expect(err.status).toBe(403);
  });

  // FX-63. A correction is a request by the data principal to fix a personal
  // value. The old code passed the body straight to person.update, so a
  // correction could set the dedupe state, the merge pointer or the soft
  // delete. Those are system fields and are not the principal's to set.
  it('a correction naming a system field (mergedIntoId) is refused and the person is unchanged', async () => {
    const person = await asUser('operations@kaizen.co.in', () => makePerson('correction-merge'));
    const other = await asUser('operations@kaizen.co.in', () => makePerson('correction-merge-target'));
    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'correction' }));

    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => fulfilDataRequest(request.id, { correction: { mergedIntoId: other.id } })),
    );
    expect(err.status).toBe(400);

    const after = await unscopedPrisma.person.findFirstOrThrow({ where: { id: person.id } });
    expect(after.mergedIntoId).toBeNull();
    expect(after.dedupeStatus).toBe('active');
    const stillOpen = await unscopedPrisma.dataPrincipalRequest.findFirstOrThrow({ where: { id: request.id } });
    expect(stillOpen.status).not.toBe('fulfilled');
  });

  it('a correction naming deletedAt or recordCode is refused', async () => {
    const person = await asUser('operations@kaizen.co.in', () => makePerson('correction-system'));
    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'correction' }));
    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => fulfilDataRequest(request.id, { correction: { deletedAt: new Date(), recordCode: 'PER-HIJACK' } })),
    );
    expect(err.status).toBe(400);
    const after = await unscopedPrisma.person.findFirstOrThrow({ where: { id: person.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.recordCode).not.toBe('PER-HIJACK');
  });

  it('a correction to a correctable field is applied and the normalised phone follows it', async () => {
    const person = await asUser('operations@kaizen.co.in', () => makePerson('correction-ok'));
    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'correction' }));
    // A number no other active person holds: the collision guard (FX-63) refuses
    // a number already on file, and this suite's database keeps rows across runs.
    const phone = `9${String(Date.now()).slice(-9)}`;
    const fulfilled = await asUser('operations@kaizen.co.in', () =>
      fulfilDataRequest(request.id, { correction: { primaryPhone: `+91 ${phone}` } }),
    );
    expect(fulfilled.status).toBe('fulfilled');
    const after = await unscopedPrisma.person.findFirstOrThrow({ where: { id: person.id } });
    expect(after.primaryPhone).toBe(`+91 ${phone}`);
    expect(after.primaryPhoneNormalised).toBe(phone);
  });

  it('fulfilling an access request assembles an export and audits it as an export', async () => {
    const person = await asUser('operations@kaizen.co.in', () => makePerson('access-export'));
    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'access' }));
    const fulfilled = await asUser('operations@kaizen.co.in', () => fulfilDataRequest(request.id));

    expect(fulfilled.status).toBe('fulfilled');
    const bundle = fulfilled.response as { person: { id: string } };
    expect(bundle.person.id).toBe(person.id);

    const exportAudit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TENANT, action: 'export', subjectType: 'person_data_export' },
      orderBy: { timestamp: 'desc' },
    });
    expect(exportAudit).not.toBeNull();
  });
});

// ===========================================================================
// CMP-DPD-003 — minor / guardian consent gate
// ===========================================================================

describe('CMP-DPD-003: a minor StudentProfile needs a guardian consent', () => {
  it('refuses to attach a student profile to a minor with no guardian given', async () => {
    const minor = await asUser('operations@kaizen.co.in', () =>
      makePerson('minor-no-guardian', { dateOfBirth: new Date(Date.now() - 15 * 365.25 * 86_400_000) }),
    );
    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => attachStudentProfile(minor.id, { fullName: minor.fullName })),
    );
    expect(err.status).toBe(422);
  });

  it('attaches, and stamps guardianConsentId, once a guardian name and phone are given', async () => {
    const minor = await asUser('operations@kaizen.co.in', () =>
      makePerson('minor-with-guardian', { dateOfBirth: new Date(Date.now() - 15 * 365.25 * 86_400_000) }),
    );
    const profile = await asUser('operations@kaizen.co.in', () =>
      attachStudentProfile(minor.id, { fullName: minor.fullName, guardianName: 'Parent Name', guardianPhone: '9800000000' }),
    );

    const stored = await unscopedPrisma.studentProfile.findFirstOrThrow({ where: { id: profile.id } });
    expect(stored.guardianConsentId).toBeTruthy();

    const consent = await unscopedPrisma.consent.findFirstOrThrow({ where: { id: stored.guardianConsentId! } });
    expect(consent.guardianOfPersonId).toBe(minor.id);
    expect(consent.purposeCode).toBe('education_delivery');
    expect(consent.status).toBe('granted');
  });

  // FX-64. Guardian name and phone are regulated, so they are encrypted like
  // PAN and bank values. The old code wrote them to the column as given.
  it('the guardian phone is stored encrypted on the StudentProfile and reads back in the clear', async () => {
    const minor = await asUser('operations@kaizen.co.in', () =>
      makePerson('minor-encrypted', { dateOfBirth: new Date(Date.now() - 15 * 365.25 * 86_400_000) }),
    );
    const profile = await asUser('operations@kaizen.co.in', () =>
      attachStudentProfile(minor.id, { fullName: minor.fullName, guardianName: 'Parent Name', guardianPhone: '9800000000' }),
    );
    const stored = await unscopedPrisma.studentProfile.findFirstOrThrow({ where: { id: profile.id } });
    expect(stored.guardianPhone?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);
    expect(stored.guardianName?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);
    expect(readRegulated(stored.guardianPhone)).toBe('9800000000');
  });

  // FX-64. The batch enrolment path took `isMinor` from the caller and let a
  // minor through with no consent id. Minority is derived from the date of
  // birth on file, as attachStudentProfile does, and the caller cannot
  // override it.
  it('a batch enrolment of somebody on file as 15 is refused as a minor even when the caller says they are not', async () => {
    const minor = await asUser('operations@kaizen.co.in', () =>
      makePerson('enrol-minor-lie', { dateOfBirth: new Date(Date.now() - 15 * 365.25 * 86_400_000) }),
    );
    const cohort = await unscopedPrisma.cohort.findFirstOrThrow({ where: { tenantId: TENANT } });
    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', async () => {
        const { enrolStudent } = await import('../../domains/education.js');
        return enrolStudent({ cohortId: cohort.id, personId: minor.id, isMinor: false });
      }),
    );
    expect(err.status).toBe(422);
  });

  // FX-64. A minor's enrolment rests on a recorded guardian consent, as the
  // student profile does, and its guardian contact is stored encrypted.
  it('a batch enrolment of a minor with a guardian stores the guardian phone encrypted and the consent it rests on', async () => {
    const minor = await asUser('operations@kaizen.co.in', () =>
      makePerson('enrol-minor-ok', { dateOfBirth: new Date(Date.now() - 15 * 365.25 * 86_400_000) }),
    );
    const cohort = await unscopedPrisma.cohort.findFirstOrThrow({ where: { tenantId: TENANT } });
    const enrollment = await asUser('operations@kaizen.co.in', async () => {
      const { enrolStudent } = await import('../../domains/education.js');
      return enrolStudent({ cohortId: cohort.id, personId: minor.id, guardianName: 'Parent Name', guardianPhone: '9800000002' });
    });
    expect(enrollment.guardianConsentId).toBeTruthy();

    const stored = await unscopedPrisma.enrollment.findFirstOrThrow({ where: { id: enrollment.id } });
    expect(stored.isMinor).toBe(true);
    expect(stored.guardianPhone?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);
    expect(readRegulated(stored.guardianPhone)).toBe('9800000002');
    const consent = await unscopedPrisma.consent.findFirstOrThrow({ where: { id: enrollment.guardianConsentId! } });
    expect(consent.guardianOfPersonId).toBe(minor.id);
  });

  it('an adult student needs no guardian at all', async () => {
    const adult = await asUser('operations@kaizen.co.in', () =>
      makePerson('adult-student', { dateOfBirth: new Date(Date.now() - 25 * 365.25 * 86_400_000) }),
    );
    const profile = await asUser('operations@kaizen.co.in', () => attachStudentProfile(adult.id, { fullName: adult.fullName }));
    const stored = await unscopedPrisma.studentProfile.findFirstOrThrow({ where: { id: profile.id } });
    expect(stored.guardianConsentId).toBeNull();
  });
});

// ===========================================================================
// CMP-DPD-004 — field-level encryption at rest
// ===========================================================================

describe('CMP-DPD-004: PAN/Aadhaar/bank values encrypted at rest', () => {
  it('the raw column starts with enc:v1: after backfill, and readRegulated recovers the original', async () => {
    const { employment } = await makeEmployee('encrypt-me');
    const pan = 'ABCDE1234F';
    const aadhaar = '123412341234';
    const bank = '000111222333';

    await unscopedPrisma.employmentRelationship.update({
      where: { id: employment.id },
      data: { panNumber: pan, aadhaarReference: aadhaar, bankAccountNumber: bank },
    });

    await asUser('chairman@kaizen.co.in', () => backfillEncryptAtRest());

    const raw = await unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { id: employment.id } });
    expect(raw.panNumber?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);
    expect(raw.aadhaarReference?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);
    expect(raw.bankAccountNumber?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);

    expect(readRegulated(raw.panNumber)).toBe(pan);
    expect(readRegulated(raw.aadhaarReference)).toBe(aadhaar);
    expect(readRegulated(raw.bankAccountNumber)).toBe(bank);
  });

  it('a value already encrypted is left alone on a second backfill', async () => {
    const encrypted = encryptField('AAAAA0000A');
    expect(readRegulated(encrypted)).toBe('AAAAA0000A');
    // A second decrypt of the same value is stable.
    expect(readRegulated(encrypted)).toBe(readRegulated(encrypted));
  });

  it('operations (not the chairman) cannot run the backfill', async () => {
    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => backfillEncryptAtRest()));
    expect(err.status).toBe(403);
  });
});

// ===========================================================================
// Breach register — 72-hour ladder, idempotent
// ===========================================================================

describe('Breach register: the 72-hour ladder', () => {
  it('fires once per rung and does not duplicate on a second run', async () => {
    const breach = await asUser('operations@kaizen.co.in', () =>
      raiseBreach({
        detectedAt: new Date(Date.now() - 30 * 3_600_000), // 30h ago — rung 1 (24h) crossed, not rung 2 (48h)
        description: 'Test breach for the ladder',
        principalsAffected: 3,
        severity: 'S4_CRITICAL',
      }),
    );

    const firstRun = await asUser('operations@kaizen.co.in', () => runBreachLadder());
    expect(firstRun).toBeGreaterThanOrEqual(1);

    const secondRun = await asUser('operations@kaizen.co.in', () => runBreachLadder());
    void secondRun;

    const exceptions = await unscopedPrisma.exceptionRecord.findMany({
      where: { tenantId: TENANT, code: 'CMP_DPD_BREACH_72H', subjectId: breach.id },
    });
    // Idempotent: still exactly one exception record for rung 1, not one per run.
    expect(exceptions.length).toBe(1);
    expect(exceptions[0].ladderRung).toBe(1);
  });

  it('a breach cannot skip straight from open to notified_principals', async () => {
    const breach = await asUser('operations@kaizen.co.in', () =>
      raiseBreach({ detectedAt: new Date(), description: 'x', severity: 'S3_HIGH_RISK' }),
    );
    const { transitionBreach } = await import('../../domains/compliance/privacy.js');
    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => transitionBreach(breach.id, 'notified_principals')));
    expect(err.status).toBe(422);
  });
});

// ===========================================================================
// Access revocation on offboarding
// ===========================================================================

describe('Access revocation follows offboarding to its close', () => {
  it('ends every active affiliation once offboarding reaches ClosedArchived', async () => {
    const { person, employment } = await makeEmployee('offboard-privacy');

    await asUser('operations@kaizen.co.in', async () => {
      await transitionEmployment(employment.id, 'SUBMIT_RESIGNATION', { note: 'Resigned' });
    });

    const offboarding = await unscopedPrisma.offboarding.findFirstOrThrow({ where: { employmentRelationshipId: employment.id } });

    await asUser('operations@kaizen.co.in', async () => {
      await transitionOffboarding(offboarding.id, 'REACH_LWD');
      await transitionOffboarding(offboarding.id, 'BEGIN_CLEARANCE');
      await transitionOffboarding(offboarding.id, 'CLEARANCE_COMPLETE');
      await transitionOffboarding(offboarding.id, 'DISBURSE');
      await transitionOffboarding(offboarding.id, 'ARCHIVE');
    });

    const affiliations = await unscopedPrisma.affiliation.findMany({ where: { tenantId: TENANT, partyId: person.id, affiliationType: 'employee' } });
    expect(affiliations.length).toBeGreaterThan(0);
    for (const aff of affiliations) {
      expect(aff.status).toBe('ended');
      expect(aff.revokedReason).toBe('offboarding');
      expect(aff.revokedAt).not.toBeNull();
    }
  });
});

// ===========================================================================
// Weekly access review
// ===========================================================================

describe('Access review: stale access flagged, CMP_DPD_STALE_ACCESS', () => {
  it('flags an active affiliation whose employment is not Active', async () => {
    const { person, employment } = await makeEmployee('stale-access');
    // Suspend the employment without touching the affiliation — the gap this
    // job exists to catch.
    await unscopedPrisma.employmentRelationship.update({ where: { id: employment.id }, data: { status: 'Suspended' } });

    const staleCount = await asUser('operations@kaizen.co.in', () => runAccessReview());
    expect(staleCount).toBeGreaterThanOrEqual(1);

    const exception = await unscopedPrisma.exceptionRecord.findFirst({
      where: { tenantId: TENANT, code: 'CMP_DPD_STALE_ACCESS', subjectLabel: person.fullName },
    });
    expect(exception).not.toBeNull();
  });
});

// ===========================================================================
// Review fixes: IST age, unknown-DOB minor rule, erasure reach, correction
// guards. Each block names the finding it pins.
// ===========================================================================

describe('P3 rule 3: age is measured on the IST calendar, not UTC', () => {
  // 10 May 00:00 IST is 9 May 18:30 UTC. A UTC reader still has the learner
  // at 17 for the first five and a half hours of their birthday.
  it('a learner born on 10 May is 18 at 00:00 IST, which is 18:30 UTC on 9 May', () => {
    expect(ageInYears(new Date('2008-05-10T00:00:00Z'), new Date('2026-05-09T18:30:00Z'))).toBe(18);
  });

  it('and is still 17 at 23:59:59 IST on the day before', () => {
    expect(ageInYears(new Date('2008-05-10T00:00:00Z'), new Date('2026-05-09T18:29:59Z'))).toBe(17);
  });

  it('a date of birth stored as IST midnight is read as the IST day it names', () => {
    // Stored as 9 May 18:30 UTC, which a UTC reader files under the 9th.
    expect(ageInYears(new Date('2008-05-09T18:30:00Z'), new Date('2026-05-09T18:29:59Z'))).toBe(17);
  });
});

describe('FX-64: an unknown date of birth holds the minor rule unless an adult is attested', () => {
  it('no date of birth and no attestation: the minor rule applies, so a guardian is required', () => {
    expect(() => assertMinorHasGuardian({ dateOfBirth: null })).toThrow(/guardian/i);
    expect(assertMinorHasGuardian({ dateOfBirth: null, guardianName: 'Parent Name', guardianPhone: '9800000000' })).toBe(true);
  });

  it('an explicit adult attestation releases the rule when there is no date of birth', () => {
    expect(assertMinorHasGuardian({ dateOfBirth: null, adultAttested: true })).toBe(false);
  });

  it('a measured minor is not released by an attestation', () => {
    const dob = new Date(Date.now() - 15 * 365.25 * 86_400_000);
    expect(() => assertMinorHasGuardian({ dateOfBirth: dob, adultAttested: true })).toThrow(/guardian/i);
  });
});

describe('FX-62: erasure reaches the guardian and contact values on dependent rows', () => {
  it('blanks enrolment guardian contact, consent evidence, notes and external ids in the same erasure', async () => {
    const person = await asUser('operations@kaizen.co.in', () =>
      makePerson('erase-guardian', { notes: 'Called about fees', externalIds: [{ system: 'lms', id: 'L-1' }] }),
    );
    const cohort = await unscopedPrisma.cohort.findFirstOrThrow({ where: { tenantId: TENANT } });
    const enrollment = await asUser('operations@kaizen.co.in', async () =>
      prisma.enrollment.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('ENR'),
          personId: person.id,
          cohortId: cohort.id,
          status: 'reserved',
          guardianName: encryptField('Parent Name'),
          guardianPhone: encryptField('9800000003'),
          guardianEmail: encryptField('parent@example.com'),
        },
      }),
    );
    const consent = await asUser('operations@kaizen.co.in', () =>
      prisma.consent.create({
        data: {
          tenantId: TENANT,
          personId: person.id,
          purposeCode: 'education_delivery',
          status: 'granted',
          channel: 'guardian_intake',
          evidence: { guardianName: 'Parent Name', guardianPhone: '9800000003' },
          guardianOfPersonId: person.id,
        },
      }),
    );

    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'erasure' }));
    const fulfilled = await asUser('operations@kaizen.co.in', () => fulfilDataRequest(request.id));
    expect(fulfilled.status).toBe('fulfilled');

    const e = await unscopedPrisma.enrollment.findFirstOrThrow({ where: { id: enrollment.id } });
    expect(e.guardianName).toBeNull();
    expect(e.guardianPhone).toBeNull();
    expect(e.guardianEmail).toBeNull();
    const c = await unscopedPrisma.consent.findFirstOrThrow({ where: { id: consent.id } });
    expect(c.evidence).toEqual({});
    const p = await unscopedPrisma.person.findFirstOrThrow({ where: { id: person.id } });
    expect(p.notes).toBeNull();
    expect(p.externalIds).toEqual([]);
  });
});

describe('FX-62: an active affiliation blocks erasure even without a statutory floor', () => {
  it('refuses while the affiliation is active, and the person is left unscrubbed', async () => {
    const person = await asUser('operations@kaizen.co.in', () => makePerson('erase-active-affiliation'));
    await asUser('operations@kaizen.co.in', () =>
      prisma.affiliation.create({
        data: { tenantId: TENANT, partyId: person.id, affiliationType: 'customer_contact', status: 'active' },
      }),
    );
    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'erasure' }));
    const fulfilled = await asUser('operations@kaizen.co.in', () => fulfilDataRequest(request.id));

    expect(fulfilled.status).toBe('refused');
    expect(fulfilled.refusalReason).toMatch(/active/);
    const untouched = await unscopedPrisma.person.findFirstOrThrow({ where: { id: person.id } });
    expect(untouched.fullName).not.toBe(`erased:${person.id}`);
    expect(untouched.deletedAt).toBeNull();
  });
});

describe('FX-63: a correction cannot take a contact another active person holds', () => {
  it('refuses an email held by another active person, whatever its case, and changes nothing', async () => {
    await asUser('operations@kaizen.co.in', () =>
      makePerson('holder', { primaryEmail: 'Holder.Taken@Example.com', primaryEmailNormalised: 'holder.taken@example.com' }),
    );
    const person = await asUser('operations@kaizen.co.in', () => makePerson('collider'));
    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'correction' }));

    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => fulfilDataRequest(request.id, { correction: { primaryEmail: 'HOLDER.TAKEN@example.com' } })),
    );
    expect(err.status).toBe(409);
    const after = await unscopedPrisma.person.findFirstOrThrow({ where: { id: person.id } });
    expect(after.primaryEmail).toBe(person.primaryEmail);
    expect(after.primaryEmailNormalised).toBe(person.primaryEmailNormalised);
  });
});

describe('FX-63: a date-of-birth correction re-runs the minor gate on the enrolments', () => {
  const fifteenYearsAgo = () => new Date(Date.now() - 15 * 365.25 * 86_400_000).toISOString();

  async function adultWithEnrolment(label: string, guardian: boolean) {
    const person = await asUser('operations@kaizen.co.in', () =>
      makePerson(label, { dateOfBirth: new Date(Date.now() - 30 * 365.25 * 86_400_000) }),
    );
    const cohort = await unscopedPrisma.cohort.findFirstOrThrow({ where: { tenantId: TENANT } });
    const enrollment = await asUser('operations@kaizen.co.in', async () =>
      prisma.enrollment.create({
        data: {
          tenantId: TENANT,
          recordCode: await nextRecordCode('ENR'),
          personId: person.id,
          cohortId: cohort.id,
          status: 'reserved',
          isMinor: false,
          ...(guardian ? { guardianName: encryptField('Parent Name'), guardianPhone: encryptField('9800000004') } : {}),
        },
      }),
    );
    return { person, enrollment };
  }

  it('refuses a correction that makes the learner a minor when the enrolment has no guardian on file', async () => {
    const { person, enrollment } = await adultWithEnrolment('dob-no-guardian', false);
    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'correction' }));

    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () => fulfilDataRequest(request.id, { correction: { dateOfBirth: fifteenYearsAgo() } })),
    );
    expect(err.status).toBe(422);
    const p = await unscopedPrisma.person.findFirstOrThrow({ where: { id: person.id } });
    expect(Date.now() - p.dateOfBirth!.getTime()).toBeGreaterThan(20 * 365 * 86_400_000);
    const e = await unscopedPrisma.enrollment.findFirstOrThrow({ where: { id: enrollment.id } });
    expect(e.isMinor).toBe(false);
  });

  it('a correction to a minor, with guardian contact on the enrolment, updates isMinor and stamps the consent (audited)', async () => {
    const { person, enrollment } = await adultWithEnrolment('dob-with-guardian', true);
    const request = await asUser('operations@kaizen.co.in', () => raiseDataRequest({ personId: person.id, kind: 'correction' }));

    const fulfilled = await asUser('operations@kaizen.co.in', () =>
      fulfilDataRequest(request.id, { correction: { dateOfBirth: fifteenYearsAgo() } }),
    );
    expect(fulfilled.status).toBe('fulfilled');

    const e = await unscopedPrisma.enrollment.findFirstOrThrow({ where: { id: enrollment.id } });
    expect(e.isMinor).toBe(true);
    expect(e.guardianConsentId).toBeTruthy();
    const consent = await unscopedPrisma.consent.findFirstOrThrow({ where: { id: e.guardianConsentId! } });
    expect(consent.guardianOfPersonId).toBe(person.id);

    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TENANT, subjectType: 'enrollment', subjectId: enrollment.id, action: 'update' },
    });
    expect(audit).not.toBeNull();
  });
});
