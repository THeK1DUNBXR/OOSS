/**
 * Bootstrap: everything a brand-new company needs before it holds any data of
 * its own, and nothing else.
 *
 * This file used to seed a demonstration — fifteen invented staff, a fictional
 * pipeline of deals, seven months of somebody else's ledger — so that every
 * screen had something on it. That is a good way to show a platform and a bad
 * way to ship one: the first thing a real company had to do was work out which
 * rows were theirs and delete the rest, and a figure on the founder's dashboard
 * was never trustworthy until they had.
 *
 * So the demonstration moved to `src/tests/fixtures/`, where it is a set of
 * test subjects and cannot reach production, and what remains here is
 * structure:
 *
 *   - the tenant itself
 *   - thresholds, so every tunable constant is a row from the first minute
 *   - sensitivity registrations, so an unregistered entity type fails closed
 *   - the governance policy and the three-role grant matrix
 *   - pipeline definitions, the navigation registry, agent registrations
 *   - statutory leave types
 *   - four accounts, one per role, from which everybody else is invited
 *
 * None of that is data about the company. It is the shape of the box the
 * company's data goes in, and a tenant without it cannot function.
 *
 * Idempotent by construction: every block checks before it writes, so this runs
 * on every deploy rather than once, and re-running it never alters a GRANT.
 */

import { randomUUID } from 'node:crypto';
import { seedCompliance } from './compliance/index.js';
import { AI_TOUCHPOINTS, EVENTS } from '@kaizen/shared';
import { prisma, unscopedPrisma } from '../platform/db.js';
import { asSystem } from '../platform/context.js';
import { hashPassword } from '../lib/auth.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ROLE_DEFINITIONS, ROLE_GRANT_MATRIX, parseCell } from './grants.js';
import { PIPELINE_SEEDS, RETIRED_POST_AWARD_STAGES, transitionsFor } from './pipelines.js';
import { registerSubscribers } from '../events/handlers.js';
import { runBackfills } from './backfill.js';
import { BUILD } from '../platform/build.js';
import { reconcileTenantKinds } from '../platform/tenantKind.js';

export const TENANT_SLUG = process.env.TENANT_SLUG ?? 'kaizen';
const TENANT_NAME = process.env.TENANT_NAME ?? 'Kaizen Infinities';

/**
 * `TENANT_KIND`/`PARENT_TENANT_SLUG` name the group relationship at bootstrap
 * time, but they are a starting hint rather than the truth: `reconcileTenantKinds`
 * (run at the end of every bootstrap, and at API boot) recomputes `kind` from
 * the actual parent/child rows every time, so a stale env var left on a
 * server cannot leave a tenant's `kind` wrong the way a hand-set flag could.
 */
const PARENT_TENANT_SLUG = process.env.PARENT_TENANT_SLUG || undefined;

/**
 * Read for the same reason `PARENT_TENANT_SLUG` is: as an operator's stated
 * intent at first creation. It is never the value that ends up governing
 * anything — `reconcileTenantKinds`, run at the end of this same bootstrap,
 * recomputes `kind` from the parent/child rows regardless of what this said,
 * so a wrong guess here corrects itself on the next run rather than sticking.
 */
const TENANT_KIND = process.env.TENANT_KIND || undefined;

// ---------------------------------------------------------------------------
// Thresholds — every unvalidated constant ships as a tunable row from day one
// ---------------------------------------------------------------------------

async function seedThresholds() {
  const tenantId = (await currentTenant()).id;
  const rows = [
    { thresholdKey: 'command_center.materiality_floor', value: 100_000, unit: 'currency', description: 'Changes smaller than this are not worth reporting.' },
    { thresholdKey: 'command_center.narrative_window_hours', value: 72, unit: 'hours', description: 'After being away this long, you get a summary of what happened instead of a list.' },
    { thresholdKey: 'command_center.absence_reset_days', value: 14, unit: 'days', description: 'After being away this long, "what changed" starts fresh.' },
    { thresholdKey: 'win_loss_review.value_threshold', value: 500_000, unit: 'currency', description: 'A deal worth more than this always needs a win/loss review.' },
    { thresholdKey: 'merge_candidate.stale_days', value: 14, unit: 'days', description: 'A possible duplicate left this long is raised as a problem.' },
    { thresholdKey: 'lead.untouched_days', value: 3, unit: 'days', description: 'A lead with no contact for this long is raised as a problem.' },
    { thresholdKey: 'proposal.stalled_business_days', value: 5, unit: 'days', description: 'A proposal with no movement for this many working days is chased.' },
    { thresholdKey: 'h_com.quarter_target', value: 20_000_000, unit: 'currency', description: 'The sales target the pipeline is scored against.' },
    { thresholdKey: 'people.k_anonymity_floor', value: 5, unit: 'count', description: 'A people figure covering fewer than this many is withheld, so nobody is identifiable.' },
    { thresholdKey: 'routing.tie_break_margin_points', value: 5, unit: 'points', description: 'Scores this close count as a tie, and are shared out in turn.' },
    { thresholdKey: 'approval.escalation_grace_business_days', value: 3, unit: 'days', description: 'An approval left this long moves up to the next person.' },
    { thresholdKey: 'document.record_of_record_ttl_seconds', value: 60, unit: 'seconds', description: 'How long a link to a sensitive document stays valid.' },
  ];

  for (const r of rows) {
    await prisma.threshold.upsert({
      where: { tenantId_thresholdKey: { tenantId, thresholdKey: r.thresholdKey } },
      create: { tenantId, ...r },
      update: { description: r.description },
    });
  }
  console.log(`  ${rows.length} thresholds`);
}

/**
 * The navigation registry: every surface a person can reach, and the words they
 * might look for it under.
 *
 * Module-level and exported so the suite can hold the seeded rows to it. The
 * synonyms in particular are load-bearing — the command palette routes a typed
 * phrase through them — and they went stale once already, which is how
 * "customers" went on opening Organisations after the word had moved to the
 * learners screen.
 */
export interface NavNodeSpec {
  nodeKey: string;
  label: string;
  icon: string;
  path: string;
  group: string;
  position: number;
  requiredPermission?: string;
  archetypes?: string[];
  synonyms?: string[];
}

export const NAV_REGISTRY: NavNodeSpec[] = [
  // ---- Start here ------------------------------------------------------
  { nodeKey: 'business', label: 'The Business', icon: 'trending', path: '/business', group: 'main', position: 0, requiredPermission: 'transactions:V', synonyms: ['dashboard', 'how are we doing', 'profit', 'runway', 'cash', 'by division', 'p&l'] },
  { nodeKey: 'command', label: 'Needs Attention', icon: 'gauge', path: '/command', group: 'main', position: 1, requiredPermission: 'health_scores:V', synonyms: ['pulse', 'today', 'command centre', 'state of kaizen', 'problems'] },
  { nodeKey: 'workspace', label: 'My Work', icon: 'home', path: '/workspace', group: 'main', position: 2, archetypes: ['command', 'workspace', 'console'], synonyms: ['my day', 'my queue', 'home', 'workspace'] },
  { nodeKey: 'start', label: 'Getting Started', icon: 'book', path: '/start', group: 'main', position: 3, archetypes: ['command', 'workspace', 'console'], synonyms: ['setup', 'help', 'tutorial', 'how do i', 'guide', 'onboarding'] },

  // ---- Money -----------------------------------------------------------
  { nodeKey: 'fin_ledger', label: 'Ledger', icon: 'coins', path: '/finance/ledger', group: 'money', position: 10, requiredPermission: 'transactions:V', synonyms: ['transactions', 'cash book', 'spend', 'expenses', 'bank'] },
  { nodeKey: 'fin_invoices', label: 'Invoices', icon: 'receipt', path: '/finance/invoices', group: 'money', position: 11, requiredPermission: 'invoices:V', synonyms: ['bill a customer', 'raise an invoice', 'sales invoice'] },
  { nodeKey: 'fin_new_invoice', label: 'New Invoice', icon: 'receipt', path: '/finance/invoices/new', group: 'money', position: 12, requiredPermission: 'invoices:C', synonyms: ['raise an invoice', 'course invoice', 'bill a student', 'counter sale', 'enrol and bill'] },
  { nodeKey: 'fin_invoice_history', label: 'Invoice History', icon: 'receipt', path: '/finance/invoices/history', group: 'money', position: 13, requiredPermission: 'invoices:V', synonyms: ['course invoices', 'reprint an invoice', 'search invoices'] },
  { nodeKey: 'fin_receipts', label: 'Receipts', icon: 'receipt', path: '/finance/receipts', group: 'money', position: 14, requiredPermission: 'payments:V', synonyms: ['part payment', 'instalment', 'acknowledgement', 'money received'] },
  { nodeKey: 'fin_final_invoices', label: 'Final Invoices', icon: 'file', path: '/finance/final-invoices', group: 'money', position: 15, requiredPermission: 'invoices:V', synonyms: ['statement', 'settlement', 'closing invoice', 'instalments'] },
  { nodeKey: 'fin_payments', label: 'Payments In', icon: 'wallet', path: '/finance/payments', group: 'money', position: 16, requiredPermission: 'payments:V', synonyms: ['money received', 'collections', 'bank credits'] },
  { nodeKey: 'fin_payables', label: 'Bills To Pay', icon: 'receipt', path: '/finance/payables', group: 'money', position: 17, requiredPermission: 'vendor_bills:V', synonyms: ['payables', 'supplier bills', 'vendors', 'creditors', 'what we owe'] },
  { nodeKey: 'fin_receivables', label: 'Owed To Us', icon: 'coins', path: '/finance/receivables', group: 'money', position: 18, requiredPermission: 'receivables:V', synonyms: ['receivables', 'debtors', 'outstanding'] },
  { nodeKey: 'fin_gst', label: 'GST Returns', icon: 'scale', path: '/finance/gst', group: 'money', position: 19, requiredPermission: 'gst_filings:V', synonyms: ['gstr1', 'gstr-1', 'gstr3b', 'gstr-3b', 'filing', 'return', 'tax', 'itc', 'input credit'] },
  { nodeKey: 'fin_budget', label: 'Budget', icon: 'calculator', path: '/finance/budget', group: 'money', position: 20, requiredPermission: 'budgets:V', synonyms: ['plan', 'variance', 'overspend'] },
  { nodeKey: 'fin_assets', label: 'Assets & Loans', icon: 'package', path: '/finance/assets', group: 'money', position: 21, requiredPermission: 'assets:V', synonyms: ['depreciation', 'borrowing', 'emi', 'fixed assets'] },

  // ---- People ----------------------------------------------------------
  { nodeKey: 'hr_people', label: 'Employees', icon: 'users', path: '/people/employees', group: 'people', position: 20, requiredPermission: 'employees:V', synonyms: ['staff', 'team', 'headcount', 'who works here', 'directory'] },
  { nodeKey: 'hr_leave', label: 'Leave', icon: 'clock', path: '/people/leave', group: 'people', position: 21, requiredPermission: 'leave:V', synonyms: ['holiday', 'time off', 'absence', 'casual leave'] },
  { nodeKey: 'hr_attendance', label: 'Attendance', icon: 'clipboard', path: '/people/attendance', group: 'people', position: 22, requiredPermission: 'attendance:V', synonyms: ['timesheet', 'punch', 'hours', 'present'] },
  { nodeKey: 'hr_payroll', label: 'Payroll', icon: 'wallet', path: '/people/payroll', group: 'people', position: 23, requiredPermission: 'payroll:V', synonyms: ['salary', 'pay run', 'wages', 'payslip'] },
  { nodeKey: 'hr_hiring', label: 'Hiring', icon: 'inbox', path: '/people/hiring', group: 'people', position: 24, requiredPermission: 'requisitions:V', synonyms: ['recruitment', 'vacancies', 'candidates', 'applications'] },
  { nodeKey: 'hr_capabilities', label: 'Skills', icon: 'badge', path: '/people/skills', group: 'people', position: 25, requiredPermission: 'capabilities:V', synonyms: ['capability', 'who can do', 'expertise'] },
  // An employee's own grants — `option_grants:V@own` — separate from the
  // register's own `eq_esop` node, the same way a payslip is separate from
  // the payroll screen it is drawn from.
  { nodeKey: 'my_options', label: 'My Options', icon: 'coins', path: '/me/options', group: 'people', position: 26, requiredPermission: 'option_grants:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['esop', 'stock options', 'vesting', 'my grants'] },

  // ---- Customers -------------------------------------------------------
  { nodeKey: 'crm_leads', label: 'Leads', icon: 'inbox', path: '/crm/leads', group: 'customers', position: 30, requiredPermission: 'leads:V', synonyms: ['enquiries', 'prospects'] },
  { nodeKey: 'crm_pipeline', label: 'Pipeline', icon: 'columns', path: '/crm/pipeline', group: 'customers', position: 31, requiredPermission: 'opportunities:V', synonyms: ['kanban', 'board', 'deals'] },
  { nodeKey: 'crm_opportunities', label: 'Deals', icon: 'target', path: '/crm/opportunities', group: 'customers', position: 32, requiredPermission: 'opportunities:V', synonyms: ['opportunities'] },
  // The three parties, each under the word the company uses for it. A customer
  // here is a learner who buys a course — the company's own phrase, from
  // "Customer (Student)" — and the two bodies are named for what they are.
  // Each synonym list belongs to exactly one of them: sharing "colleges"
  // between two entries is how a search for it lands on the wrong screen.
  { nodeKey: 'crm_students', label: 'Customers', icon: 'users', path: '/crm/students', group: 'customers', position: 33, requiredPermission: 'students:V', synonyms: ['students', 'learners', 'trainees', 'candidates', 'customer', 'admissions'] },
  { nodeKey: 'crm_institutions', label: 'Institutions', icon: 'building', path: '/crm/institutions', group: 'customers', position: 34, requiredPermission: 'institutions:V', synonyms: ['colleges', 'schools', 'polytechnics', 'universities', 'campus', 'mou'] },
  { nodeKey: 'crm_accounts', label: 'Organisations', icon: 'building', path: '/crm/organizations', group: 'customers', position: 35, requiredPermission: 'organizations:V', synonyms: ['accounts', 'organizations', 'companies', 'businesses', 'trusts', 'foundations', 'clients', 'employers', 'sponsors', 'corporate training'] },
  { nodeKey: 'crm_people', label: 'Contacts', icon: 'users', path: '/crm/people', group: 'customers', position: 36, requiredPermission: 'people:V', synonyms: ['persons', 'people'] },
  { nodeKey: 'crm_interactions', label: 'Calls & Meetings', icon: 'message', path: '/crm/interactions', group: 'customers', position: 37, requiredPermission: 'interactions:V', synonyms: ['activity', 'timeline', 'calls'] },
  { nodeKey: 'crm_forecast', label: 'Forecast', icon: 'trending', path: '/crm/forecast', group: 'customers', position: 38, requiredPermission: 'opportunities:V', synonyms: ['commit', 'coverage'] },

  // ---- Selling and delivering -------------------------------------------
  { nodeKey: 'com_offerings', label: 'What We Sell', icon: 'package', path: '/commercial/offerings', group: 'delivery', position: 40, requiredPermission: 'offerings:V', synonyms: ['products', 'price book', 'catalog', 'services'] },
  { nodeKey: 'com_quotes', label: 'Quotes', icon: 'calculator', path: '/commercial/quotes', group: 'delivery', position: 41, requiredPermission: 'quotes:V', synonyms: ['pricing', 'discount'] },
  { nodeKey: 'com_proposals', label: 'Proposals', icon: 'file', path: '/commercial/proposals', group: 'delivery', position: 42, requiredPermission: 'proposals:V' },
  { nodeKey: 'com_agreements', label: 'Agreements', icon: 'scroll', path: '/commercial/agreements', group: 'delivery', position: 43, requiredPermission: 'mous:V', synonyms: ['mou', 'contracts', 'partner agreements'] },
  { nodeKey: 'com_approvals', label: 'Approvals', icon: 'shield', path: '/commercial/approvals', group: 'delivery', position: 44, requiredPermission: 'mous:V', synonyms: ['sign off', 'waiting on me'] },
  { nodeKey: 'prj_projects', label: 'Projects', icon: 'kanban', path: '/delivery/projects', group: 'delivery', position: 45, requiredPermission: 'projects:V', synonyms: ['delivery', 'engagements'] },
  { nodeKey: 'edu_courses', label: 'Courses', icon: 'book', path: '/education/courses', group: 'delivery', position: 46, requiredPermission: 'courses:V', synonyms: ['catalogue', 'course list', 'syllabus', 'fees', 'price list', 'what we teach'] },
  { nodeKey: 'edu_cohorts', label: 'Training Batches', icon: 'graduation', path: '/education/cohorts', group: 'delivery', position: 47, requiredPermission: 'education:V', synonyms: ['batches', 'classes'] },
  // Not "Students": that is the person, and it lives under Customers. This is
  // their place on a course — the class register, and the day-by-day record
  // hanging off it. Two screens both called Students is how somebody looking
  // for a learner's file ends up in the attendance list.
  { nodeKey: 'edu_enrollments', label: 'Enrolments', icon: 'badge', path: '/education/enrollments', group: 'delivery', position: 48, requiredPermission: 'education:V', synonyms: ['enrollments', 'class register', 'who is on a course', 'attendance', 'progress', 'timeline'] },
  { nodeKey: 'edu_queries', label: 'Student Queries', icon: 'message', path: '/education/queries', group: 'delivery', position: 49, requiredPermission: 'education:V', synonyms: ['complaints', 'issues', 'feedback', 'questions', 'grievance'] },
  { nodeKey: 'com_winloss', label: 'Win / Loss', icon: 'clipboard', path: '/commercial/win-loss', group: 'delivery', position: 50, requiredPermission: 'win_loss_reviews:V', synonyms: ['post mortem', 'lessons'] },

  // ---- Set up ----------------------------------------------------------
  // ---- Compliance (docs/plan/compliance.md) --------------------------------
  { nodeKey: 'cmp_calendar', label: 'Compliance Calendar', icon: 'clock', path: '/compliance/calendar', group: 'compliance', position: 40, requiredPermission: 'compliance_obligations:V', synonyms: ['due dates', 'filings', 'deadlines', 'obligations', 'gstr due', 'tds due', 'pf due'] },
  { nodeKey: 'cmp_gst', label: 'GST Compliance', icon: 'scale', path: '/compliance/gst', group: 'compliance', position: 41, requiredPermission: 'gst_filings:V', synonyms: ['reverse charge', 'e-invoice', 'irn', 'debit note', 'gstr-2b', 'itc reconciliation', 'exempt supply'] },
  { nodeKey: 'cmp_tax', label: 'Income Tax & TDS', icon: 'calculator', path: '/compliance/tax', group: 'compliance', position: 42, requiredPermission: 'tds:V', synonyms: ['tds', 'tan', 'challan', '26q', '24q', 'form 16', 'advance tax', 'msme', '43b(h)'] },
  { nodeKey: 'cmp_books', label: 'Audit & Periods', icon: 'clipboard', path: '/compliance/books', group: 'compliance', position: 43, requiredPermission: 'accounting_periods:V', synonyms: ['period close', 'lock period', 'audit trail', 'trial balance', 'schedule iii', 'depreciation schedule', 'tally export'] },
  { nodeKey: 'cmp_payroll', label: 'Payroll Statutory', icon: 'wallet', path: '/compliance/payroll', group: 'compliance', position: 44, requiredPermission: 'payslips:V', synonyms: ['pf', 'esi', 'professional tax', 'payslip', 'ecr', 'gratuity', 'bonus', 'ctc'] },
  { nodeKey: 'cmp_labour', label: 'Labour & Conduct', icon: 'users', path: '/compliance/labour', group: 'compliance', position: 45, requiredPermission: 'holidays:V', synonyms: ['holidays', 'posh', 'internal committee', 'disciplinary', 'appointment letter', 'relieving letter', 'muster roll', 'registers'] },
  { nodeKey: 'cmp_privacy', label: 'Data Protection', icon: 'badge', path: '/compliance/privacy', group: 'compliance', position: 46, requiredPermission: 'consents:V', synonyms: ['dpdp', 'consent', 'privacy notice', 'erasure', 'breach', 'data request', 'guardian consent'] },
  { nodeKey: 'cmp_corporate', label: 'Corporate & Security', icon: 'building', path: '/compliance/corporate', group: 'compliance', position: 47, requiredPermission: 'corporate_registers:V', synonyms: ['board resolution', 'register of members', 'directors', 'mca', 'aoc-4', 'mgt-7', 'refund', 'certificate', 'mfa', 'stamp duty', 'e-sign', 'firc'] },

  { nodeKey: 'data_import', label: 'Import Data', icon: 'inbox', path: '/data/import', group: 'setup', position: 50, requiredPermission: 'imports:V', synonyms: ['tally', 'bank statement', 'excel', 'csv', 'upload', 'migrate', 'bring data in'] },
  { nodeKey: 'gov_decisions', label: 'Decisions', icon: 'scale', path: '/command/decisions', group: 'setup', position: 51, requiredPermission: 'decisions:V' },
  { nodeKey: 'gov_exceptions', label: 'Problems', icon: 'alert', path: '/exceptions', group: 'setup', position: 52, requiredPermission: 'exceptions:V', synonyms: ['issues', 'attention', 'exceptions'] },
  { nodeKey: 'adm_governance', label: 'Who Can Do What', icon: 'shield', path: '/admin/governance', group: 'setup', position: 53, requiredPermission: 'grants:V', synonyms: ['permissions', 'roles', 'grants', 'access'] },
  { nodeKey: 'adm_pipelines', label: 'Pipeline Setup', icon: 'settings', path: '/admin/pipelines', group: 'setup', position: 54, requiredPermission: 'pipeline_definitions:V' },
  { nodeKey: 'adm_territories', label: 'Territories', icon: 'map', path: '/admin/territories', group: 'setup', position: 55, requiredPermission: 'territories:V' },
  { nodeKey: 'adm_agents', label: 'AI Agents', icon: 'sparkle', path: '/admin/agents', group: 'setup', position: 56, requiredPermission: 'agents:V' },
  { nodeKey: 'adm_jobs', label: 'Automatic Checks', icon: 'clock', path: '/admin/jobs', group: 'setup', position: 57, requiredPermission: 'jobs:V' },
  { nodeKey: 'adm_events', label: 'System History', icon: 'list', path: '/admin/events', group: 'setup', position: 58, requiredPermission: 'events:V' },
  { nodeKey: 'adm_audit', label: 'Audit Trail', icon: 'lock', path: '/admin/audit', group: 'setup', position: 59, requiredPermission: 'audit:V' },
  { nodeKey: 'fin_company', label: 'Company Details', icon: 'building', path: '/finance/company', group: 'setup', position: 49, requiredPermission: 'company_profile:V', synonyms: ['gstin', 'registration', 'pan', 'bank details', 'invoice footer', 'legal name', 'address'] },
  { nodeKey: 'adm_platform', label: 'How This Is Built', icon: 'book', path: '/admin/platform', group: 'setup', position: 60, archetypes: ['command', 'workspace', 'console'] },

  // ---- Equity & board (ERP side) -----------------------------------------
  // The register itself is phase 1's `cap_table`/`holders`/etc, not yet ERP
  // nav here (this worktree is based on the phase-0 commit). Board, its
  // resolutions and the compliance calendar are phase 3. `archetypes` is
  // explicit here on purpose — a node with no `archetypes` leaks into every
  // host including the portal shell, and these three belong to the ERP side
  // only; the `portal_board` node above is the shareholder/director view of
  // the same data.
  { nodeKey: 'eq_board', label: 'Board', icon: 'shield', path: '/equity/board', group: 'equity', position: 91, requiredPermission: 'board_meetings:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['meetings', 'minutes', 'agenda', 'directors', 'quorum'] },
  { nodeKey: 'eq_resolutions', label: 'Resolutions', icon: 'scale', path: '/equity/resolutions', group: 'equity', position: 92, requiredPermission: 'resolutions:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['circular resolution', 'vote', 'mgt-14', 'circulation'] },
  { nodeKey: 'eq_compliance', label: 'Compliance', icon: 'clipboard', path: '/equity/compliance', group: 'equity', position: 93, requiredPermission: 'compliance:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['calendar', 'due dates', 'filings', 'ss-1', 'agm', 'mbp-1'] },

  // ---- The equity & board portal ----------------------------------------
  // `archetypes: ['portal']` is what actually keeps these off the ERP shell —
  // `navigationFor()` filters by the active role's archetype, so an ERP role
  // opening the portal host sees none of these, and a portal role opening the
  // ERP host still sees only these (§3.1).
  { nodeKey: 'portal_holdings', label: 'Holdings', icon: 'coins', path: '/portal/holdings', group: 'portal', position: 70, requiredPermission: 'holdings:V', archetypes: ['portal'], synonyms: ['shares', 'my shares', 'cap table', 'ownership'] },
  { nodeKey: 'portal_certificates', label: 'Certificates', icon: 'file', path: '/portal/certificates', group: 'portal', position: 71, requiredPermission: 'share_certificates:V', archetypes: ['portal'], synonyms: ['share certificate'] },
  { nodeKey: 'portal_documents', label: 'Documents', icon: 'file', path: '/portal/documents', group: 'portal', position: 72, requiredPermission: 'entity_documents:V', archetypes: ['portal'] },
  { nodeKey: 'portal_board', label: 'Board', icon: 'shield', path: '/portal/board', group: 'portal', position: 73, requiredPermission: 'board_meetings:V', archetypes: ['portal'], synonyms: ['meetings', 'resolutions', 'minutes'] },
  { nodeKey: 'portal_entities', label: 'Entities', icon: 'building', path: '/portal/entities', group: 'portal', position: 74, requiredPermission: 'group:V', archetypes: ['portal'], synonyms: ['group', 'subsidiaries', 'structure chart'] },
  // An employee who is also a shareholder sees their own grants here too —
  // identical content to `my_options`, reached from the portal shell instead
  // of the ERP one.
  { nodeKey: 'portal_options', label: 'Options', icon: 'coins', path: '/portal/options', group: 'portal', position: 75, requiredPermission: 'option_grants:V', archetypes: ['portal'], synonyms: ['esop', 'stock options', 'vesting'] },

  // The register, worked from the ERP side — company secretary, finance,
  // chairman. Nothing here is `archetypes: ['portal']`, so it never reaches
  // the portal shell; the portal's own view of the same facts is the
  // `portal_*` group above.
  { nodeKey: 'eq_cap_table', label: 'Cap Table', icon: 'chart', path: '/equity/cap-table', group: 'equity', position: 80, requiredPermission: 'cap_table:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['shareholders', 'cap table', 'ownership', 'members'] },
  { nodeKey: 'eq_register', label: 'Share Register', icon: 'file', path: '/equity/register', group: 'equity', position: 81, requiredPermission: 'share_ledger:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['share register', 'allotments', 'transfers', 'ledger'] },
  { nodeKey: 'eq_holders', label: 'Holders', icon: 'users', path: '/equity/holders', group: 'equity', position: 82, requiredPermission: 'holders:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['shareholders', 'members', 'investors'] },
  { nodeKey: 'eq_share_classes', label: 'Share Classes', icon: 'package', path: '/equity/share-classes', group: 'equity', position: 83, requiredPermission: 'share_classes:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['equity', 'preference', 'instruments'] },
  { nodeKey: 'eq_valuations', label: 'Valuations', icon: 'trending', path: '/equity/valuations', group: 'equity', position: 84, requiredPermission: 'valuations:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['409a', 'fmv', 'fair value'] },
  { nodeKey: 'eq_documents', label: 'Entity Documents', icon: 'file', path: '/equity/documents', group: 'equity', position: 85, requiredPermission: 'entity_documents:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['certificates', 'resolutions', 'filings'] },
  // Group (equity-portal plan §6, phase 2). Reads the holding tenant's own
  // snapshots only — see `domains/group.ts`.
  { nodeKey: 'eq_group', label: 'Group', icon: 'building', path: '/equity/group', group: 'equity', position: 90, requiredPermission: 'group:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['subsidiaries', 'structure chart', 'consolidated', 'look-through', 'sbo'] },
  // Rounds, instruments, valuations, scenarios (phase 4).
  { nodeKey: 'eq_rounds', label: 'Rounds', icon: 'trending', path: '/equity/rounds', group: 'equity', position: 86, requiredPermission: 'rounds:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['funding round', 'preferential', 'private placement', 'bonus', 'rights issue', 'buyback'] },
  { nodeKey: 'eq_scenarios', label: 'Scenarios', icon: 'chart', path: '/equity/scenarios', group: 'equity', position: 87, requiredPermission: 'cap_table:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['dilution', 'waterfall', 'modelling', 'what if'] },
  { nodeKey: 'eq_esop', label: 'ESOP', icon: 'coins', path: '/equity/esop', group: 'equity', position: 88, requiredPermission: 'esop_plans:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['options', 'option pool', 'stock options', 'vesting', 'sh-6'] },
  // Filings, demat, FEMA (phase 6a).
  { nodeKey: 'eq_filings', label: 'Filings', icon: 'file', path: '/equity/filings', group: 'equity', position: 89, requiredPermission: 'compliance:V', archetypes: ['command', 'workspace', 'console'], synonyms: ['mgt-1', 'mgt-2', 'pas-3', 'sh-4', 'pas-6', 'demat', 'fema', 'fc-gpr', 'fc-trs', 'fla'] },
];

/**
 * Each context registers the sensitivity of its own entity types. Anything NOT
 * registered defaults to `confidential` and raises S1_ATTENTION — defaulting to
 * internal means every new column ships readable.
 */
async function seedSensitivityRegistrations() {
  const tenantId = (await currentTenant()).id;
  const rows: Array<{ contextCode: string; entityType: string; sensitivityClass: string }> = [
    { contextCode: 'crm', entityType: 'lead', sensitivityClass: 'internal' },
    { contextCode: 'crm', entityType: 'opportunity', sensitivityClass: 'internal' },
    { contextCode: 'crm', entityType: 'account', sensitivityClass: 'internal' },
    { contextCode: 'crm', entityType: 'organization', sensitivityClass: 'internal' },
    { contextCode: 'crm', entityType: 'institution_profile', sensitivityClass: 'internal' },
    { contextCode: 'crm', entityType: 'mou', sensitivityClass: 'restricted' },
    { contextCode: 'crm', entityType: 'contract', sensitivityClass: 'confidential' },
    { contextCode: 'crm', entityType: 'partner_agreement', sensitivityClass: 'restricted' },
    { contextCode: 'idn', entityType: 'person', sensitivityClass: 'internal' },
    { contextCode: 'fin', entityType: 'invoice', sensitivityClass: 'confidential' },
    { contextCode: 'fin', entityType: 'payment', sensitivityClass: 'confidential' },
    { contextCode: 'edu', entityType: 'enrollment', sensitivityClass: 'restricted' },
    // The near-term regulated case: a minor's guardian contact, reached via the
    // admissions pipeline, is exactly the DPDP-covered data the platform calls
    // regulated.
    { contextCode: 'edu', entityType: 'guardian_contact', sensitivityClass: 'regulated' },
    { contextCode: 'prj', entityType: 'project', sensitivityClass: 'internal' },
    { contextCode: 'hr', entityType: 'performance_note', sensitivityClass: 'confidential' },
    { contextCode: 'hr', entityType: 'compensation_record', sensitivityClass: 'regulated' },
    // Deliberately absent: hr.ICC_CASE. Its existence is the sensitive fact, so
    // it is concealed rather than classified — and any unregistered type that
    // reaches the interaction log fails closed at `confidential` anyway.
  ];

  for (const r of rows) {
    await prisma.sensitivityRegistration.upsert({
      where: { tenantId_contextCode_entityType: { tenantId, contextCode: r.contextCode, entityType: r.entityType } },
      create: { tenantId, ...r },
      update: { sensitivityClass: r.sensitivityClass },
    });
  }
  console.log(`  ${rows.length} sensitivity registrations`);
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

async function seedGovernance() {
  const tenantId = (await currentTenant()).id;

  const basePolicy = await prisma.policy.upsert({
    where: { tenantId_policyCode: { tenantId, policyCode: 'POL-PLATFORM-BASE' } },
    create: {
      tenantId,
      policyCode: 'POL-PLATFORM-BASE',
      name: 'Platform base permission policy',
      description: 'The rules every permission in the system is granted under.',
      kind: 'permission',
    },
    update: {},
  });

  let version = await prisma.policyVersion.findFirst({ where: { policyId: basePolicy.id, version: 1 } });
  if (!version) {
    version = await prisma.policyVersion.create({
      data: {
        tenantId,
        policyId: basePolicy.id,
        version: 1,
        content: {
          axes: ['WHO', 'WHERE', 'WHAT', 'HOW_MUCH', 'WHY'],
          evaluationTime: 'query',
          cachedAtLogin: false,
          scopeSemantics: {
            own: 'Narrows mutation to records the requester owns. View and export always resolve to all.',
            own_or_unowned: 'Additionally permits mutation on unowned records, with a same-branch check applied ONLY in the unowned case.',
            all: 'No narrowing.',
          },
          translationNote: 'Behaviour-preserving translation of the legacy 14x10 matrix. Later changes happen only by authoring a new POLICY_VERSION.',
        },
      },
    });
    await prisma.policy.update({ where: { id: basePolicy.id }, data: { currentVersionId: version.id } });
  }

  // The three approval-gate instances. Specified alongside their entities at
  // build time, never retrofitted — instantiate, do not re-derive.
  const gates = [
    {
      code: 'POL-CRM-MOU-APPROVAL',
      name: 'MoU privileged-transition approval',
      requiredPermission: 'mous:approve',
      authorityClass: 'mou_approval',
    },
    {
      code: 'POL-CRM-CONTRACT-APPROVAL',
      name: 'Contract privileged-transition approval',
      requiredPermission: 'contracts:approve',
      authorityClass: 'contract_approval',
    },
    {
      code: 'POL-CRM-PARTNER-APPROVAL',
      name: 'Partner agreement privileged-transition approval',
      requiredPermission: 'partner_agreements:approve',
      authorityClass: 'partner_approval',
    },
  ];

  for (const gate of gates) {
    const policy = await prisma.policy.upsert({
      where: { tenantId_policyCode: { tenantId, policyCode: gate.code } },
      create: { tenantId, policyCode: gate.code, name: gate.name, kind: 'approval_gate' },
      update: {},
    });
    const existing = await prisma.policyVersion.findFirst({ where: { policyId: policy.id, version: 1 } });
    if (existing) continue;

    const pv = await prisma.policyVersion.create({
      data: {
        tenantId,
        policyId: policy.id,
        version: 1,
        content: {
          requiredPermission: gate.requiredPermission,
          authorityClass: gate.authorityClass,
          approverResolution: ['business_head', 'director', 'chairman'],
          // An OR gate, deliberately: a zero-value high-strategic academic MoU
          // escalates to the top tier as readily as a high-value commercial one.
          escalateToTopTierWhen: { strategicValue: 'high', termMonthsOver: 36 },
          selfDealingBar: true,
          // Structurally excluded at every tier — not merely a runtime check
          // that a missed code path could bypass.
          excludedRoles: ['system_admin'],
          // The approval decision is PROHIBITED for any AI principal regardless
          // of AUTHORITY_GRANT size.
          appliesTo: { principalTypes: ['human'] },
          escalationGraceBusinessDays: 3,
        },
      },
    });
    await prisma.policy.update({ where: { id: policy.id }, data: { currentVersionId: pv.id } });
  }

  console.log(`  1 base policy + ${gates.length} approval gates`);
  return { policyVersionId: version.id };
}

async function seedGrants(policyVersionId: string) {
  const tenantId = (await currentTenant()).id;
  let roleCount = 0;
  let grantCount = 0;

  for (const def of ROLE_DEFINITIONS) {
    const role = await prisma.accessRole.upsert({
      where: { tenantId_slug: { tenantId, slug: def.slug } },
      create: {
        tenantId,
        slug: def.slug,
        name: def.name,
        description: def.description,
        archetype: def.archetype,
        classificationCeiling: def.classificationCeiling,
        isSystem: true,
      },
      update: { name: def.name, description: def.description, archetype: def.archetype, classificationCeiling: def.classificationCeiling },
    });
    roleCount += 1;

    for (const spec of ROLE_GRANT_MATRIX[def.slug] ?? []) {
      const parsed = parseCell(spec.cell);
      // An explicit absence is exactly that: no row, not a placeholder.
      if (!parsed) continue;

      // Keyed on resource AND scope, so one resource can carry two cells —
      // `leads: V@all` beside `leads: CE@own` is "see every lead, edit your
      // own", which needs two rows to say. Keyed on resource alone, the second
      // cell was silently dropped and the matrix quietly disagreed with the
      // database.
      const existing = await prisma.grant.findFirst({
        where: { tenantId, roleId: role.id, resource: spec.resource, scope: parsed.scope },
      });

      if (existing) {
        // Re-running the deployment pipeline does NOT alter GRANT records.
        continue;
      }

      await prisma.grant.create({
        data: {
          tenantId,
          principalType: 'role',
          roleId: role.id,
          policyVersionId,
          resource: spec.resource,
          verbs: parsed.verbs,
          scope: parsed.scope,
          scopeResolver: spec.scopeResolver ?? null,
          conditions: (spec.conditions ?? {}) as never,
        },
      });
      grantCount += 1;
    }
  }

  console.log(`  ${roleCount} roles, ${grantCount} grants`);
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

async function seedPipelines() {
  const tenantId = (await currentTenant()).id;

  for (const seed of PIPELINE_SEEDS) {
    const existing = await prisma.pipelineDefinition.findFirst({
      where: { tenantId, pipelineCode: seed.pipelineCode },
    });
    if (existing) continue;

    const pipeline = await prisma.pipelineDefinition.create({
      data: {
        tenantId,
        pipelineCode: seed.pipelineCode,
        name: seed.name,
        commercialMotion: seed.commercialMotion,
        appliesToVerticals: seed.appliesToVerticals,
        appliesToAccountKind: seed.appliesToAccountKind,
        defaultForecastMethod: seed.defaultForecastMethod,
        requiresAwardArtefact: seed.requiresAwardArtefact,
        isDefault: seed.isDefault ?? false,
        commitApprovalThreshold: seed.commitApprovalThreshold ?? undefined,
      },
    });

    for (const stage of seed.stages) {
      await prisma.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          stageKey: stage.stageKey,
          label: stage.label,
          sequence: stage.sequence,
          defaultProbability: stage.defaultProbability,
          pipelinePosition: stage.pipelinePosition,
          isOpen: stage.pipelinePosition !== 0 && stage.pipelinePosition !== 90,
          isTerminal: stage.pipelinePosition === 0 || stage.pipelinePosition === 90,
          postAward: stage.postAward ?? false,
          stageAgeBudgetDays: stage.stageAgeBudgetDays,
          requiredFields: stage.requiredFields ?? [],
        },
      });
    }

    // The three retired post-award stages remain DEFINED for reporting on
    // historical rows, but no transition targets them.
    if (seed.pipelineCode === 'PL-ENTERPRISE') {
      for (const stage of RETIRED_POST_AWARD_STAGES) {
        await prisma.pipelineStage.create({
          data: {
            tenantId,
            pipelineId: pipeline.id,
            stageKey: stage.stageKey,
            label: stage.label,
            sequence: stage.sequence,
            defaultProbability: stage.defaultProbability,
            pipelinePosition: stage.pipelinePosition,
            isOpen: false,
            isTerminal: false,
            postAward: true,
            stageAgeBudgetDays: null,
          },
        });
      }
    }

    for (const t of transitionsFor(seed.stages)) {
      await prisma.pipelineTransition.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          fromStageKey: t.fromStageKey,
          toStageKey: t.toStageKey,
          requiresApproval: t.requiresApproval,
          requiredPermission: t.requiredPermission,
          emitsEvent: EVENTS.OPPORTUNITY_STAGE_CHANGED,
        },
      });
    }
  }

  const count = await prisma.pipelineDefinition.count({ where: { tenantId } });
  console.log(`  ${count} pipelines with stages and validated transition graphs`);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

async function seedAgents() {
  const tenantId = (await currentTenant()).id;

  const agents = [
    {
      agentKey: 'agent.dedup',
      name: 'Identity Resolution Agent',
      purpose: 'Raises near-duplicate person pairs into human review that the exact-match stage misses.',
      tier: 'RECOMMEND',
      tools: ['tool.idn.suggest_duplicates', 'tool.idn.resolve_person'],
      countCeiling: 200,
    },
    {
      agentKey: 'agent.router',
      name: 'Lead Routing Agent',
      purpose: 'Evaluates the six routing factors and assigns ownership within a transparent, tenant-configured policy.',
      tier: 'AUTONOMOUS_WITHIN_POLICY',
      tools: ['tool.crm.route_lead', 'tool.crm.score_lead'],
      countCeiling: 1000,
    },
    {
      agentKey: 'agent.forecast',
      name: 'Forecast Advisor',
      purpose: 'Flags deals whose activity pattern resembles historically-committed ones. Never writes a forecast category.',
      tier: 'RECOMMEND',
      tools: ['tool.crm.suggest_forecast_category', 'tool.crm.suggest_stage_budget'],
      countCeiling: 100,
    },
    {
      agentKey: 'agent.drafter',
      name: 'Proposal Drafting Agent',
      purpose: 'Drafts proposal narrative from structured opportunity and offering data. A human always sends.',
      tier: 'DRAFT',
      tools: ['tool.pct.draft_proposal', 'tool.pct.flag_clause_risk'],
      countCeiling: 25,
    },
    {
      agentKey: 'agent.owner_resolver',
      name: 'Exception Ownership Agent',
      purpose: 'Resolves an owner for an exception that failed to route. Assigns; never decides or acts on the substance.',
      tier: 'AUTONOMOUS_WITHIN_POLICY',
      tools: ['tool.xcp.resolve_owner'],
      countCeiling: 500,
    },
    {
      agentKey: 'agent.enricher',
      name: 'Institution Registry Enricher',
      purpose: 'Fills AISHE/UDISE+ identifiers from an external provider, above a confidence threshold. Leaves null rather than fabricating.',
      tier: 'AUTONOMOUS_WITHIN_POLICY',
      tools: ['tool.crm.enrich_institution', 'tool.crm.suggest_specialisation'],
      countCeiling: 300,
    },
    {
      agentKey: 'agent.ask_kaizen',
      name: 'Ask Kaizen',
      purpose: 'Answers from governed widget data through the identical five-axis filter. It cannot answer what the surface would withhold.',
      tier: 'READ',
      tools: ['tool.xdm.answer_from_composition', 'tool.mem.render_narrative'],
      countCeiling: null,
    },
  ];

  for (const a of agents) {
    const agent = await prisma.agentPrincipal.upsert({
      where: { tenantId_agentKey: { tenantId, agentKey: a.agentKey } },
      create: {
        tenantId,
        agentKey: a.agentKey,
        name: a.name,
        purpose: a.purpose,
        tier: a.tier,
        declaredTools: a.tools,
      },
      update: { name: a.name, purpose: a.purpose, tier: a.tier, declaredTools: a.tools },
    });

    if (a.countCeiling) {
      const exists = await prisma.authorityGrant.findFirst({
        where: { tenantId, principalId: agent.id, authorityClass: 'agent_action' },
      });
      if (!exists) {
        await prisma.authorityGrant.create({
          data: {
            tenantId,
            principalType: 'agent',
            principalId: agent.id,
            principalLabel: a.name,
            authorityClass: 'agent_action',
            // An agent's bounds are its own — never inherited from a human's.
            countCeiling: a.countCeiling,
            countWindow: 'day',
            riskClassCeiling: 'low',
          },
        });
      }
    }
  }

  console.log(`  ${agents.length} agent principals with declared tools and their own authority grants`);
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

async function seedSurfaces() {
  const tenantId = (await currentTenant()).id;

  // Navigation, written through the same function the API runs at boot — one
  // implementation of "make the menu match the code" rather than two that drift.
  const { reconcileNav } = await import('../platform/navSync.js');
  await reconcileNav(tenantId);

  // Every widget declares all seven mandatory fields. A non-empty actions[] is
  // enforced at publish time.
  const widgets = [
    { widgetKey: 'pulse_strip', title: 'Company Pulse', dataSource: 'health.latestPulse', requiredPermission: 'health_scores:V', severityRelevance: 'S1_ATTENTION', actions: [{ label: 'Open factor breakdown', path: '/command/health/:domainCode' }], drillTarget: '/command/health', mobileBehaviour: 'keep', emptyState: 'Not measured yet — not enough information in any area.' },
    { widgetKey: 'attention_queue', title: 'Attention Queue', dataSource: 'commandCenter.attentionQueue', requiredPermission: 'exceptions:V', severityRelevance: 'S3_HIGH_RISK', actions: [{ label: 'Acknowledge', path: '/exceptions/:id/acknowledge' }, { label: 'Resolve', path: '/exceptions/:id/resolve' }], drillTarget: '/exceptions', mobileBehaviour: 'keep', emptyState: 'Nothing serious is open for you.' },
    { widgetKey: 'decision_queue', title: 'Decision Queue', dataSource: 'decisions.decisionQueue', requiredPermission: 'decisions:V', severityRelevance: 'S2_WARNING', actions: [{ label: 'Decide', path: '/command/decisions/:id' }, { label: 'Delegate', path: '/command/decisions/:id' }, { label: 'Defer', path: '/command/decisions/:id' }, { label: 'Request evidence', path: '/command/decisions/:id' }], drillTarget: '/command/decisions', mobileBehaviour: 'keep', emptyState: 'Nothing needs a decision only you can make.' },
    { widgetKey: 'what_changed', title: 'What Changed', dataSource: 'commandCenter.whatChanged', requiredPermission: 'events:V', severityRelevance: 'S1_ATTENTION', actions: [{ label: 'Open source event', path: '/admin/events' }], drillTarget: '/admin/events', mobileBehaviour: 'drill_only', emptyState: 'Nothing big enough to report since you last looked.' },
    { widgetKey: 'live_and_handled', title: 'Live & Handled', dataSource: 'commandCenter.liveAndHandled', requiredPermission: 'jobs:V', severityRelevance: 'S0_INFO', actions: [{ label: 'Inspect authority', path: '/admin/agents' }], drillTarget: '/admin/jobs', mobileBehaviour: 'shed', emptyState: 'Nothing ran. Worth a look if something normally does.' },
    { widgetKey: 'forecast_band', title: 'Forecast', dataSource: 'opportunities.forecastRollup', requiredPermission: 'opportunities:V', severityRelevance: 'S2_WARNING', actions: [{ label: 'Open the model', path: '/crm/forecast' }, { label: 'Set a review date', path: '/command/decisions' }], drillTarget: '/crm/forecast', mobileBehaviour: 'shed', emptyState: 'No forecast we have checked for accuracy yet, so none is shown.' },
    { widgetKey: 'people_capability', title: 'People & Capability', dataSource: 'commandCenter.peopleAndCapability', requiredPermission: 'health_scores:V', severityRelevance: 'S1_ATTENTION', actions: [{ label: 'Review unit coverage', path: '/command' }], drillTarget: '/command', mobileBehaviour: 'drill_only', emptyState: 'Every team is too small to show without identifying people.' },
    { widgetKey: 'my_queue', title: 'My Queue', dataSource: 'crm.tasks', requiredPermission: 'interactions:V', severityRelevance: 'S1_ATTENTION', actions: [{ label: 'Complete', path: '/workspace' }], drillTarget: '/workspace', mobileBehaviour: 'keep', emptyState: 'Nothing due.' },
    { widgetKey: 'my_pipeline', title: 'My Pipeline', dataSource: 'crm.opportunities', requiredPermission: 'opportunities:V', severityRelevance: 'S1_ATTENTION', actions: [{ label: 'Open board', path: '/crm/pipeline' }], drillTarget: '/crm/pipeline', mobileBehaviour: 'keep', emptyState: 'No open opportunities assigned to you.' },
    { widgetKey: 'unrouted_leads', title: 'Unrouted Leads', dataSource: 'crm.leads?unrouted=true', requiredPermission: 'leads:V', severityRelevance: 'S2_WARNING', actions: [{ label: 'Assign', path: '/crm/leads' }], drillTarget: '/crm/leads?unrouted=true', mobileBehaviour: 'keep', emptyState: 'Every open lead has a resolved owner.', noActionFallback: 'Route to the territory owner with a 4-business-hour SLA.' },
  ];

  for (const w of widgets) {
    await prisma.widgetDefinition.upsert({
      where: { tenantId_widgetKey: { tenantId, widgetKey: w.widgetKey } },
      create: {
        tenantId,
        widgetKey: w.widgetKey,
        title: w.title,
        dataSource: w.dataSource,
        requiredPermission: w.requiredPermission,
        severityRelevance: w.severityRelevance,
        actions: w.actions as never,
        drillTarget: w.drillTarget,
        mobileBehaviour: w.mobileBehaviour,
        emptyState: w.emptyState,
        noActionFallback: (w as { noActionFallback?: string }).noActionFallback ?? null,
      },
      update: { title: w.title, actions: w.actions as never, emptyState: w.emptyState },
    });
  }

  const templates = [
    { templateKey: 'command_center', name: 'Chairman Command Center', archetype: 'command', eligibleRoles: ['chairman', 'founder', 'admin', 'director', 'business_head'], widgets: ['pulse_strip', 'attention_queue', 'decision_queue', 'what_changed', 'live_and_handled', 'forecast_band', 'people_capability'] },
    { templateKey: 'employee_workspace', name: 'Employee & Manager Workspace', archetype: 'workspace', eligibleRoles: [], widgets: ['my_queue', 'my_pipeline', 'unrouted_leads'] },
  ];

  for (const t of templates) {
    const template = await prisma.surfaceTemplate.upsert({
      where: { tenantId_templateKey: { tenantId, templateKey: t.templateKey } },
      create: { tenantId, templateKey: t.templateKey, name: t.name, archetype: t.archetype, eligibleRoles: t.eligibleRoles },
      update: { name: t.name, eligibleRoles: t.eligibleRoles },
    });

    for (const [i, widgetKey] of t.widgets.entries()) {
      const widget = await prisma.widgetDefinition.findFirst({ where: { tenantId, widgetKey } });
      if (!widget) continue;
      await prisma.widgetBinding.upsert({
        where: { templateId_widgetId: { templateId: template.id, widgetId: widget.id } },
        create: { tenantId, templateId: template.id, widgetId: widget.id, position: i },
        update: { position: i },
      });
    }
  }

  console.log(`  ${NAV_REGISTRY.length} nav nodes, ${widgets.length} widgets, ${templates.length} surface templates`);
}

// ---------------------------------------------------------------------------

/**
 * The tenant every helper below writes into. `seedBootstrap` sets this once
 * at the top of a run — set rather than threaded as a parameter through every
 * `seedThresholds`/`seedGovernance`/… helper, so a subsidiary's bootstrap is a
 * one-line change here and not a signature change in a dozen functions that
 * otherwise behave identically for every tenant.
 */
let ACTIVE_TENANT_SLUG = TENANT_SLUG;
let ACTIVE_TENANT_NAME = TENANT_NAME;

async function currentTenant() {
  const t = await unscopedPrisma.tenant.findFirstOrThrow({ where: { slug: ACTIVE_TENANT_SLUG } });
  return t;
}
// ---------------------------------------------------------------------------
// Statutory leave types
// ---------------------------------------------------------------------------

/**
 * The five leave types Indian employment ordinarily runs on. These are
 * structure rather than data: a tenant with no leave types cannot accept a
 * leave request at all, and a company that wants different ones edits these
 * rather than inventing the concept.
 */
async function seedLeaveTypes() {
  const tenantId = (await currentTenant()).id;
  const specs = [
    { code: 'CL', name: 'Casual Leave', annualEntitlementDays: 12, statutory: false, employmentStateAffecting: false },
    { code: 'SL', name: 'Sick Leave', annualEntitlementDays: 12, statutory: true, employmentStateAffecting: false },
    { code: 'EL', name: 'Earned Leave', annualEntitlementDays: 15, statutory: true, employmentStateAffecting: false },
    // Long leave takes somebody off the roll while it runs, so the employment
    // relationship moves with it.
    { code: 'ML', name: 'Maternity Leave', annualEntitlementDays: 182, statutory: true, employmentStateAffecting: true },
    { code: 'LOP', name: 'Loss of Pay', annualEntitlementDays: 0, statutory: false, employmentStateAffecting: false },
  ];
  let created = 0;
  for (const spec of specs) {
    const existing = await prisma.leaveType.findFirst({ where: { tenantId, code: spec.code } });
    if (existing) continue;
    await prisma.leaveType.create({ data: { tenantId, ...spec } });
    created += 1;
  }
  console.log(`  ${created} leave types (${specs.length} declared)`);
}

// ---------------------------------------------------------------------------
// The founding accounts
// ---------------------------------------------------------------------------

/**
 * The four people the company runs on, one per role.
 *
 * This used to create one account — the chairman — on the principle that
 * everybody else is invited from inside the product. That principle is still
 * right for the fifth person onwards and was wrong for the first four: the
 * matrix's whole point is that a pay rise takes two parties and the books are
 * not the people function, and a tenant with one superadmin account cannot
 * demonstrate any of it. Somebody signing in for the first time had to create
 * three colleagues before the product behaved the way it is designed to.
 *
 * So the four named role-holders are seeded, and every one of them gets its own
 * generated password, printed once. A known default password in a seed script is
 * a known default password in production, and "it is only the demo one" has never
 * been true by the time it mattered.
 *
 * Names and addresses are overridable per account, so a different company does
 * not inherit these ones. `OWNER_*` stays the chairman's, unchanged, because
 * that is what existing installs and `docker-compose.yml` already set.
 */
interface FoundingAccount {
  roleSlug: string;
  /** Env prefix for the three overrides: `_EMAIL`, `_NAME`, `_PASSWORD`. */
  env: string;
  defaultLocalPart: string;
  /**
   * The designation, not a person.
   *
   * A seeded account is a post rather than a human: whoever holds it changes,
   * and a name baked into the seed is wrong the first time somebody else takes
   * the job. `<PREFIX>_NAME` sets the real one at install time, and the person
   * can edit it afterwards from their own record.
   */
  defaultName: string;
  /** What this account is for, printed beside it at the end of the seed. */
  holds: string;
}

const FOUNDING_ACCOUNTS: FoundingAccount[] = [
  {
    roleSlug: 'chairman',
    env: 'OWNER',
    defaultLocalPart: 'chairman',
    defaultName: 'Chairman',
    holds: 'superadmin — every resource, every verb, every scope',
  },
  {
    roleSlug: 'hr_ops_manager',
    env: 'OPERATIONS',
    defaultLocalPart: 'operations',
    defaultName: 'Operations Head',
    holds: 'the people function, delivery, education and the course catalogue',
  },
  {
    roleSlug: 'finance_head',
    env: 'FINANCE',
    defaultLocalPart: 'finance',
    defaultName: 'Finance Head',
    holds: 'the books, the GST returns, and the money side of people',
  },
  {
    roleSlug: 'employee',
    env: 'EMPLOYEE',
    defaultLocalPart: 'employee',
    defaultName: 'Employee',
    holds: 'their own record, and raising invoices at the counter',
  },
];

const EMAIL_DOMAIN = process.env.SEED_EMAIL_DOMAIN ?? 'kaizen.co.in';

export interface SeededAccount {
  roleSlug: string;
  name: string;
  email: string;
  holds: string;
  /** Null when the password came from the environment, or the account already existed. */
  password: string | null;
  created: boolean;
}

async function seedAccount(spec: FoundingAccount): Promise<SeededAccount> {
  const tenantId = (await currentTenant()).id;
  const email = (
    process.env[`${spec.env}_EMAIL`] ?? `${spec.defaultLocalPart}@${EMAIL_DOMAIN}`
  ).toLowerCase();
  const fullName = process.env[`${spec.env}_NAME`] ?? spec.defaultName;

  const existingUser = await prisma.user.findFirst({ where: { tenantId, email } });

  let person = await prisma.person.findFirst({ where: { tenantId, primaryEmail: email } });
  if (!person) {
    person = await prisma.person.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('PER'),
        fullName,
        primaryEmail: email,
        primaryEmailNormalised: email,
        source: 'bootstrap',
      },
    });
  }

  // Checked and repaired rather than created once beside the user, because the
  // two can come apart: a run that fails between the two writes leaves an
  // account that can authenticate and then resolves to no affiliation, which
  // presents as a login that succeeds and a session with no authority at all.
  const affiliation = await prisma.affiliation.findFirst({
    where: { tenantId, partyId: person.id, roleSlug: spec.roleSlug },
  });
  if (!affiliation) {
    await prisma.affiliation.create({
      data: {
        tenantId,
        partyId: person.id,
        affiliationType: 'employee',
        counterpartyName: ACTIVE_TENANT_NAME,
        roleSlug: spec.roleSlug,
        primaryFlag: true,
        status: 'active',
        // An employee affiliation carries a statutory retention floor: a dedup
        // match against it never auto-merges.
        statutoryRetentionFloor: true,
      },
    });
  }

  if (existingUser) {
    console.log(`  ${spec.roleSlug} ${email} already exists — password left untouched`);
    return { roleSlug: spec.roleSlug, name: fullName, email, holds: spec.holds, password: null, created: false };
  }

  // The credential lives on the Principal, not the User — find-or-create it
  // directly here rather than leaving it to the backfill, so a brand-new
  // tenant's founding accounts never pass through the "unmigrated" state at
  // all. Keyed on lowercase email: the same person signing in as chairman of
  // the holding and as a director of a subsidiary is one Principal (§3.2),
  // and a subsidiary bootstrapped with the same `OWNER_EMAIL` reuses the
  // holding chairman's existing password rather than silently resetting it.
  const existingPrincipal = await unscopedPrisma.principal.findFirst({ where: { email } });
  const fromEnv = process.env[`${spec.env}_PASSWORD`];
  const password = fromEnv ?? randomUUID().replace(/-/g, '').slice(0, 16);

  const principal =
    existingPrincipal ?? (await unscopedPrisma.principal.create({ data: { email, passwordHash: await hashPassword(password) } }));

  await prisma.user.create({
    data: { tenantId, personId: person.id, email, principalId: principal.id },
  });

  console.log(`  ${spec.roleSlug} ${email} created`);
  return {
    roleSlug: spec.roleSlug,
    name: fullName,
    email,
    holds: spec.holds,
    password: existingPrincipal || fromEnv ? null : password,
    created: true,
  };
}

async function seedFoundingAccounts(): Promise<SeededAccount[]> {
  const out: SeededAccount[] = [];
  for (const spec of FOUNDING_ACCOUNTS) out.push(await seedAccount(spec));
  return out;
}

// ---------------------------------------------------------------------------

export interface SeedBootstrapOptions {
  /** Defaults to `TENANT_SLUG` (env `TENANT_SLUG`, else `kaizen`) — the existing default path is unchanged when this is omitted. */
  tenantSlug?: string;
  tenantName?: string;
  /** The slug of this tenant's parent, if any — `PARENT_TENANT_SLUG` when omitted. `reconcileTenantKinds` derives `kind` from this at the end of the run; it is never trusted as written past that point. */
  parentTenantSlug?: string;
  /** The division this subsidiary grew out of — written into `config.originDivision` (§1.1). */
  originDivision?: 'software' | 'skill' | 'education';
}

export async function seedBootstrap(opts: SeedBootstrapOptions = {}): Promise<{
  tenantId: string;
  owner: { email: string; password: string | null };
  accounts: SeededAccount[];
}> {
  ACTIVE_TENANT_SLUG = opts.tenantSlug ?? TENANT_SLUG;
  ACTIVE_TENANT_NAME = opts.tenantName ?? TENANT_NAME;
  const parentSlug = opts.parentTenantSlug ?? PARENT_TENANT_SLUG;

  const parent = parentSlug ? await unscopedPrisma.tenant.findFirst({ where: { slug: parentSlug } }) : null;
  if (parentSlug && !parent) {
    throw new Error(`--parent ${parentSlug} does not exist. Bootstrap the parent tenant first.`);
  }

  const tenant = await unscopedPrisma.tenant.upsert({
    where: { slug: ACTIVE_TENANT_SLUG },
    create: {
      slug: ACTIVE_TENANT_SLUG,
      name: ACTIVE_TENANT_NAME,
      status: 'active',
      parentTenantId: parent?.id ?? null,
      ...(TENANT_KIND ? { kind: TENANT_KIND } : {}),
      config: {
        // The explicit bootstrap authority set, owned by SYS: who may create
        // the first POLICY or GRANT for a new tenant. This breaks the
        // circularity of the permission system needing permission to create
        // itself.
        bootstrapAuthoritySet: ['chairman'],
        forecastPeriod: 'quarter',
        baseCurrency: 'INR',
        // Flipped by the onboarding checklist once the company has been set up.
        // Until then the product leads with setup rather than with empty
        // dashboards.
        onboardingComplete: false,
        ...(opts.originDivision ? { originDivision: opts.originDivision } : {}),
      },
    },
    // A tenant that already exists keeps its parent as it is — re-running
    // bootstrap is not how a tenant is re-parented, the same posture every
    // other block here takes toward its own rows.
    update: {},
  });

  registerSubscribers();

  let accounts: SeededAccount[] = [];
  await asSystem(tenant.id, async () => {
    await seedThresholds();
    await seedSensitivityRegistrations();
    const { policyVersionId } = await seedGovernance();
    await seedGrants(policyVersionId);
    await seedPipelines();
    await seedSurfaces();
    await seedAgents();
    await seedLeaveTypes();
    await seedCompliance();
    accounts = await seedFoundingAccounts();
  });

  // Rows written under an older shape, brought up to the current one. Safe to
  // re-run: each backfill changes only what still carries the old shape.
  const backfilled = await runBackfills();

  // Stamp the tenant with the seed that just ran.
  //
  // The third of the three things that can be stale independently, and the one
  // nothing on screen reveals: the API and the web bundle can both be current
  // while a tenant's seeded rows — the grant matrix, the navigation, its
  // vocabulary — are from three deploys ago. "Customers" went on opening
  // Organisations for exactly that reason. The sequence increments on every
  // run, so the footnote can say how far behind the data is rather than only
  // when it was last touched.
  const previous = (tenant.config as { seed?: { sequence?: number } } | null)?.seed;
  await unscopedPrisma.tenant.update({
    where: { id: tenant.id },
    data: {
      config: {
        ...((tenant.config as object) ?? {}),
        seed: {
          sequence: (Number(previous?.sequence) || 0) + 1,
          at: new Date().toISOString(),
          build: BUILD.sequence,
          commit: BUILD.commit,
          navNodes: NAV_REGISTRY.length,
        },
      } as never,
    },
  });
  if (backfilled.organizationKinds > 0) {
    console.log(`  ${backfilled.organizationKinds} organisation(s) recognised as institutions`);
  }
  if (backfilled.studentProfiles > 0) {
    console.log(`  ${backfilled.studentProfiles} enrolled learner(s) given a student record`);
  }
  if (backfilled.designations > 0) {
    console.log(`  ${backfilled.designations} founding account(s) now named by designation`);
  }
  if (backfilled.principals > 0) {
    console.log(`  ${backfilled.principals} user(s) given a principal`);
  }

  // Never trust `kind` as written — recompute it from the parent/child rows
  // that actually exist, every run. Raises the §1a.1 small-company notice the
  // first time this or any tenant in the same group flips to holding/subsidiary.
  await reconcileTenantKinds();

  // `owner` is kept as its own field because it is what every caller printing
  // sign-in details actually wants, and because removing it would break them for
  // no gain. It is the chairman's row of `accounts`.
  const chairman = accounts.find((a) => a.roleSlug === 'chairman');
  return {
    tenantId: tenant.id,
    owner: { email: chairman?.email ?? '', password: chairman?.password ?? null },
    accounts,
  };
}
