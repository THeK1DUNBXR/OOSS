/**
 * P0 + P7 — the five-axis permission model.
 *
 * Access is evaluated on five axes — WHO × WHERE × WHAT × HOW MUCH × WHY — at
 * query time, never cached at login. All five must evaluate true for an action
 * to be permitted. A revoked affiliation goes dark on the very next query.
 *
 * Tenant scoping is NOT one of the five axes: it is a gate the request clears
 * before WHO/WHERE/WHAT/HOW MUCH/WHY are evaluated at all, and it fails with a
 * 404 (never a 403 — a weaker information leak than confirming the record
 * exists in another tenant).
 */

import type { SensitivityClass } from './events.js';

// ---------------------------------------------------------------------------
// Grant vocabulary. The letter-matrix vocabulary is migrated verbatim, not
// redesigned — a developer who knows `people:VCEA@own` needs to learn a new
// storage/evaluation mechanism, not a new grant language.
// ---------------------------------------------------------------------------

export const VERBS = {
  V: 'view',
  C: 'create',
  E: 'edit',
  D: 'delete',
  A: 'assign',
  X: 'export',
  F: 'financial',
} as const;

export type VerbLetter = keyof typeof VERBS;
export type Verb = (typeof VERBS)[VerbLetter] | 'approve' | 'merge';

/** Verbs held as their own grant, never inherited from the base edit verb. */
export const DISTINCT_GRANT_VERBS = ['approve', 'merge'] as const;

export const SCOPES = ['own', 'own_or_unowned', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

export interface ParsedGrant {
  resource: string;
  verbs: Verb[];
  scope: Scope;
}

/**
 * Parses a grant string such as `institutions:VCEA@own_or_unowned` or
 * `mous:approve`. Verb letters and long-form verbs may be mixed:
 * `mous:VCEA,approve@all`.
 */
export function parseGrant(grantString: string): ParsedGrant {
  const [resourcePart, rest] = splitOnce(grantString, ':');
  if (!rest) throw new Error(`Malformed grant string (no verbs): ${grantString}`);
  const [verbPart, scopePart] = splitOnce(rest, '@');

  const verbs: Verb[] = [];
  for (const token of verbPart.split(',')) {
    const t = token.trim();
    if (!t) continue;
    if (t === 'approve' || t === 'merge') {
      verbs.push(t);
      continue;
    }
    for (const letter of t) {
      const verb = VERBS[letter as VerbLetter];
      if (!verb) throw new Error(`Unknown verb letter '${letter}' in grant: ${grantString}`);
      verbs.push(verb);
    }
  }

  const scope = (scopePart ?? 'all') as Scope;
  if (!SCOPES.includes(scope)) throw new Error(`Unknown scope '${scope}' in grant: ${grantString}`);

  return { resource: resourcePart, verbs, scope };
}

function splitOnce(input: string, sep: string): [string, string | undefined] {
  const i = input.indexOf(sep);
  if (i === -1) return [input, undefined];
  return [input.slice(0, i), input.slice(i + sep.length)];
}

export function formatGrant(g: ParsedGrant): string {
  const letters = g.verbs.filter((v) => v !== 'approve' && v !== 'merge').map(letterFor).join('');
  const longs = g.verbs.filter((v) => v === 'approve' || v === 'merge');
  const verbPart = [letters, ...longs].filter(Boolean).join(',');
  return `${g.resource}:${verbPart}@${g.scope}`;
}

function letterFor(verb: Verb): string {
  const entry = Object.entries(VERBS).find(([, v]) => v === verb);
  return entry ? entry[0] : '';
}

// ---------------------------------------------------------------------------
// Resources — the 14 legacy resources plus every resource added by this handoff.
// ---------------------------------------------------------------------------

export const RESOURCES = [
  // legacy 14
  'people',
  'organizations',
  'institutions',
  'relationships',
  'leads',
  'opportunities',
  'mous',
  'activities',
  'documents',
  'education',
  'projects',
  'payments',
  'users',
  'reports',
  // added by this handoff
  'pipeline_definitions',
  'pipeline_stages',
  'pipeline_transitions',
  'territories',
  'routing_rules',
  'offerings',
  'price_book_entries',
  'proposals',
  'quotes',
  'contracts',
  'partner_agreements',
  'win_loss_reviews',
  'interactions',
  // Need-to-know on a restricted interaction is a grant, not a role check.
  // Holding it is what makes a principal need-to-know; no service compares a
  // slug to decide.
  'restricted_interactions',
  'receivables',
  'invoices',
  'health_scores',
  'decisions',
  'exceptions',
  'policies',
  'grants',
  'agents',
  'jobs',
  'audit',
  'events',
  // People (hr, Canon §14). `employees` is the employment spine; the rest are
  // separated because the authority over them genuinely differs — a manager
  // approves leave without ever seeing pay, and hr_ops moves pay without
  // deciding a disciplinary case.
  'employees',
  'positions',
  'requisitions',
  'applications',
  'assignments',
  'compensation',
  'leave',
  'attendance',
  'goals',
  // Case-scoped disciplinary and ICC evidence. Held separately from `goals`
  // because need-to-know on a case is a grant, not a seniority.
  'performance_evidence',
  'learning',
  'capabilities',
  'payroll',
] as const;

export type Resource = (typeof RESOURCES)[number];

// ---------------------------------------------------------------------------
// The role register.
// ---------------------------------------------------------------------------

/** The ten legacy role slugs, carried forward unchanged into the GRANT model. */
export const LEGACY_ROLE_SLUGS = [
  'founder',
  'admin',
  'sales',
  'telecaller',
  'education_counsellor',
  'trainer',
  'project_manager',
  'workforce_placement',
  'marketing',
  'finance',
] as const;

/**
 * Target-state additions. `founder` splits into `chairman` (organisational and
 * commercial authority) and `system_admin` (platform administration, with
 * explicitly no domain content authority).
 *
 * `sales_ops` is deliberately absent: it is an open role-register question this
 * handoff does not resolve unilaterally. Everywhere it would naturally hold
 * pipeline/territory/catalog authoring rights, `business_head` holds them as a
 * stated interim default.
 */
export const TARGET_ROLE_SLUGS = [
  'chairman',
  'system_admin',
  // The HR function. Named by §14.6.4, which requires hr_ops plus an
  // independent second verifier for a capability claim that moves pay — a rule
  // that cannot be written without a role to name.
  'hr_ops',
  'business_head',
  'director',
  'finance_controller',
  ...LEGACY_ROLE_SLUGS,
] as const;

export type RoleSlug = (typeof TARGET_ROLE_SLUGS)[number];

/** Roles structurally excluded from every approver_resolution tier. */
export const APPROVAL_EXCLUDED_ROLES: RoleSlug[] = ['system_admin'];

// ---------------------------------------------------------------------------
// Money-field masking (the pre-existing WHAT-axis control, retained and extended).
// ---------------------------------------------------------------------------

export const MONEY_FIELDS = [
  'amount',
  'value',
  'commercialValue',
  'commercial_value',
  'unitPrice',
  'unit_price',
  'listUnitPrice',
  'grandTotal',
  'grand_total',
  'subtotal',
  'discountTotal',
  'discountAmount',
  'lineTotal',
  'expectedValue',
  'expected_value',
  'allocatedAmount',
  'amountOutstanding',
  'totalValue',
  'total_value',
  'pipelineValue',
  'weightedValue',
  'revenue',
  'ceilingValue',
  // Pay. A colleague's salary is money like any other money, and it reaches
  // the same masking path rather than a special case that has to be
  // remembered at every call site.
  'grossAmount',
  'gross_amount',
  'netAmount',
  'net_amount',
  'ctc',
  'basicPay',
  'monthlyRate',
];

/**
 * `regulated`-classified fields are structurally excluded from a projection
 * entirely, not merely nulled at render time. A masked field's presence (as
 * null) still tells a viewer something is being withheld; a structurally
 * excluded field does not appear in the response shape at all.
 */
export const REGULATED_EXCLUDED_FIELDS = [
  'bankAccountReference',
  'bank_account_reference',
  'taxRegistrationReference',
  'tax_registration_reference',
  'guardianPhone',
  'guardianEmail',
  'nationalId',
  // Statutory identifiers held on an employment record.
  'panNumber',
  'pan_number',
  'aadhaarReference',
  'aadhaar_reference',
  'uanNumber',
  'uan_number',
  'pfAccountNumber',
  'esiNumber',
];

// ---------------------------------------------------------------------------
// Axis definitions, used by the evaluator and surfaced in the admin UI.
// ---------------------------------------------------------------------------

export const AXES = [
  { code: 'WHO', question: 'Which principal — human via Party/Affiliation, or AI agent via its own bounded identity — is asking?' },
  { code: 'WHERE', question: 'What tenant, org unit, or scope boundary does this request originate from?' },
  { code: 'WHAT', question: 'Which specific field, record, or action is being requested?' },
  { code: 'HOW_MUCH', question: 'Is there a value, count, or risk-class limit on this grant?' },
  { code: 'WHY', question: 'What purpose is this access bound to?' },
] as const;

export type AxisCode = (typeof AXES)[number]['code'];

export interface AxisOutcome {
  axis: AxisCode;
  passed: boolean;
  reason?: string;
}

export interface PermissionDecision {
  allowed: boolean;
  axes: AxisOutcome[];
  /** The policy version in force at decision time — pinned onto the event envelope's reason. */
  policyId?: string | null;
  policyVersion?: number | null;
  deniedBy?: AxisCode;
  reasonCode?: string;
}

/**
 * The classification ceiling each role may read up to. Administrative roles are
 * deliberately not narrowed by record-level classification — a stated exception,
 * not an oversight.
 */
export const ROLE_CLASSIFICATION_CEILING: Record<string, SensitivityClass> = {
  founder: 'regulated',
  chairman: 'regulated',
  admin: 'regulated',
  system_admin: 'internal', // platform administration, explicitly no domain content authority
  director: 'confidential',
  business_head: 'confidential',
  finance_controller: 'confidential',
  finance: 'restricted',
  sales: 'internal',
  telecaller: 'internal',
  education_counsellor: 'restricted',
  trainer: 'internal',
  project_manager: 'internal',
  workforce_placement: 'internal',
  marketing: 'internal',
  // HR reads statutory identifiers and disciplinary evidence, so it needs the
  // top ceiling. That is not seniority — it is the job.
  hr_ops: 'regulated',
};
