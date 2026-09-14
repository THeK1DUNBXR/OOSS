/**
 * Compliance — G. Data protection and privacy (DPDP). Types and pure
 * arithmetic shared by API and web. docs/plan/compliance.md §G.
 */

/** The purposes this platform actually processes personal data for. Each is a
 * row on the seeded privacy notice; `X-Purpose` is accepted only when it names
 * one of these. */
export const PURPOSE_CODES = [
  'employment',
  'education_delivery',
  'invoicing',
  'statutory_filing',
  'marketing',
] as const;
export type PurposeCode = (typeof PURPOSE_CODES)[number];

export const LAWFUL_BASES = ['consent', 'legitimate_use', 'legal_obligation'] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

export const CONSENT_STATUSES = ['granted', 'withdrawn', 'expired'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const DATA_REQUEST_KINDS = ['access', 'correction', 'erasure', 'nomination'] as const;
export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number];

export const DATA_REQUEST_STATUSES = ['received', 'verifying', 'fulfilled', 'refused'] as const;
export type DataRequestStatus = (typeof DATA_REQUEST_STATUSES)[number];

export const BREACH_STATUSES = ['open', 'contained', 'notified_board', 'notified_principals', 'closed'] as const;
export type BreachStatus = (typeof BREACH_STATUSES)[number];

/** Every data-principal request is due this many days after receipt, unless
 * the tenant configures otherwise (kept here, not inline, per the platform's
 * own rule that a deadline is data). */
export const DATA_REQUEST_DUE_DAYS = 30;

export function requestDueAt(receivedAt: Date, dueDays = DATA_REQUEST_DUE_DAYS): Date {
  const due = new Date(receivedAt);
  due.setUTCDate(due.getUTCDate() + dueDays);
  return due;
}

/** The 72-hour breach-notification ladder rungs, in hours since detection. */
export const BREACH_LADDER_HOURS = [24, 48, 72] as const;

/** Which rung (1-based) `hoursElapsed` has crossed, or 0 if none yet. */
export function breachLadderRung(hoursElapsed: number): number {
  let rung = 0;
  for (let i = 0; i < BREACH_LADDER_HOURS.length; i += 1) {
    if (hoursElapsed >= BREACH_LADDER_HOURS[i]) rung = i + 1;
  }
  return rung;
}

/** Age in whole years as of `asOf` (default now). Null when the birth date is
 * unknown — age is then unmeasured, not assumed adult. */
export function ageInYears(dateOfBirth: Date | null | undefined, asOf: Date = new Date()): number | null {
  if (!dateOfBirth) return null;
  let age = asOf.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDiff = asOf.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getUTCDate() < dateOfBirth.getUTCDate())) age -= 1;
  return age;
}

/** Whether `dateOfBirth` makes somebody a minor as of `asOf`. Null (unknown
 * DOB) is not "not a minor" — it is unmeasured, and the caller decides what to
 * do with that. */
export function isMinor(dateOfBirth: Date | null | undefined, asOf: Date = new Date()): boolean | null {
  const age = ageInYears(dateOfBirth, asOf);
  if (age === null) return null;
  return age < 18;
}

export interface RetentionWindowInput {
  retentionClass: string;
  years: number;
  /** The earliest date the window is measured from — hire date, enrolment
   * date, whatever anchors the record. */
  anchor: Date;
}

/** The first date on which erasure would no longer be blocked by this
 * retention floor. */
export function earliestErasableDate(input: RetentionWindowInput): Date {
  const d = new Date(input.anchor);
  d.setUTCFullYear(d.getUTCFullYear() + input.years);
  return d;
}

export function isPastRetentionWindow(input: RetentionWindowInput, asOf: Date = new Date()): boolean {
  return asOf >= earliestErasableDate(input);
}

/** The encrypted-at-rest marker `readRegulated`/`encryptField` use. Exported
 * so a test can assert a raw column starts with it without duplicating the
 * literal. */
export const ENCRYPTED_FIELD_PREFIX = 'enc:v1:';

export function isEncryptedFieldValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_FIELD_PREFIX);
}

/** A consent or data-principal-request list row, additively carrying the
 * data principal's name so an unfiltered listing — several people's rows
 * together — doesn't read as a column of bare cuids. */
export interface PersonNamedRow {
  personId: string;
  personFullName: string | null;
}
