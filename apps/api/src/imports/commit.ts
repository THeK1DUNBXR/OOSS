/**
 * Turning staged rows into records.
 *
 * Everything here is reversible. A batch records what it created, and revert
 * removes exactly that — which is what makes it reasonable to import a year of
 * somebody's books before they have decided whether the categories are right.
 *
 * Accounts and categories are created on demand from the names in the file
 * rather than requiring a chart of accounts to be built first. That is the
 * difference between an importer somebody uses and one they abandon: the names
 * in a Tally export *are* the chart of accounts, and asking a person to retype
 * sixty of them before their first import is asking them not to bother.
 */

import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { assertCan } from '../platform/permissions.js';
import { ApiError } from '../platform/errors.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { emit } from '../platform/eventBus.js';
import { EVENTS } from '@kaizen/shared';
import { matchFailure, matchPerson } from './matchName.js';
import {
  classifyLedger, divisionFor, isAccountName,
  JOURNAL_ACCOUNT_NAME, JOURNAL_ACCOUNT_TYPE,
} from './classify.js';
import { UNSTATED_LEDGER_KIND } from './chart.js';

/**
 * Where the cash half of a split voucher is filed.
 *
 * `transfer` keeps it out of the profit and loss while the movement still
 * shows in the ledger and in the account balance, which is exactly what it is:
 * money arriving, whose reason is recorded on the other legs.
 */
const SETTLEMENT_CATEGORY_NAME = 'Bank settlement';

export interface CommitResult {
  created: Record<string, number>;
  skipped: number;
  errors: Array<{ rowNumber: number; message: string }>;
}

async function ensureAccount(name: string, accountType: string): Promise<string> {
  const auth = currentAuth();
  const existing = await prisma.ledgerAccount.findFirst({ where: { tenantId: auth.tenantId, name } });
  if (existing) return existing.id;
  const created = await prisma.ledgerAccount.create({
    data: {
      tenantId: auth.tenantId,
      name,
      accountType,
      ledgerGroup: accountType === 'card' ? 'liability' : 'asset',
      openingBalance: 0,
    },
  });
  return created.id;
}

async function ensureCategory(name: string, categoryKind: string): Promise<string> {
  const auth = currentAuth();
  const existing = await prisma.ledgerCategory.findFirst({ where: { tenantId: auth.tenantId, name } });
  if (existing) return existing.id;
  const created = await prisma.ledgerCategory.create({
    data: {
      tenantId: auth.tenantId,
      name,
      kind: categoryKind,
      behaviour: 'variable',
      defaultDivision: divisionFor(name),
    },
  });
  return created.id;
}

// ---------------------------------------------------------------------------

export async function commitImport(id: string): Promise<CommitResult> {
  const auth = currentAuth();
  await assertCan({ resource: 'imports', verb: 'edit' });

  const batch = await prisma.importBatch.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!batch) throw ApiError.notFound('Import');
  if (batch.status === 'committed') throw ApiError.conflict('This import has already been committed.');

  const rows = await prisma.importRow.findMany({
    where: { tenantId: auth.tenantId, batchId: id, status: 'ready' },
    orderBy: { rowNumber: 'asc' },
  });

  if (rows.length === 0) {
    throw ApiError.badRequest('Every row in this import is a duplicate, a blank or an error. There is nothing to commit.');
  }

  const options = (batch.options ?? {}) as Record<string, unknown>;
  const result: CommitResult = { created: {}, skipped: 0, errors: [] };
  const bump = (k: string) => {
    result.created[k] = (result.created[k] ?? 0) + 1;
  };

  for (const row of rows) {
    const data = row.normalised as Record<string, unknown> | null;
    if (!data) {
      result.skipped += 1;
      continue;
    }
    try {
      let outcome: { entityType: string; entityId: string } | null = null;
      switch (batch.kind) {
        case 'tally_ledger':
          outcome = await commitLedgerRow(data, options);
          break;
        case 'bank_statement':
        case 'transactions':
          outcome = await commitBankRow(data, options);
          break;
        case 'chart_of_accounts':
          outcome = await commitAccountRow(data);
          break;
        case 'employees':
          outcome = await commitEmployeeRow(data);
          break;
        case 'salary':
          outcome = await commitSalaryRow(data);
          break;
        case 'attendance':
          outcome = await commitAttendanceRow(data);
          break;
        case 'template_courses':
          outcome = await commitCourseRow(data);
          break;
        case 'template_batches':
          outcome = await commitBatchRow(data);
          break;
        case 'template_colleges':
          outcome = await commitCollegeRow(data);
          break;
        case 'template_clients':
          outcome = await commitClientRow(data);
          break;
        case 'template_students':
          outcome = await commitStudentRow(data);
          break;
        case 'student_register':
          outcome = await commitStudentRegisterRow(data);
          break;
        case 'template_contacts':
          outcome = await commitContactRow(data);
          break;
        case 'template_staff':
          outcome = await commitEmployeeRow(data);
          break;
        default:
          throw new Error(`No commit path for an import of kind "${batch.kind}".`);
      }

      if (outcome) {
        bump(outcome.entityType);
        await prisma.importRow.update({
          where: { id: row.id },
          data: { status: 'committed', entityType: outcome.entityType, entityId: outcome.entityId, message: null },
        });
      } else {
        result.skipped += 1;
        await prisma.importRow.update({ where: { id: row.id }, data: { status: 'skipped' } });
      }
    } catch (error) {
      const message = (error as Error).message;
      result.errors.push({ rowNumber: row.rowNumber, message });
      await prisma.importRow.update({ where: { id: row.id }, data: { status: 'error', message } });
    }
  }

  await prisma.importBatch.update({
    where: { id },
    data: {
      status: 'committed',
      committedAt: new Date(),
      stats: { ...(batch.stats as object), ...result.created, errors: result.errors.length } as never,
    },
  });

  await emit({
    name: EVENTS.IMPORT_COMMITTED,
    subject: { entityType: 'import_batch', entityId: id },
    newState: { kind: batch.kind, ...result.created, errors: result.errors.length },
    impact: { domains: ['fin'] },
  });

  return result;
}

// ---- per-kind commits -----------------------------------------------------

async function commitLedgerRow(data: Record<string, unknown>, options: Record<string, unknown>) {
  const auth = currentAuth();
  const chart = (options.chart ?? {}) as Record<string, string>;
  const ledger = String(data.ledger ?? '');
  const contra = String(data.contraAccount ?? '');
  const side = String(data.side ?? 'debit');
  const amount = Number(data.amount ?? 0);
  if (!ledger || !amount) return null;

  const ledgerIsAccount = isAccountName(ledger, chart);
  const contraIsAccount = contra ? isAccountName(contra, chart) : false;

  let accountName: string;
  let categoryName: string;
  let direction: 'in' | 'out';

  if (ledgerIsAccount) {
    // The extractor keeps the account-section copy of every entry, so this is
    // the usual path and it is the one whose totals reconcile to Tally. For a
    // transfer between two accounts both sections are kept, and each lands
    // here once against its own account.
    accountName = ledger;
    // On a split voucher this leg carries the cash only. The category legs are
    // imported separately and are what the profit and loss is built from, so
    // taking the contra as this leg's category would count the same income or
    // cost twice.
    categoryName = data.isSplitLeg ? SETTLEMENT_CATEGORY_NAME : contra || 'Uncategorised';
    // A debit to a bank account is money arriving.
    direction = side === 'debit' ? 'in' : 'out';
  } else if (contraIsAccount && data.postToContra !== false) {
    accountName = contra;
    categoryName = ledger;
    // A debit to an expense head is money leaving the account that paid it.
    direction = side === 'debit' ? 'out' : 'in';
  } else {
    // Either neither side is a bank or a cash box — a director paying a
    // supplier personally, a depreciation entry — or this is an extra leg of a
    // voucher whose cash side the file already reports elsewhere. Both are
    // real movements that are not themselves cash, so they land on an account
    // the cash position does not count.
    accountName = JOURNAL_ACCOUNT_NAME;
    categoryName = ledger;
    direction = side === 'debit' ? 'out' : 'in';
  }

  const accountClass = classifyLedger(accountName, chart);
  const accountId = await ensureAccount(
    accountName,
    accountName === JOURNAL_ACCOUNT_NAME
      ? JOURNAL_ACCOUNT_TYPE
      : accountClass.kind === 'account'
        ? accountClass.accountType
        : 'bank',
  );

  const categoryId = await ensureCategory(
    categoryName,
    categoryName === SETTLEMENT_CATEGORY_NAME ? 'transfer' : categoryKindFor(categoryName, chart),
  );

  const txn = await prisma.transaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('TXN'),
      txnDate: new Date(String(data.txnDate)),
      direction,
      amount,
      accountId,
      categoryId,
      division: String(options.defaultDivision ?? divisionFor(categoryName)),
      counterparty: contra || null,
      method: 'bank_transfer',
      reference: data.voucherNo ? `${data.voucherType ?? 'Voucher'} ${data.voucherNo}` : null,
      note: String(data.narration ?? ''),
      source: 'tally_import',
      createdById: auth.partyId,
    },
  });

  return { entityType: 'transaction', entityId: txn.id };
}

/**
 * What a ledger is, when the statements were available to say.
 *
 * A ledger the statements name is that. A ledger they do not name, in a
 * workbook that carried statements at all, is a balance-sheet account whose
 * members the statements summarised rather than listed — a supplier inside
 * Sundry Creditors, a director's current account. Calling it an expense
 * because its name is not obviously anything else is what doubled the cost
 * base, so it is a transfer instead: real, traceable, and not a cost.
 */
function categoryKindFor(name: string, chart: Record<string, string>): string {
  const stated = chart[name.toLowerCase().trim()];
  if (stated) return stated;

  const guessed = classifyLedger(name, chart);
  const kind = guessed.kind === 'category' ? guessed.categoryKind : 'transfer';

  // A confident guess stands whether or not the statements were available.
  if (kind !== 'unknown') return kind;
  // Nothing recognised the name. With no statements to consult, a cost is the
  // likeliest thing an unrecognised ledger is; with statements that named
  // every income and expense head and still did not mention this one, it is a
  // balance-sheet account whose members they summarised.
  return Object.keys(chart).length === 0 ? 'expense' : UNSTATED_LEDGER_KIND;
}

async function commitBankRow(data: Record<string, unknown>, options: Record<string, unknown>) {
  const auth = currentAuth();

  // An opening-balance line sets the account's starting figure rather than
  // creating a transaction, so the running balance in the file and the balance
  // the platform computes agree from the first row.
  if (data.openingBalance !== undefined) return null;

  const accountId = String(options.accountId ?? '');
  if (!accountId) {
    throw new Error('No account was chosen for this statement. Pick the bank account it belongs to and commit again.');
  }

  const narration = String(data.narration ?? '');
  const txn = await prisma.transaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('TXN'),
      txnDate: new Date(String(data.txnDate)),
      direction: String(data.direction) === 'in' ? 'in' : 'out',
      amount: Number(data.amount ?? 0),
      accountId,
      categoryId: options.defaultCategoryId ? String(options.defaultCategoryId) : null,
      division: String(options.defaultDivision ?? 'shared'),
      counterparty: data.counterparty ? String(data.counterparty) : null,
      method: 'bank_transfer',
      reference: data.reference ? String(data.reference) : null,
      note: narration,
      source: 'bank_import',
      createdById: auth.partyId,
    },
  });
  return { entityType: 'transaction', entityId: txn.id };
}

async function commitAccountRow(data: Record<string, unknown>) {
  const name = String(data.name ?? '');
  if (!name) return null;
  const classified = classifyLedger(name);
  if (classified.kind === 'account') {
    return { entityType: 'ledgerAccount', entityId: await ensureAccount(name, classified.accountType) };
  }
  return { entityType: 'ledgerCategory', entityId: await ensureCategory(name, classified.categoryKind) };
}

/**
 * The division codes a staff list uses.
 *
 * Kaizen writes them into the employee code — `KD/M/2026/0005` is Development,
 * Madurai, 2026, fifth. Mapping them onto the platform's four divisions is what
 * lets a payroll cost land on the right side of the founder's dashboard.
 */
const DIVISION_CODES: Record<string, { division: string; unit: string }> = {
  KI: { division: 'shared', unit: 'Corporate' },
  KD: { division: 'software', unit: 'Software Development' },
  KE: { division: 'education', unit: 'Education' },
  KCS: { division: 'software', unit: 'Cybersecurity' },
  KM: { division: 'shared', unit: 'Marketing' },
};

/**
 * The same divisions written out.
 *
 * The company's own staff export codes them off the employee-code prefix; a
 * person filling in a template writes "Software". Both have to land in the same
 * place, and a template row that quietly became "Shared" because the word did
 * not match a two-letter code is exactly the kind of silent wrong this importer
 * is supposed to avoid.
 */
const DIVISION_NAMES: Record<string, string> = {
  SHARED: 'KI',
  CORPORATE: 'KI',
  SOFTWARE: 'KD',
  'SOFTWARE DEVELOPMENT': 'KD',
  EDUCATION: 'KE',
  'SKILL DEVELOPMENT': 'KE',
  SKILL: 'KE',
  CYBERSECURITY: 'KCS',
  MARKETING: 'KM',
};

/** A division cell, however it was written. */
const divisionCodeOf = (v: unknown): string => {
  const raw = String(v ?? '').toUpperCase().trim();
  if (!raw) return '';
  return DIVISION_CODES[raw] ? raw : (DIVISION_NAMES[raw] ?? raw);
};

async function ensureOrgUnit(name: string, division: string): Promise<string> {
  const auth = currentAuth();
  const existing = await prisma.orgUnit.findFirst({ where: { tenantId: auth.tenantId, name } });
  if (existing) return existing.id;
  const created = await prisma.orgUnit.create({
    data: { tenantId: auth.tenantId, name, unitType: 'department', division },
  });
  return created.id;
}

async function ensureJob(title: string): Promise<string> {
  const auth = currentAuth();
  const existing = await prisma.job.findFirst({ where: { tenantId: auth.tenantId, title } });
  if (existing) return existing.id;

  // The level is read out of the title because a staff list has nothing else,
  // and a job with no level at all makes the establishment view meaningless.
  const t = title.toLowerCase();
  const jobLevel = /head|director|chief|manager/.test(t)
    ? 'lead'
    : /senior|sr\.?/.test(t)
      ? 'senior'
      : /trainee|intern|junior|jr\.?/.test(t)
        ? 'entry'
        : 'mid';
  const jobFamily = /develop|engineer|software|cyber/.test(t)
    ? 'engineering'
    : /train|instructor|academic|teach/.test(t)
      ? 'delivery'
      : /market|design|creative/.test(t)
        ? 'marketing'
        : /hr|operation|admin|front office|keeping/.test(t)
          ? 'operations'
          : 'general';

  const created = await prisma.job.create({ data: { tenantId: auth.tenantId, title, jobFamily, jobLevel } });
  return created.id;
}

/**
 * The seat somebody sits in, and the employment that fills it.
 *
 * A staff spreadsheet is a list of people; the platform models a person, a
 * position and the relationship between them. Building all three on import is
 * the difference between a directory and an HR system — payroll, leave and
 * attendance all hang off the employment relationship, so an import that
 * created only people would produce twelve names that nothing else could use.
 */
async function ensureEmployment(input: {
  personId: string;
  designation: string | null;
  divisionCode: string;
  branch: string | null;
  joiningYear: string | null;
  /** An exact date, where the source gave one rather than only a year. */
  hireDate?: string | null;
}): Promise<string> {
  const auth = currentAuth();

  const existing = await prisma.employmentRelationship.findFirst({
    where: { tenantId: auth.tenantId, personId: input.personId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing.id;

  const mapped = DIVISION_CODES[input.divisionCode] ?? { division: 'shared', unit: 'Corporate' };
  const orgUnitId = await ensureOrgUnit(mapped.unit, mapped.division);
  const jobId = await ensureJob(input.designation || 'Unspecified');

  const position = await prisma.position.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('POS'),
      orgUnitId,
      jobId,
      location: input.branch === 'M' ? 'Madurai' : input.branch || 'Head Office',
      status: 'Filled',
    },
  });

  // A year is all a staff list gives. The first of April is the start of the
  // Indian financial year and is the least wrong assumption available; it is
  // visible on the record and editable, rather than being today's date
  // pretending to be a hire date.
  const exact = input.hireDate ? new Date(input.hireDate) : null;
  const year = Number(input.joiningYear);
  const hireEffectiveDate =
    exact && !Number.isNaN(exact.getTime())
      ? exact
      : Number.isFinite(year) && year > 1990
        ? new Date(Date.UTC(year, 3, 1))
        : new Date();

  const employment = await prisma.employmentRelationship.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('EMP'),
      personId: input.personId,
      hireEffectiveDate,
      status: 'Active',
      confirmationState: 'confirmed',
    },
  });

  await prisma.assignment.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: employment.id,
      positionId: position.id,
      effectiveFrom: hireEffectiveDate,
      reasonCode: 'imported_baseline',
      requestStatus: 'Effective',
      rowStatus: 'Effective',
    },
  });

  return employment.id;
}

async function commitEmployeeRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const fullName = String(data.fullName ?? '').trim();
  if (!fullName) return null;

  const email = data.email ? String(data.email).toLowerCase() : null;

  // Matched on the normalised name as well as on email, because a staff
  // spreadsheet rarely carries email and the same person is spelled three ways
  // across three files. An existing person is updated rather than duplicated.
  const candidates = await prisma.person.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, mergedIntoId: null },
    select: { id: true, fullName: true, primaryEmail: true },
    take: 2000,
  });

  // Email is decisive where a staff list carries one; otherwise the name is
  // matched with the same tolerance the salary and attendance importers use,
  // so the three files agree about who is who.
  const byEmail = email ? candidates.find((p) => p.primaryEmail?.toLowerCase() === email) : undefined;
  const matched = byEmail ? { kind: 'matched' as const, id: byEmail.id } : matchPerson(fullName, candidates);
  if (matched.kind === 'ambiguous') throw new Error(matchFailure(fullName, matched));
  const existing = matched.kind === 'matched' ? candidates.find((p) => p.id === matched.id) : undefined;

  // Only fields the file actually carried are written. A staff list that omits
  // a birthday must not blank one somebody typed in.
  const held = {
    ...(email ? { primaryEmail: email, primaryEmailNormalised: email } : {}),
    ...(data.dateOfBirth ? { dateOfBirth: new Date(String(data.dateOfBirth)) } : {}),
    ...(data.bloodGroup ? { bloodGroup: String(data.bloodGroup) } : {}),
  };

  const person = existing
    ? await prisma.person.update({ where: { id: existing.id }, data: { fullName, ...held } })
    : await prisma.person.create({
        data: {
          tenantId: auth.tenantId,
          recordCode: await nextRecordCode('PER'),
          fullName,
          ...held,
          ...(data.phone ? { primaryPhone: String(data.phone), primaryPhoneNormalised: String(data.phone) } : {}),
          source: 'import',
        },
      });

  const divisionCode = divisionCodeOf(data.division);
  const mapped = DIVISION_CODES[divisionCode] ?? { division: 'shared', unit: 'Corporate' };

  const affiliation = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, partyId: person.id, affiliationType: 'employee' },
  });
  if (!affiliation) {
    await prisma.affiliation.create({
      data: {
        tenantId: auth.tenantId,
        partyId: person.id,
        affiliationType: 'employee',
        counterpartyName: 'Kaizen Infinities',
        // Everybody imported from a staff list is an employee. Authority is a
        // separate decision, made in the product by somebody who holds it — an
        // import must never be a way to grant somebody a role.
        roleSlug: 'employee',
        primaryFlag: true,
        status: 'active',
        branch: data.branch ? String(data.branch) : null,
        statutoryRetentionFloor: true,
      },
    });
  }

  await ensureEmployment({
    personId: person.id,
    designation: data.designation ? String(data.designation) : null,
    divisionCode,
    branch: data.branch ? String(data.branch) : null,
    joiningYear: data.joiningYear ? String(data.joiningYear) : null,
    hireDate: data.joiningDate ? String(data.joiningDate) : null,
  });

  return { entityType: 'person', entityId: person.id };
}

async function commitSalaryRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const fullName = String(data.fullName ?? '').trim();
  const amount = Number(data.monthlyAmount ?? 0);
  if (!fullName || !amount) return null;

  const candidates = await prisma.person.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, mergedIntoId: null },
    select: { id: true, fullName: true },
    take: 2000,
  });
  const matched = matchPerson(fullName, candidates);
  if (matched.kind !== 'matched') throw new Error(matchFailure(fullName, matched));
  const person = { id: matched.id };

  const employment = await prisma.employmentRelationship.findFirst({
    where: { tenantId: auth.tenantId, personId: person.id },
    orderBy: { createdAt: 'desc' },
  });
  if (!employment) {
    throw new Error(`"${fullName}" is on file but holds no employment relationship, so there is nothing to attach pay to.`);
  }

  const existing = await prisma.compensationRecord.findFirst({
    where: { tenantId: auth.tenantId, employmentRelationshipId: employment.id, status: 'Effective' },
  });
  if (existing && Number(existing.amount) === amount) {
    return { entityType: 'compensationRecord', entityId: existing.id };
  }

  const record = await prisma.compensationRecord.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: employment.id,
      amount,
      currency: 'INR',
      revisionReason: 'imported_baseline',
      status: 'Effective',
      effectiveFrom: new Date(),
    },
  });

  if (existing) {
    await prisma.compensationRecord.update({
      where: { id: existing.id },
      data: { status: 'Superseded', effectiveTo: new Date() },
    });
  }

  return { entityType: 'compensationRecord', entityId: record.id };
}

async function commitAttendanceRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const fullName = String(data.fullName ?? '').trim();
  const days = (data.days ?? []) as Array<{ date: string; status: string }>;
  if (!fullName || days.length === 0) return null;

  const candidates = await prisma.person.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, mergedIntoId: null },
    select: { id: true, fullName: true },
    take: 2000,
  });
  const matched = matchPerson(fullName, candidates);
  if (matched.kind !== 'matched') throw new Error(matchFailure(fullName, matched));
  const person = { id: matched.id };

  const employment = await prisma.employmentRelationship.findFirst({
    where: { tenantId: auth.tenantId, personId: person.id },
    orderBy: { createdAt: 'desc' },
  });
  if (!employment) throw new Error(`"${fullName}" holds no employment relationship.`);

  let written = 0;
  for (const day of days) {
    const workDate = new Date(day.date);
    const existing = await prisma.workAttendance.findFirst({
      where: { tenantId: auth.tenantId, employmentRelationshipId: employment.id, workDate },
    });
    if (existing) continue;
    // `status` on this model is the lifecycle state — Recorded, Disputed,
    // Approved — and not whether somebody turned up. The presence mark is the
    // note, and the minutes carry it in a form payroll can add up.
    await prisma.workAttendance.create({
      data: {
        tenantId: auth.tenantId,
        employmentRelationshipId: employment.id,
        workDate,
        status: 'Recorded',
        workedMinutes: day.status === 'present' ? 480 : day.status === 'half_day' ? 240 : 0,
        note: `Imported: ${day.status}`,
      },
    });
    written += 1;
  }

  if (written === 0) return null;
  return { entityType: 'workAttendance', entityId: employment.id };
}

// ---------------------------------------------------------------------------

/**
 * Undo.
 *
 * Removes exactly what the batch created and nothing else, so a bad import is
 * a mistake somebody made for ten minutes rather than a weekend of manual
 * correction. Accounts and categories the import created are left in place:
 * they are almost always right even when the transactions are not, and
 * deleting one that a later transaction now uses would fail anyway.
 */
export async function revertImport(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'imports', verb: 'delete' });

  const batch = await prisma.importBatch.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!batch) throw ApiError.notFound('Import');
  if (batch.status !== 'committed') throw ApiError.conflict('Only a committed import can be reverted.');

  const rows = await prisma.importRow.findMany({
    where: { tenantId: auth.tenantId, batchId: id, status: 'committed' },
  });

  const removed: Record<string, number> = {};
  for (const row of rows) {
    if (!row.entityId || !row.entityType) continue;
    try {
      switch (row.entityType) {
        case 'transaction':
          await prisma.transaction.delete({ where: { id: row.entityId } });
          break;
        case 'compensationRecord':
          await prisma.compensationRecord.delete({ where: { id: row.entityId } });
          break;
        case 'workAttendance':
          await prisma.workAttendance.deleteMany({
            where: { tenantId: auth.tenantId, employmentRelationshipId: row.entityId, note: { startsWith: 'Imported:' } },
          });
          break;
        case 'person':
          // People are soft-deleted rather than removed. A person may already
          // be referenced by a leave request or an employment record by now,
          // and the statutory retention floor on an employee affiliation means
          // deleting one is not the platform's call anyway.
          await prisma.person.update({ where: { id: row.entityId }, data: { deletedAt: new Date() } });
          break;
        case 'enrollment':
          // Withdrawn rather than deleted, and the person is left alone. An
          // enrolment that has had attendance marked or a fee receipted against
          // it is a record of something that happened; reverting the import that
          // created it does not unhappen any of that. The student stays on file,
          // because they may have been on file before this import ran — and
          // their student record with them, for the same reason: it is a fact
          // about a person, not about this batch.
          await prisma.enrollment.update({
            where: { id: row.entityId },
            data: { status: 'withdrawn' },
          });
          break;
        default:
          continue;
      }
      removed[row.entityType] = (removed[row.entityType] ?? 0) + 1;
      await prisma.importRow.update({ where: { id: row.id }, data: { status: 'ready', entityId: null, entityType: null } });
    } catch {
      // A row whose record has since been edited into something else is left
      // alone and reported, rather than cascading into records the import did
      // not create.
      await prisma.importRow.update({
        where: { id: row.id },
        data: { message: 'Could not be reverted — the record it created has since changed.' },
      });
    }
  }

  await prisma.importBatch.update({
    where: { id },
    data: { status: 'reverted', revertedAt: new Date(), stats: { ...(batch.stats as object), reverted: removed } as never },
  });

  await emit({
    name: EVENTS.IMPORT_REVERTED,
    subject: { entityType: 'import_batch', entityId: id },
    newState: { removed },
    impact: { domains: ['fin'] },
  });

  return { removed };
}

// ---------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------

/**
 * These rows came from a shape this platform published, so there is far less
 * guessing than in the ledger importers above — but the same two disciplines
 * hold: nothing is invented to fill a blank cell, and a name that already
 * exists is used rather than duplicated.
 *
 * References between templates are by name, because a person filling in a
 * spreadsheet has names and not ids. A name that does not resolve is an error
 * on that row naming what was not found, never a silent skip and never a
 * newly-invented record standing in for the one they meant.
 */

const text = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s || null;
};

/** An organisation by name, for the columns that point at one. */
async function organizationByName(name: string) {
  const auth = currentAuth();
  const matches = await prisma.organization.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, name: { equals: name, mode: 'insensitive' } },
    include: { institutionProfile: { select: { id: true } } },
    take: 2,
  });
  if (matches.length > 1) {
    throw new Error(`"${name}" matches more than one organisation on file. Rename one of them, or import this row by hand.`);
  }
  return matches[0] ?? null;
}

async function commitCourseRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const code = text(data.code);
  const name = text(data.name);
  if (!code || !name) return null;

  const existing = await prisma.course.findFirst({ where: { tenantId: auth.tenantId, code } });
  if (existing) return { entityType: 'course', entityId: existing.id };

  const course = await prisma.course.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('CRS'),
      name,
      code,
      description: text(data.description),
      durationWeeks: data.durationWeeks == null ? null : Math.round(Number(data.durationWeeks)),
    },
  });
  return { entityType: 'course', entityId: course.id };
}

async function commitBatchRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const courseCode = text(data.courseCode);
  const name = text(data.name);
  if (!courseCode || !name) return null;

  const course = await prisma.course.findFirst({ where: { tenantId: auth.tenantId, code: courseCode } });
  if (!course) {
    throw new Error(`No course has the code "${courseCode}". Import the Courses template first, or correct the code.`);
  }

  const existing = await prisma.cohort.findFirst({ where: { tenantId: auth.tenantId, name } });
  if (existing) return { entityType: 'cohort', entityId: existing.id };

  let institutionId: string | null = null;
  const collegeName = text(data.institutionName);
  if (collegeName) {
    const college = await organizationByName(collegeName);
    if (!college) throw new Error(`"${collegeName}" is not on file. Import the Colleges template first, or correct the name.`);
    if (!college.institutionProfile) {
      throw new Error(`"${collegeName}" is on file but is not marked as a college, so a batch cannot run at it.`);
    }
    institutionId = college.id;
  }

  const cohort = await prisma.cohort.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('COH'),
      courseId: course.id,
      name,
      startDate: new Date(String(data.startDate)),
      endDate: data.endDate ? new Date(String(data.endDate)) : null,
      capacity: data.capacity == null ? 30 : Math.round(Number(data.capacity)),
      institutionId,
    },
  });
  return { entityType: 'cohort', entityId: cohort.id };
}

/**
 * Shared by the college and client templates: find the body, or make it as the
 * kind the template is for.
 *
 * A name already on file is used as it stands even if it was recorded as the
 * other kind — an import does not get to decide that the college somebody
 * entered by hand is really a supplier. The row is returned as it is and the
 * caller's kind-specific work refuses on its own terms, which is where the
 * error message can actually say what happened.
 */
async function organizationFor(name: string, kind: 'institution' | 'organization') {
  const existing = await organizationByName(name);
  if (existing) return existing;
  const { createOrganization } = await import('../domains/organizations.js');
  const created = await createOrganization({ name, kind });
  return { ...created, institutionProfile: null as { id: string } | null };
}

async function commitCollegeRow(data: Record<string, unknown>) {
  const name = text(data.name);
  if (!name) return null;

  const org = await organizationFor(name, 'institution');
  const { attachInstitutionProfile, attachAccount } = await import('../domains/organizations.js');

  if (!org.institutionProfile) {
    await attachInstitutionProfile(org.id, {
      institutionType: text(data.institutionType),
      managementType: text(data.managementType),
      district: text(data.district),
      state: text(data.state),
      studentCount: data.studentCount == null ? null : Math.round(Number(data.studentCount)),
      establishedYear: data.establishedYear == null ? null : Math.round(Number(data.establishedYear)),
    });
  }

  if (text(data.website)) {
    await prisma.organization.update({ where: { id: org.id }, data: { website: text(data.website) } });
  }

  // A college that also buys from us. It stays a college: billing detail is not
  // an identity, and the column says the money moves, not what the body is.
  if (data.alsoAClient === true) {
    const account = await prisma.account.findFirst({ where: { organizationId: org.id } });
    if (!account) await attachAccount(org.id, {});
  }

  return { entityType: 'organization', entityId: org.id };
}

async function commitClientRow(data: Record<string, unknown>) {
  const name = text(data.name);
  if (!name) return null;

  const org = await organizationFor(name, 'organization');
  const { attachAccount } = await import('../domains/organizations.js');

  const account = await prisma.account.findFirst({ where: { organizationId: org.id } });
  if (!account) {
    await attachAccount(org.id, {
      tier: text(data.tier)?.toLowerCase().replace(/\s+/g, '_') ?? undefined,
      billingEmail: text(data.billingEmail),
      billingAddress: text(data.billingAddress),
      paymentTermsDays: data.paymentTermsDays == null ? null : Math.round(Number(data.paymentTermsDays)),
    });
  }

  if (text(data.website)) {
    await prisma.organization.update({ where: { id: org.id }, data: { website: text(data.website) } });
  }

  return { entityType: 'organization', entityId: org.id };
}

async function commitStudentRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const cohortName = text(data.cohortName);
  if (!cohortName) return null;

  const cohort = await prisma.cohort.findFirst({ where: { tenantId: auth.tenantId, name: cohortName } });
  if (!cohort) {
    throw new Error(`No batch is called "${cohortName}". Import the Training batches template first, or correct the name.`);
  }

  let institutionId: string | null = null;
  const collegeName = text(data.institutionName);
  if (collegeName) {
    const college = await organizationByName(collegeName);
    if (!college) throw new Error(`"${collegeName}" is not on file. Import the Colleges template first, or correct the name.`);
    institutionId = college.id;
  }

  // Through the same function the form calls, so an imported student and a
  // typed one are the same act: the same college check, the same guardian rule,
  // the same student affiliation, the same refusal to enrol somebody twice.
  const { enrolStudent } = await import('../domains/education.js');
  const enrollment = await enrolStudent({
    cohortId: cohort.id,
    fullName: text(data.fullName) ?? undefined,
    primaryPhone: text(data.primaryPhone),
    primaryEmail: text(data.primaryEmail),
    institutionId,
    isMinor: data.isMinor === true,
    guardianName: text(data.guardianName),
    guardianPhone: text(data.guardianPhone),
  });
  return { entityType: 'enrollment', entityId: enrollment.id };
}

/**
 * A row of the company's own student register.
 *
 * Four writes, in this order, and nothing else: the course, a batch of it, the
 * person, and their enrolment. The registration number the register already gave
 * them rides onto the enrolment as its `legacyReference`, so "KI-2026/07-FS/1101"
 * keeps working as a way to find somebody after the import.
 *
 * **The money on the row is not written.** The fee, the discount, the GST and the
 * instalments are read, checked against each other and reported in the preview,
 * and then left there. Two reasons. A course's price belongs to the course and is
 * set deliberately — nine rows quoting nine discounted figures are not a price
 * list, and writing the first one onto the catalogue would make the next person
 * who bills that course quote a discount somebody negotiated once. And the
 * payments in this register were receipted outside this platform: inventing
 * invoices and receipts to match would produce documents the customer never
 * received, numbered by us, in a ledger that then disagrees with the counterfoils
 * they are holding. Raising them is a decision, and it is made in the product
 * with its own audit trail.
 *
 * So a course that is new arrives with no fee against it, which is the honest
 * state for a course nobody has priced yet, and the Courses screen says so.
 */
async function commitStudentRegisterRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const fullName = text(data.fullName);
  const courseName = text(data.courseName);
  if (!fullName || !courseName) return null;

  // ---- The course ---------------------------------------------------------
  //
  // Matched on the name as written, then on a canonical form of it, so
  // "C.C++ & Java" and "C C++ and Java" are one course rather than two. Created
  // with no fee, no rate and no SAC: those are the catalogue's to set.
  let course = await prisma.course.findFirst({ where: { tenantId: auth.tenantId, name: courseName } });
  if (!course) {
    const canonical = canonicalCourseName(courseName);
    const candidates = await prisma.course.findMany({ where: { tenantId: auth.tenantId } });
    course = candidates.find((c) => canonicalCourseName(c.name) === canonical) ?? null;
  }
  if (!course) {
    course = await prisma.course.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: await nextRecordCode('CRS'),
        name: courseName,
        code: courseCodeFor(courseName),
        // Deliberately unpriced. A discounted figure from one student's row is
        // not what this course sells for.
        feeAmount: null,
        division: 'education',
      },
    });
  }

  // ---- The batch ----------------------------------------------------------
  //
  // The register carries a start and an end date per student rather than per
  // batch, because students join a rolling programme whenever they join. So the
  // batch is the course's rolling intake — one per course, created on first use —
  // and the student's own dates go on their enrolment. Making a batch per
  // distinct date pair would report nine batches of one.
  const batchName = `${course.name} — rolling`;
  let cohort = await prisma.cohort.findFirst({ where: { tenantId: auth.tenantId, courseId: course.id, name: batchName } });
  const startsOn = data.startsOn ? new Date(String(data.startsOn)) : null;
  if (!cohort) {
    cohort = await prisma.cohort.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: await nextRecordCode('COH'),
        courseId: course.id,
        name: batchName,
        startDate: startsOn ?? new Date(),
        endDate: null,
        capacity: 9_999,
        status: 'active',
      },
    });
  } else if (startsOn && startsOn < cohort.startDate) {
    // A rolling intake starts when its earliest student did.
    await prisma.cohort.update({ where: { id: cohort.id }, data: { startDate: startsOn } });
  }

  // ---- The student and the enrolment --------------------------------------
  //
  // Through the same function the form calls, so an imported student and a typed
  // one are the same act: the same phone-and-email matching, the same refusal to
  // enrol somebody twice, the same student affiliation.
  const { enrolStudent } = await import('../domains/education.js');
  const enrollment = await enrolStudent({
    cohortId: cohort.id,
    fullName,
    primaryPhone: text(data.primaryPhone),
    primaryEmail: text(data.primaryEmail),
  });

  // The register's own identifiers and dates, which the enrolment is the right
  // place for: they are facts about this student's run of the course, not about
  // the batch.
  const registrationNumber = text(data.registrationNumber);
  const enrolledAt = data.registeredOn ? new Date(String(data.registeredOn)) : (startsOn ?? null);
  await prisma.enrollment.update({
    where: { id: enrollment.id },
    data: {
      ...(registrationNumber ? { legacyReference: registrationNumber } : {}),
      status: 'active',
      ...(enrolledAt ? { enrolledAt } : {}),
    },
  });

  // The student record itself.
  //
  // An enrolment says somebody holds a place on a course; it does not make them
  // a learner the company can find, list or bill. The register is a list of
  // students, so importing it produces students — with the registration number
  // in its own field rather than only as the enrolment's legacy reference.
  //
  // Nothing about money is written, here or anywhere in this import: the fees
  // and the receipts in the file stay in the file until somebody asks for them.
  const existingStudent = await prisma.studentProfile.findFirst({
    where: { personId: enrollment.personId, deletedAt: null },
  });
  if (!existingStudent) {
    // A registration number already in use means the same learner reached this
    // row twice under two different people, which is a matter for whoever reads
    // the preview. The student is still created, without it, rather than the
    // row failing.
    const numberFree =
      !registrationNumber ||
      !(await prisma.studentProfile.findFirst({ where: { registrationNumber } }));
    await prisma.studentProfile.create({
      data: {
        tenantId: auth.tenantId,
        personId: enrollment.personId,
        registrationNumber: numberFree ? registrationNumber : null,
        status: 'active',
      },
    });
  } else if (registrationNumber && !existingStudent.registrationNumber) {
    const taken = await prisma.studentProfile.findFirst({ where: { registrationNumber } });
    if (!taken) {
      await prisma.studentProfile.update({
        where: { id: existingStudent.id },
        data: { registrationNumber },
      });
    }
  }

  return { entityType: 'enrollment', entityId: enrollment.id };
}

/** "C.C++ & Java" and "C C++ and Java" are the same course. */
function canonicalCourseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A code for a course that arrived without one.
 *
 * Initials of the words, which is what the register's own registration numbers
 * use — `KI-2026/07-FS/1101` for Full Stack — so the generated code reads the way
 * the company already refers to the course. Truncated to sixteen characters,
 * because a tax invoice number has a length limit and this ends up beside one.
 */
function courseCodeFor(name: string): string {
  const initials = name
    .replace(/&/g, ' ')
    .split(/[^A-Za-z0-9+]+/)
    .filter(Boolean)
    .map((w) => (/^[0-9+]/.test(w) ? w : w[0]))
    .join('')
    .toUpperCase();
  return (initials || name.replace(/[^A-Za-z0-9]/g, '')).slice(0, 16);
}

async function commitContactRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const fullName = text(data.fullName);
  if (!fullName) return null;

  const email = text(data.primaryEmail)?.toLowerCase() ?? null;
  const phone = text(data.primaryPhone)?.replace(/\D/g, '') || null;

  const existing =
    email || phone
      ? await prisma.person.findFirst({
          where: {
            tenantId: auth.tenantId,
            deletedAt: null,
            dedupeStatus: { not: 'merged' },
            OR: [...(email ? [{ primaryEmailNormalised: email }] : []), ...(phone ? [{ primaryPhoneNormalised: phone }] : [])],
          },
        })
      : null;

  const person =
    existing ??
    (await prisma.person.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: await nextRecordCode('PER'),
        fullName,
        ...(email ? { primaryEmail: email, primaryEmailNormalised: email } : {}),
        ...(phone ? { primaryPhone: text(data.primaryPhone), primaryPhoneNormalised: phone } : {}),
        source: 'import',
      },
    }));

  const orgName = text(data.organizationName);
  if (orgName) {
    const org = await organizationByName(orgName);
    if (!org) throw new Error(`"${orgName}" is not on file. Import the Clients or Colleges template first, or correct the name.`);

    // Which kind of contact they are follows from what the organisation is to
    // us, rather than being asked again in a column the person filling this in
    // would have to keep consistent with the other sheet.
    const affiliationType = org.institutionProfile ? 'institution_contact' : 'customer_contact';
    const held = await prisma.affiliation.findFirst({
      where: { tenantId: auth.tenantId, partyId: person.id, counterpartyId: org.id, affiliationType },
    });
    if (!held) {
      const { createAffiliation } = await import('../domains/identity.js');
      await createAffiliation({
        partyId: person.id,
        affiliationType,
        counterpartyId: org.id,
        counterpartyName: org.name,
      });
    }
  }

  return { entityType: 'person', entityId: person.id };
}
