/**
 * HR analytics & reporting (docs/hcm/analytics.md).
 *
 * Everything on this page is a read: KPI tiles with the shape a metric needs
 * (a number, or "not measured" rendered as its own state, never a zero
 * standing in for one), a handful of inline-SVG charts (no charting library —
 * one accent hue for a single series, the platform's fixed division palette
 * for anything cut by division), and a Reports tab that downloads the same
 * data as CSV.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, Metric, PageHeader, Tabs } from '../../components/ui.js';
import { NOT_MEASURED } from '../../lib/words.js';

// ---------------------------------------------------------------------------
// Types (mirrors apps/api/src/domains/hcm/analytics.ts)
// ---------------------------------------------------------------------------

interface Metric_<T> {
  measured: boolean;
  value: T | null;
  reason?: string;
}

interface HeadcountPoint { month: string; headcount: number; joiners: number; leavers: number }
interface Breakdown { key: string; headcount: number }
interface Attrition {
  leavers: number; avgHeadcount: number; annualizedRatePct: number | null;
  earlyAttritionCount: number; earlyAttritionRatePct: number | null;
}
interface Tenure { buckets: Record<string, number>; totalActive: number }
interface Absenteeism { ratePct: number | null; zeroMinuteDays: number; totalDays: number }
interface Overtime { totalHours: number; totalAmount: number | null; byMonth: Array<{ month: string; hours: number }> }
interface LeaveLiability { totalDays: number; totalAmount: number | null; byLeaveType: Array<{ leaveType: string; days: number; amount: number | null }> }
interface Hiring {
  timeToHireDaysAvg: number | null; offerAcceptanceRatePct: number | null;
  offersExtended: number; offersAccepted: number; hires: number;
}
interface SpanStats { managerCount: number; averageSpan: number; minSpan: number; maxSpan: number }
interface PayrollPoint { payPeriod: string; gross: number; net: number; headcount: number; status: string }
interface Training { completionsPerHead: Metric_<number>; averageHoursPerHead: Metric_<number> }

interface Dashboard {
  headcount: HeadcountPoint[];
  byDivision: Breakdown[];
  byLocation: Breakdown[];
  attrition: Attrition;
  tenure: Tenure;
  absenteeism: Absenteeism;
  overtime: Overtime;
  leaveLiability: LeaveLiability;
  hiring: Hiring;
  costPerHire: Metric_<number>;
  spanOfControl: Metric_<SpanStats>;
  payroll: PayrollPoint[] | null;
  training: Training;
  genderRatio: Metric_<Record<string, number>>;
  compRatioDistribution: Metric_<Array<{ bucket: string; count: number }>>;
  engagementEnps: Metric_<number>;
  openCasesBySla: Metric_<Array<{ bucket: string; count: number }>>;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function pct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '—' : `${v.toFixed(digits)}%`;
}
function num1(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '—' : v.toFixed(digits);
}
function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}
function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

const DIVISION_LABEL: Record<string, string> = { software: 'Software', skill: 'Skill', education: 'Education', shared: 'Shared' };
const DIVISION_FILL: Record<string, string> = {
  software: 'fill-div-software', skill: 'fill-div-skill', education: 'fill-div-education', shared: 'fill-div-shared',
};
const DIVISION_BG: Record<string, string> = {
  software: 'bg-div-software', skill: 'bg-div-skill', education: 'bg-div-education', shared: 'bg-div-shared',
};

// ---------------------------------------------------------------------------
// Not-measured tile
// ---------------------------------------------------------------------------

function MetricTile<T>({ label, metric, format, noActionReason }: { label: string; metric: Metric_<T>; format: (v: T) => string; noActionReason: string }) {
  if (!metric.measured) {
    return <Metric label={label} value={NOT_MEASURED} tone="neutral" noActionReason={metric.reason ?? 'Not measured.'} />;
  }
  return <Metric label={label} value={format(metric.value as T)} tone="neutral" noActionReason={noActionReason} />;
}

// ---------------------------------------------------------------------------
// Inline SVG charts — thin marks, axis labels, a legend for multi-series.
// ---------------------------------------------------------------------------

const CHART_W = 640;
const CHART_H = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 36 };

function LineChart({ points, valueKey, label }: { points: Array<{ month: string; [k: string]: number | string }>; valueKey: string; label: string }) {
  if (points.length === 0) return <EmptyState message="No data for this period yet." />;
  const values = points.map((p) => Number(p[valueKey]));
  const maxV = Math.max(1, ...values);
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const coords = points.map((p, i) => ({
    x: PAD.left + i * stepX,
    y: PAD.top + innerH - (Number(p[valueKey]) / maxV) * innerH,
    month: p.month,
    value: Number(p[valueKey]),
  }));
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const everyN = Math.max(1, Math.ceil(points.length / 8));

  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full" role="img" aria-label={`${label} trend`}>
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + innerH} className="stroke-ink-700" strokeWidth={1} />
      <line x1={PAD.left} y1={PAD.top + innerH} x2={CHART_W - PAD.right} y2={PAD.top + innerH} className="stroke-ink-700" strokeWidth={1} />
      <text x={4} y={PAD.top + 4} className="fill-ink-500 text-[9px]">{Math.round(maxV)}</text>
      <text x={4} y={PAD.top + innerH} className="fill-ink-500 text-[9px]">0</text>
      <path d={path} fill="none" className="stroke-accent" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {coords.map((c, i) => (
        <g key={c.month}>
          <circle cx={c.x} cy={c.y} r={2.5} className="fill-accent">
            <title>{`${monthLabel(c.month)}: ${c.value}`}</title>
          </circle>
          {i % everyN === 0 && (
            <text x={c.x} y={CHART_H - 6} textAnchor="middle" className="fill-ink-500 text-[9px]">
              {monthLabel(c.month)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

function CategoricalBarChart({ bars, colorClass, legend }: { bars: Array<{ label: string; value: number; colorClass?: string }>; colorClass?: (label: string) => string; legend?: Array<{ label: string; colorClass: string }> }) {
  if (bars.length === 0) return <EmptyState message="No data yet." />;
  const maxV = Math.max(1, ...bars.map((b) => b.value));
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const gap = 10;
  const barW = Math.max(6, innerW / bars.length - gap);

  return (
    <div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full" role="img" aria-label="bar chart">
        <line x1={PAD.left} y1={PAD.top + innerH} x2={CHART_W - PAD.right} y2={PAD.top + innerH} className="stroke-ink-700" strokeWidth={1} />
        <text x={4} y={PAD.top + 4} className="fill-ink-500 text-[9px]">{Math.round(maxV)}</text>
        <text x={4} y={PAD.top + innerH} className="fill-ink-500 text-[9px]">0</text>
        {bars.map((b, i) => {
          const h = (b.value / maxV) * innerH;
          const x = PAD.left + i * (barW + gap) + gap / 2;
          const y = PAD.top + innerH - h;
          return (
            <g key={b.label}>
              <rect x={x} y={y} width={barW} height={Math.max(0, h)} rx={3} className={b.colorClass ?? colorClass?.(b.label) ?? 'fill-accent'}>
                <title>{`${b.label}: ${b.value}`}</title>
              </rect>
              <text x={x + barW / 2} y={CHART_H - 6} textAnchor="middle" className="fill-ink-500 text-[9px]">
                {b.label.length > 10 ? `${b.label.slice(0, 9)}…` : b.label}
              </text>
            </g>
          );
        })}
      </svg>
      {legend && legend.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {legend.map((l) => (
            <span key={l.label} className="flex items-center gap-1.5 text-2xs text-ink-400">
              <span className={`h-2 w-2 rounded-full ${l.colorClass}`} />
              {l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Tab = 'dashboard' | 'reports';

export function Analytics() {
  const [tab, setTab] = useState<Tab>('dashboard');

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="Headcount, attrition, absenteeism, leave liability, overtime and hiring, drawn from the records other People screens keep. A tile that has nothing to measure yet says so — it is never a silent zero."
      />
      <Tabs tabs={[{ key: 'dashboard', label: 'Dashboard' }, { key: 'reports', label: 'Reports' }]} active={tab} onChange={setTab} />
      {tab === 'dashboard' && <DashboardTab />}
      {tab === 'reports' && <ReportsTab />}
    </>
  );
}

function DashboardTab() {
  const dash = useQuery({ queryKey: ['hcm-analytics-dashboard'], queryFn: () => api.get<Dashboard>('/hcm/analytics/dashboard?months=12') });

  if (dash.isLoading) return <Loading label="Loading analytics" />;
  if (dash.error) return <ErrorBox error={dash.error} />;
  if (!dash.data) return null;
  const d = dash.data;

  const latestHeadcount = d.headcount.at(-1)?.headcount ?? 0;
  const joinersTotal = d.headcount.reduce((s, p) => s + p.joiners, 0);
  const leaversTotal = d.headcount.reduce((s, p) => s + p.leavers, 0);

  return (
    <div className="flex flex-col gap-5">
      {/* ---- KPI tiles ---- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Metric label="Current headcount" value={latestHeadcount} noActionReason="See the trend chart below." />
        <Metric label="Joiners (12 mo)" value={joinersTotal} noActionReason="See the trend chart below." />
        <Metric label="Leavers (12 mo)" value={leaversTotal} noActionReason="See the trend chart below." />
        <Metric
          label="Attrition (annualised)"
          value={pct(d.attrition.annualizedRatePct)}
          sub={`${d.attrition.leavers} left, avg headcount ${d.attrition.avgHeadcount.toFixed(1)}`}
          noActionReason="Computed over the trailing 12 months."
          tone={d.attrition.annualizedRatePct !== null && d.attrition.annualizedRatePct > 20 ? 'bad' : 'neutral'}
        />
        <Metric
          label="Early attrition"
          value={pct(d.attrition.earlyAttritionRatePct)}
          sub={`${d.attrition.earlyAttritionCount} of ${d.attrition.leavers} leavers, within 12 months of hire`}
          noActionReason="Share of leavers who left within a year of joining."
        />
        <Metric
          label="Absenteeism (3 mo)"
          value={pct(d.absenteeism.ratePct)}
          sub={`${d.absenteeism.zeroMinuteDays} of ${d.absenteeism.totalDays} recorded days`}
          noActionReason="Share of recorded attendance rows with zero worked minutes."
        />
        <Metric label="Overtime hours (3 mo)" value={num1(d.overtime.totalHours)} sub={d.overtime.totalAmount !== null ? money(d.overtime.totalAmount) : 'Amount withheld'} noActionReason="See the chart below." />
        <Metric label="Leave liability (days)" value={num1(d.leaveLiability.totalDays)} sub={d.leaveLiability.totalAmount !== null ? money(d.leaveLiability.totalAmount) : 'Amount withheld — no compensation grant'} noActionReason="Outstanding balance × basic/26 daily rate." />
        <Metric label="Time to hire" value={d.hiring.timeToHireDaysAvg !== null ? `${num1(d.hiring.timeToHireDaysAvg, 0)} days` : '—'} sub={`${d.hiring.hires} hires (12 mo)`} noActionReason="Requisition creation to hire-effective date, averaged." />
        <Metric label="Offer acceptance" value={pct(d.hiring.offerAcceptanceRatePct)} sub={`${d.hiring.offersAccepted} of ${d.hiring.offersExtended} offers`} noActionReason="By current application status." />
        {d.spanOfControl.measured ? (
          <Metric label="Span of control" value={num1((d.spanOfControl.value as SpanStats).averageSpan)} sub={`${(d.spanOfControl.value as SpanStats).managerCount} managers, ${(d.spanOfControl.value as SpanStats).minSpan}–${(d.spanOfControl.value as SpanStats).maxSpan} range`} noActionReason="Average direct reports per manager position." />
        ) : (
          <Metric label="Span of control" value={NOT_MEASURED} noActionReason={d.spanOfControl.reason ?? 'Not measured.'} />
        )}
        <MetricTile label="Training completions / head" metric={d.training.completionsPerHead} format={(v) => num1(v, 2)} noActionReason="Learning records completed in 12 months, per currently-employed head." />
        <MetricTile label="Cost per hire" metric={d.costPerHire} format={(v) => money(v)} noActionReason="Not measured." />
        <MetricTile label="Gender ratio" metric={d.genderRatio} format={() => '—'} noActionReason="Not measured." />
        <MetricTile
          label="Comp-ratio distribution"
          metric={d.compRatioDistribution}
          format={(v) => `${v.reduce((s, b) => s + b.count, 0)} employees`}
          noActionReason="Current CTC ÷ grade midpoint. See the chart below."
        />
        <MetricTile label="Engagement eNPS" metric={d.engagementEnps} format={(v) => num1(v, 0)} noActionReason="-100..100, from every pulse survey's eNPS question." />
        <MetricTile
          label="Open cases by SLA"
          metric={d.openCasesBySla}
          format={(v) => `${v.reduce((s, b) => s + b.count, 0)} open`}
          noActionReason="Confidential cases excluded. See the chart below."
        />
      </div>

      {/* ---- Charts ---- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Headcount trend" subtitle="Month-end headcount, trailing 12 months.">
          <LineChart points={d.headcount as unknown as Array<{ month: string; [k: string]: number | string }>} valueKey="headcount" label="Headcount" />
        </Card>

        <Card title="Headcount by division" subtitle="Current snapshot.">
          {d.byDivision.length === 0 ? (
            <EmptyState message="No one is currently assigned to a position." />
          ) : (
            <CategoricalBarChart
              bars={d.byDivision.map((b) => ({ label: DIVISION_LABEL[b.key] ?? b.key, value: b.headcount, colorClass: DIVISION_FILL[b.key] ?? 'fill-div-shared' }))}
              legend={d.byDivision.map((b) => ({ label: DIVISION_LABEL[b.key] ?? b.key, colorClass: DIVISION_BG[b.key] ?? 'bg-div-shared' }))}
            />
          )}
        </Card>

        <Card title="Headcount by location" subtitle="Current snapshot.">
          {d.byLocation.length === 0 ? (
            <EmptyState message="No one is currently assigned to a position." />
          ) : (
            <CategoricalBarChart bars={d.byLocation.map((b) => ({ label: b.key, value: b.headcount }))} />
          )}
        </Card>

        <Card title="Tenure distribution" subtitle={`${d.tenure.totalActive} currently employed.`}>
          <CategoricalBarChart bars={Object.entries(d.tenure.buckets).map(([label, value]) => ({ label, value }))} />
        </Card>

        <Card title="Overtime hours" subtitle="Trailing 3 months, from weekly overtime accrual.">
          <LineChart points={d.overtime.byMonth as unknown as Array<{ month: string; [k: string]: number | string }>} valueKey="hours" label="Overtime hours" />
        </Card>

        <Card title="Payroll cost trend" subtitle="Gross pay per period, trailing 12 months.">
          {d.payroll && d.payroll.length > 0 ? (
            <LineChart points={d.payroll.map((p) => ({ month: p.payPeriod, gross: p.gross })) as unknown as Array<{ month: string; [k: string]: number | string }>} valueKey="gross" label="Payroll gross" />
          ) : (
            <EmptyState message="No payroll runs recorded yet, or this account cannot see payroll figures." hint="Payroll cost trend needs the payroll:view grant at all scope." />
          )}
        </Card>

        <Card title="Comp-ratio distribution" subtitle="Current CTC ÷ this tenant's pay-grade midpoint, one bucket per employee.">
          {d.compRatioDistribution.measured ? (
            <CategoricalBarChart bars={d.compRatioDistribution.value.map((b) => ({ label: b.bucket, value: b.count }))} />
          ) : (
            <EmptyState message={d.compRatioDistribution.reason ?? NOT_MEASURED} />
          )}
        </Card>

        <Card title="Open cases by SLA" subtitle="Open, non-confidential HR helpdesk cases, by how close they are to breaching their SLA.">
          {d.openCasesBySla.measured ? (
            <CategoricalBarChart bars={d.openCasesBySla.value.map((b) => ({ label: b.bucket, value: b.count }))} />
          ) : (
            <EmptyState message={d.openCasesBySla.reason ?? NOT_MEASURED} />
          )}
        </Card>
      </div>
    </div>
  );
}

const REPORTS: Array<{ key: string; label: string; hint: string; path: string; filename: string }> = [
  { key: 'headcount', label: 'Headcount register', hint: 'Everyone currently employed: division, location, job title, hire date.', path: '/hcm/analytics/reports/headcount-register.csv', filename: 'headcount-register.csv' },
  { key: 'attrition', label: 'Attrition report', hint: 'Everyone who separated in the trailing 12 months, with early-attrition flagged.', path: '/hcm/analytics/reports/attrition.csv?months=12', filename: 'attrition-report.csv' },
  { key: 'leave-liability', label: 'Leave liability', hint: 'Outstanding leave balance and its estimated payout, by employee and leave type.', path: '/hcm/analytics/reports/leave-liability.csv', filename: 'leave-liability.csv' },
  { key: 'overtime', label: 'Overtime register', hint: 'Weekly overtime hours and pay, trailing 3 months.', path: '/hcm/analytics/reports/overtime.csv?months=3', filename: 'overtime-register.csv' },
  { key: 'training', label: 'Training register', hint: 'Learning enrolments and completions, trailing 12 months.', path: '/hcm/analytics/reports/training.csv?months=12', filename: 'training-register.csv' },
];

function ReportsTab() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(report: (typeof REPORTS)[number]) {
    setError(null);
    setPending(report.key);
    try {
      await api.download(report.path, report.filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The download failed.');
    } finally {
      setPending(null);
    }
  }

  return (
    <Card title="Reports" subtitle="Every export here is recorded in the audit trail (auditExport) with who ran it and how many rows it carried.">
      {error && <div className="mb-3"><ErrorBox error={new Error(error)} /></div>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {REPORTS.map((r) => (
          <div key={r.key} className="flex items-start justify-between gap-3 rounded-md border border-ink-800 bg-ink-900 p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink-100">{r.label}</p>
              <p className="mt-0.5 text-2xs text-ink-500">{r.hint}</p>
            </div>
            <button className="btn shrink-0 text-2xs" disabled={pending === r.key} onClick={() => download(r)}>
              {pending === r.key ? 'Preparing…' : 'Download CSV'}
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}
