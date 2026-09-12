/**
 * Staging an uploaded file.
 *
 * Upload → parse → detect → stage → preview. Nothing is written to the books
 * until somebody has looked at the preview and pressed commit, which is the
 * whole design: an import that goes straight in is an import you have to undo
 * by hand, and the only thing worse than no ledger is a ledger you do not
 * trust.
 */

import { createHash } from 'node:crypto';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { assertCan } from '../platform/permissions.js';
import { ApiError } from '../platform/errors.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { emit } from '../platform/eventBus.js';
import { EVENTS } from '@kaizen/shared';
import { parseCsv, readWorkbook, type Grid } from './parse.js';
import {
  detectGrid, detectSourceFormat, detectWorkbook, isTallyLedgerSheet,
  type Detection, type ImportKind,
} from './detect.js';
import {
  extractAttendance,
  extractStudentRegister, extractBankStatement, extractEmployees, extractSalary,
  extractTallyLedger, extractTrialBalance, extractTemplate, type Extraction,
} from './extract.js';
import { extractTallyXml } from './tallyXml.js';
import { buildChart, type LedgerChart } from './chart.js';
import { templateByKind } from './templates.js';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface StageResult {
  batchId: string;
  recordCode: string;
  kind: ImportKind;
  sourceFormat: string;
  sourceLabel: string | null;
  detection: Detection;
  otherSheets: Detection[];
  notes: string[];
  columns: string[];
  stats: Record<string, number>;
  duplicateOfBatch?: { id: string; recordCode: string; fileName: string; committedAt: Date | null };
}

/**
 * Reads the file, decides what it is, and writes the rows to the staging
 * tables.
 *
 * `kindOverride` and `sheetOverride` exist because detection is a claim rather
 * than a fact: the preview shows what was decided and the user can say
 * otherwise without re-uploading.
 */
export async function stageImport(input: {
  fileName: string;
  buffer: Buffer;
  kindOverride?: ImportKind;
  sheetOverride?: string;
}): Promise<StageResult> {
  const auth = currentAuth();
  await assertCan({ resource: 'imports', verb: 'create' });

  if (input.buffer.length === 0) throw ApiError.badRequest('The uploaded file is empty.');
  if (input.buffer.length > MAX_UPLOAD_BYTES) {
    throw ApiError.badRequest(
      `That file is ${(input.buffer.length / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB — split it by period and import each part.`,
    );
  }

  const sourceFormat = detectSourceFormat(input.fileName, input.buffer);
  if (sourceFormat === 'unsupported') {
    throw ApiError.badRequest(
      'That file is not a spreadsheet, a CSV or a Tally XML export. Those are the three things this can read.',
    );
  }

  const contentHash = createHash('sha256').update(input.buffer).digest('hex');

  // The same bytes, uploaded again. Not refused — re-importing after a revert
  // is legitimate — but said out loud, because the usual reason a person
  // uploads a statement twice is that they forgot they already had.
  const previous = await prisma.importBatch.findFirst({
    where: { tenantId: auth.tenantId, contentHash, status: { in: ['parsed', 'previewed', 'committed'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, recordCode: true, fileName: true, committedAt: true },
  });

  let detection: Detection;
  let otherSheets: Detection[] = [];
  let extraction: Extraction;
  let sourceLabel: string | null = null;
  let chart: LedgerChart = {};
  let chartSources: string[] = [];

  if (sourceFormat === 'tally_xml') {
    const xml = input.buffer.toString('utf8');
    detection = { kind: 'tally_ledger', confidence: 'high', reason: 'A Tally XML export.' };
    extraction = extractTallyXml(xml);
  } else if (sourceFormat === 'xlsx') {
    const sheets = readWorkbook(input.buffer);
    if (sheets.length === 0) throw ApiError.badRequest('That workbook has no sheets in it.');

    const detected = detectWorkbook(sheets);
    otherSheets = detected.perSheet;

    // Read the chart of accounts out of the workbook's own statements before
    // touching the vouchers, so classification is what the company's books say
    // rather than what a ledger's name suggests.
    const built = buildChart(sheets);
    chart = built.chart;
    chartSources = built.sources;

    const chosenName = input.sheetOverride ?? detected.primary.sheet ?? sheets[0].name;
    const chosen = sheets.find((s) => s.name === chosenName) ?? sheets[0];
    sourceLabel = chosen.name;

    detection = input.sheetOverride
      ? detected.perSheet.find((d) => d.sheet === input.sheetOverride) ?? detectGrid(chosen.grid, chosen.name)
      : detected.primary;
    if (input.kindOverride) detection = { ...detection, kind: input.kindOverride };

    extraction = extractFromGrid(chosen.grid, detection, chosen.name, chart);
  } else {
    const grid = parseCsv(input.buffer.toString('utf8'));
    detection = detectGrid(grid);
    if (input.kindOverride) detection = { ...detection, kind: input.kindOverride };
    extraction = extractFromGrid(grid, detection);
  }

  if (extraction.rows.length === 0) {
    throw ApiError.badRequest(
      `Nothing importable was found in ${input.fileName}. ${detection.reason} ` +
        'If that is wrong about the file, choose the sheet and the kind by hand and try again.',
    );
  }

  // Rows this tenant has already brought in, on any earlier batch.
  const keys = extraction.rows.map((r) => r.dedupeKey).filter((k): k is string => Boolean(k));
  const seen = new Set(
    (
      await prisma.importRow.findMany({
        where: { tenantId: auth.tenantId, dedupeKey: { in: keys }, status: 'committed' },
        select: { dedupeKey: true },
      })
    ).map((r) => r.dedupeKey!),
  );

  // And rows this file repeats within itself — the Tally case, where each
  // voucher appears once under each account it touches.
  const withinFile = new Set<string>();

  const batch = await prisma.importBatch.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('IMP'),
      fileName: input.fileName,
      fileSize: input.buffer.length,
      contentHash,
      kind: detection.kind,
      sourceFormat,
      detectedAs: detection.kind,
      sourceLabel,
      status: 'parsed',
      mapping: {},
      // The chart travels with the batch so that commit classifies exactly the
      // way the preview said it would.
      options: { chart, chartSources } as never,
      stats: {},
      createdById: auth.partyId,
    },
  });

  const stats: Record<string, number> = { total: 0, ready: 0, duplicate: 0, skipped: 0, error: 0 };

  await prisma.importRow.createMany({
    data: extraction.rows.map((row) => {
      let status = row.status as string;
      let message = row.message ?? null;

      if (status === 'ready' && row.dedupeKey) {
        if (seen.has(row.dedupeKey)) {
          status = 'duplicate';
          message = 'Already imported on an earlier batch.';
        } else if (withinFile.has(row.dedupeKey)) {
          status = 'duplicate';
          message = 'The other half of a voucher already counted in this file.';
        } else {
          withinFile.add(row.dedupeKey);
        }
      }

      stats.total += 1;
      stats[status] = (stats[status] ?? 0) + 1;

      return {
        tenantId: auth.tenantId,
        batchId: batch.id,
        rowNumber: row.rowNumber,
        raw: row.raw as never,
        normalised: (row.normalised ?? undefined) as never,
        status,
        message,
        dedupeKey: row.dedupeKey ?? null,
      };
    }),
  });

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { stats: stats as never, status: 'previewed' },
  });

  await emit({
    name: EVENTS.IMPORT_STAGED,
    subject: { entityType: 'import_batch', entityId: batch.id },
    newState: { kind: detection.kind, fileName: input.fileName, ...stats },
    impact: { domains: ['fin'] },
  });

  return {
    batchId: batch.id,
    recordCode: batch.recordCode,
    kind: detection.kind,
    sourceFormat,
    sourceLabel,
    detection,
    otherSheets,
    notes: [
      ...extraction.notes,
      ...(chartSources.length
        ? [
            `The chart of accounts was read from this workbook's ${chartSources.join(' and ')}, so ${Object.keys(chart).length} ledgers are classified from the company's own statements rather than guessed from their names.`,
          ]
        : []),
    ],
    columns: extraction.columns,
    stats,
    duplicateOfBatch: previous ?? undefined,
  };
}

function extractFromGrid(grid: Grid, detection: Detection, sheetName?: string, chart?: LedgerChart): Extraction {
  const header = detection.headerRow ?? 0;

  // A filled-in template is read by its own spec, so the columns the file was
  // handed out with and the columns read back are one definition.
  const spec = templateByKind(detection.kind);
  if (spec) return extractTemplate(grid, spec, header);

  switch (detection.kind) {
    case 'tally_ledger':
      return extractTallyLedger(grid, chart);
    case 'chart_of_accounts':
      return extractTrialBalance(grid);
    case 'bank_statement':
      return extractBankStatement(grid, header);
    case 'employees':
      return extractEmployees(grid, header);
    case 'salary':
      return extractSalary(grid, header, sheetName);
    case 'attendance':
      return extractAttendance(grid, header, sheetName);
    case 'transactions':
      return extractBankStatement(grid, header);
    case 'student_register':
      return extractStudentRegister(grid, header);
    default:
      // An unrecognised grid is still worth staging: the ledger importer copes
      // with anything shaped like a Tally report, and the bank importer with
      // anything that has a date and an amount, so the user gets a preview to
      // argue with rather than a refusal.
      return isTallyLedgerSheet(grid) ? extractTallyLedger(grid, chart) : extractBankStatement(grid, header);
  }
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

export async function listImports() {
  const auth = currentAuth();
  await assertCan({ resource: 'imports', verb: 'view' });
  return prisma.importBatch.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function getImport(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'imports', verb: 'view' });
  const batch = await prisma.importBatch.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!batch) throw ApiError.notFound('Import');
  return batch;
}

export async function importRows(id: string, filter: { status?: string; limit?: number } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'imports', verb: 'view' });
  return prisma.importRow.findMany({
    where: {
      tenantId: auth.tenantId,
      batchId: id,
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { rowNumber: 'asc' },
    take: Math.min(filter.limit ?? 200, 1000),
  });
}

/** Options the commit will honour — target account, division, and so on. */
export async function setImportOptions(id: string, options: Record<string, unknown>) {
  const auth = currentAuth();
  await assertCan({ resource: 'imports', verb: 'edit' });
  const batch = await prisma.importBatch.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!batch) throw ApiError.notFound('Import');
  if (batch.status === 'committed') {
    throw ApiError.conflict('This import has already been committed. Revert it first if the options were wrong.');
  }
  return prisma.importBatch.update({
    where: { id },
    data: { options: { ...(batch.options as object), ...options } as never },
  });
}

/** Excludes a row from the commit, or puts an excluded one back. */
export async function setRowStatus(rowId: string, status: 'ready' | 'skipped') {
  const auth = currentAuth();
  await assertCan({ resource: 'imports', verb: 'edit' });
  const row = await prisma.importRow.findFirst({ where: { id: rowId, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Import row');
  if (row.status === 'committed') {
    throw ApiError.conflict('That row is already in the books. Reverting the batch is the way to take it out.');
  }
  return prisma.importRow.update({ where: { id: rowId }, data: { status, message: null } });
}
