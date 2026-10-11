/**
 * The founder exception view (OP:120; SPINE-CONTRACT 1.6).
 *
 * A read model with no table of its own. Each source reports one of three
 * states, and the three are kept apart on purpose (CLAUDE.md rule 7, "not
 * measured != zero != withheld"): a table that is missing from the database is
 * not measured, a table that exists and holds nothing is zero, and a source the
 * caller may not read is withheld and carries no count at all.
 */

export const FOUNDER_SOURCE_KINDS = ['exception', 'commitment', 'decision', 'approval_step', 'case'] as const;
export type FounderSourceKind = (typeof FOUNDER_SOURCE_KINDS)[number];

export const FOUNDER_SOURCE_LABELS: Record<FounderSourceKind, string> = {
  exception: 'Open exceptions',
  commitment: 'Missed or overdue commitments',
  decision: 'Decisions awaiting a disposition',
  approval_step: 'Approvals pending',
  case: 'Overdue cases',
};

/** Which instant put the row on the view: the one a person would quote. */
export type FounderTimestampKind = 'raised_at' | 'due_at' | 'requested_at' | 'response_due_at';

export interface FounderRow {
  sourceKind: FounderSourceKind;
  sourceId: string;
  recordCode: string | null;
  title: string;
  state: string;
  ownerPartyId: string | null;
  /** The owner's name in this tenant, or null when nobody owns the row. */
  ownerName: string | null;
  /** ISO instant, UTC. */
  timestamp: string;
  timestampKind: FounderTimestampKind;
  /** Only the sources that escalate carry a rung; null means the source has none. */
  escalationRung: number | null;
  /** A route the web app serves. */
  drillTo: string;
}

export type FounderSourceStatus =
  | { status: 'measured'; count: number; shown: number }
  | { status: 'not_measured'; reason: string }
  | { status: 'withheld'; reason: string };

export interface FounderViewResponse {
  asOf: string;
  scope: 'tenant';
  sources: Record<FounderSourceKind, FounderSourceStatus>;
  rows: FounderRow[];
}
