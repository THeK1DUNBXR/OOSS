/**
 * Holdings — what a shareholder holds, and where. No prices: `holdingsFor()`
 * returns none, and none are invented here (equity-portal plan §7).
 */
import { useQuery } from '@tanstack/react-query';
import type { HoldingsView, ValuationView } from '@kaizen/shared';
import { api, date, money } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui.js';

export function Holdings() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['equity-holdings', 'me'],
    queryFn: () => api.get<HoldingsView>('/equity/holdings/me'),
  });

  // Not every viewer of this screen holds a valuations grant — a director
  // does, most shareholders do not — so a refusal here is read as "nothing to
  // show" rather than surfaced as an error on a screen about somebody's own
  // shares.
  const { data: valuations } = useQuery({
    queryKey: ['equity-valuations', 'latest'],
    queryFn: () => api.get<{ items: ValuationView[] }>('/equity/valuations'),
    retry: false,
    throwOnError: false,
  });

  if (error) return <ErrorBox error={error} />;

  const latest = valuations?.items?.[0];
  const latestPerShare = latest ? Object.values(latest.perShareByClass)[0] : undefined;

  return (
    <div>
      <PageHeader title="Holdings" />

      {isLoading || !data ? (
        <Loading />
      ) : data.rows.length === 0 ? (
        <EmptyState
          message="No shareholding has been recorded for you yet."
          hint="Your holdings appear here the day an allotment or transfer to you is made effective."
        />
      ) : (
        <div className="space-y-4">
          {latest && latestPerShare !== undefined && (
            <p className="text-xs text-ink-400">
              Last valuation: {money(latestPerShare)} per share, {latest.basis.replace(/_/g, ' ')}, {date(latest.asOf)}.
            </p>
          )}
          <Card bodyClassName="p-0">
            <table className="table">
              <thead>
                <tr>
                  <th>Class</th>
                  <th className="text-right">Count</th>
                  <th>Certificates</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.shareClassId}>
                    <td className="text-ink-100">{r.shareClassName}</td>
                    <td className="text-right tabular-nums">{r.count.toLocaleString('en-IN')}</td>
                    <td className="mono text-2xs text-ink-400">{r.certificateNumbers.join(', ') || 'none yet'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}
