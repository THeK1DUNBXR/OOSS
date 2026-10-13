/**
 * Customer-facing document numbers.
 *
 * A record code — `INV-2026-00001` — identifies a row to this platform. A
 * document number is what a customer quotes back at you, and it is the company's
 * own: `KIPL/I/2026-27/001`. The company short code, then the series letter, then
 * the financial year, then a sequence that restarts each year.
 *
 * Three properties, and all three are the reason this is not just string
 * formatting.
 *
 * **Gapless within the year.** A tax invoice series has to be consecutive: the
 * return reports the range issued and the count cancelled within it, and a number
 * nothing explains is a question at an audit. The atomic increment is the same
 * one the record codes use, so two invoices raised in the same millisecond cannot
 * take the same number.
 *
 * **It restarts in April.** The financial year is the period the returns are
 * filed for, so it is the period the series belongs to. `2026-27` is how a
 * company writes it and how their existing counterfoils read.
 *
 * **It can start where the company's paper series stopped.** A company adopting
 * this platform mid-year has already issued KIPL/R/2026-27/015 by hand, and
 * starting again at 001 would put two documents into the world with one number.
 * `setNextNumber` is how that is corrected, deliberately, before anything is
 * issued.
 */

import { financialYearOf, istFinancialYearStart, type RecordTypeCode } from '@kaizen/shared';
import { randomUUID } from 'node:crypto';
import { prisma, type DbTx } from './db.js';
import { currentTenantId } from './context.js';
import { ApiError } from './errors.js';
import { auditWrite, registerGovernedEntities } from './audit.js';

// The series' next number is a document-numbering setting a company changes by hand,
// and the change has to be explainable at an audit. The per-document counter increments
// (recordSequence) are not registered: each document they number is audited itself.
registerGovernedEntities('fin', ['document_series']);

/** The series a customer-facing document belongs to. */
export const DOCUMENT_SERIES = {
  invoice: 'I',
  receipt: 'R',
  /// The tax invoice raised at the end of a fee-instalment run — see
  /// `finalizeCourseFeeInvoice` in `domains/receipts.ts`. `KIPL/TI/26-27/001`.
  finalInvoice: 'TI',
  /// The internal working invoice a course-fee student's instalments are
  /// tracked against. Never handed to the student and never reported for
  /// tax — see the `Invoice` doc comment. `KIPL/temp/26-27/001`.
  tempInvoice: 'temp',
  // Added with the compliance work (docs/plan/compliance.md): each is a
  // document that is final once issued, so each gets a gapless series.
  creditNote: 'C',
  debitNote: 'D',
  payslip: 'P',
  refund: 'N',
  certificate: 'T',
  /// A share certificate (SH-1): `KIPL/S/26-27/001`. Its own letter, apart
  /// from the course certificate above. Never allocated for a certificate
  /// the opening-register import carries in with its own paper number — see
  /// `ShareCertificate.imported`.
  shareCertificate: 'S',
} as const;

export type DocumentSeries = (typeof DOCUMENT_SERIES)[keyof typeof DOCUMENT_SERIES];

export const SERIES_LABELS: Record<DocumentSeries, string> = {
  I: 'Tax invoices',
  R: 'Receipts',
  TI: 'Final (tax) invoices',
  temp: 'Temporary invoices (internal)',
  C: 'Credit notes',
  D: 'Debit notes',
  P: 'Payslips',
  N: 'Refunds',
  T: 'Certificates',
  S: 'Share certificates',
};

export type YearFormat = 'short' | 'full';

/**
 * The financial year in a document number: `26-27` or `2026-27`.
 *
 * The short form exists because of a limit rather than a preference. The portal
 * takes a tax invoice number of at most sixteen characters, and
 * `KIPL/I/2026-27/001` is eighteen — correct on paper, rejected by GSTR-1.
 * `KIPL/I/26-27/001` is exactly sixteen.
 */
export function financialYearLabel(at: Date, format: YearFormat = 'short'): string {
  const full = financialYearOf(at).replace(/^FY/, '');
  return format === 'full' ? full : full.slice(2);
}

/** The longest a tax invoice number may be before the portal refuses it. */
export const MAX_INVOICE_NUMBER_LENGTH = 16;

/**
 * IST, because the sequence is keyed by year: a UTC reading on 1 April puts
 * the first invoices of the new year into the old year's series, which
 * restarts the count at the wrong number on the portal (FX-40).
 */
export function financialYearStart(at: Date): number {
  return istFinancialYearStart(at);
}

/**
 * The prefix every document number begins with.
 *
 * Initials of the legal name where the company has not said otherwise, because
 * that is what a company's own numbering almost always is: Kaizen Infinities
 * Private Limited writes KIPL.
 */
export function prefixFrom(profile: { documentPrefix?: string | null; legalName: string }): string {
  const explicit = profile.documentPrefix?.trim().toUpperCase();
  if (explicit) return explicit;
  const initials = profile.legalName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  return initials.slice(0, 8) || 'DOC';
}

function sequenceKey(series: DocumentSeries): RecordTypeCode {
  // Its own key space, so a document series and a record-code series never share
  // a counter and a change to one cannot move the other.
  return `DOC:${series}` as unknown as RecordTypeCode;
}

/**
 * Allocates the next number in a series, inside the caller's transaction.
 *
 * The number is taken in `tx` because the document it names is written in `tx`.
 * Taken on the global client it committed by itself, so a document whose write
 * then failed left its number behind and the series had a hole in it: a tax
 * invoice series with a gap is a question the return cannot answer (FX-40 and
 * the gap policy are the accountant's, not this code's). Here the increment
 * rolls back with the write, and the row lock it takes holds until commit, so
 * two issuers in one series serialise rather than read the same counter.
 *
 * The increment is a single INSERT ... ON CONFLICT rather than a Prisma upsert:
 * upsert reads, then inserts, and two first-ever numbers in a new year could both
 * see no row and one would fail on the unique key.
 *
 * Takes the prefix as an argument rather than reading the profile, so that the
 * caller has already decided which company this is on behalf of and this cannot
 * quietly read a different one inside a transaction.
 */
export async function nextDocumentNumber(
  tx: DbTx,
  series: DocumentSeries,
  prefix: string,
  at: Date = new Date(),
  yearFormat: YearFormat = 'short',
): Promise<string> {
  const tenantId = currentTenantId();
  const year = financialYearStart(at);

  const rows = await tx.$queryRaw<{ nextSequence: number }[]>`
    INSERT INTO "record_sequences" ("id", "tenantId", "entityType", "year", "nextSequence")
    VALUES (${randomUUID()}, ${tenantId}, ${sequenceKey(series)}, ${year}, 2)
    ON CONFLICT ("tenantId", "entityType", "year")
    DO UPDATE SET "nextSequence" = "record_sequences"."nextSequence" + 1
    RETURNING "nextSequence"`;
  const seq = rows[0]!.nextSequence - 1;

  // Three digits, and more when a company needs more. Padding is a convention,
  // not a limit: a company issuing its thousandth invoice gets `1000` rather
  // than an error or a rollover.
  return `${prefix}/${series}/${financialYearLabel(at, yearFormat)}/${String(seq).padStart(3, '0')}`;
}

/**
 * What the next number in each series would be, without taking it.
 *
 * Reported with its length, because the sixteen-character limit on a tax invoice
 * number is the kind of thing that should be visible before the first invoice is
 * raised rather than discovered at the filing deadline.
 */
export async function peekNextNumbers(prefix: string, at: Date = new Date(), yearFormat: YearFormat = 'short') {
  const tenantId = currentTenantId();
  const year = financialYearStart(at);

  const rows = await prisma.recordSequence.findMany({
    where: { tenantId, entityType: { in: Object.values(DOCUMENT_SERIES).map(sequenceKey) }, year },
  });
  const byKey = new Map(rows.map((r) => [r.entityType, r.nextSequence]));

  return Object.values(DOCUMENT_SERIES).map((series) => {
    const next = byKey.get(sequenceKey(series)) ?? 1;
    const example = `${prefix}/${series}/${financialYearLabel(at, yearFormat)}/${String(next).padStart(3, '0')}`;
    return {
      series,
      label: SERIES_LABELS[series],
      financialYear: financialYearLabel(at, yearFormat),
      nextNumber: next,
      example,
      length: example.length,
      /**
       * Only the two series that are actually reported to the portal are
       * capped: a generic tax invoice, and the final (tax) invoice a
       * fee-instalment run closes with. A receipt or a temp invoice number
       * can be as long as the company likes — neither is filed.
       */
      tooLongForThePortal:
        (series === DOCUMENT_SERIES.invoice || series === DOCUMENT_SERIES.finalInvoice) &&
        example.length > MAX_INVOICE_NUMBER_LENGTH,
    };
  });
}

/**
 * Sets where a series starts.
 *
 * For the company that has already issued fifteen receipts by hand this year:
 * without this, the platform would start again at 001 and put two documents into
 * the world with one number. Only ever forwards — moving a series backwards would
 * do exactly the thing it exists to prevent.
 */
export async function setNextNumber(series: DocumentSeries, nextNumber: number, at: Date = new Date()) {
  const tenantId = currentTenantId();
  const year = financialYearStart(at);

  if (!Number.isInteger(nextNumber) || nextNumber < 1) {
    throw ApiError.badRequest('The next number in a series is a whole number of one or more.');
  }

  const existing = await prisma.recordSequence.findFirst({
    where: { tenantId, entityType: sequenceKey(series), year },
  });
  if (existing && nextNumber < existing.nextSequence) {
    throw ApiError.unprocessable(
      `The ${SERIES_LABELS[series].toLowerCase()} series is already at ${existing.nextSequence} for ${financialYearLabel(at, 'full')}. ` +
        'A series only moves forwards: setting it back would issue a number that is already on a document somebody is holding.',
      { current: existing.nextSequence },
    );
  }

  const row = await prisma.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId, entityType: sequenceKey(series), year } },
    create: { tenantId, entityType: sequenceKey(series), year, nextSequence: nextNumber },
    update: { nextSequence: nextNumber },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'document_series',
    subjectId: row.id,
    before: { nextSequence: existing?.nextSequence ?? null },
    after: { nextSequence: nextNumber },
    meta: { series, year },
  });
  return row;
}
