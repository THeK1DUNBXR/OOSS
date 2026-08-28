/**
 * P6 — AI governance.
 *
 * Every AI agent carries its own identity — never a shared service account,
 * never a role — and a specific AUTHORITY_GRANT bounding what it can do: a value
 * limit, a count limit, and a risk-class ceiling. An agent acts only through
 * declared TOOLs; there is no private write path around this.
 */

/** The six-tier action classification. The tier is the mechanism, not a UX detail to be loosened later. */
export const AI_TIERS = [
  {
    code: 'READ',
    label: 'Read',
    meaning: 'The agent may observe data, produce no output that changes anything.',
    canWrite: false,
    requiresHuman: false,
  },
  {
    code: 'RECOMMEND',
    label: 'Recommend',
    meaning: 'The agent may suggest an action; a human decides whether to take it.',
    canWrite: false,
    requiresHuman: true,
  },
  {
    code: 'DRAFT',
    label: 'Draft',
    meaning: 'The agent may produce a draft artifact; a human reviews and sends/publishes it.',
    canWrite: false,
    requiresHuman: true,
  },
  {
    code: 'EXECUTE_WITH_APPROVAL',
    label: 'Execute with approval',
    meaning: 'The agent may take the action, but only after an explicit human approval gate.',
    canWrite: true,
    requiresHuman: true,
  },
  {
    code: 'AUTONOMOUS_WITHIN_POLICY',
    label: 'Autonomous within policy',
    meaning: 'The agent may act without a per-instance approval, bounded strictly by its AUTHORITY_GRANT and a pre-approved policy.',
    canWrite: true,
    requiresHuman: false,
  },
  {
    code: 'PROHIBITED',
    label: 'Prohibited',
    meaning: 'The agent may never do this, under any authority grant.',
    canWrite: false,
    requiresHuman: false,
  },
] as const;

export type AiTierCode = (typeof AI_TIERS)[number]['code'];

export const AI_TIER_BY_CODE = Object.fromEntries(AI_TIERS.map((t) => [t.code, t])) as Record<
  AiTierCode,
  (typeof AI_TIERS)[number]
>;

/**
 * Four hard prohibitions apply platform-wide, regardless of any AUTHORITY_GRANT
 * a future policy might attempt to issue.
 */
export const HARD_PROHIBITIONS = [
  {
    code: 'no_individual_attrition_scoring',
    statement: 'No individual attrition or flight-risk scoring.',
    rationale:
      'The platform\'s actual levers here are structural (hire, cross-train, re-allocate), not individual prediction. Enforced by unit-level-only aggregation and the k>=5 floor, not merely a policy note.',
  },
  {
    code: 'no_autonomous_pay_leave_promotion',
    statement: 'No autonomous execution of pay, leave or promotion decisions.',
    rationale: 'These commit the organisation to a person; a named human role sits at every tier.',
  },
  {
    code: 'no_action_outside_declared_tool',
    statement: 'No AI acting outside a declared TOOL.',
    rationale: 'There is no private write path around the tool declaration.',
  },
  {
    code: 'no_employee_communication_surveillance',
    statement: 'No employee-communication surveillance.',
    rationale: 'Reading employee communications to score or monitor individuals is categorically out of scope.',
  },
] as const;

export type ProhibitionCode = (typeof HARD_PROHIBITIONS)[number]['code'];

/** Actions categorically barred for every AI principal at every AUTHORITY_GRANT size. */
export const AI_PROHIBITED_ACTIONS = [
  'mou.approve',
  'mou.sign',
  'contract.approve',
  'contract.sign',
  'partner_agreement.approve',
  'person.merge',
  'policy.author',
  'grant.issue',
  'decision.decide',
  'decision.delegate',
  'authority_grant.revoke',
];

export interface AiTouchpoint {
  code: string;
  surface: string;
  description: string;
  tier: AiTierCode;
  tool: string;
  boundary: string;
}

/**
 * The CRM-scoped AI touchpoint catalogue (11-ai-requirements). Every touchpoint
 * carries a declared TOOL and, where applicable, an AUTHORITY_GRANT with
 * value/count/risk-class bounds.
 */
export const AI_TOUCHPOINTS: AiTouchpoint[] = [
  {
    code: 'AI-IDN-001',
    surface: 'Person resolution',
    description: 'Stage-1/2 exact-match entity resolution — mechanical rule evaluation, no model in the loop.',
    tier: 'AUTONOMOUS_WITHIN_POLICY',
    tool: 'tool.idn.resolve_person',
    boundary: 'Deterministic only. Never merges; never overrides the sensitive-data veto.',
  },
  {
    code: 'AI-IDN-002',
    surface: 'Person near-duplicate detection',
    description: 'Stage-3 embedding-similarity pass over free text to catch near-duplicates the exact-match stage misses.',
    tier: 'RECOMMEND',
    tool: 'tool.idn.suggest_duplicates',
    boundary:
      'Structurally bounded: may only raise a pair from auto-reject into human review, never push review into auto-accept.',
  },
  {
    code: 'AI-IDN-003',
    surface: 'Merge confirmation',
    description: 'Confirming a merge candidate.',
    tier: 'PROHIBITED',
    tool: '—',
    boundary: 'No confidence score authorises an automatic merge. A human confirms every merge.',
  },
  {
    code: 'AI-ORG-001',
    surface: 'Institution registry enrichment',
    description: 'Enrichment-waterfall fill of AISHE/UDISE+ registry identifiers from an external provider.',
    tier: 'AUTONOMOUS_WITHIN_POLICY',
    tool: 'tool.crm.enrich_institution',
    boundary:
      'Bounded to non-regulated fields, provider-confidence-gated. The absence of a value is safe; a wrong value is not — leave null rather than fabricate.',
  },
  {
    code: 'AI-ORG-002',
    surface: 'Specialisation suggestion',
    description: 'Suggesting that an Account-only Organization likely also merits an InstitutionProfile.',
    tier: 'RECOMMEND',
    tool: 'tool.crm.suggest_specialisation',
    boundary: 'Never auto-attached.',
  },
  {
    code: 'AI-REL-001',
    surface: 'Relationship strength inference',
    description: 'Inferring relationship strength from interaction frequency and recency.',
    tier: 'RECOMMEND',
    tool: 'tool.crm.suggest_relationship_strength',
    boundary:
      'Strength is a direct input to the routing engine — a mis-set strength misroutes leads. Never auto-set at strong by inference alone.',
  },
  {
    code: 'AI-PIPE-001',
    surface: 'Pipeline authoring',
    description: 'Authoring a PIPELINE_DEFINITION or PIPELINE_TRANSITION.',
    tier: 'PROHIBITED',
    tool: '—',
    boundary: 'This changes what every seller in the vertical may do — a governance action, not a data-entry convenience.',
  },
  {
    code: 'AI-PIPE-002',
    surface: 'Stage age budget suggestion',
    description: 'Proposing a stage_age_budget_days value computed from historical stage-to-stage velocity.',
    tier: 'RECOMMEND',
    tool: 'tool.crm.suggest_stage_budget',
    boundary: 'May propose for an administrator to accept; never writes one directly.',
  },
  {
    code: 'AI-LEAD-001',
    surface: 'Lead scoring',
    description: 'Rule-based lead scoring with transparent score_reasons[].',
    tier: 'AUTONOMOUS_WITHIN_POLICY',
    tool: 'tool.crm.score_lead',
    boundary: 'Transparent, reversible, non-consequential until a human acts on the qualification gate.',
  },
  {
    code: 'AI-ROUTE-001',
    surface: 'Lead routing',
    description: 'Six-factor routing evaluation — hard filters then soft-factor scoring.',
    tier: 'AUTONOMOUS_WITHIN_POLICY',
    tool: 'tool.crm.route_lead',
    boundary:
      'Every factor and weight is transparent, tenant-configured, and disclosed to the affected rep via the routing-audit view.',
  },
  {
    code: 'AI-FCST-001',
    surface: 'Forecast category suggestion',
    description: 'Flagging a best_case deal whose activity pattern resembles historically-committed deals.',
    tier: 'RECOMMEND',
    tool: 'tool.crm.suggest_forecast_category',
    boundary: 'Never writes forecast_category directly — leadership relies on this number for revenue planning.',
  },
  {
    code: 'AI-COML-001',
    surface: 'Revenue treatment default',
    description: 'Suggesting default_revenue_treatment from delivery_model on offering create.',
    tier: 'AUTONOMOUS_WITHIN_POLICY',
    tool: 'tool.crm.suggest_revenue_treatment',
    boundary: 'Pre-fill on create only; never auto-applied to an already-active offering.',
  },
  {
    code: 'AI-COML-002',
    surface: 'Proposal narrative',
    description: 'AI-drafted proposal narrative from Opportunity and Offering structured data.',
    tier: 'DRAFT',
    tool: 'tool.pct.draft_proposal',
    boundary: 'Never auto-sent. A human always sends.',
  },
  {
    code: 'AI-COML-003',
    surface: 'Contract redlining',
    description: 'Clause-risk flagging on a contract document.',
    tier: 'RECOMMEND',
    tool: 'tool.pct.flag_clause_risk',
    boundary: 'Flags risk, never accepts or rejects a clause.',
  },
  {
    code: 'AI-COML-004',
    surface: 'Obligation extraction',
    description: 'Extracting renewal dates and obligations from a signed document.',
    tier: 'EXECUTE_WITH_APPROVAL',
    tool: 'tool.pct.extract_obligations',
    boundary: 'A human confirms end_date once before the expiry ladder starts running against it.',
  },
  {
    code: 'AI-COML-005',
    surface: 'Contract approval',
    description: 'Executing the approved/signed transition.',
    tier: 'PROHIBITED',
    tool: '—',
    boundary: 'This transition commits the organisation legally. Barred at every AUTHORITY_GRANT size.',
  },
  {
    code: 'AI-WLR-001',
    surface: 'Win/loss disposition triage',
    description: 'Proposing a disposition from a row\'s activity history for migration triage.',
    tier: 'RECOMMEND',
    tool: 'tool.crm.triage_disposition',
    boundary: 'Pre-fills a report; every row\'s final classification requires human confirmation.',
  },
  {
    code: 'AI-XCP-001',
    surface: 'Exception ownership resolution',
    description: 'Resolving an owner for an exception that failed to route.',
    tier: 'AUTONOMOUS_WITHIN_POLICY',
    tool: 'tool.xcp.resolve_owner',
    boundary: 'Assigns within 15 minutes during an absence window. Assigns; never decides or acts on the exception\'s substance.',
  },
  {
    code: 'AI-CMD-001',
    surface: 'Ask Kaizen',
    description: 'Natural-language query answering over the same governed widget compositions every visual surface renders.',
    tier: 'READ',
    tool: 'tool.xdm.answer_from_composition',
    boundary:
      'Runs through the identical five-axis filter — it cannot answer what the surface would withhold. Every answer carries its drill path.',
  },
  {
    code: 'AI-CMD-002',
    surface: 'Narrative briefing',
    description: 'Prose rendering of the since-I-last-looked delta.',
    tier: 'DRAFT',
    tool: 'tool.mem.render_narrative',
    boundary:
      'Behaves like READ: every claim must resolve to an admitted delta item a human could independently verify. Opens with a computed reconciliation line, not a stylistic flourish.',
  },
  {
    code: 'AI-GOV-001',
    surface: 'Decision disposition',
    description: 'Decide / Delegate / Defer / Request-evidence.',
    tier: 'PROHIBITED',
    tool: '—',
    boundary: 'There is no AI disposition authority anywhere on the Command Center surface.',
  },
];

export interface AuthorityBounds {
  /** Value ceiling, in the grant's currency. */
  ceilingValue?: number | null;
  currency?: string | null;
  /** Count ceiling per window, e.g. "draft up to 5 outreach emails per day". */
  countCeiling?: number | null;
  countWindow?: 'day' | 'week' | 'month' | null;
  /** Risk-class ceiling. */
  riskClassCeiling?: string | null;
}

export function isProhibitedForAgent(action: string): boolean {
  return AI_PROHIBITED_ACTIONS.includes(action);
}
