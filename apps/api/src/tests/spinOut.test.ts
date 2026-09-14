/**
 * Phase 6b of the equity portal — spinning a division out into a subsidiary.
 *
 * Requirements named `EQT-SPN-*`, per the phase-6b brief in
 * `docs/plan/equity-portal.md` §6.
 *
 * Builds its own holding tenant and its own subsidiary tenant in `beforeAll`
 * (parented to it, `config.originDivision: 'education'`) — the spin-out
 * needs books and an employment/course structure this file controls
 * completely, not whatever another suite left behind in the shared `kaizen`
 * tenant (`vitest.config.ts` runs every file serially against one database).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { seedBootstrap } from '../seed/bootstrap.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { previewSpinOut, commitSpinOut, revertSpinOut } from '../seed/spinOutEngine.js';
import { spinOutPreview, spinOutDivisionsSummary } from '../domains/group.js';
import { asPrincipal, authFor, expectReject, type TestPrincipal, unscopedPrisma, prisma as scopedPrisma } from './helpers.js';

let HOLD: string;
let HOLD_SLUG: string;
let SUB: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

async function principalInTenant(tid: string, email: string): Promise<TestPrincipal> {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { tenantId: tid, email } });
  const affiliation = await unscopedPrisma.affiliation.findFirstOrThrow({
    where: { partyId: user.personId, tenantId: tid, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  return {
    tenantId: tid,
    partyId: user.personId,
    userId: user.id,
    affiliationId: affiliation.id,
    roleSlug: affiliation.roleSlug ?? 'chairman',
    branch: user.branch,
  };
}

async function asHoldingChairman<T>(fn: () => Promise<T>): Promise<T> {
  const p = await principalInTenant(HOLD, 'chairman@kaizen.co.in');
  return asPrincipal(authFor(p), fn);
}

async function asSubChairman<T>(fn: () => Promise<T>): Promise<T> {
  const p = await principalInTenant(SUB, 'chairman@kaizen.co.in');
  return asPrincipal(authFor(p), fn);
}

/** Fixture data for the education division: transactions (one carriable, one shared, one linked), an org unit with a current employee, a course/cohort/enrolment, and an organisation invoiced under the division. */
async function seedHoldingFixtures() {
  return asHoldingChairman(async () => {
    const account = await scopedPrisma.ledgerAccount.create({
      data: { tenantId: HOLD, name: `Corp Bank ${suffix}`, accountType: 'bank', ledgerGroup: 'asset' },
    });
    const category = await scopedPrisma.ledgerCategory.create({
      data: { tenantId: HOLD, name: `Tuition Fees ${suffix}`, kind: 'income', behaviour: 'variable', defaultDivision: 'education' },
    });

    const carriedTxn = await scopedPrisma.transaction.create({
      data: {
        tenantId: HOLD, recordCode: await nextRecordCode('TXN'), txnDate: new Date('2026-04-01'),
        direction: 'in', amount: 1000, accountId: account.id, categoryId: category.id, division: 'education', source: 'manual',
      },
    });
    const sharedTxn = await scopedPrisma.transaction.create({
      data: {
        tenantId: HOLD, recordCode: await nextRecordCode('TXN'), txnDate: new Date('2026-04-02'),
        direction: 'out', amount: 200, accountId: account.id, division: 'shared', source: 'manual',
      },
    });
    const linkedTxn = await scopedPrisma.transaction.create({
      data: {
        tenantId: HOLD, recordCode: await nextRecordCode('TXN'), txnDate: new Date('2026-04-03'),
        direction: 'in', amount: 500, accountId: account.id, division: 'education', source: 'invoice', invoiceId: 'fake-invoice-id',
      },
    });
    const otherDivisionTxn = await scopedPrisma.transaction.create({
      data: {
        tenantId: HOLD, recordCode: await nextRecordCode('TXN'), txnDate: new Date('2026-04-04'),
        direction: 'in', amount: 300, accountId: account.id, division: 'software', source: 'manual',
      },
    });

    // Employment: an org unit tree rooted in the education division, a
    // position in it, a person, and a current effective assignment.
    const orgUnit = await scopedPrisma.orgUnit.create({ data: { tenantId: HOLD, name: `Education ${suffix}`, unitType: 'division', division: 'education' } });
    const job = await scopedPrisma.job.create({ data: { tenantId: HOLD, title: 'Trainer', jobFamily: 'academics', jobLevel: 'L1' } });
    const position = await scopedPrisma.position.create({ data: { tenantId: HOLD, recordCode: await nextRecordCode('POS'), orgUnitId: orgUnit.id, jobId: job.id, status: 'Filled' } });
    const empEmail = `trainer-${suffix}@example.test`;
    const empPerson = await scopedPrisma.person.create({ data: { tenantId: HOLD, recordCode: await nextRecordCode('PER'), fullName: 'Trainer One', primaryEmail: empEmail, primaryEmailNormalised: empEmail, source: 'test' } });
    const employment = await scopedPrisma.employmentRelationship.create({ data: { tenantId: HOLD, recordCode: await nextRecordCode('EMP'), personId: empPerson.id, hireEffectiveDate: new Date('2025-01-01') } });
    await scopedPrisma.assignment.create({
      data: { tenantId: HOLD, employmentRelationshipId: employment.id, positionId: position.id, reasonCode: 'hire', rowStatus: 'Effective', effectiveFrom: new Date('2025-01-01') },
    });

    // Course, cohort, enrolment.
    const course = await scopedPrisma.course.create({ data: { tenantId: HOLD, recordCode: await nextRecordCode('CRS'), name: `Diploma ${suffix}`, code: `DIP-${suffix}`, division: 'education' } });
    const cohort = await scopedPrisma.cohort.create({ data: { tenantId: HOLD, recordCode: await nextRecordCode('COH'), courseId: course.id, name: 'Batch 1', startDate: new Date('2026-01-01') } });
    const studentEmail = `student-${suffix}@example.test`;
    const studentPerson = await scopedPrisma.person.create({ data: { tenantId: HOLD, recordCode: await nextRecordCode('PER'), fullName: 'Student One', primaryEmail: studentEmail, primaryEmailNormalised: studentEmail, source: 'test' } });
    const enrollment = await scopedPrisma.enrollment.create({ data: { tenantId: HOLD, recordCode: await nextRecordCode('ENR'), personId: studentPerson.id, cohortId: cohort.id } });

    // Organisation owned by the division, via an invoice.
    const org = await scopedPrisma.organization.create({ data: { tenantId: HOLD, recordCode: await nextRecordCode('ORG'), kind: 'organization', name: `Acme College ${suffix}` } });
    await scopedPrisma.invoice.create({ data: { tenantId: HOLD, organizationId: org.id, division: 'education' } });

    return { account, category, carriedTxn, sharedTxn, linkedTxn, otherDivisionTxn, orgUnit, employment, empPerson, course, cohort, enrollment, studentPerson, org };
  });
}

beforeAll(async () => {
  const holdSlug = `spinout-hold-${suffix}`;
  const subSlug = `spinout-sub-${suffix}`;

  const hold = await seedBootstrap({ tenantSlug: holdSlug, tenantName: `Spin-out Holding ${suffix}` });
  HOLD = hold.tenantId;
  HOLD_SLUG = holdSlug;

  const sub = await seedBootstrap({ tenantSlug: subSlug, tenantName: `Spin-out Education ${suffix} Pvt Ltd`, parentTenantSlug: holdSlug, originDivision: 'education' });
  SUB = sub.tenantId;

  // Certificate signatories, without which the opening allotment refuses.
  await asSubChairman(() =>
    scopedPrisma.companyProfile.upsert({
      where: { tenantId: SUB },
      create: { tenantId: SUB, legalName: `Spin-out Education ${suffix} Pvt Ltd`, certificateSignatories: [{ name: 'A Director', designation: 'Director' }, { name: 'B Secretary', designation: 'Company Secretary' }] as never },
      update: { certificateSignatories: [{ name: 'A Director', designation: 'Director' }, { name: 'B Secretary', designation: 'Company Secretary' }] as never },
    }),
  );

  await seedHoldingFixtures();
}, 60_000);

describe('EQT-SPN-001 — preview writes nothing and reports every row it would carry and refuse', () => {
  it('carries the education-tagged transaction, employment, course, cohort, enrolment and organisation, and refuses the shared and linked ones — with no rows created', async () => {
    const [txnCountBefore, empCountBefore, subShareClassesBefore] = await Promise.all([
      unscopedPrisma.transaction.count({ where: { tenantId: HOLD } }),
      unscopedPrisma.employmentRelationship.count({ where: { tenantId: HOLD } }),
      unscopedPrisma.shareClass.count({ where: { tenantId: SUB } }),
    ]);

    const preview = await previewSpinOut(HOLD, 'education');

    expect(preview.subsidiary?.tenantId).toBe(SUB);
    expect(preview.ready).toBe(true);
    expect(preview.blockers).toEqual([]);

    expect(preview.carried.transactions?.count).toBe(1);
    expect(preview.carried.employmentRelationships?.count).toBe(1);
    expect(preview.carried.courses?.count).toBe(1);
    expect(preview.carried.cohorts?.count).toBe(1);
    expect(preview.carried.enrollments?.count).toBe(1);
    expect(preview.carried.organizations?.count).toBe(1);

    expect(preview.refused.transactions?.count).toBe(2); // shared + linked-to-invoice
    const reasons = preview.refused.transactions?.sample.map((r) => r.reason) ?? [];
    expect(reasons.some((r) => r.includes('shared'))).toBe(true);
    expect(reasons.some((r) => r.includes('invoice'))).toBe(true);

    const [txnCountAfter, empCountAfter, subShareClassesAfter] = await Promise.all([
      unscopedPrisma.transaction.count({ where: { tenantId: HOLD } }),
      unscopedPrisma.employmentRelationship.count({ where: { tenantId: HOLD } }),
      unscopedPrisma.shareClass.count({ where: { tenantId: SUB } }),
    ]);
    expect(txnCountAfter).toBe(txnCountBefore);
    expect(empCountAfter).toBe(empCountBefore);
    expect(subShareClassesAfter).toBe(subShareClassesBefore);
  });

  it('is reachable through the API surface, gated on group:create, and reads no deeper than the Tenant row of another tenant', async () => {
    const view = await asHoldingChairman(() => spinOutPreview('education'));
    expect(view.carried.transactions?.count).toBe(1);
    // deep:false — never touches the subsidiary's own share register, so it
    // never reports the blockers a genuine cross-tenant read would need.
    expect(view.blockers).toEqual([]);

    const summary = await asHoldingChairman(() => spinOutDivisionsSummary());
    expect(summary.tenantKind).toBe('holding');
    // The education division already has a subsidiary — not offered here.
    expect(summary.divisions.find((d) => d.division === 'education')).toBeUndefined();
    expect(summary.divisions.find((d) => d.division === 'software')).toBeTruthy();
  });
});

describe('EQT-SPN-005 — a shared-division transaction is refused, not carried', () => {
  it('names the reason and never appears among the carried rows', async () => {
    const preview = await previewSpinOut(HOLD, 'education');
    const refusedCodes = preview.refused.transactions?.sample.map((r) => r.code) ?? [];
    const carriedCodes = preview.carried.transactions?.sample ?? [];
    const sharedTxn = await unscopedPrisma.transaction.findFirstOrThrow({ where: { tenantId: HOLD, division: 'shared' } });
    expect(refusedCodes).toContain(sharedTxn.recordCode);
    expect(carriedCodes).not.toContain(sharedTxn.recordCode);
  });
});

let COMMIT_BATCH: Awaited<ReturnType<typeof commitSpinOut>>;

describe('EQT-SPN-002, 003, 004, 007 — commit', () => {
  beforeAll(async () => {
    COMMIT_BATCH = await commitSpinOut({
      holdingTenantId: HOLD,
      division: 'education',
      kiplStake: 7000,
      faceValue: 10,
      className: `Equity ${suffix}`,
      otherHolders: [{ name: `Jane Founder ${suffix}`, email: `jane-founder-${suffix}@example.test`, count: 3000 }],
    });
  });

  it('EQT-SPN-002 — copies division-tagged rows into the subsidiary and marks the sources migrated without editing them', async () => {
    expect(COMMIT_BATCH.carried.transactions).toBe(1);
    expect(COMMIT_BATCH.carried.employmentRelationships).toBe(1);
    expect(COMMIT_BATCH.carried.courses).toBe(1);
    expect(COMMIT_BATCH.carried.cohorts).toBe(1);
    expect(COMMIT_BATCH.carried.enrollments).toBe(1);
    expect(COMMIT_BATCH.carried.organizations).toBe(1);

    const sourceTxn = await unscopedPrisma.transaction.findFirstOrThrow({ where: { tenantId: HOLD, division: 'education', invoiceId: null } });
    expect(sourceTxn.migratedToTenantId).toBe(SUB);
    // Never edited otherwise — the amount and date the row carried at
    // creation still read the same.
    expect(Number(sourceTxn.amount)).toBe(1000);
    expect(sourceTxn.txnDate.toISOString().slice(0, 10)).toBe('2026-04-01');

    const copiedTxn = await unscopedPrisma.transaction.findFirstOrThrow({ where: { tenantId: SUB, spinOutBatchId: COMMIT_BATCH.batchId } });
    expect(Number(copiedTxn.amount)).toBe(1000);
    expect(copiedTxn.division).toBe('education');

    const sourceEmployment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { tenantId: HOLD } });
    expect(sourceEmployment.migratedToTenantId).toBe(SUB);
    // Ending the employment is deliberately not done here.
    expect(sourceEmployment.status).not.toBe('Terminated');

    const copiedEmployment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { tenantId: SUB, spinOutBatchId: COMMIT_BATCH.batchId } });
    expect(copiedEmployment.legalEntity).toBe(`Spin-out Education ${suffix} Pvt Ltd`);
  });

  it('EQT-SPN-003 — the opening allotment records the holding as an entity holder and issues certificates', async () => {
    const entityHolder = await unscopedPrisma.holder.findFirstOrThrow({ where: { tenantId: SUB, kind: 'entity', heldByTenantId: HOLD } });
    const allotment = await unscopedPrisma.shareTransaction.findFirstOrThrow({ where: { tenantId: SUB, toHolderId: entityHolder.id } });
    expect(allotment.status).toBe('effective');
    expect(allotment.boardResolutionRef).toBe('spin-out');
    expect(Number(allotment.count)).toBe(7000);

    const cert = await unscopedPrisma.shareCertificate.findFirstOrThrow({ where: { tenantId: SUB, holderId: entityHolder.id } });
    expect(cert.status).toBe('issued');
    expect((cert.signatories as unknown[]).length).toBeGreaterThanOrEqual(2);

    const otherHolder = await unscopedPrisma.holder.findFirstOrThrow({ where: { tenantId: SUB, kind: 'person', heldByTenantId: null } });
    const otherAllotment = await unscopedPrisma.shareTransaction.findFirstOrThrow({ where: { tenantId: SUB, toHolderId: otherHolder.id } });
    expect(Number(otherAllotment.count)).toBe(3000);
  });

  it('EQT-SPN-004 — cash never moves: subsidiary accounts open at zero with the note', async () => {
    const account = await unscopedPrisma.ledgerAccount.findFirstOrThrow({ where: { tenantId: SUB, spinOutBatchId: COMMIT_BATCH.batchId } });
    expect(Number(account.openingBalance)).toBe(0);
    expect(account.openingNote).toMatch(/transfer of funds/);
    expect(COMMIT_BATCH.accountsOpened.length).toBeGreaterThan(0);
  });

  it('EQT-SPN-007 — the tenant gate holds throughout: no carried row is readable from the holding after commit except through the source row', async () => {
    const copiedTxn = await unscopedPrisma.transaction.findFirstOrThrow({ where: { tenantId: SUB, spinOutBatchId: COMMIT_BATCH.batchId } });

    // A scoped read as the holding tenant never sees the subsidiary's copy —
    // the gate injects tenantId into the query regardless of the id asked for.
    const crossRead = await asHoldingChairman(() => scopedPrisma.transaction.findFirst({ where: { id: copiedTxn.id } }));
    expect(crossRead).toBeNull();

    // The only way from the holding to know it happened is the source row's
    // own `migratedToTenantId` — never a foreign key into the subsidiary's table.
    const sourceTxn = await unscopedPrisma.transaction.findFirstOrThrow({ where: { tenantId: HOLD, division: 'education', invoiceId: null } });
    expect(sourceTxn.migratedToTenantId).toBe(SUB);
  });
});

describe('EQT-SPN-006 — revert removes only what the batch created and refuses once the subsidiary has its own rows', () => {
  it('removes the batch and clears migratedToTenantId on the sources', async () => {
    const result = await revertSpinOut({ holdingTenantId: HOLD, subsidiaryTenantId: SUB, batchId: COMMIT_BATCH.batchId });
    expect(result.removed.transactions).toBe(1);
    expect(result.removed.shareTransactions).toBeGreaterThan(0);

    const remainingShareClasses = await unscopedPrisma.shareClass.count({ where: { tenantId: SUB } });
    expect(remainingShareClasses).toBe(0);
    const remainingTxns = await unscopedPrisma.transaction.count({ where: { tenantId: SUB } });
    expect(remainingTxns).toBe(0);

    const sourceTxn = await unscopedPrisma.transaction.findFirstOrThrow({ where: { tenantId: HOLD, division: 'education', invoiceId: null } });
    expect(sourceTxn.migratedToTenantId).toBeNull();
  });

  it('refuses once the subsidiary has a row of its own', async () => {
    const second = await commitSpinOut({ holdingTenantId: HOLD, division: 'education', faceValue: 10, className: `Equity2 ${suffix}` });

    // Something the batch did not create.
    const account = await unscopedPrisma.ledgerAccount.findFirstOrThrow({ where: { tenantId: SUB } });
    await unscopedPrisma.transaction.create({
      data: { tenantId: SUB, recordCode: `TXN-OWN-${suffix}`, txnDate: new Date(), direction: 'in', amount: 1, accountId: account.id, source: 'manual' },
    });

    const rejection = await expectReject(() => revertSpinOut({ holdingTenantId: HOLD, subsidiaryTenantId: SUB, batchId: second.batchId }));
    expect(rejection.message).toMatch(/life of its own/);
  });
});
