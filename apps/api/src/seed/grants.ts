/**
 * The initial GRANT set, translated faithfully from the legacy 14x10
 * letter-matrix.
 *
 * Day-one behaviour under the new mechanism must be identical to day-minus-one
 * behaviour under the old one. The vocabulary does not change: `people:VCEA`,
 * `mous:approve`, `offerings:V` are the same strings, migrated rather than
 * redesigned.
 *
 * `restricted_interactions` and the `management_chain` scope resolver carry the
 * two role lists that used to live as slug comparisons inside the interaction
 * service. The roles holding them are unchanged; where the decision is made is.
 *
 * `project_manager`'s empty cell on `education` translates to an explicit
 * GRANT ABSENCE, not a placeholder row — the ambiguity is resolved here, at
 * translation time, rather than left to a parseCell returning an empty array.
 */

import type { Scope, Verb } from '@kaizen/shared';

export interface GrantSpec {
  resource: string;
  /** Letter-matrix cell. `-` means an explicit absence of grant. */
  cell: string;
  scopeResolver?: string;
  conditions?: Record<string, unknown>;
}

export type RoleGrants = Record<string, GrantSpec[]>;

const LETTERS: Record<string, Verb> = {
  V: 'view',
  C: 'create',
  E: 'edit',
  D: 'delete',
  A: 'assign',
  X: 'export',
  F: 'financial',
};

export function parseCell(cell: string): { verbs: Verb[]; scope: Scope } | null {
  if (!cell || cell === '-') return null;
  const [letters, scopePart] = cell.split('@');
  const verbs: Verb[] = [];
  for (const token of letters.split(',')) {
    const t = token.trim();
    if (t === 'approve' || t === 'merge') {
      verbs.push(t);
      continue;
    }
    for (const ch of t) {
      const verb = LETTERS[ch];
      if (verb) verbs.push(verb);
    }
  }
  const scope = (scopePart ?? 'all') as Scope;
  return { verbs: [...new Set(verbs)], scope };
}

/**
 * The matrix. Rows are roles; each entry is `resource: cell`.
 *
 * `founder` and `admin` hold identical grants in the source material. Where
 * they structurally diverge is under the chairman/system_admin split, which is
 * expressed below as separate rows rather than inherited.
 */
export const ROLE_GRANT_MATRIX: RoleGrants = {
  // ---- Pre-split administrative roles -------------------------------------
  founder: [
    { resource: 'people', cell: 'VCEDAXF,merge' },
    { resource: 'organizations', cell: 'VCEDAXF' },
    { resource: 'institutions', cell: 'VCEDAXF' },
    { resource: 'relationships', cell: 'VCEDAXF' },
    { resource: 'leads', cell: 'VCEDAXF' },
    { resource: 'opportunities', cell: 'VCEDAXF,approve' },
    { resource: 'mous', cell: 'VCEDAXF,approve' },
    { resource: 'contracts', cell: 'VCEDAXF,approve' },
    { resource: 'partner_agreements', cell: 'VCEDAXF,approve' },
    { resource: 'proposals', cell: 'VCEDAXF' },
    { resource: 'quotes', cell: 'VCEDAXF,approve' },
    { resource: 'offerings', cell: 'VCEDAXF' },
    { resource: 'price_book_entries', cell: 'VCEDAXF' },
    { resource: 'win_loss_reviews', cell: 'VCEDAXF' },
    { resource: 'interactions', cell: 'VCEDAXF' },
    { resource: 'restricted_interactions', cell: 'V' },
    { resource: 'activities', cell: 'VCEDAXF' },
    { resource: 'documents', cell: 'VCEAXF' },
    { resource: 'education', cell: 'VCEDAXF' },
    { resource: 'projects', cell: 'VCEDAXF' },
    { resource: 'payments', cell: 'VCEDAXF' },
    { resource: 'invoices', cell: 'VCEDAXF' },
    { resource: 'receivables', cell: 'VXF' },
    { resource: 'users', cell: 'VCEDAX' },
    { resource: 'reports', cell: 'VXF' },
    { resource: 'pipeline_definitions', cell: 'VCE' },
    { resource: 'pipeline_stages', cell: 'VCE' },
    { resource: 'pipeline_transitions', cell: 'VCED' },
    { resource: 'territories', cell: 'VCED' },
    { resource: 'routing_rules', cell: 'VCED' },
    { resource: 'health_scores', cell: 'V' },
    { resource: 'decisions', cell: 'VCE,approve' },
    { resource: 'exceptions', cell: 'VCE' },
    { resource: 'policies', cell: 'VCE' },
    { resource: 'grants', cell: 'VCE' },
    { resource: 'agents', cell: 'VCE' },
    { resource: 'jobs', cell: 'VCE' },
    { resource: 'audit', cell: 'VX' },
    { resource: 'events', cell: 'V' },
  ],

  /**
   * The split. `chairman` retains organisational and commercial authority.
   */
  chairman: [
    { resource: 'people', cell: 'VCEDAXF,merge' },
    { resource: 'organizations', cell: 'VCEDAXF' },
    { resource: 'institutions', cell: 'VCEDAXF' },
    { resource: 'relationships', cell: 'VCEDAXF' },
    { resource: 'leads', cell: 'VCEDAXF' },
    { resource: 'opportunities', cell: 'VCEDAXF,approve' },
    { resource: 'mous', cell: 'VCEDAXF,approve' },
    { resource: 'contracts', cell: 'VCEDAXF,approve' },
    { resource: 'partner_agreements', cell: 'VCEDAXF,approve' },
    { resource: 'proposals', cell: 'VCEAXF' },
    { resource: 'quotes', cell: 'VCEAXF,approve' },
    { resource: 'offerings', cell: 'VCEAXF' },
    { resource: 'price_book_entries', cell: 'VCEAXF' },
    { resource: 'win_loss_reviews', cell: 'VCEAXF' },
    { resource: 'interactions', cell: 'VCEDAXF' },
    { resource: 'restricted_interactions', cell: 'V' },
    { resource: 'activities', cell: 'VCEDAXF' },
    { resource: 'documents', cell: 'VCEAXF' },
    { resource: 'education', cell: 'VXF' },
    { resource: 'projects', cell: 'VXF' },
    { resource: 'payments', cell: 'VXF' },
    { resource: 'invoices', cell: 'VXF' },
    { resource: 'receivables', cell: 'VXF' },
    { resource: 'reports', cell: 'VXF' },
    { resource: 'pipeline_definitions', cell: 'VCE' },
    { resource: 'pipeline_stages', cell: 'VCE' },
    { resource: 'pipeline_transitions', cell: 'VCED' },
    { resource: 'territories', cell: 'VCED' },
    { resource: 'routing_rules', cell: 'VCED' },
    { resource: 'health_scores', cell: 'V' },
    { resource: 'decisions', cell: 'VCE,approve' },
    { resource: 'exceptions', cell: 'VCE' },
    { resource: 'policies', cell: 'VCE' },
    { resource: 'grants', cell: 'VCE' },
    { resource: 'agents', cell: 'VCE' },
    { resource: 'jobs', cell: 'V' },
    { resource: 'audit', cell: 'VX' },
    { resource: 'events', cell: 'V' },
    // Explicitly absent: `users` administration is system_admin's, not the
    // Chairman's.
    { resource: 'users', cell: 'V' },
  ],

  /**
   * `system_admin` gets platform-administration authority with explicitly NO
   * domain content authority. It is structurally excluded from every
   * approver_resolution tier, and its classification ceiling stops at
   * `internal` — a platform administrator whose job is keeping the servers
   * running never inherits the ability to sign a memorandum of understanding.
   */
  system_admin: [
    { resource: 'users', cell: 'VCEDAX' },
    { resource: 'grants', cell: 'VCE' },
    { resource: 'policies', cell: 'V' },
    { resource: 'agents', cell: 'VCE' },
    { resource: 'jobs', cell: 'VCE' },
    { resource: 'events', cell: 'V' },
    { resource: 'audit', cell: 'VX' },
    { resource: 'pipeline_definitions', cell: 'V' },
    { resource: 'pipeline_stages', cell: 'V' },
    { resource: 'pipeline_transitions', cell: 'V' },
    { resource: 'exceptions', cell: 'V' },
    // No grant at all on people, organizations, leads, opportunities, mous,
    // contracts. Domain content is not system administration.
  ],

  admin: [
    { resource: 'people', cell: 'VCEDAXF,merge' },
    { resource: 'organizations', cell: 'VCEDAXF' },
    { resource: 'institutions', cell: 'VCEDAXF' },
    { resource: 'relationships', cell: 'VCEDAXF' },
    { resource: 'leads', cell: 'VCEDAXF' },
    { resource: 'opportunities', cell: 'VCEDAXF,approve' },
    { resource: 'mous', cell: 'VCEDAXF,approve' },
    { resource: 'contracts', cell: 'VCEDAXF,approve' },
    { resource: 'partner_agreements', cell: 'VCEDAXF,approve' },
    { resource: 'proposals', cell: 'VCEDAXF' },
    { resource: 'quotes', cell: 'VCEDAXF,approve' },
    { resource: 'offerings', cell: 'VCEDAXF' },
    { resource: 'price_book_entries', cell: 'VCEDAXF' },
    { resource: 'win_loss_reviews', cell: 'VCEDAXF' },
    { resource: 'interactions', cell: 'VCEDAXF' },
    { resource: 'restricted_interactions', cell: 'V' },
    { resource: 'activities', cell: 'VCEDAXF' },
    { resource: 'documents', cell: 'VCEAXF' },
    { resource: 'education', cell: 'VCEDAXF' },
    { resource: 'projects', cell: 'VCEDAXF' },
    { resource: 'payments', cell: 'VCEDAXF' },
    { resource: 'invoices', cell: 'VCEDAXF' },
    { resource: 'receivables', cell: 'VXF' },
    { resource: 'users', cell: 'VCEDAX' },
    { resource: 'reports', cell: 'VXF' },
    { resource: 'pipeline_definitions', cell: 'VCE' },
    { resource: 'pipeline_stages', cell: 'VCE' },
    { resource: 'pipeline_transitions', cell: 'VCED' },
    { resource: 'territories', cell: 'VCED' },
    { resource: 'routing_rules', cell: 'VCED' },
    { resource: 'health_scores', cell: 'V' },
    { resource: 'decisions', cell: 'VCE,approve' },
    { resource: 'exceptions', cell: 'VCE' },
    { resource: 'policies', cell: 'VCE' },
    { resource: 'grants', cell: 'VCE' },
    { resource: 'agents', cell: 'VCE' },
    { resource: 'jobs', cell: 'VCE' },
    { resource: 'audit', cell: 'VX' },
    { resource: 'events', cell: 'V' },
  ],

  // ---- Commercial leadership ----------------------------------------------
  business_head: [
    { resource: 'people', cell: 'VCEA' },
    { resource: 'organizations', cell: 'VCEA' },
    { resource: 'institutions', cell: 'VCEA' },
    { resource: 'relationships', cell: 'VCEA' },
    { resource: 'leads', cell: 'VCEA' },
    { resource: 'opportunities', cell: 'VCEAF' },
    { resource: 'mous', cell: 'VCEAF,approve' },
    { resource: 'contracts', cell: 'VCEAF,approve' },
    { resource: 'partner_agreements', cell: 'VCEAF,approve' },
    { resource: 'proposals', cell: 'VCEA' },
    { resource: 'quotes', cell: 'VCEAF,approve' },
    // Interim catalog owner, pending the open sales_ops role-register decision.
    { resource: 'offerings', cell: 'VCEAF' },
    { resource: 'price_book_entries', cell: 'VCEAF' },
    { resource: 'win_loss_reviews', cell: 'VCEA' },
    { resource: 'interactions', cell: 'VCEDA', scopeResolver: 'management_chain' },
    { resource: 'activities', cell: 'VCEDA' },
    { resource: 'documents', cell: 'VCEA' },
    { resource: 'projects', cell: 'V' },
    { resource: 'receivables', cell: 'VF' },
    { resource: 'reports', cell: 'VXF' },
    { resource: 'pipeline_definitions', cell: 'VCE' },
    { resource: 'pipeline_stages', cell: 'VCE' },
    { resource: 'pipeline_transitions', cell: 'VCE' },
    { resource: 'territories', cell: 'VCED' },
    { resource: 'routing_rules', cell: 'VCED' },
    { resource: 'health_scores', cell: 'V' },
    { resource: 'decisions', cell: 'VC,approve' },
    { resource: 'exceptions', cell: 'VCE' },
    { resource: 'events', cell: 'V' },
  ],

  director: [
    { resource: 'people', cell: 'VCEA' },
    { resource: 'organizations', cell: 'VCEA' },
    { resource: 'institutions', cell: 'VCEA' },
    { resource: 'relationships', cell: 'VCEA' },
    { resource: 'leads', cell: 'VCEA' },
    { resource: 'opportunities', cell: 'VCEAF' },
    { resource: 'mous', cell: 'VCEAF,approve' },
    { resource: 'contracts', cell: 'VCEAF,approve' },
    { resource: 'partner_agreements', cell: 'VCEAF,approve' },
    { resource: 'proposals', cell: 'VCEA' },
    { resource: 'quotes', cell: 'VCEAF,approve' },
    { resource: 'offerings', cell: 'VF' },
    { resource: 'price_book_entries', cell: 'VF' },
    { resource: 'win_loss_reviews', cell: 'VCEA' },
    { resource: 'interactions', cell: 'VCEA', scopeResolver: 'management_chain' },
    { resource: 'documents', cell: 'VCEA' },
    { resource: 'receivables', cell: 'VF' },
    { resource: 'reports', cell: 'VXF' },
    { resource: 'pipeline_definitions', cell: 'V' },
    { resource: 'pipeline_stages', cell: 'V' },
    { resource: 'health_scores', cell: 'V' },
    { resource: 'decisions', cell: 'VC,approve' },
    { resource: 'exceptions', cell: 'VCE' },
    { resource: 'projects', cell: 'V' },
  ],

  finance_controller: [
    { resource: 'people', cell: 'V' },
    { resource: 'organizations', cell: 'V' },
    { resource: 'institutions', cell: 'V' },
    { resource: 'opportunities', cell: 'VF' },
    { resource: 'mous', cell: 'VF' },
    { resource: 'contracts', cell: 'VF' },
    { resource: 'quotes', cell: 'VF,approve' },
    { resource: 'offerings', cell: 'VF' },
    { resource: 'price_book_entries', cell: 'VCEAF' },
    { resource: 'invoices', cell: 'VCEAXF' },
    { resource: 'payments', cell: 'VCEAXF' },
    { resource: 'receivables', cell: 'VXF' },
    { resource: 'reports', cell: 'VXF' },
    { resource: 'interactions', cell: 'V' },
    { resource: 'documents', cell: 'V' },
    { resource: 'exceptions', cell: 'VCE' },
    { resource: 'health_scores', cell: 'V' },
    { resource: 'decisions', cell: 'VC' },
  ],

  // ---- The legacy ten -----------------------------------------------------
  sales: [
    { resource: 'people', cell: 'VCEA' },
    { resource: 'organizations', cell: 'VCEA' },
    { resource: 'institutions', cell: 'VCEA' },
    { resource: 'relationships', cell: 'VCEA' },
    { resource: 'leads', cell: 'VCEA' },
    { resource: 'opportunities', cell: 'VCEA' },
    { resource: 'mous', cell: 'VCEA' },
    { resource: 'contracts', cell: 'VCEA' },
    { resource: 'proposals', cell: 'VCEA' },
    { resource: 'quotes', cell: 'VCEA' },
    { resource: 'offerings', cell: 'V' },
    { resource: 'price_book_entries', cell: 'V' },
    // A deal owner completes their own review.
    { resource: 'win_loss_reviews', cell: 'VCEA@own' },
    { resource: 'interactions', cell: 'VCEA' },
    { resource: 'activities', cell: 'VCEA' },
    { resource: 'documents', cell: 'VCEA' },
    { resource: 'receivables', cell: 'V' },
    { resource: 'pipeline_definitions', cell: 'V' },
    { resource: 'pipeline_stages', cell: 'V' },
    { resource: 'pipeline_transitions', cell: 'V' },
    { resource: 'exceptions', cell: 'VE' },
    { resource: 'reports', cell: 'V' },
  ],

  telecaller: [
    { resource: 'people', cell: 'VCEA@own' },
    { resource: 'organizations', cell: 'V' },
    { resource: 'institutions', cell: 'V' },
    { resource: 'relationships', cell: 'VCEA@own' },
    { resource: 'leads', cell: 'VCEA@own' },
    // Explicitly no grant on opportunities.
    { resource: 'interactions', cell: 'VCEA' },
    { resource: 'activities', cell: 'VCEA' },
    { resource: 'documents', cell: 'VCEA' },
    { resource: 'offerings', cell: '-' },
    { resource: 'mous', cell: '-' },
    { resource: 'pipeline_definitions', cell: 'V' },
    { resource: 'pipeline_stages', cell: 'V' },
    { resource: 'exceptions', cell: 'VE' },
  ],

  education_counsellor: [
    { resource: 'people', cell: 'VCEA@own' },
    { resource: 'organizations', cell: 'V' },
    // The own_or_unowned narrowing, preserved exactly: a same-branch check
    // applies only in the unowned case.
    { resource: 'institutions', cell: 'VCEA@own_or_unowned' },
    { resource: 'relationships', cell: 'VCEA@own' },
    { resource: 'leads', cell: 'VCEA@own' },
    { resource: 'opportunities', cell: 'VCEA' },
    { resource: 'mous', cell: 'VCEA' },
    { resource: 'offerings', cell: 'V' },
    { resource: 'price_book_entries', cell: 'V' },
    { resource: 'interactions', cell: 'VCEA' },
    { resource: 'activities', cell: 'VCEA' },
    { resource: 'documents', cell: 'VCEA' },
    { resource: 'education', cell: 'VCEA' },
    { resource: 'pipeline_definitions', cell: 'V' },
    { resource: 'pipeline_stages', cell: 'V' },
    { resource: 'exceptions', cell: 'VE' },
  ],

  trainer: [
    { resource: 'people', cell: 'V' },
    { resource: 'organizations', cell: 'V' },
    { resource: 'institutions', cell: 'V' },
    // The six hard-coded role-slug checks become one grant with a scope
    // resolver. A second role needing the same narrowing is a POLICY_VERSION
    // change alone, with zero service-code edits.
    { resource: 'education', cell: 'VCEA', scopeResolver: 'batch_member' },
    { resource: 'interactions', cell: 'VCEA' },
    { resource: 'activities', cell: 'VCEA' },
    { resource: 'documents', cell: 'VCEA' },
    // Explicit, load-bearing narrowing: trainer holds NO grant on mous or
    // partner_agreements, and this is never widened.
    { resource: 'mous', cell: '-' },
    { resource: 'partner_agreements', cell: '-' },
    { resource: 'pipeline_definitions', cell: 'V' },
    { resource: 'exceptions', cell: 'VE' },
  ],

  project_manager: [
    { resource: 'people', cell: 'V' },
    { resource: 'organizations', cell: 'V' },
    { resource: 'institutions', cell: 'V' },
    { resource: 'relationships', cell: 'V' },
    // Post-award, a project manager's working record is PROJECT — not a
    // repurposed opportunity they could never edit anyway.
    { resource: 'opportunities', cell: 'V' },
    { resource: 'projects', cell: 'VCEA' },
    { resource: 'offerings', cell: 'V' },
    { resource: 'win_loss_reviews', cell: 'V' },
    { resource: 'interactions', cell: 'VCEA', scopeResolver: 'management_chain' },
    { resource: 'activities', cell: 'VCEA' },
    { resource: 'documents', cell: 'VCEA' },
    { resource: 'receivables', cell: 'V' },
    { resource: 'mous', cell: 'V' },
    // The legacy matrix's empty cell on education translates to an explicit
    // absence, resolved here rather than left ambiguous.
    { resource: 'education', cell: '-' },
    { resource: 'pipeline_definitions', cell: 'V' },
    { resource: 'exceptions', cell: 'VE' },
  ],

  workforce_placement: [
    { resource: 'people', cell: 'VCEA' },
    { resource: 'organizations', cell: 'VCEA' },
    { resource: 'institutions', cell: 'VCEA' },
    { resource: 'relationships', cell: 'VCEA' },
    { resource: 'leads', cell: 'VCEA' },
    { resource: 'opportunities', cell: 'VCEA' },
    { resource: 'mous', cell: 'VCEA' },
    { resource: 'partner_agreements', cell: 'VCEA' },
    { resource: 'offerings', cell: 'V' },
    { resource: 'win_loss_reviews', cell: 'VCEA@own' },
    { resource: 'interactions', cell: 'VCEA' },
    { resource: 'activities', cell: 'VCEA' },
    { resource: 'documents', cell: 'VCEA' },
    { resource: 'pipeline_definitions', cell: 'V' },
    { resource: 'pipeline_stages', cell: 'V' },
    { resource: 'exceptions', cell: 'VE' },
  ],

  marketing: [
    { resource: 'people', cell: 'V' },
    { resource: 'organizations', cell: 'VC' },
    { resource: 'institutions', cell: 'V' },
    { resource: 'interactions', cell: 'VCEA' },
    { resource: 'activities', cell: 'VCEA' },
    { resource: 'documents', cell: 'VCEA' },
    { resource: 'mous', cell: 'V' },
    { resource: 'offerings', cell: 'V' },
    { resource: 'pipeline_definitions', cell: 'V' },
    { resource: 'reports', cell: 'V' },
    { resource: 'exceptions', cell: 'V' },
  ],

  finance: [
    { resource: 'people', cell: 'V' },
    { resource: 'organizations', cell: 'V' },
    { resource: 'institutions', cell: 'V' },
    { resource: 'opportunities', cell: 'VF' },
    { resource: 'mous', cell: 'VF' },
    { resource: 'contracts', cell: 'VF' },
    { resource: 'offerings', cell: 'VF' },
    { resource: 'price_book_entries', cell: 'VCEAF' },
    { resource: 'invoices', cell: 'VCEAXF' },
    { resource: 'payments', cell: 'VCEAXF' },
    { resource: 'receivables', cell: 'VXF' },
    { resource: 'win_loss_reviews', cell: 'V' },
    // Restricted to view on the shared interaction collection, matching the
    // legacy matrix exactly.
    { resource: 'interactions', cell: 'V' },
    { resource: 'activities', cell: 'V' },
    { resource: 'documents', cell: 'V' },
    { resource: 'projects', cell: 'V' },
    { resource: 'reports', cell: 'VXF' },
    { resource: 'pipeline_definitions', cell: 'V' },
    { resource: 'exceptions', cell: 'VE' },
    { resource: 'health_scores', cell: 'V' },
  ],
};

export const ROLE_DEFINITIONS: Array<{
  slug: string;
  name: string;
  description: string;
  archetype: string;
  classificationCeiling: string;
}> = [
  { slug: 'chairman', name: 'Chairman', description: 'Organisational and commercial authority. The Command Center archetype.', archetype: 'command', classificationCeiling: 'regulated' },
  { slug: 'founder', name: 'Founder (pre-split)', description: 'The unsplit legacy role, retained until the chairman/system_admin cutover completes.', archetype: 'command', classificationCeiling: 'regulated' },
  { slug: 'system_admin', name: 'System Administrator', description: 'Platform administration authority with explicitly no domain content authority. Structurally excluded from every approval tier.', archetype: 'console', classificationCeiling: 'internal' },
  { slug: 'admin', name: 'Administrator', description: 'Full administrative access across domains.', archetype: 'console', classificationCeiling: 'regulated' },
  { slug: 'director', name: 'Director', description: 'Portfolio-level commercial authority; second approval tier.', archetype: 'command', classificationCeiling: 'confidential' },
  { slug: 'business_head', name: 'Business Head', description: 'Unit-level commercial authority; first approval tier and interim catalog/territory owner.', archetype: 'command', classificationCeiling: 'confidential' },
  { slug: 'finance_controller', name: 'Finance Controller', description: 'Money authority, including the discount-approval tier.', archetype: 'workspace', classificationCeiling: 'confidential' },
  { slug: 'sales', name: 'Sales', description: 'Enterprise and institution deal ownership.', archetype: 'workspace', classificationCeiling: 'internal' },
  { slug: 'telecaller', name: 'Telecaller', description: 'Lead qualification, scoped to own records.', archetype: 'workspace', classificationCeiling: 'internal' },
  { slug: 'education_counsellor', name: 'Education Counsellor', description: 'Admissions motion and institution relationships.', archetype: 'workspace', classificationCeiling: 'restricted' },
  { slug: 'trainer', name: 'Trainer', description: 'Delivery of cohorts, scoped to own batches via a grant resolver.', archetype: 'workspace', classificationCeiling: 'internal' },
  { slug: 'project_manager', name: 'Project Manager', description: 'Post-award delivery. Works PROJECT, not a repurposed opportunity.', archetype: 'workspace', classificationCeiling: 'internal' },
  { slug: 'workforce_placement', name: 'Workforce & Placement', description: 'Employer demand and placement channel.', archetype: 'workspace', classificationCeiling: 'internal' },
  { slug: 'marketing', name: 'Marketing', description: 'Campaign targeting and demand generation.', archetype: 'workspace', classificationCeiling: 'internal' },
  { slug: 'finance', name: 'Finance', description: 'Money ledger operations.', archetype: 'workspace', classificationCeiling: 'restricted' },
];
