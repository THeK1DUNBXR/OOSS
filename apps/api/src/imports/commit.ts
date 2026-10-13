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

import { Prisma, type ImportBatch, type ImportRow } from '@prisma/client';
import { prisma, unscopedPrisma, dec, type DbTx } from '../platform/db.js';
import { rupeesToMinor } from '../platform/wire.js';
import { currentAuth } from '../platform/context.js';
import { assertCan } from '../platform/permissions.js';
import { assertCanAssignRole } from '../platform/roleAssignment.js';
import { ApiError } from '../platform/errors.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { emit } from '../platform/eventBus.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { lockLegacyPeriods } from '../platform/periodLock.js';
import { governedWrite } from '../platform/governedWrite.js';
import { writeTransactionMinor, assertPeriodPostableInTx, reverseTransactionIn } from '../domains/books.js';
import { filedReturnFor } from '../domains/invoicing.js';
// A register import writes learner profiles, and auditWrite refuses a subject type
// no module has registered. The student_profile registration is in that module, so
// it must be loaded here rather than only wherever the routes happen to load it.
import '../domains/students.js';
// The revert writes six subject types through auditWrite, which throws on a subject
// no loaded module registered (audit.ts:419). Their registrations sit in these three
// modules, so they are loaded here, not left to whichever route or job loads them first.
// FX-22 in auditRegistry.test.ts pins this.
import '../domains/employment.js';
import '../domains/leave.js';
import '../domains/compliance/books.js';
// The import creates org units, and their subject is registered in the units module.
import '../domains/units.js';
import { EVENTS, DIVISION_LABELS, DIVISIONS, parseMinor, type Division } from '@kaizen/shared';
import { matchFailure, matchPerson } from './matchName.js';
import { classifyLedger, divisionFor, isAccountName, JOURNAL_ACCOUNT_NAME, JOURNAL_ACCOUNT_TYPE } from './classify.js';
import { UNSTATED_LEDGER_KIND } from './chart.js';
import { openStagedNormalised, purgeStagedRaw } from './sealing.js';
import { logger } from '../platform/logger.js';

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

/**
 * Finds or creates an account named in the file, inside the chunk's
 * transaction. A created account is audited and announced like one made by
 * hand (books.ts createAccount), so an import cannot add to the books unseen.
 */
async function ensureAccount(name: string, accountType: string, tx: DbTx): Promise<string> {
  const auth = currentAuth();
  const existing = await tx.ledgerAccount.findFirst({ where: { tenantId: auth.tenantId, name } });
  if (existing) return existing.id;
  const created = await tx.ledgerAccount.create({
    data: {
      tenantId: auth.tenantId,
      name,
      accountType,
      ledgerGroup: accountType === 'card' ? 'liability' : 'asset',
      openingBalanceMinor: 0n,
    },
  });
  await auditWrite({
    action: 'create',
    subjectType: 'ledger_account',
    subjectId: created.id,
    after: { name, accountType, ledgerGroup: created.ledgerGroup, openingBalance: 0, openingBalanceMinor: '0' },
    tx,
  });
  await emit({
    name: EVENTS.LEDGER_ACCOUNT_CREATED,
    subject: { entityType: 'ledger_account', entityId: created.id },
    newState: { name, accountType },
    tx,
  });
  return created.id;
}

async function ensureCategory(name: string, categoryKind: string, tx: DbTx): Promise<string> {
  const auth = currentAuth();
  const existing = await tx.ledgerCategory.findFirst({ where: { tenantId: auth.tenantId, name } });
  if (existing) return existing.id;
  const created = await tx.ledgerCategory.create({
    data: {
      tenantId: auth.tenantId,
      name,
      kind: categoryKind,
      behaviour: 'variable',
      defaultDivision: divisionFor(name),
    },
  });
  await auditWrite({
    action: 'create',
    subjectType: 'ledger_category',
    subjectId: created.id,
    after: { name, kind: categoryKind, behaviour: 'variable' },
    tx,
  });
  return created.id;
}

/**
 * The file's amount in paise. The reader hands over a JavaScript number, so it
 * is taken back to the text the file had (String of a double is the shortest
 * text that reads back to it, which for a two-place amount is that amount) and
 * parsed strictly: a third decimal is refused, not rounded. Refusing it is the
 * point, because a third decimal is nearly always a unit mistake.
 */
function paiseOf(value: unknown): bigint {
  if (value === undefined || value === null) return 0n;
  const text = String(value);
  try {
    return parseMinor(text);
  } catch {
    throw new Error(`The amount ${text} is not a rupee amount with at most two decimal places.`);
  }
}

// ---------------------------------------------------------------------------

/** Rows per transaction. A crash loses at most the open chunk, and the rerun finds those rows still ready (FX-72). */
const CHUNK_ROWS = 500;

/**
 * Kinds whose writers take the chunk's transaction. The others still write
 * through the scoped client, one row at a time, as they did before FX-72: a
 * crash between one of their writes and the row being marked can still leave a
 * duplicate on the rerun. Moving them is the same change as the ledger's.
 */
const CHUNKED_KINDS = new Set(['tally_ledger', 'bank_statement', 'transactions']);

const CHUNK_TIMEOUT_MS = 5 * 60_000;
const BATCH_LOCK_TIMEOUT_MS = 4 * 60 * 60_000;

interface Tally {
  created: Record<string, number>;
  skipped: number;
  errors: Array<{ rowNumber: number; message: string }>;
}

/**
 * Errors from the database itself, rather than from the row. Postgres aborts
 * the whole transaction on one of them, so the chunk cannot go on: it is rolled
 * back, and the rerun starts from its first row.
 */
function isDatabaseFault(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientInitializationError
  );
}

/**
 * One commit at a time per batch. A session-level lock cannot span the chunk
 * transactions, since each takes its own connection from the pool, so the lock
 * is a transaction-scoped advisory lock held by an outer transaction. It is
 * released when that transaction ends, including when the process dies, which
 * is what lets an interrupted commit be resumed.
 *
 * The outer transaction runs on the unscoped client and holds no tenant data:
 * it sets no tenant and reads no row, only takes the lock. That matters because
 * the scoped client refuses any statement made inside an interactive transaction
 * (db.ts refuseOuterClientInTransaction), and the work below must run its own
 * scoped chunk transactions. The key names the tenant, so a batch id is never
 * shared across tenants.
 */
async function withBatchLock<T>(tenant: string, batchId: string, work: () => Promise<T>): Promise<T> {
  return unscopedPrisma.$transaction(
    async (lock) => {
      const [row] = await lock.$queryRaw<Array<{ held: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`import_batch:${tenant}:${batchId}`}, 0)) AS held`;
      if (!row?.held) {
        throw ApiError.conflict(
          'This import is already being committed. Wait for that commit to finish, then look again.',
        );
      }
      return work();
    },
    { timeout: BATCH_LOCK_TIMEOUT_MS, maxWait: 10_000 },
  );
}

export async function commitImport(id: string): Promise<CommitResult> {
  await assertCan({ resource: 'imports', verb: 'edit' });
  const auth = currentAuth();

  const batch = await prisma.importBatch.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!batch) throw ApiError.notFound('Import');
  if (batch.status === 'committed') throw ApiError.conflict('This import has already been committed.');

  return withBatchLock(auth.tenantId, id, () => commitUnderLock(id));
}

async function commitUnderLock(id: string): Promise<CommitResult> {
  const auth = currentAuth();

  // Read again under the lock: a commit that held it a moment ago may have finished.
  const batch = await prisma.importBatch.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!batch) throw ApiError.notFound('Import');
  if (batch.status === 'committed') throw ApiError.conflict('This import has already been committed.');

  const pending = await prisma.importRow.count({
    where: { tenantId: auth.tenantId, batchId: id, status: 'ready' },
  });
  // An interrupted commit can have nothing left to write and still be unmarked:
  // that is a resume to finish, not a file with nothing to commit.
  if (pending === 0 && batch.status !== 'committing') {
    throw ApiError.badRequest(
      'Every row in this import is a duplicate, a blank or an error. There is nothing to commit.',
    );
  }

  // Written outside the chunk transactions, so an interrupted commit leaves it
  // on the batch and the rerun resumes rather than starting the batch over.
  await prisma.importBatch.update({ where: { id }, data: { status: 'committing' } });
  await auditWrite({
    action: 'update',
    subjectType: 'import_batch',
    subjectId: id,
    before: { status: batch.status },
    after: { status: 'committing' },
  });

  const options = (batch.options ?? {}) as Record<string, unknown>;
  const chunked = CHUNKED_KINDS.has(batch.kind);
  const tally: Tally = { created: {}, skipped: 0, errors: [] };

  for (;;) {
    const rows = await prisma.importRow.findMany({
      where: { tenantId: auth.tenantId, batchId: id, status: 'ready' },
      orderBy: { rowNumber: 'asc' },
      take: CHUNK_ROWS,
    });
    if (rows.length === 0) break;
    if (chunked) {
      await commitChunk(rows, batch.kind, options, tally);
    } else {
      for (const row of rows) await commitRowOutsideChunk(row, batch.kind, options, tally);
    }
  }

  // Read back from the rows, not from this run alone, so a resumed commit
  // reports the errors the interrupted run already recorded.
  const errorRows = await prisma.importRow.findMany({
    where: { tenantId: auth.tenantId, batchId: id, status: 'error' },
    orderBy: { rowNumber: 'asc' },
    select: { rowNumber: true, message: true },
  });
  const result: CommitResult = {
    created: tally.created,
    skipped: tally.skipped,
    errors: errorRows.map((r) => ({ rowNumber: r.rowNumber, message: r.message ?? '' })),
  };

  await prisma.importBatch.update({
    where: { id },
    data: {
      status: 'committed',
      committedAt: new Date(),
      stats: { ...(batch.stats as object), ...result.created, errors: result.errors.length } as never,
    },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'import_batch',
    subjectId: id,
    before: { status: 'committing' },
    after: { status: 'committed', created: result.created, skipped: result.skipped, errors: result.errors.length },
  });

  await emit({
    name: EVENTS.IMPORT_COMMITTED,
    subject: { entityType: 'import_batch', entityId: id },
    newState: { kind: batch.kind, ...result.created, errors: result.errors.length },
    impact: { domains: ['fin'] },
  });

  // After the commit, not before: the books now hold what the file said, so
  // the file's own cells are no longer needed. A failure here is logged and
  // does not undo the commit, which has already happened; the cells stay until
  // someone purges them, and the log says which batch.
  try {
    await purgeStagedRaw(id);
  } catch (err) {
    logger.error(
      { component: 'imports', tenantId: auth.tenantId, batchId: id, err },
      'staged cells not purged after commit',
    );
  }

  return result;
}

/**
 * One chunk: up to CHUNK_ROWS rows in one transaction. Its rows are committed
 * together or not at all. The tally is merged only once the transaction has
 * committed, so a rolled-back chunk reports nothing.
 */
async function commitChunk(rows: ImportRow[], kind: string, options: Record<string, unknown>, tally: Tally) {
  const chunk: Tally = { created: {}, skipped: 0, errors: [] };
  const { tenantId } = currentAuth();
  const writeDates = rows.flatMap((row) => chunkWriteDates(row, kind, options));
  await prisma.$transaction(
    async (tx) => {
      // Every month this chunk writes into is locked before the first write or audit row,
      // in ascending order (platform/periodLock.ts). A chunk that reached its second month
      // only after writing its first would hold the audit lock while it waited for that
      // month's row, and a close of that month would wait for the audit lock: a deadlock.
      // It refuses nothing here. Each row below still refuses a closing or closed month.
      await lockLegacyPeriods(tx, tenantId, writeDates);
      for (const row of rows) await commitRowInChunk(tx, row, kind, options, chunk);
    },
    { timeout: CHUNK_TIMEOUT_MS, maxWait: 10_000 },
  );
  for (const [k, n] of Object.entries(chunk.created)) tally.created[k] = (tally.created[k] ?? 0) + n;
  tally.skipped += chunk.skipped;
  tally.errors.push(...chunk.errors);
}

/**
 * The IST date a chunk row writes a legacy row into, or none if it writes none. It
 * mirrors the early returns of commitLedgerRow and commitBankRow, so a row that writes
 * nothing creates no period. A row whose date or amount does not read is left out here.
 * The row then fails on its own, as it did before the chunk lock. The row is opened here
 * only to read its date and amount. commitRowInChunk opens it again for the domain.
 */
function chunkWriteDates(row: ImportRow, kind: string, options: Record<string, unknown>): Date[] {
  const data = openStagedNormalised(row.normalised);
  if (!data) return [];
  let writes: boolean;
  if (kind === 'tally_ledger') {
    let amount: bigint;
    try {
      amount = paiseOf(data.amount);
    } catch {
      return [];
    }
    writes = String(data.ledger ?? '') !== '' && amount !== 0n;
  } else if (kind === 'bank_statement' || kind === 'transactions') {
    writes = data.openingBalance === undefined && String(options.accountId ?? '') !== '';
  } else {
    writes = false;
  }
  if (!writes) return [];
  const txnDate = new Date(String(data.txnDate));
  return Number.isNaN(txnDate.getTime()) ? [] : [txnDate];
}

/**
 * Writes one staged row's outcome and audits it. The outcome names the record each row
 * made, and a revert reads it back, so a row's outcome is part of the import's own trail.
 * `tx` is the chunk's transaction. The row-at-a-time path has none, and its audit row
 * commits on its own, as the rest of that path's writes do.
 */
async function recordRowOutcome(
  row: ImportRow,
  data: { status: string; entityType?: string; entityId?: string; created?: unknown; message?: string | null },
  tx?: DbTx,
): Promise<void> {
  const db = tx ?? (prisma as unknown as DbTx);
  await db.importRow.update({ where: { id: row.id }, data: data as never });
  await auditWrite({
    action: 'update',
    subjectType: 'import_row',
    subjectId: row.id,
    before: { status: row.status },
    after: { status: data.status, entityType: data.entityType ?? null, entityId: data.entityId ?? null },
    meta: { batchId: row.batchId, rowNumber: row.rowNumber },
    tx,
  });
}

async function commitRowInChunk(
  tx: DbTx,
  row: ImportRow,
  kind: string,
  options: Record<string, unknown>,
  tally: Tally,
) {
  // Opened here, and only here: the domain functions below seal what they
  // are given for their own records, so a staged ciphertext would be sealed
  // a second time and come out unreadable.
  const data = openStagedNormalised(row.normalised);
  if (!data) {
    tally.skipped += 1;
    await recordRowOutcome(row, { status: 'skipped' }, tx);
    return;
  }
  try {
    const outcome = await commitChunkedRow(tx, kind, data, options);
    if (outcome) {
      tally.created[outcome.entityType] = (tally.created[outcome.entityType] ?? 0) + 1;
      await recordRowOutcome(
        row,
        {
          status: 'committed',
          entityType: outcome.entityType,
          entityId: outcome.entityId,
          created: [{ entityType: outcome.entityType, entityId: outcome.entityId }],
          message: null,
        },
        tx,
      );
    } else {
      tally.skipped += 1;
      await recordRowOutcome(row, { status: 'skipped' }, tx);
    }
  } catch (error) {
    if (isDatabaseFault(error)) {
      logger.error(
        { component: 'imports', batchId: row.batchId, rowNumber: row.rowNumber, err: error },
        'import chunk rolled back on a database fault',
      );
      throw error;
    }
    const message = (error as Error).message;
    tally.errors.push({ rowNumber: row.rowNumber, message });
    await recordRowOutcome(row, { status: 'error', message }, tx);
  }
}

async function commitChunkedRow(
  tx: DbTx,
  kind: string,
  data: Record<string, unknown>,
  options: Record<string, unknown>,
) {
  switch (kind) {
    case 'tally_ledger':
      return commitLedgerRow(data, options, tx);
    case 'bank_statement':
    case 'transactions':
      return commitBankRow(data, options, tx);
    default:
      throw new Error(`No commit path for an import of kind "${kind}".`);
  }
}

/** The row-at-a-time path, for the kinds not yet moved into chunks (see CHUNKED_KINDS). */
async function commitRowOutsideChunk(row: ImportRow, kind: string, options: Record<string, unknown>, tally: Tally) {
  // Opened here, and only here (see commitRowInChunk).
  const data = openStagedNormalised(row.normalised);
  if (!data) {
    tally.skipped += 1;
    await recordRowOutcome(row, { status: 'skipped' });
    return;
  }
  try {
    let outcome: {
      entityType: string;
      entityId: string;
      matched?: boolean;
      /** What the row created, when it made more than its entity: see ImportRow.created. */
      created?: CreatedRecord[];
    } | null = null;
    switch (kind) {
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
      case 'template_ledger_accounts':
        outcome = await commitLedgerAccountTemplateRow(data);
        break;
      case 'template_ledger_categories':
        outcome = await commitLedgerCategoryTemplateRow(data);
        break;
      case 'template_vendor_bills':
        outcome = await commitVendorBillTemplateRow(data);
        break;
      case 'template_opening_register':
        outcome = await commitOpeningRegisterRow(data);
        break;
      default:
        throw new Error(`No commit path for an import of kind "${kind}".`);
    }

    if (outcome?.matched) {
      // Not counted as created: the row names a record another entry made. What
      // it did create (a child written for that person) is listed, and a revert
      // undoes only that list.
      tally.skipped += 1;
      await recordRowOutcome(row, {
        status: 'matched',
        entityType: outcome.entityType,
        entityId: outcome.entityId,
        created: outcome.created ?? [],
        message: 'Matched an existing record. This import did not create it, so a revert leaves it.',
      });
    } else if (outcome) {
      tally.created[outcome.entityType] = (tally.created[outcome.entityType] ?? 0) + 1;
      await recordRowOutcome(row, {
        status: 'committed',
        entityType: outcome.entityType,
        entityId: outcome.entityId,
        created: outcome.created ?? [{ entityType: outcome.entityType, entityId: outcome.entityId }],
        message: null,
      });
    } else {
      tally.skipped += 1;
      await recordRowOutcome(row, { status: 'skipped' });
    }
  } catch (error) {
    const message = (error as Error).message;
    tally.errors.push({ rowNumber: row.rowNumber, message });
    await recordRowOutcome(row, { status: 'error', message });
  }
}

// ---- per-kind commits -----------------------------------------------------

async function commitLedgerRow(data: Record<string, unknown>, options: Record<string, unknown>, tx: DbTx) {
  const chart = (options.chart ?? {}) as Record<string, string>;
  const ledger = String(data.ledger ?? '');
  const contra = String(data.contraAccount ?? '');
  const side = String(data.side ?? 'debit');
  const amount = paiseOf(data.amount);
  if (!ledger || amount === 0n) return null;
  const txnDate = new Date(String(data.txnDate));
  await assertPeriodPostableInTx(tx, txnDate);

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
    tx,
  );

  const categoryId = await ensureCategory(
    categoryName,
    categoryName === SETTLEMENT_CATEGORY_NAME ? 'transfer' : categoryKindFor(categoryName, chart),
    tx,
  );

  const txn = await writeTransactionMinor(
    {
      txnDate,
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
    },
    tx,
  );

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

async function commitBankRow(data: Record<string, unknown>, options: Record<string, unknown>, tx: DbTx) {
  // An opening-balance line sets the account's starting figure rather than
  // creating a transaction, so the running balance in the file and the balance
  // the platform computes agree from the first row.
  if (data.openingBalance !== undefined) return null;

  const accountId = String(options.accountId ?? '');
  if (!accountId) {
    throw new Error('No account was chosen for this statement. Pick the bank account it belongs to and commit again.');
  }

  const txnDate = new Date(String(data.txnDate));
  await assertPeriodPostableInTx(tx, txnDate);

  const narration = String(data.narration ?? '');
  const txn = await writeTransactionMinor(
    {
      txnDate,
      direction: String(data.direction) === 'in' ? 'in' : 'out',
      amount: paiseOf(data.amount),
      accountId,
      categoryId: options.defaultCategoryId ? String(options.defaultCategoryId) : null,
      division: String(options.defaultDivision ?? 'shared'),
      counterparty: data.counterparty ? String(data.counterparty) : null,
      method: 'bank_transfer',
      reference: data.reference ? String(data.reference) : null,
      note: narration,
      source: 'bank_import',
    },
    tx,
  );
  return { entityType: 'transaction', entityId: txn.id };
}

async function commitAccountRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const name = String(data.name ?? '');
  if (!name) return null;
  // Not a chunk kind (CHUNKED_KINDS): there is no transaction to pass, so the
  // scoped client writes, as it always has for this kind.
  const db = prisma as unknown as DbTx;
  const classified = classifyLedger(name);
  // Looked up before ensuring, because ensure returns an existing id and a
  // created one alike; a revert must leave the first kind of row alone.
  if (classified.kind === 'account') {
    const existed = await db.ledgerAccount.findFirst({
      where: { tenantId: auth.tenantId, name },
      select: { id: true },
    });
    const entityId = await ensureAccount(name, classified.accountType, db);
    return { entityType: 'ledgerAccount', entityId, matched: existed !== null };
  }
  const existed = await db.ledgerCategory.findFirst({ where: { tenantId: auth.tenantId, name }, select: { id: true } });
  const entityId = await ensureCategory(name, classified.categoryKind, db);
  return { entityType: 'ledgerCategory', entityId, matched: existed !== null };
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
  const raw = String(v ?? '')
    .toUpperCase()
    .trim();
  if (!raw) return '';
  return DIVISION_CODES[raw] ? raw : (DIVISION_NAMES[raw] ?? raw);
};

// The job master is made here on the import path, and this is where its subject is registered.
registerGovernedEntities('hcm_employment', ['job']);

async function ensureOrgUnit(name: string, division: string): Promise<string> {
  const auth = currentAuth();
  const existing = await prisma.orgUnit.findFirst({ where: { tenantId: auth.tenantId, name } });
  if (existing) return existing.id;
  const created = await prisma.orgUnit.create({
    data: { tenantId: auth.tenantId, name, unitType: 'department', division },
  });
  await auditWrite({
    action: 'create',
    subjectType: 'unit',
    subjectId: created.id,
    after: { name, unitType: 'department', division },
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
  await auditWrite({
    action: 'create',
    subjectType: 'job',
    subjectId: created.id,
    after: { title, jobFamily, jobLevel },
  });
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
}): Promise<{ employmentId: string; created: CreatedRecord[] }> {
  const auth = currentAuth();

  const existing = await prisma.employmentRelationship.findFirst({
    where: { tenantId: auth.tenantId, personId: input.personId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return { employmentId: existing.id, created: [] };

  // The seat, and the employment and assignment that fill it, are what this
  // call makes; the org unit and job it hangs them on are masters, kept as the
  // other masters are, and not listed.
  const created: CreatedRecord[] = [];
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

  await auditWrite({
    action: 'create',
    subjectType: 'position',
    subjectId: position.id,
    after: { orgUnitId, jobId, status: 'Filled' },
  });
  created.push({ entityType: 'position', entityId: position.id });

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

  await auditWrite({
    action: 'create',
    subjectType: 'employment_relationship',
    subjectId: employment.id,
    after: { personId: input.personId, hireEffectiveDate, status: 'Active' },
  });

  const assignment = await prisma.assignment.create({
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
  await auditWrite({
    action: 'create',
    subjectType: 'assignment',
    subjectId: assignment.id,
    after: { employmentRelationshipId: employment.id, positionId: position.id, effectiveFrom: hireEffectiveDate },
    meta: { reasonCode: 'imported_baseline' },
  });
  created.push({ entityType: 'employmentRelationship', entityId: employment.id });
  created.push({ entityType: 'assignment', entityId: assignment.id });

  return { employmentId: employment.id, created };
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

  // The employee affiliation written below carries roleSlug 'employee' when it
  // is created, which is a role assignment. Checked before any person write
  // here, so a refused row writes nothing; the importer must cover the role.
  const existingEmployee = existing
    ? await prisma.affiliation.findFirst({
        where: { tenantId: auth.tenantId, partyId: existing.id, affiliationType: 'employee' },
      })
    : null;
  if (!existingEmployee) {
    await assertCanAssignRole({ roleSlug: 'employee', targetPartyId: existing?.id ?? null });
  }

  // Only fields the file actually carried are written. A staff list that omits
  // a birthday must not blank one somebody typed in.
  const held = {
    ...(email ? { primaryEmail: email, primaryEmailNormalised: email } : {}),
    ...(data.dateOfBirth ? { dateOfBirth: new Date(String(data.dateOfBirth)) } : {}),
    ...(data.bloodGroup ? { bloodGroup: String(data.bloodGroup) } : {}),
  };

  // What this row makes, for its revert: a new person, and the children written
  // for them. A matched person is not made here, so only their children are listed.
  const created: CreatedRecord[] = [];

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
  if (existing) {
    await auditWrite({
      action: 'update',
      subjectType: 'person',
      subjectId: person.id,
      before: { fullName: existing.fullName, primaryEmail: existing.primaryEmail },
      after: { fullName },
      meta: { source: 'import', fieldsSet: Object.keys(held) },
    });
  } else {
    await auditWrite({
      action: 'create',
      subjectType: 'person',
      subjectId: person.id,
      after: { fullName, recordCode: person.recordCode },
      meta: { source: 'import' },
    });
    created.push({ entityType: 'person', entityId: person.id });
  }

  const divisionCode = divisionCodeOf(data.division);
  const mapped = DIVISION_CODES[divisionCode] ?? { division: 'shared', unit: 'Corporate' };

  const affiliation = await prisma.affiliation.findFirst({
    where: { tenantId: auth.tenantId, partyId: person.id, affiliationType: 'employee' },
  });
  if (!affiliation) {
    const madeAffiliation = await prisma.affiliation.create({
      data: {
        tenantId: auth.tenantId,
        partyId: person.id,
        affiliationType: 'employee',
        counterpartyName: 'Kaizen Infinities',
        // Everybody imported from a staff list is an employee, so the row names
        // the employee role. That is a grant, and assertCanAssignRole above is
        // what stops an importer naming a role they do not cover. Authority
        // beyond employee stays a separate decision made in the product.
        roleSlug: 'employee',
        primaryFlag: true,
        status: 'active',
        branch: data.branch ? String(data.branch) : null,
        statutoryRetentionFloor: true,
      },
    });
    await auditWrite({
      action: 'create',
      subjectType: 'affiliation',
      subjectId: madeAffiliation.id,
      after: { partyId: person.id, affiliationType: 'employee', roleSlug: 'employee', status: 'active' },
      meta: { source: 'import' },
    });
    created.push({ entityType: 'affiliation', entityId: madeAffiliation.id });
  }

  const employment = await ensureEmployment({
    personId: person.id,
    designation: data.designation ? String(data.designation) : null,
    divisionCode,
    branch: data.branch ? String(data.branch) : null,
    joiningYear: data.joiningYear ? String(data.joiningYear) : null,
    hireDate: data.joiningDate ? String(data.joiningDate) : null,
  });
  created.push(...employment.created);

  // A person already on file is updated in place, not made. Their fields stay as
  // this import set them when it reverts: the revert does not restore prior values.
  return { entityType: 'person', entityId: person.id, matched: existing !== undefined, created };
}

async function commitSalaryRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const fullName = String(data.fullName ?? '').trim();
  const amount = Number(data.monthlyAmount ?? 0);
  if (!fullName || !amount) return null;
  const amountMinor = rupeesToMinor(amount);

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
    throw new Error(
      `"${fullName}" is on file but holds no employment relationship, so there is nothing to attach pay to.`,
    );
  }

  // A pay record a revert voided is not this pay: it is not reused, and the
  // record written below does not supersede it.
  const existing = await prisma.compensationRecord.findFirst({
    where: { tenantId: auth.tenantId, employmentRelationshipId: employment.id, status: 'Effective', voidedAt: null },
  });
  // Matched, not created: the record belongs to whichever entry made it, so this
  // batch's revert must leave it: a matched row undoes only what it created, and
  // this one creates nothing (created is empty for a matched salary row).
  if (existing && existing.amountMinor === amountMinor) {
    return { entityType: 'compensationRecord', entityId: existing.id, matched: true };
  }

  // The new record and the supersede of the one it replaces are one governed
  // write. The superseded record is listed with its action, so a revert puts it
  // back to Effective if nothing has replaced it since (restoreSupersededIn), and
  // never voids it: it was not this batch's to void.
  const created: CreatedRecord[] = [];
  let madeId = '';
  await governedWrite(async (tx) => {
    const record = await tx.compensationRecord.create({
      data: {
        tenantId: auth.tenantId,
        employmentRelationshipId: employment.id,
        amountMinor,
        currency: 'INR',
        revisionReason: 'imported_baseline',
        status: 'Effective',
        effectiveFrom: new Date(),
      },
    });
    madeId = record.id;
    created.push({ entityType: 'compensationRecord', entityId: record.id });
    await auditWrite({
      action: 'create',
      subjectType: 'compensation_record',
      subjectId: record.id,
      after: { amount, amountMinor: amountMinor.toString(), status: 'Effective' },
      tx,
    });
    await emit({
      name: EVENTS.COMPENSATION_RECORD_CREATED,
      subject: { entityType: 'compensation_record', entityId: record.id },
      newState: { amount, amountMinor: amountMinor.toString(), status: 'Effective' },
      impact: { domains: ['hr'] },
      tx,
    });

    if (existing) {
      const effectiveTo = new Date();
      await tx.compensationRecord.update({
        where: { id: existing.id },
        data: { status: 'Superseded', effectiveTo },
      });
      created.push({ entityType: 'compensationRecord', entityId: existing.id, action: 'superseded' });
      await auditWrite({
        action: 'update',
        subjectType: 'compensation_record',
        subjectId: existing.id,
        before: { status: 'Effective', effectiveTo: existing.effectiveTo },
        after: { status: 'Superseded', effectiveTo },
        tx,
      });
      await emit({
        name: EVENTS.COMPENSATION_RECORD_SUPERSEDED,
        subject: { entityType: 'compensation_record', entityId: existing.id },
        newState: { status: 'Superseded', effectiveTo },
        related: [{ relation: 'replaced_by', entityType: 'compensation_record', entityId: record.id }],
        impact: { domains: ['hr'] },
        tx,
      });
    }
  });

  return { entityType: 'compensationRecord', entityId: madeId, created };
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

  // The days this row makes live: created, or a voided day taken back. A day
  // already live is another batch's and is skipped, so it is not listed here,
  // and a revert of this row never voids it.
  const createdDays: CreatedRecord[] = [];
  let written = 0;
  for (const day of days) {
    const workDate = new Date(day.date);
    const existing = await prisma.workAttendance.findFirst({
      where: { tenantId: auth.tenantId, employmentRelationshipId: employment.id, workDate },
    });
    if (existing && existing.voidedAt === null) continue;
    // `status` on this model is the lifecycle state — Recorded, Disputed,
    // Approved — and not whether somebody turned up. The presence mark is the
    // note, and the minutes carry it in a form payroll can add up.
    const figures = {
      workedMinutes: day.status === 'present' ? 480 : day.status === 'half_day' ? 240 : 0,
      note: `Imported: ${day.status}`,
    };
    if (existing) {
      // A day a revert voided is taken back under its own key. WorkAttendance
      // is unique per employment and day, so a new row would fail on the key
      // the voided one still holds; the audit row names the void it reverses.
      await governedWrite(async (tx) => {
        await tx.workAttendance.update({
          where: { id: existing.id },
          data: {
            ...figures,
            status: 'Recorded',
            overtimeMinutes: 0,
            missingPunch: false,
            voidedAt: null,
            voidedById: null,
            voidReason: null,
            voidBatchId: null,
          },
        });
        await auditWrite({
          action: 'update',
          subjectType: 'work_attendance',
          subjectId: existing.id,
          before: {
            voidedAt: existing.voidedAt,
            voidBatchId: existing.voidBatchId,
            workedMinutes: existing.workedMinutes,
          },
          after: { voidedAt: null, voidBatchId: null, ...figures },
          tx,
        });
        await emit({
          name: EVENTS.WORK_ATTENDANCE_RECORDED,
          subject: { entityType: 'work_attendance', entityId: existing.id },
          newState: { workDate, workedMinutes: figures.workedMinutes, revivedFromVoid: true },
          impact: { domains: ['hr'] },
          tx,
        });
      });
      createdDays.push({ entityType: 'workAttendance', entityId: existing.id });
    } else {
      const madeDay = await prisma.workAttendance.create({
        data: {
          tenantId: auth.tenantId,
          employmentRelationshipId: employment.id,
          workDate,
          status: 'Recorded',
          ...figures,
        },
      });
      createdDays.push({ entityType: 'workAttendance', entityId: madeDay.id });
    }
    written += 1;
  }

  if (written === 0) return null;
  return { entityType: 'workAttendance', entityId: employment.id, created: createdDays };
}

// ---------------------------------------------------------------------------

/**
 * Undo, by reversal.
 *
 * A recorded fact is never removed. Each row the batch wrote is undone by the
 * means its kind allows, and the undo is itself a record:
 *
 *   - a Transaction gets a reversal row (books.ts reverseTransactionIn), and any
 *     bank line matched to it is unmatched, so the statement stops claiming a
 *     match to an entry that no longer counts;
 *   - a share allotment is reversed and its certificate cancelled, as
 *     reverseShareTransaction does (domains/equity.ts);
 *   - pay and attendance rows are tombstoned (voidedAt, voidReason, voidBatchId),
 *     and every reader leaves them out.
 *
 * Each row is one transaction, so a row that cannot be undone (a split across
 * business lines, a filed GST month, a locked day, a period that is closed
 * today) is reported with its reason and leaves the rest of the batch undone.
 * The batch is `reverted` only when no committed row is left; `revert_partial`
 * when some are undone and some are not.
 */
export async function revertImport(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'imports', verb: 'delete' });

  const exists = await prisma.importBatch.findFirst({ where: { id, tenantId: auth.tenantId }, select: { id: true } });
  if (!exists) throw ApiError.notFound('Import');

  // The same lock commit takes, so a revert cannot interleave with a commit of
  // the batch. The status is read again under it: a commit that held the lock
  // a moment ago may have finished, or may still be running.
  return withBatchLock(auth.tenantId, id, () => revertUnderLock(id));
}

/** A batch a revert may start from: committed, or partly reverted by an earlier run. */
const REVERTABLE_STATUSES = new Set(['committed', 'revert_partial']);

/**
 * The kinds whose legacy rows (committed before ImportRow.created) are refused:
 * a person-bearing row (staff, contact, student) or an attendance row. See
 * revertUnderLock.
 */
const LEGACY_REFUSED_KINDS = new Set([
  'employees',
  'template_staff',
  'template_contacts',
  'template_students',
  'student_register',
  'attendance',
]);

interface RevertFailure {
  rowNumber: number;
  message: string;
}

interface RowRevert {
  /** `kept` is for rows whose record a revert deliberately leaves on the books (see revertRowIn). */
  status: 'reverted' | 'kept';
  reversalIds: string[];
  unmatched: number;
  message: string | null;
}

async function revertUnderLock(id: string) {
  const auth = currentAuth();
  const batch = await prisma.importBatch.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!batch) throw ApiError.notFound('Import');
  if (!REVERTABLE_STATUSES.has(batch.status)) throw ApiError.conflict('Only a committed import can be reverted.');

  // A batch committed before ImportRow.created existed cannot say which of its
  // rows it created and which it only matched. For these kinds, undoing the row
  // by its entity type voids a matched person, or another batch's attendance
  // days (FX-71a), so the whole batch is refused before any row is touched. A
  // legacy row of any other kind is not refused: it keeps the revert it had.
  if (LEGACY_REFUSED_KINDS.has(batch.kind)) {
    const legacy = await prisma.importRow.findFirst({
      where: {
        tenantId: auth.tenantId,
        batchId: id,
        status: { in: ['committed', 'matched'] },
        created: { equals: Prisma.DbNull },
      },
      select: { rowNumber: true },
      orderBy: { rowNumber: 'asc' },
    });
    if (legacy) {
      throw ApiError.conflict(
        `This import predates per-row tracking, so the revert cannot tell what row ${legacy.rowNumber} created from what it matched. ` +
          'Nothing has been reverted. Correct the records it touched by hand.',
      );
    }
  }

  // A matched row is visited only when it created something: a matched row
  // with nothing on its created list has nothing for a revert to undo. A matched
  // row committed before the list existed (created null) is left alone, since
  // what it made was never recorded.
  const rows = (
    await prisma.importRow.findMany({
      where: { tenantId: auth.tenantId, batchId: id, status: { in: ['committed', 'matched'] } },
      orderBy: { rowNumber: 'asc' },
    })
  ).filter((r) => r.status === 'committed' || (Array.isArray(r.created) && r.created.length > 0));
  // Share rows are reversed by the share register's own rule, which needs its
  // two grants. Asserted once for the batch, before any row is touched.
  if (rows.some((r) => r.entityType === 'shareTransaction')) {
    await assertCan({ resource: 'share_ledger', verb: 'create' });
    await assertCan({ resource: 'share_ledger', verb: 'approve' });
  }

  const removed: Record<string, number> = {};
  const reversalIds: string[] = [];
  const failed: RevertFailure[] = [];
  let unmatched = 0;

  try {
    for (const row of rows) {
      try {
        // One transaction per row: the undo and the row's new status commit
        // together, so a row is never reversed and still reads committed.
        const outcome = await prisma.$transaction(
          async (tx) => {
            const result = await revertRowIn(tx, row, batch);
            await tx.importRow.update({
              where: { id: row.id },
              data: { status: result.status, message: result.message },
            });
            return result;
          },
          { timeout: CHUNK_TIMEOUT_MS, maxWait: 10_000 },
        );
        // Counted by the row's entity type. A matched row is not a removal: its
        // record stays, and only what it created is undone.
        if (outcome.status === 'reverted' && row.status === 'committed') {
          removed[row.entityType!] = (removed[row.entityType!] ?? 0) + 1;
        }
        reversalIds.push(...outcome.reversalIds);
        unmatched += outcome.unmatched;
      } catch (error) {
        // A database fault aborts the run (rethrown below, and the batch is
        // settled from what is on the rows). Anything else is this row's
        // reason, recorded on the row, and the next row carries on.
        if (isDatabaseFault(error)) throw error;
        const message = (error as Error).message;
        failed.push({ rowNumber: row.rowNumber, message });
        await prisma.importRow.update({ where: { id: row.id }, data: { message: `Not reverted: ${message}` } });
      }
    }
  } finally {
    await settleRevertedBatch(id, batch, removed, reversalIds, unmatched, failed.length);
  }

  return { removed, reversed: reversalIds.length, unmatched, failed };
}

/**
 * Sets the batch's state from its rows and, when this run undid something,
 * audits the change and emits IMPORT_REVERTED once for the batch.
 */
async function settleRevertedBatch(
  id: string,
  batch: ImportBatch,
  removed: Record<string, number>,
  reversalIds: string[],
  unmatched: number,
  failedCount: number,
) {
  const auth = currentAuth();
  const remaining = await prisma.importRow.count({
    where: { tenantId: auth.tenantId, batchId: id, status: 'committed' },
  });
  const undone = await prisma.importRow.count({
    where: { tenantId: auth.tenantId, batchId: id, status: 'reverted' },
  });
  const status = remaining === 0 ? 'reverted' : undone > 0 ? 'revert_partial' : batch.status;
  if (status === batch.status && reversalIds.length === 0) return;

  const prior = (batch.stats ?? {}) as { reverted?: Record<string, number>; reversalIds?: string[] };
  const counts: Record<string, number> = { ...(prior.reverted ?? {}) };
  for (const [kind, n] of Object.entries(removed)) counts[kind] = (counts[kind] ?? 0) + n;

  await governedWrite(async (tx) => {
    await tx.importBatch.update({
      where: { id },
      data: {
        status,
        revertedAt: new Date(),
        stats: {
          ...(batch.stats as object),
          reverted: counts,
          reversalIds: [...(prior.reversalIds ?? []), ...reversalIds],
        } as never,
      },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'import_batch',
      subjectId: id,
      before: { status: batch.status },
      after: { status, reversed: reversalIds.length, failed: failedCount },
      tx,
    });
    // Once per batch per run, after the rows: the batch's own announcement.
    if (reversalIds.length > 0 || status !== batch.status) {
      await emit({
        name: EVENTS.IMPORT_REVERTED,
        subject: { entityType: 'import_batch', entityId: id },
        newState: { status, removed: counts, unmatched, failed: failedCount },
        impact: { domains: ['fin'] },
        tx,
      });
    }
  });
}

/**
 * One row's undo, inside the transaction that will hold its status. Throws
 * with the reason when the row cannot be undone; the caller records it.
 *
 * A row committed since ImportRow.created exists is undone by that list, and
 * nothing else: a record the row only matched belongs to another entry. A row
 * committed before the column is refused whole before any row is touched (see
 * revertUnderLock) when it is of a kind that can over-revert; the rest are
 * undone by entityType, as they always were.
 */
async function revertRowIn(tx: DbTx, row: ImportRow, batch: ImportBatch): Promise<RowRevert> {
  const reason = `Import ${batch.recordCode} reverted`;
  const created = row.created as CreatedRecord[] | null;

  if (created === null) return revertLegacyRowIn(tx, row, batch, reason);

  if (row.status === 'matched') {
    // The record it matched stays. What the row created is reversed.
    const { reversalIds, unmatched, messages } = await undoCreatedIn(tx, created, batch, reason);
    return {
      status: 'reverted',
      reversalIds,
      unmatched,
      message: ['The record this row matched stays on file. Only what the row created is reversed.', ...messages].join(
        ' ',
      ),
    };
  }

  const undoable = created.filter((c) => !KEPT_KINDS.has(c.entityType));
  if (undoable.length === 0) return keptRowRevert(created[0]?.entityType ?? row.entityType ?? 'record');
  const { reversalIds, unmatched, messages } = await undoCreatedIn(tx, undoable, batch, reason);
  return { status: 'reverted', reversalIds, unmatched, message: messages.length > 0 ? messages.join(' ') : null };
}

/** A record an import row created, as ImportRow.created lists it. */
interface CreatedRecord {
  entityType: string;
  entityId: string;
  /**
   * Set on a pay record this row superseded rather than created. A revert then
   * restores that record to Effective, if nothing has replaced it since; it never
   * voids it.
   */
  action?: 'superseded';
}

/**
 * Masters an import creates or finds: accounts, categories, courses, cohorts,
 * organisations and vendor bills. A revert keeps them, because a later import
 * may already use them, and accounts and categories are almost always right
 * even when the transactions are not. A row that made one reports it as kept.
 */
const KEPT_KINDS = new Set(['ledgerAccount', 'ledgerCategory', 'course', 'cohort', 'organization', 'vendorBill']);

function keptRowRevert(entityType: string): RowRevert {
  return {
    status: 'kept',
    reversalIds: [],
    unmatched: 0,
    message: `Kept: a revert does not remove a ${entityType} record.`,
  };
}

/** A row committed before ImportRow.created existed: undone by its entityType, as before. */
async function revertLegacyRowIn(tx: DbTx, row: ImportRow, batch: ImportBatch, reason: string): Promise<RowRevert> {
  if (!row.entityId || !row.entityType) throw new Error('This row has no record on file to undo.');
  if (KEPT_KINDS.has(row.entityType)) return keptRowRevert(row.entityType);
  if (row.entityType === 'workAttendance') {
    await legacyVoidAttendanceIn(tx, row, batch, reason);
    return { status: 'reverted', reversalIds: [], unmatched: 0, message: null };
  }
  const { reversalIds, unmatched, message } = await undoRecordIn(
    tx,
    { entityType: row.entityType, entityId: row.entityId },
    batch,
    reason,
  );
  return { status: 'reverted', reversalIds, unmatched, message: message ?? null };
}

async function undoCreatedIn(tx: DbTx, items: CreatedRecord[], batch: ImportBatch, reason: string) {
  const reversalIds: string[] = [];
  const messages: string[] = [];
  let unmatched = 0;
  for (const item of items) {
    const one = await undoRecordIn(tx, item, batch, reason);
    reversalIds.push(...one.reversalIds);
    unmatched += one.unmatched;
    if (one.message) messages.push(one.message);
  }
  return { reversalIds, unmatched, messages };
}

/** Undoes one record a batch created. Throws with the reason when it cannot. */
async function undoRecordIn(
  tx: DbTx,
  item: CreatedRecord,
  batch: ImportBatch,
  reason: string,
): Promise<{ reversalIds: string[]; unmatched: number; message?: string }> {
  const auth = currentAuth();
  switch (item.entityType) {
    case 'transaction': {
      const original = await tx.transaction.findFirst({
        where: { id: item.entityId, tenantId: auth.tenantId, deletedAt: null },
        select: { id: true, txnDate: true },
      });
      if (!original) throw new Error('The entry this row wrote is no longer on file.');
      await refuseIfGstFiled(tx, original.txnDate);
      const split = await tx.lineDistribution.count({
        where: { tenantId: auth.tenantId, transactionId: original.id },
      });
      if (split > 0) {
        throw ApiError.unprocessable(
          'This entry is split across business lines. Remove the split before reverting the import.',
        );
      }
      const reversal = await reverseTransactionIn(tx, original.id, { reason, batchId: batch.id });
      const unmatched = await unmatchBankLinesIn(tx, original.id);
      return { reversalIds: [reversal.id], unmatched };
    }

    case 'compensationRecord': {
      if (item.action === 'superseded') {
        const message = await restoreSupersededIn(tx, item, batch, reason);
        return { reversalIds: [], unmatched: 0, message };
      }
      const record = await tx.compensationRecord.findFirst({
        where: { id: item.entityId, tenantId: auth.tenantId, voidedAt: null },
        select: { id: true },
      });
      if (!record) throw new Error('The pay record this row wrote is no longer on file.');
      await tombstoneIn(tx, 'compensation_record', record.id, reason, batch.id);
      // Pay rows carry no unique key, so a tombstoned one does not block a later import.
      return { reversalIds: [], unmatched: 0 };
    }

    case 'workAttendance': {
      await voidAttendanceDayIn(tx, item.entityId, batch, reason);
      return { reversalIds: [], unmatched: 0 };
    }

    case 'shareTransaction': {
      // Imported by the opening register. Reversed by the share register's own
      // rule, which keeps the original, cancels its certificate and writes the
      // reversal row.
      const { reverseShareTransactionIn } = await import('../domains/equity.js');
      const { reversal } = await reverseShareTransactionIn(tx, item.entityId, reason);
      return { reversalIds: [reversal.id], unmatched: 0 };
    }

    case 'person': {
      // Soft-deleted rather than removed. A person may already be referenced by a
      // leave request or an employment record by now, and the statutory retention
      // floor on an employee affiliation means deleting one is not the platform's
      // call anyway. Only a person this batch created is listed here: a matched
      // person is another entry's and is never undone.
      const before = await tx.person.findFirstOrThrow({
        where: { id: item.entityId, tenantId: auth.tenantId },
        select: { deletedAt: true },
      });
      const at = new Date();
      await tx.person.update({ where: { id: item.entityId }, data: { deletedAt: at } });
      await auditWrite({
        action: 'update',
        subjectType: 'person',
        subjectId: item.entityId,
        before: { deletedAt: before.deletedAt },
        after: { deletedAt: at, reason },
        tx,
      });
      await emit({
        name: EVENTS.PERSON_DELETED,
        subject: { entityType: 'person', entityId: item.entityId },
        newState: { deletedAt: at },
        impact: { domains: ['idn'] },
        tx,
      });
      return { reversalIds: [], unmatched: 0 };
    }

    case 'enrollment': {
      // Withdrawn rather than deleted. An enrolment with attendance or a fee
      // receipted against it is a record of something that happened, and
      // reverting the import that created it does not unhappen that.
      const before = await tx.enrollment.findFirstOrThrow({
        where: { id: item.entityId, tenantId: auth.tenantId },
        select: { status: true },
      });
      await tx.enrollment.update({ where: { id: item.entityId }, data: { status: 'withdrawn' } });
      await auditWrite({
        action: 'update',
        subjectType: 'enrollment',
        subjectId: item.entityId,
        before: { status: before.status },
        after: { status: 'withdrawn', reason },
        tx,
      });
      await emit({
        name: EVENTS.ENROLLMENT_WITHDRAWN,
        subject: { entityType: 'enrollment', entityId: item.entityId },
        newState: { status: 'withdrawn' },
        impact: { domains: ['edu'] },
        tx,
      });
      return { reversalIds: [], unmatched: 0 };
    }

    case 'studentProfile': {
      // The learner record a register import made for a new student. Soft-deleted
      // as the person is: the register, and any billing read off it, keep the
      // fact that the learner was on file.
      const live = await tx.studentProfile.findFirst({
        where: { id: item.entityId, tenantId: auth.tenantId, deletedAt: null },
        select: { id: true, status: true },
      });
      if (!live) throw new Error('The student record this row wrote is no longer on file.');
      const at = new Date();
      await tx.studentProfile.update({ where: { id: live.id }, data: { deletedAt: at } });
      await auditWrite({
        action: 'update',
        subjectType: 'student_profile',
        subjectId: live.id,
        before: { status: live.status },
        after: { deletedAt: at, reason },
        tx,
      });
      await emit({
        name: EVENTS.STUDENT_PROFILE_ENDED,
        subject: { entityType: 'student_profile', entityId: live.id },
        newState: { deletedAt: at },
        impact: { domains: ['edu'] },
        tx,
      });
      return { reversalIds: [], unmatched: 0 };
    }

    case 'affiliation':
    case 'employmentRelationship':
    case 'position':
    case 'assignment':
      await endCreatedIn(tx, item, batch, reason);
      return { reversalIds: [], unmatched: 0 };

    default:
      throw new Error(`No revert path for a row written as ${item.entityType}.`);
  }
}

/**
 * Puts back the pay record a batch superseded, if the batch's own record is the
 * only thing that replaced it. A record that is voided, or that a later record
 * has replaced, stays as it is, and the row says why. Returns the reason the
 * record was not restored, or nothing when it was.
 */
async function restoreSupersededIn(
  tx: DbTx,
  item: CreatedRecord,
  batch: ImportBatch,
  reason: string,
): Promise<string | undefined> {
  const auth = currentAuth();
  const prior = await tx.compensationRecord.findFirst({
    where: { id: item.entityId, tenantId: auth.tenantId },
    select: { id: true, status: true, voidedAt: true, effectiveTo: true, employmentRelationshipId: true },
  });
  if (!prior) return 'Not restored: the pay record this import superseded is no longer on file.';
  if (prior.voidedAt !== null || prior.status !== 'Superseded') {
    const state = prior.voidedAt !== null ? 'voided' : prior.status;
    return `Not restored: the pay record this import superseded is ${state}, so it stays as it is.`;
  }
  const later = await tx.compensationRecord.findFirst({
    where: {
      tenantId: auth.tenantId,
      employmentRelationshipId: prior.employmentRelationshipId,
      id: { not: prior.id },
      voidedAt: null,
      status: { not: 'Superseded' },
    },
    select: { id: true },
  });
  if (later) return `Not restored: a later pay record (${later.id}) replaced it, so it stays Superseded.`;

  await tx.compensationRecord.update({
    where: { id: prior.id },
    data: { status: 'Effective', effectiveTo: null },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'compensation_record',
    subjectId: prior.id,
    before: { status: 'Superseded', effectiveTo: prior.effectiveTo },
    after: { status: 'Effective', effectiveTo: null, reason, batchId: batch.id },
    tx,
  });
  await emit({
    name: EVENTS.COMPENSATION_RECORD_RESTORED,
    subject: { entityType: 'compensation_record', entityId: prior.id },
    newState: { status: 'Effective' },
    impact: { domains: ['hr'] },
    tx,
  });
  return undefined;
}

/**
 * Ends a record an employee or contact import created, for a matched person or
 * a new one. None of these has a void column, so each is ended by the model's
 * own state (deletedAt, or the superseded state an assignment already uses),
 * with an audit row naming the batch and an event for the end. The row stays
 * for the register.
 */
async function endCreatedIn(tx: DbTx, item: CreatedRecord, batch: ImportBatch, reason: string) {
  const auth = currentAuth();
  const at = new Date();
  const subjectId = item.entityId;
  switch (item.entityType) {
    case 'affiliation': {
      const live = await tx.affiliation.findFirst({
        where: { id: subjectId, tenantId: auth.tenantId, deletedAt: null },
        select: { status: true },
      });
      if (!live) throw new Error('The affiliation this row wrote is no longer on file.');
      await tx.affiliation.update({ where: { id: subjectId }, data: { status: 'ended', deletedAt: at } });
      await auditWrite({
        action: 'update',
        subjectType: 'affiliation',
        subjectId,
        before: { status: live.status },
        after: { status: 'ended', reason },
        tx,
      });
      await emit({
        name: EVENTS.AFFILIATION_ENDED,
        subject: { entityType: 'affiliation', entityId: subjectId },
        newState: { status: 'ended' },
        impact: { domains: ['idn'] },
        tx,
      });
      return;
    }

    case 'employmentRelationship': {
      const live = await tx.employmentRelationship.findFirst({
        where: { id: subjectId, tenantId: auth.tenantId, deletedAt: null },
        select: { status: true },
      });
      if (!live) throw new Error('The employment this row wrote is no longer on file.');
      await tx.employmentRelationship.update({ where: { id: subjectId }, data: { deletedAt: at } });
      await auditWrite({
        action: 'update',
        subjectType: 'employment_relationship',
        subjectId,
        before: { status: live.status },
        after: { deletedAt: at, reason },
        tx,
      });
      await emit({
        name: EVENTS.EMPLOYMENT_RELATIONSHIP_ENDED,
        subject: { entityType: 'employment_relationship', entityId: subjectId },
        newState: { deletedAt: at },
        impact: { domains: ['hr'] },
        tx,
      });
      return;
    }

    case 'position': {
      const live = await tx.position.findFirst({
        where: { id: subjectId, tenantId: auth.tenantId, deletedAt: null },
        select: { status: true },
      });
      if (!live) throw new Error('The position this row wrote is no longer on file.');
      await tx.position.update({ where: { id: subjectId }, data: { deletedAt: at } });
      await auditWrite({
        action: 'update',
        subjectType: 'position',
        subjectId,
        before: { status: live.status },
        after: { deletedAt: at, reason },
        tx,
      });
      await emit({
        name: EVENTS.POSITION_ENDED,
        subject: { entityType: 'position', entityId: subjectId },
        newState: { deletedAt: at },
        impact: { domains: ['hr'] },
        tx,
      });
      return;
    }

    case 'assignment': {
      const live = await tx.assignment.findFirst({
        where: { id: subjectId, tenantId: auth.tenantId, rowStatus: 'Effective' },
        select: { rowStatus: true },
      });
      if (!live) throw new Error('The assignment this row wrote is no longer on file.');
      await tx.assignment.update({
        where: { id: subjectId },
        data: { rowStatus: 'Superseded', effectiveTo: at },
      });
      await auditWrite({
        action: 'update',
        subjectType: 'assignment',
        subjectId,
        before: { rowStatus: live.rowStatus },
        after: { rowStatus: 'Superseded', effectiveTo: at, reason },
        tx,
      });
      await emit({
        name: EVENTS.ASSIGNMENT_ENDED,
        subject: { entityType: 'assignment', entityId: subjectId },
        newState: { rowStatus: 'Superseded', effectiveTo: at },
        impact: { domains: ['hr'] },
        tx,
      });
      return;
    }

    default:
      throw new Error(`No end path for a ${item.entityType} record.`);
  }
}

/** pending A14 (owner): the GST filing lock is applied to an import revert by default, until the owner decides. */
async function refuseIfGstFiled(tx: DbTx, txnDate: Date): Promise<void> {
  const filed = await filedReturnFor(txnDate, tx);
  if (!filed) return;
  throw ApiError.unprocessable(
    `This entry is dated ${filed.period}, and ${filed.returnType} for ${filed.period} was filed as ${filed.recordCode}. ` +
      'Reverting it would change a month already reported, so this row is not reverted.',
    { period: filed.period, filing: filed.recordCode, returnType: filed.returnType },
  );
}

/** Clears the match on every bank line that points at a reversed entry, and audits each. */
async function unmatchBankLinesIn(tx: DbTx, transactionId: string): Promise<number> {
  const auth = currentAuth();
  const lines = await tx.bankStatementLine.findMany({
    where: { tenantId: auth.tenantId, matchedTransactionId: transactionId },
    select: { id: true, matchedAt: true },
  });
  for (const line of lines) {
    await tx.bankStatementLine.update({
      where: { id: line.id },
      data: { matchedTransactionId: null, matchedAt: null },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'bank_statement_line',
      subjectId: line.id,
      before: { matchedTransactionId: transactionId, matchedAt: line.matchedAt },
      after: { matchedTransactionId: null, matchedAt: null },
      tx,
    });
    await emit({
      name: EVENTS.BANK_STATEMENT_LINE_UNMATCHED,
      subject: { entityType: 'bank_statement_line', entityId: line.id },
      related: [{ relation: 'was_matched_to', entityType: 'transaction', entityId: transactionId }],
      newState: { matchedTransactionId: null },
      impact: { domains: ['fin'] },
      tx,
    });
  }
  return lines.length;
}

/**
 * Tombstones a pay or attendance row: the record stays, every reader leaves it
 * out, and the void names the batch that made it.
 */
async function tombstoneIn(
  tx: DbTx,
  subjectType: 'compensation_record' | 'work_attendance',
  id: string,
  reason: string,
  batchId: string,
) {
  const auth = currentAuth();
  const voidedAt = new Date();
  const data = { voidedAt, voidedById: auth.partyId, voidReason: reason, voidBatchId: batchId };
  if (subjectType === 'compensation_record') {
    await tx.compensationRecord.update({ where: { id }, data });
  } else {
    await tx.workAttendance.update({ where: { id }, data });
  }
  await auditWrite({
    action: 'update',
    subjectType,
    subjectId: id,
    before: { voidedAt: null },
    after: { voidedAt, voidReason: reason, voidBatchId: batchId },
    tx,
  });
  await emit({
    name: subjectType === 'compensation_record' ? EVENTS.COMPENSATION_RECORD_VOIDED : EVENTS.WORK_ATTENDANCE_VOIDED,
    subject: { entityType: subjectType, entityId: id },
    newState: { voidedAt, voidBatchId: batchId },
    impact: { domains: ['hr'] },
    tx,
  });
}

/**
 * Voids one attendance day a batch created, by its id. The day is named on the
 * row's `created` list only when that batch wrote it: a day it found already
 * live belongs to the batch that wrote it, and is never named here, which is why
 * this takes an id and not the row's date set.
 */
async function voidAttendanceDayIn(tx: DbTx, id: string, batch: ImportBatch, reason: string) {
  const auth = currentAuth();
  const day = await tx.workAttendance.findFirst({
    where: { id, tenantId: auth.tenantId, voidedAt: null },
    select: { id: true, status: true },
  });
  if (!day) throw new Error('The attendance day this row wrote is no longer on file.');
  if (day.status === 'Locked') {
    throw ApiError.unprocessable('Payroll has locked this attendance, so it cannot be reverted.');
  }
  await tombstoneIn(tx, 'work_attendance', day.id, reason, batch.id);
}

/**
 * Rows committed before ImportRow.created existed (FX-71a). The attendance a
 * batch wrote for one employee, taken as the days in its own staged row where
 * the row still says the import wrote them. That can name a day another batch
 * wrote, so it is kept only for those old rows, which have no list to go by. A
 * day someone has since edited no longer says so, and is left alone.
 */
async function legacyVoidAttendanceIn(tx: DbTx, row: ImportRow, batch: ImportBatch, reason: string) {
  const auth = currentAuth();
  const data = openStagedNormalised(row.normalised);
  const days = Array.isArray(data?.days) ? (data!.days as Array<{ date: string }>) : [];
  const workDates = days.map((d) => new Date(d.date));
  const found = await tx.workAttendance.findMany({
    where: {
      tenantId: auth.tenantId,
      employmentRelationshipId: row.entityId!,
      workDate: { in: workDates },
      note: { startsWith: 'Imported:' },
      voidedAt: null,
    },
    select: { id: true, status: true },
  });
  if (found.length === 0) {
    throw new Error('The attendance this row wrote has since been changed or is no longer on file.');
  }
  if (found.some((r) => r.status === 'Locked')) {
    throw ApiError.unprocessable('Payroll has locked this attendance, so it cannot be reverted.');
  }
  for (const r of found) {
    await tombstoneIn(tx, 'work_attendance', r.id, reason, batch.id);
  }
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
    throw new Error(
      `"${name}" matches more than one organisation on file. Rename one of them, or import this row by hand.`,
    );
  }
  return matches[0] ?? null;
}

async function commitCourseRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const code = text(data.code);
  const name = text(data.name);
  if (!code || !name) return null;

  const existing = await prisma.course.findFirst({ where: { tenantId: auth.tenantId, code } });
  if (existing) return { entityType: 'course', entityId: existing.id, matched: true };

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
  await auditWrite({
    action: 'create',
    subjectType: 'course',
    subjectId: course.id,
    after: { code, name },
    meta: { source: 'import' },
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
  if (existing) return { entityType: 'cohort', entityId: existing.id, matched: true };

  let institutionId: string | null = null;
  const collegeName = text(data.institutionName);
  if (collegeName) {
    const college = await organizationByName(collegeName);
    if (!college)
      throw new Error(`"${collegeName}" is not on file. Import the Colleges template first, or correct the name.`);
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
  await auditWrite({
    action: 'create',
    subjectType: 'cohort',
    subjectId: cohort.id,
    after: { courseId: course.id, name, startDate: cohort.startDate, institutionId },
    meta: { source: 'import' },
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
  if (existing) return { org: existing, matched: true };
  const { createOrganization } = await import('../domains/organizations.js');
  const created = await createOrganization({ name, kind });
  return { org: { ...created, institutionProfile: null as { id: string } | null }, matched: false };
}

async function commitCollegeRow(data: Record<string, unknown>) {
  const name = text(data.name);
  if (!name) return null;

  const { org, matched } = await organizationFor(name, 'institution');
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

  return { entityType: 'organization', entityId: org.id, matched };
}

async function commitClientRow(data: Record<string, unknown>) {
  const name = text(data.name);
  if (!name) return null;

  const { org, matched } = await organizationFor(name, 'organization');
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

  return { entityType: 'organization', entityId: org.id, matched };
}

async function commitStudentRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const cohortName = text(data.cohortName);
  if (!cohortName) return null;

  const cohort = await prisma.cohort.findFirst({ where: { tenantId: auth.tenantId, name: cohortName } });
  if (!cohort) {
    throw new Error(
      `No batch is called "${cohortName}". Import the Training batches template first, or correct the name.`,
    );
  }

  let institutionId: string | null = null;
  const collegeName = text(data.institutionName);
  if (collegeName) {
    const college = await organizationByName(collegeName);
    if (!college)
      throw new Error(`"${collegeName}" is not on file. Import the Colleges template first, or correct the name.`);
    institutionId = college.id;
  }

  // Through the same function the form calls, so an imported student and a
  // typed one are the same act: the same college check, the same guardian rule,
  // the same student affiliation, the same refusal to enrol somebody twice.
  const ageBasis = learnerAgeBasis(data);
  const { enrolStudentRecorded } = await import('../domains/education.js');
  const recorded = await enrolStudentRecorded({
    cohortId: cohort.id,
    fullName: text(data.fullName) ?? undefined,
    primaryPhone: text(data.primaryPhone),
    primaryEmail: text(data.primaryEmail),
    institutionId,
    dateOfBirth: ageBasis.dateOfBirth,
    adultAttested: ageBasis.adultAttested,
    guardianName: text(data.guardianName),
    guardianPhone: text(data.guardianPhone),
  });
  const enrollment = recorded.enrollment;
  return {
    entityType: 'enrollment',
    entityId: enrollment.id,
    created: [...recorded.created, { entityType: 'enrollment', entityId: enrollment.id }],
  };
}

/**
 * The age basis an imported learner row brings, checked before anything is
 * written. A row with no date of birth and no guardian is refused as a row
 * error unless the template's adult-attestation column says Yes: the same rule
 * `enrolStudent` applies to a typed enrolment, stated here so the import reports
 * it in the row's own terms. FX-64.
 */
function learnerAgeBasis(data: Record<string, unknown>): {
  dateOfBirth: string | null;
  adultAttested: boolean;
} {
  const raw = data.dateOfBirth;
  let dateOfBirth: string | null = null;
  if (raw) {
    const d = raw instanceof Date ? raw : new Date(String(raw));
    if (Number.isNaN(d.getTime())) throw new Error('The date of birth is not a valid date. Use DD/MM/YYYY.');
    dateOfBirth = d.toISOString();
  }
  const adultAttested = data.adultAttested === true;
  const hasGuardian = !!(text(data.guardianName) && text(data.guardianPhone));
  if (!dateOfBirth && !hasGuardian && !adultAttested) {
    throw new Error(
      'This learner has no date of birth and no guardian. Give a date of birth, or a guardian name and phone, or mark "Adult (18 or over)" Yes if you have confirmed they are an adult.',
    );
  }
  return { dateOfBirth, adultAttested };
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
  // Before the course and batch are created: a refused learner must not leave
  // a course behind that nobody enrolled anyone on. FX-64.
  const ageBasis = learnerAgeBasis(data);

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
        feeAmountMinor: null,
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
  let cohort = await prisma.cohort.findFirst({
    where: { tenantId: auth.tenantId, courseId: course.id, name: batchName },
  });
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
  const { enrolStudentRecorded } = await import('../domains/education.js');
  const recorded = await enrolStudentRecorded({
    cohortId: cohort.id,
    fullName,
    primaryPhone: text(data.primaryPhone),
    primaryEmail: text(data.primaryEmail),
    dateOfBirth: ageBasis.dateOfBirth,
    adultAttested: ageBasis.adultAttested,
    guardianName: text(data.guardianName),
    guardianPhone: text(data.guardianPhone),
  });
  const enrollment = recorded.enrollment;
  const created: CreatedRecord[] = [...recorded.created];

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
      !registrationNumber || !(await prisma.studentProfile.findFirst({ where: { registrationNumber } }));
    // Written as the student route writes one: the profile, its audit row, and
    // the person-created event that route emits for the learner it makes.
    const profile = await governedWrite(async (tx) => {
      const made = await tx.studentProfile.create({
        data: {
          tenantId: auth.tenantId,
          personId: enrollment.personId,
          registrationNumber: numberFree ? registrationNumber : null,
          status: 'active',
        },
      });
      await auditWrite({
        action: 'create',
        subjectType: 'student_profile',
        subjectId: made.id,
        after: { registrationNumber: made.registrationNumber, status: made.status },
        tx,
      });
      await emit({
        name: EVENTS.PERSON_CREATED,
        subject: { entityType: 'person', entityId: enrollment.personId },
        related: [{ relation: 'specialises', entityType: 'student_profile', entityId: made.id }],
        newState: { student: true, status: made.status },
        tx,
      });
      return made;
    });
    created.push({ entityType: 'studentProfile', entityId: profile.id });
  } else if (registrationNumber && !existingStudent.registrationNumber) {
    const taken = await prisma.studentProfile.findFirst({ where: { registrationNumber } });
    if (!taken) {
      await prisma.studentProfile.update({
        where: { id: existingStudent.id },
        data: { registrationNumber },
      });
    }
  }

  return {
    entityType: 'enrollment',
    entityId: enrollment.id,
    created: [...created, { entityType: 'enrollment', entityId: enrollment.id }],
  };
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
            OR: [
              ...(email ? [{ primaryEmailNormalised: email }] : []),
              ...(phone ? [{ primaryPhoneNormalised: phone }] : []),
            ],
          },
        })
      : null;

  // What this row makes for its revert: a new person, and the affiliation it
  // writes to an organisation. A matched person is not listed as made.
  const created: CreatedRecord[] = [];
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
  if (!existing) created.push({ entityType: 'person', entityId: person.id });

  const orgName = text(data.organizationName);
  if (orgName) {
    const org = await organizationByName(orgName);
    if (!org)
      throw new Error(
        `"${orgName}" is not on file. Import the Clients or Colleges template first, or correct the name.`,
      );

    // Which kind of contact they are follows from what the organisation is to
    // us, rather than being asked again in a column the person filling this in
    // would have to keep consistent with the other sheet.
    const affiliationType = org.institutionProfile ? 'institution_contact' : 'customer_contact';
    const held = await prisma.affiliation.findFirst({
      where: { tenantId: auth.tenantId, partyId: person.id, counterpartyId: org.id, affiliationType },
    });
    if (!held) {
      const { createAffiliation } = await import('../domains/identity.js');
      const madeAffiliation = await createAffiliation({
        partyId: person.id,
        affiliationType,
        counterpartyId: org.id,
        counterpartyName: org.name,
      });
      created.push({ entityType: 'affiliation', entityId: madeAffiliation.id });
    }
  }

  return { entityType: 'person', entityId: person.id, matched: existing !== null, created };
}

// ---------------------------------------------------------------------------
// Finance: the company's own chart, its accounts, and what it owes.
//
// A Tally export already carries this — `commitLedgerRow` and
// `commitAccountRow` above read a chart and post transactions straight from
// it. These three exist for the company that has no such export yet, or
// whose vendor bills a Tally export never carried in the first place:
// somebody types the shape the platform states, the same way they would for
// Courses or Client companies.
// ---------------------------------------------------------------------------

/** A ledger category by name. Unique per tenant, so there is nothing to disambiguate. */
async function ledgerCategoryByName(name: string) {
  const auth = currentAuth();
  return prisma.ledgerCategory.findFirst({ where: { tenantId: auth.tenantId, name } });
}

const ACCOUNT_TYPES = new Set(['bank', 'cash', 'card', 'loan', 'wallet']);

/** "Bank", "Credit card" and their kin, to the accountType the ledger stores. */
function accountTypeOf(v: unknown): string {
  const raw = text(v)?.toLowerCase();
  if (!raw) return 'bank';
  if (ACCOUNT_TYPES.has(raw)) return raw;
  if (raw.includes('cash')) return 'cash';
  if (raw.includes('card')) return 'card';
  if (raw.includes('loan')) return 'loan';
  if (raw.includes('wallet')) return 'wallet';
  throw new Error(`Type reads "${text(v)}". Use Bank, Cash, Card, Loan or Wallet.`);
}

const CATEGORY_KIND_WORDS: Record<string, string> = {
  income: 'income',
  revenue: 'income',
  expense: 'expense',
  cost: 'expense',
  'asset purchase': 'asset_purchase',
  asset: 'asset_purchase',
  'fixed asset': 'asset_purchase',
  tax: 'tax',
  statutory: 'tax',
  transfer: 'transfer',
  equity: 'equity',
  'capital in': 'equity',
  'capital introduced': 'equity',
  drawings: 'drawings',
  'capital out': 'drawings',
  'capital taken out': 'drawings',
};

/** "Asset purchase", "Tax or statutory due" and the like, to the stored kind. */
function categoryKindOf(v: unknown): string {
  const raw = text(v)?.toLowerCase();
  if (!raw) return 'expense';
  if (CATEGORY_KIND_WORDS[raw]) return CATEGORY_KIND_WORDS[raw];
  throw new Error(`Type reads "${text(v)}". Use Income, Expense, Asset purchase, Tax, Transfer, Equity or Drawings.`);
}

const CATEGORY_BEHAVIOUR_WORDS: Record<string, string> = {
  'recurring fixed': 'recurring_fixed',
  fixed: 'recurring_fixed',
  'same every month': 'recurring_fixed',
  variable: 'variable',
  varies: 'variable',
  'one-time': 'one_time',
  'one time': 'one_time',
  onetime: 'one_time',
  'one-off': 'one_time',
  'one off': 'one_time',
  annual: 'annual',
  yearly: 'annual',
  'once a year': 'annual',
};

/** "Same every month" and its kin, to the stored behaviour. */
function categoryBehaviourOf(v: unknown): string {
  const raw = text(v)?.toLowerCase();
  if (!raw) return 'variable';
  if (CATEGORY_BEHAVIOUR_WORDS[raw]) return CATEGORY_BEHAVIOUR_WORDS[raw];
  throw new Error(`How it behaves reads "${text(v)}". Use Recurring fixed, Variable, One-time or Annual.`);
}

const DIVISION_BY_LABEL: Record<string, Division> = Object.fromEntries(
  Object.entries(DIVISION_LABELS).map(([code, label]) => [label.toLowerCase(), code as Division]),
);

/** "Skill Development" and its own code alike, to the division the ledger stores. */
function divisionValueOf(v: unknown): string | null {
  const raw = text(v)?.toLowerCase();
  if (!raw) return null;
  if ((DIVISIONS as readonly string[]).includes(raw)) return raw;
  if (DIVISION_BY_LABEL[raw]) return DIVISION_BY_LABEL[raw];
  throw new Error(`Division reads "${text(v)}". Use Software, Skill Development, Education or Shared.`);
}

async function commitLedgerAccountTemplateRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const name = text(data.name);
  if (!name) return null;

  const existing = await prisma.ledgerAccount.findFirst({ where: { tenantId: auth.tenantId, name } });
  if (existing) return { entityType: 'ledgerAccount', entityId: existing.id, matched: true };

  const { createAccount } = await import('../domains/books.js');
  const account = await createAccount({
    name,
    accountType: accountTypeOf(data.accountType),
    displayReference: text(data.displayReference),
    openingBalance: data.openingBalance == null ? 0 : Number(data.openingBalance),
    openingDate: data.openingDate ? new Date(String(data.openingDate)) : null,
  });
  return { entityType: 'ledgerAccount', entityId: account.id };
}

async function commitLedgerCategoryTemplateRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const name = text(data.name);
  if (!name) return null;

  const existing = await prisma.ledgerCategory.findFirst({ where: { tenantId: auth.tenantId, name } });
  if (existing) return { entityType: 'ledgerCategory', entityId: existing.id, matched: true };

  let parentId: string | null = null;
  const parentName = text(data.parentName);
  if (parentName) {
    const parent = await ledgerCategoryByName(parentName);
    if (!parent)
      throw new Error(
        `"${parentName}" is not on file. Import it first, with Parent category left blank, or correct the name.`,
      );
    parentId = parent.id;
  }

  const { createCategory } = await import('../domains/books.js');
  const category = await createCategory({
    name,
    kind: categoryKindOf(data.kind),
    behaviour: categoryBehaviourOf(data.behaviour),
    parentId,
    defaultDivision: divisionValueOf(data.defaultDivision),
    mustPay: data.mustPay === true,
  });
  return { entityType: 'ledgerCategory', entityId: category.id };
}

async function commitVendorBillTemplateRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const vendorName = text(data.vendorName);
  const billNumber = text(data.billNumber);
  if (!vendorName || !billNumber) return null;

  const existing = await prisma.vendorBill.findFirst({ where: { tenantId: auth.tenantId, vendorName, billNumber } });
  if (existing) return { entityType: 'vendorBill', entityId: existing.id, matched: true };

  let categoryId: string | null = null;
  const categoryName = text(data.categoryName);
  if (categoryName) {
    const category = await ledgerCategoryByName(categoryName);
    if (!category)
      throw new Error(
        `"${categoryName}" is not on file. Import the Ledger categories template first, or correct the name.`,
      );
    categoryId = category.id;
  }

  const { recordVendorBill } = await import('../domains/books.js');
  const bill = await recordVendorBill({
    vendorName,
    vendorGstin: text(data.vendorGstin),
    billNumber,
    billDate: new Date(String(data.billDate)),
    dueDate: data.dueDate ? new Date(String(data.dueDate)) : null,
    categoryId,
    division: divisionValueOf(data.division),
    subtotal: Number(data.subtotal ?? 0),
    taxAmount: data.taxAmount == null ? 0 : Number(data.taxAmount),
    note: text(data.note),
  });
  return { entityType: 'vendorBill', entityId: bill.id };
}

/** instrument → the class kind s.2(87) cares about, for a class the import creates. */
const INSTRUMENT_CLASS_KIND: Record<string, string> = {
  equity: 'equity',
  sweat_equity: 'equity',
  ccps: 'preference',
  ocps: 'preference',
  rps: 'preference',
  ccd: 'debenture',
  ocd: 'debenture',
  ncd: 'debenture',
  convertible_note: 'debenture',
  warrant: 'equity',
  option: 'equity',
  phantom: 'equity',
};

/**
 * One row of the opening register: a holder, a share class (created on
 * demand when it is new and the row gives a face value and an instrument),
 * and an **effective** allotment carrying the distinctive range and
 * certificate the row states — this is the opening position, not a proposal
 * working through `proposeAllotment`/`approveShareTransaction`.
 *
 * A distinctive range overlapping one already on file in the same class is
 * refused, naming the row it collides with — checked against the database
 * rather than only within the file, which is what makes a second row in the
 * same file that collides with the first refuse too: each row is written
 * before the next is checked, so a same-file collision is a database
 * collision by the time it is looked for.
 */
async function commitOpeningRegisterRow(data: Record<string, unknown>) {
  const auth = currentAuth();
  const holderName = text(data.holderName);
  const shareClassName = text(data.shareClassName);
  if (!holderName || !shareClassName) return null;

  const { findOrCreatePerson } = await import('../domains/identity.js');
  const { nextFolioNumber, sealHolderPan } = await import('../domains/equity.js');

  const kind = text(data.holderKind)?.toLowerCase().startsWith('org') ? 'organization' : 'person';

  let shareClass = await prisma.shareClass.findFirst({ where: { tenantId: auth.tenantId, name: shareClassName } });
  if (!shareClass) {
    const faceValue = data.faceValue == null ? null : Number(data.faceValue);
    const instrument = text(data.instrument)?.toLowerCase() ?? 'equity';
    if (faceValue == null) {
      throw new Error(`"${shareClassName}" is not an existing share class, and no face value was given to create one.`);
    }
    shareClass = await prisma.shareClass.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: await nextRecordCode('SHC'),
        name: shareClassName,
        kind: INSTRUMENT_CLASS_KIND[instrument] ?? 'equity',
        instrument,
        faceValueMinor: rupeesToMinor(faceValue),
      },
    });
  }

  let personId: string | null = null;
  let organizationId: string | null = null;
  if (kind === 'person') {
    const email = text(data.email)?.toLowerCase() ?? null;
    const phone = text(data.phone);
    const resolved = await findOrCreatePerson({
      fullName: holderName,
      primaryEmail: email,
      primaryPhone: phone,
      source: 'import',
    });
    personId = resolved.person.id;
  } else {
    const org = await organizationByName(holderName);
    if (!org)
      throw new Error(`"${holderName}" is not on file as an organisation. Import it first, or correct the name.`);
    organizationId = org.id;
  }

  let holderRow = await prisma.holder.findFirst({
    where: { tenantId: auth.tenantId, ...(personId ? { personId } : { organizationId }) },
  });
  if (!holderRow) {
    const residencyText = text(data.residency)?.toLowerCase() ?? '';
    const residency = residencyText.startsWith('non') ? 'non_resident' : 'resident';
    const basisText = text(data.investmentBasis)?.toLowerCase() ?? '';
    const investmentBasis = basisText.startsWith('non') ? 'non_repatriable' : basisText ? 'repatriable' : null;
    if (residency === 'non_resident' && !investmentBasis) {
      throw new Error(`"${holderName}" is marked non-resident but no investment basis was given.`);
    }
    holderRow = await prisma.holder.create({
      data: {
        tenantId: auth.tenantId,
        recordCode: await nextRecordCode('HLD'),
        kind,
        personId,
        organizationId,
        folioNumber: await nextFolioNumber(),
        residency,
        investmentBasis,
        panNumber: sealHolderPan(text(data.panNumber)),
      },
    });
  }

  const fromNum = Number(data.distinctiveFrom);
  const toNum = Number(data.distinctiveTo);
  if (!Number.isFinite(fromNum) || !Number.isFinite(toNum) || toNum < fromNum) {
    throw new Error('Distinctive from/to must be whole numbers with "to" not before "from".');
  }
  const distinctiveFrom = BigInt(Math.round(fromNum));
  const distinctiveTo = BigInt(Math.round(toNum));
  const count = Number(data.count);

  const overlap = await prisma.shareTransaction.findFirst({
    where: {
      tenantId: auth.tenantId,
      shareClassId: shareClass.id,
      status: 'effective',
      // A reversal carries its original's range and nets it to nothing, so it
      // does not hold the range; a reversed original is not 'effective' at all.
      reversalOfId: null,
      distinctiveFrom: { not: null, lte: distinctiveTo },
      distinctiveTo: { not: null, gte: distinctiveFrom },
    },
  });
  if (overlap) {
    throw new Error(
      `Distinctive numbers ${distinctiveFrom}-${distinctiveTo} in "${shareClassName}" overlap ${overlap.recordCode}'s range (${overlap.distinctiveFrom}-${overlap.distinctiveTo}).`,
    );
  }

  const effectiveOn = new Date(String(data.allottedOn));

  const txn = await prisma.shareTransaction.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('SHT'),
      type: 'allotment',
      shareClassId: shareClass.id,
      toHolderId: holderRow.id,
      count: dec(count)!,
      pricePerShareMinor: data.pricePerShare == null ? null : rupeesToMinor(Number(data.pricePerShare)),
      distinctiveFrom,
      distinctiveTo,
      effectiveOn,
      status: 'effective',
      proposedByPartyId: auth.partyId ?? 'system',
      note: 'Opening register import.',
    },
  });

  await prisma.shareCertificate.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('CRT'),
      certificateNumber: text(data.certificateNumber) ?? `${shareClass.recordCode}/${distinctiveFrom}-${distinctiveTo}`,
      imported: true,
      holderId: holderRow.id,
      shareClassId: shareClass.id,
      distinctiveFrom,
      distinctiveTo,
      count: dec(count)!,
      issuedOn: effectiveOn,
      status: 'issued',
      issuedForTransactionId: txn.id,
      signatories: [] as never,
      holderNameSnapshot: holderName,
    },
  });

  return { entityType: 'shareTransaction', entityId: txn.id };
}
