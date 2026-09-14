/**
 * The cap table — who holds what, on two bases (issued and fully diluted).
 *
 * Table first, chart second (DESIGN.md, and the same order Executive.tsx
 * keeps): a shareholder checking their own stake reads a row, not a wedge.
 * The donut is by holder on the fully-diluted basis, which is the only place
 * this screen does arithmetic on the client — reshaping percentages the API
 * already computed into the shape `recharts` wants, never computing a new one.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { CapTableView } from '@kaizen/shared';
import { api, date, money } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui.js';

/**
 * A categorical palette for holders, distinct from `band.*`/`div.*` (those
 * are fixed data encodings for status and division, not this). Eight hues,
 * lightness varied as well as hue so the set stays distinguishable under
 * colour-vision deficiency, cycled if there are more than eight holders.
 */
const HOLDER_PALETTE = [
  '#2a78d6', '#c2670f', '#12805c', '#8f3d90',
  '#b5570c', '#1a7a4c', '#6b4fd6', '#a8481a',
];

function ChartTooltip({ active, payload }: { active?: boolean; payload?: unknown[] }) {
  if (!active || !payload?.length) return null;
  const row = (payload as Array<{ name?: string; value?: number; payload?: { fill?: string } }>)[0];
  return (
    <div className="rounded-md border border-ink-800 bg-ink-900 px-3 py-2 shadow-floating">
      <div className="flex items-center gap-2 text-xs">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: row.payload?.fill }} />
        <span className="text-ink-400">{row.name}</span>
        <span className="num ml-auto font-semibold">{row.value?.toFixed(2)}%</span>
      </div>
    </div>
  );
}

interface SpinOutDivisionSummary {
  division: string;
  carriedTotal: number;
  refusedTotal: number;
  command: string;
}
interface SpinOutDivisionsView {
  tenantKind: string;
  divisions: SpinOutDivisionSummary[];
}

const DIVISION_LABEL: Record<string, string> = { software: 'Software', skill: 'Skill', education: 'Education' };

/**
 * "Divisions" — not yet incorporated as their own tenant, read-only. Shown
 * only on a holding or standalone tenant that still has a division nobody
 * has spun out (equity-portal plan §6b). No commit from here: the spin-out is
 * a deliberate script, run by hand, with a preview of its own to argue with.
 */
function DivisionsCard() {
  const { data } = useQuery({
    queryKey: ['equity-spin-out-divisions'],
    queryFn: () => api.get<SpinOutDivisionsView>('/group/spin-out/preview'),
  });

  if (!data || data.divisions.length === 0) return null;

  return (
    <Card title="Divisions" subtitle="Not yet incorporated as their own entity." className="mb-4">
      <div className="divide-y divide-ink-800">
        {data.divisions.map((d) => (
          <div key={d.division} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-100">{DIVISION_LABEL[d.division] ?? d.division}</span>
              <span className="text-ink-400">
                {d.carriedTotal} row{d.carriedTotal === 1 ? '' : 's'} would carry
                {d.refusedTotal > 0 ? `, ${d.refusedTotal} refused` : ''}
              </span>
            </div>
            <code className="mono text-2xs text-ink-500">{d.command}</code>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function CapTable() {
  const [asOf, setAsOf] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['equity-cap-table', asOf],
    queryFn: () => api.get<CapTableView>(`/equity/cap-table${asOf ? `?asOf=${asOf}` : ''}`),
  });

  const { data: valuations } = useQuery({
    queryKey: ['equity-valuations', 'latest'],
    queryFn: () => api.get<{ items: Array<{ asOf: string; basis: string; perShareByClass: Record<string, number> }> }>('/equity/valuations'),
  });

  if (error) return <ErrorBox error={error} />;

  const latestValuation = valuations?.items?.[0] ?? null;
  const latestPerShare = latestValuation ? Object.values(latestValuation.perShareByClass)[0] : undefined;

  return (
    <div>
      <PageHeader
        title="Cap table"
        subtitle={
          latestValuation && latestPerShare !== undefined
            ? `Last valuation: ${money(latestPerShare)} per share, ${latestValuation.basis.replace(/_/g, ' ')}, ${date(latestValuation.asOf)}.`
            : 'No valuation on record.'
        }
        actions={
          <label className="flex items-center gap-2 text-xs text-ink-400">
            As of
            <input
              type="date"
              className="input w-auto"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </label>
        }
      />

      <DivisionsCard />

      {isLoading || !data ? (
        <Loading />
      ) : data.rows.length === 0 ? (
        <Card>
          <EmptyState
            message="No shares have been allotted yet."
            hint="Propose an allotment from the Register to bring the first holder onto this table."
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2" bodyClassName="p-0" subtitle={data.since ? `Since ${date(data.since)}` : undefined}>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Holder</th>
                    <th>Class</th>
                    <th className="text-right">Count</th>
                    <th className="text-right">Issued %</th>
                    <th className="text-right">Fully diluted %</th>
                    <th>Certificates</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={`${r.holderId}:${r.shareClassId}`}>
                      <td>
                        <Link to={`/equity/holders/${r.holderId}`} className="text-ink-100 hover:text-accent-soft">
                          {r.holderName}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {r.pendingConsideration && (
                            <span className="chip border-band-watch/40 bg-band-watch/10 text-band-watch">
                              Awaiting consideration
                            </span>
                          )}
                          {r.certificateOverdue && (
                            <span className="chip border-band-critical/40 bg-band-critical/10 text-band-critical">
                              Certificate overdue
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="text-ink-300">{r.shareClassName}</td>
                      <td className="text-right tabular-nums">{r.count.toLocaleString('en-IN')}</td>
                      <td className="text-right tabular-nums">{r.issuedPct.toFixed(2)}%</td>
                      <td className="text-right tabular-nums">{r.fullyDilutedPct.toFixed(2)}%</td>
                      <td>
                        {r.certificateNumbers.length === 0 ? (
                          <span className="text-2xs text-ink-500">none yet</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {r.certificateNumbers.map((n) => (
                              <span key={n} className="mono text-2xs text-ink-400">
                                {n}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {data.holderTotals.map((h) => (
                    <tr key={h.holderId} className="total-row">
                      <td colSpan={2}>{h.holderName} — total</td>
                      <td className="text-right tabular-nums">{h.totalCount.toLocaleString('en-IN')}</td>
                      <td className="text-right tabular-nums">{h.issuedPct.toFixed(2)}%</td>
                      <td className="text-right tabular-nums">{h.fullyDilutedPct.toFixed(2)}%</td>
                      <td />
                    </tr>
                  ))}
                </tfoot>
              </table>
            </div>
          </Card>

          <Card title="By holder" subtitle="Fully-diluted basis.">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.holderTotals.map((h, i) => ({
                      name: h.holderName,
                      value: h.fullyDilutedPct,
                      fill: HOLDER_PALETTE[i % HOLDER_PALETTE.length],
                    }))}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="55%"
                    outerRadius="85%"
                    paddingAngle={1}
                  >
                    {data.holderTotals.map((h, i) => (
                      <Cell key={h.holderId} fill={HOLDER_PALETTE[i % HOLDER_PALETTE.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip />} />
                  <Legend
                    layout="vertical"
                    align="right"
                    verticalAlign="middle"
                    wrapperStyle={{ fontSize: 11 }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
