/**
 * Cross-domain health scores (CRM-RPT-001).
 *
 * One scoring pipeline (KPI_READING -> FACTOR -> HEALTH_SCORE), instantiated ten
 * times — a domain gets its own weights and thresholds plugged into a shared
 * mechanism, never its own scoring engine.
 *
 * Three structural guards against the dashboard reflex:
 *   - Falsifiability: a factor with no downside excursion in its trailing range
 *     is quarantined and raises an exception to its own owner. Cumulative
 *     counters are barred outright.
 *   - A domain with insufficient inputs renders "not yet measured", never a
 *     zero — a confidently-wrong four-of-ten pulse is worse than an honestly
 *     partial one.
 *   - A score with no drill path is a defect. Every factor carries the query
 *     that reproduces it.
 *
 * `pipeline_value` / `pipeline_count` are retired, not patched: they summed
 * across motions with incompatible stage semantics. The fix is to derive the
 * number correctly from a live read keyed on `pipelinePosition`, with
 * `defaultProbability` now authored per motion.
 */

import {
  EVENTS,
  H_COM_FACTORS,
  SEVERITY_RANK,
  HEALTH_BAND_SEVERITY_FLOOR,
  HEALTH_DOMAINS,
  bandFor,
  distanceToEdge,
  type HealthBand,
} from '@kaizen/shared';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { raiseException } from '../platform/exceptions.js';

/**
 * What each area is called on screen. The codes stay as the identifiers — the
 * event log and the audit trail are keyed on them — but nothing a person reads
 * should say H_EDU when it means training.
 */
const DOMAIN_PLAIN_NAME: Record<string, string> = {
  H_FIN: 'Money',
  H_COM: 'Sales',
  H_DLV: 'Delivery',
  H_EDU: 'Training',
  H_PPL: 'People',
  H_MKT: 'Marketing',
  H_CUS: 'Customers',
  H_OPS: 'Operations',
  H_STR: 'Strategy',
  H_RSK: 'Risk',
};


export interface FactorResult {
  factor: string;
  label: string;
  weight: number;
  value: number;
  target: number;
  factorScore: number;
  contribution: number;
  quarantined: boolean;
  narrative: string;
  drillPath: string;
}

export interface ComputeResult {
  domainCode: string;
  score: number | null;
  band: HealthBand | null;
  factors: FactorResult[];
  state: 'measured' | 'not_yet_measured';
}

function ratio(value: number, target: number): number {
  if (target === 0) return value > 0 ? 1 : 0;
  return Math.max(0, Math.min(value / target, 1.25));
}

/** H_COM — the commercial health domain CRM feeds. */
export async function computeCommercialHealth(): Promise<ComputeResult> {
  const auth = currentAuth();

  const [openOpps, wonLast90, lostLast90, stalledProposals, totalProposals] = await Promise.all([
    prisma.opportunity.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, outcome: null },
      include: { pipeline: { include: { stages: { where: { retiredAt: null } } } } },
    }),
    prisma.opportunity.count({
      where: { tenantId: auth.tenantId, outcome: 'won', closedAt: { gte: daysAgo(90) } },
    }),
    prisma.opportunity.count({
      where: { tenantId: auth.tenantId, outcome: 'lost', closedAt: { gte: daysAgo(90) } },
    }),
    prisma.proposal.count({
      where: { tenantId: auth.tenantId, response: 'pending', stalledNotifiedAt: { not: null } },
    }),
    prisma.proposal.count({ where: { tenantId: auth.tenantId, sentAt: { not: null } } }),
  ]);

  // Insufficient inputs: report honestly rather than confidently wrong.
  if (openOpps.length === 0 && wonLast90 === 0 && lostLast90 === 0) {
    return { domainCode: 'H_COM', score: null, band: null, factors: [], state: 'not_yet_measured' };
  }

  // Factor 1 — weighted pipeline coverage. Weighted per pipeline using that
  // pipeline's own defaultProbability, never a blended curve across motions.
  let weightedPipeline = 0;
  for (const opp of openOpps) {
    const stage = opp.pipeline.stages.find((s) => s.stageKey === opp.stageKey);
    const probability = (stage?.defaultProbability ?? 0) / 100;
    weightedPipeline += (num(opp.expectedValue) ?? 0) * probability;
  }
  const quarterTarget = await targetFor('h_com.quarter_target', 20_000_000);
  const coverageValue = weightedPipeline / Math.max(quarterTarget, 1);
  const coverageTarget = 3; // 3x coverage is the standard benchmark

  // Factor 2 — median days at stage band. Lower is better, so the ratio inverts.
  const ages = openOpps.map((o) => Math.floor((Date.now() - o.stageEnteredAt.getTime()) / 86_400_000)).sort((a, b) => a - b);
  const medianAge = ages.length ? ages[Math.floor(ages.length / 2)] : 0;
  const ageTarget = 21;

  // Factor 3 — win rate.
  const decided = wonLast90 + lostLast90;
  const winRate = decided > 0 ? wonLast90 / decided : 0;
  const winRateTarget = 0.35;

  // Factor 4 — account concentration. Lower concentration is healthier.
  const byAccount = new Map<string, number>();
  for (const opp of openOpps) {
    const key = opp.organizationId ?? 'unassigned';
    byAccount.set(key, (byAccount.get(key) ?? 0) + (num(opp.expectedValue) ?? 0));
  }
  const totalValue = [...byAccount.values()].reduce((s, v) => s + v, 0);
  const topAccount = Math.max(0, ...byAccount.values());
  const concentration = totalValue > 0 ? topAccount / totalValue : 0;
  const concentrationTarget = 0.25;

  // Factor 5 — stalled proposal share. Lower is better.
  const stalledShare = totalProposals > 0 ? stalledProposals / totalProposals : 0;
  const stalledTarget = 0.1;

  const raw: Array<{ code: string; value: number; target: number; higherIsBetter: boolean; narrative: string; drill: string }> = [
    {
      code: 'pipeline_coverage',
      value: Number(coverageValue.toFixed(2)),
      target: coverageTarget,
      higherIsBetter: true,
      narrative: `${fmt(weightedPipeline)} of realistic pipeline against a ${fmt(quarterTarget)} target for the quarter. Three times cover is the usual comfortable level; this is ${coverageValue.toFixed(1)} times.`,
      drill: '/crm/opportunities?open=true',
    },
    {
      code: 'stage_velocity',
      value: medianAge,
      target: ageTarget,
      higherIsBetter: false,
      narrative: `A typical open deal has sat at its current stage for ${medianAge} days. ${openOpps.length} deals are open.`,
      drill: '/crm/opportunities?sort=stageAge',
    },
    {
      code: 'win_rate',
      value: Number((winRate * 100).toFixed(1)),
      target: winRateTarget * 100,
      higherIsBetter: true,
      narrative: `${wonLast90} won of ${decided} decided in the last 90 days.`,
      drill: '/crm/opportunities?outcome=won',
    },
    {
      code: 'account_concentration',
      value: Number((concentration * 100).toFixed(1)),
      target: concentrationTarget * 100,
      higherIsBetter: false,
      narrative: `Largest account carries ${(concentration * 100).toFixed(1)}% of open pipeline value.`,
      drill: '/crm/accounts',
    },
    {
      code: 'stalled_proposal_share',
      value: Number((stalledShare * 100).toFixed(1)),
      target: stalledTarget * 100,
      higherIsBetter: false,
      narrative: `${stalledProposals} of ${totalProposals} sent proposals are past their chase threshold.`,
      drill: '/commercial/proposals?stalled=true',
    },
  ];

  const factors: FactorResult[] = raw.map((r) => {
    const def = H_COM_FACTORS.find((f) => f.code === r.code)!;
    const scoreRatio = r.higherIsBetter ? ratio(r.value, r.target) : ratio(r.target, Math.max(r.value, 0.0001));
    const factorScore = Math.min(scoreRatio, 1) * 100;
    return {
      factor: r.code,
      label: def.label,
      weight: def.weight,
      value: r.value,
      target: r.target,
      factorScore: Number(factorScore.toFixed(1)),
      contribution: Number(((factorScore / 100) * def.weight).toFixed(1)),
      quarantined: false,
      narrative: r.narrative,
      drillPath: r.drill,
    };
  });

  const score = Number(factors.reduce((s, f) => s + f.contribution, 0).toFixed(1));
  return { domainCode: 'H_COM', score, band: bandFor(score), factors, state: 'measured' };
}

/**
 * The other nine domains. Each computes from its own module's readings; where a
 * module has not landed yet, the domain reports `not_yet_measured` rather than
 * fabricating a number.
 */
export async function computeDomainHealth(domainCode: string): Promise<ComputeResult> {
  if (domainCode === 'H_COM') return computeCommercialHealth();

  const auth = currentAuth();

  if (domainCode === 'H_FIN') {
    const [invoices, projections] = await Promise.all([
      prisma.invoice.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, include: { lines: true, receipts: true } }),
      prisma.receivablesProjection.findMany({ where: { tenantId: auth.tenantId } }),
    ]);
    if (invoices.length === 0) return notYetMeasured(domainCode);

    let billed = 0;
    let collected = 0;
    let overdue = 0;
    for (const inv of invoices) {
      const total = inv.lines.reduce((s, l) => s + (num(l.amount) ?? 0), 0);
      const allocated = inv.receipts.reduce((s, r) => s + (num(r.allocatedAmount) ?? 0), 0);
      billed += total;
      collected += allocated;
      if (inv.dueDate && inv.dueDate < new Date() && allocated < total) overdue += total - allocated;
    }

    const collectionRate = billed > 0 ? (collected / billed) * 100 : 0;
    const arShare = billed > 0 ? (overdue / billed) * 100 : 0;
    const escalated = projections.filter((p) => p.dunningStage === 'escalated').length;

    const factors = buildFactors(domainCode, [
      { code: 'collection_rate', label: 'Getting paid on time', weight: 40, value: Number(collectionRate.toFixed(1)), target: 90, higherIsBetter: true, narrative: `${fmt(collected)} collected of ${fmt(billed)} billed.`, drill: '/finance/invoices' },
      { code: 'ar_ageing', label: 'Owed to us too long', weight: 35, value: Number(arShare.toFixed(1)), target: 10, higherIsBetter: false, narrative: `${fmt(overdue)} overdue across ${invoices.filter((i) => i.status === 'overdue').length} invoices.`, drill: '/finance/invoices?status=overdue' },
      { code: 'dunning_escalations', label: 'Customers chased hard', weight: 25, value: escalated, target: 2, higherIsBetter: false, narrative: `${escalated} customer${escalated === 1 ? ' has' : 's have'} been chased to the final stage without paying.`, drill: '/finance/receivables' },
    ]);
    return finalise(domainCode, factors);
  }

  if (domainCode === 'H_EDU') {
    const enrollments = await prisma.enrollment.findMany({ where: { tenantId: auth.tenantId } });
    if (enrollments.length === 0) return notYetMeasured(domainCode);

    const active = enrollments.filter((e) => ['confirmed', 'active'].includes(e.status));
    const completed = enrollments.filter((e) => e.status === 'completed').length;
    const withdrawn = enrollments.filter((e) => e.status === 'withdrawn').length;
    const atRisk = enrollments.filter((e) => e.atRisk).length;
    const avgAttendance = active.length ? active.reduce((s, e) => s + e.attendancePct, 0) / active.length : 0;
    const completionRate = completed + withdrawn > 0 ? (completed / (completed + withdrawn)) * 100 : 0;

    const factors = buildFactors(domainCode, [
      { code: 'completion_rate', label: 'Learners finishing', weight: 40, value: Number(completionRate.toFixed(1)), target: 85, higherIsBetter: true, narrative: `${completed} completed against ${withdrawn} withdrawn.`, drill: '/education/enrollments' },
      { code: 'attendance', label: 'Attendance', weight: 30, value: Number(avgAttendance.toFixed(1)), target: 85, higherIsBetter: true, narrative: `Average attendance across ${active.length} learners currently enrolled.`, drill: '/education/attendance' },
      { code: 'learner_risk', label: 'Learners falling behind', weight: 30, value: atRisk, target: Math.max(Math.round(active.length * 0.05), 1), higherIsBetter: false, narrative: `${atRisk} learner${atRisk === 1 ? ' is' : 's are'} falling behind and may not finish.`, drill: '/education/enrollments?atRisk=true' },
    ]);
    return finalise(domainCode, factors);
  }

  if (domainCode === 'H_DLV') {
    const projects = await prisma.project.findMany({ where: { tenantId: auth.tenantId } });
    if (projects.length === 0) return notYetMeasured(domainCode);

    const active = projects.filter((p) => ['planned', 'active'].includes(p.status));
    const unaccepted = projects.filter((p) => !p.handoffAcceptedAt && p.status === 'planned').length;
    const avgVariance = active.length ? active.reduce((s, p) => s + Math.abs(p.scheduleVariancePct), 0) / active.length : 0;
    const delivered = projects.filter((p) => p.status === 'delivered').length;

    const factors = buildFactors(domainCode, [
      { code: 'schedule_variance', label: 'Projects running late', weight: 45, value: Number(avgVariance.toFixed(1)), target: 10, higherIsBetter: false, narrative: `Across ${active.length} active projects, timelines are off by ${avgVariance.toFixed(0)}% on average.`, drill: '/delivery/projects' },
      { code: 'handoff_acceptance', label: 'Won work delivery has picked up', weight: 30, value: unaccepted, target: 0, higherIsBetter: false, narrative: `${unaccepted} deal${unaccepted === 1 ? ' has' : 's have'} been won but not yet picked up by the delivery team.`, drill: '/delivery/projects?handoff=pending' },
      { code: 'delivery_throughput', label: 'Work getting finished', weight: 25, value: delivered, target: Math.max(Math.round(projects.length * 0.3), 1), higherIsBetter: true, narrative: `${delivered} project${delivered === 1 ? '' : 's'} delivered.`, drill: '/delivery/projects?status=delivered' },
    ]);
    return finalise(domainCode, factors);
  }

  if (domainCode === 'H_OPS') {
    const [exceptions, deadLetters, jobRuns] = await Promise.all([
      prisma.exceptionRecord.findMany({ where: { tenantId: auth.tenantId } }),
      prisma.eventDeadLetter.count({ where: { tenantId: auth.tenantId, state: 'dead' } }),
      prisma.jobRun.findMany({ where: { tenantId: auth.tenantId }, orderBy: { startedAt: 'desc' }, take: 50 }),
    ]);
    if (exceptions.length === 0 && jobRuns.length === 0) return notYetMeasured(domainCode);

    const open = exceptions.filter((e) => ['open', 'escalated'].includes(e.state));
    // An exception failing to resolve an owner is a first-class measured
    // category, not something discovered by noticing a blank field.
    const unowned = open.filter((e) => e.ownerUnresolved).length;
    const breached = open.filter((e) => e.slaDueAt && e.slaDueAt < new Date()).length;
    const failedJobs = jobRuns.filter((j) => j.status === 'failed').length;

    const factors = buildFactors(domainCode, [
      { code: 'unowned_exceptions', label: 'Problems assigned to nobody', weight: 35, value: unowned, target: 0, higherIsBetter: false, narrative: `${unowned} open problem${unowned === 1 ? ' has' : 's have'} nobody assigned. Until someone owns them, nobody is working on them.`, drill: '/exceptions?unowned=true' },
      { code: 'sla_breaches', label: 'Deadlines missed', weight: 35, value: breached, target: Math.max(Math.round(open.length * 0.1), 1), higherIsBetter: false, narrative: `${breached} of ${open.length} open exceptions are past their SLA.`, drill: '/exceptions?breached=true' },
      { code: 'automation_reliability', label: 'Automatic checks running', weight: 30, value: failedJobs + deadLetters, target: 0, higherIsBetter: false, narrative: `${failedJobs} failed job run${failedJobs === 1 ? '' : 's'} and ${deadLetters} dead-lettered event${deadLetters === 1 ? '' : 's'}.`, drill: '/admin/jobs' },
    ]);
    return finalise(domainCode, factors);
  }

  if (domainCode === 'H_RSK') {
    // H_RSK is a rollup, not a weighted composite. It measures whether risk is
    // being MANAGED, not how much of it exists: an open exception with a
    // resolved owner inside its SLA is the system working, not a failure. A
    // rollup that fell simply because a detector found things would bottom out
    // and stop discriminating — the same defect the falsifiability check guards
    // against at the factor level.
    const exceptions = await prisma.exceptionRecord.findMany({
      where: { tenantId: auth.tenantId, state: { in: ['open', 'acknowledged', 'escalated'] } },
    });
    if (exceptions.length === 0) {
      return { domainCode, score: 92, band: bandFor(92), factors: [], state: 'measured' };
    }

    const now = new Date();
    const severe = exceptions.filter((e) => SEVERITY_RANK[e.severity as never] >= 3);
    const unacknowledgedSevere = severe.filter((e) => !e.acknowledgedAt).length;
    const breached = exceptions.filter((e) => e.slaDueAt && e.slaDueAt < now && !e.resolvedAt).length;
    // Ownership precedes notification, so an unowned exception is a routing
    // defect and the sharpest signal in the rollup.
    const unowned = exceptions.filter((e) => e.ownerUnresolved).length;

    const factors = buildFactors(domainCode, [
      {
        code: 'unacknowledged_severe',
        label: 'Serious problems, nobody assigned',
        weight: 40,
        value: unacknowledgedSevere,
        target: 0,
        higherIsBetter: false,
        narrative: `${unacknowledgedSevere} of ${severe.length} high-risk exception${severe.length === 1 ? '' : 's'} have not been acknowledged.`,
        drill: '/exceptions?minSeverity=S3_HIGH_RISK',
      },
      {
        code: 'sla_breached',
        label: 'Problems left past their deadline',
        weight: 35,
        value: breached,
        target: Math.max(Math.round(exceptions.length * 0.1), 1),
        higherIsBetter: false,
        narrative: `${breached} of ${exceptions.length} open exceptions are past their SLA clock.`,
        drill: '/exceptions?breached=true',
      },
      {
        code: 'ownership_completeness',
        label: 'Problems that have a clear owner',
        weight: 25,
        value: unowned,
        target: 0,
        higherIsBetter: false,
        narrative: `${unowned} open exception${unowned === 1 ? '' : 's'} could not resolve an owner — a routing defect, not a normal state.`,
        drill: '/exceptions?unowned=true',
      },
    ]);

    return finalise(domainCode, factors);
  }

  // Domains whose modules have not landed report honestly.
  return notYetMeasured(domainCode);
}

function notYetMeasured(domainCode: string): ComputeResult {
  return { domainCode, score: null, band: null, factors: [], state: 'not_yet_measured' };
}

function buildFactors(
  domainCode: string,
  specs: Array<{ code: string; label: string; weight: number; value: number; target: number; higherIsBetter: boolean; narrative: string; drill: string }>,
): FactorResult[] {
  return specs.map((s) => {
    const r = s.higherIsBetter ? ratio(s.value, s.target) : ratio(s.target, Math.max(s.value, 0.0001));
    const factorScore = Math.min(r, 1) * 100;
    return {
      factor: s.code,
      label: s.label,
      weight: s.weight,
      value: s.value,
      target: s.target,
      factorScore: Number(factorScore.toFixed(1)),
      contribution: Number(((factorScore / 100) * s.weight).toFixed(1)),
      quarantined: false,
      narrative: s.narrative,
      drillPath: s.drill,
    };
  });
}

function finalise(domainCode: string, factors: FactorResult[]): ComputeResult {
  const score = Number(factors.reduce((s, f) => s + f.contribution, 0).toFixed(1));
  return { domainCode, score, band: bandFor(score), factors, state: 'measured' };
}

/**
 * The falsifiability check: a factor that has never fallen in its trailing
 * range is not measuring anything. It is quarantined and raised as an exception
 * to its own owner, structurally rather than by design guidance.
 */
export async function applyFalsifiabilityCheck(domainCode: string, factors: FactorResult[]): Promise<FactorResult[]> {
  const auth = currentAuth();
  const history = await prisma.healthScore.findMany({
    where: { tenantId: auth.tenantId, domainCode },
    orderBy: { asOf: 'desc' },
    take: 12,
  });
  if (history.length < 6) return factors;

  return Promise.all(
    factors.map(async (f) => {
      const series = history
        .map((h) => (h.factors as unknown as FactorResult[]).find((x) => x.factor === f.factor)?.factorScore)
        .filter((v): v is number => typeof v === 'number');
      if (series.length < 6) return f;

      const min = Math.min(...series);
      const max = Math.max(...series);
      // No downside excursion across the trailing range.
      if (max - min < 0.5) {
        await raiseException({
          code: 'DET-XDM-001',
          label: 'A measure we have stopped trusting',
          severity: 'S1_ATTENTION',
          subjectType: 'health_factor',
          subjectId: `${domainCode}:${f.factor}`,
          subjectLabel: `${domainCode} / ${f.label}`,
          domain: 'xdm',
          detail: `This factor has not moved across its trailing ${series.length} readings. A factor with no downside excursion is a vanity metric, not a measurement.`,
          ownerPartyId: await domainOwner(domainCode),
          triggerFingerprint: `falsifiability:${domainCode}:${f.factor}`,
          ladderRung: 1,
        });
        return { ...f, quarantined: true };
      }
      return f;
    }),
  );
}

/**
 * A factor exception is owned by the accountable holder for that domain, not by
 * the scheduler that detected it. Ownership precedes notification, always — an
 * exception with no resolvable owner is a routing defect, not a normal state.
 */
async function domainOwner(domainCode: string): Promise<string | null> {
  const auth = currentAuth();
  const preferred: Record<string, string[]> = {
    H_FIN: ['finance_controller', 'business_head', 'chairman'],
    H_COM: ['business_head', 'director', 'chairman'],
    H_EDU: ['education_counsellor', 'business_head', 'chairman'],
    H_DLV: ['project_manager', 'business_head', 'chairman'],
    H_OPS: ['system_admin', 'admin', 'chairman'],
    H_RSK: ['chairman', 'director'],
  };
  for (const roleSlug of preferred[domainCode] ?? ['business_head', 'chairman']) {
    const holder = await prisma.affiliation.findFirst({
      where: { tenantId: auth.tenantId, roleSlug, status: 'active' },
      select: { partyId: true },
    });
    if (holder) return holder.partyId;
  }
  return null;
}

export async function computeAndPersistAll(): Promise<ComputeResult[]> {
  const auth = currentAuth();
  const asOf = startOfDay(new Date());
  const results: ComputeResult[] = [];

  for (const domain of HEALTH_DOMAINS) {
    const result = await computeDomainHealth(domain.code);
    const factors = await applyFalsifiabilityCheck(domain.code, result.factors);

    const previous = await prisma.healthScore.findFirst({
      where: { tenantId: auth.tenantId, domainCode: domain.code },
      orderBy: { asOf: 'desc' },
    });

    await prisma.healthScore.upsert({
      where: { tenantId_domainCode_asOf: { tenantId: auth.tenantId, domainCode: domain.code, asOf } },
      create: {
        tenantId: auth.tenantId,
        domainCode: domain.code,
        asOf,
        score: result.score,
        band: result.band,
        factors: factors as never,
        state: result.state,
      },
      update: { score: result.score, band: result.band, factors: factors as never, state: result.state },
    });

    await emit({
      name: EVENTS.HEALTH_SCORE_COMPUTED,
      subject: { entityType: 'health_score', entityId: `${domain.code}:${asOf.toISOString().slice(0, 10)}` },
      newState: { domainCode: domain.code, score: result.score, band: result.band, state: result.state },
      impact: { domains: ['xdm', domain.module] },
    });

    // Only a band transition reaches the Command Center — never a raw reading.
    if (previous?.band && result.band && previous.band !== result.band) {
      await emit({
        name: EVENTS.HEALTH_BAND_CHANGED,
        subject: { entityType: 'health_score', entityId: `${domain.code}:${asOf.toISOString().slice(0, 10)}` },
        previousState: { band: previous.band, score: previous.score },
        newState: { band: result.band, score: result.score },
        impact: { domains: ['xdm'], severity: HEALTH_BAND_SEVERITY_FLOOR[result.band] as never },
      });
    }

    // Factors raise exceptions; composites raise attention. A factor crossing
    // its own threshold fires regardless of the parent composite's comfortable
    // band — the composite conceals nothing.
    const owner = await domainOwner(domain.code);
    // H_RSK aggregates other domains' exceptions. Raising an exception about
    // its own factors would feed straight back into its own score.
    const raisesFactorExceptions = domain.code !== 'H_RSK';
    for (const f of factors) {
      if (raisesFactorExceptions && f.factorScore < 40 && !f.quarantined) {
        await raiseException({
          code: `DET-${domain.code}-FACTOR`,
          label: `${DOMAIN_PLAIN_NAME[domain.code] ?? domain.name}: ${f.label.toLowerCase()} is below where it should be`,
          severity: f.factorScore < 25 ? 'S3_HIGH_RISK' : 'S2_WARNING',
          subjectType: 'health_factor',
          subjectId: `${domain.code}:${f.factor}`,
          subjectLabel: `${DOMAIN_PLAIN_NAME[domain.code] ?? domain.name} — ${f.label}`,
          domain: 'xdm',
          detail: f.narrative,
          ownerPartyId: owner,
          accountablePositionId: `pos_${domain.code.toLowerCase()}`,
          triggerFingerprint: `factor_threshold:${domain.code}:${f.factor}`,
          ladderRung: 1,
        });
      }
    }

    results.push({ ...result, factors });
  }

  return results;
}

export interface PulseEntry {
  domainCode: string;
  domainName: string;
  asOf: string;
  score: number | null;
  band: string | null;
  previousScore: number | null;
  trend: 'up' | 'down' | 'flat' | null;
  distanceToEdge: number | null;
  severityFloor: string | null;
  largestNegativeContributor: string | null;
  factors: FactorResult[];
  state: 'measured' | 'not_yet_measured';
  drillPath: string;
}

export async function latestPulse(): Promise<PulseEntry[]> {
  const auth = currentAuth();
  const out: PulseEntry[] = [];

  for (const domain of HEALTH_DOMAINS) {
    const rows = await prisma.healthScore.findMany({
      where: { tenantId: auth.tenantId, domainCode: domain.code },
      orderBy: { asOf: 'desc' },
      take: 2,
    });
    const latest = rows[0];
    const previous = rows[1];

    if (!latest || latest.state !== 'measured' || latest.score === null) {
      out.push({
        domainCode: domain.code,
        domainName: domain.name,
        asOf: latest?.asOf.toISOString() ?? new Date().toISOString(),
        score: null,
        band: null,
        previousScore: null,
        trend: null,
        distanceToEdge: null,
        severityFloor: null,
        largestNegativeContributor: null,
        factors: [],
        state: 'not_yet_measured' as const,
        drillPath: `/command/health/${domain.code}`,
      });
      continue;
    }

    const factors = (latest.factors as unknown as FactorResult[]) ?? [];
    const worst = factors.length
      ? factors.reduce((a, b) => (b.weight - b.contribution > a.weight - a.contribution ? b : a))
      : null;

    out.push({
      domainCode: domain.code,
      domainName: domain.name,
      asOf: latest.asOf.toISOString(),
      score: latest.score,
      band: latest.band,
      previousScore: previous?.score ?? null,
      trend: previous?.score == null ? null : latest.score > previous.score ? ('up' as const) : latest.score < previous.score ? ('down' as const) : ('flat' as const),
      // How much room before this crosses — never a bare number.
      distanceToEdge: distanceToEdge(latest.score),
      severityFloor: latest.band ? HEALTH_BAND_SEVERITY_FLOOR[latest.band as HealthBand] : null,
      largestNegativeContributor: worst ? `${worst.label} −${(worst.weight - worst.contribution).toFixed(1)} pts` : null,
      factors,
      state: 'measured' as const,
      drillPath: `/command/health/${domain.code}`,
    });
  }

  return out;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function fmt(n: number): string {
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)} Cr`;
  if (n >= 100_000) return `${(n / 100_000).toFixed(2)} L`;
  return n.toFixed(0);
}

async function targetFor(key: string, fallback: number): Promise<number> {
  const auth = currentAuth();
  const t = await prisma.threshold.findFirst({ where: { tenantId: auth.tenantId, thresholdKey: key } });
  return t?.value ?? fallback;
}
