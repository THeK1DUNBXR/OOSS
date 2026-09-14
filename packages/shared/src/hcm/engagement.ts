/**
 * HCM — engagement, communications & HR helpdesk (docs/hcm/engagement.md).
 *
 * Pure logic only: eNPS computation and SLA breach detection. Everything
 * stateful (announcements, recognition, surveys, helpdesk cases, policy
 * acknowledgements, exit interviews) lives in the API domain layer, which is
 * the only place a database or the clock may be touched.
 */
export const HCM_ENGAGEMENT_MODULE = 'engagement' as const;

// ---------------------------------------------------------------------------
// eNPS
// ---------------------------------------------------------------------------

/** A single eNPS response, 0-10 — "how likely are you to recommend working here". */
export interface EnpsBreakdown {
  promoters: number;
  passives: number;
  detractors: number;
  responses: number;
  /** -100..100. `null` when there are no responses, or too few to report without exposing individuals, to compute a score from. */
  score: number | null;
}

/**
 * The floor below which a survey result is withheld or narrowed rather than
 * reported: the same k-anonymity floor `commandCenter.ts` uses for
 * unit-level capacity. Below it, an eNPS `score` comes back `null` and free
 * text answers on an anonymous survey are withheld — either would let a
 * reader read a handful of respondents' individual answers back off an
 * "aggregate".
 */
export const SURVEY_MIN_SAMPLE = 5;

/**
 * Standard NPS math applied to the employee-engagement variant: 9-10 promote,
 * 7-8 are passive, 0-6 detract. `score = (%promoters - %detractors)`, rounded
 * to the nearest whole point, which is how eNPS is conventionally reported —
 * but only once there are at least `SURVEY_MIN_SAMPLE` responses; below that
 * the breakdown is still returned (so a manager can see "too few responses"),
 * but `score` is withheld as `null`.
 */
export function computeEnps(scores: number[]): EnpsBreakdown {
  const responses = scores.length;
  if (responses === 0) {
    return { promoters: 0, passives: 0, detractors: 0, responses: 0, score: null };
  }
  let promoters = 0;
  let detractors = 0;
  for (const raw of scores) {
    const s = Math.max(0, Math.min(10, Math.round(raw)));
    if (s >= 9) promoters += 1;
    else if (s <= 6) detractors += 1;
  }
  const passives = responses - promoters - detractors;
  const score = responses < SURVEY_MIN_SAMPLE ? null : Math.round(((promoters - detractors) / responses) * 100);
  return { promoters, passives, detractors, responses, score };
}

// ---------------------------------------------------------------------------
// SLA breach detection
// ---------------------------------------------------------------------------

/** Case states that are no longer anybody's open SLA obligation. */
export const HR_CASE_TERMINAL_STATUSES = ['resolved', 'closed'] as const;

/**
 * An HR helpdesk case is SLA-breached when it is still open (not resolved or
 * closed) and its due date has passed. A resolved-late case is not breached —
 * the SLA is about whether it is *still* outstanding past the deadline, not
 * whether it was ever late; a case closed one minute after its due date is a
 * different fact from one that has sat open for a week past it.
 */
export function isHrCaseSlaBreached(status: string, slaDueAt: Date, asOf: Date = new Date()): boolean {
  if ((HR_CASE_TERMINAL_STATUSES as readonly string[]).includes(status)) return false;
  return slaDueAt.getTime() < asOf.getTime();
}

/** Days (fractional, can be negative once breached) until a case's SLA deadline. */
export function daysToSlaDue(slaDueAt: Date, asOf: Date = new Date()): number {
  return (slaDueAt.getTime() - asOf.getTime()) / 86_400_000;
}

// ---------------------------------------------------------------------------
// Survey question shapes
// ---------------------------------------------------------------------------

export const SURVEY_QUESTION_TYPES = ['scale', 'text', 'enps'] as const;
export type SurveyQuestionType = (typeof SURVEY_QUESTION_TYPES)[number];

export interface SurveyQuestion {
  id: string;
  type: SurveyQuestionType;
  text: string;
  /** For `scale`: the top of the range (bottom is always 0). Defaults to 10. */
  scaleMax?: number;
}

export interface SurveyAnswer {
  questionId: string;
  /** `scale`/`enps` carry a number; `text` carries a string. */
  value: number | string;
}

/** Every question in the survey has a matching, in-range answer. */
export function validateSurveyAnswers(questions: SurveyQuestion[], answers: SurveyAnswer[]): string | null {
  const byId = new Map(questions.map((q) => [q.id, q]));
  if (answers.length !== questions.length) {
    return `Expected ${questions.length} answer(s), received ${answers.length}.`;
  }
  for (const answer of answers) {
    const q = byId.get(answer.questionId);
    if (!q) return `"${answer.questionId}" is not a question on this survey.`;
    if (q.type === 'text') {
      if (typeof answer.value !== 'string' || !answer.value.trim()) return `"${q.text}" needs a text answer.`;
    } else {
      const n = Number(answer.value);
      if (Number.isNaN(n)) return `"${q.text}" needs a numeric answer.`;
      const max = q.type === 'enps' ? 10 : (q.scaleMax ?? 10);
      if (n < 0 || n > max) return `"${q.text}" must be between 0 and ${max}.`;
    }
  }
  return null;
}

/** The response rate as a percentage, or `null` when the audience size is not known. */
export function responseRate(responded: number, audienceSize: number | null): number | null {
  if (audienceSize === null || audienceSize <= 0) return null;
  return Math.round((responded / audienceSize) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Audience matching
// ---------------------------------------------------------------------------

export const AUDIENCE_TYPES = ['all', 'division', 'org_unit', 'location'] as const;
export type AudienceType = (typeof AUDIENCE_TYPES)[number];

export interface Audience {
  audienceType: AudienceType;
  audienceDivision?: string | null;
  audienceOrgUnitId?: string | null;
  audienceLocation?: string | null;
}

export interface AudienceFacts {
  division?: string | null;
  orgUnitId?: string | null;
  location?: string | null;
}

/** Whether a person described by `facts` falls inside a published audience. */
export function inAudience(audience: Audience, facts: AudienceFacts): boolean {
  switch (audience.audienceType) {
    case 'all':
      return true;
    case 'division':
      return Boolean(audience.audienceDivision) && audience.audienceDivision === facts.division;
    case 'org_unit':
      return Boolean(audience.audienceOrgUnitId) && audience.audienceOrgUnitId === facts.orgUnitId;
    case 'location':
      return Boolean(audience.audienceLocation) && audience.audienceLocation === facts.location;
    default:
      return false;
  }
}
