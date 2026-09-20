/**
 * HCM — WS11 assets (docs/hcm/assets.md).
 *
 * Pure shapes and logic shared between the domain layer and the test suite:
 * the closed vocabularies, the asset status machine (small enough not to
 * warrant the generic HR_MACHINES shape), and the letter-request kinds that
 * do and do not map onto compliance labour's own `HrLetterKind`.
 */

export const HCM_ASSETS_MODULE = 'assets' as const;

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const ASSET_CATEGORIES = ['laptop', 'phone', 'access_card', 'other'] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const ASSET_STATUSES = ['in_stock', 'assigned', 'repair', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ASSET_CONDITIONS = ['good', 'fair', 'poor'] as const;
export type AssetCondition = (typeof ASSET_CONDITIONS)[number];

/** `from -> to` pairs a plain status field on Asset is allowed to move through. */
const ASSET_TRANSITIONS: Record<AssetStatus, AssetStatus[]> = {
  in_stock: ['assigned', 'retired'],
  assigned: ['in_stock', 'repair'],
  repair: ['in_stock', 'retired'],
  retired: [],
};

export function canTransitionAsset(from: AssetStatus, to: AssetStatus): boolean {
  return ASSET_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Travel requests
// ---------------------------------------------------------------------------

export const TRAVEL_MODES = ['flight', 'train', 'road', 'other'] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

export const TRAVEL_REQUEST_STATUSES = ['submitted', 'approved', 'rejected', 'settled'] as const;
export type TravelRequestStatus = (typeof TRAVEL_REQUEST_STATUSES)[number];

/** A travel request may only be decided (approved/rejected) while submitted, and settled only once approved. */
export function canTransitionTravelRequest(from: TravelRequestStatus, to: TravelRequestStatus): boolean {
  if (from === 'submitted') return to === 'approved' || to === 'rejected';
  if (from === 'approved') return to === 'settled';
  return false;
}

/**
 * The Self-Dealing Bar for a travel approval: the approver must not be the
 * person the travel is for. Pure so the domain layer and the tests share one
 * definition of the rule rather than each spelling out the comparison.
 */
export function isSelfDealingApproval(approverPartyId: string, subjectPersonId: string): boolean {
  return approverPartyId === subjectPersonId;
}

// ---------------------------------------------------------------------------
// Letter requests
// ---------------------------------------------------------------------------

export const LETTER_REQUEST_KINDS = ['address_proof', 'salary_certificate', 'noc', 'visa', 'experience'] as const;
export type LetterRequestKind = (typeof LETTER_REQUEST_KINDS)[number];

export const LETTER_REQUEST_STATUSES = ['requested', 'fulfilled', 'rejected'] as const;
export type LetterRequestStatus = (typeof LETTER_REQUEST_STATUSES)[number];

export function canTransitionLetterRequest(from: LetterRequestStatus, to: LetterRequestStatus): boolean {
  return from === 'requested' && (to === 'fulfilled' || to === 'rejected');
}

/**
 * Of the five request kinds, only `experience` also names one of compliance
 * labour's own `HrLetterKind`s — the other four (address proof, salary
 * certificate, NOC, visa) are letters this platform has never modelled as an
 * `HrLetter`, so fulfilling them writes this workstream's own snapshot
 * instead of calling into `compliance/labour.ts`.
 */
const KINDS_WITH_HR_LETTER: ReadonlySet<LetterRequestKind> = new Set(['experience']);

export function fulfilsViaHrLetter(kind: LetterRequestKind): boolean {
  return KINDS_WITH_HR_LETTER.has(kind);
}

/** The plain-text body for a letter-request kind this workstream fulfils itself. */
export function buildOwnLetterBody(
  kind: Exclude<LetterRequestKind, 'experience'>,
  facts: { employeeName: string; legalEntity: string; designation?: string | null; issuedOn: string; number: string },
): string {
  const { employeeName, legalEntity, designation, issuedOn, number } = facts;
  switch (kind) {
    case 'address_proof':
      return (
        `${legalEntity}\n\nAddress Proof Letter — ${number}\nDated ${issuedOn}\n\n` +
        `This is to certify that ${employeeName}${designation ? `, ${designation},` : ''} is employed with ` +
        `${legalEntity} and the address on record with us is held on file for verification purposes.`
      );
    case 'salary_certificate':
      return (
        `${legalEntity}\n\nSalary Certificate — ${number}\nDated ${issuedOn}\n\n` +
        `This is to certify that ${employeeName}${designation ? `, ${designation},` : ''} is employed with ` +
        `${legalEntity}. Salary particulars are held on file and available to the addressee this certificate names.`
      );
    case 'noc':
      return (
        `${legalEntity}\n\nNo-Objection Certificate — ${number}\nDated ${issuedOn}\n\n` +
        `${legalEntity} has no objection to the request made by ${employeeName}` +
        `${designation ? `, ${designation},` : ''} for the purpose stated in their application.`
      );
    case 'visa':
      return (
        `${legalEntity}\n\nLetter for Visa Purposes — ${number}\nDated ${issuedOn}\n\n` +
        `This is to certify that ${employeeName}${designation ? ` holds the position of ${designation}` : ''} at ` +
        `${legalEntity} and is expected to return to this employment on completion of travel.`
      );
  }
}
