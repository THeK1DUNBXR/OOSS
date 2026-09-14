/**
 * HCM — learning (docs/hcm/learning.md).
 *
 * HCM-LEARNING-001..012: catalogue create, nomination → approval →
 * attendance → completion, the Self-Dealing Bar on approval, capability
 * integration on completion, auto-issued certifications, direct
 * certification entry with self-verification barred, the expiry ladder,
 * mandatory-training overdue detection, IDPs, budget utilisation and
 * cross-tenant isolation.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asUser, asPrincipal, withFixtureRole, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import {
  createProgram, createSession, listSessions, getProgram,
  nominate, approveEnrollment, rejectEnrollment, markAttendance, completeEnrollment, listEnrollments,
  addCertification, verifyCertification, listCertifications, runCertificationExpiryLadder,
  createMandatoryRule, mandatoryComplianceStatus, runMandatoryTrainingOverdueCheck,
  createIdp, updateIdp, listIdps,
  createBudget, listBudgets,
} from '../../domains/hcm/learning.js';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
});

async function makeEmployee(label: string) {
  fixtureSeq += 1;
  const stamp = `${Date.now()}-${fixtureSeq}`;
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
        fullName: `Fixture ${label} ${stamp}`,
        primaryEmail: `fixture.learning.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { employment, person };
  });
}

async function makeProgramAndSession(kind: 'classroom' | 'certification' = 'classroom', extra: Record<string, unknown> = {}) {
  return asUser('operations@kaizen.co.in', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const program = await createProgram({ title: `Fixture Program ${stamp}`, kind, ...extra });
    const session = await createSession({
      programId: program.id,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 4 * 3_600_000),
      seats: 10,
    });
    return { program, session };
  });
}

// ===========================================================================
// HCM-LEARNING-001 — catalogue
// ===========================================================================

describe('HCM-LEARNING-001 — training programs and sessions', () => {
  it('creating a program and scheduling a session against it succeeds', async () => {
    const { program, session } = await makeProgramAndSession();
    expect(program.kind).toBe('classroom');

    await asUser('operations@kaizen.co.in', async () => {
      const sessions = await listSessions(program.id);
      expect(sessions.map((s) => s.id)).toContain(session.id);
    });
  });
});

// ===========================================================================
// HCM-LEARNING-002 — nomination
// ===========================================================================

describe('HCM-LEARNING-002 — nomination enrolls an employee at status "nominated"', () => {
  it('nominating an employee to a session creates a nominated enrollment', async () => {
    const { employment } = await makeEmployee('nominee');
    const { session } = await makeProgramAndSession();

    const enrollment = await asUser('operations@kaizen.co.in', () =>
      nominate({ sessionId: session.id, employmentRelationshipId: employment.id }),
    );
    expect(enrollment.status).toBe('nominated');
  });
});

// ===========================================================================
// HCM-LEARNING-003 — Self-Dealing Bar on approval
// ===========================================================================

describe('HCM-LEARNING-003 — a nomination cannot be approved by the person nominated', () => {
  it('refuses self-approval even when the actor holds the approve grant', async () => {
    const { session } = await makeProgramAndSession();

    const err = await withFixtureRole(
      {
        slug: 'learning_self',
        grants: [{ resource: 'training_enrollments', verbs: ['view', 'create', 'approve'], scope: 'own' }],
      },
      async (fixture) => {
        const position = await unscopedPrisma.position.create({
          data: {
            tenantId: TENANT,
            recordCode: await nextRecordCode('POS'),
            jobId: (await unscopedPrisma.job.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
            orgUnitId: (await unscopedPrisma.orgUnit.findFirstOrThrow({ where: { tenantId: TENANT } })).id,
            status: 'Open',
          },
        });
        const employment = await asPrincipal(
          { ...selfAuth(fixture), roleSlug: 'hr_ops_manager' },
          () => hire({ personId: fixture.partyId, positionId: position.id, hireEffectiveDate: new Date() }),
        );

        const enrollment = await nominate({ sessionId: session.id, employmentRelationshipId: employment.id });
        return expectReject(() => approveEnrollment(enrollment.id));
      },
    );

    expect(err.status).toBe(422);
    expect(err.message).toMatch(/self-approved|Self-Dealing/i);
  });
});

function selfAuth(fixture: { tenantId: string; partyId: string; userId: string; affiliationId: string; roleSlug: string; branch: string | null }) {
  return {
    tenantId: fixture.tenantId,
    principalType: 'human' as const,
    partyId: fixture.partyId,
    userId: fixture.userId,
    agentId: null,
    onBehalfOfPartyId: null,
    affiliationId: fixture.affiliationId,
    roleSlug: fixture.roleSlug,
    branch: fixture.branch,
    orgUnitId: null,
    classificationCeiling: 'regulated' as const,
    purpose: 'operational',
    consentCodes: [],
    stepUpVerified: true,
  };
}

// ===========================================================================
// HCM-LEARNING-004 — approval, attendance, completion by a real approver
// ===========================================================================

describe('HCM-LEARNING-004 — approval by someone else, then attendance and completion', () => {
  it('walks nominated → approved → attended → completed', async () => {
    const { employment } = await makeEmployee('lifecycle');
    const { session } = await makeProgramAndSession();

    const enrollment = await asUser('operations@kaizen.co.in', () =>
      nominate({ sessionId: session.id, employmentRelationshipId: employment.id }),
    );

    const approved = await asUser('chairman@kaizen.co.in', () => approveEnrollment(enrollment.id));
    expect(approved.status).toBe('approved');

    const attended = await asUser('operations@kaizen.co.in', () => markAttendance(enrollment.id, true));
    expect(attended.status).toBe('attended');

    const { enrollment: completed } = await asUser('operations@kaizen.co.in', () =>
      completeEnrollment(enrollment.id, { score: 92, feedback: 'Solid' }),
    );
    expect(completed.status).toBe('completed');
    expect(Number(completed.score)).toBe(92);
  });
});

// ===========================================================================
// HCM-LEARNING-005 — invalid transition refused
// ===========================================================================

describe('HCM-LEARNING-005 — completing a nomination that has not been approved or attended is refused', () => {
  it('rejects skipping straight from nominated to completed', async () => {
    const { employment } = await makeEmployee('skip');
    const { session } = await makeProgramAndSession();

    const enrollment = await asUser('operations@kaizen.co.in', () =>
      nominate({ sessionId: session.id, employmentRelationshipId: employment.id }),
    );

    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => completeEnrollment(enrollment.id)));
    expect(err.status).toBe(422);
  });

  it('rejects a nomination once it has already been rejected', async () => {
    const { employment } = await makeEmployee('rerejected');
    const { session } = await makeProgramAndSession();

    const enrollment = await asUser('operations@kaizen.co.in', () =>
      nominate({ sessionId: session.id, employmentRelationshipId: employment.id }),
    );
    await asUser('operations@kaizen.co.in', () => rejectEnrollment(enrollment.id, 'no seats'));

    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => approveEnrollment(enrollment.id)));
    expect(err.status).toBe(422);
  });
});

// ===========================================================================
// HCM-LEARNING-006 — completion feeds the existing capability system
// ===========================================================================

describe('HCM-LEARNING-006 — completing a skills-linked program asserts a capability claim', () => {
  it('writes a CapabilityClaim at the Assessed tier via claimFromLearningCompletion', async () => {
    const { employment, person } = await makeEmployee('capability');
    const skill: { id: string } = await asUser('operations@kaizen.co.in', () =>
      prisma.skill.create({ data: { tenantId: TENANT, name: `Fixture Skill ${Date.now()}` } }),
    );
    const { session } = await makeProgramAndSession('classroom', { skillIds: [skill.id] });

    const enrollment = await asUser('operations@kaizen.co.in', () =>
      nominate({ sessionId: session.id, employmentRelationshipId: employment.id }),
    );
    await asUser('chairman@kaizen.co.in', () => approveEnrollment(enrollment.id));
    await asUser('operations@kaizen.co.in', () => markAttendance(enrollment.id, true));
    await asUser('operations@kaizen.co.in', () => completeEnrollment(enrollment.id));

    const claim = await prisma.capabilityClaim.findFirst({
      where: { tenantId: TENANT, partyId: person.id, skillId: skill.id },
    });
    expect(claim).not.toBeNull();
    expect(claim?.tier).toBe('assessed');
  });
});

// ===========================================================================
// HCM-LEARNING-007 — certification-kind program auto-issues a Certification
// ===========================================================================

describe('HCM-LEARNING-007 — completing a certification-kind program issues a Certification', () => {
  it('sets an expiry from the program validity window', async () => {
    const { employment } = await makeEmployee('cert-auto');
    const { session } = await makeProgramAndSession('certification', { validityMonths: 12 });

    const enrollment = await asUser('operations@kaizen.co.in', () =>
      nominate({ sessionId: session.id, employmentRelationshipId: employment.id }),
    );
    await asUser('chairman@kaizen.co.in', () => approveEnrollment(enrollment.id));
    await asUser('operations@kaizen.co.in', () => markAttendance(enrollment.id, true));
    const { certification } = await asUser('operations@kaizen.co.in', () => completeEnrollment(enrollment.id));

    expect(certification).not.toBeNull();
    expect(certification!.expiresOn).not.toBeNull();
    expect(certification!.verified).toBe(false);
    expect(certification!.recordCode).toMatch(/^CERT-\d{4}-\d{5}$/);
  });
});

// ===========================================================================
// HCM-LEARNING-008 — direct certification entry and self-verification barred
// ===========================================================================

describe('HCM-LEARNING-008 — a certification cannot be self-verified', () => {
  it('lets HR add a certification directly, then refuses to let the holder verify it themselves', async () => {
    const { employment, person } = await makeEmployee('cert-self');
    const cert = await asUser('operations@kaizen.co.in', () =>
      addCertification({ employmentRelationshipId: employment.id, name: 'AWS Certified', issuedOn: new Date() }),
    );

    const err = await withFixtureRole(
      { slug: 'cert_holder', grants: [{ resource: 'certifications', verbs: ['view', 'approve'], scope: 'own' }] },
      async (fixture) => {
        // Same person as the holder, acting with the approve grant.
        return expectReject(() =>
          asPrincipal({ ...selfAuth(fixture), partyId: person.id }, () => verifyCertification(cert.id)),
        );
      },
    );
    expect(err.status).toBe(422);

    const verified = await asUser('chairman@kaizen.co.in', () => verifyCertification(cert.id));
    expect(verified.verified).toBe(true);

    const list = await asUser('operations@kaizen.co.in', () => listCertifications(employment.id));
    expect(list.some((c) => c.id === cert.id && c.verified)).toBe(true);
  });
});

// ===========================================================================
// HCM-LEARNING-009 — certification expiry ladder
// ===========================================================================

describe('HCM-LEARNING-009 — the certification expiry ladder is idempotent per rung', () => {
  it('raises an exception at the 30-day rung once, and a same-day re-run does not duplicate it', async () => {
    const { employment } = await makeEmployee('expiring');
    const expiresOn = new Date(Date.now() + 20 * 86_400_000);
    await asUser('operations@kaizen.co.in', () =>
      addCertification({ employmentRelationshipId: employment.id, name: 'Fixture Expiring Cert', issuedOn: new Date(), expiresOn }),
    );

    const first = await asUser('operations@kaizen.co.in', () => runCertificationExpiryLadder());
    expect(first.notified).toBeGreaterThanOrEqual(1);

    const second = await asUser('operations@kaizen.co.in', () => runCertificationExpiryLadder());
    expect(second.skippedIdempotent).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// HCM-LEARNING-010 — mandatory training overdue
// ===========================================================================

describe('HCM-LEARNING-010 — mandatory training overdue detection', () => {
  it('flags an employee who joined before the due window and has not completed the program', async () => {
    const { employment } = await makeEmployee('mandatory');
    // Backdate the join date so the due window has already passed.
    await asUser('operations@kaizen.co.in', () =>
      prisma.employmentRelationship.update({ where: { id: employment.id }, data: { hireEffectiveDate: new Date(Date.now() - 60 * 86_400_000) } }),
    );

    const { program } = await makeProgramAndSession('classroom');
    await asUser('operations@kaizen.co.in', () => createMandatoryRule({ programId: program.id, dueWithinDaysOfJoin: 30 }));

    const status = await asUser('operations@kaizen.co.in', () => mandatoryComplianceStatus());
    const row = status.find((r) => r.employmentRelationshipId === employment.id && r.programId === program.id);
    expect(row?.overdue).toBe(true);

    const result = await asUser('operations@kaizen.co.in', () => runMandatoryTrainingOverdueCheck());
    expect(result.processed).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// HCM-LEARNING-011 — individual development plans
// ===========================================================================

describe('HCM-LEARNING-011 — individual development plans', () => {
  it('creates a plan with a mentor and goals, then closes it', async () => {
    const { employment } = await makeEmployee('idp');
    const idp = await asUser('operations@kaizen.co.in', () =>
      createIdp({ employmentRelationshipId: employment.id, goals: { items: ['Lead a project'] }, reviewDate: new Date() }),
    );
    expect(idp.status).toBe('active');

    const closed = await asUser('operations@kaizen.co.in', () => updateIdp(idp.id, { status: 'closed' }));
    expect(closed.status).toBe('closed');

    const list = await asUser('operations@kaizen.co.in', () => listIdps(employment.id));
    expect(list.map((i) => i.id)).toContain(idp.id);
  });
});

// ===========================================================================
// HCM-LEARNING-012 — training budget utilisation and cross-tenant isolation
// ===========================================================================

describe('HCM-LEARNING-012 — training budgets and cross-tenant isolation', () => {
  it('computes utilisation from completed enrollments in that financial year', async () => {
    const fy = `FY-BUDGET-TEST-${Date.now()}`;
    await asUser('finance@kaizen.co.in', () => createBudget({ fy, amount: 100_000 }));
    const budgets = await asUser('finance@kaizen.co.in', () => listBudgets(fy));
    expect(budgets[0].amount != null).toBe(true);
    expect(budgets[0].spent).toBe(0);
    expect(budgets[0].utilisationPercent).toBe(0);
  });

  it('a program id from another tenant (or one that does not exist) is 404, not 403', async () => {
    const otherTenant = await unscopedPrisma.tenant.findFirst({ where: { id: { not: TENANT } } });

    if (otherTenant) {
      const foreignProgram = await unscopedPrisma.trainingProgram.findFirst({ where: { tenantId: otherTenant.id } });
      const targetId = foreignProgram?.id ?? 'does-not-exist';
      const err = await expectReject(() => asUser('chairman@kaizen.co.in', () => getProgram(targetId)));
      expect(err.status).toBe(404);
    } else {
      const err = await expectReject(() => asUser('chairman@kaizen.co.in', () => getProgram('does-not-exist')));
      expect(err.status).toBe(404);
    }
  });
});
