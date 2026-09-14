/**
 * The one-snapshot view — `GET /group/entities/:sourceTenantId`, read-only.
 * Reached from a group tile when the session's own entity list does not
 * include that tenant (equity-portal plan §6, phase 2).
 */
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, dateTime, money } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui.js';

interface SnapshotView {
  sourceTenantId: string;
  sourceName: string;
  originDivision: string | null;
  asOf: string;
  publishedAt: string;
  staleSeconds: number;
  stale: boolean;
  capTable: { rows: Array<{ holderName: string; shareClassName: string; count: number; issuedPct: number; fullyDilutedPct: number }> };
  financial: { period: string; cash: number | null; pnlMonth: { income: number; expense: number; net: number } | null; headcount: Array<{ division: string; headcount: number }> };
  compliance: { dematStatus: string | null; isSmallCompany: boolean | null; certificateOverdueCount: number; kind: string };
  valuation: { asOf: string; basis: string; equityValue: number | null } | null;
}

export function GroupEntity() {
  const { sourceTenantId } = useParams<{ sourceTenantId: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ['group-entity-view', sourceTenantId],
    queryFn: () => api.get<SnapshotView>(`/group/entities/${sourceTenantId}`),
    enabled: Boolean(sourceTenantId),
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Loading label="Reading the published snapshot" />;

  return (
    <div>
      <PageHeader
        title={data.sourceName}
        subtitle={
          <>
            as published {dateTime(data.publishedAt)}
            {data.stale && <span className="ml-2 chip border-band-critical/40 bg-band-critical/10 text-band-critical">Stale</span>}
            {' — read-only. Switch entity from the group screen to open this entity\'s own register, if your relationships there allow it.'}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Cap table" bodyClassName="p-0">
          {data.capTable.rows.length === 0 ? (
            <EmptyState message="No shares have been allotted yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Holder</th>
                    <th>Class</th>
                    <th className="text-right">Issued %</th>
                    <th className="text-right">Fully diluted %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.capTable.rows.map((r, i) => (
                    <tr key={i}>
                      <td>{r.holderName}</td>
                      <td className="text-ink-300">{r.shareClassName}</td>
                      <td className="text-right tabular-nums">{r.issuedPct.toFixed(2)}%</td>
                      <td className="text-right tabular-nums">{r.fullyDilutedPct.toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Financial summary" subtitle={data.financial.period}>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <dt className="text-ink-400">Cash</dt>
            <dd className="text-right tabular-nums text-ink-100">{money(data.financial.cash)}</dd>
            <dt className="text-ink-400">P&amp;L, net (month)</dt>
            <dd className="text-right tabular-nums text-ink-100">{data.financial.pnlMonth ? money(data.financial.pnlMonth.net) : '—'}</dd>
            <dt className="text-ink-400">Headcount</dt>
            <dd className="text-right tabular-nums text-ink-100">{data.financial.headcount.reduce((s, r) => s + r.headcount, 0)}</dd>
          </dl>
        </Card>

        <Card title="Compliance">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <dt className="text-ink-400">Demat status</dt>
            <dd className="text-right text-ink-100">{data.compliance.dematStatus ?? '—'}</dd>
            <dt className="text-ink-400">Small company</dt>
            <dd className="text-right text-ink-100">{data.compliance.isSmallCompany === null ? '—' : data.compliance.isSmallCompany ? 'Yes' : 'No'}</dd>
            <dt className="text-ink-400">Certificates overdue</dt>
            <dd className="text-right tabular-nums text-ink-100">{data.compliance.certificateOverdueCount}</dd>
          </dl>
        </Card>

        <Card title="Valuation">
          {data.valuation ? (
            <p className="text-sm text-ink-200">
              {money(data.valuation.equityValue)} — {data.valuation.basis.replace(/_/g, ' ')}, {dateTime(data.valuation.asOf)}
            </p>
          ) : (
            <EmptyState message="No valuation on record." />
          )}
        </Card>
      </div>
    </div>
  );
}
