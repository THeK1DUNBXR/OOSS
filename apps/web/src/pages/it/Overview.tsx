/**
 * Technology overview (docs/plan/cio.md, workstream I).
 *
 * A KPI wall composed client-side from every other workstream's own
 * `GET /it/<segment>/summary` endpoint — this page never computes a figure
 * of its own, it only arranges what A–H already worked out. Each summary is
 * fetched with `retry: 0` so an unfinished workstream's 404 resolves fast
 * rather than retrying into a spinner, and is read defensively with `pick()`
 * because the exact field names were still being decided while this page
 * was written. A tile reads "Nothing to measure yet" whenever its query
 * errored or its summary says `notYetMeasured` — never a zero, because a
 * zero next to "open tickets" reads as a fact about the desk rather than a
 * fact about there being no desk data yet.
 *
 * -------------------------------------------------------------------------
 * Tile → summary-key expectations (what this page reads from each summary).
 * The API agent (workstream I's API sibling, or whichever workstream owns
 * each `/summary` route) should match these key names, or this file's
 * `pick()` calls should be extended to match theirs.
 *
 *   GET /it/assets/summary        byStatus (Record<status, count>),
 *                                  warrantyExpiring90d | warrantyExpiring,
 *                                  unassigned
 *   GET /it/applications/summary  byTier (Record<tier, count>) | total | count,
 *                                  noOwner | withoutOwner | unowned
 *   GET /it/licences/summary      annualisedSpend | annualSpend,
 *                                  renewalsDue90d | renewalsDue,
 *                                  seatsPurchased, seatsInUse
 *   GET /it/vendors/summary       byTier (Record<tier, count>) | total | count,
 *                                  assessmentsOverdue | overdueAssessments
 *   GET /it/contracts/summary     valueUnderManagement | totalValue,
 *                                  expiring90d | expiringIn90Days
 *   GET /it/tickets/summary       openByPriority (Record<priority, count>),
 *                                  slaAttainment.response | slaAttainmentResponse,
 *                                  slaAttainment.resolution | slaAttainmentResolution,
 *                                  medianResolveMinutes
 *   GET /it/incidents/summary     openBySeverity (Record<severity, count>),
 *                                  mttrMinutes
 *   GET /it/changes/summary       awaitingApproval, successRate, freezeInForce
 *   GET /it/risks/summary         byBand (Record<band, count>)
 *   GET /it/findings/summary      overdue, openBySeverity (Record<severity, count>)
 *   GET /it/policies/summary      acknowledgementRate
 *   GET /it/initiatives/summary   byRag (Record<rag, count>) | byStage (Record<stage, count>)
 *   GET /it/budget/summary        planned, actual
 *   GET /it/continuity/summary    tier1Tested | tier1WithTestedPlan,
 *                                  testsOverdue
 *   GET /it/availability/summary  lastMonthUptime | uptimeLastMonth
 *
 * Every summary is also expected to carry `notYetMeasured: boolean` (or be
 * treated as such on a 404), per `ItSummaryBase` in `@kaizen/shared`.
 * -------------------------------------------------------------------------
 */

import type { ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api, money } from '../../lib/api.js';
import { NOT_MEASURED } from '../../lib/words.js';
import { Card, Metric, PageHeader } from '../../components/ui.js';

// ---------------------------------------------------------------------------
// Defensive summary reading
// ---------------------------------------------------------------------------

type Summary = Record<string, unknown> | undefined;

/** Reads the first present key off a summary object. Keys may be dotted
 *  (`'slaAttainment.response'`) to reach one level into a nested object. */
function pick<T = unknown>(obj: Summary, ...keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = key
      .split('.')
      .reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), obj);
    if (value !== undefined && value !== null) return value as T;
  }
  return undefined;
}

/** Sums the values of a `{ [bucket]: count }` object, e.g. `byStatus` or
 *  `openBySeverity`, defensively — anything that is not a finite number is
 *  ignored rather than turned into `NaN`. */
function sumBuckets(obj: unknown): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const values = Object.values(obj as Record<string, unknown>).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0);
}

/** Renders a `{ [bucket]: count }` object as "P1 2 · P2 5" for a tile's sub-line. */
function breakdown(obj: unknown, limit = 4): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const entries = Object.entries(obj as Record<string, unknown>).filter(([, v]) => typeof v === 'number' && (v as number) > 0);
  if (entries.length === 0) return undefined;
  return entries
    .slice(0, limit)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
}

function useSummary(path: string): UseQueryResult<Summary> {
  return useQuery({
    queryKey: ['it-summary', path],
    queryFn: () => api.get<Summary>(path),
    retry: 0,
  });
}

/** Whether this workstream should render as "Nothing to measure yet" — an
 *  error (very likely a 404, the workstream not built yet), no data back,
 *  or the summary saying so itself. */
function notMeasured(q: UseQueryResult<Summary>): boolean {
  return q.isError || !q.data || q.data.notYetMeasured === true;
}

// ---------------------------------------------------------------------------
// A tile — a `Metric` that renders the honest empty state on its own.
// ---------------------------------------------------------------------------

function Tile({
  q,
  label,
  drillTo,
  value,
  sub,
  tone,
}: {
  q: UseQueryResult<Summary>;
  label: string;
  drillTo: string;
  value: (d: Record<string, unknown>) => ReactNode;
  sub?: (d: Record<string, unknown>) => ReactNode;
  tone?: (d: Record<string, unknown>) => 'neutral' | 'good' | 'warn' | 'bad';
}) {
  if (notMeasured(q)) {
    return <Metric label={label} value={NOT_MEASURED} drillTo={drillTo} />;
  }
  const d = q.data as Record<string, unknown>;
  return <Metric label={label} value={value(d)} sub={sub?.(d)} drillTo={drillTo} tone={tone?.(d) ?? 'neutral'} />;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <Card title={title} subtitle={subtitle}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </Card>
  );
}

export function ItOverview() {
  const assets = useSummary('/it/assets/summary');
  const applications = useSummary('/it/applications/summary');
  const licences = useSummary('/it/licences/summary');
  const vendors = useSummary('/it/vendors/summary');
  const contracts = useSummary('/it/contracts/summary');
  const tickets = useSummary('/it/tickets/summary');
  const incidents = useSummary('/it/incidents/summary');
  const changes = useSummary('/it/changes/summary');
  const risks = useSummary('/it/risks/summary');
  const findings = useSummary('/it/findings/summary');
  const policies = useSummary('/it/policies/summary');
  const initiatives = useSummary('/it/initiatives/summary');
  const budget = useSummary('/it/budget/summary');
  const continuity = useSummary('/it/continuity/summary');
  const availability = useSummary('/it/availability/summary');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Technology"
        subtitle="What the estate is running, what it costs, and what is due. Every figure here is
          either typed into a register or computed from what was typed in — this screen does not discover
          devices on the network, meter a SaaS login, page anyone, or scan for vulnerabilities, and each
          screen it opens onto says so again. Nothing to measure yet stands for a workstream with no data
          behind it; it is never shown as zero."
      />

      <Section title="Estate" subtitle="What we own, run and pay for.">
        <Tile
          q={assets}
          label="Assets"
          drillTo="/it/assets"
          value={(d) => sumBuckets(pick(d, 'byStatus')) ?? '—'}
          sub={(d) => {
            const warranty = pick<number>(d, 'warrantyExpiring90d', 'warrantyExpiring');
            const unassigned = pick<number>(d, 'unassigned');
            const parts: string[] = [];
            if (warranty !== undefined) parts.push(`${warranty} warranty due in 90 days`);
            if (unassigned !== undefined) parts.push(`${unassigned} unassigned`);
            return parts.join(' · ') || breakdown(pick(d, 'byStatus'));
          }}
        />
        <Tile
          q={applications}
          label="Applications"
          drillTo="/it/applications"
          value={(d) => sumBuckets(pick(d, 'byTier')) ?? pick<number>(d, 'total', 'count') ?? '—'}
          sub={(d) => {
            const noOwner = pick<number>(d, 'noOwner', 'withoutOwner', 'unowned');
            return noOwner ? `${noOwner} with no owner` : breakdown(pick(d, 'byTier'));
          }}
        />
        <Tile
          q={licences}
          label="Licence spend"
          drillTo="/it/licences"
          value={(d) => {
            const spend = pick<number>(d, 'annualisedSpend', 'annualSpend');
            return spend === undefined ? '—' : money(spend);
          }}
          sub={(d) => {
            const renewals = pick<number>(d, 'renewalsDue90d', 'renewalsDue');
            const purchased = pick<number>(d, 'seatsPurchased');
            const inUse = pick<number>(d, 'seatsInUse');
            const parts: string[] = [];
            if (renewals !== undefined) parts.push(`${renewals} renewing in 90 days`);
            if (purchased !== undefined && inUse !== undefined) parts.push(`${inUse} of ${purchased} seats in use`);
            return parts.join(' · ') || undefined;
          }}
        />
        <Tile
          q={vendors}
          label="Vendors"
          drillTo="/it/vendors"
          value={(d) => sumBuckets(pick(d, 'byTier')) ?? pick<number>(d, 'total', 'count') ?? '—'}
          sub={(d) => {
            const overdue = pick<number>(d, 'assessmentsOverdue', 'overdueAssessments');
            return overdue ? `${overdue} assessments overdue` : breakdown(pick(d, 'byTier'));
          }}
          tone={(d) => {
            const overdue = pick<number>(d, 'assessmentsOverdue', 'overdueAssessments');
            return overdue ? 'warn' : 'neutral';
          }}
        />
        <Tile
          q={contracts}
          label="Vendor contracts"
          drillTo="/it/contracts"
          value={(d) => {
            const value = pick<number>(d, 'valueUnderManagement', 'totalValue');
            return value === undefined ? '—' : money(value);
          }}
          sub={(d) => {
            const expiring = pick<number>(d, 'expiring90d', 'expiringIn90Days');
            return expiring !== undefined ? `${expiring} expiring in 90 days` : undefined;
          }}
        />
      </Section>

      <Section title="The desk" subtitle="What people are waiting on.">
        <Tile
          q={tickets}
          label="Open tickets"
          drillTo="/it/tickets"
          value={(d) => sumBuckets(pick(d, 'openByPriority')) ?? '—'}
          sub={(d) => {
            const response = pick<number>(d, 'slaAttainment.response', 'slaAttainmentResponse');
            const median = pick<number>(d, 'medianResolveMinutes');
            const parts: string[] = [];
            if (response !== undefined) parts.push(`${Math.round(response)}% response SLA`);
            if (median !== undefined) parts.push(`median resolve ${Math.round(median / 60)}h`);
            return parts.join(' · ') || breakdown(pick(d, 'openByPriority'));
          }}
        />
        <Tile
          q={incidents}
          label="Open incidents"
          drillTo="/it/incidents"
          value={(d) => sumBuckets(pick(d, 'openBySeverity')) ?? '—'}
          sub={(d) => {
            const mttr = pick<number>(d, 'mttrMinutes');
            return mttr !== undefined ? `MTTR ${Math.round(mttr / 60)}h` : breakdown(pick(d, 'openBySeverity'));
          }}
          tone={(d) => (sumBuckets(pick(d, 'openBySeverity')) ? 'warn' : 'neutral')}
        />
        <Tile
          q={changes}
          label="Changes awaiting approval"
          drillTo="/it/changes"
          value={(d) => pick<number>(d, 'awaitingApproval') ?? '—'}
          sub={(d) => {
            const rate = pick<number>(d, 'successRate');
            const freeze = pick<boolean>(d, 'freezeInForce');
            const parts: string[] = [];
            if (rate !== undefined) parts.push(`${Math.round(rate)}% succeed`);
            if (freeze) parts.push('a freeze is in force');
            return parts.join(' · ') || undefined;
          }}
        />
      </Section>

      <Section title="Security" subtitle="Risk, findings and what staff have signed off.">
        <Tile
          q={risks}
          label="Open risks"
          drillTo="/it/risks"
          value={(d) => sumBuckets(pick(d, 'byBand')) ?? '—'}
          sub={(d) => breakdown(pick(d, 'byBand'))}
          tone={(d) => {
            const bands = pick<Record<string, number>>(d, 'byBand');
            return bands && ((bands.critical ?? 0) > 0 || (bands.high ?? 0) > 0) ? 'bad' : 'neutral';
          }}
        />
        <Tile
          q={findings}
          label="Findings overdue"
          drillTo="/it/findings"
          value={(d) => pick<number>(d, 'overdue') ?? '—'}
          sub={(d) => breakdown(pick(d, 'openBySeverity'))}
          tone={(d) => {
            const overdue = pick<number>(d, 'overdue');
            return overdue ? 'warn' : 'neutral';
          }}
        />
        <Tile
          q={policies}
          label="Policy acknowledgement"
          drillTo="/it/policies"
          value={(d) => {
            const rate = pick<number>(d, 'acknowledgementRate');
            return rate === undefined ? '—' : `${Math.round(rate)}%`;
          }}
        />
      </Section>

      <Section title="Money and plans" subtitle="What is funded, and where the budget stands.">
        <Tile
          q={initiatives}
          label="Portfolio"
          drillTo="/it/portfolio"
          value={(d) => sumBuckets(pick(d, 'byRag')) ?? sumBuckets(pick(d, 'byStage')) ?? '—'}
          sub={(d) => breakdown(pick(d, 'byRag')) ?? breakdown(pick(d, 'byStage'))}
          tone={(d) => {
            const rag = pick<Record<string, number>>(d, 'byRag');
            return rag && (rag.red ?? 0) > 0 ? 'bad' : 'neutral';
          }}
        />
        <Tile
          q={budget}
          label="Budget"
          drillTo="/it/budget"
          value={(d) => {
            const planned = pick<number>(d, 'planned');
            return planned === undefined ? '—' : money(planned);
          }}
          sub={(d) => {
            const actual = pick<number>(d, 'actual');
            return actual === undefined ? undefined : `${money(actual)} actual`;
          }}
        />
      </Section>

      <Section title="Continuity" subtitle="Whether we could get a system back, and whether it stays up.">
        <Tile
          q={continuity}
          label="Tier-1 plans tested"
          drillTo="/it/continuity"
          value={(d) => pick<number>(d, 'tier1Tested', 'tier1WithTestedPlan') ?? '—'}
          sub={(d) => {
            const overdue = pick<number>(d, 'testsOverdue');
            return overdue !== undefined ? `${overdue} tests overdue` : undefined;
          }}
          tone={(d) => {
            const overdue = pick<number>(d, 'testsOverdue');
            return overdue ? 'warn' : 'neutral';
          }}
        />
        <Tile
          q={availability}
          label="Uptime, last month"
          drillTo="/it/availability"
          value={(d) => {
            const uptime = pick<number>(d, 'lastMonthUptime', 'uptimeLastMonth');
            return uptime === undefined ? '—' : `${uptime.toFixed(2)}%`;
          }}
        />
      </Section>
    </div>
  );
}
