/**
 * The Chairman Command Center (Tier D, P9).
 *
 * The defining test: at any moment, from anywhere, the Chairman can know the
 * state of Kaizen, what changed, what needs attention, what needs a decision,
 * who owns it, what the system already handled, and what is likely next.
 *
 * Four structural properties distinguish it from a workspace: the aggregation
 * gradient runs DOWN (domain → factor → reading → record), never up from
 * individual work items; the write path is a different object class entirely
 * (DECISION, DELEGATION, an AUTHORITY_GRANT change) and never a field edit on
 * an operational record; the unit of attention is an exception, a decision, or
 * a health-band transition, never a record row; and it is the only surface that
 * needs a time model, because the Chairman arrives after an absence.
 *
 * Three named failure modes are guarded structurally, not by design guidance:
 * vanity metrics (the falsifiability check in health.ts), activity floods (the
 * four admission gates below), and dead numbers (every widget declares actions).
 */

import {
  AUTOMATION_CLASSES,
  EVENTS,
  SEVERITY_RANK,
  type DeltaItem,
  type SeverityCode,
} from '@kaizen/shared';
import { createHash } from 'node:crypto';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { latestPulse } from './health.js';


/** Why an item sits where it does in the queue, in words rather than codes. */
const SEVERITY_REASON: Record<string, string> = {
  S0_INFO: 'it is worth knowing about',
  S1_ATTENTION: 'it is worth a look',
  S2_WARNING: 'it needs attention',
  S3_HIGH_RISK: 'it is high risk',
  S4_CRITICAL: 'it is urgent',
};


// ---------------------------------------------------------------------------
// The four admission gates. Nothing arrives on this surface as a raw event —
// only a resolved exception, a decision whose authority exceeds everyone below
// the viewer, a health-band transition, or a delta item past a materiality floor.
// ---------------------------------------------------------------------------

const ADMITTED_EVENT_NAMES = new Set<string>([
  EVENTS.EXCEPTION_RAISED,
  EVENTS.EXCEPTION_ESCALATED,
  EVENTS.HEALTH_BAND_CHANGED,
  EVENTS.DECISION_RAISED,
  EVENTS.APPROVAL_STEP_OPENED,
  EVENTS.CONTRACT_SIGNED,
  EVENTS.OPPORTUNITY_WON,
  EVENTS.OPPORTUNITY_LOST,
  EVENTS.MOU_STATUS_CHANGED,
  EVENTS.AUTHORITY_GRANT_EXCEEDED,
  EVENTS.PAYMENT_OVERDUE_DETECTED,
  EVENTS.LEAD_UNROUTED,
  EVENTS.AGENT_AUTHORITY_SHORTFALL,
]);

async function materialityFloor(): Promise<number> {
  const auth = currentAuth();
  const t = await prisma.threshold.findFirst({
    where: { tenantId: auth.tenantId, thresholdKey: 'command_center.materiality_floor' },
  });
  return t?.value ?? 100_000;
}

async function narrativeWindowHours(): Promise<number> {
  const auth = currentAuth();
  const t = await prisma.threshold.findFirst({
    where: { tenantId: auth.tenantId, thresholdKey: 'command_center.narrative_window_hours' },
  });
  // Shipped as a THRESHOLD row from day one rather than a hardcoded constant,
  // because the source flags it as unvalidated.
  return t?.value ?? 72;
}

/**
 * A hash over resolved scope, policy version and consent state. Lets the delta
 * engine distinguish "forty exceptions just appeared because your portfolio
 * widened" from "forty things just broke" — a distinction a generic unread flag
 * cannot make.
 */
export async function computeReachSignature(): Promise<string> {
  const auth = currentAuth();
  const grants = await prisma.grant.findMany({
    where: { tenantId: auth.tenantId },
    select: { resource: true, verbs: true, scope: true, policyVersionId: true },
    orderBy: { resource: 'asc' },
  });
  const payload = JSON.stringify({
    role: auth.roleSlug,
    affiliation: auth.affiliationId,
    ceiling: auth.classificationCeiling,
    grants,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

async function watermarkFor() {
  const auth = currentAuth();
  if (!auth.userId || !auth.affiliationId) return null;

  const signature = await computeReachSignature();
  const existing = await prisma.attentionWatermark.findFirst({
    where: { tenantId: auth.tenantId, userId: auth.userId, affiliationId: auth.affiliationId },
  });

  if (existing) return { ...existing, currentSignature: signature };

  const created = await prisma.attentionWatermark.create({
    data: {
      tenantId: auth.tenantId,
      userId: auth.userId,
      affiliationId: auth.affiliationId,
      lastSeenAt: new Date(Date.now() - 24 * 3_600_000),
      reachSignature: signature,
    },
  });
  return { ...created, currentSignature: signature };
}

export async function whatChanged() {
  const auth = currentAuth();
  const watermark = await watermarkFor();
  const since = watermark?.lastSeenAt ?? new Date(Date.now() - 24 * 3_600_000);
  const floor = await materialityFloor();
  const windowHours = await narrativeWindowHours();

  const events = await prisma.eventRecord.findMany({
    where: { tenantId: auth.tenantId, recordedAt: { gt: since }, legacyName: null },
    orderBy: { recordedAt: 'desc' },
    take: 500,
  });

  const items: DeltaItem[] = [];
  let suppressed = 0;

  // The reach changed, so items are new to the view rather than new in the world.
  const reachChanged = Boolean(watermark && watermark.reachSignature !== watermark.currentSignature);

  for (const e of events) {
    if (!ADMITTED_EVENT_NAMES.has(e.eventName)) {
      suppressed += 1;
      continue;
    }

    const materiality = (e.impactMateriality as { value?: number } | null)?.value ?? null;
    const severity = e.impactSeverity as SeverityCode | null;

    // Materiality floor: an item with neither material value nor a severity of
    // S2 or higher does not earn a place on this surface.
    const passesFloor =
      (materiality !== null && materiality >= floor) ||
      (severity !== null && SEVERITY_RANK[severity] >= SEVERITY_RANK.S2_WARNING);
    if (!passesFloor) {
      suppressed += 1;
      continue;
    }

    items.push({
      id: e.id,
      eventId: e.eventId,
      occurredAt: e.occurredAt.toISOString(),
      headline: headlineFor(e.eventName, e.subjectRecordCode),
      detail: detailFor(e),
      domain: e.impactDomains[0] ?? 'crm',
      severity,
      materiality,
      newToView: reachChanged,
      // Resolved without Chairman involvement — links through to the automation
      // digest rather than duplicating detail here.
      handledWithoutYou: e.actorType === 'system' || e.actorType === 'agent',
      drillPath: drillPathFor(e.subjectEntityType, e.subjectEntityId),
    });
  }

  const elapsed = (Date.now() - since.getTime()) / 3_600_000;
  const narrativeWindowElapsed = elapsed >= windowHours;

  return {
    watermark: since.toISOString(),
    reachSignature: watermark?.currentSignature ?? '',
    narrativeWindowElapsed,
    narrative: narrativeWindowElapsed ? await buildNarrative(items, since) : null,
    items: items.slice(0, 50),
    suppressedBelowMateriality: suppressed,
  };
}

/**
 * AI-authored prose, but it behaves like READ: every claim resolves to an
 * admitted delta item a human could independently verify, and it opens with a
 * computed reconciliation line — never a stylistic flourish.
 */
async function buildNarrative(items: DeltaItem[], since: Date) {
  const auth = currentAuth();

  const [openWhenLeft, stillOpen, resolvedSince, newSince] = await Promise.all([
    prisma.exceptionRecord.count({
      where: { tenantId: auth.tenantId, severity: { in: ['S3_HIGH_RISK', 'S4_CRITICAL'] }, raisedAt: { lt: since } },
    }),
    prisma.exceptionRecord.count({
      where: {
        tenantId: auth.tenantId,
        severity: { in: ['S3_HIGH_RISK', 'S4_CRITICAL'] },
        raisedAt: { lt: since },
        state: { in: ['open', 'escalated'] },
      },
    }),
    prisma.exceptionRecord.count({
      where: { tenantId: auth.tenantId, state: 'resolved', resolvedAt: { gte: since } },
    }),
    prisma.exceptionRecord.count({
      where: { tenantId: auth.tenantId, raisedAt: { gte: since } },
    }),
  ]);

  const reconciliationLine = `${openWhenLeft} S3+ open when you left, ${stillOpen} the same, ${resolvedSince} resolved, ${newSince} new.`;

  const bySeverity = items.filter((i) => i.severity && SEVERITY_RANK[i.severity] >= SEVERITY_RANK.S3_HIGH_RISK);
  const byValue = items.filter((i) => i.materiality && i.materiality > 0).sort((a, b) => (b.materiality ?? 0) - (a.materiality ?? 0));

  const claims: string[] = [];
  if (bySeverity.length) {
    claims.push(`${bySeverity.length} high-risk item${bySeverity.length === 1 ? '' : 's'} arrived, led by ${bySeverity[0].headline}.`);
  }
  if (byValue.length) {
    claims.push(`The largest movement by value was ${byValue[0].headline} at ${formatMoney(byValue[0].materiality!)}.`);
  }
  const handled = items.filter((i) => i.handledWithoutYou).length;
  if (handled) claims.push(`${handled} item${handled === 1 ? '' : 's'} ${handled === 1 ? 'was' : 'were'} handled without you.`);
  if (claims.length === 0) claims.push('Nothing crossed the materiality floor in this window.');

  return { reconciliationLine, body: claims.join(' ') };
}

export async function attentionQueue(minSeverity: SeverityCode = 'S3_HIGH_RISK') {
  const auth = currentAuth();
  const rank = SEVERITY_RANK[minSeverity];

  const rows = await prisma.exceptionRecord.findMany({
    where: {
      tenantId: auth.tenantId,
      state: { in: ['open', 'acknowledged', 'escalated'] },
      OR: [
        { severity: { in: Object.keys(SEVERITY_RANK).filter((s) => SEVERITY_RANK[s as SeverityCode] >= rank) } },
        // Breaching SLA escalates visibility here regardless of source domain.
        { slaDueAt: { lt: new Date() } },
        // The unowned bucket is a first-class, measured category.
        { ownerUnresolved: true },
      ],
    },
    orderBy: [{ severity: 'desc' }, { raisedAt: 'asc' }],
    take: 50,
  });

  const owners = await ownerNames(rows.map((r) => r.ownerPartyId).filter(Boolean) as string[]);

  return rows.map((r) => {
    const slaBreached = Boolean(r.slaDueAt && r.slaDueAt < new Date());
    return {
      id: r.id,
      code: r.code,
      label: r.label,
      severity: r.severity as SeverityCode,
      state: r.state,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      subjectLabel: r.subjectLabel ?? r.subjectId,
      recordCode: r.recordCode,
      ownerPartyId: r.ownerPartyId,
      ownerName: r.ownerPartyId ? (owners.get(r.ownerPartyId) ?? null) : null,
      accountablePositionId: r.accountablePositionId,
      raisedAt: r.raisedAt.toISOString(),
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
      slaDueAt: r.slaDueAt?.toISOString() ?? null,
      slaBreached,
      escalationRung: r.escalationRung,
      escalationTrigger: r.escalationTrigger,
      detail: r.detail ?? '',
      drillPath: drillPathFor(r.subjectType, r.subjectId),
      // Six-band lexicographic ranking: band always dominates score.
      ranked: {
        band:
          r.severity === 'S4_CRITICAL'
            ? ('critical_in_scope' as const)
            : r.ownerPartyId === auth.partyId && SEVERITY_RANK[r.severity as SeverityCode] >= 3
              ? ('my_high_risk' as const)
              : r.ownerUnresolved
                ? ('i_am_blocker' as const)
                : slaBreached
                  ? ('my_due_items' as const)
                  : ('scored' as const),
        score: SEVERITY_RANK[r.severity as SeverityCode] * 10 + (slaBreached ? 5 : 0),
        // Said the way a person would say it, because an ordering nobody can
        // explain is no more use than a score nobody can check.
        whyRanked: [
          SEVERITY_REASON[r.severity as SeverityCode] ?? 'it was flagged',
          ...(slaBreached ? ['it has missed its deadline'] : []),
          ...(r.ownerUnresolved ? ['nobody has been assigned to it'] : []),
          ...(r.ownerPartyId === auth.partyId ? ['it is yours'] : []),
        ],
      },
    };
  });
}

async function ownerNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const people = await prisma.person.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, fullName: true },
  });
  return new Map(people.map((p) => [p.id, p.fullName]));
}

export async function liveAndHandled(windowHours = 24) {
  const auth = currentAuth();
  const since = new Date(Date.now() - windowHours * 3_600_000);

  const [definitions, runs, agentActions, authorityGrants] = await Promise.all([
    prisma.automationDefinition.findMany({ where: { tenantId: auth.tenantId } }),
    prisma.jobRun.findMany({ where: { tenantId: auth.tenantId, startedAt: { gte: since } } }),
    prisma.agentAction.findMany({
      where: { tenantId: auth.tenantId, proposedAt: { gte: since } },
      include: { agent: { select: { name: true } } },
    }),
    prisma.authorityGrant.findMany({ where: { tenantId: auth.tenantId, status: 'active' } }),
  ]);

  const byClass = new Map(definitions.map((d) => [d.jobName, d]));

  const rows = AUTOMATION_CLASSES.map((cls) => {
    const clsDefs = definitions.filter((d) => d.automationClass === cls);
    const clsRuns = runs.filter((r) => clsDefs.some((d) => d.jobName === r.jobName));
    const succeeded = clsRuns.filter((r) => r.status === 'completed').length;
    const failed = clsRuns.filter((r) => r.status === 'failed').length;

    // agent_recommendation_applied is tracked as its own row so agent-originated
    // action is never blended into deterministic automation's success rate.
    const isAgentClass = cls === 'agent_recommendation_applied';
    const agentCount = isAgentClass ? agentActions.filter((a) => a.state === 'executed').length : 0;
    const shortfall = isAgentClass ? agentActions.filter((a) => a.state === 'blocked').length : 0;

    const count = isAgentClass ? agentCount : clsRuns.length;
    const top = clsRuns.length
      ? clsRuns.reduce((a, b) => (b.processed > a.processed ? b : a)).jobName
      : clsDefs[0]?.jobName ?? null;

    return {
      automationClass: cls,
      label: humaniseClass(cls),
      count,
      valueMoved: null,
      successRate: clsRuns.length ? Number(((succeeded / clsRuns.length) * 100).toFixed(1)) : isAgentClass && agentCount ? 100 : 100,
      exceptionCount: failed,
      topDefinition: top,
      accountablePosition: top ? (byClass.get(top)?.accountablePositionId ?? null) : null,
      suppressedByRateLimit: 0,
      dryRunCount: clsRuns.filter((r) => r.dryRun).length,
      // The leading indicator of over- and under-granting: what an agent
      // proposed but lacked authority to take.
      authorityShortfall: shortfall,
    };
  });

  const authorityInForce = await Promise.all(
    authorityGrants.map(async (g) => {
      const dependentAgents = await prisma.agentPrincipal.findMany({
        where: { tenantId: auth.tenantId, id: g.principalId },
        select: { name: true },
      });
      return {
        id: g.id,
        principalLabel: g.principalLabel ?? g.principalId,
        principalType: g.principalType,
        authorityClass: g.authorityClass,
        ceilingValue: num(g.ceilingValue),
        currency: g.currency,
        status: g.status,
        dependentAutomations: definitions.filter((d) => (d.config as { authorityClass?: string })?.authorityClass === g.authorityClass).map((d) => d.label),
        dependentAgents: dependentAgents.map((a) => a.name),
      };
    }),
  );

  const materialEvents = await prisma.eventRecord.findMany({
    where: {
      tenantId: auth.tenantId,
      recordedAt: { gte: since },
      legacyName: null,
      eventName: { in: [...ADMITTED_EVENT_NAMES] },
    },
    orderBy: { recordedAt: 'desc' },
    take: 25,
  });

  return {
    rows,
    materialEvents: materialEvents.map((e) => ({
      id: e.id,
      eventId: e.eventId,
      occurredAt: e.occurredAt.toISOString(),
      headline: headlineFor(e.eventName, e.subjectRecordCode),
      detail: detailFor(e),
      domain: e.impactDomains[0] ?? 'crm',
      severity: e.impactSeverity as SeverityCode | null,
      materiality: (e.impactMateriality as { value?: number } | null)?.value ?? null,
      newToView: false,
      handledWithoutYou: e.actorType !== 'human',
      drillPath: drillPathFor(e.subjectEntityType, e.subjectEntityId),
    })),
    authorityInForce,
  };
}

/**
 * People & Capability: unit-level capacity only. The k-anonymity floor is
 * enforced in the widget's data contract, so it cannot be bypassed by a higher
 * role holding a broader grant — it applies regardless of who is asking,
 * including the Chairman.
 *
 * This is the structural substitute for individual flight-risk scoring, which
 * is categorically PROHIBITED rather than deferred.
 */
export async function peopleAndCapability() {
  const auth = currentAuth();
  const K = 5;

  const affiliations = await prisma.affiliation.findMany({
    where: { tenantId: auth.tenantId, affiliationType: 'employee', status: 'active' },
    select: { orgUnitId: true, roleSlug: true, partyId: true },
  });

  const byUnit = new Map<string, { headcount: number; roles: Set<string> }>();
  for (const a of affiliations) {
    const unit = a.orgUnitId ?? 'unassigned';
    const entry = byUnit.get(unit) ?? { headcount: 0, roles: new Set<string>() };
    entry.headcount += 1;
    if (a.roleSlug) entry.roles.add(a.roleSlug);
    byUnit.set(unit, entry);
  }

  return [...byUnit.entries()].map(([unit, data]) => {
    // A unit of three cannot be reverse-engineered into a person.
    if (data.headcount < K) {
      return {
        unit,
        headcount: null,
        roleCoverage: null,
        singlePointsOfFailure: null,
        withheld: true,
        withheldReason: 'classification_ceiling' as const,
        note: `Population below the k>=${K} anonymity floor. Withheld regardless of who is asking.`,
      };
    }
    // A role held by exactly one person in a unit is a single point of failure —
    // a structural fact about the unit, never a statement about the individual.
    const spof = [...data.roles].filter(
      (role) => affiliations.filter((a) => (a.orgUnitId ?? 'unassigned') === unit && a.roleSlug === role).length === 1,
    ).length;

    return {
      unit,
      headcount: data.headcount,
      roleCoverage: data.roles.size,
      singlePointsOfFailure: spof,
      withheld: false,
      withheldReason: null,
      note: null,
    };
  });
}

export async function touchWatermark() {
  const auth = currentAuth();
  if (!auth.userId || !auth.affiliationId) return null;
  const signature = await computeReachSignature();
  return prisma.attentionWatermark.upsert({
    where: {
      tenantId_userId_affiliationId: {
        tenantId: auth.tenantId,
        userId: auth.userId,
        affiliationId: auth.affiliationId,
      },
    },
    create: { tenantId: auth.tenantId, userId: auth.userId, affiliationId: auth.affiliationId, reachSignature: signature },
    update: { lastSeenAt: new Date(), reachSignature: signature },
  });
}

export async function banner() {
  const auth = currentAuth();
  const [exceptions, decisions, approvals] = await Promise.all([
    prisma.exceptionRecord.findMany({
      where: { tenantId: auth.tenantId, state: { in: ['open', 'escalated'] }, severity: { in: ['S3_HIGH_RISK', 'S4_CRITICAL'] } },
      orderBy: { raisedAt: 'asc' },
      select: { raisedAt: true },
    }),
    prisma.decision.findMany({
      where: { tenantId: auth.tenantId, state: { in: ['Raised', 'Analysing', 'AwaitingAuthority', 'EvidenceRequested'] } },
      orderBy: { raisedAt: 'asc' },
      select: { raisedAt: true },
    }),
    prisma.approvalStep.findMany({
      where: { tenantId: auth.tenantId, state: 'open' },
      orderBy: { requestedAt: 'asc' },
      select: { requestedAt: true },
    }),
  ]);

  const clocks = [
    ...exceptions.map((e) => e.raisedAt),
    ...decisions.map((d) => d.raisedAt),
    ...approvals.map((a) => a.requestedAt),
  ].sort((a, b) => a.getTime() - b.getTime());

  return {
    waitingCount: clocks.length,
    // A rendered fact, not a derived query the Chairman has to run.
    oldestClockHours: clocks.length ? Math.floor((Date.now() - clocks[0].getTime()) / 3_600_000) : null,
  };
}

export async function commandCenter() {
  const [pulseData, bannerData, attention, changed, live, decisions] = await Promise.all([
    latestPulse(),
    banner(),
    attentionQueue(),
    whatChanged(),
    liveAndHandled(),
    (await import('./decisions.js')).decisionQueue(),
  ]);

  return {
    asOf: new Date().toISOString(),
    scope: 'tenant' as const,
    banner: bannerData,
    pulse: pulseData,
    attentionQueue: attention,
    decisionQueue: decisions,
    whatChanged: changed,
    liveAndHandled: live,
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const HEADLINES: Record<string, string> = {
  [EVENTS.EXCEPTION_RAISED]: 'Exception raised',
  [EVENTS.EXCEPTION_ESCALATED]: 'Exception escalated',
  [EVENTS.HEALTH_BAND_CHANGED]: 'Health band changed',
  [EVENTS.DECISION_RAISED]: 'Decision raised',
  [EVENTS.APPROVAL_STEP_OPENED]: 'Approval required',
  [EVENTS.CONTRACT_SIGNED]: 'Contract signed',
  [EVENTS.OPPORTUNITY_WON]: 'Opportunity won',
  [EVENTS.OPPORTUNITY_LOST]: 'Opportunity lost',
  [EVENTS.MOU_STATUS_CHANGED]: 'MoU status changed',
  [EVENTS.AUTHORITY_GRANT_EXCEEDED]: 'Authority ceiling exceeded',
  [EVENTS.PAYMENT_OVERDUE_DETECTED]: 'Payment overdue',
  [EVENTS.LEAD_UNROUTED]: 'Lead could not be routed',
  [EVENTS.AGENT_AUTHORITY_SHORTFALL]: 'Agent lacked authority',
};

function headlineFor(eventName: string, recordCode: string | null): string {
  const base = HEADLINES[eventName] ?? eventName.split('.').slice(2).join(' ').replace(/_/g, ' ');
  return recordCode ? `${base} — ${recordCode}` : base;
}

function detailFor(e: { newState: unknown; reason: unknown; subjectEntityType: string }): string {
  const state = (e.newState ?? {}) as Record<string, unknown>;
  const reason = (e.reason ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (reason.reasonCode) parts.push(String(reason.reasonCode).replace(/_/g, ' '));
  if (state.status) parts.push(`status ${state.status}`);
  if (state.band) parts.push(`band ${state.band}`);
  if (state.severity) parts.push(String(state.severity));
  if (state.commercialValue) parts.push(formatMoney(Number(state.commercialValue)));
  return parts.length ? parts.join(' · ') : e.subjectEntityType;
}

const DRILL_ROUTES: Record<string, string> = {
  opportunity: '/crm/opportunities',
  lead: '/crm/leads',
  organization: '/crm/accounts',
  person: '/crm/people',
  mou: '/commercial/mous',
  contract: '/commercial/contracts',
  partner_agreement: '/commercial/partner-agreements',
  proposal: '/commercial/proposals',
  quote: '/commercial/quotes',
  invoice: '/finance/invoices',
  payment: '/finance/payments',
  exception: '/exceptions',
  decision: '/command/decisions',
  approval_step: '/approvals',
  interaction: '/crm/interactions',
  win_loss_review: '/commercial/win-loss',
  offering: '/commercial/offerings',
  project: '/delivery/projects',
  enrollment: '/education/enrollments',
  health_score: '/command',
  health_factor: '/command',
};

export function drillPathFor(entityType: string, entityId: string): string {
  const base = DRILL_ROUTES[entityType];
  return base ? `${base}/${entityId}` : `/admin/events?subject=${entityId}`;
}

function humaniseClass(cls: string): string {
  return cls.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function formatMoney(n: number): string {
  if (Math.abs(n) >= 10_000_000) return `₹${(n / 10_000_000).toFixed(2)} Cr`;
  if (Math.abs(n) >= 100_000) return `₹${(n / 100_000).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}
