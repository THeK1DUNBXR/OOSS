/**
 * The five seeded pipelines (CRM-LEAD-002).
 *
 * This is where the schema becomes the fix. One enum served nine verticals and
 * produced three live defects: a weighted pipeline value with no coherent unit
 * once summed across motions, stage-age SLAs that could not be set on one
 * shared clock, and an entire motion — placement — with no pipeline object at
 * all, so the one motion with recurring forecastable volume was invisible to
 * every forecast the platform produced.
 *
 * Every stage carries one of the eight canonical `pipelinePosition` values, so
 * "both at qualified" holds across motions even where the labels differ.
 */

export interface StageSeed {
  stageKey: string;
  label: string;
  sequence: number;
  defaultProbability: number;
  pipelinePosition: number;
  stageAgeBudgetDays: number | null;
  requiredFields?: string[];
  postAward?: boolean;
}

export interface PipelineSeed {
  pipelineCode: string;
  name: string;
  commercialMotion: string;
  appliesToVerticals: string[];
  appliesToAccountKind: string;
  defaultForecastMethod: string;
  requiresAwardArtefact: string;
  isDefault?: boolean;
  commitApprovalThreshold?: number;
  stages: StageSeed[];
}

export const PIPELINE_SEEDS: PipelineSeed[] = [
  {
    // Long-cycle, committee-bought.
    pipelineCode: 'PL-ENTERPRISE',
    name: 'Enterprise Direct',
    commercialMotion: 'enterprise_direct',
    appliesToVerticals: ['sap_enterprise', 'cybersecurity', 'software_ai', 'corporate_training', 'research', 'other'],
    appliesToAccountKind: 'organization',
    defaultForecastMethod: 'weighted_stage',
    requiresAwardArtefact: 'contract',
    commitApprovalThreshold: 5_000_000,
    stages: [
      { stageKey: 'discovered', label: 'Discovered', sequence: 1, defaultProbability: 5, pipelinePosition: 10, stageAgeBudgetDays: null },
      { stageKey: 'engaged', label: 'Engaged', sequence: 2, defaultProbability: 15, pipelinePosition: 20, stageAgeBudgetDays: 14 },
      {
        stageKey: 'qualified',
        label: 'Qualified',
        sequence: 3,
        defaultProbability: 30,
        pipelinePosition: 30,
        stageAgeBudgetDays: 14,
        // The MEDDPICC-style scorecard fields that make a commit evidenced
        // rather than asserted.
        requiredFields: ['expectedValue', 'expectedCloseDate'],
      },
      { stageKey: 'solution_shaped', label: 'Solution Shaped', sequence: 4, defaultProbability: 45, pipelinePosition: 40, stageAgeBudgetDays: 21 },
      { stageKey: 'proposed', label: 'Proposed', sequence: 5, defaultProbability: 60, pipelinePosition: 50, stageAgeBudgetDays: 10 },
      { stageKey: 'negotiating', label: 'Negotiating', sequence: 6, defaultProbability: 80, pipelinePosition: 60, stageAgeBudgetDays: 14 },
      { stageKey: 'won', label: 'Won', sequence: 7, defaultProbability: 100, pipelinePosition: 90, stageAgeBudgetDays: null },
      { stageKey: 'lost', label: 'Lost', sequence: 8, defaultProbability: 0, pipelinePosition: 0, stageAgeBudgetDays: null },
    ],
  },
  {
    // MoU-based, relationship-driven, longer natural cycle: five idle days at
    // `engaged` is normal here and fatal in the admissions motion.
    pipelineCode: 'PL-INSTITUTION',
    name: 'Institution Partnership',
    commercialMotion: 'institution_partnership',
    appliesToVerticals: ['partnerships'],
    appliesToAccountKind: 'institution',
    defaultForecastMethod: 'weighted_stage',
    requiresAwardArtefact: 'mou',
    stages: [
      { stageKey: 'identified', label: 'Identified', sequence: 1, defaultProbability: 5, pipelinePosition: 10, stageAgeBudgetDays: null },
      { stageKey: 'engaged', label: 'Engaged', sequence: 2, defaultProbability: 15, pipelinePosition: 20, stageAgeBudgetDays: 30 },
      { stageKey: 'qualified', label: 'Qualified', sequence: 3, defaultProbability: 30, pipelinePosition: 30, stageAgeBudgetDays: 30, requiredFields: ['expectedCloseDate'] },
      { stageKey: 'mou_drafted', label: 'MoU Drafted', sequence: 4, defaultProbability: 50, pipelinePosition: 40, stageAgeBudgetDays: 21 },
      { stageKey: 'mou_offered', label: 'MoU Offered', sequence: 5, defaultProbability: 65, pipelinePosition: 50, stageAgeBudgetDays: 21 },
      { stageKey: 'negotiating', label: 'Negotiating', sequence: 6, defaultProbability: 80, pipelinePosition: 60, stageAgeBudgetDays: 30 },
      { stageKey: 'won', label: 'Signed', sequence: 7, defaultProbability: 100, pipelinePosition: 90, stageAgeBudgetDays: null },
      { stageKey: 'lost', label: 'Lost', sequence: 8, defaultProbability: 0, pipelinePosition: 0, stageAgeBudgetDays: null },
    ],
  },
  {
    // 1-30 day cycle, high volume, low per-deal information density. Replaces
    // EDUCATION_ADMISSION_STAGES as data rather than a code constant, plus a
    // `not_proceeding` terminal loss stage.
    pipelineCode: 'PL-ADMISSION',
    name: 'Learner Admission',
    commercialMotion: 'learner_admission',
    appliesToVerticals: ['education'],
    appliesToAccountKind: 'individual',
    defaultForecastMethod: 'milestone_based',
    requiresAwardArtefact: 'enrollment',
    stages: [
      { stageKey: 'new_enquiry', label: 'New Enquiry', sequence: 1, defaultProbability: 5, pipelinePosition: 10, stageAgeBudgetDays: 2 },
      { stageKey: 'counselled', label: 'Counselled', sequence: 2, defaultProbability: 20, pipelinePosition: 20, stageAgeBudgetDays: 3 },
      { stageKey: 'course_selected', label: 'Course Selected', sequence: 3, defaultProbability: 40, pipelinePosition: 30, stageAgeBudgetDays: 3 },
      { stageKey: 'seat_reserved', label: 'Seat Reserved', sequence: 4, defaultProbability: 60, pipelinePosition: 40, stageAgeBudgetDays: 5 },
      { stageKey: 'fee_offered', label: 'Fee Offered', sequence: 5, defaultProbability: 75, pipelinePosition: 50, stageAgeBudgetDays: 5 },
      { stageKey: 'registration', label: 'Registration', sequence: 6, defaultProbability: 90, pipelinePosition: 60, stageAgeBudgetDays: 3 },
      { stageKey: 'enrolled', label: 'Enrolled', sequence: 7, defaultProbability: 100, pipelinePosition: 90, stageAgeBudgetDays: null },
      { stageKey: 'not_proceeding', label: 'Not Proceeding', sequence: 8, defaultProbability: 0, pipelinePosition: 0, stageAgeBudgetDays: null },
    ],
  },
  {
    // The pipeline that did not exist. Employer demand now has a first-class
    // object with its own SLA clocks and its own contribution to coverage,
    // instead of being invisible to every forecast.
    pipelineCode: 'PL-PLACEMENT',
    name: 'Workforce Placement',
    commercialMotion: 'workforce_placement',
    appliesToVerticals: ['placement'],
    appliesToAccountKind: 'organization',
    // Stage-weighted probability is a poor proxy for a fee-on-confirmed-
    // placement motion, so only explicitly committed deals count.
    defaultForecastMethod: 'manual_commit',
    requiresAwardArtefact: 'partner_agreement',
    stages: [
      { stageKey: 'demand_identified', label: 'Demand Identified', sequence: 1, defaultProbability: 10, pipelinePosition: 10, stageAgeBudgetDays: 5 },
      { stageKey: 'employer_engaged', label: 'Employer Engaged', sequence: 2, defaultProbability: 20, pipelinePosition: 20, stageAgeBudgetDays: 10 },
      {
        stageKey: 'requirement_qualified',
        label: 'Requirement Qualified',
        sequence: 3,
        defaultProbability: 35,
        pipelinePosition: 30,
        stageAgeBudgetDays: 10,
        requiredFields: ['expectedValue'],
      },
      { stageKey: 'candidates_shortlisted', label: 'Candidates Shortlisted', sequence: 4, defaultProbability: 55, pipelinePosition: 40, stageAgeBudgetDays: 14 },
      { stageKey: 'terms_offered', label: 'Terms Offered', sequence: 5, defaultProbability: 70, pipelinePosition: 50, stageAgeBudgetDays: 7 },
      { stageKey: 'agreement_negotiating', label: 'Agreement Negotiating', sequence: 6, defaultProbability: 85, pipelinePosition: 60, stageAgeBudgetDays: 10 },
      { stageKey: 'placement_confirmed', label: 'Placement Confirmed', sequence: 7, defaultProbability: 100, pipelinePosition: 90, stageAgeBudgetDays: null },
      { stageKey: 'lost', label: 'Lost', sequence: 8, defaultProbability: 0, pipelinePosition: 0, stageAgeBudgetDays: null },
    ],
  },
  {
    // Post-award, opened against a parent contract. Replaces the retired
    // `renew_expand_refer` stage, which was structurally unforecastable because
    // it was excluded from OPEN_STAGES by omission rather than design.
    pipelineCode: 'PL-RENEWAL',
    name: 'Renewal & Expansion',
    commercialMotion: 'renewal_expansion',
    appliesToVerticals: [],
    appliesToAccountKind: 'any',
    defaultForecastMethod: 'weighted_stage',
    requiresAwardArtefact: 'contract',
    isDefault: true,
    stages: [
      { stageKey: 'renewal_identified', label: 'Renewal Identified', sequence: 1, defaultProbability: 20, pipelinePosition: 10, stageAgeBudgetDays: 14 },
      { stageKey: 'engaged', label: 'Engaged', sequence: 2, defaultProbability: 35, pipelinePosition: 20, stageAgeBudgetDays: 14 },
      { stageKey: 'qualified', label: 'Qualified', sequence: 3, defaultProbability: 50, pipelinePosition: 30, stageAgeBudgetDays: 14 },
      { stageKey: 'terms_shaped', label: 'Terms Shaped', sequence: 4, defaultProbability: 65, pipelinePosition: 40, stageAgeBudgetDays: 14 },
      { stageKey: 'offer_sent', label: 'Offer Sent', sequence: 5, defaultProbability: 80, pipelinePosition: 50, stageAgeBudgetDays: 10 },
      { stageKey: 'negotiating', label: 'Negotiating', sequence: 6, defaultProbability: 90, pipelinePosition: 60, stageAgeBudgetDays: 14 },
      { stageKey: 'renewed_or_expanded', label: 'Renewed or Expanded', sequence: 7, defaultProbability: 100, pipelinePosition: 90, stageAgeBudgetDays: null },
      { stageKey: 'churned', label: 'Churned', sequence: 8, defaultProbability: 0, pipelinePosition: 0, stageAgeBudgetDays: null },
    ],
  },
];

/**
 * Builds the transition graph. Forward moves, one backward move per stage (a
 * re-scope is legitimate), and a direct path to both terminals from every open
 * stage — so every non-terminal stage can reach a terminal one and the
 * reachability check passes.
 */
export function transitionsFor(stages: StageSeed[]): Array<{
  fromStageKey: string | null;
  toStageKey: string;
  requiresApproval: boolean;
  requiredPermission: string;
}> {
  const open = stages.filter((s) => s.pipelinePosition !== 0 && s.pipelinePosition !== 90).sort((a, b) => a.sequence - b.sequence);
  const won = stages.find((s) => s.pipelinePosition === 90)!;
  const lost = stages.find((s) => s.pipelinePosition === 0)!;

  const out: Array<{ fromStageKey: string | null; toStageKey: string; requiresApproval: boolean; requiredPermission: string }> = [];

  // The initial creation transition.
  out.push({ fromStageKey: null, toStageKey: open[0].stageKey, requiresApproval: false, requiredPermission: 'opportunities:create' });

  for (let i = 0; i < open.length; i += 1) {
    const stage = open[i];
    const next = open[i + 1];
    if (next) {
      out.push({ fromStageKey: stage.stageKey, toStageKey: next.stageKey, requiresApproval: false, requiredPermission: 'opportunities:edit' });
    }
    const prev = open[i - 1];
    if (prev) {
      // A deal can move backward on a re-scope.
      out.push({ fromStageKey: stage.stageKey, toStageKey: prev.stageKey, requiresApproval: false, requiredPermission: 'opportunities:edit' });
    }
    // Every open stage can close, in either direction.
    out.push({ fromStageKey: stage.stageKey, toStageKey: lost.stageKey, requiresApproval: false, requiredPermission: 'opportunities:edit' });
    if (stage.pipelinePosition >= 50) {
      out.push({ fromStageKey: stage.stageKey, toStageKey: won.stageKey, requiresApproval: false, requiredPermission: 'opportunities:edit' });
    }
  }

  return out;
}

/**
 * The three retired post-award stages. They remain DEFINED for reporting on
 * historical rows, marked `postAward` and `isOpen: false`, but no transition
 * targets them — the Kanban stops offering them as drop targets entirely.
 */
export const RETIRED_POST_AWARD_STAGES: StageSeed[] = [
  { stageKey: 'delivering', label: 'Delivering (retired)', sequence: 90, defaultProbability: 0, pipelinePosition: 90, stageAgeBudgetDays: null, postAward: true },
  { stageKey: 'outcome', label: 'Outcome (retired)', sequence: 91, defaultProbability: 0, pipelinePosition: 90, stageAgeBudgetDays: null, postAward: true },
  { stageKey: 'renew_expand_refer', label: 'Renew/Expand/Refer (retired)', sequence: 92, defaultProbability: 0, pipelinePosition: 60, stageAgeBudgetDays: null, postAward: true },
];
