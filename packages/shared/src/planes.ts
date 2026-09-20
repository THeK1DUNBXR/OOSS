/**
 * The ten architectural planes (03-target-platform-model §3.1).
 *
 * Every capability in the platform is assigned to exactly one plane. A plane owns
 * its own kind of record and answers its own question. Nearly every requirement
 * touches several planes at once — that is expected, not a miscategorisation.
 */
export const PLANES = {
  P0: { code: 'P0', name: 'Tenancy & Trust Fabric', owns: 'tenant_id, isolation, trust posture', question: 'Whose data is this, and can this session even reach it?' },
  P1: { code: 'P1', name: 'Party & Identity', owns: 'PERSON, AFFILIATION', question: 'Who is this, in every relationship they hold?' },
  P2: { code: 'P2', name: 'World Model', owns: 'Domain entities', question: 'What is actually true about the business right now?' },
  P3: { code: 'P3', name: 'Relationship Graph', owns: 'Connections between world-model entities', question: 'What is connected to what, and how?' },
  P4: { code: 'P4', name: 'Event Fabric', owns: 'The durable, hash-chained event log', question: 'What happened, in what order, caused by what?' },
  P5: { code: 'P5', name: 'Automation', owns: 'Scheduled jobs, workflow definitions, triggers', question: 'What should happen automatically, and when?' },
  P6: { code: 'P6', name: 'Intelligence', owns: 'AI agents, AUTHORITY_GRANTs, declared TOOLs', question: 'What should an AI agent be allowed to do here?' },
  P7: { code: 'P7', name: 'Governance', owns: 'Policies, approval gates, exception rules', question: 'What requires explicit sign-off, and from whom?' },
  P8: { code: 'P8', name: 'Memory', owns: 'Precedent, prior resolutions, organisational learning', question: 'Has something like this happened before, and how was it handled?' },
  P9: { code: 'P9', name: 'Experience', owns: 'Every user-facing surface', question: 'How does a human actually see and act on all of the above?' },
} as const;

export type PlaneCode = keyof typeof PLANES;

/**
 * The bounded contexts / modules. A module can be the sole write authority for a
 * bounded context, or share one with a sibling module that has its own distinct
 * write authority. Two such splits recur: CRM↔PCT share `crm`; FIN↔PRC share `fin`.
 */
export const BOUNDED_CONTEXTS = [
  'sys', // platform substrate
  'idn', // party & identity
  'gov', // governance
  'crm', // customer relationship (CRM + PCT)
  'pct', // proposals & contracts (module inside the `crm` bounded context)
  'fin', // finance
  'edu', // education
  'hr',  // human resources
  'prj', // projects & delivery
  'mkt', // marketing
  'cs',  // customer success
  'com', // communication & meetings
  'doc', // documents
  'wfl', // workflow & automation
  'xcp', // exception engine
  'anl', // analytics
  'mem', // memory
  'str', // strategy
  'agt', // agent principals
  'xdm', // cross-domain / health
  'eqt', // equity, shareholder & board register
  'ceo', // chairman's office (on-screen name; code prefix stays `ceo`, docs/plan/ceo-office.md §1)
] as const;

export type BoundedContext = (typeof BOUNDED_CONTEXTS)[number];

/**
 * Module register with explicit "Never does" clauses (§3.4). The boundary is
 * written as a prohibition, not just a diagram — check it before designing a
 * feature, not after someone notices the overlap.
 */
export interface ModuleRegisterEntry {
  code: string;
  name: string;
  boundedContext: BoundedContext;
  plane: PlaneCode;
  owns: string[];
  neverDoes: string[];
}

export const MODULE_REGISTER: ModuleRegisterEntry[] = [
  {
    code: 'CRM',
    name: 'Customer Relationship Management',
    boundedContext: 'crm',
    plane: 'P2',
    owns: ['LEAD', 'OPPORTUNITY', 'ACCOUNT', 'INSTITUTION_PROFILE', 'OFFERING', 'PRICE_BOOK_ENTRY', 'WIN_LOSS_REVIEW', 'TERRITORY', 'ROUTING_RULE', 'PIPELINE_DEFINITION'],
    neverDoes: [
      'Write a PROPOSAL, QUOTE, CONTRACT, MOU or PARTNER_AGREEMENT record — those are PCT-owned.',
      'Hold authoritative money state — INVOICE/PAYMENT/RECEIPT are fin-owned; CRM holds a disposable read model only.',
      'Track post-award delivery state — PROJECT.status (prj) and ENROLLMENT.status (edu) own that.',
    ],
  },
  {
    code: 'PCT',
    name: 'Proposals & Contracts',
    boundedContext: 'crm',
    plane: 'P2',
    owns: ['PROPOSAL', 'QUOTE', 'CONTRACT', 'MOU', 'PARTNER_AGREEMENT', 'SIGNATURE_REQUEST'],
    neverDoes: [
      'Move an OPPORTUNITY between pipeline stages — stage authority is CRM\'s.',
      'Author a PIPELINE_DEFINITION or PIPELINE_STAGE.',
    ],
  },
  {
    code: 'FIN',
    name: 'Finance',
    boundedContext: 'fin',
    plane: 'P2',
    owns: ['INVOICE', 'INVOICE_LINE', 'FEE_INSTALMENT', 'PAYMENT', 'RECEIPT', 'CREDIT_NOTE'],
    neverDoes: [
      'Decide what to sell or at what list price — OFFERING and PRICE_BOOK_ENTRY are CRM reference data.',
      'Mutate a PAYMENT row in place — money movement is append-only; corrections are new rows.',
      'Share a route or masking boundary with payroll.',
    ],
  },
  {
    code: 'IDN',
    name: 'Party & Identity',
    boundedContext: 'idn',
    plane: 'P1',
    owns: ['PERSON', 'AFFILIATION', 'USER_ACCOUNT', 'SESSION', 'AGENT_IDENTITY'],
    neverDoes: [
      'Record a role or a relationship on PERSON itself — that is what AFFILIATION and RELATIONSHIP are for.',
      'Create a second person-like table for a new domain.',
    ],
  },
  {
    code: 'GOV',
    name: 'Governance',
    boundedContext: 'gov',
    plane: 'P7',
    owns: ['POLICY', 'POLICY_VERSION', 'GRANT', 'AUTHORITY_GRANT', 'ACCESS_ROLE', 'DECISION', 'DELEGATION'],
    neverDoes: [
      'Evaluate a permission — GOV authors the records, IAM\'s decision point evaluates them.',
      'Permit any principal, system_admin included, to bypass the five-axis evaluator.',
    ],
  },
  {
    code: 'XCP',
    name: 'Exception Engine',
    boundedContext: 'xcp',
    plane: 'P7',
    owns: ['EXCEPTION', 'SLA_TIMER'],
    neverDoes: ['Raise an exception with no resolved owner — ownership precedes notification, always.'],
  },
  {
    code: 'DOC',
    name: 'Documents',
    boundedContext: 'doc',
    plane: 'P2',
    owns: ['DOCUMENT', 'NOTE', 'TAG'],
    neverDoes: [
      'Store a binary in the database — object storage holds bytes, the row holds metadata.',
      'Grant document access independently of the parent record\'s permission.',
    ],
  },
  {
    code: 'EDU',
    name: 'Education',
    boundedContext: 'edu',
    plane: 'P2',
    owns: ['COURSE', 'COHORT', 'ENROLLMENT', 'ATTENDANCE', 'DAILY_PROGRESS', 'STUDENT_PROFILE'],
    neverDoes: ['Run the admissions pipeline — that is CRM\'s PL-ADMISSION motion until enrollment is confirmed.'],
  },
  {
    code: 'EQT',
    name: 'Equity & Board',
    boundedContext: 'eqt',
    plane: 'P2',
    owns: ['SHARE_CLASS', 'HOLDER', 'SHARE_TRANSACTION', 'SHARE_CERTIFICATE', 'BOARD_MEETING', 'RESOLUTION', 'ENTITY_SNAPSHOT'],
    neverDoes: [
      'Hold money movement itself — an allotment references the FIN Transaction that already lifted cash; EQT never posts beside the books.',
      'Approve its own allotment or transfer — that goes through the approval gate, whose self-dealing bar reroutes an interested approver.',
      "Read another tenant's tables — the group view is built from EntitySnapshot rows published upward, never a cross-tenant query.",
    ],
  },
  {
    code: 'CEO',
    name: "Chairman's Office",
    boundedContext: 'ceo',
    plane: 'P2',
    owns: [
      // Phase 1
      'KPI_DEFINITION', 'KPI_FORMULA_VERSION', 'KPI_TARGET_BAND', 'KPI_VALUE', 'KPI_REFERENCE',
      'NORTH_STAR_METRIC', 'COCKPIT_VIEW', 'COCKPIT_SNAPSHOT',
      // Phase 2
      'VISION_STATEMENT', 'THREE_YEAR_PICTURE', 'ANNUAL_OPERATING_PLAN', 'STRATEGIC_THEME',
      'PLAN_ASSUMPTION', 'OBJECTIVE', 'KEY_RESULT', 'CHECK_IN', 'OKR_CYCLE',
      // Phase 3
      'INITIATIVE', 'INITIATIVE_MILESTONE', 'INITIATIVE_DEPENDENCY',
      // Phase 4
      'MEETING_SERIES', 'MEETING_INSTANCE', 'AGENDA_ITEM', 'ISSUE_ITEM', 'ACTION_ITEM',
      'MEETING_DECISION_LINK',
      // Phase 5
      'DOA_MATRIX_ENTRY', 'DELEGATION_LOG',
      // Phase 6
      'BOARD_PACK', 'BOARD_PACK_VERSION', 'INVESTOR_UPDATE', 'INVESTOR_UPDATE_VERSION',
      'DOCUMENT_CIRCULATION', 'STAKEHOLDER', 'STAKEHOLDER_TOUCH',
      // Phase 7
      'RISK_ITEM', 'POLICY_DOCUMENT', 'POLICY_ACKNOWLEDGEMENT',
      // Phase 8
      'FINANCIAL_SCENARIO', 'HEADCOUNT_PLAN', 'HEADCOUNT_PLAN_LINE',
      // Phase 9
      'SEAT', 'SUCCESSION_CANDIDATE', 'ONE_ON_ONE_SERIES', 'ONE_ON_ONE_INSTANCE', 'TIME_AUDIT_ENTRY',
    ],
    neverDoes: [
      'Hold money movement — FIN owns that; this module references Transaction/BudgetLine rows, it never posts one.',
      "Hold statutory board records — BoardMeeting/Resolution stay eqt-owned; the Board Pack is a narrative document that cites a BoardMeeting, it does not replace one.",
      'Write a second Decision-like record — every state transition that needs sign-off reuses GOV\'s Decision via raiseDecision/disposeDecision.',
      "Read another tenant's tables directly — any group-wide chairman view extends group.ts's snapshot-publish pattern, never a new cross-tenant read.",
    ],
  },
];
