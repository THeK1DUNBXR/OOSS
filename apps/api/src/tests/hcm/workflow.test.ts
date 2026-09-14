/**
 * HCM — workflow (docs/hcm/workflow.md).
 *
 * HCM-WORKFLOW-001..013: submit → resolve → decide across chain levels, the
 * Self-Dealing Bar (both as a resolution-time exclusion and as a
 * decide()-time defence in depth), delegation, and cross-tenant isolation.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { asSystem } from '../../platform/context.js';
import type { AuthContext } from '../../platform/context.js';
import { asPrincipal, asUser, expectReject, prisma, tenantId, unscopedPrisma, withFixtureRole } from '../helpers.js';
import { invalidateGrantCache } from '../../platform/permissions.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { hire, transitionEmployment } from '../../domains/employment.js';
import {
  createRequestType,
  submitRequest,
  getRequest,
  decide,
  listInbox,
  withdrawRequest,
  createDelegation,
  _resetReportingLineTableCache,
} from '../../domains/hcm/workflow.js';

let TENANT: string;
let fixtureSeq = 0;

beforeAll(async () => {
  TENANT = await tenantId();
  // Scaffold gap (see docs/hcm/workflow.md, "Wanted from the scaffold"):
  // grants.ts (owned by the scaffold, not editable by this workstream) gives
  // `finance_head` only `view` on `hr_requests`, not `approve` — so a
  // finance_grant-resolved level can be opened but never decided by the real
  // seeded finance_head account. This patches the Grant table directly (the
  // same mechanism `withFixtureRole` uses) to exercise the resolver and
  // decide() path end to end; it does not touch grants.ts itself.
  const financeRole = await unscopedPrisma.accessRole.findFirstOrThrow({ where: { tenantId: TENANT, slug: 'finance_head' } });
  const existing = await unscopedPrisma.grant.findFirst({ where: { tenantId: TENANT, roleId: financeRole.id, resource: 'hr_requests' } });
  if (existing) {
    if (!existing.verbs.includes('approve' as never)) {
      await unscopedPrisma.grant.update({ where: { id: existing.id }, data: { verbs: [...existing.verbs, 'approve'] } });
    }
  } else {
    await unscopedPrisma.grant.create({
      data: { tenantId: TENANT, principalType: 'role', roleId: financeRole.id, resource: 'hr_requests', verbs: ['view', 'approve'], scope: 'all' },
    });
  }
  invalidateGrantCache();
});

/** A throwaway employee with no login — its partyId is used directly via `asEmployee`. */
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
        primaryEmail: `fixture.workflow.${label}.${stamp}@example.com`,
        source: 'test',
      },
    });
    const employment = await hire({ personId: person.id, positionId: position.id, hireEffectiveDate: new Date() });
    await transitionEmployment(employment.id, 'ACTIVATE');
    return { employment, person };
  });
}

/** Hires an existing person (e.g. a `withFixtureRole` principal) into a fresh position, as HR ops. */
async function hireExisting(personId: string) {
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
    return hire({ personId, positionId: position.id, hireEffectiveDate: new Date() });
  });
}

/** Runs `fn` as a bare employee principal for `partyId` — no login required, matching how a fixture-only employee acts on their own request. */
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

// Multiple staff can hold `hr_ops_manager`/`finance_head` in the seeded
// dataset; the resolver in the domain layer always picks the earliest
// (`orderBy: createdAt asc`), so these mirror that ordering exactly rather
// than asserting against an arbitrary holder.
async function operationsPartyId(): Promise<string> {
  const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
    where: { tenantId: TENANT, roleSlug: 'hr_ops_manager', status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  return affiliation.partyId;
}

async function financePartyId(): Promise<string> {
  const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
    where: { tenantId: TENANT, roleSlug: 'finance_head', status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
  return affiliation.partyId;
}

async function makeType(label: string, chain: Array<{ level: number; resolver: string; partyId?: string }>) {
  return asUser('operations@kaizen.co.in', () =>
    createRequestType({
      code: `WF-${label}-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
      name: `Fixture ${label}`,
      approvalChain: chain as never,
      slaHours: 24,
    }),
  );
}

describe('Submit & single-level resolution (HCM-WORKFLOW-001)', () => {
  it('HCM-WORKFLOW-001: submitting opens level 1, resolved through hr_grant to the hr_ops_manager holder', async () => {
    const { employment, person } = await makeEmployee('single');
    const type = await makeType('single', [{ level: 1, resolver: 'hr_grant' }]);
    const opsPartyId = await operationsPartyId();

    const request = await asEmployee(person.id, () =>
      submitRequest({ typeId: type.id, subjectEmploymentId: employment.id, payload: { note: 'wfh' } }),
    );

    expect(request.status).toBe('submitted');
    expect(request.currentLevel).toBe(1);
    expect(request.approvals).toHaveLength(1);
    expect(request.approvals[0].approverPartyId).toBe(opsPartyId);
    expect(request.approvals[0].decision).toBe('pending');
    expect(request.recordCode).toMatch(/^HRQ-\d{4}-\d+$/);
  });
});

describe('Approval flow (HCM-WORKFLOW-002, 003, 010)', () => {
  it('HCM-WORKFLOW-002: approving the only level closes the request', async () => {
    const { employment, person } = await makeEmployee('close');
    const type = await makeType('close', [{ level: 1, resolver: 'hr_grant' }]);
    const request = await asEmployee(person.id, () =>
      submitRequest({ typeId: type.id, subjectEmploymentId: employment.id, payload: {} }),
    );

    const decided = await asUser('operations@kaizen.co.in', () => decide(request.id, true, 'looks fine'));
    expect(decided.status).toBe('closed');
    expect(decided.currentLevel).toBe(0);
    expect(decided.approvals[0].decision).toBe('approved');
    expect(decided.approvals[0].note).toBe('looks fine');
  });

  it('HCM-WORKFLOW-003: a two-level chain advances to a different resolver on level-1 approval', async () => {
    const { employment, person } = await makeEmployee('twolevel');
    const type = await makeType('twolevel', [
      { level: 1, resolver: 'hr_grant' },
      { level: 2, resolver: 'finance_grant' },
    ]);
    const financePartyIdVal = await financePartyId();

    const request = await asEmployee(person.id, () =>
      submitRequest({ typeId: type.id, subjectEmploymentId: employment.id, payload: {} }),
    );
    const afterLevel1 = await asUser('operations@kaizen.co.in', () => decide(request.id, true));

    expect(afterLevel1.status).toBe('submitted');
    expect(afterLevel1.currentLevel).toBe(2);
    expect(afterLevel1.approvals).toHaveLength(2);
    expect(afterLevel1.approvals[1].approverPartyId).toBe(financePartyIdVal);
    expect(afterLevel1.approvals[1].decision).toBe('pending');

    const afterLevel2 = await asUser('finance@kaizen.co.in', () => decide(request.id, true));
    expect(afterLevel2.status).toBe('closed');
  });

  it('HCM-WORKFLOW-010: listInbox surfaces only pending approvals resolved to the caller', async () => {
    const { employment, person } = await makeEmployee('inbox');
    const type = await makeType('inbox', [{ level: 1, resolver: 'hr_grant' }]);
    const request = await asEmployee(person.id, () =>
      submitRequest({ typeId: type.id, subjectEmploymentId: employment.id, payload: {} }),
    );

    const opsInbox = await asUser('operations@kaizen.co.in', () => listInbox());
    expect(opsInbox.some((i) => i.requestId === request.id)).toBe(true);

    const financeInbox = await asUser('finance@kaizen.co.in', () => listInbox());
    expect(financeInbox.some((i) => i.requestId === request.id)).toBe(false);

    await asUser('operations@kaizen.co.in', () => decide(request.id, true));
    const opsInboxAfter = await asUser('operations@kaizen.co.in', () => listInbox());
    expect(opsInboxAfter.some((i) => i.requestId === request.id)).toBe(false);
  });
});

describe('Rejection and invalid transitions (HCM-WORKFLOW-004, 007)', () => {
  it('HCM-WORKFLOW-004: rejecting at level 1 ends the request rejected without opening level 2', async () => {
    const { employment, person } = await makeEmployee('reject');
    const type = await makeType('reject', [
      { level: 1, resolver: 'hr_grant' },
      { level: 2, resolver: 'finance_grant' },
    ]);
    const request = await asEmployee(person.id, () =>
      submitRequest({ typeId: type.id, subjectEmploymentId: employment.id, payload: {} }),
    );

    const decided = await asUser('operations@kaizen.co.in', () => decide(request.id, false, 'not eligible'));
    expect(decided.status).toBe('rejected');
    expect(decided.currentLevel).toBe(0);
    expect(decided.approvals).toHaveLength(1);
  });

  it('HCM-WORKFLOW-007: deciding an already-closed request is refused as a conflict', async () => {
    const { employment, person } = await makeEmployee('conflict');
    const type = await makeType('conflict', [{ level: 1, resolver: 'hr_grant' }]);
    const request = await asEmployee(person.id, () =>
      submitRequest({ typeId: type.id, subjectEmploymentId: employment.id, payload: {} }),
    );
    await asUser('operations@kaizen.co.in', () => decide(request.id, true));

    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => decide(request.id, true)));
    expect(err.status).toBe(409);
  });
});

describe('The Self-Dealing Bar (HCM-WORKFLOW-005, 006)', () => {
  it('HCM-WORKFLOW-005: an approver may never decide a request that is about them, even if resolution drifted onto them', async () => {
    const { person: proposer } = await makeEmployee('self-subject-proposer');
    const type = await makeType('self-subject', [{ level: 1, resolver: 'hr_grant' }]);

    // A fixture principal who genuinely holds `hr_requests:approve` — the WHO
    // axis must pass for this scenario to actually exercise the Self-Dealing
    // Bar rather than stopping earlier on a missing grant.
    await withFixtureRole(
      { slug: 'wf_approver', grants: [{ resource: 'hr_requests', verbs: ['view', 'create', 'approve'] }] },
      async (approver) => {
        const subjectEmployment = await hireExisting(approver.partyId);

        const request = await asEmployee(proposer.id, () =>
          submitRequest({ typeId: type.id, subjectEmploymentId: subjectEmployment.id, payload: {} }),
        );
        // The hr_grant resolver already excludes the subject, so it opened
        // unresolved — the scenario below simulates a later reassignment.
        expect(request.approvals[0].approverPartyId).not.toBe(approver.partyId);

        await unscopedPrisma.hrRequestApproval.updateMany({
          where: { tenantId: TENANT, requestId: request.id, level: 1 },
          data: { approverPartyId: approver.partyId },
        });

        const err = await expectReject(() => decide(request.id, true));
        expect(err.status).toBe(403);
        expect(err.message).toMatch(/Self-Dealing Bar/);
      },
    );
  });

  it('HCM-WORKFLOW-006: an approver may never decide a request they themselves raised', async () => {
    const { employment } = await makeEmployee('self-proposer');
    const opsPartyId = await operationsPartyId();
    const type = await makeType('self-proposer', [{ level: 1, resolver: 'hr_grant' }]);

    // hr_ops_manager raises a request about someone else's employment; the
    // hr_grant resolver still resolves to hr_ops_manager (the only holder),
    // which is also the requester — the resolver's own exclusion catches it
    // and opens the level unresolved.
    const request = await asUser('operations@kaizen.co.in', () =>
      submitRequest({ typeId: type.id, subjectEmploymentId: employment.id, payload: {} }),
    );
    expect(request.approvals[0].approverPartyId).toBeNull();

    // Simulate drift the other way: the level resolves to the requester
    // directly. decide() must refuse it regardless.
    await unscopedPrisma.hrRequestApproval.updateMany({
      where: { tenantId: TENANT, requestId: request.id, level: 1 },
      data: { approverPartyId: opsPartyId },
    });
    const err = await expectReject(() => asUser('operations@kaizen.co.in', () => decide(request.id, true)));
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/Self-Dealing Bar/);
  });
});

describe('Withdrawal and cross-tenant isolation (HCM-WORKFLOW-009, 008)', () => {
  it('HCM-WORKFLOW-009: only the requester may withdraw their own submitted request', async () => {
    const { employment, person } = await makeEmployee('withdraw');
    const type = await makeType('withdraw', [{ level: 1, resolver: 'hr_grant' }]);
    const request = await asEmployee(person.id, () =>
      submitRequest({ typeId: type.id, subjectEmploymentId: employment.id, payload: {} }),
    );

    const otherErr = await expectReject(() => asUser('operations@kaizen.co.in', () => withdrawRequest(request.id)));
    expect(otherErr.status).toBe(403);

    const withdrawn = await asEmployee(person.id, () => withdrawRequest(request.id));
    expect(withdrawn.status).toBe('withdrawn');
  });

  it('HCM-WORKFLOW-008: a request is invisible from another tenant (404, not a leak)', async () => {
    const { employment, person } = await makeEmployee('crosstenant');
    const type = await makeType('crosstenant', [{ level: 1, resolver: 'hr_grant' }]);
    const request = await asEmployee(person.id, () =>
      submitRequest({ typeId: type.id, subjectEmploymentId: employment.id, payload: {} }),
    );

    const otherTenant = await unscopedPrisma.tenant.create({
      data: { name: `Other Tenant ${Date.now()}`, slug: `other-wf-${Date.now()}` },
    });
    // A brand-new tenant has no seeded AccessRole/Grant rows, so a `human`
    // principal there would fail on the WHO axis before ever reaching the
    // tenant scope check — that would test the grant seed, not tenant
    // isolation. `system` bypasses the grant lookup by design (it is always
    // `allowed`), which is what actually exercises the tenant filter: the
    // request genuinely exists, just not in this tenant's rows.
    const err = await expectReject(() => asSystem(otherTenant.id, () => getRequest(request.id)));
    expect(err.status).toBe(404);
  });
});

describe('Manager resolution and delegation (HCM-WORKFLOW-011, 012)', () => {
  it('HCM-WORKFLOW-011: a manager step falls back to the hr_ops_manager holder when no ReportingLine is open', async () => {
    _resetReportingLineTableCache();
    const { employment, person } = await makeEmployee('manager-fallback');
    const opsPartyId = await operationsPartyId();
    const type = await makeType('manager-fallback', [{ level: 1, resolver: 'manager' }]);

    const request = await asEmployee(person.id, () =>
      submitRequest({ typeId: type.id, subjectEmploymentId: employment.id, payload: {} }),
    );
    expect(request.approvals[0].approverPartyId).toBe(opsPartyId);
  });

  it('HCM-WORKFLOW-012: an active delegation reroutes a resolved level to the delegate', async () => {
    const { employment, person } = await makeEmployee('delegated');
    const opsPartyId = await operationsPartyId();
    const financePartyIdVal = await financePartyId();
    const type = await makeType('delegated', [{ level: 1, resolver: 'hr_grant' }]);

    await asUser('operations@kaizen.co.in', () =>
      createDelegation({
        toPartyId: financePartyIdVal,
        fromDate: new Date(Date.now() - 86_400_000),
        toDate: new Date(Date.now() + 7 * 86_400_000),
        scope: 'hr_grant',
        note: 'on leave',
      }),
    );

    const request = await asEmployee(person.id, () =>
      submitRequest({ typeId: type.id, subjectEmploymentId: employment.id, payload: {} }),
    );
    expect(request.approvals[0].approverPartyId).toBe(financePartyIdVal);
    void opsPartyId;

    const decided = await asUser('finance@kaizen.co.in', () => decide(request.id, true));
    expect(decided.status).toBe('closed');
  });
});

describe('Request type validation (HCM-WORKFLOW-013)', () => {
  it('HCM-WORKFLOW-013: a malformed approval chain is refused at creation, not discovered at submit time', async () => {
    const err = await expectReject(() =>
      asUser('operations@kaizen.co.in', () =>
        createRequestType({
          code: `WF-BAD-${Date.now()}`,
          name: 'Malformed',
          approvalChain: [{ level: 2, resolver: 'hr_grant' }] as never,
          slaHours: 24,
        }),
      ),
    );
    expect(err.status).toBe(400);
  });
});
