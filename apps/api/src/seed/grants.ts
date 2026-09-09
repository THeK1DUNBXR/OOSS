/**
 * The grant matrix: three roles.
 *
 * The platform previously shipped sixteen roles translated from a legacy
 * letter-matrix. Sixteen roles is a defensible model for a five-hundred person
 * company and an obstacle for this one — every screen had to be reasoned about
 * from sixteen angles, and nobody could answer "what can this person do"
 * without reading a spreadsheet. So there are three, and the whole model fits
 * on a page:
 *
 *   employee      Own record only. Their leave, their attendance, their goals,
 *                 their skills, their payslip, their documents. They can see
 *                 who works here; they cannot see what anybody else earns.
 *
 *   finance_head  The company's operating authority: the books end to end, and
 *                 the people function that pays into them. Payroll is a finance
 *                 act as much as an HR one, and with three roles there is
 *                 nobody else to run it. Cannot change the permission model
 *                 itself, register agents, or edit governance policy.
 *
 *   chairman      Superadmin. Every resource, every verb, every scope, no
 *                 ceiling. Nothing is hidden or inaccessible.
 *
 * The chairman row is a deliberate reversal of what this file used to argue.
 * The old matrix withheld disciplinary evidence and payment entry from the
 * chairman on the principle that need-to-know is held rather than conferred by
 * rank. That is a good principle and it is not the one the company asked for:
 * the chairman here is the system's owner and is meant to be able to see and do
 * everything in it. The principle survives one rung down — an employee still
 * cannot read a colleague's file — but it no longer binds the top.
 *
 * ## Cells
 *
 * A cell is letters plus an optional `@scope`: `VCEDAXF`, `V@all`, `CE@own`.
 * A resource may appear more than once in a role when view and mutation differ
 * in reach — `leads: V@all` with `leads: CE@own` is "see every lead, edit your
 * own", which is the shape a sales floor actually wants. Each distinct scope
 * becomes its own GRANT row, and the evaluator picks the widest row that
 * carries the verb being asked about.
 *
 * `-` is an explicit absence: it documents that the omission was decided
 * rather than forgotten, and writes no row.
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
 * Every resource the API enforces against. Kept here as one list because the
 * chairman's row is generated from it: a superadmin who is missing a resource
 * because somebody added one and forgot the matrix is not a superadmin, and
 * `pnpm test` asserts this list matches what the code actually asks for.
 */
export const ALL_RESOURCES = [
  'activities', 'agents', 'applications', 'assets', 'assignments', 'attendance',
  'audit', 'budgets', 'capabilities', 'categories', 'compensation', 'contracts',
  'decisions', 'documents', 'education', 'employees', 'events', 'exceptions',
  'goals', 'grants', 'health_scores', 'imports', 'institutions', 'interactions',
  'invoices', 'jobs', 'leads', 'learning', 'leave', 'ledger_accounts', 'mous',
  'offerings', 'opportunities', 'organizations', 'partner_agreements',
  'payments', 'payroll', 'people', 'performance_evidence', 'pipeline_definitions',
  'pipeline_stages', 'pipeline_transitions', 'policies', 'positions',
  'price_book_entries', 'projects', 'proposals', 'quotes', 'receivables',
  'relationships', 'reports', 'requisitions', 'restricted_interactions',
  'routing_rules', 'tasks', 'territories', 'transactions', 'users',
  'vendor_bills', 'win_loss_reviews',
] as const;

/** Everything, at every scope, with no exceptions. */
const SUPERADMIN_CELL = 'VCEDAXF,approve,merge';

const chairman: GrantSpec[] = ALL_RESOURCES.map((resource) => ({
  resource,
  cell: SUPERADMIN_CELL,
}));

/**
 * Finance Head — the operating authority.
 *
 * Holds the books outright and the people function that feeds them. The line
 * that is drawn is not seniority but kind: this role runs the company's
 * operations and does not get to rewrite the rules it operates under. Grants,
 * policies, agent registrations and the job scheduler are the chairman's,
 * because a role that can widen its own grant has no scope at all.
 */
const financeHead: GrantSpec[] = [
  // ---- Money -------------------------------------------------------------
  { resource: 'transactions', cell: 'VCEDAXF' },
  { resource: 'ledger_accounts', cell: 'VCEDAXF' },
  { resource: 'categories', cell: 'VCEDAXF' },
  { resource: 'budgets', cell: 'VCEDAXF' },
  { resource: 'assets', cell: 'VCEDAXF' },
  { resource: 'vendor_bills', cell: 'VCEDAXF,approve' },
  { resource: 'invoices', cell: 'VCEDAXF' },
  { resource: 'payments', cell: 'VCEDAXF' },
  { resource: 'receivables', cell: 'VCEDAXF' },
  { resource: 'reports', cell: 'VXF' },
  { resource: 'imports', cell: 'VCEDX' },

  // ---- People ------------------------------------------------------------
  { resource: 'employees', cell: 'VCEDAXF' },
  { resource: 'positions', cell: 'VCEDA' },
  { resource: 'assignments', cell: 'VCEDA' },
  // Proposes and approves. Under three roles there is no independent second
  // party inside the role, so a compensation change that needs one escalates
  // to the chairman through the authority ceiling rather than the grant.
  { resource: 'compensation', cell: 'VCEDAXF,approve' },
  { resource: 'payroll', cell: 'VCEDAXF,approve' },
  { resource: 'leave', cell: 'VCEDA,approve' },
  { resource: 'attendance', cell: 'VCEDA' },
  { resource: 'requisitions', cell: 'VCEDA,approve' },
  { resource: 'applications', cell: 'VCEDA' },
  // The financial verb is what reveals the confidence score behind the trust
  // badge. The people function needs the number; a colleague sees the tier.
  { resource: 'capabilities', cell: 'VCEDAF,approve' },
  { resource: 'learning', cell: 'VCEDA' },
  { resource: 'goals', cell: 'VCEDA' },
  // The people function is the only routine reach into case-scoped evidence
  // besides the chairman. Somebody has to be able to record and read a
  // disciplinary note, and with three roles this is who.
  { resource: 'performance_evidence', cell: 'VCE' },

  // ---- Commercial --------------------------------------------------------
  { resource: 'leads', cell: 'VCEDAXF' },
  { resource: 'opportunities', cell: 'VCEDAXF,approve' },
  { resource: 'organizations', cell: 'VCEDAXF' },
  { resource: 'institutions', cell: 'VCEDAXF' },
  { resource: 'people', cell: 'VCEDAXF,merge' },
  { resource: 'relationships', cell: 'VCEDAXF' },
  { resource: 'interactions', cell: 'VCEDAXF' },
  { resource: 'restricted_interactions', cell: '-' },
  { resource: 'activities', cell: 'VCEDAXF' },
  { resource: 'tasks', cell: 'VCEDAXF' },
  { resource: 'documents', cell: 'VCEAXF' },
  { resource: 'offerings', cell: 'VCEDAXF' },
  { resource: 'price_book_entries', cell: 'VCEDAXF' },
  { resource: 'quotes', cell: 'VCEDAXF,approve' },
  { resource: 'proposals', cell: 'VCEDAXF' },
  { resource: 'mous', cell: 'VCEDAXF,approve' },
  { resource: 'contracts', cell: 'VCEDAXF,approve' },
  { resource: 'partner_agreements', cell: 'VCEDAXF,approve' },
  { resource: 'win_loss_reviews', cell: 'VCEDAXF' },
  { resource: 'projects', cell: 'VCEDAXF' },
  { resource: 'education', cell: 'VCEDAXF' },

  // ---- Governance, read-mostly -------------------------------------------
  { resource: 'health_scores', cell: 'V' },
  { resource: 'exceptions', cell: 'VCE' },
  { resource: 'decisions', cell: 'VCE,approve' },
  { resource: 'events', cell: 'V' },
  { resource: 'audit', cell: 'VX' },
  { resource: 'territories', cell: 'VCED' },
  { resource: 'routing_rules', cell: 'VCED' },
  { resource: 'pipeline_definitions', cell: 'V' },
  { resource: 'pipeline_stages', cell: 'V' },
  { resource: 'pipeline_transitions', cell: 'V' },

  // ---- Explicitly withheld ------------------------------------------------
  // A role that can edit the grant matrix has no scope. These are the
  // chairman's, and their absence is the reason this role is bounded at all.
  { resource: 'grants', cell: '-' },
  { resource: 'policies', cell: '-' },
  { resource: 'agents', cell: '-' },
  { resource: 'jobs', cell: '-' },
  { resource: 'users', cell: '-' },
];

/**
 * Employee — self-service.
 *
 * Everything here is `@own` and the scope is real: `view` narrows exactly like
 * `edit` does, so an employee querying the leave list gets their own ledger
 * rather than the company's. Where an employee legitimately needs to see the
 * whole set — the staff directory, the catalogue of what we sell — the cell
 * says `@all` and says so on purpose.
 */
const employee: GrantSpec[] = [
  // Their own record and its moving parts.
  { resource: 'leave', cell: 'VCE@own' },
  { resource: 'attendance', cell: 'VC@own' },
  { resource: 'goals', cell: 'VCE@own' },
  // The skills directory is company-wide on purpose — "who here knows Kubernetes"
  // is a question a colleague should be able to answer. The confidence score
  // behind the badge is a separate `financial` verb and is not granted, so a
  // peer sees the tier and never the number.
  { resource: 'capabilities', cell: 'V@all' },
  { resource: 'capabilities', cell: 'C@own' },
  { resource: 'learning', cell: 'VE@own' },
  { resource: 'compensation', cell: 'VF@own' },
  { resource: 'employees', cell: 'VE@own' },
  { resource: 'documents', cell: 'VC@own' },
  { resource: 'tasks', cell: 'VCE@own' },
  { resource: 'activities', cell: 'VCE@own' },

  // The staff directory is a company-wide fact, and a company where you cannot
  // find out who your colleagues are is not a nicer place to work.
  { resource: 'people', cell: 'V@all' },
  { resource: 'offerings', cell: 'V@all' },

  // Deliberately absent. An employee has no reason to reach the ledger, the
  // pipeline, or anybody else's file, and every one of these would be a
  // privacy incident rather than a feature.
  { resource: 'transactions', cell: '-' },
  { resource: 'payroll', cell: '-' },
  { resource: 'performance_evidence', cell: '-' },
  { resource: 'grants', cell: '-' },
];

export const ROLE_GRANT_MATRIX: RoleGrants = {
  chairman,
  finance_head: financeHead,
  employee,
};

export const ROLE_DEFINITIONS: Array<{
  slug: string;
  name: string;
  description: string;
  archetype: string;
  classificationCeiling: string;
}> = [
  {
    slug: 'chairman',
    name: 'Chairman',
    description:
      'Owner of the system. Every resource, every verb, every scope — nothing is hidden or inaccessible.',
    archetype: 'command',
    classificationCeiling: 'regulated',
  },
  {
    slug: 'finance_head',
    name: 'Finance Head',
    description:
      'The company’s operating authority: the books end to end, and the people function that pays into them. Cannot alter the permission model, governance policy, or agent registrations.',
    archetype: 'workspace',
    classificationCeiling: 'regulated',
  },
  {
    slug: 'employee',
    name: 'Employee',
    description:
      'Self-service. Own leave, attendance, goals, skills, payslip and documents, plus the staff directory. Sees no colleague’s file and no company money.',
    archetype: 'workspace',
    classificationCeiling: 'internal',
  },
];
