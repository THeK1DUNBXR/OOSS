/**
 * Marketing Overview — the KPI row, the funnel, live campaigns and the
 * attention list. Every tile that has never been measured says so; it never
 * shows a bare zero, which would read as "measured, and it's zero."
 */

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { CAMPAIGN_STATUS_LABELS } from '@kaizen/shared';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, RecordCode, StatusChip } from '../../components/ui.js';
import { NOT_MEASURED } from '../../lib/words.js';
import { money } from '../../lib/api.js';
import { useMarketingOverview, type MeasuredKpi } from '../../lib/marketingApi.js';

// Recharts takes literal SVG/CSS color props, not Tailwind classes, so these
// mirror tailwind.config.js's `ink`/`div` steps by value rather than name:
// FUNNEL_COLOUR is `div-software`, MUTED is `ink-500`, GRID is `ink-800`
// (the hairline), and SURFACE below is `ink-900` — the same steps
// Executive.tsx and CommandCenter.tsx pick their chart colours from.
const FUNNEL_COLOUR = '#2a78d6';
const MUTED = '#6b6b74';
const GRID = '#e7e7eb';
const SURFACE = '#ffffff';

function KpiTile({ kpi }: { kpi: MeasuredKpi }) {
  return (
    <div className="kpi">
      <p className="kpi-label">{kpi.label}</p>
      {kpi.measured ? (
        <>
          <p className="kpi-value">
            {kpi.unit === 'currency' ? money(kpi.value) : kpi.unit === 'percent' ? `${(kpi.value ?? 0).toFixed(1)}%` : (kpi.value ?? 0).toLocaleString('en-IN')}
          </p>
          {kpi.delta !== undefined && kpi.delta !== null && (
            <p className={`mt-1 text-2xs ${kpi.delta >= 0 ? 'text-band-strong' : 'text-band-critical'}`}>
              {kpi.delta >= 0 ? '▲' : '▼'} {Math.abs(kpi.delta).toFixed(1)}% vs prior period
            </p>
          )}
        </>
      ) : (
        <p className="mt-1.5 text-xs italic text-ink-500">{NOT_MEASURED}</p>
      )}
    </div>
  );
}

export function MarketingOverview() {
  const { data, isLoading, error } = useMarketingOverview();

  if (isLoading) return <Loading label="Loading marketing overview" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const funnelData = data.funnel.stages.map((s) => ({ label: s.label, count: s.measured ? s.count : 0, measured: s.measured }));
  const anyFunnelMeasured = data.funnel.stages.some((s) => s.measured);

  return (
    <div>
      <PageHeader title="Marketing overview" subtitle="Is enough new interest coming in, and is it converting?" />

      {data.kpis.length === 0 ? (
        <Card className="mb-5">
          <EmptyState message="No KPIs to show yet." />
        </Card>
      ) : (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {data.kpis.map((k) => (
            <KpiTile key={k.key} kpi={k} />
          ))}
        </div>
      )}

      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card title="The funnel" subtitle="Touchpoints through to enrolments, this period." className="lg:col-span-2">
          {!anyFunnelMeasured ? (
            <EmptyState message="Nothing to measure yet." hint="The funnel fills in once touchpoints and leads start being recorded against campaigns." />
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={funnelData} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} />
                  <YAxis tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#ffffff', border: `1px solid ${GRID}`, borderRadius: '8px', fontSize: '12px' }}
                    formatter={(v: number, _n, entry) => [(entry?.payload?.measured ? v : NOT_MEASURED), 'Count']}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {funnelData.map((d, i) => (
                      <Cell key={i} fill={d.measured ? FUNNEL_COLOUR : '#d7d7dd'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {data.funnel.conversionRates.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-3 border-t border-ink-800 pt-3 text-2xs text-ink-400">
              {data.funnel.conversionRates.map((r) => (
                <span key={`${r.from}-${r.to}`}>
                  {r.from} → {r.to}: <span className="font-semibold text-ink-200">{r.rate === null ? NOT_MEASURED : `${(r.rate * 100).toFixed(1)}%`}</span>
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card title="Needs a look" subtitle="Items worth attention right now.">
          {data.attention.length === 0 ? (
            <EmptyState message="Nothing needs attention." />
          ) : (
            <ul className="flex flex-col divide-y divide-ink-800">
              {data.attention.map((a) => (
                <li key={a.code} className="flex items-center justify-between gap-2 py-2 text-xs">
                  <span className="text-ink-300" title={a.code}>
                    {a.label}
                  </span>
                  <span className="chip border-band-watch/40 bg-band-watch/10 text-band-watch">{a.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Live campaigns" subtitle="Campaigns currently running.">
        {data.liveCampaigns.length === 0 ? (
          <EmptyState message="No campaigns are live right now." hint="A campaign shows here once it has been launched." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Campaign</th>
                  <th>Division</th>
                  <th>Status</th>
                  <th className="text-right">Budget</th>
                  <th>Ends</th>
                </tr>
              </thead>
              <tbody>
                {data.liveCampaigns.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <RecordCode code={c.recordCode} to={`/marketing/campaigns/${c.id}`} />
                    </td>
                    <td>
                      <Link to={`/marketing/campaigns/${c.id}`} className="text-xs font-medium text-ink-100 hover:text-accent-soft">
                        {c.name}
                      </Link>
                    </td>
                    <td className="text-xs text-ink-300">{c.division}</td>
                    <td>
                      <StatusChip status={CAMPAIGN_STATUS_LABELS[c.status]} tone="good" />
                    </td>
                    <td className="text-right tabular-nums text-xs">{money(c.budgetActual)} / {money(c.budgetPlanned)}</td>
                    <td className="text-xs text-ink-400">{c.endAt.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
