/**
 * Compliance — corporate: types and pure arithmetic/validation shared by API
 * and web (docs/plan/compliance.md, H).
 *
 * Company registrations. TAN, CIN and Udyam are checked for shape only — the
 * portal is the authority on whether a number is actually allotted, the same
 * posture `isValidGstin` already takes with GSTIN. The PAN-in-GSTIN check is
 * different in kind: it is not a format rule but a cross-field fact — the
 * GSTIN is issued *from* the PAN, so a mismatch between the two on the same
 * company profile is not a typo waiting to be found at the portal, it is two
 * different companies' numbers on one profile.
 */

export const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
export const CIN_PATTERN = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
export const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
export const CIN_LENGTH = 21;

export function isValidTan(value: string | null | undefined): boolean {
  if (!value) return false;
  return TAN_PATTERN.test(value.trim().toUpperCase());
}

export function isValidCin(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toUpperCase();
  return v.length === CIN_LENGTH && CIN_PATTERN.test(v);
}

export function isValidUdyam(value: string | null | undefined): boolean {
  if (!value) return false;
  return UDYAM_PATTERN.test(value.trim().toUpperCase());
}

/**
 * True when the PAN embedded in a GSTIN (characters 3-12, one-indexed —
 * `gstin.slice(2, 12)` zero-indexed) agrees with the company's own PAN.
 * Returns `true` (no mismatch to report) whenever either value is absent:
 * this is a cross-check, not a presence check — `isValidGstin`/PAN-shape
 * validation covers that separately.
 */
export function panMatchesGstin(pan: string | null | undefined, gstin: string | null | undefined): boolean {
  if (!pan || !gstin) return true;
  const p = pan.trim().toUpperCase();
  const g = gstin.trim().toUpperCase();
  if (g.length !== 15) return true;
  return g.slice(2, 12) === p;
}

export interface PanGstinCheckResult {
  ok: boolean;
  reasonCode: 'pan_gstin_mismatch' | null;
  message: string | null;
}

/** Named-error wrapper: what a mismatch is called and what it says, in one place. */
export function checkPanAgainstGstin(pan: string | null | undefined, gstin: string | null | undefined): PanGstinCheckResult {
  if (panMatchesGstin(pan, gstin)) return { ok: true, reasonCode: null, message: null };
  return {
    ok: false,
    reasonCode: 'pan_gstin_mismatch',
    message: `The GSTIN's embedded PAN (${gstin!.trim().toUpperCase().slice(2, 12)}) does not match the company's own PAN (${pan!.trim().toUpperCase()}). A GSTIN is issued against a specific PAN — this pair cannot both be the same company's.`,
  };
}

// ---------------------------------------------------------------------------
// Password policy (CMP-COR-001/002 supporting rule)
// ---------------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 12;

/** Small, deliberately short — a blocklist is a floor, not a strength meter. */
export const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456789012', 'qwertyuiop12',
  'letmein12345', 'admin12345678', 'welcome123456', 'changeme12345',
  'iloveyou12345', '111111111111', 'aaaaaaaaaaaaa', 'dev-secret-change-me',
  'change-me-in-production', 'docker-development-secret-not-for-production',
]);

export interface PasswordCheckResult {
  valid: boolean;
  reasons: string[];
}

/** Pure — no DB, no hashing. Caller decides what happens with a failing result. */
export function validatePassword(password: string, email?: string | null, minLength = PASSWORD_MIN_LENGTH): PasswordCheckResult {
  const reasons: string[] = [];
  if (password.length < minLength) reasons.push(`Must be at least ${minLength} characters.`);
  if (email && password.toLowerCase() === email.trim().toLowerCase()) {
    reasons.push('Cannot be the same as the email address.');
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    reasons.push('This is a commonly used password and is not allowed.');
  }
  return { valid: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// MCA filing types (Companies Act 2013) — data for the calendar spine
// (workstream A) to seed as ComplianceObligation rows.
// ---------------------------------------------------------------------------

export type McaFilingForm = 'AOC-4' | 'MGT-7' | 'MGT-7A' | 'DIR-3-KYC' | 'ADT-1' | 'DPT-3' | 'MSME-1';

export interface McaFilingType {
  form: McaFilingForm;
  label: string;
  /** annual (tied to the AGM), yearly_fixed (a fixed calendar date every year), or half_yearly. */
  frequency: 'annual_agm' | 'yearly_fixed' | 'half_yearly';
  /** Plain description of the due rule — the portal, not this platform, is authoritative on the exact date. */
  dueRule: string;
}

export const MCA_FILINGS: McaFilingType[] = [
  {
    form: 'AOC-4',
    label: 'Financial statements',
    frequency: 'annual_agm',
    dueRule: 'Within 30 days of the AGM.',
  },
  {
    form: 'MGT-7',
    label: 'Annual return',
    frequency: 'annual_agm',
    dueRule: 'Within 60 days of the AGM (small companies and OPCs file MGT-7A instead).',
  },
  {
    form: 'MGT-7A',
    label: 'Annual return (small company / OPC)',
    frequency: 'annual_agm',
    dueRule: 'Within 60 days of the AGM.',
  },
  {
    form: 'DIR-3-KYC',
    label: 'Director KYC',
    frequency: 'yearly_fixed',
    dueRule: 'By 30 September every year, for every director holding a DIN.',
  },
  {
    form: 'ADT-1',
    label: 'Auditor appointment',
    frequency: 'annual_agm',
    dueRule: 'Within 15 days of the AGM that appoints or reappoints the auditor.',
  },
  {
    form: 'DPT-3',
    label: 'Return of deposits',
    frequency: 'yearly_fixed',
    dueRule: 'By 30 June every year, for the year ended 31 March.',
  },
  {
    form: 'MSME-1',
    label: 'Outstanding dues to micro/small enterprises',
    frequency: 'half_yearly',
    dueRule: 'By 30 April (Oct-Mar half) and 31 October (Apr-Sep half).',
  },
];

// ---------------------------------------------------------------------------
// Statutory registers
// ---------------------------------------------------------------------------

export const REGISTER_KINDS = ['members', 'directors', 'charges', 'kmp', 'related_party'] as const;
export type RegisterKind = (typeof REGISTER_KINDS)[number];

export const REGISTER_KIND_LABELS: Record<RegisterKind, string> = {
  members: 'Register of members',
  directors: 'Register of directors and KMP',
  charges: 'Register of charges',
  kmp: 'Register of key managerial personnel',
  related_party: 'Register of contracts with related parties',
};

// ---------------------------------------------------------------------------
// Board minutes
// ---------------------------------------------------------------------------

export const BOARD_MEETING_KINDS = ['board', 'agm', 'egm'] as const;
export type BoardMeetingKind = (typeof BOARD_MEETING_KINDS)[number];

export const BOARD_MEETING_STATUSES = ['draft', 'recorded'] as const;
export type BoardMeetingStatus = (typeof BOARD_MEETING_STATUSES)[number];

export const BOARD_RESOLUTION_KINDS = ['ordinary', 'special', 'circular'] as const;
export type BoardResolutionKind = (typeof BOARD_RESOLUTION_KINDS)[number];

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export const REFUND_STATUSES = ['requested', 'approved', 'paid'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

export const CERTIFICATE_KINDS = ['completion', 'participation'] as const;
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];
