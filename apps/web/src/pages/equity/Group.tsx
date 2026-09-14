/**
 * The group screen — equity-portal plan §6, phase 2.
 *
 * Everything here is built from the API's already-published snapshots
 * (`/group/*`); no arithmetic on percentages happens in this file beyond
 * shaping numbers the server already computed for display.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type {
  GroupComplianceRowView, GroupEntityFinancialView, GroupHolderRowView,
  GroupStructureView, GroupEntityBadge,
} from '@kaizen/shared';
import { GROUP_ENTITY_BADGE_LABELS } from '@kaizen/shared';
import { api, dateTime, money } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui.js';

const BADGE_STYLE: Record<GroupEntityBadge, string> = {
  wholly_owned: 'border-band-strong/40 bg-band-strong/10 text-band-strong',
  subsidiary: 'border-accent/40 bg-accent/10 text-accent-soft',
  associate: 'border-band-watch/40 bg-band-watch/10 text-band-watch',
  investment: 'border-ink-700 bg-ink-850 text-ink-300',
  not_yet_incorporated: 'border-ink-800 bg-ink-900 text-ink-500',
};

function BadgeChip({ badge }: { badge: GroupEntityBadge | null }) {
  if (!badge) return null;
  return <span className={`chip ${BADGE_STYLE[badge]}`}>{GROUP_ENTITY_BADGE_LABELS[badge]}</span>;
}

/** "as published 14 Sep, 09:41 · 12 minutes ago" — never a raw ISO string. */
function agoWords(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function publishedWords(publishedAt: string | null, staleSeconds: number | null): string {
  if (!publishedAt || staleSeconds === null) return 'Not yet published';
  return `as published ${dateTime(publishedAt)} · ${agoWords(staleSeconds)}`;
}

export function Group() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'structure' | 'holders' | 'financials' | 'compliance'>('structure');

  const structure = useQuery({
    queryKey: ['group-structure'],
    queryFn: () => api.get<GroupStructureView>('/group/structure'),
  });
  const holders = useQuery({
    queryKey: ['group-holders'],
    queryFn: () => api.get<{ entities: Array<{ tenantId: string; name: string }>; holders: GroupHolderRowView[] }>('/group/holders'),
    enabled: tab === 'holders',
  });
  const financials = useQuery({
    queryKey: ['group-financials'],
    queryFn: () =>
      api.get<{ entities: GroupEntityFinancialView[]; totalLabel: string; totalCash: number | null; totalPnlMonth: { income: number; expense: number; net: number } | null; intercompanyTotal: { in: number; out: number } | null }>(
        '/group/financials',
      ),
    enabled: tab === 'financials',
  });
  const compliance = useQuery({
    queryKey: ['group-compliance'],
    queryFn: () => api.get<{ rows: GroupComplianceRowView[] }>('/group/compliance'),
    enabled: tab === 'compliance',
  });

  const refresh = useMutation({
    mutationFn: () => api.post('/group/refresh', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['group-structure'] });
      qc.invalidateQueries({ queryKey: ['group-holders'] });
      qc.invalidateQueries({ queryKey: ['group-financials'] });
      qc.invalidateQueries({ queryKey: ['group-compliance'] });
    },
  });

  if (structure.error) return <ErrorBox error={structure.error} />;
  if (structure.isLoading || !structure.data) return <Loading label="Reading the group" />;

  const childNodes = structure.data.nodes.filter((n) => n.tenantId !== structure.data!.self.tenantId);
  const hasSubsidiaries = childNodes.some((n) => n.kind !== 'not_yet_incorporated');

  return (
    <div>
      <PageHeader
        title="Group"
        subtitle="Each entity's own published summary, and a group total before inter-company eliminations. Never a consolidated statement — that stays an accountant's act."
        actions={
          can('group:C') && (
            <button className="btn btn-secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              {refresh.isPending ? 'Refreshing…' : 'Refresh from subsidiaries'}
            </button>
          )
        }
      />

      {!hasSubsidiaries && childNodes.every((n) => n.kind === 'not_yet_incorporated') && (
        <Card className="mb-4">
          <EmptyState message="This company has no subsidiaries." hint="Every division below is not yet incorporated as its own entity." />
        </Card>
      )}

      <div className="mb-4 flex gap-1 border-b border-ink-800">
        {(['structure', 'holders', 'financials', 'compliance'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-xs font-medium capitalize ${tab === t ? 'border-b-2 border-accent text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'structure' && (
        <div className="space-y-4">
          <Card title="Structure" subtitle="Edge labels: issued % · fully-diluted %.">
            <div className="flex flex-col items-center gap-6">
              <div className="rounded-md border border-ink-700 bg-ink-850 px-4 py-3 text-center shadow-raised">
                <p className="text-sm font-semibold text-ink-100">{structure.data.self.name}</p>
                <p className="text-2xs uppercase tracking-wide text-ink-500">{structure.data.self.kind}</p>
              </div>
              {childNodes.length > 0 && (
                <div className="flex w-full flex-wrap justify-center gap-4">
                  {childNodes.map((n) => {
                    const edge = structure.data!.edges.find((e) => e.childTenantId === n.tenantId);
                    return (
                      <div key={n.tenantId ?? n.originDivision} className="flex flex-col items-center gap-1">
                        <div className="h-6 w-px bg-ink-700" />
                        {edge && (
                          <span className="text-2xs text-ink-500">
                            {edge.issuedPct.toFixed(1)}% issued · {edge.fullyDilutedPct.toFixed(1)}% fully diluted
                          </span>
                        )}
                        <div
                          className={`flex min-w-[10rem] flex-col items-center gap-1 rounded-md border p-3 text-center shadow-raised ${
                            n.kind === 'not_yet_incorporated' ? 'border-dashed border-ink-800 bg-ink-925' : 'border-ink-700 bg-ink-900'
                          }`}
                        >
                          <p className="text-xs font-semibold text-ink-100">{n.name}</p>
                          <BadgeChip badge={n.badge} />
                          {n.layerLimitExceeded && <span className="chip border-band-critical/40 bg-band-critical/10 text-band-critical">Layer limit</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {childNodes
              .filter((n) => n.kind !== 'not_yet_incorporated')
              .map((n) => (
                <EntityTile key={n.tenantId} node={n} />
              ))}
          </div>
        </div>
      )}

      {tab === 'holders' && (
        <Card
          bodyClassName="p-0"
          actions={
            <Link to="/equity/filings" className="btn-ghost">
              BEN-2 candidates
            </Link>
          }
        >
          {holders.isLoading || !holders.data ? (
            <Loading />
          ) : holders.data.holders.length === 0 ? (
            <EmptyState message="No holders to consolidate yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Holder</th>
                    {holders.data.entities.map((e) => (
                      <th key={e.tenantId} className="text-right">
                        {e.name}
                      </th>
                    ))}
                    <th>Matched by</th>
                    <th>SBO</th>
                  </tr>
                </thead>
                <tbody>
                  {holders.data.holders.map((h) => (
                    <tr key={h.holderKey}>
                      <td>{h.displayName}</td>
                      {holders.data!.entities.map((e) => {
                        const stake = h.perEntity[e.tenantId];
                        return (
                          <td key={e.tenantId} className="text-right tabular-nums">
                            {stake ? (
                              <span title={`Direct ${stake.directFullyDilutedPct.toFixed(2)}% · look-through ${stake.lookThroughFullyDilutedPct.toFixed(2)}%`}>
                                {stake.lookThroughFullyDilutedPct.toFixed(2)}%
                                {stake.lookThroughFullyDilutedPct !== stake.directFullyDilutedPct && (
                                  <span className="ml-1 text-2xs text-ink-500">({stake.directFullyDilutedPct.toFixed(2)}% direct)</span>
                                )}
                              </span>
                            ) : (
                              <span className="text-ink-600">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="text-2xs text-ink-400">
                        {[...new Set(Object.values(h.perEntity).map((s) => s.matchedBy))].join(', ')}
                      </td>
                      <td>{h.sbo && <span className="chip border-band-watch/40 bg-band-watch/10 text-band-watch">SBO ≥10%</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'financials' && (
        <Card bodyClassName="p-0">
          {financials.isLoading || !financials.data ? (
            <Loading />
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Entity</th>
                    <th className="text-right">Cash</th>
                    <th className="text-right">P&amp;L (month)</th>
                    <th className="text-right">Headcount</th>
                    <th className="text-right">Inter-company in</th>
                    <th className="text-right">Inter-company out</th>
                  </tr>
                </thead>
                <tbody>
                  {financials.data.entities.map((e) => (
                    <tr key={e.tenantId}>
                      <td>{e.name}</td>
                      <td className="text-right tabular-nums">{money(e.cash)}</td>
                      <td className="text-right tabular-nums">{e.pnlMonth ? money(e.pnlMonth.net) : '—'}</td>
                      <td className="text-right tabular-nums">{e.headcount}</td>
                      <td className="text-right tabular-nums">{money(e.intercompanyIn)}</td>
                      <td className="text-right tabular-nums">{money(e.intercompanyOut)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="total-row">
                    <td>{financials.data.totalLabel}</td>
                    <td className="text-right tabular-nums">{money(financials.data.totalCash)}</td>
                    <td className="text-right tabular-nums">{financials.data.totalPnlMonth ? money(financials.data.totalPnlMonth.net) : '—'}</td>
                    <td />
                    <td className="text-right tabular-nums">{money(financials.data.intercompanyTotal?.in ?? null)}</td>
                    <td className="text-right tabular-nums">{money(financials.data.intercompanyTotal?.out ?? null)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'compliance' && (
        <Card bodyClassName="p-0">
          {compliance.isLoading || !compliance.data ? (
            <Loading />
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Entity</th>
                    <th>Demat status</th>
                    <th>Small company</th>
                    <th className="text-right">Certificates overdue</th>
                    <th>Snapshot</th>
                  </tr>
                </thead>
                <tbody>
                  {compliance.data.rows.map((r) => (
                    <tr key={r.tenantId}>
                      <td>{r.name}</td>
                      <td className="text-ink-300">{r.dematStatus ?? '—'}</td>
                      <td className="text-ink-300">{r.isSmallCompany === null ? '—' : r.isSmallCompany ? 'Yes' : 'No'}</td>
                      <td className="text-right tabular-nums">{r.certificateOverdueCount}</td>
                      <td>
                        <span className="text-2xs text-ink-400">{publishedWords(r.publishedAt, r.staleSeconds)}</span>
                        {r.stale && <span className="ml-2 chip border-band-critical/40 bg-band-critical/10 text-band-critical">Stale</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function EntityTile({ node }: { node: GroupStructureView['nodes'][number] }) {
  const { user, switchEntity } = useSession();
  const [busy, setBusy] = useState(false);

  const detail = useQuery({
    queryKey: ['group-entity', node.tenantId],
    queryFn: () =>
      api.get<{
        capTable: { holderTotals: Array<unknown> };
        financial: unknown;
        compliance: { dematStatus: string | null; certificateOverdueCount: number };
        valuation: { asOf: string; basis: string } | null;
      }>(`/group/entities/${node.tenantId}`),
    enabled: Boolean(node.tenantId),
  });

  const open = async () => {
    if (!node.tenantId) return;
    setBusy(true);
    try {
      // Only a tenant this session's own entity list includes can be
      // switched into directly — otherwise the read-only snapshot view is
      // where a holding-level viewer with no relationship there lands.
      await switchEntity(node.tenantId);
    } catch {
      window.location.assign(`/equity/group/${node.tenantId}`);
    } finally {
      setBusy(false);
    }
  };

  void user;

  return (
    <button onClick={open} disabled={busy} className="flex flex-col items-start gap-1.5 rounded-lg border border-ink-800 bg-ink-900 p-4 text-left shadow-raised transition-all duration-150 hover:-translate-y-px hover:shadow-floating disabled:opacity-60">
      <div className="flex w-full items-center justify-between gap-2">
        <span className="text-sm font-semibold text-ink-100">{node.name}</span>
        <BadgeChip badge={node.badge} />
      </div>
      {detail.data && (
        <>
          <p className="text-2xs text-ink-400">
            {detail.data.compliance.dematStatus ? detail.data.compliance.dematStatus.replace(/_/g, ' ') : 'No demat status on record'}
          </p>
          <p className="text-2xs text-ink-400">
            {detail.data.valuation ? `Last valuation ${money((detail.data.valuation as never as { equityValue?: number }).equityValue ?? null)} · ${detail.data.valuation.basis.replace(/_/g, ' ')}` : 'No valuation on record'}
          </p>
          {detail.data.compliance.certificateOverdueCount > 0 && (
            <span className="chip border-band-critical/40 bg-band-critical/10 text-band-critical">
              {detail.data.compliance.certificateOverdueCount} certificate(s) overdue
            </span>
          )}
        </>
      )}
      <p className="mt-1 text-2xs text-ink-500">{publishedWords(node.publishedAt, node.staleSeconds)}</p>
      {node.stale && <span className="chip border-band-critical/40 bg-band-critical/10 text-band-critical">Stale</span>}
    </button>
  );
}
