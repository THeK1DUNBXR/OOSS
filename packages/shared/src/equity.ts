/**
 * The register (bounded context `eqt`) — equity-portal plan §5, phase 1.
 *
 * Pure vocabulary and arithmetic, kept here for the same reason `finance.ts`
 * is: a cap table screen and the domain function that computes it must agree,
 * and the only way to guarantee that is for there to be one computation.
 *
 * `computeCapTable` takes plain numbers, not `Decimal` — the API side converts
 * with its own `dec()`/`num()` helpers before calling in and after calling
 * out, so money and share counts never touch float arithmetic on the way
 * through the database, only inside this one pure function where the input is
 * already a JS number by construction (a share count from the books is never
 * itself the last step of a financial computation — it is summed and
 * percentaged, which is what this function does).
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const SHARE_CLASS_KINDS = ['equity', 'preference', 'debenture'] as const;
export type ShareClassKind = (typeof SHARE_CLASS_KINDS)[number];

export const SHARE_INSTRUMENTS = [
  'equity', 'sweat_equity', 'ccps', 'ocps', 'rps', 'ccd', 'ocd', 'ncd',
  'convertible_note', 'warrant', 'option', 'phantom',
] as const;
export type ShareInstrument = (typeof SHARE_INSTRUMENTS)[number];

export const SHARE_INSTRUMENT_LABELS: Record<ShareInstrument, string> = {
  equity: 'Equity shares',
  sweat_equity: 'Sweat equity (s.54)',
  ccps: 'Compulsorily convertible preference shares',
  ocps: 'Optionally convertible preference shares',
  rps: 'Redeemable preference shares',
  ccd: 'Compulsorily convertible debentures',
  ocd: 'Optionally convertible debentures',
  ncd: 'Non-convertible debentures',
  convertible_note: 'Convertible note (DPIIT start-ups only)',
  warrant: 'Warrant',
  option: 'ESOP option',
  phantom: 'Phantom stock',
};

/** Instruments counted at their share count toward fully-diluted, on top of issued. */
export const DILUTIVE_INSTRUMENTS: ShareInstrument[] = [
  'ccps', 'ocps', 'ccd', 'ocd', 'convertible_note', 'warrant', 'option', 'phantom',
];

export const HOLDER_KINDS = ['person', 'organization', 'entity'] as const;
export type HolderKind = (typeof HOLDER_KINDS)[number];

export const HOLDER_KIND_LABELS: Record<HolderKind, string> = {
  person: 'Person',
  organization: 'Organisation',
  entity: 'Group entity',
};

export const RESIDENCY_VALUES = ['resident', 'non_resident'] as const;
export type Residency = (typeof RESIDENCY_VALUES)[number];

export const RESIDENCY_LABELS: Record<Residency, string> = {
  resident: 'Resident',
  non_resident: 'Non-resident',
};

export const INVESTMENT_BASIS_VALUES = ['repatriable', 'non_repatriable'] as const;
export type InvestmentBasis = (typeof INVESTMENT_BASIS_VALUES)[number];

export const INVESTMENT_BASIS_LABELS: Record<InvestmentBasis, string> = {
  repatriable: 'Repatriable',
  non_repatriable: 'Non-repatriable (Schedule IV)',
};

export const SHARE_TRANSACTION_TYPES = [
  'allotment', 'transfer', 'conversion', 'buyback', 'split', 'bonus',
  'forfeiture', 'cancellation', 'redemption', 'reduction',
] as const;
export type ShareTransactionType = (typeof SHARE_TRANSACTION_TYPES)[number];

export const SHARE_TRANSACTION_TYPE_LABELS: Record<ShareTransactionType, string> = {
  allotment: 'Allotment',
  transfer: 'Transfer',
  conversion: 'Conversion',
  buyback: 'Buy-back',
  split: 'Split',
  bonus: 'Bonus issue',
  forfeiture: 'Forfeiture',
  cancellation: 'Cancellation',
  redemption: 'Redemption',
  reduction: 'Reduction of capital',
};

export const SHARE_TRANSACTION_STATUSES = ['proposed', 'approved', 'effective', 'reversed', 'rejected'] as const;
export type ShareTransactionStatus = (typeof SHARE_TRANSACTION_STATUSES)[number];

export const CERTIFICATE_STATUSES = ['issued', 'surrendered', 'cancelled'] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

export const VALUATION_BASES = ['registered_valuer', 'merchant_banker', 'ca_certificate', 'internal', 'round_price'] as const;
export type ValuationBasis = (typeof VALUATION_BASES)[number];

export const VALUATION_BASIS_LABELS: Record<ValuationBasis, string> = {
  registered_valuer: 'Registered valuer',
  merchant_banker: 'Merchant banker',
  ca_certificate: "Chartered accountant's certificate",
  internal: 'Internal estimate',
  round_price: 'Latest round price',
};

export const DEMAT_STATUSES = ['physical', 'demat', 'mixed'] as const;
export type DematStatus = (typeof DEMAT_STATUSES)[number];

export const DEMAT_STATUS_LABELS: Record<DematStatus, string> = {
  physical: 'Physical certificates',
  demat: 'Dematerialised',
  mixed: 'Mixed',
};

export const ENTITY_DOCUMENT_KINDS = ['certificate', 'resolution', 'valuation_report', 'agreement', 'filing', 'other'] as const;
export type EntityDocumentKind = (typeof ENTITY_DOCUMENT_KINDS)[number];

export const ENTITY_DOCUMENT_AUDIENCES = ['shareholders', 'board', 'secretary'] as const;
export type EntityDocumentAudience = (typeof ENTITY_DOCUMENT_AUDIENCES)[number];

// ---------------------------------------------------------------------------
// View shapes — what the API hands the web, money already `Withheld` where
// the viewer lacks `financial`.
// ---------------------------------------------------------------------------

export interface ShareClassView {
  id: string;
  recordCode: string;
  name: string;
  kind: ShareClassKind;
  instrument: ShareInstrument;
  faceValue: number | null;
  votesPerShare: number;
  rights: Record<string, unknown>;
  conversionTerms: Record<string, unknown> | null;
  authorisedCount: number | null;
  status: 'active' | 'closed';
}

export interface HolderView {
  id: string;
  recordCode: string;
  kind: HolderKind;
  personId: string | null;
  organizationId: string | null;
  heldByTenantId: string | null;
  displayName: string;
  folioNumber: string;
  residency: Residency;
  investmentBasis: InvestmentBasis | null;
  status: 'active' | 'ceased';
}

export interface ShareTransactionView {
  id: string;
  recordCode: string;
  type: ShareTransactionType;
  shareClassId: string;
  fromHolderId: string | null;
  toHolderId: string | null;
  count: number;
  pricePerShare: number | null;
  distinctiveFrom: string | null;
  distinctiveTo: string | null;
  effectiveOn: string | null;
  status: ShareTransactionStatus;
  considerationTransactionId: string | null;
  pendingConsideration: boolean;
  reversalOfId: string | null;
  reversedById: string | null;
  proposedByPartyId: string;
}

export interface CertificateView {
  id: string;
  recordCode: string;
  certificateNumber: string;
  imported: boolean;
  holderId: string;
  shareClassId: string;
  distinctiveFrom: string;
  distinctiveTo: string;
  count: number;
  issuedOn: string;
  status: CertificateStatus;
  supersededById: string | null;
}

export interface CertificateDocumentView {
  certificateNumber: string;
  companyLegalName: string;
  companyCin: string | null;
  registeredAddress: string;
  holderNameSnapshot: string;
  folioNumber: string;
  shareClassName: string;
  faceValue: number | null;
  count: number;
  distinctiveFrom: string;
  distinctiveTo: string;
  issuedOn: string;
  signatories: Array<{ name: string; designation: string }>;
  paidUpAmount: number | null;
}

export interface ValuationView {
  id: string;
  recordCode: string;
  asOf: string;
  basis: ValuationBasis;
  valuerName: string | null;
  perShareByClass: Record<string, number>;
  equityValue: number | null;
  reportRef: string | null;
  validUntil: string | null;
  note: string | null;
}

export interface EntityDocumentView {
  id: string;
  recordCode: string;
  title: string;
  kind: EntityDocumentKind;
  audience: EntityDocumentAudience;
  fileRef: string;
  uploadedByPartyId: string;
  createdAt: string;
}

export interface CapTableRow {
  holderId: string;
  holderName: string;
  shareClassId: string;
  shareClassName: string;
  count: number;
  issuedPct: number;
  fullyDilutedPct: number;
  certificateNumbers: string[];
  pendingConsideration: boolean;
  certificateOverdue: boolean;
}

export interface CapTableHolderTotal {
  holderId: string;
  holderName: string;
  totalCount: number;
  issuedPct: number;
  fullyDilutedPct: number;
}

export interface CapTableView {
  asOf: string;
  since: string | null;
  rows: CapTableRow[];
  holderTotals: CapTableHolderTotal[];
}

export interface HoldingsView {
  holderId: string;
  holderName: string;
  rows: Array<{ shareClassId: string; shareClassName: string; count: number; certificateNumbers: string[] }>;
}

// ---------------------------------------------------------------------------
// Cap-table arithmetic
// ---------------------------------------------------------------------------

export interface CapTableInputRow {
  holderId: string;
  shareClassId: string;
  count: number;
  instrument: ShareInstrument;
  /** `total share capital` per s.2(87) is equity + preference; a debenture or
   * an option/warrant/note is never share capital, however many units are
   * outstanding — only the fully-diluted basis counts it. */
  classKind: ShareClassKind;
  /** How many underlying equity shares one unit converts to. Defaults to 1. */
  conversionRatio?: number;
  status: ShareTransactionStatus;
  pendingConsideration?: boolean;
}

export interface CapTableComputedRow {
  holderId: string;
  shareClassId: string;
  count: number;
  issuedPct: number;
  fullyDilutedPct: number;
  pendingConsideration: boolean;
}

export interface CapTableComputedHolderTotal {
  holderId: string;
  totalCount: number;
  issuedPct: number;
  fullyDilutedPct: number;
}

export interface CapTableComputation {
  rows: CapTableComputedRow[];
  holderTotals: CapTableComputedHolderTotal[];
}

/**
 * Largest-remainder rounding to two decimals: every share of a percentage
 * split gets its floor, and the rows with the largest dropped remainder each
 * receive one more hundredth until the parts sum to exactly the whole,
 * rather than 33.33 + 33.33 + 33.33 quietly totalling 99.99.
 */
export function apportionPercent(shares: number[], total: number): number[] {
  const n = shares.length;
  if (n === 0) return [];
  if (total <= 0) return shares.map(() => 0);

  const raw = shares.map((s) => (s / total) * 100);
  const floors = raw.map((r) => Math.floor(r * 100) / 100);
  const remainders = raw.map((r, i) => ({ i, rem: r * 100 - Math.floor(r * 100) }));

  const targetHundredths = 10000; // 100.00 expressed in hundredths
  let flooredHundredths = floors.reduce((acc, f) => acc + Math.round(f * 100), 0);
  let short = targetHundredths - flooredHundredths;

  remainders.sort((a, b) => b.rem - a.rem);
  const bump = new Array(n).fill(0);
  for (let k = 0; k < remainders.length && short > 0; k += 1) {
    bump[remainders[k].i] += 1;
    short -= 1;
  }

  return floors.map((f, i) => Math.round((f + bump[i] / 100) * 100) / 100);
}

/**
 * Per holder per class counts, issued % (equity + preference share count,
 * s.2(87)'s "total share capital") and fully-diluted % (adds convertible
 * instruments and options at their conversion ratio) — each basis summing to
 * exactly 100.00 via `apportionPercent`.
 */
export function computeCapTable(inputRows: CapTableInputRow[]): CapTableComputation {
  const effective = inputRows.filter((r) => r.status === 'effective');
  const isShareCapital = (r: CapTableInputRow) => r.classKind === 'equity' || r.classKind === 'preference';

  // Issued basis: equity + preference share count only (s.2(87)).
  const issuedTotal = effective.filter(isShareCapital).reduce((sum, r) => sum + r.count, 0);

  // Fully-diluted basis: every effective row, convertibles and options at
  // their conversion ratio.
  const dilutedUnits = effective.map((r) => r.count * (r.conversionRatio ?? 1));
  const dilutedTotal = dilutedUnits.reduce((sum, u) => sum + u, 0);

  const issuedPcts = apportionPercent(
    effective.map((r) => (isShareCapital(r) ? r.count : 0)),
    issuedTotal,
  );
  const dilutedPcts = apportionPercent(dilutedUnits, dilutedTotal);

  const rows: CapTableComputedRow[] = effective.map((r, i) => ({
    holderId: r.holderId,
    shareClassId: r.shareClassId,
    count: r.count,
    issuedPct: issuedPcts[i] ?? 0,
    fullyDilutedPct: dilutedPcts[i] ?? 0,
    pendingConsideration: Boolean(r.pendingConsideration),
  }));

  // Per-holder totals, computed the same way rather than summed from the
  // per-row percentages, so the holder totals also sum to exactly 100.00.
  const holderIds = [...new Set(effective.map((r) => r.holderId))];
  const holderIssued = holderIds.map((h) =>
    effective.filter((r) => r.holderId === h && isShareCapital(r)).reduce((s, r) => s + r.count, 0),
  );
  const holderDiluted = holderIds.map((h) =>
    effective.filter((r) => r.holderId === h).reduce((s, r) => s + r.count * (r.conversionRatio ?? 1), 0),
  );
  const holderIssuedPcts = apportionPercent(holderIssued, issuedTotal);
  const holderDilutedPcts = apportionPercent(holderDiluted, dilutedTotal);

  const holderTotals: CapTableComputedHolderTotal[] = holderIds.map((h, i) => ({
    holderId: h,
    totalCount: holderDiluted[i],
    issuedPct: holderIssuedPcts[i] ?? 0,
    fullyDilutedPct: holderDilutedPcts[i] ?? 0,
  }));

  return { rows, holderTotals };
}
