/**
 * Spinning a division out into a subsidiary — equity-portal plan §3.3 and §6b.
 *
 * `pnpm division:spin-out` is the one sanctioned cross-tenant writer besides
 * the snapshot publisher (§3.3): it reads the holding tenant and writes the
 * subsidiary tenant in the same run, each read and write still going through
 * the ordinary tenant-scoped `prisma` client under its own `asSystem(<that
 * tenant>)` context — no query ever runs unscoped, and no query ever spans
 * two tenants at once. A request through the API can never reach this path;
 * `routes/group.routes.ts` exposes only the read-only preview, scoped to the
 * caller's own tenant.
 *
 * Modelled on `imports/service.ts` + `imports/commit.ts`: preview writes
 * nothing and names every row it would carry and every row it would refuse;
 * commit copies rows under a fresh `spinOutBatchId` and marks the sources
 * `migratedToTenantId`, never editing or deleting them, so the holding's
 * history still reads; revert removes only what the batch created.
 *
 * What is carried, verbatim from the phase-6b brief: transactions, employment
 * relationships, courses and enrolments, organisations owned by the division.
 * Everything else division-tagged in the schema (`VendorBill`, `BudgetLine`,
 * `RecurringRule`, `FixedAsset`, `Loan`, `PayrollInstruction`) is out of scope
 * for this phase — named in "Phase 6b — as built" in the plan doc rather than
 * silently ignored.
 */

import { ulid } from 'ulid';
import { EVENTS, type Division } from '@kaizen/shared';
import { prisma, unscopedPrisma, dec } from '../platform/db.js';
import { asSystem, currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { findOrCreatePerson } from '../domains/identity.js';
import { companyProfile } from '../domains/companyProfile.js';
import {
  createShareClass, createHolder, issueCertificateFor, nextDistinctiveStart, nextFolioNumber,
} from '../domains/equity.js';

const SAMPLE_SIZE = 5;

export type SpinOutModel = 'transactions' | 'employmentRelationships' | 'courses' | 'cohorts' | 'enrollments' | 'organizations';

const MODEL_LABEL: Record<SpinOutModel, string> = {
  transactions: 'Transactions',
  employmentRelationships: 'Employment relationships',
  courses: 'Courses',
  cohorts: 'Cohorts',
  enrollments: 'Enrolments',
  organizations: 'Organisations',
};

interface Bucket { count: number; sample: string[] }
interface RefusedRow { code: string; reason: string }
interface RefusedBucket { count: number; sample: RefusedRow[] }

class Ledger {
  carried: Partial<Record<SpinOutModel, Bucket>> = {};
  refused: Partial<Record<SpinOutModel, RefusedBucket>> = {};

  carry(model: SpinOutModel, code: string) {
    const b = (this.carried[model] ??= { count: 0, sample: [] });
    b.count += 1;
    if (b.sample.length < SAMPLE_SIZE) b.sample.push(code);
  }

  refuse(model: SpinOutModel, code: string, reason: string) {
    const b = (this.refused[model] ??= { count: 0, sample: [] });
    b.count += 1;
    if (b.sample.length < SAMPLE_SIZE) b.sample.push({ code, reason });
  }
}

/** Walks an org unit's parent chain for the nearest division it or an ancestor carries. */
async function resolveOrgUnitDivision(orgUnitId: string): Promise<string | null> {
  let cursor: string | null = orgUnitId;
  let steps = 0;
  while (cursor && steps < 10) {
    const unit: { division: string | null; parentId: string | null } | null = await prisma.orgUnit.findFirst({
      where: { id: cursor },
      select: { division: true, parentId: true },
    });
    if (!unit) return null;
    if (unit.division) return unit.division;
    cursor = unit.parentId;
    steps += 1;
  }
  return null;
}

/** Names which record this transaction is linked to, when it is linked to one this script does not carry. */
function transactionLinkName(t: { payrollRunId: string | null; invoiceId: string | null; vendorBillId: string | null; fixedAssetId: string | null; loanId: string | null }): string | null {
  if (t.invoiceId) return 'an invoice';
  if (t.vendorBillId) return 'a vendor bill';
  if (t.payrollRunId) return 'a payroll run';
  if (t.fixedAssetId) return 'a fixed asset';
  if (t.loanId) return 'a loan';
  return null;
}

interface CarriedTransaction {
  id: string; recordCode: string; accountName: string; categoryName: string | null;
  txnDate: Date; direction: string; amount: unknown; currency: string;
  division: string | null; counterparty: string | null; method: string; reference: string | null; note: string | null;
}
interface CarriedEmployment {
  id: string; recordCode: string; personId: string;
  hireEffectiveDate: Date; status: string; panNumber: string | null; aadhaarReference: string | null; uanNumber: string | null;
}
interface CarriedCourse {
  id: string; recordCode: string; name: string; code: string; description: string | null; durationWeeks: number | null;
  feeAmount: unknown; gstRate: unknown; hsnSac: string | null; division: string;
}
interface CarriedCohort {
  id: string; recordCode: string; courseId: string; name: string; startDate: Date; endDate: Date | null;
  capacity: number; status: string;
}
interface CarriedEnrollment {
  id: string; recordCode: string; personId: string; cohortId: string; status: string;
  enrolledAt: Date | null; completedAt: Date | null; progressPct: number; attendancePct: number;
}
interface CarriedOrganization {
  id: string; recordCode: string; kind: string; roles: string[]; name: string; website: string | null;
  locations: unknown; tags: string[];
}

interface Candidates {
  transactions: CarriedTransaction[];
  employmentRelationships: CarriedEmployment[];
  courses: CarriedCourse[];
  cohorts: CarriedCohort[];
  enrollments: CarriedEnrollment[];
  organizations: CarriedOrganization[];
  ledger: Ledger;
}

/**
 * Reads the holding tenant only — this is the half of the operation that
 * never needs a second tenant in scope. Runs under `asSystem(holdingTenantId)`
 * so it sees the whole tenant regardless of the caller's own grant scope; the
 * caller-facing entry points below gate on a real permission first.
 */
async function collectCandidates(holdingTenantId: string, division: Division): Promise<Candidates> {
  return asSystem(holdingTenantId, async () => {
    const ledger = new Ledger();

    // ---- Transactions -------------------------------------------------
    const txnRows = await prisma.transaction.findMany({
      where: { tenantId: holdingTenantId, deletedAt: null, migratedToTenantId: null, division: { in: [division, 'shared'] } },
      include: { account: true, category: true },
      orderBy: { txnDate: 'asc' },
    });
    const transactions: CarriedTransaction[] = [];
    for (const t of txnRows) {
      if (t.division === 'shared') {
        ledger.refuse('transactions', t.recordCode, 'Tagged to the shared division, so it cannot be attributed to one subsidiary. Split it before the spin-out.');
        continue;
      }
      const linked = transactionLinkName(t);
      if (linked) {
        ledger.refuse('transactions', t.recordCode, `Linked to ${linked}, which this script does not carry. Record the equivalent directly in the subsidiary instead.`);
        continue;
      }
      ledger.carry('transactions', t.recordCode);
      transactions.push({
        id: t.id, recordCode: t.recordCode, accountName: t.account.name, categoryName: t.category?.name ?? null,
        txnDate: t.txnDate, direction: t.direction, amount: t.amount, currency: t.currency,
        division: t.division, counterparty: t.counterparty, method: t.method, reference: t.reference, note: t.note,
      });
    }

    // ---- Employment relationships --------------------------------------
    const empRows = await prisma.employmentRelationship.findMany({
      where: { tenantId: holdingTenantId, deletedAt: null, migratedToTenantId: null, separationDate: null },
      include: { assignments: { where: { rowStatus: 'Effective', effectiveTo: null }, include: { position: true } } },
    });
    const employmentRelationships: CarriedEmployment[] = [];
    for (const e of empRows) {
      if (e.assignments.length === 0) continue; // no current seat on file — not in scope for any division
      const divisions = new Set<string | null>();
      for (const a of e.assignments) divisions.add(await resolveOrgUnitDivision(a.position.orgUnitId));
      if (divisions.size > 1) {
        ledger.refuse('employmentRelationships', e.recordCode, 'Holds more than one current assignment, in different divisions. Resolve which unit this person moves with before the spin-out.');
        continue;
      }
      const div = [...divisions][0];
      if (div === 'shared') {
        ledger.refuse('employmentRelationships', e.recordCode, 'Assigned to a shared unit, not one division. Reassign before the spin-out if this person is moving.');
        continue;
      }
      if (div !== division) continue; // a different division's employee — not in scope, not a refusal
      const person = await prisma.person.findFirst({ where: { id: e.personId } });
      if (!person?.primaryEmail && !person?.primaryPhone) {
        ledger.refuse('employmentRelationships', e.recordCode, 'No email or phone on file for this person, so they cannot be resolved in the new tenant.');
        continue;
      }
      ledger.carry('employmentRelationships', e.recordCode);
      employmentRelationships.push({
        id: e.id, recordCode: e.recordCode, personId: e.personId,
        hireEffectiveDate: e.hireEffectiveDate, status: e.status,
        panNumber: e.panNumber, aadhaarReference: e.aadhaarReference, uanNumber: e.uanNumber,
      });
    }

    // ---- Courses, cohorts, enrolments -----------------------------------
    const courseRows = await prisma.course.findMany({ where: { tenantId: holdingTenantId, migratedToTenantId: null } });
    const courses: CarriedCourse[] = [];
    const carriedCourseIds = new Set<string>();
    for (const c of courseRows) {
      if (c.division === 'shared') {
        ledger.refuse('courses', c.recordCode, 'Tagged to the shared division, so it cannot be attributed to one subsidiary.');
        continue;
      }
      if (c.division !== division) continue;
      ledger.carry('courses', c.recordCode);
      courses.push({
        id: c.id, recordCode: c.recordCode, name: c.name, code: c.code, description: c.description,
        durationWeeks: c.durationWeeks, feeAmount: c.feeAmount, gstRate: c.gstRate, hsnSac: c.hsnSac, division: c.division,
      });
      carriedCourseIds.add(c.id);
    }

    const cohortRows = carriedCourseIds.size
      ? await prisma.cohort.findMany({ where: { tenantId: holdingTenantId, migratedToTenantId: null, courseId: { in: [...carriedCourseIds] } } })
      : [];
    const cohorts: CarriedCohort[] = [];
    const carriedCohortIds = new Set<string>();
    for (const co of cohortRows) {
      ledger.carry('cohorts', co.recordCode);
      cohorts.push({
        id: co.id, recordCode: co.recordCode, courseId: co.courseId, name: co.name,
        startDate: co.startDate, endDate: co.endDate, capacity: co.capacity, status: co.status,
      });
      carriedCohortIds.add(co.id);
    }

    const enrollmentRows = carriedCohortIds.size
      ? await prisma.enrollment.findMany({ where: { tenantId: holdingTenantId, migratedToTenantId: null, cohortId: { in: [...carriedCohortIds] } } })
      : [];
    const enrollments: CarriedEnrollment[] = [];
    for (const en of enrollmentRows) {
      const person = await prisma.person.findFirst({ where: { id: en.personId } });
      if (!person?.primaryEmail && !person?.primaryPhone) {
        ledger.refuse('enrollments', en.recordCode, 'No email or phone on file for this learner, so they cannot be resolved in the new tenant.');
        continue;
      }
      ledger.carry('enrollments', en.recordCode);
      enrollments.push({
        id: en.id, recordCode: en.recordCode, personId: en.personId, cohortId: en.cohortId, status: en.status,
        enrolledAt: en.enrolledAt, completedAt: en.completedAt, progressPct: en.progressPct, attendancePct: en.attendancePct,
      });
    }

    // ---- Organisations owned by the division -----------------------------
    const invoiceRows = await prisma.invoice.findMany({
      where: { tenantId: holdingTenantId, organizationId: { not: null }, division: { not: null } },
      select: { organizationId: true, division: true },
    });
    const divisionsByOrg = new Map<string, Set<string>>();
    for (const inv of invoiceRows) {
      if (!inv.organizationId || !inv.division) continue;
      const set = divisionsByOrg.get(inv.organizationId) ?? new Set<string>();
      set.add(inv.division);
      divisionsByOrg.set(inv.organizationId, set);
    }
    const organizations: CarriedOrganization[] = [];
    for (const [orgId, divs] of divisionsByOrg) {
      if (divs.size > 1) {
        const org = await prisma.organization.findFirst({ where: { id: orgId } });
        if (org && org.migratedToTenantId === null) {
          ledger.refuse('organizations', org.recordCode, `Invoiced from more than one division (${[...divs].sort().join(', ')}); not attributable to a single subsidiary.`);
        }
        continue;
      }
      const only = [...divs][0];
      if (only === 'shared') {
        const org = await prisma.organization.findFirst({ where: { id: orgId } });
        if (org && org.migratedToTenantId === null) {
          ledger.refuse('organizations', org.recordCode, 'Invoiced under the shared division; not attributable to a single subsidiary.');
        }
        continue;
      }
      if (only !== division) continue;
      const org = await prisma.organization.findFirst({ where: { id: orgId, deletedAt: null, migratedToTenantId: null } });
      if (!org) continue;
      ledger.carry('organizations', org.recordCode);
      organizations.push({
        id: org.id, recordCode: org.recordCode, kind: org.kind, roles: org.roles, name: org.name,
        website: org.website, locations: org.locations, tags: org.tags,
      });
    }

    return { transactions, employmentRelationships, courses, cohorts, enrollments, organizations, ledger };
  });
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface SpinOutPreview {
  division: Division;
  holding: { tenantId: string; slug: string };
  subsidiary: { tenantId: string; slug: string; name: string } | null;
  ready: boolean;
  blockers: string[];
  carried: Partial<Record<SpinOutModel, Bucket>>;
  refused: Partial<Record<SpinOutModel, RefusedBucket>>;
  openingAllotment: { note: string };
}

/** Finds the subsidiary tenant a spin-out for this division would target, if one exists. */
async function findSubsidiary(holdingTenantId: string, division: Division) {
  const children = await unscopedPrisma.tenant.findMany({ where: { parentTenantId: holdingTenantId } });
  return children.find((c) => (c.config as { originDivision?: string } | null)?.originDivision === division) ?? null;
}

/**
 * `deep` reads inside the subsidiary tenant's own business tables (its share
 * register, its company profile) to say whether a commit could run right now
 * — real cross-tenant reads, legitimate for this script (the sanctioned
 * cross-tenant writer, §3.3/§6b) but not for a live API request. The route
 * this preview also serves (`domains/group.ts`) passes `deep: false`, so a
 * request never reads past the `Tenant` row (itself tenant-exempt, like
 * `assertNotHoldingsAncestor` in `domains/equity.ts`) of a tenant that is not
 * its own.
 */
export async function previewSpinOut(holdingTenantId: string, division: Division, deep = true): Promise<SpinOutPreview> {
  const holding = await unscopedPrisma.tenant.findFirstOrThrow({ where: { id: holdingTenantId } });
  const subsidiaryTenant = await findSubsidiary(holdingTenantId, division);
  const candidates = await collectCandidates(holdingTenantId, division);

  const blockers: string[] = [];
  if (!subsidiaryTenant) {
    blockers.push(
      `No subsidiary is on file for the ${division} division. Create one first: ` +
        `pnpm --filter @kaizen/api tenant:create --slug <slug> --name "<Legal Name> Pvt Ltd" --parent ${holding.slug} --origin-division ${division}`,
    );
  } else if (subsidiaryTenant.parentTenantId !== holdingTenantId) {
    blockers.push(`Tenant "${subsidiaryTenant.slug}" does not name "${holding.slug}" as its parent.`);
  } else if (deep) {
    const registerCount = await asSystem(subsidiaryTenant.id, async () => await prisma.shareClass.count({ where: { tenantId: subsidiaryTenant.id } }));
    if (registerCount > 0) {
      blockers.push(`"${subsidiaryTenant.slug}" already has ${registerCount} share class(es) on its register. A spin-out is only the first thing that happens to a subsidiary.`);
    }
    const signatories = await asSystem(subsidiaryTenant.id, async () => (await companyProfile()).certificateSignatories as unknown[]);
    if (!Array.isArray(signatories) || signatories.length < 2) {
      blockers.push(`"${subsidiaryTenant.slug}" has fewer than two certificate signatories on its company profile. Set them before the opening allotment can issue certificates.`);
    }
  }

  return {
    division,
    holding: { tenantId: holding.id, slug: holding.slug },
    subsidiary: subsidiaryTenant ? { tenantId: subsidiaryTenant.id, slug: subsidiaryTenant.slug, name: subsidiaryTenant.name } : null,
    ready: blockers.length === 0,
    blockers,
    carried: candidates.ledger.carried,
    refused: candidates.ledger.refused,
    openingAllotment: {
      note: 'Cash never moves by data migration — the subsidiary\'s ledger accounts open at zero, with a note that the balance is to be set from the transfer of funds.',
    },
  };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface SpinOutHolderInput { name: string; count: number; email?: string; phone?: string }

export interface SpinOutCommitInput {
  holdingTenantId: string;
  division: Division;
  kiplStake?: number;
  faceValue?: number;
  className?: string;
  otherHolders?: SpinOutHolderInput[];
}

export interface SpinOutCommitResult {
  batchId: string;
  subsidiaryTenantId: string;
  carried: Record<string, number>;
  accountsOpened: string[];
  categoriesCopied: string[];
  openingAllotment: { shareClassId: string; holders: Array<{ holderId: string; count: number }> };
}


export async function commitSpinOut(input: SpinOutCommitInput): Promise<SpinOutCommitResult> {
  const preview = await previewSpinOut(input.holdingTenantId, input.division);
  if (!preview.ready || !preview.subsidiary) {
    throw new Error(`Cannot commit — ${preview.blockers.join(' ')}`);
  }
  const subsidiaryTenantId = preview.subsidiary.tenantId;
  const candidates = await collectCandidates(input.holdingTenantId, input.division);
  const batchId = `SPINOUT-${ulid()}`;

  const carried: Record<string, number> = {};
  const bump = (k: string) => { carried[k] = (carried[k] ?? 0) + 1; };

  // ---- Ledger accounts and categories, copied by name at zero -----------
  // Source names are already on each carried transaction candidate — no
  // second read of the holding tenant is needed to know what to copy.
  const accountNames = new Set(candidates.transactions.map((t) => t.accountName));
  const categoryNames = new Set(candidates.transactions.map((t) => t.categoryName).filter((n): n is string => Boolean(n)));

  const sourceAccountsByName = await asSystem(input.holdingTenantId, async () => {
    const out = new Map<string, { accountType: string; ledgerGroup: string; currency: string }>();
    for (const name of accountNames) {
      const a = await prisma.ledgerAccount.findFirst({ where: { tenantId: input.holdingTenantId, name } });
      if (a) out.set(name, { accountType: a.accountType, ledgerGroup: a.ledgerGroup, currency: a.currency });
    }
    return out;
  });
  const sourceCategoriesByName = await asSystem(input.holdingTenantId, async () => {
    const out = new Map<string, { kind: string; behaviour: string; defaultDivision: string | null; mustPay: boolean }>();
    for (const name of categoryNames) {
      const c = await prisma.ledgerCategory.findFirst({ where: { tenantId: input.holdingTenantId, name } });
      if (c) out.set(name, { kind: c.kind, behaviour: c.behaviour, defaultDivision: c.defaultDivision, mustPay: c.mustPay });
    }
    return out;
  });

  const accountIdByName = new Map<string, string>();
  const categoryIdByName = new Map<string, string>();
  const accountsOpened: string[] = [];
  const categoriesCopied: string[] = [];

  await asSystem(subsidiaryTenantId, async () => {
    for (const [name, spec] of sourceAccountsByName) {
      let account = await prisma.ledgerAccount.findFirst({ where: { tenantId: subsidiaryTenantId, name } });
      if (!account) {
        account = await prisma.ledgerAccount.create({
          data: {
            tenantId: subsidiaryTenantId,
            name,
            accountType: spec.accountType,
            ledgerGroup: spec.ledgerGroup,
            currency: spec.currency,
            openingBalance: dec(0)!,
            openingNote: 'Opening balance to be set from the transfer of funds.',
            spinOutBatchId: batchId,
          },
        });
        accountsOpened.push(name);
      }
      accountIdByName.set(name, account.id);
    }
    for (const [name, spec] of sourceCategoriesByName) {
      let category = await prisma.ledgerCategory.findFirst({ where: { tenantId: subsidiaryTenantId, name } });
      if (!category) {
        category = await prisma.ledgerCategory.create({
          data: {
            tenantId: subsidiaryTenantId,
            name,
            kind: spec.kind,
            behaviour: spec.behaviour,
            defaultDivision: spec.defaultDivision,
            mustPay: spec.mustPay,
            spinOutBatchId: batchId,
          },
        });
        categoriesCopied.push(name);
      }
      categoryIdByName.set(name, category.id);
    }

    // ---- Transactions -----------------------------------------------------
    for (const t of candidates.transactions) {
      const accountId = accountIdByName.get(t.accountName);
      if (!accountId) continue; // its account failed to resolve — should not happen, given the loop above
      const categoryId = t.categoryName ? categoryIdByName.get(t.categoryName) ?? null : null;
      await prisma.transaction.create({
        data: {
          tenantId: subsidiaryTenantId,
          recordCode: await nextRecordCode('TXN'),
          txnDate: t.txnDate,
          direction: t.direction,
          amount: t.amount as never,
          currency: t.currency,
          accountId,
          categoryId,
          division: t.division,
          counterparty: t.counterparty,
          method: t.method,
          reference: t.reference,
          note: t.note,
          source: 'manual',
          spinOutBatchId: batchId,
        },
      });
      bump('transactions');
    }

    // ---- Courses and cohorts ------------------------------------------------
    const courseIdMap = new Map<string, string>();
    for (const c of candidates.courses) {
      const created = await prisma.course.create({
        data: {
          tenantId: subsidiaryTenantId,
          recordCode: await nextRecordCode('CRS'),
          name: c.name,
          code: c.code,
          description: c.description,
          durationWeeks: c.durationWeeks,
          feeAmount: c.feeAmount as never,
          gstRate: c.gstRate as never,
          hsnSac: c.hsnSac,
          division: c.division,
          spinOutBatchId: batchId,
        },
      });
      courseIdMap.set(c.id, created.id);
      bump('courses');
    }

    const cohortIdMap = new Map<string, string>();
    for (const co of candidates.cohorts) {
      const courseId = courseIdMap.get(co.courseId);
      if (!courseId) continue;
      const created = await prisma.cohort.create({
        data: {
          tenantId: subsidiaryTenantId,
          recordCode: await nextRecordCode('COH'),
          courseId,
          name: co.name,
          startDate: co.startDate,
          endDate: co.endDate,
          capacity: co.capacity,
          status: co.status,
          spinOutBatchId: batchId,
        },
      });
      cohortIdMap.set(co.id, created.id);
      bump('cohorts');
    }

    // ---- Enrolments — the learner is re-resolved through findOrCreatePerson,
    // because a Person is per tenant. -----------------------------------------
    for (const en of candidates.enrollments) {
      const cohortId = cohortIdMap.get(en.cohortId);
      if (!cohortId) continue;
      const sourcePerson = await asSystem(input.holdingTenantId, async () => await prisma.person.findFirstOrThrow({ where: { id: en.personId } }));
      const resolved = await findOrCreatePerson({
        fullName: sourcePerson.fullName,
        primaryEmail: sourcePerson.primaryEmail,
        primaryPhone: sourcePerson.primaryPhone,
        source: 'spin_out',
      });
      await prisma.enrollment.create({
        data: {
          tenantId: subsidiaryTenantId,
          recordCode: await nextRecordCode('ENR'),
          personId: resolved.person.id,
          cohortId,
          status: en.status,
          enrolledAt: en.enrolledAt,
          completedAt: en.completedAt,
          progressPct: en.progressPct,
          attendancePct: en.attendancePct,
          spinOutBatchId: batchId,
        },
      });
      bump('enrollments');
    }

    // ---- Organisations -------------------------------------------------------
    for (const org of candidates.organizations) {
      await prisma.organization.create({
        data: {
          tenantId: subsidiaryTenantId,
          recordCode: await nextRecordCode('ORG'),
          kind: org.kind,
          roles: org.roles,
          name: org.name,
          website: org.website,
          locations: org.locations as never,
          tags: org.tags,
          spinOutBatchId: batchId,
        },
      });
      bump('organizations');
    }

    // ---- Employment relationships — the person is re-resolved the same way;
    // `legalEntity` becomes the subsidiary's own legal name. Ending the source
    // employment is deliberately NOT done here — that is an HR act the
    // chairman takes on purpose, not a side effect of a data migration. -------
    const subsidiaryLegalName = (await companyProfile()).legalName;
    for (const e of candidates.employmentRelationships) {
      const sourcePerson = await asSystem(input.holdingTenantId, async () => await prisma.person.findFirstOrThrow({ where: { id: e.personId } }));
      const resolved = await findOrCreatePerson({
        fullName: sourcePerson.fullName,
        primaryEmail: sourcePerson.primaryEmail,
        primaryPhone: sourcePerson.primaryPhone,
        source: 'spin_out',
      });
      await prisma.employmentRelationship.create({
        data: {
          tenantId: subsidiaryTenantId,
          recordCode: await nextRecordCode('EMP'),
          personId: resolved.person.id,
          legalEntity: subsidiaryLegalName,
          hireEffectiveDate: e.hireEffectiveDate,
          status: e.status,
          panNumber: e.panNumber,
          aadhaarReference: e.aadhaarReference,
          uanNumber: e.uanNumber,
          spinOutBatchId: batchId,
        },
      });
      bump('employmentRelationships');
    }
  });

  // ---- Mark every carried source row migrated, in the holding tenant -------
  await asSystem(input.holdingTenantId, async () => {
    if (candidates.transactions.length) await prisma.transaction.updateMany({ where: { id: { in: candidates.transactions.map((r) => r.id) } }, data: { migratedToTenantId: subsidiaryTenantId } });
    if (candidates.employmentRelationships.length) await prisma.employmentRelationship.updateMany({ where: { id: { in: candidates.employmentRelationships.map((r) => r.id) } }, data: { migratedToTenantId: subsidiaryTenantId } });
    if (candidates.courses.length) await prisma.course.updateMany({ where: { id: { in: candidates.courses.map((r) => r.id) } }, data: { migratedToTenantId: subsidiaryTenantId } });
    if (candidates.cohorts.length) await prisma.cohort.updateMany({ where: { id: { in: candidates.cohorts.map((r) => r.id) } }, data: { migratedToTenantId: subsidiaryTenantId } });
    if (candidates.enrollments.length) await prisma.enrollment.updateMany({ where: { id: { in: candidates.enrollments.map((r) => r.id) } }, data: { migratedToTenantId: subsidiaryTenantId } });
    if (candidates.organizations.length) await prisma.organization.updateMany({ where: { id: { in: candidates.organizations.map((r) => r.id) } }, data: { migratedToTenantId: subsidiaryTenantId } });
  });

  // ---- Opening allotment: the holding as an entity holder, plus anyone else
  // named, approved and made effective under the system principal. The
  // approval gate (`evaluateApprovalGate`) has no ceiling for a system
  // principal and would only open a pending approval step rather than grant
  // one outright, so this writes the transaction straight to `effective` —
  // the same explicit path the opening-register import uses
  // (`imports/commit.ts#commitOpeningRegisterRow`) — rather than routing
  // through `proposeAllotment`/`approveShareTransaction`. --------------------
  const holdingHolders: Array<{ holderId: string; count: number }> = [];
  let openingShareClassId = '';
  await asSystem(subsidiaryTenantId, async () => {
    const shareClass = await createShareClass({
      name: input.className ?? 'Equity',
      kind: 'equity',
      instrument: 'equity',
      faceValue: input.faceValue ?? 10,
    });

    const entries: Array<{ holderId: string; count: number }> = [];
    if (input.kiplStake && input.kiplStake > 0) {
      const holder = await createHolder({ kind: 'entity', heldByTenantId: input.holdingTenantId, residency: 'resident' });
      entries.push({ holderId: holder.id, count: input.kiplStake });
    }
    for (const other of input.otherHolders ?? []) {
      if (!other.email && !other.phone) {
        throw new Error(`"${other.name}" needs an email or a phone number to be resolved as a person in the new tenant — pass --other-holder "${other.name}|<email>=${other.count}".`);
      }
      const holder = await createHolder({ kind: 'person', person: { fullName: other.name, email: other.email, phone: other.phone }, residency: 'resident' });
      entries.push({ holderId: holder.id, count: other.count });
    }

    for (const entry of entries) {
      const auth = currentAuth();
      const start = await nextDistinctiveStart(shareClass.id);
      const end = start + BigInt(entry.count) - BigInt(1);
      const txn = await prisma.shareTransaction.create({
        data: {
          tenantId: subsidiaryTenantId,
          recordCode: await nextRecordCode('SHT'),
          type: 'allotment',
          shareClassId: shareClass.id,
          toHolderId: entry.holderId,
          count: dec(entry.count)!,
          effectiveOn: new Date(),
          boardResolutionRef: 'spin-out',
          status: 'effective',
          distinctiveFrom: start,
          distinctiveTo: end,
          proposedByPartyId: auth.partyId ?? 'system',
          note: `Opening allotment — spin-out of the ${input.division} division from ${preview.holding.slug}.`,
          spinOutBatchId: batchId,
        },
      });
      await issueCertificateFor({
        holderId: entry.holderId,
        shareClassId: shareClass.id,
        distinctiveFrom: start,
        distinctiveTo: end,
        count: entry.count,
        issuedOn: txn.effectiveOn,
        issuedForTransactionId: txn.id,
      });
      await prisma.shareCertificate.updateMany({ where: { issuedForTransactionId: txn.id }, data: { spinOutBatchId: batchId } });
      await prisma.holder.update({ where: { id: entry.holderId }, data: { spinOutBatchId: batchId } });
      holdingHolders.push(entry);
    }
    await prisma.shareClass.update({ where: { id: shareClass.id }, data: { spinOutBatchId: batchId } });
    openingShareClassId = shareClass.id;

    await unscopedPrisma.tenant.update({
      where: { id: subsidiaryTenantId },
      data: {
        config: {
          ...((await unscopedPrisma.tenant.findFirstOrThrow({ where: { id: subsidiaryTenantId } })).config as object ?? {}),
          spinOut: { from: preview.holding.slug, division: input.division, at: new Date().toISOString(), batchId },
        } as never,
      },
    });

    await emit({
      name: EVENTS.TENANT_SPIN_OUT_COMMITTED,
      subject: { entityType: 'tenant', entityId: subsidiaryTenantId },
      newState: { from: preview.holding.slug, division: input.division, batchId, carried },
      impact: { domains: ['sys'] },
    });
  });

  await asSystem(input.holdingTenantId, async () => {
    await emit({
      name: EVENTS.TENANT_SPIN_OUT_COMMITTED,
      subject: { entityType: 'tenant', entityId: input.holdingTenantId },
      newState: { to: preview.subsidiary!.slug, division: input.division, batchId, carried },
      impact: { domains: ['sys'] },
    });
  });

  return {
    batchId,
    subsidiaryTenantId,
    carried,
    accountsOpened,
    categoriesCopied,
    openingAllotment: { shareClassId: openingShareClassId, holders: holdingHolders },
  };
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

export interface SpinOutRevertResult {
  removed: Record<string, number>;
}

/**
 * Removes only what the batch created in the subsidiary, and clears
 * `migratedToTenantId` on the sources it carried. Refuses outright if the
 * subsidiary carries any transaction or register row from outside the batch
 * — reverting a spin-out is only safe while the subsidiary has done nothing
 * else yet.
 */
export async function revertSpinOut(input: { holdingTenantId: string; subsidiaryTenantId: string; batchId: string }): Promise<SpinOutRevertResult> {
  const removed: Record<string, number> = {};
  const bump = (k: string, n: number) => { if (n) removed[k] = (removed[k] ?? 0) + n; };

  await asSystem(input.subsidiaryTenantId, async () => {
    const [otherTxns, otherShares] = await Promise.all([
      // `not: batchId` alone would miss a row with no `spinOutBatchId` at all —
      // Postgres never matches NULL against `<>` — and a row outside every
      // batch is exactly the "life of its own" case this guards against.
      prisma.transaction.count({ where: { tenantId: input.subsidiaryTenantId, OR: [{ spinOutBatchId: { not: input.batchId } }, { spinOutBatchId: null }] } }),
      prisma.shareTransaction.count({ where: { tenantId: input.subsidiaryTenantId, OR: [{ spinOutBatchId: { not: input.batchId } }, { spinOutBatchId: null }] } }),
    ]);
    if (otherTxns > 0 || otherShares > 0) {
      throw new Error(
        `"${input.subsidiaryTenantId}" has transactions or register rows this batch did not create — the spin-out cannot be reverted once the subsidiary has a life of its own.`,
      );
    }

    const certs = await prisma.shareCertificate.deleteMany({ where: { tenantId: input.subsidiaryTenantId, spinOutBatchId: input.batchId } });
    bump('shareCertificates', certs.count);
    const shts = await prisma.shareTransaction.deleteMany({ where: { tenantId: input.subsidiaryTenantId, spinOutBatchId: input.batchId } });
    bump('shareTransactions', shts.count);
    const holders = await prisma.holder.deleteMany({ where: { tenantId: input.subsidiaryTenantId, spinOutBatchId: input.batchId } });
    bump('holders', holders.count);
    const classes = await prisma.shareClass.deleteMany({ where: { tenantId: input.subsidiaryTenantId, spinOutBatchId: input.batchId } });
    bump('shareClasses', classes.count);

    const enrollments = await prisma.enrollment.deleteMany({ where: { tenantId: input.subsidiaryTenantId, spinOutBatchId: input.batchId } });
    bump('enrollments', enrollments.count);
    const cohorts = await prisma.cohort.deleteMany({ where: { tenantId: input.subsidiaryTenantId, spinOutBatchId: input.batchId } });
    bump('cohorts', cohorts.count);
    const courses = await prisma.course.deleteMany({ where: { tenantId: input.subsidiaryTenantId, spinOutBatchId: input.batchId } });
    bump('courses', courses.count);

    const orgs = await prisma.organization.deleteMany({ where: { tenantId: input.subsidiaryTenantId, spinOutBatchId: input.batchId } });
    bump('organizations', orgs.count);

    const emps = await prisma.employmentRelationship.deleteMany({ where: { tenantId: input.subsidiaryTenantId, spinOutBatchId: input.batchId } });
    bump('employmentRelationships', emps.count);

    const txns = await prisma.transaction.deleteMany({ where: { tenantId: input.subsidiaryTenantId, spinOutBatchId: input.batchId } });
    bump('transactions', txns.count);

    // Accounts/categories opened by this batch are only removed if this batch
    // is the only thing that ever used them — otherwise a legitimate row
    // created since would be left pointing at nothing.
    const accounts = await prisma.ledgerAccount.findMany({ where: { tenantId: input.subsidiaryTenantId, spinOutBatchId: input.batchId } });
    for (const a of accounts) {
      const stillUsed = await prisma.transaction.count({ where: { tenantId: input.subsidiaryTenantId, accountId: a.id } });
      if (stillUsed === 0) await prisma.ledgerAccount.delete({ where: { id: a.id } });
    }
    const categories = await prisma.ledgerCategory.findMany({ where: { tenantId: input.subsidiaryTenantId, spinOutBatchId: input.batchId } });
    for (const c of categories) {
      const stillUsed = await prisma.transaction.count({ where: { tenantId: input.subsidiaryTenantId, categoryId: c.id } });
      if (stillUsed === 0) await prisma.ledgerCategory.delete({ where: { id: c.id } });
    }

    const tenant = await unscopedPrisma.tenant.findFirstOrThrow({ where: { id: input.subsidiaryTenantId } });
    const config = { ...((tenant.config as Record<string, unknown>) ?? {}) };
    delete config.spinOut;
    await unscopedPrisma.tenant.update({ where: { id: input.subsidiaryTenantId }, data: { config: config as never } });

    await emit({
      name: EVENTS.TENANT_SPIN_OUT_REVERTED,
      subject: { entityType: 'tenant', entityId: input.subsidiaryTenantId },
      newState: { batchId: input.batchId, removed },
      impact: { domains: ['sys'] },
    });
  });

  await asSystem(input.holdingTenantId, async () => {
    await prisma.transaction.updateMany({ where: { tenantId: input.holdingTenantId, migratedToTenantId: input.subsidiaryTenantId }, data: { migratedToTenantId: null } });
    await prisma.employmentRelationship.updateMany({ where: { tenantId: input.holdingTenantId, migratedToTenantId: input.subsidiaryTenantId }, data: { migratedToTenantId: null } });
    await prisma.course.updateMany({ where: { tenantId: input.holdingTenantId, migratedToTenantId: input.subsidiaryTenantId }, data: { migratedToTenantId: null } });
    await prisma.cohort.updateMany({ where: { tenantId: input.holdingTenantId, migratedToTenantId: input.subsidiaryTenantId }, data: { migratedToTenantId: null } });
    await prisma.enrollment.updateMany({ where: { tenantId: input.holdingTenantId, migratedToTenantId: input.subsidiaryTenantId }, data: { migratedToTenantId: null } });
    await prisma.organization.updateMany({ where: { tenantId: input.holdingTenantId, migratedToTenantId: input.subsidiaryTenantId }, data: { migratedToTenantId: null } });

    await emit({
      name: EVENTS.TENANT_SPIN_OUT_REVERTED,
      subject: { entityType: 'tenant', entityId: input.holdingTenantId },
      newState: { batchId: input.batchId, removed },
      impact: { domains: ['sys'] },
    });
  });

  return { removed };
}

export { MODEL_LABEL };
