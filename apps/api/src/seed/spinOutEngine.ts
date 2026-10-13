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
 * history still reads; revert reverses and marks only what the batch created,
 * and deletes nothing (FX-71: a deleted accounting row is a lost audit trail).
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
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { assertCan, assertScopeAll } from '../platform/permissions.js';
import { governedWrite } from '../platform/governedWrite.js';
import { runHooks } from '../platform/hooks.js';
import { ApiError } from '../platform/errors.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { findOrCreatePerson } from '../domains/identity.js';
import { companyProfile } from '../domains/companyProfile.js';
import {
  createShareClass,
  createHolder,
  issueCertificateFor,
  nextDistinctiveStart,
  nextFolioNumber,
} from '../domains/equity.js';

const SAMPLE_SIZE = 5;

export type SpinOutModel =
  'transactions' | 'employmentRelationships' | 'courses' | 'cohorts' | 'enrollments' | 'organizations';

const MODEL_LABEL: Record<SpinOutModel, string> = {
  transactions: 'Transactions',
  employmentRelationships: 'Employment relationships',
  courses: 'Courses',
  cohorts: 'Cohorts',
  enrollments: 'Enrolments',
  organizations: 'Organisations',
};

interface Bucket {
  count: number;
  sample: string[];
}
interface RefusedRow {
  code: string;
  reason: string;
}
interface RefusedBucket {
  count: number;
  sample: RefusedRow[];
}

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
function transactionLinkName(t: {
  payrollRunId: string | null;
  invoiceId: string | null;
  vendorBillId: string | null;
  fixedAssetId: string | null;
  loanId: string | null;
}): string | null {
  if (t.invoiceId) return 'an invoice';
  if (t.vendorBillId) return 'a vendor bill';
  if (t.payrollRunId) return 'a payroll run';
  if (t.fixedAssetId) return 'a fixed asset';
  if (t.loanId) return 'a loan';
  return null;
}

interface CarriedTransaction {
  id: string;
  recordCode: string;
  accountName: string;
  categoryName: string | null;
  txnDate: Date;
  direction: string;
  amount: unknown;
  currency: string;
  division: string | null;
  counterparty: string | null;
  method: string;
  reference: string | null;
  note: string | null;
}
interface CarriedEmployment {
  id: string;
  recordCode: string;
  personId: string;
  hireEffectiveDate: Date;
  status: string;
  panNumber: string | null;
  aadhaarReference: string | null;
  uanNumber: string | null;
}
interface CarriedCourse {
  id: string;
  recordCode: string;
  name: string;
  code: string;
  description: string | null;
  durationWeeks: number | null;
  feeAmountMinor: bigint | null;
  gstRate: unknown;
  hsnSac: string | null;
  division: string;
}
interface CarriedCohort {
  id: string;
  recordCode: string;
  courseId: string;
  name: string;
  startDate: Date;
  endDate: Date | null;
  capacity: number;
  status: string;
}
interface CarriedEnrollment {
  id: string;
  recordCode: string;
  personId: string;
  cohortId: string;
  status: string;
  enrolledAt: Date | null;
  completedAt: Date | null;
  progressPct: number;
  attendancePct: number;
}
interface CarriedOrganization {
  id: string;
  recordCode: string;
  kind: string;
  roles: string[];
  name: string;
  website: string | null;
  locations: unknown;
  tags: string[];
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
      where: {
        tenantId: holdingTenantId,
        deletedAt: null,
        migratedToTenantId: null,
        division: { in: [division, 'shared'] },
      },
      include: { account: true, category: true },
      orderBy: { txnDate: 'asc' },
    });
    const transactions: CarriedTransaction[] = [];
    for (const t of txnRows) {
      if (t.division === 'shared') {
        ledger.refuse(
          'transactions',
          t.recordCode,
          'Tagged to the shared division, so it cannot be attributed to one subsidiary. Split it before the spin-out.',
        );
        continue;
      }
      const linked = transactionLinkName(t);
      if (linked) {
        ledger.refuse(
          'transactions',
          t.recordCode,
          `Linked to ${linked}, which this script does not carry. Record the equivalent directly in the subsidiary instead.`,
        );
        continue;
      }
      ledger.carry('transactions', t.recordCode);
      transactions.push({
        id: t.id,
        recordCode: t.recordCode,
        accountName: t.account.name,
        categoryName: t.category?.name ?? null,
        txnDate: t.txnDate,
        direction: t.direction,
        amount: t.amount,
        currency: t.currency,
        division: t.division,
        counterparty: t.counterparty,
        method: t.method,
        reference: t.reference,
        note: t.note,
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
        ledger.refuse(
          'employmentRelationships',
          e.recordCode,
          'Holds more than one current assignment, in different divisions. Resolve which unit this person moves with before the spin-out.',
        );
        continue;
      }
      const div = [...divisions][0];
      if (div === 'shared') {
        ledger.refuse(
          'employmentRelationships',
          e.recordCode,
          'Assigned to a shared unit, not one division. Reassign before the spin-out if this person is moving.',
        );
        continue;
      }
      if (div !== division) continue; // a different division's employee — not in scope, not a refusal
      const person = await prisma.person.findFirst({ where: { id: e.personId } });
      if (!person?.primaryEmail && !person?.primaryPhone) {
        ledger.refuse(
          'employmentRelationships',
          e.recordCode,
          'No email or phone on file for this person, so they cannot be resolved in the new tenant.',
        );
        continue;
      }
      ledger.carry('employmentRelationships', e.recordCode);
      employmentRelationships.push({
        id: e.id,
        recordCode: e.recordCode,
        personId: e.personId,
        hireEffectiveDate: e.hireEffectiveDate,
        status: e.status,
        panNumber: e.panNumber,
        aadhaarReference: e.aadhaarReference,
        uanNumber: e.uanNumber,
      });
    }

    // ---- Courses, cohorts, enrolments -----------------------------------
    const courseRows = await prisma.course.findMany({ where: { tenantId: holdingTenantId, migratedToTenantId: null } });
    const courses: CarriedCourse[] = [];
    const carriedCourseIds = new Set<string>();
    for (const c of courseRows) {
      if (c.division === 'shared') {
        ledger.refuse(
          'courses',
          c.recordCode,
          'Tagged to the shared division, so it cannot be attributed to one subsidiary.',
        );
        continue;
      }
      if (c.division !== division) continue;
      ledger.carry('courses', c.recordCode);
      courses.push({
        id: c.id,
        recordCode: c.recordCode,
        name: c.name,
        code: c.code,
        description: c.description,
        durationWeeks: c.durationWeeks,
        feeAmountMinor: c.feeAmountMinor,
        gstRate: c.gstRate,
        hsnSac: c.hsnSac,
        division: c.division,
      });
      carriedCourseIds.add(c.id);
    }

    const cohortRows = carriedCourseIds.size
      ? await prisma.cohort.findMany({
          where: { tenantId: holdingTenantId, migratedToTenantId: null, courseId: { in: [...carriedCourseIds] } },
        })
      : [];
    const cohorts: CarriedCohort[] = [];
    const carriedCohortIds = new Set<string>();
    for (const co of cohortRows) {
      ledger.carry('cohorts', co.recordCode);
      cohorts.push({
        id: co.id,
        recordCode: co.recordCode,
        courseId: co.courseId,
        name: co.name,
        startDate: co.startDate,
        endDate: co.endDate,
        capacity: co.capacity,
        status: co.status,
      });
      carriedCohortIds.add(co.id);
    }

    const enrollmentRows = carriedCohortIds.size
      ? await prisma.enrollment.findMany({
          where: { tenantId: holdingTenantId, migratedToTenantId: null, cohortId: { in: [...carriedCohortIds] } },
        })
      : [];
    const enrollments: CarriedEnrollment[] = [];
    for (const en of enrollmentRows) {
      const person = await prisma.person.findFirst({ where: { id: en.personId } });
      if (!person?.primaryEmail && !person?.primaryPhone) {
        ledger.refuse(
          'enrollments',
          en.recordCode,
          'No email or phone on file for this learner, so they cannot be resolved in the new tenant.',
        );
        continue;
      }
      ledger.carry('enrollments', en.recordCode);
      enrollments.push({
        id: en.id,
        recordCode: en.recordCode,
        personId: en.personId,
        cohortId: en.cohortId,
        status: en.status,
        enrolledAt: en.enrolledAt,
        completedAt: en.completedAt,
        progressPct: en.progressPct,
        attendancePct: en.attendancePct,
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
          ledger.refuse(
            'organizations',
            org.recordCode,
            `Invoiced from more than one division (${[...divs].sort().join(', ')}); not attributable to a single subsidiary.`,
          );
        }
        continue;
      }
      const only = [...divs][0];
      if (only === 'shared') {
        const org = await prisma.organization.findFirst({ where: { id: orgId } });
        if (org && org.migratedToTenantId === null) {
          ledger.refuse(
            'organizations',
            org.recordCode,
            'Invoiced under the shared division; not attributable to a single subsidiary.',
          );
        }
        continue;
      }
      if (only !== division) continue;
      const org = await prisma.organization.findFirst({
        where: { id: orgId, deletedAt: null, migratedToTenantId: null },
      });
      if (!org) continue;
      ledger.carry('organizations', org.recordCode);
      organizations.push({
        id: org.id,
        recordCode: org.recordCode,
        kind: org.kind,
        roles: org.roles,
        name: org.name,
        website: org.website,
        locations: org.locations,
        tags: org.tags,
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

/** The opening class name when the caller gives none; the preflight checks the same name the commit writes. */
const DEFAULT_CLASS_NAME = 'Equity';

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
export async function previewSpinOut(
  holdingTenantId: string,
  division: Division,
  deep = true,
  className = DEFAULT_CLASS_NAME,
): Promise<SpinOutPreview> {
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
    const registerCount = await asSystem(
      subsidiaryTenant.id,
      // A reverted batch's share classes stay on the register, marked (FX-71). They
      // are not "a life of its own", so they must not block the next spin-out.
      async () => await prisma.shareClass.count({ where: { tenantId: subsidiaryTenant.id, spinOutRevertedAt: null } }),
    );
    if (registerCount > 0) {
      blockers.push(
        `"${subsidiaryTenant.slug}" already has ${registerCount} share class(es) on its register. A spin-out is only the first thing that happens to a subsidiary.`,
      );
    }
    // The name of a reverted class stays taken on the register (FX-71), so a redo that
    // repeats it would hit the ShareClass (tenantId, name) unique key inside the commit.
    // Refused here, before any write, so the caller sees a blocker rather than a raw Prisma error.
    const takenByRevert = await asSystem(
      subsidiaryTenant.id,
      async () =>
        await prisma.shareClass.findFirst({
          where: { tenantId: subsidiaryTenant.id, name: className, spinOutRevertedAt: { not: null } },
          select: { spinOutBatchId: true },
        }),
    );
    if (takenByRevert) {
      blockers.push(
        `The class name "${className}" is still on the statutory register from reverted batch ${takenByRevert.spinOutBatchId}, so choose a different className.`,
      );
    }
    const signatories = await asSystem(
      subsidiaryTenant.id,
      async () => (await companyProfile()).certificateSignatories as unknown[],
    );
    if (!Array.isArray(signatories) || signatories.length < 2) {
      blockers.push(
        `"${subsidiaryTenant.slug}" has fewer than two certificate signatories on its company profile. Set them before the opening allotment can issue certificates.`,
      );
    }
  }

  return {
    division,
    holding: { tenantId: holding.id, slug: holding.slug },
    subsidiary: subsidiaryTenant
      ? { tenantId: subsidiaryTenant.id, slug: subsidiaryTenant.slug, name: subsidiaryTenant.name }
      : null,
    ready: blockers.length === 0,
    blockers,
    carried: candidates.ledger.carried,
    refused: candidates.ledger.refused,
    openingAllotment: {
      note: "Cash never moves by data migration — the subsidiary's ledger accounts open at zero, with a note that the balance is to be set from the transfer of funds.",
    },
  };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface SpinOutHolderInput {
  name: string;
  count: number;
  email?: string;
  phone?: string;
}

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
  const preview = await previewSpinOut(input.holdingTenantId, input.division, true, input.className);
  if (!preview.ready || !preview.subsidiary) {
    throw new Error(`Cannot commit — ${preview.blockers.join(' ')}`);
  }
  const subsidiaryTenantId = preview.subsidiary.tenantId;
  const candidates = await collectCandidates(input.holdingTenantId, input.division);
  const batchId = `SPINOUT-${ulid()}`;

  const carried: Record<string, number> = {};
  const bump = (k: string) => {
    carried[k] = (carried[k] ?? 0) + 1;
  };

  // ---- Ledger accounts and categories, copied by name at zero -----------
  // Source names are already on each carried transaction candidate — no
  // second read of the holding tenant is needed to know what to copy.
  const accountNames = new Set(candidates.transactions.map((t) => t.accountName));
  const categoryNames = new Set(
    candidates.transactions.map((t) => t.categoryName).filter((n): n is string => Boolean(n)),
  );

  const sourceAccountsByName = await asSystem(input.holdingTenantId, async () => {
    const out = new Map<string, { accountType: string; ledgerGroup: string; currency: string }>();
    for (const name of accountNames) {
      const a = await prisma.ledgerAccount.findFirst({ where: { tenantId: input.holdingTenantId, name } });
      if (a) out.set(name, { accountType: a.accountType, ledgerGroup: a.ledgerGroup, currency: a.currency });
    }
    return out;
  });
  const sourceCategoriesByName = await asSystem(input.holdingTenantId, async () => {
    const out = new Map<
      string,
      { kind: string; behaviour: string; defaultDivision: string | null; mustPay: boolean }
    >();
    for (const name of categoryNames) {
      const c = await prisma.ledgerCategory.findFirst({ where: { tenantId: input.holdingTenantId, name } });
      if (c)
        out.set(name, { kind: c.kind, behaviour: c.behaviour, defaultDivision: c.defaultDivision, mustPay: c.mustPay });
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
      const categoryId = t.categoryName ? (categoryIdByName.get(t.categoryName) ?? null) : null;
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
          feeAmountMinor: c.feeAmountMinor,
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
      const sourcePerson = await asSystem(
        input.holdingTenantId,
        async () => await prisma.person.findFirstOrThrow({ where: { id: en.personId } }),
      );
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
      const sourcePerson = await asSystem(
        input.holdingTenantId,
        async () => await prisma.person.findFirstOrThrow({ where: { id: e.personId } }),
      );
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
    if (candidates.transactions.length)
      await prisma.transaction.updateMany({
        where: { id: { in: candidates.transactions.map((r) => r.id) } },
        data: { migratedToTenantId: subsidiaryTenantId },
      });
    if (candidates.employmentRelationships.length)
      await prisma.employmentRelationship.updateMany({
        where: { id: { in: candidates.employmentRelationships.map((r) => r.id) } },
        data: { migratedToTenantId: subsidiaryTenantId },
      });
    if (candidates.courses.length)
      await prisma.course.updateMany({
        where: { id: { in: candidates.courses.map((r) => r.id) } },
        data: { migratedToTenantId: subsidiaryTenantId },
      });
    if (candidates.cohorts.length)
      await prisma.cohort.updateMany({
        where: { id: { in: candidates.cohorts.map((r) => r.id) } },
        data: { migratedToTenantId: subsidiaryTenantId },
      });
    if (candidates.enrollments.length)
      await prisma.enrollment.updateMany({
        where: { id: { in: candidates.enrollments.map((r) => r.id) } },
        data: { migratedToTenantId: subsidiaryTenantId },
      });
    if (candidates.organizations.length)
      await prisma.organization.updateMany({
        where: { id: { in: candidates.organizations.map((r) => r.id) } },
        data: { migratedToTenantId: subsidiaryTenantId },
      });
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
      name: input.className ?? DEFAULT_CLASS_NAME,
      kind: 'equity',
      instrument: 'equity',
      faceValue: input.faceValue ?? 10,
    });

    const entries: Array<{ holderId: string; count: number }> = [];
    if (input.kiplStake && input.kiplStake > 0) {
      const holder = await createHolder({
        kind: 'entity',
        heldByTenantId: input.holdingTenantId,
        residency: 'resident',
      });
      entries.push({ holderId: holder.id, count: input.kiplStake });
    }
    for (const other of input.otherHolders ?? []) {
      if (!other.email && !other.phone) {
        throw new Error(
          `"${other.name}" needs an email or a phone number to be resolved as a person in the new tenant — pass --other-holder "${other.name}|<email>=${other.count}".`,
        );
      }
      const holder = await createHolder({
        kind: 'person',
        person: { fullName: other.name, email: other.email, phone: other.phone },
        residency: 'resident',
      });
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
      await prisma.shareCertificate.updateMany({
        where: { issuedForTransactionId: txn.id },
        data: { spinOutBatchId: batchId },
      });
      await prisma.holder.update({ where: { id: entry.holderId }, data: { spinOutBatchId: batchId } });
      holdingHolders.push(entry);
    }
    await prisma.shareClass.update({ where: { id: shareClass.id }, data: { spinOutBatchId: batchId } });
    openingShareClassId = shareClass.id;

    await unscopedPrisma.tenant.update({
      where: { id: subsidiaryTenantId },
      data: {
        config: {
          ...(((await unscopedPrisma.tenant.findFirstOrThrow({ where: { id: subsidiaryTenantId } }))
            .config as object) ?? {}),
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
  /** Rows reversed, cancelled or marked in the subsidiary, by model. None was deleted (FX-71). */
  removed: Record<string, number>;
  /** Holding rows whose `migratedToTenantId` pointer to the subsidiary was cleared. */
  clearedOnHolding: number;
  /**
   * True when an earlier call had already reversed the subsidiary and this call
   * only finished the holding side, which that earlier call did not get to.
   */
  resumed: boolean;
}

// Written only by the revert, so it is registered beside the code that writes it.
registerGovernedEntities('eqt', ['spin_out_tombstone']);

/**
 * The released form of a tenant-unique key a reverted row no longer holds (FX-71b).
 * A redo of the division copies the original value from the holding again, so the
 * reverted row must stop holding it. Deterministic per batch, and idempotent: a
 * value already released for this batch comes back unchanged, so a retried revert
 * cannot suffix it twice.
 */
function releasedKey(value: string, batchId: string): string {
  const suffix = `~reverted~${batchId}`;
  return value.endsWith(suffix) ? value : `${value}${suffix}`;
}

/** One key released by a revert: the row, the field, and the value it held before. */
interface ReleasedKey {
  model: string;
  id: string;
  field: 'code' | 'name';
  from: string;
  to: string;
}

/**
 * Reverses a spin-out batch in the subsidiary and clears the holding's pointers
 * to it. Nothing is deleted. Safe to call again after a failure.
 *
 * The revert used to hard-delete everything the batch had created. That was a
 * lost audit trail in the accounting path: no audit row and no event for any of
 * it, and a booked transaction that vanished from the books rather than being
 * reversed by a second row, so the books could no longer say what had happened.
 * Now each row the batch created stays and says what became of it:
 *
 * - a transaction is reversed by a second transaction, dated now (so it lands in
 *   today's IST period, refused if that period is closed), and the original
 *   points at the reversal through `reversedById`;
 * - a share certificate is cancelled, and a share transaction is marked
 *   `reversed`; the register counts only `effective` rows, so both leave the
 *   holding without leaving the record;
 * - every other batch row is marked with `spinOutRevertedAt`;
 * - a ledger account or category the batch opened is soft-deleted, which the
 *   books already read as absent;
 * - one tombstone names who asked, when and why.
 *
 * The subsidiary side and the holding side are two transactions, because one
 * transaction carries one tenant's scope (db.ts set_config). The subsidiary side
 * commits first and writes the tombstone. If the holding side then fails, the
 * tombstone says the subsidiary is done, and the pointers still name it. A later
 * call sees the tombstone, skips the subsidiary side, and finishes the holding
 * side: no reversal is written twice. A call that finds the tombstone and no
 * pointers left has nothing to do, and is refused with a 409.
 */
export async function revertSpinOut(input: {
  holdingTenantId: string;
  subsidiaryTenantId: string;
  batchId: string;
  /** Who asked for the revert, as an operator label. Kept on the tombstone. */
  revertedBy: string;
  /** Why. Kept on the tombstone and on every audit row the revert writes. */
  reason: string;
  /**
   * Test seam: runs after the subsidiary transaction commits and before the
   * holding transaction starts. A throw here is the interrupted revert that the
   * resume path exists for (FX-71b). Not used by the CLI.
   */
  afterSubsidiaryCommit?: () => Promise<void>;
}): Promise<SpinOutRevertResult> {
  const { holdingTenantId, subsidiaryTenantId, batchId } = input;
  const revertedBy = input.revertedBy.trim();
  const reason = input.reason.trim();
  if (!revertedBy || !reason) {
    throw ApiError.unprocessable('A spin-out revert names who asked for it and why. Both are kept on its tombstone.');
  }

  const now = new Date();
  const removed: Record<string, number> = {};
  // Filled inside the subsidiary transaction and read only after it commits, so the
  // tombstone describes rows that were actually released.
  const releasedKeys: ReleasedKey[] = [];
  const bump = (k: string, n: number) => {
    if (n) removed[k] = (removed[k] ?? 0) + n;
  };

  // A tombstone already present means the subsidiary side is done. Read outside
  // the transaction; the subsidiary transaction re-checks under the row lock.
  // `await` inside the callback: a Prisma query is lazy, so one returned unawaited
  // would run after asSystem has left the tenant context and be refused.
  const priorTombstone = await asSystem(
    subsidiaryTenantId,
    async () => await prisma.spinOutTombstone.findFirst({ where: { tenantId: subsidiaryTenantId, batchId } }),
  );
  let resumed = priorTombstone !== null;

  if (!resumed) {
    // The period hook reads through the scoped client, which refuses to run inside
    // a transaction (db.ts refuseOuterClientInTransaction), so it runs first, as
    // reverseTransaction does (books.ts:420). A closed current month refuses the
    // revert here, before any row is touched.
    await asSystem(subsidiaryTenantId, async () => {
      await assertCan({ resource: 'share_ledger', verb: 'approve' });
      await assertScopeAll('transactions', 'edit');
      await runHooks('transaction.before_record', { txnDate: now, source: 'reversal' });
    });

    resumed = await asSystem(subsidiaryTenantId, () =>
      governedWrite(async (tx) => {
        const auth = currentAuth();

        // The row lock comes first. Two reverts of one batch both pass the
        // pre-read above, and the lock makes the second wait; the tombstone check
        // that follows then sees the first revert's tombstone (each statement under
        // READ COMMITTED sees what committed before it started).
        await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${subsidiaryTenantId} FOR UPDATE`;

        const prior = await tx.spinOutTombstone.findFirst({
          where: { tenantId: subsidiaryTenantId, batchId },
        });
        if (prior) return true;

        // A revert is only safe while the subsidiary has done nothing else. Keep the
        // guard: a row outside the batch means the subsidiary has a life of its own.
        // `not: batchId` alone would miss a row with no `spinOutBatchId` at all,
        // because Postgres never matches NULL against `<>`.
        const otherTxns = await tx.transaction.count({
          where: {
            tenantId: subsidiaryTenantId,
            OR: [{ spinOutBatchId: { not: batchId } }, { spinOutBatchId: null }],
          },
        });
        const otherShares = await tx.shareTransaction.count({
          where: {
            tenantId: subsidiaryTenantId,
            OR: [{ spinOutBatchId: { not: batchId } }, { spinOutBatchId: null }],
          },
        });
        if (otherTxns > 0 || otherShares > 0) {
          throw new Error(
            `"${subsidiaryTenantId}" has transactions or register rows this batch did not create — the spin-out cannot be reverted once the subsidiary has a life of its own.`,
          );
        }

        // Transactions. The original stays; the reversal is the opposite entry and
        // carries the batch, so the batch's rows still read as the batch's.
        const originals = await tx.transaction.findMany({
          where: { tenantId: subsidiaryTenantId, spinOutBatchId: batchId, reversalOfId: null, reversedById: null },
          orderBy: { recordCode: 'asc' },
        });
        for (const original of originals) {
          const recordCode = await nextRecordCode('TXN', now, tx);
          const reversal = await tx.transaction.create({
            data: {
              tenantId: subsidiaryTenantId,
              recordCode,
              txnDate: now,
              direction: original.direction === 'in' ? 'out' : 'in',
              // The stored decimal is copied, not computed on, so no money arithmetic happens here.
              amount: original.amount,
              accountId: original.accountId,
              categoryId: original.categoryId,
              division: original.division,
              counterparty: original.counterparty,
              method: original.method,
              reference: original.reference,
              note: `Reversal of ${original.recordCode}: spin-out ${batchId} reverted. ${reason}`,
              source: original.source,
              reversalOfId: original.id,
              spinOutBatchId: batchId,
              createdById: auth.partyId,
            },
          });
          await tx.transaction.update({ where: { id: original.id }, data: { reversedById: reversal.id } });
          await auditWrite({
            action: 'update',
            subjectType: 'transaction',
            subjectId: original.id,
            before: { reversedById: null },
            after: { reversedById: reversal.id, reason },
            tx,
          });
          await auditWrite({
            action: 'create',
            subjectType: 'transaction',
            subjectId: reversal.id,
            after: { recordCode, reversalOfId: original.id, direction: reversal.direction, reason },
            tx,
          });
          await emit({
            name: EVENTS.TRANSACTION_REVERSED,
            subject: { entityType: 'transaction', entityId: reversal.id, recordCode },
            related: [{ relation: 'reverses', entityType: 'transaction', entityId: original.id }],
            previousState: { recordCode: original.recordCode },
            newState: { direction: reversal.direction },
            reason: { reasonCode: 'reversal', note: reason },
            confidentiality: 'confidential',
            impact: { domains: ['fin'], severity: 'S1_ATTENTION' },
            tx,
          });
        }
        bump('transactions', originals.length);

        // Share certificates are cancelled, as the register cancels a certificate
        // elsewhere (equity.ts reversal path). The row stays.
        const certs = await tx.shareCertificate.findMany({
          where: { tenantId: subsidiaryTenantId, spinOutBatchId: batchId, spinOutRevertedAt: null },
        });
        for (const cert of certs) {
          await tx.shareCertificate.update({
            where: { id: cert.id },
            data: { status: 'cancelled', spinOutRevertedAt: now },
          });
          await auditWrite({
            action: 'update',
            subjectType: 'share_certificate',
            subjectId: cert.id,
            before: { status: cert.status, spinOutRevertedAt: null },
            after: { status: 'cancelled', spinOutRevertedAt: now.toISOString(), reason },
            tx,
          });
          await emit({
            name: EVENTS.CERTIFICATE_CANCELLED,
            subject: { entityType: 'share_certificate', entityId: cert.id, recordCode: cert.recordCode },
            newState: { status: 'cancelled', reason },
            tx,
          });
        }
        bump('shareCertificates', certs.length);

        // Share transactions are marked `reversed`, which the register already uses
        // for a reversed allotment (equity.ts reversal path). Only `effective` rows
        // count towards a holding, so the holding returns to what it was before.
        const shares = await tx.shareTransaction.findMany({
          where: { tenantId: subsidiaryTenantId, spinOutBatchId: batchId, spinOutRevertedAt: null },
        });
        for (const share of shares) {
          await tx.shareTransaction.update({
            where: { id: share.id },
            data: { status: 'reversed', spinOutRevertedAt: now },
          });
          await auditWrite({
            action: 'update',
            subjectType: 'share_transaction',
            subjectId: share.id,
            before: { status: share.status, spinOutRevertedAt: null },
            after: { status: 'reversed', spinOutRevertedAt: now.toISOString(), reason },
            tx,
          });
          await emit({
            name: EVENTS.SHARE_TRANSACTION_REVERSED,
            subject: { entityType: 'share_transaction', entityId: share.id, recordCode: share.recordCode },
            newState: { status: 'reversed', reason },
            tx,
          });
        }
        bump('shareTransactions', shares.length);

        // The rest of the batch's rows are marked, not removed. Each mark is audited;
        // the batch-level event below covers their counts.
        const markRows = async (subjectType: string, ids: string[]) => {
          for (const id of ids) {
            await auditWrite({
              action: 'update',
              subjectType,
              subjectId: id,
              before: { spinOutRevertedAt: null },
              after: { spinOutRevertedAt: now.toISOString(), reason },
              tx,
            });
          }
        };

        const holders = await tx.holder.findMany({
          where: { tenantId: subsidiaryTenantId, spinOutBatchId: batchId, spinOutRevertedAt: null },
        });
        for (const row of holders) await tx.holder.update({ where: { id: row.id }, data: { spinOutRevertedAt: now } });
        await markRows(
          'holder',
          holders.map((r) => r.id),
        );
        bump('holders', holders.length);

        const classes = await tx.shareClass.findMany({
          where: { tenantId: subsidiaryTenantId, spinOutBatchId: batchId, spinOutRevertedAt: null },
        });
        for (const row of classes)
          await tx.shareClass.update({ where: { id: row.id }, data: { spinOutRevertedAt: now } });
        await markRows(
          'share_class',
          classes.map((r) => r.id),
        );
        bump('shareClasses', classes.length);

        const enrollments = await tx.enrollment.findMany({
          where: { tenantId: subsidiaryTenantId, spinOutBatchId: batchId, spinOutRevertedAt: null },
        });
        for (const row of enrollments)
          await tx.enrollment.update({ where: { id: row.id }, data: { spinOutRevertedAt: now } });
        await markRows(
          'enrollment',
          enrollments.map((r) => r.id),
        );
        bump('enrollments', enrollments.length);

        const cohorts = await tx.cohort.findMany({
          where: { tenantId: subsidiaryTenantId, spinOutBatchId: batchId, spinOutRevertedAt: null },
        });
        for (const row of cohorts) await tx.cohort.update({ where: { id: row.id }, data: { spinOutRevertedAt: now } });
        await markRows(
          'cohort',
          cohorts.map((r) => r.id),
        );
        bump('cohorts', cohorts.length);

        // A course's code is unique on the tenant, and a redo of the division copies
        // it again from the holding. The reverted row releases it (FX-71b).
        const courses = await tx.course.findMany({
          where: { tenantId: subsidiaryTenantId, spinOutBatchId: batchId, spinOutRevertedAt: null },
        });
        for (const row of courses) {
          const to = releasedKey(row.code, batchId);
          await tx.course.update({ where: { id: row.id }, data: { code: to, spinOutRevertedAt: now } });
          await auditWrite({
            action: 'update',
            subjectType: 'course',
            subjectId: row.id,
            before: { code: row.code, spinOutRevertedAt: null },
            after: { code: to, spinOutRevertedAt: now.toISOString(), reason },
            tx,
          });
          releasedKeys.push({ model: 'course', id: row.id, field: 'code', from: row.code, to });
        }
        bump('courses', courses.length);

        const orgs = await tx.organization.findMany({
          where: { tenantId: subsidiaryTenantId, spinOutBatchId: batchId, spinOutRevertedAt: null },
        });
        for (const row of orgs)
          await tx.organization.update({ where: { id: row.id }, data: { spinOutRevertedAt: now } });
        await markRows(
          'organization',
          orgs.map((r) => r.id),
        );
        bump('organizations', orgs.length);

        const emps = await tx.employmentRelationship.findMany({
          where: { tenantId: subsidiaryTenantId, spinOutBatchId: batchId, spinOutRevertedAt: null },
        });
        for (const row of emps)
          await tx.employmentRelationship.update({ where: { id: row.id }, data: { spinOutRevertedAt: now } });
        await markRows(
          'employment_relationship',
          emps.map((r) => r.id),
        );
        bump('employmentRelationships', emps.length);

        // Accounts and categories the batch opened are soft-deleted, and their names
        // released: the books read a `deletedAt` row as absent, the reversals still
        // point at it, and a redo copies the names again (FX-71b).
        const accounts = await tx.ledgerAccount.findMany({
          where: { tenantId: subsidiaryTenantId, spinOutBatchId: batchId, deletedAt: null },
        });
        for (const account of accounts) {
          const to = releasedKey(account.name, batchId);
          await tx.ledgerAccount.update({ where: { id: account.id }, data: { name: to, deletedAt: now } });
          await auditWrite({
            action: 'delete',
            subjectType: 'ledger_account',
            subjectId: account.id,
            before: { name: account.name, deletedAt: null },
            after: { name: to, deletedAt: now.toISOString(), reason },
            tx,
          });
          releasedKeys.push({ model: 'ledger_account', id: account.id, field: 'name', from: account.name, to });
        }
        bump('ledgerAccounts', accounts.length);

        const categories = await tx.ledgerCategory.findMany({
          where: { tenantId: subsidiaryTenantId, spinOutBatchId: batchId, deletedAt: null },
        });
        for (const category of categories) {
          const to = releasedKey(category.name, batchId);
          await tx.ledgerCategory.update({ where: { id: category.id }, data: { name: to, deletedAt: now } });
          await auditWrite({
            action: 'delete',
            subjectType: 'ledger_category',
            subjectId: category.id,
            before: { name: category.name, deletedAt: null },
            after: { name: to, deletedAt: now.toISOString(), reason },
            tx,
          });
          releasedKeys.push({ model: 'ledger_category', id: category.id, field: 'name', from: category.name, to });
        }
        bump('ledgerCategories', categories.length);

        // The batch's marker on the tenant. The tenant row is not governed; the
        // tombstone records that the config was cleared, by its existence.
        const tenant = await tx.tenant.findFirstOrThrow({ where: { id: subsidiaryTenantId } });
        const config = { ...((tenant.config as Record<string, unknown>) ?? {}) };
        delete config.spinOut;
        await tx.tenant.update({ where: { id: subsidiaryTenantId }, data: { config: config as never } });

        const tombstone = await tx.spinOutTombstone.create({
          data: {
            tenantId: subsidiaryTenantId,
            batchId,
            holdingTenantId,
            revertedById: auth.partyId,
            revertedBy,
            reason,
            // The original values of every released key, so the tombstone can say what
            // a redo would have had to take (FX-71b).
            removed: { ...removed, releasedKeys } as never,
          },
        });
        await auditWrite({
          action: 'create',
          subjectType: 'spin_out_tombstone',
          subjectId: tombstone.id,
          after: { batchId, holdingTenantId, revertedBy, reason, removed },
          tx,
        });

        await emit({
          name: EVENTS.TENANT_SPIN_OUT_REVERTED,
          subject: { entityType: 'tenant', entityId: subsidiaryTenantId },
          newState: { batchId, removed, reason },
          impact: { domains: ['sys'] },
          tx,
        });
        return false;
      }),
    );
  }

  if (!resumed && input.afterSubsidiaryCommit) await input.afterSubsidiaryCommit();

  // The holding side. It locks the holding tenant row and reads its pointers only
  // after that lock, so a call that waited on another behind it sees what the other
  // cleared. A resumed call that finds no pointers is a call for a revert that is
  // already complete, and is refused.
  const clearedOnHolding = await asSystem(holdingTenantId, () =>
    governedWrite(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${holdingTenantId} FOR UPDATE`;

      const pointed = {
        transaction: await tx.transaction.findMany({
          where: { tenantId: holdingTenantId, migratedToTenantId: subsidiaryTenantId },
          select: { id: true },
        }),
        employmentRelationship: await tx.employmentRelationship.findMany({
          where: { tenantId: holdingTenantId, migratedToTenantId: subsidiaryTenantId },
          select: { id: true },
        }),
        course: await tx.course.findMany({
          where: { tenantId: holdingTenantId, migratedToTenantId: subsidiaryTenantId },
          select: { id: true },
        }),
        cohort: await tx.cohort.findMany({
          where: { tenantId: holdingTenantId, migratedToTenantId: subsidiaryTenantId },
          select: { id: true },
        }),
        enrollment: await tx.enrollment.findMany({
          where: { tenantId: holdingTenantId, migratedToTenantId: subsidiaryTenantId },
          select: { id: true },
        }),
        organization: await tx.organization.findMany({
          where: { tenantId: holdingTenantId, migratedToTenantId: subsidiaryTenantId },
          select: { id: true },
        }),
      };
      const pointerTotal = Object.values(pointed).reduce((n, rows) => n + rows.length, 0);
      if (resumed && pointerTotal === 0) {
        throw ApiError.conflict(`Spin-out batch ${batchId} has already been reverted.`, {
          subsidiaryTenantId,
          resumed: true,
        });
      }

      let cleared = 0;
      const clear = async (subjectType: string, id: string) => {
        await auditWrite({
          action: 'update',
          subjectType,
          subjectId: id,
          before: { migratedToTenantId: subsidiaryTenantId },
          after: { migratedToTenantId: null, batchId, reason },
          tx,
        });
        cleared += 1;
      };
      for (const row of pointed.transaction) {
        await tx.transaction.update({ where: { id: row.id }, data: { migratedToTenantId: null } });
        await clear('transaction', row.id);
      }
      for (const row of pointed.employmentRelationship) {
        await tx.employmentRelationship.update({ where: { id: row.id }, data: { migratedToTenantId: null } });
        await clear('employment_relationship', row.id);
      }
      for (const row of pointed.course) {
        await tx.course.update({ where: { id: row.id }, data: { migratedToTenantId: null } });
        await clear('course', row.id);
      }
      for (const row of pointed.cohort) {
        await tx.cohort.update({ where: { id: row.id }, data: { migratedToTenantId: null } });
        await clear('cohort', row.id);
      }
      for (const row of pointed.enrollment) {
        await tx.enrollment.update({ where: { id: row.id }, data: { migratedToTenantId: null } });
        await clear('enrollment', row.id);
      }
      for (const row of pointed.organization) {
        await tx.organization.update({ where: { id: row.id }, data: { migratedToTenantId: null } });
        await clear('organization', row.id);
      }

      await emit({
        name: EVENTS.TENANT_SPIN_OUT_REVERTED,
        subject: { entityType: 'tenant', entityId: holdingTenantId },
        newState: { batchId, subsidiaryTenantId, clearedOnHolding: cleared, resumed },
        impact: { domains: ['sys'] },
        tx,
      });
      return cleared;
    }),
  );

  return { removed, clearedOnHolding, resumed };
}

export { MODEL_LABEL };
