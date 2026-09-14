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
// Rounds, instruments, valuations (equity-portal plan §6 phase 4)
// ---------------------------------------------------------------------------

export const FUNDING_ROUND_KINDS = [
  'seed', 'series', 'rights_issue', 'bonus', 'preferential', 'private_placement',
  'sweat_equity', 'esop_top_up', 'buyback', 'capital_reduction', 'conversion',
] as const;
export type FundingRoundKind = (typeof FUNDING_ROUND_KINDS)[number];

export const FUNDING_ROUND_KIND_LABELS: Record<FundingRoundKind, string> = {
  seed: 'Seed round',
  series: 'Priced series',
  rights_issue: 'Rights issue (s.62(1)(a))',
  bonus: 'Bonus issue (s.63)',
  preferential: 'Preferential allotment (s.62(1)(c))',
  private_placement: 'Private placement (s.42)',
  sweat_equity: 'Sweat equity (s.54)',
  esop_top_up: 'ESOP pool top-up',
  buyback: 'Buy-back (s.68)',
  capital_reduction: 'Reduction of capital (s.66)',
  conversion: 'Conversion',
};

export const FUNDING_ROUND_STATUSES = ['draft', 'open', 'closed', 'cancelled'] as const;
export type FundingRoundStatus = (typeof FUNDING_ROUND_STATUSES)[number];

/**
 * `ShareClass.conversionTerms` shape (§A). `atOptionOf` names who decides
 * when it is not automatic; `trigger` is a free sentence for a mandatory
 * conversion's condition (a qualified financing, an IPO) rather than a coded
 * enum, because the conditions a term sheet actually writes down do not
 * reduce to a short list.
 */
export interface ConversionTerms {
  convertsToClassId: string;
  /** Underlying equity shares per one unit of this class. */
  ratio: number;
  priceFloor?: number;
  byDate?: string;
  atOptionOf: 'holder' | 'company' | 'mandatory';
  trigger?: string;
}

/** `ShareClass.redemptionTerms` shape — RPS and NCD. */
export interface RedemptionTerms {
  redeemOn?: string;
  premium?: number;
  fromReserves: boolean;
}

export interface FundingRoundView {
  id: string;
  recordCode: string;
  name: string;
  kind: FundingRoundKind;
  status: FundingRoundStatus;
  openedOn: string | null;
  closedOn: string | null;
  preMoneyValuation: number | null;
  postMoneyValuation: number | null;
  raised: number | null;
  pricePerShareByClass: Record<string, number> | null;
  valuationId: string | null;
  boardResolutionRef: string | null;
  shareholderResolutionRef: string | null;
  mgt14Srn: string | null;
  pas3Srn: string | null;
  pas3FiledOn: string | null;
  offerLetterSerial: string | null;
  separateBankAccountRef: string | null;
  offereeCount: number | null;
  renunciationAllowed: boolean | null;
  sourceOfBonus: string | null;
  valuationReportRef: string | null;
  tribunalOrderRef: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Scenario modelling — pure, never persisted (§6 phase 4). A proposed round or
// exit is arithmetic over the live cap table, not a fact about the company;
// nothing in this section reads or writes a database.
// ---------------------------------------------------------------------------

export interface ScenarioCapTableRow {
  holderId: string;
  holderName: string;
  shareClassId: string;
  /** liquidation preference multiple, participating, seniority (0 = paid first) */
  preference?: { multiple: number; participating: boolean; seniority: number } | null;
  count: number;
}

export interface ModelRoundInput {
  newMoney: number;
  preMoney: number;
  newClass: {
    name: string;
    liquidationPreferenceMultiple: number;
    participating: boolean;
    seniority: number;
  };
  /** Percentage of the post-money fully-diluted cap the option pool is topped up to, before the new money is priced in — the standard "pool shuffle". */
  optionPoolTopUpPct?: number;
}

export interface ModelRoundHolderRow {
  holderId: string;
  holderName: string;
  before: { count: number; pct: number };
  after: { count: number; pct: number };
  dilutionPct: number;
}

export interface ModelRoundResult {
  postMoney: number;
  pricePerShare: number;
  newShares: number;
  poolTopUpShares: number;
  holders: ModelRoundHolderRow[];
}

/**
 * A proposed round applied to the live cap table: post-money, the price
 * implied by it, how many new shares that mints, and — because a pool top-up
 * is dilutive to everyone except the pool itself — the pool shares minted
 * before the new money's shares are counted, per the standard mechanic (the
 * pool top-up dilutes existing holders, not the incoming investor).
 *
 * Every existing holder is diluted by exactly the same proportion of the
 * pre-round total (pro-rata): nobody's *pre-round* pct changes, only what it
 * becomes of the larger post-round total.
 */
export function modelRound(capTable: ScenarioCapTableRow[], input: ModelRoundInput): ModelRoundResult {
  const preTotal = capTable.reduce((s, r) => s + r.count, 0);
  const postMoney = input.preMoney + input.newMoney;
  const pricePerShare = preTotal > 0 && input.preMoney > 0 ? input.preMoney / preTotal : 0;

  // Pool top-up: mint enough pool shares that the pool reaches the target
  // percentage of the post-round fully-diluted total, funded by diluting the
  // existing holders (the new investor's shares are priced on top of it).
  let poolTopUpShares = 0;
  if (input.optionPoolTopUpPct && input.optionPoolTopUpPct > 0 && pricePerShare > 0) {
    const targetPct = input.optionPoolTopUpPct / 100;
    // shares needed so pool / (preTotal + pool) = targetPct, solved for pool.
    poolTopUpShares = Math.round((targetPct * preTotal) / (1 - targetPct));
  }

  const preTotalWithPool = preTotal + poolTopUpShares;
  const newShares = pricePerShare > 0 ? Math.round(input.newMoney / pricePerShare) : 0;
  const postTotal = preTotalWithPool + newShares;

  const holders: ModelRoundHolderRow[] = capTable.map((r) => {
    const beforePct = preTotal > 0 ? (r.count / preTotal) * 100 : 0;
    const afterPct = postTotal > 0 ? (r.count / postTotal) * 100 : 0;
    return {
      holderId: r.holderId,
      holderName: r.holderName,
      before: { count: r.count, pct: round2(beforePct) },
      after: { count: r.count, pct: round2(afterPct) },
      dilutionPct: round2(beforePct - afterPct),
    };
  });

  return { postMoney: round2(postMoney), pricePerShare: round2(pricePerShare), newShares, poolTopUpShares, holders };
}

export interface WaterfallHolderResult {
  holderId: string;
  holderName: string;
  shareClassId: string;
  /** What the preference stack pays this row before any as-converted sharing. */
  preferencePayout: number;
  /** What sharing the remainder as-converted equity pays this row. */
  commonPayout: number;
  /** The better of taking the preference or converting to common, per holder — a non-participating holder's own choice. */
  totalPayout: number;
  converted: boolean;
}

export interface WaterfallResult {
  exitValue: number;
  rows: WaterfallHolderResult[];
  /** Anything left over after every class is paid — should be ~0 when the whole exit value clears the stack. */
  unallocated: number;
}

/**
 * Distribution by preference stack at a given exit value: senior classes
 * (lowest `seniority` number first) are paid their preference — multiple ×
 * their count's face contribution — before anything reaches common, a
 * participating class also shares the remainder alongside common, and a
 * non-participating class takes whichever of (preference) or (as-converted
 * common share) is larger — the choice a rational holder actually makes.
 *
 * `pricePerShare` is the per-share basis the preference multiple applies to
 * (the price that class was issued at); passed per row via `count`'s implicit
 * face is not enough on its own, so callers pass it as part of the class's
 * `preference` block through `issuePricePerShare` on the input row — kept
 * simple here by taking it as a flat map to avoid growing the row shape
 * further for a function nothing persists.
 */
export function waterfall(
  capTable: ScenarioCapTableRow[],
  issuePricePerShareByClass: Record<string, number>,
  exitValue: number,
): WaterfallResult {
  let remaining = exitValue;
  const totalCommonEquivalent = capTable.reduce((s, r) => s + r.count, 0);

  // Preference classes, senior (lowest seniority number) first.
  const preferenceRows = capTable
    .filter((r) => r.preference)
    .sort((a, b) => (a.preference!.seniority ?? 0) - (b.preference!.seniority ?? 0));

  const preferencePayout = new Map<string, number>();
  for (const r of preferenceRows) {
    const key = `${r.holderId}::${r.shareClassId}`;
    const price = issuePricePerShareByClass[r.shareClassId] ?? 0;
    const pref = Math.min(remaining, price * r.count * r.preference!.multiple);
    preferencePayout.set(key, pref);
    remaining = round2(remaining - pref);
  }

  // The remainder is shared as-converted equity among common holders and any
  // participating preference holders (who take their preference AND share
  // the remainder alongside common).
  const participatingHolders = new Set(
    capTable.filter((r) => r.preference?.participating).map((r) => `${r.holderId}::${r.shareClassId}`),
  );
  const commonHolders = capTable.filter((r) => !r.preference || participatingHolders.has(`${r.holderId}::${r.shareClassId}`));
  const commonTotal = commonHolders.reduce((s, r) => s + r.count, 0);

  const commonPayout = new Map<string, number>();
  for (const r of commonHolders) {
    const key = `${r.holderId}::${r.shareClassId}`;
    const share = commonTotal > 0 ? (r.count / commonTotal) * remaining : 0;
    commonPayout.set(key, round2(share));
  }
  const allocatedToCommon = [...commonPayout.values()].reduce((s, v) => s + v, 0);
  remaining = round2(remaining - allocatedToCommon);

  // As-converted comparison for a non-participating class: what it would get
  // if it gave up the preference and shared the WHOLE remaining pool
  // (preference stack unwound above it) as if it were common from the start.
  const asConvertedTotal = totalCommonEquivalent;
  const rows: WaterfallHolderResult[] = capTable.map((r) => {
    const key = `${r.holderId}::${r.shareClassId}`;
    const pref = preferencePayout.get(key) ?? 0;
    const common = commonPayout.get(key) ?? 0;
    const nonParticipating = Boolean(r.preference && !r.preference.participating);

    if (!nonParticipating) {
      return {
        holderId: r.holderId,
        holderName: r.holderName,
        shareClassId: r.shareClassId,
        preferencePayout: round2(pref),
        commonPayout: round2(common),
        totalPayout: round2(pref + common),
        converted: false,
      };
    }

    const asConvertedShare = asConvertedTotal > 0 ? (r.count / asConvertedTotal) * exitValue : 0;
    const takePreference = pref >= asConvertedShare;
    return {
      holderId: r.holderId,
      holderName: r.holderName,
      shareClassId: r.shareClassId,
      preferencePayout: round2(takePreference ? pref : 0),
      commonPayout: round2(takePreference ? 0 : asConvertedShare),
      totalPayout: round2(takePreference ? pref : asConvertedShare),
      converted: !takePreference,
    };
  });

  return { exitValue: round2(exitValue), rows, unallocated: round2(remaining) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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
  redemptionTerms: Record<string, unknown> | null;
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

// ---------------------------------------------------------------------------
// The group (equity-portal plan §3.3, §5 "Group", §6 phase 2).
//
// The group screen never reads a subsidiary's own tables (§3.3) — everything
// here operates on `EntitySnapshot` rows the subsidiary has already published
// into its parent. This section is pure vocabulary and the look-through
// arithmetic; the read model that assembles snapshots into these shapes lives
// in `apps/api/src/domains/group.ts`.
// ---------------------------------------------------------------------------

/** s.2(87)/s.90 badges, plus the one status that is not yet a real tenant. */
export const GROUP_ENTITY_BADGES = [
  'wholly_owned', 'subsidiary', 'associate', 'investment', 'not_yet_incorporated',
] as const;
export type GroupEntityBadge = (typeof GROUP_ENTITY_BADGES)[number];

export const GROUP_ENTITY_BADGE_LABELS: Record<GroupEntityBadge, string> = {
  wholly_owned: 'Wholly owned',
  subsidiary: 'Subsidiary',
  associate: 'Associate',
  investment: 'Investment',
  not_yet_incorporated: 'Not yet incorporated',
};

/**
 * The heading the plan requires word for word (§1, answer 5): a group total
 * is an addition, not a consolidation, and the screen must say so in these
 * exact words. Kept as one constant so no client copy can quietly rename it.
 */
export const GROUP_LABELS = {
  totalBeforeEliminations: 'Group total before inter-company eliminations',
  aggregatedNotConsolidated: 'Aggregated, not consolidated',
} as const;

/** s.90: a look-through holding of 10% or more makes a person a Significant Beneficial Owner. */
export const GROUP_SBO_THRESHOLD_PCT = 10;

/** A snapshot older than this reads as stale on the group screen. */
export const GROUP_SNAPSHOT_STALE_HOURS = 24;

/** Two layers of wholly/majority-owned subsidiaries is the s.2(87) limit before it is flagged. */
export const GROUP_LAYER_LIMIT = 2;

export type LookThroughMatch = 'email' | 'pan' | 'unmatched';

/** A folio's cross-tenant identity: lower-cased email when known, else `pan:<sha256>`, else unmatched. */
export function holderKeyFor(input: { email?: string | null; panHash?: string | null }): { key: string | null; matchedBy: LookThroughMatch } {
  if (input.email) return { key: input.email.trim().toLowerCase(), matchedBy: 'email' };
  if (input.panHash) return { key: `pan:${input.panHash}`, matchedBy: 'pan' };
  return { key: null, matchedBy: 'unmatched' };
}

export interface LookThroughDirectRow {
  entityId: string;
  holderKey: string;
  issuedPct: number;
  fullyDilutedPct: number;
  matchedBy: LookThroughMatch;
}

/** One group entity's stake in another, read from the child's own cap table (the row where `heldByTenantId` is the parent). */
export interface LookThroughEdge {
  parentEntityId: string;
  childEntityId: string;
  issuedPct: number;
  fullyDilutedPct: number;
}

export interface LookThroughRow {
  entityId: string;
  holderKey: string;
  issuedPct: number;
  fullyDilutedPct: number;
  matchedBy: LookThroughMatch;
}

/**
 * Effective ownership of each holder in each entity: direct % plus, for every
 * entity that itself holds a stake in this one, that entity's own look-through
 * % of the holder times its stake — the worked example in the plan is
 * founder 60% of the holding × the holding's 70% of a subsidiary, plus the
 * founder's own 5% direct in the subsidiary, giving 47%.
 *
 * Computed depth-first from each entity's parents (an entity with no parent
 * edge is its own base case), memoised so a diamond in the graph is not
 * recomputed, and refusing outright — never silently truncating — a cycle,
 * which the group's own s.19 rule should make impossible but which this
 * function does not trust to stay impossible.
 */
export function computeLookThrough(direct: LookThroughDirectRow[], edges: LookThroughEdge[]): LookThroughRow[] {
  const entityIds = new Set<string>();
  for (const d of direct) entityIds.add(d.entityId);
  for (const e of edges) {
    entityIds.add(e.parentEntityId);
    entityIds.add(e.childEntityId);
  }

  const parentsOf = new Map<string, LookThroughEdge[]>();
  for (const e of edges) {
    if (!parentsOf.has(e.childEntityId)) parentsOf.set(e.childEntityId, []);
    parentsOf.get(e.childEntityId)!.push(e);
  }

  const matchedByKey = new Map<string, LookThroughMatch>();
  for (const d of direct) {
    if (!matchedByKey.has(d.holderKey) || matchedByKey.get(d.holderKey) === 'unmatched') {
      matchedByKey.set(d.holderKey, d.matchedBy);
    }
  }

  const memo = new Map<string, Map<string, { issuedPct: number; fullyDilutedPct: number }>>();
  const visiting = new Set<string>();

  function compute(entityId: string): Map<string, { issuedPct: number; fullyDilutedPct: number }> {
    const cached = memo.get(entityId);
    if (cached) return cached;
    if (visiting.has(entityId)) {
      throw new Error(`Look-through ownership graph has a cycle at entity ${entityId} — refused rather than computed.`);
    }
    visiting.add(entityId);

    const holderMap = new Map<string, { issuedPct: number; fullyDilutedPct: number }>();
    for (const row of direct.filter((r) => r.entityId === entityId)) {
      const cur = holderMap.get(row.holderKey) ?? { issuedPct: 0, fullyDilutedPct: 0 };
      cur.issuedPct += row.issuedPct;
      cur.fullyDilutedPct += row.fullyDilutedPct;
      holderMap.set(row.holderKey, cur);
    }

    for (const edge of parentsOf.get(entityId) ?? []) {
      const parentLookThrough = compute(edge.parentEntityId);
      for (const [holderKey, pct] of parentLookThrough) {
        const cur = holderMap.get(holderKey) ?? { issuedPct: 0, fullyDilutedPct: 0 };
        cur.issuedPct += (pct.issuedPct * edge.issuedPct) / 100;
        cur.fullyDilutedPct += (pct.fullyDilutedPct * edge.fullyDilutedPct) / 100;
        holderMap.set(holderKey, cur);
      }
    }

    visiting.delete(entityId);
    memo.set(entityId, holderMap);
    return holderMap;
  }

  for (const id of entityIds) compute(id);

  const rows: LookThroughRow[] = [];
  for (const [entityId, holderMap] of memo) {
    for (const [holderKey, pct] of holderMap) {
      rows.push({
        entityId,
        holderKey,
        issuedPct: Math.round(pct.issuedPct * 100) / 100,
        fullyDilutedPct: Math.round(pct.fullyDilutedPct * 100) / 100,
        matchedBy: matchedByKey.get(holderKey) ?? 'unmatched',
      });
    }
  }
  return rows;
}

/** s.2(87): the badge for one entity's stake in another, by total share capital (`issuedPct`). */
export function groupEntityBadge(issuedPct: number): Exclude<GroupEntityBadge, 'not_yet_incorporated'> {
  if (issuedPct >= 100) return 'wholly_owned';
  if (issuedPct > 50) return 'subsidiary';
  if (issuedPct >= 20) return 'associate';
  return 'investment';
}

export interface GroupStructureNodeView {
  /** `null` for a not-yet-incorporated division node. */
  tenantId: string | null;
  slug: string | null;
  name: string;
  kind: 'holding' | 'subsidiary' | 'standalone' | 'not_yet_incorporated';
  originDivision: string | null;
  badge: GroupEntityBadge | null;
  layerDepth: number;
  layerLimitExceeded: boolean;
  asOf: string | null;
  publishedAt: string | null;
  staleSeconds: number | null;
  stale: boolean;
}

export interface GroupStructureEdgeView {
  parentTenantId: string;
  childTenantId: string;
  issuedPct: number;
  fullyDilutedPct: number;
  badge: GroupEntityBadge;
}

export interface GroupStructureView {
  self: { tenantId: string; slug: string; name: string; kind: string };
  nodes: GroupStructureNodeView[];
  edges: GroupStructureEdgeView[];
}

export interface GroupHolderEntityStake {
  directIssuedPct: number;
  directFullyDilutedPct: number;
  lookThroughIssuedPct: number;
  lookThroughFullyDilutedPct: number;
  matchedBy: LookThroughMatch;
}

export interface GroupHolderRowView {
  holderKey: string;
  displayName: string;
  perEntity: Record<string, GroupHolderEntityStake>;
  /** s.90: true when the look-through, fully-diluted stake in any entity reaches `GROUP_SBO_THRESHOLD_PCT`. */
  sbo: boolean;
}

export interface GroupEntityFinancialView {
  tenantId: string;
  name: string;
  period: string;
  cash: number | null;
  pnlMonth: { income: number; expense: number; net: number } | null;
  pnlFyToDate: { income: number; expense: number; net: number } | null;
  headcount: number;
  intercompanyIn: number | null;
  intercompanyOut: number | null;
  asOf: string;
}

export interface GroupFinancialsView {
  entities: GroupEntityFinancialView[];
  totalLabel: typeof GROUP_LABELS.totalBeforeEliminations;
  totalCash: number | null;
  totalPnlMonth: { income: number; expense: number; net: number } | null;
  intercompanyTotal: { in: number; out: number } | null;
}

export interface GroupComplianceRowView {
  tenantId: string;
  name: string;
  dematStatus: DematStatus | null;
  isSmallCompany: boolean | null;
  certificateOverdueCount: number;
  kind: string;
  asOf: string;
  publishedAt: string;
  staleSeconds: number;
  stale: boolean;
}
