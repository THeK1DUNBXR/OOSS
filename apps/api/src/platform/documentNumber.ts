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

import { financialYearOf, type RecordTypeCode } from '@kaizen/shared';
import { prisma } from './db.js';
import { currentTenantId } from './context.js';
import { ApiError } from './errors.js';

/** The series a customer-facing document belongs to. */
export const DOCUMENT_SERIES = {
  invoice: 'I',
  receipt: 'R',
  finalInvoice: 'F',
} as const;

export type DocumentSeries = (typeof DOCUMENT_SERIES)[keyof typeof DOCUMENT_SERIES];

export const SERIES_LABELS: Record<DocumentSeries, string> = {
  I: 'Tax invoices',
  R: 'Receipts',
  F: 'Final invoices',
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

function financialYearStart(at: Date): number {
  const year = at.getUTCFullYear();
  return at.getUTCMonth() >= 3 ? year : year - 1;
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
 * Allocates the next number in a series.
 *
 * Takes the prefix as an argument rather than reading the profile, so that the
 * caller has already decided which company this is on behalf of and this cannot
 * quietly read a different one inside a transaction.
 */
export async function nextDocumentNumber(
  series: DocumentSeries,
  prefix: string,
  at: Date = new Date(),
  yearFormat: YearFormat = 'short',
): Promise<string> {
  const tenantId = currentTenantId();
  const year = financialYearStart(at);

  const row = await prisma.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId, entityType: sequenceKey(series), year } },
    create: { tenantId, entityType: sequenceKey(series), year, nextSequence: 2 },
    update: { nextSequence: { increment: 1 } },
    select: { nextSequence: true },
  });
  const seq = row.nextSequence - 1;

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
       * Only the invoice series is reported to the portal, so only it is capped.
       * A receipt number can be as long as the company likes.
       */
      tooLongForThePortal: series === DOCUMENT_SERIES.invoice && example.length > MAX_INVOICE_NUMBER_LENGTH,
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

  return prisma.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId, entityType: sequenceKey(series), year } },
    create: { tenantId, entityType: sequenceKey(series), year, nextSequence: nextNumber },
    update: { nextSequence: nextNumber },
  });
}
