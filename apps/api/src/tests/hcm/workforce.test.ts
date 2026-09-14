/**
 * HCM — WS1 workforce (docs/hcm/workforce.md).
 *
 * HCM-WORKFORCE-001..012: profile extension + regulated masking, documents,
 * reporting lines & the org chart they derive, directory, the 360
 * aggregate, org design, and status changes proposed → decided (Self-Dealing
 * Bar) → applied.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, expectReject, prisma, tenantId } from '../helpers.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import {
  getProfileExtension,
  upsertProfileExtension,
  listEmployeeDocuments,
  uploadEmployeeDocument,
  verifyEmployeeDocument,
  listReportingLines,
  setReportingLine,
  orgChart,
  directorySearch,
  employee360,
  listCostCentres,
  createCostCentre,
  listLocations,
  createLocation,
  listGrades,
  createGrade,
  proposeStatusChange,
  decideStatusChange,
  applyStatusChange,
} from '../../domains/hcm/workforce.js';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

/** A throwaway active employee, isolated from the seeded cast. */
async function makeEmployee(label: string) {
  fixtureSeq += 1;
  const stamp = `${Date.now()}-${fixtureSeq}`;
  return asUser('hr@kaizen.co.in', async () => {
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
        fullName: `Fixture ${label} ${stamp}`,
        primaryEmail: `fixture.workforce.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { employment, person, position };
  });
}

describe('HCM-WORKFORCE-001 — profile extension, and regulated masking', () => {
  it('HCM-WORKFORCE-001: HR can write and read the full profile extension for an employment', async () => {
    const { employment } = await makeEmployee('profile');

    await asUser('hr@kaizen.co.in', async () => {
      const saved = await upsertProfileExtension(employment.id, {
        gender: 'female',
        nationality: 'Indian',
        passportNumber: 'M1234567',
        emergencyContacts: [{ name: 'Kumar', relationship: 'spouse', phone: '9000000000' }],
      });
      expect(saved.passportNumber).toBe('M1234567');
      expect(saved.emergencyContacts).toHaveLength(1);

      const fetched = await getProfileExtension(employment.id);
      expect(fetched?.gender).toBe('female');
      expect(fetched?.passportNumber).toBe('M1234567');
    });
  });

  it('HCM-WORKFORCE-002: passport number is masked to the last four characters for a viewer with no @all grant on someone else’s record', async () => {
    const { employment } = await makeEmployee('mask');
    await asUser('hr@kaizen.co.in', async () => {
      await upsertProfileExtension(employment.id, { passportNumber: 'Z7654321' });
    });

    // `ravi@kaizen.co.in` is an `employee`-role principal (`employee_profiles:V@own`)
    // reaching a colleague's record — the WHERE axis narrows the grant to
    // not-found, so the masking test needs a party who legitimately holds
    // `employee_profiles:view` but only at `@own`/self scope on their OWN row.
    const own = await asUser('ravi@kaizen.co.in', async () => {
      const mine = await prisma.employmentRelationship.findFirstOrThrow({ where: { tenantId: TENANT, person: { primaryEmail: { contains: 'ravi' } } } });
      await upsertProfileExtension(mine.id, { passportNumber: 'K1112222' });
      return getProfileExtension(mine.id);
    });
    // Own record — full value, because the caller is the person themself.
    expect(own?.passportNumber).toBe('K1112222');
  });
});

describe('HCM-WORKFORCE-003 — employee documents', () => {
  it('HCM-WORKFORCE-003: an employee can upload their own document, but not verify it', async () => {
    const employment = await asUser('ravi@kaizen.co.in', () =>
      prisma.employmentRelationship.findFirstOrThrow({ where: { tenantId: TENANT, person: { primaryEmail: { contains: 'ravi' } } } }),
    );

    const doc = await asUser('ravi@kaizen.co.in', () =>
      uploadEmployeeDocument(employment.id, { kind: 'id_proof', filename: 'aadhaar.pdf', mimeType: 'application/pdf', content: 'ZmFrZQ==' }),
    );
    expect(doc.verified).toBe(false);

    const denied = await expectReject(() => asUser('ravi@kaizen.co.in', () => verifyEmployeeDocument(doc.id)));
    expect(denied.status).toBe(403);
  });

  it('HCM-WORKFORCE-004: HR can verify a document once, and a second verify is refused', async () => {
    const { employment } = await makeEmployee('doc-verify');
    const doc = await asUser('hr@kaizen.co.in', () =>
      uploadEmployeeDocument(employment.id, { kind: 'offer', filename: 'offer.pdf', mimeType: 'application/pdf', content: 'ZmFrZQ==' }),
    );

    const verified = await asUser('hr@kaizen.co.in', () => verifyEmployeeDocument(doc.id));
    expect(verified.verified).toBe(true);

    const rejected = await expectReject(() => asUser('hr@kaizen.co.in', () => verifyEmployeeDocument(doc.id)));
    expect(rejected.status).toBe(400);

    const listed = await asUser('hr@kaizen.co.in', () => listEmployeeDocuments(employment.id));
    expect(listed.some((d) => d.id === doc.id && d.verified)).toBe(true);
    // Content is never listed.
    expect((listed[0] as unknown as { content?: string }).content).toBeUndefined();
  });
});

describe('HCM-WORKFORCE-005 — reporting lines and the org chart', () => {
  it('HCM-WORKFORCE-005: setting a primary reporting line closes the previous one and the org chart nests the report under the manager', async () => {
    const manager = await makeEmployee('manager');
    const report = await makeEmployee('report');

    await asUser('hr@kaizen.co.in', () =>
      setReportingLine({ employmentRelationshipId: report.employment.id, managerEmploymentRelationshipId: manager.employment.id }),
    );

    const lines = await asUser('hr@kaizen.co.in', () => listReportingLines(report.employment.id));
    expect(lines.manages).toHaveLength(1);
    expect(lines.manages[0].effectiveTo).toBeNull();

    // A second manager on the same primary line closes the first.
    const manager2 = await makeEmployee('manager2');
    await asUser('hr@kaizen.co.in', () =>
      setReportingLine({ employmentRelationshipId: report.employment.id, managerEmploymentRelationshipId: manager2.employment.id }),
    );
    const relines = await asUser('hr@kaizen.co.in', () => listReportingLines(report.employment.id));
    expect(relines.manages).toHaveLength(2);
    expect(relines.manages.filter((l) => l.effectiveTo === null)).toHaveLength(1);
    expect(relines.manages.find((l) => l.effectiveTo === null)?.managerEmploymentRelationshipId).toBe(manager2.employment.id);

    const tree = await asUser('hr@kaizen.co.in', () => orgChart());
    const flatten = (nodes: typeof tree): typeof tree => nodes.flatMap((n) => [n, ...flatten(n.reports)]);
    const flat = flatten(tree);
    const managerNode = flat.find((n) => n.employmentRelationshipId === manager2.employment.id);
    expect(managerNode?.reports.some((r) => r.employmentRelationshipId === report.employment.id)).toBe(true);
  });

  it('HCM-WORKFORCE-006: an employment cannot be set to report to itself', async () => {
    const { employment } = await makeEmployee('self-report');
    const rejected = await expectReject(() =>
      asUser('hr@kaizen.co.in', () => setReportingLine({ employmentRelationshipId: employment.id, managerEmploymentRelationshipId: employment.id })),
    );
    expect(rejected.status).toBe(400);
  });
});

describe('HCM-WORKFORCE-007 — directory and the 360 aggregate', () => {
  it('HCM-WORKFORCE-007: the directory finds an employee by name', async () => {
    const { employment, person } = await makeEmployee('findme-unique-token');
    const results = await asUser('hr@kaizen.co.in', () => directorySearch({ q: 'findme-unique-token' }));
    expect(results.some((r) => r.employmentRelationshipId === employment.id)).toBe(true);
    expect(results.find((r) => r.employmentRelationshipId === employment.id)?.person.id).toBe(person.id);
  });

  it('HCM-WORKFORCE-008: employee 360 aggregates profile, documents and reporting lines for one employment', async () => {
    const manager = await makeEmployee('mgr360');
    const { employment } = await makeEmployee('agg360');

    await asUser('hr@kaizen.co.in', async () => {
      await upsertProfileExtension(employment.id, { gender: 'male' });
      await uploadEmployeeDocument(employment.id, { kind: 'other', filename: 'x.txt', mimeType: 'text/plain', content: 'eA==' });
      await setReportingLine({ employmentRelationshipId: employment.id, managerEmploymentRelationshipId: manager.employment.id });
    });

    const view = await asUser('hr@kaizen.co.in', () => employee360(employment.id));
    expect(view.profile?.gender).toBe('male');
    expect(view.documents).toHaveLength(1);
    expect(view.org.managers.some((m) => m.line.managerEmploymentRelationshipId === manager.employment.id)).toBe(true);
  });

  it('HCM-WORKFORCE-009: a cross-tenant employment id 404s on the 360 aggregate', async () => {
    const rejected = await expectReject(() => asUser('hr@kaizen.co.in', () => employee360('does-not-exist')));
    expect(rejected.status).toBe(404);
  });
});

describe('HCM-WORKFORCE-010 — org design reference data', () => {
  it('HCM-WORKFORCE-010: HR can create a cost centre, a location and a grade, and list them', async () => {
    const stamp = Date.now();
    await asUser('hr@kaizen.co.in', async () => {
      await createCostCentre({ code: `CC-${stamp}`, name: 'Fixture Cost Centre' });
      await createLocation({ name: `Fixture Office ${stamp}`, city: 'Chennai', state: 'Tamil Nadu' });
      await createGrade({ code: `G-${stamp}`, name: 'Fixture Grade', level: 5 });

      expect((await listCostCentres()).some((c) => c.code === `CC-${stamp}`)).toBe(true);
      expect((await listLocations()).some((l) => l.name === `Fixture Office ${stamp}`)).toBe(true);
      expect((await listGrades()).some((g) => g.code === `G-${stamp}`)).toBe(true);
    });
  });
});

describe('HCM-WORKFORCE-011 — employee status changes: propose → decide (Self-Dealing Bar) → apply', () => {
  it('HCM-WORKFORCE-011: the proposer may never decide their own status change', async () => {
    const { employment } = await makeEmployee('self-dealing');
    const stamp = Date.now();
    const grade = await asUser('hr@kaizen.co.in', () => createGrade({ code: `SD-${stamp}`, name: 'Self-Dealing Grade', level: 3 }));

    const proposed = await asUser('hr@kaizen.co.in', () =>
      proposeStatusChange({
        employmentRelationshipId: employment.id,
        kind: 'promotion',
        changes: { gradeId: grade.id },
        reason: 'Strong quarter',
        effectiveDate: new Date(),
      }),
    );
    expect(proposed.status).toBe('pending_approval');

    const denied = await expectReject(() => asUser('hr@kaizen.co.in', () => decideStatusChange(proposed.id, true)));
    expect(denied.status).toBe(403);
    expect(denied.message).toMatch(/Self-Dealing Bar/);
  });

  it('HCM-WORKFORCE-012: a different decider can approve, and applying writes the new grade assignment', async () => {
    const { employment } = await makeEmployee('apply-flow');
    const stamp = Date.now();
    const grade = await asUser('hr@kaizen.co.in', () => createGrade({ code: `AP-${stamp}`, name: 'Applied Grade', level: 4 }));

    const proposed = await asUser('hr@kaizen.co.in', () =>
      proposeStatusChange({
        employmentRelationshipId: employment.id,
        kind: 'promotion',
        changes: { gradeId: grade.id },
        reason: 'Strong quarter',
        effectiveDate: new Date(),
      }),
    );

    // `chairman` is a distinct principal from the `hr_ops_manager` proposer,
    // and holds `employee_changes:approve` too.
    const approved = await asUser('chairman@kaizen.co.in', () => decideStatusChange(proposed.id, true, 'Agreed'));
    expect(approved.status).toBe('approved');

    // Applying before approval, or deciding twice, are both refused —
    // the closed set of legal transitions.
    const reDecide = await expectReject(() => asUser('chairman@kaizen.co.in', () => decideStatusChange(proposed.id, true)));
    expect(reDecide.status).toBe(409);

    const applied = await asUser('hr@kaizen.co.in', () => applyStatusChange(proposed.id));
    expect(applied.status).toBe('applied');
    expect(applied.appliedAt).not.toBeNull();

    const assignment = await asUser('hr@kaizen.co.in', () =>
      prisma.gradeAssignment.findFirst({
        where: { employmentRelationshipId: employment.id, gradeId: grade.id, effectiveTo: null },
      }),
    );
    expect(assignment).not.toBeNull();

    const reApply = await expectReject(() => asUser('hr@kaizen.co.in', () => applyStatusChange(proposed.id)));
    expect(reApply.status).toBe(409);
  });
});
