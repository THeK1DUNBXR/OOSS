/**
 * A status change and the side effects that come with it commit or vanish together.
 *
 * `transition()` writes its audit row and its event before the domain write runs.
 * So when the write, or a letter or an exception raised after it, is refused, the
 * audit row and the event are already committed for a status that never changed:
 * the audit trail says a transition happened and the subscribers act on it.
 *
 * These tests make one insert refused on purpose (a test-only trigger on
 * audit_records, installed for one call, scoped to the subject type whose audit
 * row comes after the status write) and check that the domain row, every audit
 * row for the subject and every event for the subject are unchanged once the
 * call rejects. Real Postgres and the real decision paths. The trigger is a fault
 * injection, not a mock: the insert really is refused by the database.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '../platform/context.js';
import { asPrincipal, asUser, expectReject, prisma, tenantId, unscopedPrisma } from './helpers.js';
import { hire, transitionEmployment, transitionOffboarding } from '../domains/employment.js';
import { createLetterRequest, fulfilLetterRequest, rejectLetterRequest } from '../domains/hcm/assets.js';
import {
  createApplication,
  createRequisition,
  transitionApplication,
  transitionRequisition,
} from '../domains/hiring.js';
import { createCandidate } from '../domains/hcm/recruiting.js';
import { nextRecordCode } from '../platform/recordCode.js';

const HR = 'hr@kaizen.co.in';
const OPS = 'operations@kaizen.co.in';
const INJECTED = 'injected audit refusal';

let TENANT: string;
let seq = 0;

async function refuseAuditFor(subjectType: string): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION w2fu_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW."subjectType" = TG_ARGV[0] THEN RAISE EXCEPTION '${INJECTED}'; END IF;
       RETURN NEW;
     END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER w2fu_refuse_audit BEFORE INSERT ON audit_records
     FOR EACH ROW EXECUTE FUNCTION w2fu_refuse_audit('${subjectType}')`,
  );
}

async function restoreAuditRefusal(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w2fu_refuse_audit ON audit_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w2fu_refuse_audit()`);
}

afterEach(async () => {
  await restoreAuditRefusal();
});

beforeAll(async () => {
  TENANT = await tenantId();
});

/** Every audit row and every event recorded against one subject. What a rolled-back call must leave unchanged. */
async function footprint(subjectType: string, subjectId: string) {
  const [audits, events] = await Promise.all([
    unscopedPrisma.auditRecord.count({ where: { tenantId: TENANT, subjectType, subjectId } }),
    unscopedPrisma.eventRecord.count({
      where: { tenantId: TENANT, subjectEntityType: subjectType, subjectEntityId: subjectId },
    }),
  ]);
  return { audits, events };
}

async function asEmployee<T>(partyId: string, fn: () => Promise<T>): Promise<T> {
  const auth: AuthContext = {
    tenantId: TENANT,
    principalType: 'human',
    partyId,
    userId: null,
    agentId: null,
    onBehalfOfPartyId: null,
    affiliationId: null,
    roleSlug: 'employee',
    branch: null,
    orgUnitId: null,
    classificationCeiling: 'regulated',
    purpose: 'operational',
    consentCodes: [],
    stepUpVerified: true,
  };
  return asPrincipal(auth, fn);
}

/** A throwaway employee, hired and activated, so no other test reads the rows this writes. */
async function activeEmployee(label: string) {
  seq += 1;
  const stamp = `${Date.now()}-${seq}-${Math.floor(Math.random() * 1e6)}`;
  return asUser(HR, async () => {
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
        fullName: `Atomicity ${label} ${stamp}`,
        primaryEmail: `atomic.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const hired = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(hired.id, 'ACTIVATE');
    return { employment: hired, personId: person.id };
  });
}

/** An application taken to OfferExtended, against a requisition published for it. */
async function offerExtendedApplication(label: string) {
  seq += 1;
  const stamp = `${Date.now()}-${seq}-${Math.floor(Math.random() * 1e6)}`;
  return asUser(OPS, async () => {
    const position = await prisma.position.create({
      data: {
        tenantId: TENANT,
        recordCode: await nextRecordCode('POS'),
        jobId: (await prisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        orgUnitId: (await prisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
        status: 'Open',
      },
    });
    const requisition = await createRequisition({ positionId: position.id });
    await transitionRequisition(requisition.id, 'SUBMIT');
    await transitionRequisition(requisition.id, 'APPROVE');
    await transitionRequisition(requisition.id, 'PUBLISH');
    const candidate = await createCandidate({
      fullName: `Atomicity ${label} ${stamp}`,
      primaryEmail: `atomic.${label}.${stamp}@example.com`,
      source: 'job_board',
    });
    const application = await createApplication({
      requisitionId: requisition.id,
      candidatePartyId: candidate.person.id,
    });
    await transitionApplication(application.id, 'ADVANCE'); // Screening
    await transitionApplication(application.id, 'ADVANCE'); // Interviewing
    await transitionApplication(application.id, 'ADVANCE'); // Selected
    return transitionApplication(application.id, 'EXTEND_OFFER'); // OfferExtended
  });
}

describe('an absence breach: the status change, its audit row, its event and EX-HR-001 commit together', () => {
  it('when the exception audit row is refused, the employee stays Active and the breach leaves no trace', async () => {
    const { employment } = await activeEmployee('absence');
    const before = await footprint('employment_relationship', employment.id);

    await refuseAuditFor('exception');
    await expectReject(() => asUser(HR, () => transitionEmployment(employment.id, 'ABSENCE_BREACH')));

    const after = await unscopedPrisma.employmentRelationship.findUniqueOrThrow({ where: { id: employment.id } });
    expect(after.status).toBe('Active');
    expect(await footprint('employment_relationship', employment.id)).toEqual(before);
    expect(
      await unscopedPrisma.exceptionRecord.count({
        where: { tenantId: TENANT, code: 'EX-HR-001', subjectId: employment.id },
      }),
    ).toBe(0);
  });
});

describe('a resignation opens the offboarding in the same transaction as the status change', () => {
  it('when the offboarding audit row is refused, the employee stays Active and no transition is recorded', async () => {
    const { employment } = await activeEmployee('resign');
    const before = await footprint('employment_relationship', employment.id);

    await refuseAuditFor('offboarding');
    await expectReject(() => asUser(HR, () => transitionEmployment(employment.id, 'SUBMIT_RESIGNATION')));

    const after = await unscopedPrisma.employmentRelationship.findUniqueOrThrow({ where: { id: employment.id } });
    expect(after.status).toBe('Active');
    expect(await footprint('employment_relationship', employment.id)).toEqual(before);
    expect(await unscopedPrisma.offboarding.count({ where: { employmentRelationshipId: employment.id } })).toBe(0);
  });
});

describe('archiving a completed offboarding issues its exit letters in the same transaction', () => {
  it('when a letter audit row is refused, the offboarding stays FFSettlementCompleted and no letter is issued', async () => {
    const { employment } = await activeEmployee('archive');
    await asUser(HR, () => transitionEmployment(employment.id, 'SUBMIT_RESIGNATION'));
    const offboarding = await unscopedPrisma.offboarding.findUniqueOrThrow({
      where: { employmentRelationshipId: employment.id },
    });
    // A fixture, not a transition: the settlement steps are not what this probes.
    await unscopedPrisma.offboarding.update({
      where: { id: offboarding.id },
      data: { status: 'FFSettlementCompleted' },
    });
    const before = await footprint('offboarding', offboarding.id);
    const lettersBefore = await unscopedPrisma.hrLetter.count({
      where: { tenantId: TENANT, employmentRelationshipId: employment.id },
    });

    await refuseAuditFor('hr_letter');
    await expectReject(() => asUser(HR, () => transitionOffboarding(offboarding.id, 'ARCHIVE')));

    const after = await unscopedPrisma.offboarding.findUniqueOrThrow({ where: { id: offboarding.id } });
    expect(after.status).toBe('FFSettlementCompleted');
    expect(await footprint('offboarding', offboarding.id)).toEqual(before);
    expect(
      await unscopedPrisma.hrLetter.count({ where: { tenantId: TENANT, employmentRelationshipId: employment.id } }),
    ).toBe(lettersBefore);
  });
});

describe('accepting an offer appoints the candidate in the same transaction as the application moves', () => {
  it('when the appointment letter audit row is refused, the application stays OfferExtended', async () => {
    const application = await offerExtendedApplication('accept');
    const before = await footprint('application', application.id);

    await refuseAuditFor('hr_letter');
    await expectReject(() => asUser(OPS, () => transitionApplication(application.id, 'ACCEPT_OFFER')));

    const after = await unscopedPrisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(after.status).toBe('OfferExtended');
    expect(await footprint('application', application.id)).toEqual(before);
    expect(await unscopedPrisma.hrLetter.count({ where: { tenantId: TENANT, applicationId: application.id } })).toBe(0);
  });
});

describe('fulfilling a letter request issues its letter in the same transaction as the fulfilment', () => {
  it('when the request audit row is refused, the request stays requested and no letter is issued', async () => {
    const { employment, personId } = await activeEmployee('fulfil');
    const request = await asEmployee(personId, () =>
      createLetterRequest({ employmentRelationshipId: employment.id, kind: 'experience' }),
    );
    const before = await footprint('letter_request', request.id);

    await refuseAuditFor('letter_request');
    await expectReject(() => asUser(OPS, () => fulfilLetterRequest(request.id)));

    const after = await unscopedPrisma.letterRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.status).toBe('requested');
    expect(await footprint('letter_request', request.id)).toEqual(before);
    expect(
      await unscopedPrisma.hrLetter.count({
        where: { tenantId: TENANT, employmentRelationshipId: employment.id, kind: 'experience' },
      }),
    ).toBe(0);
  });
});

describe('rejecting a letter request records its decision in the same transaction', () => {
  it('when the decision audit row is refused, the request stays requested', async () => {
    const { employment, personId } = await activeEmployee('reject');
    const request = await asEmployee(personId, () =>
      createLetterRequest({ employmentRelationshipId: employment.id, kind: 'noc' }),
    );
    const before = await footprint('letter_request', request.id);

    await refuseAuditFor('letter_request');
    await expectReject(() => asUser(OPS, () => rejectLetterRequest(request.id, 'Atomicity probe.')));

    const after = await unscopedPrisma.letterRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.status).toBe('requested');
    expect(await footprint('letter_request', request.id)).toEqual(before);
  });
});
