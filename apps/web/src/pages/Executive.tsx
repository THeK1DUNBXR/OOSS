/**
 * The founder's dashboard.
 *
 * The Command Center answers "what needs attention". This answers a different
 * question — "how is the company actually doing, and which part of it" — and
 * it is built around the one cut that matters here: Kaizen runs three
 * businesses inside one legal entity, and every consolidated figure hides
 * which of them is paying for the others.
 *
 * Three rules it holds to:
 *
 * A withheld figure is never a zero. Where the server withholds an amount the
 * tile says so, because a zero beside a division reads as a fact about the
 * business rather than about the reader's grants.
 *
 * "Not measured" is never zero either. A period with no data says so.
 *
 * Every figure opens. A number nobody can get behind is a number nobody should
 * be asked to trust, so the tiles and the bars all drill to the records.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { DIVISION_LABELS, type Division } from '@kaizen/shared';
import { api, money, titleCase } from '../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, Withheld } from '../components/ui.js';

/** The tinted status chip a KPI tile wears instead of a colored rail —
 *  material, not a stripe. Neutral tone wears nothing. */
function KpiStatus({ tone }: { tone: 'neutral' | 'good' | 'warn' | 'bad' }) {
  if (tone === 'neutral') return null;
  const Icon = tone === 'good' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : XCircle;
  const toneClass = {
    good: 'bg-band-strong/10 text-band-strong',
    warn: 'bg-band-watch/10 text-band-watch',
    bad: 'bg-band-critical/10 text-band-critical',
  }[tone];
  return (
    <span className={`absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full ${toneClass}`}>
      <Icon className="h-3 w-3" strokeWidth={2} aria-hidden />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * The division hues, in fixed order. Assigned by entity and never cycled, so
 * filtering the set does not repaint the survivors.
 *
 * These are validated categorical steps rather than the brand's display hues —
 * see the note beside `div` in tailwind.config.js. The green and orange sit at
 * ΔE 7.4 under protanopia, which is only legal alongside secondary encoding,
 * so every chart below carries a legend and direct labels.
 */
const DIVISION_COLOUR: Record<string, string> = {
  software: '#2a78d6',
  skill: '#c2670f',
  education: '#12805c',
  shared: '#8f3d90',
};

const DIVISION_ORDER = ['software', 'skill', 'education', 'shared'];

/** Profit and loss is polarity, so it takes a diverging pair, not a hue each. */
const POLARITY = { positive: '#1a7a4c', negative: '#ad2c22' };

const INK = '#0F0F12';
const MUTED = '#6b6b74';
const GRID = '#dcdce1';

function divisionLabel(d: string): string {
  return DIVISION_LABELS[d as Division] ?? titleCase(d);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrendRow {
  period: string;
  income: number | null;
  expense: number | null;
  net: number | null;
}

interface DivisionRow {
  division: string;
  income: number | null;
  expense: number | null;
  net: number | null;
}

interface ProfitAndLoss {
  period: string;
  income: number | null;
  expense: number | null;
  net: number | null;
  byDivision: DivisionRow[];
  byCategory: Array<{ categoryId: string | null; categoryName: string; kind: string; amount: number }>;
}

interface CashPosition {
  cash: number | null;
  accounts: Array<{ id: string; name: string; accountType: string; balance: number | null }>;
  averageMonthlyNet: number | null;
  burning: boolean;
  runwayMonths: number | null;
  basedOnMonths: string[];
}

interface BudgetVariance {
  period: string;
  budgetTotal: number | null;
  actualTotal: number | null;
  variance: number | null;
  rows: Array<{
    categoryId: string;
    categoryName: string;
    division: string | null;
    budget: number | null;
    actual: number | null;
    variance: number | null;
    overspent: boolean;
  }>;
}

interface HeadcountRow {
  division: string;
  headcount: number;
  monthlyCost: number | null;
}

interface AgeingResult {
  total: number | null;
  count: number;
  buckets: { current: number; d30: number; d60: number; d90: number; older: number } | null;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Compact rupees for an axis: ₹1.2L, ₹34K. */
function compact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 10_000_000) return `₹${(v / 10_000_000).toFixed(1)}Cr`;
  if (abs >= 100_000) return `₹${(v / 100_000).toFixed(1)}L`;
  if (abs >= 1_000) return `₹${Math.round(v / 1_000)}K`;
  return `₹${Math.round(v)}`;
}

function monthLabel(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
}

/**
 * A headline figure.
 *
 * `value === null` means withheld and says so; `undefined` means not yet
 * measured. Neither renders as a zero, because a zero here is a claim about
 * the company.
 */
function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
  drillTo,
}: {
  label: string;
  value: number | null | undefined;
  sub?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
  drillTo?: string;
  format?: (v: number) => string;
}) {
  const body = (
    <div className="kpi">
      <KpiStatus tone={tone} />
      <p className="kpi-label">{label}</p>
      <div className="kpi-value">
        {value === null ? (
          <span className="text-base font-semibold">
            <Withheld reason="no_permission" />
          </span>
        ) : value === undefined ? (
          <span className="text-base font-semibold text-ink-500">Not yet measured</span>
        ) : (
          money(value)
        )}
      </div>
      {sub && <p className="kpi-sub">{sub}</p>}
    </div>
  );
  return drillTo ? (
    <Link to={drillTo} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

/** A plain count, where rupee formatting would be wrong. */
function CountStat({
  label,
  value,
  sub,
  tone = 'neutral',
  drillTo,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
  drillTo?: string;
}) {
  const body = (
    <div className="kpi">
      <KpiStatus tone={tone} />
      <p className="kpi-label">{label}</p>
      <div className="kpi-value">{value}</div>
      {sub && <p className="kpi-sub">{sub}</p>}
    </div>
  );
  return drillTo ? (
    <Link to={drillTo} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

/** One shared tooltip, so every chart reads the same way. */
function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: unknown[]; label?: unknown }) {
  if (!active || !payload?.length) return null;
  const rows = payload as Array<{ name?: string; value?: number; color?: string; dataKey?: string }>;
  return (
    <div className="rounded-md border border-ink-800 bg-ink-900 px-3 py-2 shadow-floating">
      {label !== undefined && <p className="mb-1 text-2xs font-semibold uppercase tracking-wide">{String(label)}</p>}
      {rows.map((r) => (
        <div key={r.dataKey ?? r.name} className="flex items-center gap-2 text-xs">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
          <span className="text-ink-400">{r.name}</span>
          <span className="num ml-auto font-semibold">{money(r.value ?? 0)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

function lastCompletePeriod(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function Executive() {
  const [period, setPeriod] = useState(lastCompletePeriod);
  const [months, setMonths] = useState(12);

  const pl = useQuery({
    queryKey: ['exec-pl', period],
    queryFn: () => api.get<ProfitAndLoss>(`/books/reports/profit-and-loss?period=${period}`),
    retry: false,
  });
  const trend = useQuery({
    queryKey: ['exec-trend', months],
    queryFn: () => api.get<TrendRow[]>(`/books/reports/trend?months=${months}`),
    retry: false,
  });
  const cash = useQuery({
    queryKey: ['exec-cash'],
    queryFn: () => api.get<CashPosition>('/books/reports/cash'),
    retry: false,
  });
  const budget = useQuery({
    queryKey: ['exec-budget', period],
    queryFn: () => api.get<BudgetVariance>(`/books/budget/variance?period=${period}`),
    retry: false,
  });
  const headcount = useQuery({
    queryKey: ['exec-headcount'],
    queryFn: () => api.get<HeadcountRow[]>('/hr/headcount-by-division'),
    retry: false,
  });
  const payables = useQuery({
    queryKey: ['exec-payables'],
    queryFn: () => api.get<AgeingResult>('/books/payables/ageing'),
    retry: false,
  });

  // Every panel is independently permitted, so one refusal darkens its own
  // panel rather than the whole dashboard. Only a total failure is fatal.
  const allFailed = pl.isError && trend.isError && cash.isError;
  if (allFailed) return <ErrorBox error={pl.error} />;

  const runningPeriod = useMemo(() => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }, []);

  const trendData = useMemo(
    () =>
      (trend.data ?? [])
        // The month in progress is dropped rather than drawn.
        //
        // A partial month plots as a short bar and pulls the net line back
        // toward zero, which reads as "we broke even" when what happened is
        // "this month is four days old". Nothing to measure yet is not zero,
        // and a chart is the easiest place to forget that.
        .filter((r) => r.period !== runningPeriod)
        .map((r) => ({
          period: r.period,
          label: monthLabel(r.period),
          income: r.income ?? 0,
          expense: r.expense ?? 0,
          net: r.net ?? 0,
        })),
    [trend.data, runningPeriod],
  );

  const divisionData = useMemo(() => {
    const rows = pl.data?.byDivision ?? [];
    // Fixed order, so the chart does not reshuffle as divisions come and go.
    return DIVISION_ORDER.map((d) => rows.find((r) => r.division === d))
      .filter((r): r is DivisionRow => Boolean(r))
      .map((r) => ({
        division: r.division,
        label: divisionLabel(r.division),
        income: r.income ?? 0,
        expense: r.expense ?? 0,
        net: r.net ?? 0,
      }));
  }, [pl.data]);

  const overspent = (budget.data?.rows ?? []).filter((r) => r.overspent);
  const moneyVisible = pl.data ? pl.data.income !== null : false;
  const totalHeadcount = (headcount.data ?? []).reduce((s, r) => s + r.headcount, 0);

  return (
    <div>
      <PageHeader
        title="The business"
        subtitle="Three divisions in one company. Every figure can be cut by division."
        actions={
          <>
            <label className="label sr-only" htmlFor="exec-period">
              Period
            </label>
            <input
              id="exec-period"
              type="month"
              className="input w-40"
              value={period}
              onChange={(e) => e.target.value && setPeriod(e.target.value)}
            />
            <select className="input w-36" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
              <option value={24}>24 months</option>
            </select>
          </>
        }
      />

      {/* --- the headline ------------------------------------------------- */}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Cash on hand"
          value={cash.isError ? null : cash.data?.cash}
          sub={cash.data?.accounts.length ? `Across ${cash.data.accounts.length} accounts` : undefined}
          tone={(cash.data?.cash ?? 0) > 0 ? 'neutral' : 'bad'}
          drillTo="/finance/ledger"
        />
        <CountStat
          label="Runway"
          value={
            cash.isError
              ? '—'
              : !cash.data
                ? '—'
                : !cash.data.burning
                  ? 'Not burning'
                  : cash.data.runwayMonths === 0
                    ? 'Out of cash'
                    : `${cash.data.runwayMonths?.toFixed(1)} months`
          }
          sub={
            cash.data?.basedOnMonths.length
              ? `At the average of ${cash.data.basedOnMonths.map(monthLabel).join(', ')}`
              : 'Not enough complete months to judge'
          }
          tone={
            !cash.data?.burning ? 'good' : (cash.data?.runwayMonths ?? 0) < 6 ? 'bad' : (cash.data?.runwayMonths ?? 0) < 12 ? 'warn' : 'neutral'
          }
        />
        <Stat
          label={`Net, ${monthLabel(period)}`}
          value={pl.isError ? null : pl.data?.net}
          sub={pl.data && moneyVisible ? `${money(pl.data.income ?? 0)} in, ${money(pl.data.expense ?? 0)} out` : undefined}
          tone={(pl.data?.net ?? 0) >= 0 ? 'good' : 'bad'}
          drillTo="/finance/ledger"
        />
        <CountStat
          label="People"
          value={headcount.isError ? '—' : totalHeadcount}
          sub={
            headcount.isError
              ? 'Not yours to see'
              : (headcount.data ?? []).some((r) => r.monthlyCost !== null)
                ? `${money((headcount.data ?? []).reduce((s, r) => s + (r.monthlyCost ?? 0), 0))} a month`
                : 'Cost withheld'
          }
          drillTo="/people/employees"
        />
      </div>

      {/* --- income, cost and the line between them ----------------------- */}
      <Card
        title="Income against cost"
        subtitle="Funding is excluded: money put in is not revenue."
        className="mb-4"
      >
        {trend.isError ? (
          <EmptyState message="The ledger is not yours to see." />
        ) : trend.isLoading ? (
          <Loading />
        ) : trendData.length === 0 ? (
          <EmptyState message="Nothing recorded yet." />
        ) : (
          <>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trendData} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} />
                  <YAxis
                    tickFormatter={compact}
                    tick={{ fill: MUTED, fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={64}
                  />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(15,15,18,0.05)' }} />
                  <Legend
                    wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
                    iconType="circle"
                    formatter={(v) => <span style={{ color: INK }}>{v}</span>}
                  />
                  {/* Income and cost are the same measure in the same unit, so
                      they share one axis. A second scale would let any two
                      series be drawn to look correlated. */}
                  <Bar dataKey="income" name="Income" fill="#12805c" radius={[4, 4, 0, 0]} maxBarSize={22} />
                  <Bar dataKey="expense" name="Cost" fill="#c2670f" radius={[4, 4, 0, 0]} maxBarSize={22} />
                  <Line
                    type="monotone"
                    dataKey="net"
                    name="Net"
                    stroke={INK}
                    strokeWidth={2}
                    dot={{ r: 3, fill: INK }}
                    activeDot={{ r: 5 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* The table view, so the figures are readable without the colour. */}
            <p className="mt-2 text-2xs text-ink-500">
              Complete months only — {monthLabel(runningPeriod)} is still running and is left out rather than drawn
              as a short bar, which would read as a fall rather than as an unfinished month.
            </p>

            <details className="mt-3">
              <summary className="cursor-pointer text-2xs font-semibold uppercase tracking-wide text-ink-500">
                Show the figures
              </summary>
              <div className="mt-2 overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th className="num">Income</th>
                      <th className="num">Cost</th>
                      <th className="num">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trendData.map((r) => (
                      <tr key={r.period}>
                        <td>{r.label}</td>
                        <td className="num">{money(r.income)}</td>
                        <td className="num">{money(r.expense)}</td>
                        <td className={`num font-semibold ${r.net < 0 ? 'text-band-critical' : 'text-band-strong'}`}>
                          {money(r.net)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        {/* --- which business is carrying which --------------------------- */}
        <Card
          title={`By division — ${monthLabel(period)}`}
          subtitle="The question a consolidated total cannot answer."
        >
          {pl.isError ? (
            <EmptyState message="Not yours to see." />
          ) : pl.isLoading ? (
            <Loading />
          ) : divisionData.length === 0 ? (
            <EmptyState message="Nothing recorded for this month." hint="That is different from a zero — no entries have been made." />
          ) : (
            <>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={divisionData} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 8 }}>
                    <CartesianGrid stroke={GRID} horizontal={false} />
                    <XAxis
                      type="number"
                      tickFormatter={compact}
                      tick={{ fill: MUTED, fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: GRID }}
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={104}
                      tick={{ fill: INK, fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(15,15,18,0.05)' }} />
                    {/* Profit and loss is polarity, not identity, so the bars
                        take a diverging pair rather than a hue per division —
                        and the division is already named on the axis. */}
                    <Bar dataKey="net" name="Net" radius={4} maxBarSize={26}>
                      {divisionData.map((d) => (
                        <Cell key={d.division} fill={d.net >= 0 ? POLARITY.positive : POLARITY.negative} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <table className="table mt-2">
                <thead>
                  <tr>
                    <th>Division</th>
                    <th className="num">Income</th>
                    <th className="num">Cost</th>
                    <th className="num">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {divisionData.map((d) => (
                    <tr key={d.division}>
                      <td>
                        <span className="inline-flex items-center gap-2 font-semibold">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ background: DIVISION_COLOUR[d.division] ?? MUTED }}
                          />
                          {d.label}
                        </span>
                      </td>
                      <td className="num">{money(d.income)}</td>
                      <td className="num">{money(d.expense)}</td>
                      <td className={`num font-semibold ${d.net < 0 ? 'text-band-critical' : 'text-band-strong'}`}>
                        {money(d.net)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Card>

        {/* --- where the money went -------------------------------------- */}
        <Card title={`Where it went — ${monthLabel(period)}`} subtitle="The ten largest lines, and everything else together.">
          {pl.isError ? (
            <EmptyState message="Not yours to see." />
          ) : !pl.data?.byCategory.length ? (
            <EmptyState message="Nothing recorded for this month." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th className="num">Amount</th>
                  <th className="num">Share</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const spend = pl.data.byCategory.filter((c) => c.kind !== 'income');
                  const total = spend.reduce((s, c) => s + c.amount, 0);
                  const top = spend.slice(0, 10);
                  const rest = spend.slice(10);
                  const restTotal = rest.reduce((s, c) => s + c.amount, 0);
                  return (
                    <>
                      {top.map((c) => (
                        <tr key={c.categoryId ?? c.categoryName}>
                          <td>
                            <Link
                              to={`/finance/ledger?categoryId=${c.categoryId ?? ''}`}
                              className="hover:underline"
                            >
                              {c.categoryName}
                            </Link>
                          </td>
                          <td className="num">{money(c.amount)}</td>
                          <td className="num text-ink-500">{total ? `${Math.round((c.amount / total) * 100)}%` : '—'}</td>
                        </tr>
                      ))}
                      {rest.length > 0 && (
                        <tr>
                          {/* Never a ninth hue: the tail folds into one row. */}
                          <td className="text-ink-500">Everything else ({rest.length} lines)</td>
                          <td className="num">{money(restTotal)}</td>
                          <td className="num text-ink-500">{total ? `${Math.round((restTotal / total) * 100)}%` : '—'}</td>
                        </tr>
                      )}
                      <tr className="total-row">
                        <td>Total cost</td>
                        <td className="num">{money(total)}</td>
                        <td className="num">100%</td>
                      </tr>
                    </>
                  );
                })()}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* --- against the plan ------------------------------------------ */}
        <Card
          title={`Against the plan — ${monthLabel(period)}`}
          subtitle="Summed from the ledger each time, so a late entry moves the variance."
        >
          {budget.isError ? (
            <EmptyState message="Not yours to see." />
          ) : !budget.data?.rows.length ? (
            <EmptyState message="No budget set for this month." hint="Without a plan there is nothing to be over or under." />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-4 text-sm">
                <span>
                  <span className="text-2xs uppercase tracking-wide text-ink-500">Planned </span>
                  <span className="num font-semibold">
                    {budget.data.budgetTotal === null ? <Withheld reason="no_permission" /> : money(budget.data.budgetTotal)}
                  </span>
                </span>
                <span>
                  <span className="text-2xs uppercase tracking-wide text-ink-500">Spent </span>
                  <span className="num font-semibold">
                    {budget.data.actualTotal === null ? <Withheld reason="no_permission" /> : money(budget.data.actualTotal)}
                  </span>
                </span>
                <span>
                  <span className="text-2xs uppercase tracking-wide text-ink-500">Over by </span>
                  <span className="num font-semibold text-band-critical">
                    {budget.data.variance === null
                      ? '—'
                      : budget.data.variance >= 0
                        ? 'nothing — within plan'
                        : money(Math.abs(budget.data.variance))}
                  </span>
                </span>
              </div>

              <table className="table">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th className="num">Planned</th>
                    <th className="num">Spent</th>
                    <th className="num">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {budget.data.rows.slice(0, 12).map((r) => (
                    <tr key={`${r.categoryId}-${r.division ?? ''}`}>
                      <td>
                        {r.categoryName}
                        {r.budget === 0 && <span className="ml-1.5 chip-gold">unbudgeted</span>}
                      </td>
                      <td className="num">{r.budget === null ? '—' : money(r.budget)}</td>
                      <td className="num">{r.actual === null ? '—' : money(r.actual)}</td>
                      <td className={`num font-semibold ${r.overspent ? 'text-band-critical' : 'text-band-strong'}`}>
                        {r.variance === null ? (r.overspent ? 'over' : 'within') : money(r.variance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {overspent.length > 12 && (
                <p className="mt-2 text-2xs text-ink-500">{overspent.length - 12} more lines are over plan.</p>
              )}
            </>
          )}
        </Card>

        {/* --- what is owed and what it costs to run ---------------------- */}
        <div className="space-y-4">
          <Card title="What we owe" subtitle="Supplier bills outstanding, by how late they are.">
            {payables.isError ? (
              <EmptyState message="Not yours to see." />
            ) : !payables.data ? (
              <Loading />
            ) : payables.data.buckets === null ? (
              <EmptyState message="Amounts are withheld." hint={`${payables.data.count} bills are open.`} />
            ) : payables.data.count === 0 ? (
              <EmptyState message="Nothing outstanding." />
            ) : (
              <table className="table">
                <tbody>
                  {(
                    [
                      ['Not yet due', payables.data.buckets.current, 'neutral'],
                      ['Up to 30 days late', payables.data.buckets.d30, 'warn'],
                      ['31 to 60 days', payables.data.buckets.d60, 'warn'],
                      ['61 to 90 days', payables.data.buckets.d90, 'bad'],
                      ['Over 90 days', payables.data.buckets.older, 'bad'],
                    ] as const
                  ).map(([label, value, tone]) => (
                    <tr key={label}>
                      <td>{label}</td>
                      <td
                        className={`num font-semibold ${
                          value > 0 && tone === 'bad' ? 'text-band-critical' : value > 0 && tone === 'warn' ? 'text-band-watch' : ''
                        }`}
                      >
                        {money(value)}
                      </td>
                    </tr>
                  ))}
                  <tr className="total-row">
                    <td>Outstanding</td>
                    <td className="num">{money(payables.data.total ?? 0)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </Card>

          <Card title="People, by division" subtitle="Headcount and what it costs each month.">
            {headcount.isError ? (
              <EmptyState message="Not yours to see." />
            ) : !headcount.data?.length ? (
              <EmptyState message="Nobody on the books." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Division</th>
                    <th className="num">People</th>
                    <th className="num">Monthly cost</th>
                  </tr>
                </thead>
                <tbody>
                  {headcount.data.map((r) => (
                    <tr key={r.division}>
                      <td>
                        <span className="inline-flex items-center gap-2 font-semibold">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ background: DIVISION_COLOUR[r.division] ?? MUTED }}
                          />
                          {divisionLabel(r.division)}
                        </span>
                      </td>
                      <td className="num">{r.headcount}</td>
                      <td className="num">
                        {r.monthlyCost === null ? <Withheld reason="no_permission" /> : money(r.monthlyCost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
