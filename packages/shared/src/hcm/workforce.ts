/**
 * HCM — WS1 workforce (docs/hcm/workforce.md).
 *
 * Pure logic and shared types for the employee master extension, org
 * design (cost centres, locations, grades) and employee status changes
 * (transfer/promotion/demotion/redesignation). No I/O here — the domain
 * layer (`apps/api/src/domains/hcm/workforce.ts`) is the only caller.
 */

export const HCM_WORKFORCE_MODULE = 'workforce' as const;

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

export const EMPLOYEE_DOCUMENT_KINDS = [
  'id_proof',
  'address_proof',
  'education',
  'offer',
  'contract',
  'other',
] as const;
export type EmployeeDocumentKind = (typeof EMPLOYEE_DOCUMENT_KINDS)[number];

export const REPORTING_LINE_KINDS = ['primary', 'dotted'] as const;
export type ReportingLineKind = (typeof REPORTING_LINE_KINDS)[number];

export const EMPLOYEE_STATUS_CHANGE_KINDS = [
  'transfer',
  'promotion',
  'demotion',
  'redesignation',
] as const;
export type EmployeeStatusChangeKind = (typeof EMPLOYEE_STATUS_CHANGE_KINDS)[number];

export const EMPLOYEE_STATUS_CHANGE_STATES = [
  'pending_approval',
  'approved',
  'rejected',
  'applied',
] as const;
export type EmployeeStatusChangeState = (typeof EMPLOYEE_STATUS_CHANGE_STATES)[number];

/**
 * The only legal moves for a status change: decide once from
 * `pending_approval`, then apply only an `approved` one. There is no path
 * back from `rejected` or `applied` — a correction is a new request, the
 * same discipline every lifecycle on this platform follows.
 */
export const EMPLOYEE_STATUS_CHANGE_TRANSITIONS: Record<
  EmployeeStatusChangeState,
  EmployeeStatusChangeState[]
> = {
  pending_approval: ['approved', 'rejected'],
  approved: ['applied'],
  rejected: [],
  applied: [],
};

export function canTransitionStatusChange(
  from: EmployeeStatusChangeState,
  to: EmployeeStatusChangeState,
): boolean {
  return EMPLOYEE_STATUS_CHANGE_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Regulated-field masking — PAN/Aadhaar-shaped identifiers, last four only.
// ---------------------------------------------------------------------------

/** `"M1234567"` → `"••••4567"`. Null/empty passes through unchanged. */
export function maskRegulatedId(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Org chart — a pure tree builder over reporting lines
// ---------------------------------------------------------------------------

export interface OrgChartPersonFact {
  employmentRelationshipId: string;
  managerEmploymentRelationshipId: string | null;
  fullName: string;
  title: string | null;
  orgUnitName: string | null;
}

export interface OrgChartNode extends OrgChartPersonFact {
  directReportCount: number;
  reports: OrgChartNode[];
}

/**
 * Builds the org tree from a flat list of (employee, manager) facts. Anyone
 * with no manager, or whose stated manager is not in the set (an org unit
 * head reporting to nobody yet on this tenant), becomes a root — the tree
 * always renders something rather than silently dropping a person whose
 * manager fact does not resolve.
 */
export function buildOrgTree(people: OrgChartPersonFact[]): OrgChartNode[] {
  const byId = new Map<string, OrgChartNode>();
  for (const p of people) byId.set(p.employmentRelationshipId, { ...p, directReportCount: 0, reports: [] });

  const roots: OrgChartNode[] = [];
  for (const node of byId.values()) {
    const manager = node.managerEmploymentRelationshipId ? byId.get(node.managerEmploymentRelationshipId) : undefined;
    if (manager && manager.employmentRelationshipId !== node.employmentRelationshipId) {
      manager.reports.push(node);
      manager.directReportCount += 1;
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** Span of control: how many direct reports each manager in the set carries. */
export function spanOfControl(people: OrgChartPersonFact[]): Map<string, number> {
  const spans = new Map<string, number>();
  for (const p of people) {
    if (!p.managerEmploymentRelationshipId) continue;
    spans.set(p.managerEmploymentRelationshipId, (spans.get(p.managerEmploymentRelationshipId) ?? 0) + 1);
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Status-change diff — what an "apply" actually moves, for the audit record
// ---------------------------------------------------------------------------

export interface StatusChangeTarget {
  designation?: string;
  gradeId?: string;
  costCentreId?: string;
  locationId?: string;
}

/** The subset of fields that actually change between the current state and the target. */
export function statusChangeDiff(
  current: StatusChangeTarget,
  target: StatusChangeTarget,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(current), ...Object.keys(target)]) as Set<keyof StatusChangeTarget>;
  for (const key of keys) {
    const from = current[key] ?? null;
    const to = target[key];
    if (to !== undefined && to !== from) diff[key] = { from, to };
  }
  return diff;
}
