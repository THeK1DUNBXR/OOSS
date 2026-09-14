/**
 * Technology — vendors and contracts (docs/plan/cio.md, workstream C).
 *
 * The pure arithmetic and the lifecycle machines `apps/api/src/domains/it/
 * vendors.ts` and its screens share. Nothing here reads a database: a
 * contract's notice-ladder rung, the value under management and the vendor
 * status machine are all computed or evaluated from what is passed in, so
 * they are tested without one (IT-VCT-002, IT-VEN-001).
 */

import { createMachine, type Machine } from '../hr.js';
import type { ItSummaryBase, ItTier } from './common.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const VENDOR_RISK_RATINGS = ['low', 'medium', 'high', 'critical'] as const;
export type VendorRiskRating = (typeof VENDOR_RISK_RATINGS)[number];

export const VENDOR_ASSESSMENT_STATUSES = ['not_assessed', 'in_progress', 'passed', 'failed', 'expired'] as const;
export type VendorAssessmentStatus = (typeof VENDOR_ASSESSMENT_STATUSES)[number];

export const VENDOR_ASSESSMENT_OUTCOMES = ['in_progress', 'passed', 'failed'] as const;
export type VendorAssessmentOutcome = (typeof VENDOR_ASSESSMENT_OUTCOMES)[number];

export const VENDOR_STATUSES = ['active', 'suspended', 'offboarded'] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

export const VENDOR_CONTRACT_STATUSES = [
  'draft',
  'proposed',
  'approved',
  'active',
  'expiring',
  'expired',
  'terminated',
] as const;
export type VendorContractStatus = (typeof VENDOR_CONTRACT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Vendor lifecycle — active <-> suspended -> offboarded (terminal)
// ---------------------------------------------------------------------------

export type VendorEvent = 'SUSPEND' | 'REINSTATE' | 'OFFBOARD';

export const vendorStatusMachine: Machine<VendorStatus, VendorEvent> = createMachine<VendorStatus, VendorEvent>(
  'ItVendor',
  {
    active: { SUSPEND: 'suspended', OFFBOARD: 'offboarded' },
    suspended: { REINSTATE: 'active', OFFBOARD: 'offboarded' },
    offboarded: {},
  },
);

export const VENDOR_EVENT_VERBS: Record<VendorEvent, string> = {
  SUSPEND: 'suspended',
  REINSTATE: 'reinstated',
  OFFBOARD: 'offboarded',
};

// ---------------------------------------------------------------------------
// Vendor contract lifecycle
// ---------------------------------------------------------------------------

/** User-initiated transitions. `expiring` and `expired` are job-driven only —
 * never reachable through this map, the same convention `CONTRACT_USER_
 * TRANSITIONS` keeps for the CRM-side contract. */
export const VENDOR_CONTRACT_USER_TRANSITIONS: Record<VendorContractStatus, VendorContractStatus[]> = {
  draft: ['proposed'],
  proposed: ['approved', 'terminated'],
  approved: ['active', 'terminated'],
  active: ['terminated'],
  expiring: ['terminated'],
  expired: [],
  terminated: [],
};

/** Transitions that run the approval gate (POL-IT-VENDOR-CONTRACT-APPROVAL). */
export const VENDOR_CONTRACT_PRIVILEGED_STATUSES: readonly VendorContractStatus[] = ['approved'];

// ---------------------------------------------------------------------------
// Assessment cadence — seed default, overridden by the dated
// ItVendorAssessmentCadenceRule table when a row exists.
// ---------------------------------------------------------------------------

/** Months between security assessments, by application/vendor tier. Read by
 * the seed to populate `ItVendorAssessmentCadenceRule`; kept here too as the
 * fallback a vendor with no seeded rule for its tier still gets, so
 * `assessmentDueAt` is never left unset for want of a row. */
export const VENDOR_ASSESSMENT_CADENCE_MONTHS: Record<ItTier, number> = {
  1: 6,
  2: 12,
  3: 18,
  4: 24,
};

export function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

// ---------------------------------------------------------------------------
// Notice-period ladder — days to (endDate - noticeDays): 30, 7, 0
// ---------------------------------------------------------------------------

export const VENDOR_LADDER_RUNGS = [30, 7, 0] as const;

/** The date notice must be given by: `endDate` minus `noticeDays`. Pure
 * arithmetic, no DB (IT-VCT-002's ladder is built on this). */
export function noticeDate(endDate: Date, noticeDays: number): Date {
  const d = new Date(endDate);
  d.setUTCDate(d.getUTCDate() - noticeDays);
  return d;
}

/**
 * The tightest rung of the 30/7/0 ladder that `daysToNotice` has already
 * crossed, or `null` if none has (still more than 30 days out). Shared by the
 * contract notice ladder and the vendor assessment-overdue ladder — both are
 * a plain "how many days until this date" ladder over the same rungs.
 */
export function noticeRung(daysToNotice: number): number | null {
  const crossed = VENDOR_LADDER_RUNGS.filter((r) => daysToNotice <= r);
  return crossed.length ? crossed[crossed.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Value under management
// ---------------------------------------------------------------------------

/** Statuses that represent a live commitment of spend — a draft or proposed
 * contract has not committed anything yet, and a terminated or expired one no
 * longer does. */
export const VENDOR_CONTRACT_VALUE_STATUSES: readonly VendorContractStatus[] = ['approved', 'active', 'expiring'];

/**
 * The sum of `value` across rows whose status represents a live commitment.
 * Pure arithmetic, no DB — currency is not normalised (every figure the
 * platform's own contracts carry is INR by default; a genuinely
 * multi-currency book would need an FX layer this does not attempt).
 */
export function contractValueUnderManagement(rows: Array<{ value: number; status: string }>): number {
  return rows
    .filter((r) => (VENDOR_CONTRACT_VALUE_STATUSES as readonly string[]).includes(r.status))
    .reduce((sum, r) => sum + r.value, 0);
}

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

export interface ItVendorView {
  id: string;
  recordCode: string;
  name: string;
  organizationId: string | null;
  category: string;
  tier: number;
  riskRating: VendorRiskRating;
  riskRatedAt: string | null;
  assessmentStatus: VendorAssessmentStatus;
  assessmentDueAt: string | null;
  dpaSigned: boolean;
  dpaSignedAt: string | null;
  contactName: string | null;
  contactEmail: string | null;
  status: VendorStatus;
  notes: string | null;
  availableTransitions: VendorEvent[];
  createdAt: string;
}

export interface ItVendorContractView {
  id: string;
  recordCode: string;
  vendorId: string;
  vendorName: string;
  title: string;
  /** `null` when the viewer does not hold `it_vendor_contracts:F` — withheld
   * server-side (`maskContractMoney` in `domains/it/vendors.ts`), present but
   * nulled rather than a silently dropped key. */
  value: number | null;
  currency: string | null;
  termMonths: number | null;
  startDate: string | null;
  endDate: string | null;
  noticeDays: number;
  autoRenew: boolean;
  slaText: string | null;
  documentId: string | null;
  ownerPartyId: string;
  status: VendorContractStatus;
  approvedById: string | null;
  approvedAt: string | null;
  renewedFromId: string | null;
  terminatedAt: string | null;
  terminationReason: string | null;
  daysToNotice: number | null;
  availableTransitions: VendorContractStatus[];
  requiresApprovalFor: VendorContractStatus[];
}

export interface ItVendorSummary extends ItSummaryBase {
  byTier: Record<string, number>;
  byRisk: Record<VendorRiskRating, number>;
  assessmentsOverdue: number;
  highRiskCount: number;
  highRiskWithDpa: number;
}

export interface ItVendorContractSummary extends ItSummaryBase {
  byStatus: Record<VendorContractStatus, number>;
  /** `null` when the viewer does not hold `it_vendor_contracts:F` — withheld
   * server-side the same way a single contract's `value` is. */
  valueUnderManagement: number | null;
  expiringIn90Days: number;
  awaitingApproval: number;
}
