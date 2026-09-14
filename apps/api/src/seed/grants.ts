/**
 * The grant matrix: four roles.
 *
 * The platform previously shipped sixteen, translated from a legacy
 * letter-matrix. Sixteen is a defensible model for a five-hundred person
 * company and an obstacle for this one — every screen had to be reasoned about
 * from sixteen angles, and nobody could answer "what can this person do"
 * without reading a spreadsheet. So there are four, and the whole model fits
 * on a page:
 *
 *   employee            Own record only. Their leave, their attendance, their
 *                       goals, their skills, their payslip, their documents.
 *                       They can see who works here and what we sell, and they
 *                       raise invoices at the counter for what they sell; they
 *                       cannot see what anybody else earns.
 *
 *   hr_ops_manager      Operations Head. The people function and day-to-day
 *                       operations: runs the employment lifecycle end to end,
 *                       prepares payroll, holds the only routine reach into
 *                       case-scoped evidence, and owns delivery, education and
 *                       the course catalogue. Proposes pay and cannot approve
 *                       it.
 *
 *   finance_head        The books end to end, and the money side of people:
 *                       approves compensation and payroll, and sees the
 *                       establishment and what it costs without running it.
 *
 *   chairman            Superadmin. Every resource, every verb, every scope,
 *                       no ceiling. Nothing is hidden or inaccessible.
 *
 * The chairman row is a deliberate reversal of what this file used to argue.
 * The old matrix withheld disciplinary evidence and payment entry from the
 * chairman on the principle that need-to-know is held rather than conferred by
 * rank. That is a good principle and it is not the one the company asked for:
 * the chairman here is the system's owner and is meant to be able to see and do
 * everything in it. The principle survives below the top — an employee cannot
 * read a colleague's file, and HR cannot sign off its own pay proposals.
 *
 * The HR/Finance split is what makes a pay rise a two-party act again.
 * `hr_ops_manager` holds `compensation:VCED` and no `approve`; `finance_head`
 * holds `approve` and does not propose. Neither can move somebody's salary
 * alone, and that is a property of the matrix rather than of anybody's
 * restraint.
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
  'audit', 'budgets', 'capabilities', 'categories', 'company_profile',
  'compensation', 'contracts', 'courses',
  'decisions', 'documents', 'education', 'employees', 'events', 'exceptions',
  'goals', 'grants', 'gst_filings', 'health_scores', 'imports', 'institutions',
  'interactions',
  'invoices', 'jobs', 'leads', 'learning', 'leave', 'ledger_accounts', 'mous',
  'offerings', 'opportunities', 'organizations', 'partner_agreements',
  'payments', 'payroll', 'people', 'performance_evidence', 'pipeline_definitions',
  'pipeline_stages', 'pipeline_transitions', 'policies', 'positions',
  'price_book_entries', 'projects', 'proposals', 'quotes', 'receivables',
  'relationships', 'reports', 'requisitions', 'restricted_interactions',
  'routing_rules', 'students', 'tasks', 'territories', 'transactions', 'users',
  'vendor_bills', 'win_loss_reviews',
  // Equity & board (phase 0 declares them; §3.4 fills in the cells; phase 1
  // ships the screens). Kept in lockstep with RESOURCES in
  // `@kaizen/shared/permissions.ts` — a test asserts the two lists agree.
  'cap_table', 'share_classes', 'holders', 'share_ledger', 'certificates',
  'valuations', 'entity_documents', 'board_meetings', 'resolutions',
  'board_documents', 'compliance', 'group', 'holdings',
] as const;

/** Everything, at every scope, with no exceptions. */
const SUPERADMIN_CELL = 'VCEDAXF,approve,merge';

const chairman: GrantSpec[] = ALL_RESOURCES.map((resource) => ({
  resource,
  cell: SUPERADMIN_CELL,
}));

/**
 * Operations Head — the people function, and the running of the place.
 *
 * Owns the employment lifecycle from requisition to exit, prepares payroll,
 * and holds the only routine reach into case-scoped evidence besides the
 * chairman. Also owns the operational surfaces that are nobody else's:
 * projects, education, tasks and documents.
 *
 * Proposes compensation and cannot approve it. That single missing verb is
 * what keeps a pay rise a two-party act, and it is the reason this role and
 * `finance_head` are separate rows rather than one operations role.
 */
const hrOpsManager: GrantSpec[] = [
  // ---- The employment lifecycle ------------------------------------------
  { resource: 'employees', cell: 'VCEDA' },
  { resource: 'positions', cell: 'VCEDA' },
  { resource: 'assignments', cell: 'VCEDA' },
  { resource: 'requisitions', cell: 'VCEDA,approve' },
  { resource: 'applications', cell: 'VCEDA' },
  { resource: 'leave', cell: 'VCEDA,approve' },
  { resource: 'attendance', cell: 'VCEDA' },
  { resource: 'capabilities', cell: 'VCEDAF,approve' },
  { resource: 'learning', cell: 'VCEDA' },
  { resource: 'goals', cell: 'VCEDA' },
  { resource: 'performance_evidence', cell: 'VCE' },

  // Proposes, never approves. `financial` is held because a proposal that
  // cannot see the current salary is not a proposal.
  { resource: 'compensation', cell: 'VCEDXF' },
  // Prepares a run and submits it for review; the money side signs it off.
  { resource: 'payroll', cell: 'VCEDXF' },

  // ---- Operations --------------------------------------------------------
  { resource: 'projects', cell: 'VCEDAXF' },
  { resource: 'education', cell: 'VCEDAXF' },
  // The catalogue is theirs: they run the training business, so the courses on
  // offer, how long they run and what they cost are theirs to maintain.
  { resource: 'courses', cell: 'VCEDAXF' },
  { resource: 'tasks', cell: 'VCEDAXF' },
  { resource: 'documents', cell: 'VCEAXF' },
  { resource: 'activities', cell: 'VCEDAXF' },
  { resource: 'interactions', cell: 'VCEDA' },
  { resource: 'people', cell: 'VCEDAX,merge' },
  { resource: 'students', cell: 'VCEDAX' },
  { resource: 'organizations', cell: 'VCEDAX' },
  { resource: 'institutions', cell: 'VCEDAX' },
  { resource: 'relationships', cell: 'VCEDAX' },

  // ---- Governance, read-mostly -------------------------------------------
  { resource: 'health_scores', cell: 'V' },
  { resource: 'exceptions', cell: 'VCE' },
  { resource: 'decisions', cell: 'VCE' },
  { resource: 'events', cell: 'V' },
  { resource: 'imports', cell: 'VCEDX' },

  // ---- Explicitly withheld ------------------------------------------------
  // The books are the Finance Head's. HR sees what people cost through
  // `compensation` and `payroll`, and nothing about the company's money
  // beyond that.
  { resource: 'transactions', cell: '-' },
  { resource: 'ledger_accounts', cell: '-' },
  { resource: 'budgets', cell: '-' },
  { resource: 'vendor_bills', cell: '-' },
  { resource: 'invoices', cell: '-' },
  { resource: 'payments', cell: '-' },
  // A return is filed under the company's registration by whoever answers for
  // the company's money. That is not this role.
  { resource: 'gst_filings', cell: '-' },
  { resource: 'company_profile', cell: 'V' },
  // And the rules themselves are the chairman's.
  { resource: 'grants', cell: '-' },
  { resource: 'policies', cell: '-' },
  { resource: 'agents', cell: '-' },
  { resource: 'users', cell: '-' },
  { resource: 'restricted_interactions', cell: '-' },

  // The register and the board are the company secretary's and the finance
  // head's, never operations'.
  { resource: 'cap_table', cell: '-' },
  { resource: 'share_classes', cell: '-' },
  { resource: 'holders', cell: '-' },
  { resource: 'share_ledger', cell: '-' },
  { resource: 'certificates', cell: '-' },
  { resource: 'valuations', cell: '-' },
  { resource: 'entity_documents', cell: '-' },
  { resource: 'board_meetings', cell: '-' },
  { resource: 'resolutions', cell: '-' },
  { resource: 'board_documents', cell: '-' },
  { resource: 'compliance', cell: '-' },
  { resource: 'group', cell: '-' },
  { resource: 'holdings', cell: '-' },
];

/**
 * Finance Head — the books, and the money side of people.
 *
 * Holds the ledger outright. Over people it holds the approvals and the
 * figures and not the operation: it signs off a compensation change and a
 * payroll run, and sees the establishment and what it costs, without hiring,
 * granting leave or opening a disciplinary case.
 *
 * Does not get to rewrite the rules it operates under. Grants, policies, agent
 * registrations and the job scheduler are the chairman's, because a role that
 * can widen its own grant has no scope at all.
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
  // Prepares and files the returns, and maintains the registration they are
  // filed under. `approve` is held because filing is the irreversible half —
  // preparing a return is arithmetic, filing it closes the period.
  { resource: 'gst_filings', cell: 'VCEDAXF,approve' },
  { resource: 'company_profile', cell: 'VEXF' },
  { resource: 'reports', cell: 'VXF' },
  { resource: 'imports', cell: 'VCEDX' },

  // ---- The money side of people ------------------------------------------
  // Approves what HR proposes. No `create` and no `edit`: a signatory who can
  // also author the thing being signed is not a second party.
  { resource: 'compensation', cell: 'VXF,approve' },
  { resource: 'payroll', cell: 'VEXF,approve' },
  // Sees the establishment and what it costs. Does not run it.
  { resource: 'employees', cell: 'VXF' },
  { resource: 'positions', cell: 'V' },
  { resource: 'assignments', cell: 'V' },
  // Leave and attendance feed payroll, so they are visible and not operable.
  { resource: 'leave', cell: 'VX' },
  { resource: 'attendance', cell: 'VX' },
  // A live disciplinary case is HR's and the chairman's. Money is not a
  // need-to-know.
  { resource: 'performance_evidence', cell: '-' },

  // ---- Commercial --------------------------------------------------------
  { resource: 'leads', cell: 'VCEDAXF' },
  { resource: 'opportunities', cell: 'VCEDAXF,approve' },
  { resource: 'organizations', cell: 'VCEDAXF' },
  { resource: 'institutions', cell: 'VCEDAXF' },
  { resource: 'students', cell: 'VCEDAXF' },
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
  { resource: 'courses', cell: 'VCEDAXF' },

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
  { resource: 'grants', cell: '-' },
  { resource: 'policies', cell: '-' },
  { resource: 'agents', cell: '-' },
  { resource: 'jobs', cell: '-' },
  { resource: 'users', cell: '-' },

  // ---- Equity & board (§3.4) ---------------------------------------------
  // The books referenced by an allotment's consideration are the finance
  // head's ground truth, so the ledger's approval and the cap table's view
  // sit here beside the transactions they touch — never `create` or `edit`
  // on the register itself, which stays the secretary's.
  { resource: 'share_ledger', cell: 'V,approve@all' },
  { resource: 'cap_table', cell: 'V@all' },
  { resource: 'valuations', cell: 'VCE@all' },
  // The finance head sets `Transaction.intercompanyTenantId` on entry and
  // reads the group's financial block the figures roll up into (plan §6
  // phase 2 item 1).
  { resource: 'group', cell: 'V@all' },
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

  // ---- Billing a customer at the counter ---------------------------------
  //
  // An employee raises invoices. This is the row that says so, and it is a
  // deliberate widening of a matrix that previously kept every employee out of
  // the money entirely.
  //
  // The reasoning: somebody has to be able to take a walk-in through a course
  // enrolment and hand them a tax invoice, and routing that through the finance
  // head means either the finance head sits at the counter or the customer
  // waits. The narrowing that makes it safe is `@own` and it is real — an
  // employee sees the invoices they raised and the payments they collected, and
  // no others. `F` is held at the same scope because an invoice you cannot see
  // the amounts on is not an invoice you can raise.
  //
  // `edit` is held so a mistake can be corrected before the document goes out;
  // the service refuses it once the invoice is issued, where the only correction
  // is a credit note. Nothing here confers `delete`: an employee cannot make an
  // invoice they raised disappear.
  { resource: 'invoices', cell: 'VCEF@own' },
  { resource: 'payments', cell: 'VCF@own' },
  // The catalogue, and the three kinds of party an invoice can be addressed to,
  // so there is something to bill and somebody to bill it to. What we sell and
  // who we sell it to are company-wide facts rather than confidences, and are
  // not withheld from the people doing the selling.
  { resource: 'courses', cell: 'V@all' },
  { resource: 'organizations', cell: 'V@all' },
  { resource: 'institutions', cell: 'V@all' },

  // Students, with create: the counter job is taking a walk-in through an
  // enrolment and handing them an invoice, and that starts by writing down who
  // they are. Correcting a learner's record afterwards is Operations' work, so
  // `edit` is not here.
  { resource: 'students', cell: 'VC@all' },

  // Deliberately absent. An employee has no reason to reach the ledger, the
  // pipeline, or anybody else's file, and every one of these would be a
  // privacy incident rather than a feature.
  { resource: 'transactions', cell: '-' },
  { resource: 'payroll', cell: '-' },
  { resource: 'performance_evidence', cell: '-' },
  { resource: 'grants', cell: '-' },
  // Raising an invoice is not filing a return, and reading the class register
  // is not raising an invoice. Both stay out.
  { resource: 'gst_filings', cell: '-' },
  { resource: 'company_profile', cell: '-' },
  { resource: 'education', cell: '-' },
  { resource: 'receivables', cell: '-' },

  // The register and the board are somebody else's employment relationship,
  // not this one's.
  { resource: 'cap_table', cell: '-' },
  { resource: 'share_classes', cell: '-' },
  { resource: 'holders', cell: '-' },
  { resource: 'share_ledger', cell: '-' },
  { resource: 'certificates', cell: '-' },
  { resource: 'valuations', cell: '-' },
  { resource: 'entity_documents', cell: '-' },
  { resource: 'board_meetings', cell: '-' },
  { resource: 'resolutions', cell: '-' },
  { resource: 'board_documents', cell: '-' },
  { resource: 'compliance', cell: '-' },
  { resource: 'group', cell: '-' },
  { resource: 'holdings', cell: '-' },
];

// ---------------------------------------------------------------------------
// The equity & board portal roles (equity-portal plan §3.4). Two `portal`
// archetype roles for outsiders — a holder is never inside the ERP shell —
// and one `workspace` role for the company secretary, who keeps the register
// alongside finance but holds no `approve` anywhere in it: the secretary
// proposes an allotment or a transfer, and `approvals.ts` decides it.
//
// Cells against `cap_table`/`holdings`/etc. are declared now, against no
// domain code yet — phase 1 ships `equity.ts` and the screens that read
// them. Declaring the resources here is what makes boot's `addMissingGrants`
// backfill existing tenants the day phase 1 lands, instead of every tenant
// needing the seed re-run by hand.
// ---------------------------------------------------------------------------

const shareholder: GrantSpec[] = [
  { resource: 'holdings', cell: 'V@own' },
  { resource: 'certificates', cell: 'V@own' },
  // A shareholder-facing document set is company-wide once granted — the
  // narrowing that matters is `entity_documents.audience`, not tenancy — so
  // this is `@all` on purpose, the same shape `courses:V@all` already takes
  // for an employee at the counter.
  { resource: 'entity_documents', cell: 'V@all' },
  { resource: 'valuations', cell: 'V@all' },
  // Resolutions they are a voter on — a shareholder ordinary/special
  // resolution — never a board one.
  { resource: 'resolutions', cell: 'V@own' },
  // A holding-level shareholder sees every entity's summary (plan §1, answer
  // 4) — the union of what their affiliations reach already includes the
  // holding tenant when they hold shares there, and the group screen there
  // reads only snapshots, never a subsidiary's own tables.
  { resource: 'group', cell: 'V@all' },
];

const director: GrantSpec[] = [
  // Everything a shareholder holds (a director is very often one too,
  // including `group:V@all` above), plus the board itself.
  ...shareholder,
  { resource: 'board_meetings', cell: 'V@all' },
  { resource: 'resolutions', cell: 'V,approve@all' },
  { resource: 'board_documents', cell: 'V@all' },
  { resource: 'cap_table', cell: 'V@all' },
];

const companySecretary: GrantSpec[] = [
  { resource: 'cap_table', cell: 'VCEX@all' },
  { resource: 'share_classes', cell: 'VCE@all' },
  { resource: 'holders', cell: 'VCE@all' },
  // The ledger is append-only: `create` proposes a transaction, never `edit`.
  { resource: 'share_ledger', cell: 'VC@all' },
  { resource: 'certificates', cell: 'VC@all' },
  { resource: 'board_meetings', cell: 'VCE@all' },
  { resource: 'resolutions', cell: 'VCE@all' },
  { resource: 'compliance', cell: 'VCE@all' },
  { resource: 'entity_documents', cell: 'VCE@all' },
  { resource: 'board_documents', cell: 'VCE@all' },
  { resource: 'group', cell: 'V@all' },
  // No `approve` anywhere — the whole point of the role (§3.4).
];

export const ROLE_GRANT_MATRIX: RoleGrants = {
  chairman,
  finance_head: financeHead,
  hr_ops_manager: hrOpsManager,
  employee,
  shareholder,
  director,
  company_secretary: companySecretary,
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
      'The books end to end, and the money side of people: approves compensation and payroll and sees what the establishment costs, without running it. Cannot alter the permission model, governance policy, or agent registrations.',
    archetype: 'workspace',
    classificationCeiling: 'regulated',
  },
  {
    slug: 'hr_ops_manager',
    name: 'Operations Head',
    description:
      'The people function and the running of the place: the employment lifecycle end to end, payroll preparation, disciplinary records, projects, education and tasks. Proposes pay and cannot approve it.',
    archetype: 'workspace',
    classificationCeiling: 'regulated',
  },
  {
    slug: 'employee',
    name: 'Employee',
    description:
      'Self-service. Own leave, attendance, goals, skills, payslip and documents, plus the staff and skills directories. Sees no colleague’s file and no company money.',
    archetype: 'workspace',
    classificationCeiling: 'regulated',
  },
  {
    slug: 'shareholder',
    name: 'Shareholder',
    description:
      'A holder of this entity, reached through the portal and nowhere else. Sees their own holdings and certificates, the entity documents and valuations shared with holders, and the resolutions they vote on.',
    archetype: 'portal',
    classificationCeiling: 'confidential',
  },
  {
    slug: 'director',
    name: 'Director',
    description:
      'A board member of this entity. Everything a shareholder sees, plus the board calendar, resolutions and board documents, and a read of the cap table and the group. Votes; does not keep the register.',
    archetype: 'portal',
    classificationCeiling: 'confidential',
  },
  {
    slug: 'company_secretary',
    name: 'Company Secretary',
    description:
      'Keeps the register and the board minutes: the cap table, share classes, holders, certificates, meetings, resolutions and compliance. No approve anywhere — proposes an allotment or a transfer; the approval gate decides it.',
    archetype: 'workspace',
    classificationCeiling: 'regulated',
  },
];
