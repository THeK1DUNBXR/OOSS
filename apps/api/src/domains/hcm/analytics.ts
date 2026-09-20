/**
 * HCM — WS12 analytics (docs/hcm/analytics.md).
 *
 * Read-only aggregation over tables other workstreams own. There is no
 * write path in this file: it is a reporting layer, not a system of record,
 * so every function here is a `prisma` read plus arithmetic from
 * `@kaizen/shared`'s `analytics.ts`.
 *
 * Two kinds of "I can't answer that" are kept structurally distinct:
 *  - a metric this schema cannot answer at all (no `gender` field on Person,
 *    no recruiting-cost ledger) — returns `notMeasured()` unconditionally,
 *    documented in docs/hcm/analytics.md under "What this does not do";
 *  - a metric that depends on another workstream's table, which may not
 *    exist yet in this checkout or this test database — read through
 *    `readOptionalModel`, which returns `null` on *any* failure (a model
 *    absent from the generated Prisma Client, a table absent from the
 *    database, or a shape this code guessed wrong) rather than throwing, so
 *    this dashboard degrades to "not measured" instead of crashing the page.
 */

import { toCsv } from '@kaizen/shared';
import {
  absenteeismRate,
  annualizedAttritionRate,
  averageTimeToHireDays,
  compaRatio,
  compRatioBucket,
  COMP_RATIO_BUCKETS,
  computeEnps,
  dailyRateFromBasic,
  distribution,
  distributionList,
  isEarlyAttrition,
  daysToSlaDue,
  measured,
  monthKey,
  notMeasured,
  hiringOfferAcceptanceRate,
  slaBucket,
  SLA_BUCKETS,
  spanOfControlStats,
  tenureBucket,
  TENURE_BUCKETS,
  trailingMonths,
  type Metric,
} from '@kaizen/shared';
import { prisma, num, Prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { assertScopeAll, canSeeMoney } from '../../platform/permissions.js';
import { auditExport } from '../../platform/audit.js';
import { payrollTrend } from '../payroll.js';

const EMPLOYED_STATUSES = ['Active', 'OnLeave', 'Suspended', 'NoticePeriod', 'Absconded'];
/**
 * Every status that means the person actually started, at some point —
 * currently employed, or separated having been. `PendingHire` (a hire date
 * set but never activated), `OfferRescinded` and `NoShow` never started, so a
 * `PendingHire` row whose `hireEffectiveDate` has already passed does not
 * inflate a historical headcount it was never actually part of.
 */
const EVER_JOINED_STATUSES = [...EMPLOYED_STATUSES, 'Terminated', 'Alumni'];

function monthEnd(key: string): Date {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1));
}
function monthStart(key: string): Date {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
}

/**
 * Best-effort read of a table another workstream owns, by its Prisma model
 * name. `null` on anything short of success — an as-yet-ungenerated model, a
 * table the DB doesn't carry yet, or a query that fails for any other
 * reason — never a throw, so a metric wired to a workstream that has not
 * landed degrades to "not measured" instead of taking this page down.
 */
async function readOptionalModel<T>(modelName: string, fn: (model: Record<string, (args?: unknown) => Promise<unknown>>) => Promise<T>): Promise<T | null> {
  try {
    const model = (prisma as unknown as Record<string, Record<string, (args?: unknown) => Promise<unknown>> | undefined>)[modelName];
    if (!model) return null;
    return await fn(model);
  } catch {
    return null;
  }
}

async function assertAnalyticsView(): Promise<void> {
  await assertScopeAll('hr_analytics');
}

// ---------------------------------------------------------------------------
// Headcount trend, joiners/leavers, attrition, tenure
// ---------------------------------------------------------------------------

export interface HeadcountPoint {
  month: string;
  headcount: number;
  joiners: number;
  leavers: number;
}

/** Monthly headcount (as of month-end) plus joiners/leavers inside that month, for the trailing `months` months. */
export async function headcountTrend(months = 12): Promise<HeadcountPoint[]> {
  const auth = currentAuth();
  await assertAnalyticsView();

  const keys = trailingMonths(months);
  const earliest = monthStart(keys[0]);
  const latest = monthEnd(keys[keys.length - 1]);

  const rows = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, hireEffectiveDate: { lt: latest } },
    select: { hireEffectiveDate: true, separationDate: true, status: true },
  });
  const everJoined = rows.filter((r) => EVER_JOINED_STATUSES.includes(r.status));

  return keys.map((key) => {
    const start = monthStart(key);
    const end = monthEnd(key);
    const headcount = everJoined.filter(
      (r) => r.hireEffectiveDate < end && (!r.separationDate || r.separationDate >= end),
    ).length;
    const joiners = everJoined.filter((r) => r.hireEffectiveDate >= start && r.hireEffectiveDate < end).length;
    const leavers = rows.filter((r) => r.separationDate && r.separationDate >= start && r.separationDate < end).length;
    return { month: key, headcount, joiners, leavers };
  }).filter((p) => monthStart(p.month) >= earliest);
}

export interface AttritionSummary {
  leavers: number;
  avgHeadcount: number;
  annualizedRatePct: number | null;
  earlyAttritionCount: number;
  earlyAttritionRatePct: number | null;
}

/** CMP-style annualised attrition and the early-attrition cut, over the trailing `months` months. */
export async function attritionSummary(months = 12): Promise<AttritionSummary> {
  const auth = currentAuth();
  await assertAnalyticsView();

  const keys = trailingMonths(months);
  const start = monthStart(keys[0]);
  const end = monthEnd(keys[keys.length - 1]);
  const periodDays = (end.getTime() - start.getTime()) / 86_400_000;

  const leaverRows = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, separationDate: { gte: start, lt: end } },
    select: { hireEffectiveDate: true, separationDate: true },
  });

  const trend = await headcountTrend(months);
  const avgHeadcount = trend.length ? trend.reduce((s, p) => s + p.headcount, 0) / trend.length : 0;

  const earlyLeavers = leaverRows.filter((r) => isEarlyAttrition(r.hireEffectiveDate, r.separationDate as Date));

  return {
    leavers: leaverRows.length,
    avgHeadcount,
    annualizedRatePct: annualizedAttritionRate(leaverRows.length, avgHeadcount, periodDays),
    earlyAttritionCount: earlyLeavers.length,
    earlyAttritionRatePct: leaverRows.length > 0 ? (earlyLeavers.length / leaverRows.length) * 100 : null,
  };
}

export interface TenureDistribution {
  buckets: Record<(typeof TENURE_BUCKETS)[number], number>;
  totalActive: number;
}

/** Tenure histogram of everyone currently employed. */
export async function tenureDistribution(): Promise<TenureDistribution> {
  const auth = currentAuth();
  await assertAnalyticsView();

  const rows = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, status: { in: EMPLOYED_STATUSES } },
    select: { hireEffectiveDate: true },
  });
  const now = new Date();
  return { buckets: distribution(rows, TENURE_BUCKETS, (r) => tenureBucket(r.hireEffectiveDate, now)), totalActive: rows.length };
}

// ---------------------------------------------------------------------------
// Headcount by division / location (current snapshot)
// ---------------------------------------------------------------------------

export interface HeadcountBreakdown {
  key: string;
  headcount: number;
}

/** Current headcount grouped by the org unit's division, or by the position's location. */
export async function headcountBy(dimension: 'division' | 'location'): Promise<HeadcountBreakdown[]> {
  const auth = currentAuth();
  await assertAnalyticsView();

  const employments = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, status: { in: EMPLOYED_STATUSES } },
    include: {
      assignments: {
        where: { rowStatus: 'Effective' },
        include: { position: { include: { orgUnit: true } } },
        take: 1,
        orderBy: { effectiveFrom: 'desc' },
      },
    },
  });

  const counts = new Map<string, number>();
  for (const e of employments) {
    const assignment = e.assignments[0];
    const key = dimension === 'division' ? assignment?.position.orgUnit.division ?? 'shared' : assignment?.position.location ?? 'Unassigned';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, headcount]) => ({ key, headcount })).sort((a, b) => b.headcount - a.headcount);
}

// ---------------------------------------------------------------------------
// Absenteeism and overtime
// ---------------------------------------------------------------------------

export interface AbsenteeismResult {
  ratePct: number | null;
  zeroMinuteDays: number;
  totalDays: number;
}

/** Share of recorded WorkAttendance rows with zero worked minutes, over the trailing `months` months. */
export async function absenteeism(months = 3): Promise<AbsenteeismResult> {
  const auth = currentAuth();
  await assertAnalyticsView();

  const keys = trailingMonths(months);
  const start = monthStart(keys[0]);
  const end = monthEnd(keys[keys.length - 1]);

  const [totalDays, zeroMinuteDays] = await Promise.all([
    prisma.workAttendance.count({ where: { tenantId: auth.tenantId, workDate: { gte: start, lt: end } } }),
    prisma.workAttendance.count({ where: { tenantId: auth.tenantId, workDate: { gte: start, lt: end }, workedMinutes: 0 } }),
  ]);

  return { ratePct: absenteeismRate(zeroMinuteDays, totalDays), zeroMinuteDays, totalDays };
}

export interface OvertimeResult {
  totalHours: number;
  totalAmount: number | null;
  byMonth: Array<{ month: string; hours: number }>;
}

/** Overtime hours from the compliance workstream's weekly accrual rows, trailing `months` months. */
export async function overtimeHours(months = 3): Promise<OvertimeResult> {
  const auth = currentAuth();
  await assertAnalyticsView();
  const money = await canSeeMoney('compensation');

  const keys = trailingMonths(months);
  const start = monthStart(keys[0]);
  const end = monthEnd(keys[keys.length - 1]);
  const rows = await prisma.overtimeAccrual.findMany({
    where: { tenantId: auth.tenantId, computedAt: { gte: start, lt: end } },
    select: { isoWeek: true, hours: true, amount: true, computedAt: true },
  });
  // isoWeek doesn't sort cleanly against a calendar month key, so the month
  // bucket is drawn from computedAt (when the accrual was posted) instead.
  const relevant = rows;

  const byMonthMap = new Map<string, number>();
  for (const key of keys) byMonthMap.set(key, 0);
  let totalHours = 0;
  let totalAmount = 0;
  for (const r of relevant) {
    const k = monthKey(r.computedAt);
    const h = num(r.hours) ?? 0;
    byMonthMap.set(k, (byMonthMap.get(k) ?? 0) + h);
    totalHours += h;
    totalAmount += num(r.amount) ?? 0;
  }

  return {
    totalHours,
    totalAmount: money ? totalAmount : null,
    byMonth: keys.map((month) => ({ month, hours: byMonthMap.get(month) ?? 0 })),
  };
}

// ---------------------------------------------------------------------------
// Leave liability (money withheld as null without the compensation grant)
// ---------------------------------------------------------------------------

export interface LeaveLiabilityResult {
  totalDays: number;
  totalAmount: number | null;
  byLeaveType: Array<{ leaveType: string; days: number; amount: number | null }>;
}

/** Outstanding leave balance × basic/26 daily rate, summed across every open balance. */
export async function leaveLiability(): Promise<LeaveLiabilityResult> {
  const auth = currentAuth();
  await assertAnalyticsView();
  const money = await canSeeMoney('compensation');

  const balances = await prisma.leaveBalance.findMany({
    where: { tenantId: auth.tenantId, balanceDays: { gt: 0 } },
    include: { leaveType: true },
  });

  const dailyRateByEmployment = new Map<string, number>();
  if (money && balances.length > 0) {
    const employmentIds = [...new Set(balances.map((b) => b.employmentRelationshipId))];
    const comp = await prisma.compensationRecord.findMany({
      where: { tenantId: auth.tenantId, employmentRelationshipId: { in: employmentIds }, status: 'Effective' },
      orderBy: { effectiveFrom: 'desc' },
      select: { employmentRelationshipId: true, basicPay: true, amount: true },
    });
    for (const c of comp) {
      if (dailyRateByEmployment.has(c.employmentRelationshipId)) continue;
      dailyRateByEmployment.set(c.employmentRelationshipId, dailyRateFromBasic(num(c.basicPay) ?? num(c.amount) ?? 0));
    }
  }

  const byType = new Map<string, { days: number; amount: number }>();
  let totalDays = 0;
  let totalAmount = 0;
  for (const b of balances) {
    const days = num(b.balanceDays) ?? 0;
    totalDays += days;
    const rate = money ? dailyRateByEmployment.get(b.employmentRelationshipId) ?? 0 : 0;
    const amount = days * rate;
    if (money) totalAmount += amount;
    const row = byType.get(b.leaveType.name) ?? { days: 0, amount: 0 };
    row.days += days;
    row.amount += amount;
    byType.set(b.leaveType.name, row);
  }

  return {
    totalDays,
    totalAmount: money ? totalAmount : null,
    byLeaveType: [...byType.entries()].map(([leaveType, v]) => ({ leaveType, days: v.days, amount: money ? v.amount : null })),
  };
}

// ---------------------------------------------------------------------------
// Hiring: time-to-hire, offer acceptance
// ---------------------------------------------------------------------------

export interface HiringSummary {
  timeToHireDaysAvg: number | null;
  offerAcceptanceRatePct: number | null;
  offersExtended: number;
  offersAccepted: number;
  hires: number;
}

const OFFER_STAGE_OR_BEYOND = ['OfferExtended', 'OfferAccepted', 'Joined', 'OfferDeclined', 'OfferRescinded', 'NoShow'];
const ACCEPTED_STATUSES = ['OfferAccepted', 'Joined', 'NoShow'];

/** Offer-acceptance rate (by current application status) and average requisition-to-hire lead time. */
export async function hiringSummary(months = 12): Promise<HiringSummary> {
  const auth = currentAuth();
  await assertAnalyticsView();

  const keys = trailingMonths(months);
  const start = monthStart(keys[0]);

  const applications = await prisma.application.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, createdAt: { gte: start } },
    select: { status: true, candidatePartyId: true, requisitionId: true, requisition: { select: { createdAt: true, positionId: true } } },
  });

  const offersExtended = applications.filter((a) => OFFER_STAGE_OR_BEYOND.includes(a.status)).length;
  const offersAccepted = applications.filter((a) => ACCEPTED_STATUSES.includes(a.status)).length;
  const joined = applications.filter((a) => a.status === 'Joined');

  const pairs: Array<{ requisitionCreatedAt: Date; hireEffectiveDate: Date }> = [];
  for (const app of joined) {
    const employment = await prisma.employmentRelationship.findFirst({
      where: {
        tenantId: auth.tenantId,
        personId: app.candidatePartyId,
        assignments: { some: { positionId: app.requisition.positionId } },
      },
      select: { hireEffectiveDate: true },
      orderBy: { hireEffectiveDate: 'desc' },
    });
    if (employment) pairs.push({ requisitionCreatedAt: app.requisition.createdAt, hireEffectiveDate: employment.hireEffectiveDate });
  }

  return {
    timeToHireDaysAvg: averageTimeToHireDays(pairs),
    offerAcceptanceRatePct: hiringOfferAcceptanceRate(offersAccepted, offersExtended),
    offersExtended,
    offersAccepted,
    hires: joined.length,
  };
}

/** No recruiting-cost ledger is wired to this workstream — an honest "not measured", not a guessed number. */
export async function costPerHire(): Promise<Metric<number>> {
  await assertAnalyticsView();
  return notMeasured('No recruiting cost data (agency fees, advertising spend) is recorded anywhere this workstream can read.');
}

// ---------------------------------------------------------------------------
// Span of control
// ---------------------------------------------------------------------------

/** Direct-report count per manager position, from currently-effective assignments. */
export async function spanOfControl(): Promise<Metric<ReturnType<typeof spanOfControlStats>>> {
  const auth = currentAuth();
  await assertAnalyticsView();

  const rows = await prisma.assignment.groupBy({
    by: ['managerPositionId'],
    where: { tenantId: auth.tenantId, rowStatus: 'Effective', managerPositionId: { not: null } },
    _count: { _all: true },
  });
  const counts = rows.map((r) => r._count._all);
  const stats = spanOfControlStats(counts);
  return stats ? measured(stats) : notMeasured('No effective assignment carries a manager position yet.');
}

// ---------------------------------------------------------------------------
// Payroll cost trend (delegates to the payroll workstream's own money-masked query)
// ---------------------------------------------------------------------------

export async function payrollCostTrend(months = 12) {
  await assertAnalyticsView();
  // payrollTrend() itself asserts payroll:view@all and masks money on its own
  // terms; a caller with hr_analytics but not payroll simply gets that denial
  // surfaced rather than a second, looser copy of the same figure.
  return payrollTrend(months);
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export interface TrainingSummary {
  completionsPerHead: Metric<number>;
  averageHoursPerHead: Metric<number>;
}

/** `LearningActivity` carries no duration field, so hours-per-head is structurally not measured; completions-per-head is. */
export async function trainingSummary(months = 12): Promise<TrainingSummary> {
  const auth = currentAuth();
  await assertAnalyticsView();

  const keys = trailingMonths(months);
  const start = monthStart(keys[0]);

  const [completions, headcount] = await Promise.all([
    prisma.learningRecord.count({ where: { tenantId: auth.tenantId, status: 'Completed', completedAt: { gte: start } } }),
    prisma.employmentRelationship.count({ where: { tenantId: auth.tenantId, deletedAt: null, status: { in: EMPLOYED_STATUSES } } }),
  ]);

  return {
    completionsPerHead: headcount > 0 ? measured(completions / headcount) : notMeasured('No one is currently employed to divide by.'),
    averageHoursPerHead: notMeasured('LearningActivity records no duration field in this schema — only completion, not hours.'),
  };
}

// ---------------------------------------------------------------------------
// Metrics this schema cannot answer, or that depend on a workstream that may
// not have landed yet
// ---------------------------------------------------------------------------

/** Person carries no gender field anywhere in this schema. */
export async function genderRatio(): Promise<Metric<Record<string, number>>> {
  await assertAnalyticsView();
  return notMeasured('Person carries no gender field in this schema.');
}

/**
 * WS1's `Grade` (an employment's actual org-level rung, via `GradeAssignment`)
 * and WS7's `PayGrade` (the money side) are deliberately unlinked tables —
 * neither carries a foreign key to the other. The only field they share is
 * `level`, so that is the bridge: an employment's current grade level is read
 * from `GradeAssignment` → `Grade.level`, matched to whichever `PayGrade`
 * sits at that same level for this tenant. A level that more than one
 * `PayGrade` claims cannot be resolved this way and is dropped rather than
 * guessed at. `null` (not `[]`) on any table this bridge needs being absent.
 */
async function currentGradeLevelByEmployment(tenantId: string): Promise<Map<string, number> | null> {
  const gradeAssignments = await readOptionalModel(
    'gradeAssignment',
    (model) => model.findMany({ where: { tenantId, effectiveTo: null } }) as Promise<Array<{ employmentRelationshipId: string; gradeId: string }>>,
  );
  if (gradeAssignments === null) return null;
  if (gradeAssignments.length === 0) return new Map();

  const grades = await readOptionalModel(
    'grade',
    (model) => model.findMany({ where: { tenantId, id: { in: [...new Set(gradeAssignments.map((g) => g.gradeId))] } } }) as Promise<Array<{ id: string; level: number }>>,
  );
  if (grades === null) return null;

  const levelByGradeId = new Map(grades.map((g) => [g.id, g.level]));
  const out = new Map<string, number>();
  for (const ga of gradeAssignments) {
    const level = levelByGradeId.get(ga.gradeId);
    if (level !== undefined) out.set(ga.employmentRelationshipId, level);
  }
  return out;
}

/**
 * Compa-ratio (current CTC ÷ grade midpoint), bucketed across everyone whose
 * current grade resolves to exactly one `PayGrade` at that level. Withheld
 * without `compensation:financial` — a compa-ratio is a money figure by
 * another name, and this dashboard is not a back door around that grant.
 */
export async function compRatioDistribution(): Promise<Metric<Array<{ bucket: string; count: number }>>> {
  const auth = currentAuth();
  await assertAnalyticsView();
  const money = await canSeeMoney('compensation');
  if (!money) {
    return notMeasured('Compa-ratio compares pay against a grade midpoint — withheld without the compensation:financial grant.');
  }

  const payGrades = await readOptionalModel(
    'payGrade',
    (model) => model.findMany({ where: { tenantId: auth.tenantId } }) as Promise<Array<{ id: string; level: number; midPay: Prisma.Decimal | number }>>,
  );
  if (payGrades === null) {
    return notMeasured('No pay-grade table is available yet (compensation workstream) to compute a compa-ratio against.');
  }
  if (payGrades.length === 0) {
    return notMeasured('No pay grades have been defined yet.');
  }

  const midPayByLevel = new Map<number, number>();
  const ambiguousLevels = new Set<number>();
  for (const pg of payGrades) {
    if (midPayByLevel.has(pg.level)) ambiguousLevels.add(pg.level);
    else midPayByLevel.set(pg.level, num(pg.midPay) ?? 0);
  }
  for (const level of ambiguousLevels) midPayByLevel.delete(level);

  const levelByEmployment = await currentGradeLevelByEmployment(auth.tenantId);
  if (levelByEmployment === null) {
    return notMeasured("No grade-assignment table is available yet (workforce workstream) to know each employee's grade.");
  }
  if (levelByEmployment.size === 0) {
    return notMeasured('No employee carries a current grade assignment yet.');
  }

  const employmentIds = [...levelByEmployment.keys()];
  const comp = await prisma.compensationRecord.findMany({
    where: { tenantId: auth.tenantId, employmentRelationshipId: { in: employmentIds }, status: 'Effective' },
    orderBy: { effectiveFrom: 'desc' },
    select: { employmentRelationshipId: true, amount: true },
  });
  const ctcByEmployment = new Map<string, number>();
  for (const c of comp) {
    if (ctcByEmployment.has(c.employmentRelationshipId)) continue;
    ctcByEmployment.set(c.employmentRelationshipId, num(c.amount) ?? 0);
  }

  const ratios: number[] = [];
  for (const [employmentId, level] of levelByEmployment) {
    const ctc = ctcByEmployment.get(employmentId);
    const midPay = midPayByLevel.get(level);
    if (ctc === undefined || midPay === undefined) continue;
    const ratio = compaRatio(ctc, midPay);
    if (ratio !== null) ratios.push(ratio);
  }

  if (ratios.length === 0) {
    return notMeasured("No employee both has a current compensation record and a grade level that matches exactly one pay grade.");
  }
  return measured(distributionList(ratios, COMP_RATIO_BUCKETS, compRatioBucket));
}

/**
 * eNPS across every `enps`-type question answered in any pulse survey this
 * tenant has run, using the shared platform's standard NPS math
 * (`computeEnps`). Not money, so no `financial` verb applies here.
 */
export async function engagementEnps(): Promise<Metric<number>> {
  const auth = currentAuth();
  await assertAnalyticsView();

  const surveys = await readOptionalModel(
    'pulseSurvey',
    (model) =>
      model.findMany({
        where: { tenantId: auth.tenantId },
        select: { id: true, questions: true },
      }) as Promise<Array<{ id: string; questions: unknown }>>,
  );
  if (surveys === null) {
    return notMeasured('No survey table is available yet (engagement workstream) to compute eNPS from.');
  }
  if (surveys.length === 0) {
    return notMeasured('No pulse surveys have been run yet.');
  }

  const enpsQuestionIdsBySurvey = new Map<string, Set<string>>();
  for (const s of surveys) {
    const questions = Array.isArray(s.questions) ? (s.questions as Array<{ id?: unknown; type?: unknown }>) : [];
    const ids = new Set(questions.filter((q) => q.type === 'enps' && typeof q.id === 'string').map((q) => q.id as string));
    if (ids.size > 0) enpsQuestionIdsBySurvey.set(s.id, ids);
  }
  if (enpsQuestionIdsBySurvey.size === 0) {
    return notMeasured('No survey question of type "enps" has been authored yet.');
  }

  const responses = await readOptionalModel(
    'surveyResponse',
    (model) =>
      model.findMany({
        where: { tenantId: auth.tenantId, surveyId: { in: [...enpsQuestionIdsBySurvey.keys()] } },
        select: { surveyId: true, answers: true },
      }) as Promise<Array<{ surveyId: string; answers: unknown }>>,
  );
  if (responses === null) {
    return notMeasured('No survey-response table is available yet (engagement workstream) to compute eNPS from.');
  }

  const scores: number[] = [];
  for (const r of responses) {
    const ids = enpsQuestionIdsBySurvey.get(r.surveyId);
    if (!ids) continue;
    const answers = Array.isArray(r.answers) ? (r.answers as Array<{ questionId?: unknown; value?: unknown }>) : [];
    for (const a of answers) {
      if (typeof a.questionId === 'string' && ids.has(a.questionId)) {
        const n = Number(a.value);
        if (!Number.isNaN(n)) scores.push(n);
      }
    }
  }

  if (scores.length === 0) {
    return notMeasured('No response has answered an eNPS question yet.');
  }
  const { score } = computeEnps(scores);
  // `computeEnps` itself withholds `score` (as `null`) below its k-anonymity
  // floor, the same discipline `commandCenter.ts` uses for unit capacity —
  // not enough of a distinct reason from "no responses" to warrant a second
  // message, since either way the honest state is "not enough to report".
  return score === null ? notMeasured('Too few eNPS responses recorded yet to report a score without exposing individuals.') : measured(score);
}

/**
 * Open (non-terminal) `HrCase` rows bucketed by how close they are to
 * breaching their SLA — a confidential/grievance case is excluded from this
 * aggregate the same way it is excluded from the general case queue in
 * `domains/hcm/engagement.ts`, so a headline count never hints at how many
 * grievances are open.
 */
export async function openCasesBySla(): Promise<Metric<Array<{ bucket: string; count: number }>>> {
  const auth = currentAuth();
  await assertAnalyticsView();

  const cases = await readOptionalModel(
    'hrCase',
    (model) =>
      model.findMany({
        where: { tenantId: auth.tenantId, confidential: false, status: { notIn: ['resolved', 'closed'] } },
        select: { status: true, slaDueAt: true },
      }) as Promise<Array<{ status: string; slaDueAt: Date }>>,
  );
  if (cases === null) {
    return notMeasured('No HR case table is available yet (engagement workstream) to report SLA status from.');
  }
  if (cases.length === 0) {
    return notMeasured('No open, non-confidential HR case is on record right now.');
  }

  const now = new Date();
  const days = cases.map((c) => daysToSlaDue(c.slaDueAt, now));
  return measured(distributionList(days, SLA_BUCKETS, slaBucket));
}

// ---------------------------------------------------------------------------
// The dashboard — one call for the whole page
// ---------------------------------------------------------------------------

export async function dashboard(months = 12) {
  await assertAnalyticsView();
  const [
    headcount, byDivision, byLocation, attrition, tenure, absenteeismResult, overtime,
    liability, hiring, cost, span, payroll, training, gender, comp, enps, cases,
  ] = await Promise.all([
    headcountTrend(months),
    headcountBy('division'),
    headcountBy('location'),
    attritionSummary(months),
    tenureDistribution(),
    absenteeism(Math.min(months, 3)),
    overtimeHours(Math.min(months, 3)),
    leaveLiability(),
    hiringSummary(months),
    costPerHire(),
    spanOfControl(),
    payrollCostTrend(months).catch(() => null),
    trainingSummary(months),
    genderRatio(),
    compRatioDistribution(),
    engagementEnps(),
    openCasesBySla(),
  ]);

  return {
    headcount, byDivision, byLocation, attrition, tenure, absenteeism: absenteeismResult, overtime,
    leaveLiability: liability, hiring, costPerHire: cost, spanOfControl: span, payroll, training,
    genderRatio: gender, compRatioDistribution: comp, engagementEnps: enps, openCasesBySla: cases,
  };
}

// ---------------------------------------------------------------------------
// CSV exports (HCM-ANALYTICS reports)
// ---------------------------------------------------------------------------

/**
 * Every report here is a tenant-wide register, never one employee's own
 * record — same discipline as `assertAnalyticsView`: an export needs the
 * `all`-scope grant, not merely the verb, so a resource that ever picked up
 * an `own`-scope `hr_reports:export` row (none does today — see grants.ts)
 * could not use it to pull a colleague's data through this door.
 */
async function assertReportExport(): Promise<void> {
  await assertScopeAll('hr_reports', 'export');
}

export interface CsvExport {
  filename: string;
  csv: string;
}

export async function exportHeadcountRegister(): Promise<CsvExport> {
  const auth = currentAuth();
  await assertReportExport();

  const rows = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, status: { in: EMPLOYED_STATUSES } },
    include: {
      person: true,
      assignments: { where: { rowStatus: 'Effective' }, include: { position: { include: { orgUnit: true, job: true } } }, take: 1, orderBy: { effectiveFrom: 'desc' } },
    },
    orderBy: { hireEffectiveDate: 'asc' },
  });
  const csv = toCsv(
    ['Record code', 'Name', 'Status', 'Hire date', 'Division', 'Location', 'Job title'],
    rows.map((r) => [
      r.recordCode,
      r.person.fullName,
      r.status,
      r.hireEffectiveDate.toISOString().slice(0, 10),
      r.assignments[0]?.position.orgUnit.division ?? 'shared',
      r.assignments[0]?.position.location ?? '',
      r.assignments[0]?.position.job.title ?? '',
    ]),
  );
  await auditExport('employment_relationship', 'analytics:headcount_register', rows.length);
  return { filename: 'Headcount register.csv', csv };
}

export async function exportAttritionReport(months = 12): Promise<CsvExport> {
  const auth = currentAuth();
  await assertReportExport();

  const keys = trailingMonths(months);
  const start = monthStart(keys[0]);
  const end = monthEnd(keys[keys.length - 1]);
  const rows = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, deletedAt: null, separationDate: { gte: start, lt: end } },
    include: { person: true },
    orderBy: { separationDate: 'asc' },
  });
  const csv = toCsv(
    ['Record code', 'Name', 'Hire date', 'Separation date', 'Separation type', 'Early attrition', 'Tenure (days)'],
    rows.map((r) => {
      const sep = r.separationDate as Date;
      const early = isEarlyAttrition(r.hireEffectiveDate, sep);
      const tenureDays = Math.round((sep.getTime() - r.hireEffectiveDate.getTime()) / 86_400_000);
      return [r.recordCode, r.person.fullName, r.hireEffectiveDate.toISOString().slice(0, 10), sep.toISOString().slice(0, 10), r.separationType ?? '', early ? 'yes' : 'no', tenureDays];
    }),
  );
  await auditExport('employment_relationship', `analytics:attrition_report:${keys[0]}..${keys[keys.length - 1]}`, rows.length);
  return { filename: `Attrition report ${keys[0]} to ${keys[keys.length - 1]}.csv`, csv };
}

export async function exportLeaveLiabilityReport(): Promise<CsvExport> {
  const auth = currentAuth();
  await assertReportExport();
  const money = await canSeeMoney('compensation');

  const balances = await prisma.leaveBalance.findMany({
    where: { tenantId: auth.tenantId, balanceDays: { gt: 0 } },
    include: { leaveType: true, employmentRelationship: { include: { person: true } } },
    orderBy: { balanceDays: 'desc' },
  });

  const dailyRateByEmployment = new Map<string, number>();
  if (money && balances.length > 0) {
    const employmentIds = [...new Set(balances.map((b) => b.employmentRelationshipId))];
    const comp = await prisma.compensationRecord.findMany({
      where: { tenantId: auth.tenantId, employmentRelationshipId: { in: employmentIds }, status: 'Effective' },
      orderBy: { effectiveFrom: 'desc' },
      select: { employmentRelationshipId: true, basicPay: true, amount: true },
    });
    for (const c of comp) {
      if (dailyRateByEmployment.has(c.employmentRelationshipId)) continue;
      dailyRateByEmployment.set(c.employmentRelationshipId, dailyRateFromBasic(num(c.basicPay) ?? num(c.amount) ?? 0));
    }
  }

  const csv = toCsv(
    ['Employee', 'Leave type', 'Balance days', 'Estimated liability'],
    balances.map((b) => {
      const days = num(b.balanceDays) ?? 0;
      const amount = money ? days * (dailyRateByEmployment.get(b.employmentRelationshipId) ?? 0) : null;
      return [b.employmentRelationship.person.fullName, b.leaveType.name, days, amount === null ? 'withheld' : amount.toFixed(2)];
    }),
  );
  await auditExport('leave_balance', 'analytics:leave_liability', balances.length);
  return { filename: 'Leave liability.csv', csv };
}

export async function exportOvertimeRegister(months = 3): Promise<CsvExport> {
  const auth = currentAuth();
  await assertReportExport();
  const money = await canSeeMoney('compensation');

  const keys = trailingMonths(months);
  const start = monthStart(keys[0]);
  const end = monthEnd(keys[keys.length - 1]);
  // OvertimeAccrual (compliance-labour.prisma) carries only the bare
  // employmentRelationshipId scalar, no Prisma relation field — so the
  // employee's name is joined by hand rather than through `include`.
  const rows = await prisma.overtimeAccrual.findMany({
    where: { tenantId: auth.tenantId, computedAt: { gte: start, lt: end } },
    orderBy: [{ employmentRelationshipId: 'asc' }, { isoWeek: 'asc' }],
  });
  const employments = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, id: { in: [...new Set(rows.map((r) => r.employmentRelationshipId))] } },
    include: { person: true },
  });
  const nameByEmployment = new Map(employments.map((e) => [e.id, e.person.fullName]));
  const csv = toCsv(
    ['Employee', 'ISO week', 'Hours', 'Amount'],
    rows.map((r) => [nameByEmployment.get(r.employmentRelationshipId) ?? r.employmentRelationshipId, r.isoWeek, num(r.hours), money ? num(r.amount) : 'withheld']),
  );
  await auditExport('overtime_accrual', `analytics:overtime_register:${keys[0]}..${keys[keys.length - 1]}`, rows.length);
  return { filename: `Overtime register ${keys[0]} to ${keys[keys.length - 1]}.csv`, csv };
}

export async function exportTrainingRegister(months = 12): Promise<CsvExport> {
  const auth = currentAuth();
  await assertReportExport();

  const keys = trailingMonths(months);
  const start = monthStart(keys[0]);
  const rows = await prisma.learningRecord.findMany({
    where: { tenantId: auth.tenantId, createdAt: { gte: start } },
    include: { employmentRelationship: { include: { person: true } }, learningActivity: true },
    orderBy: { createdAt: 'asc' },
  });
  const csv = toCsv(
    ['Employee', 'Activity', 'Status', 'Enrolled', 'Completed', 'Compliance training'],
    rows.map((r) => [
      r.employmentRelationship.person.fullName,
      r.learningActivity.title,
      r.status,
      r.createdAt.toISOString().slice(0, 10),
      r.completedAt ? r.completedAt.toISOString().slice(0, 10) : '',
      r.learningActivity.isCompliance ? 'yes' : 'no',
    ]),
  );
  await auditExport('learning_record', `analytics:training_register:${keys[0]}..`, rows.length);
  return { filename: 'Training register.csv', csv };
}
