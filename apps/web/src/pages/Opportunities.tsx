/**
 * Opportunities and the forecast surface.
 *
 * Stage and forecast category are shown as two distinct axes throughout — a
 * card reads "Negotiating" and "Commit" simultaneously, because conflating the
 * two is exactly the kind of blended, meaningless number the pipeline rebuild
 * exists to eliminate.
 *
 * The forecast roll-up shows per-pipeline totals side by side. A blended total
 * is available only on explicit request, and says so when shown.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OpportunityView } from '@kaizen/shared';
import { api, date, money, moneyExact, relative, titleCase } from '../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Metric,
  Modal,
  PageHeader,
  RecordCode,
  SensitivityChip,
  StatusChip,
  Tabs,
} from '../components/ui.js';
import { useSession } from '../lib/session.js';

const FORECAST_TONE: Record<string, 'neutral' | 'accent' | 'good' | 'warn' | 'bad'> = {
  pipeline: 'neutral',
  best_case: 'accent',
  commit: 'good',
  closed_won: 'good',
  closed_lost: 'bad',
};

export function Opportunities() {
  const [tab, setTab] = useState<'open' | 'commit' | 'won' | 'all'>('open');

  const query =
    tab === 'open' ? '?open=true' : tab === 'commit' ? '?forecastCategory=commit' : tab === 'won' ? '' : '';

  const { data, isLoading, error } = useQuery({
    queryKey: ['opportunities', tab],
    queryFn: () => api.get<{ items: OpportunityView[]; total: number }>(`/crm/opportunities${query}`),
  });

  if (error) return <ErrorBox error={error} />;

  const items = (data?.items ?? []).filter((o) => (tab === 'won' ? o.outcome === 'won' : true));

  return (
    <div>
      <PageHeader
        title="Opportunities"
        subtitle="Deals in progress: how far along, and how likely."
        actions={<Link to="/crm/forecast" className="btn-ghost">Forecast roll-up</Link>}
      />

      <Tabs
        tabs={[
          { key: 'open', label: 'Open' },
          { key: 'commit', label: 'Commit' },
          { key: 'won', label: 'Won' },
          { key: 'all', label: 'All', count: data?.total },
        ]}
        active={tab}
        onChange={setTab}
      />

      {isLoading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState message="No deals match what you searched for." />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Opportunity</th>
                <th>Pipeline / Stage</th>
                <th>Forecast</th>
                <th className="text-right">Value</th>
                <th className="text-right">Weighted</th>
                <th>Close</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <RecordCode code={o.recordCode} to={`/crm/opportunities/${o.id}`} />
                  </td>
                  <td>
                    <Link to={`/crm/opportunities/${o.id}`} className="text-xs font-medium text-ink-100 hover:text-accent-soft">
                      {o.title}
                    </Link>
                    <p className="text-2xs text-ink-500">{o.organizationName ?? '—'}</p>
                  </td>
                  <td>
                    <span className="mono">{o.pipelineCode}</span>
                    <p className="text-2xs text-ink-300">
                      {o.stageLabel} <span className="text-ink-600">· pos {o.pipelinePosition}</span>
                    </p>
                  </td>
                  <td>
                    <StatusChip status={o.forecastCategory} tone={FORECAST_TONE[o.forecastCategory] ?? 'neutral'} />
                  </td>
                  <td className="text-right tabular-nums text-xs">{money(o.expectedValue, o.currency)}</td>
                  <td className="text-right tabular-nums text-xs text-ink-400">{money(o.weightedValue, o.currency)}</td>
                  <td className="text-xs">
                    <span className={o.closeDateStale ? 'text-band-strained' : 'text-ink-400'}>
                      {date(o.expectedCloseDate)}
                    </span>
                    {o.closeDateStale && <p className="text-2xs text-band-strained">stale</p>}
                  </td>
                  <td>
                    <span className={`text-xs ${o.stageAgeBreached ? 'text-band-strained' : 'text-ink-400'}`}>{o.stageAgeDays}d</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function OpportunityDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { can } = useSession();
  const [forecastOpen, setForecastOpen] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['opportunity', id],
    queryFn: () => api.get<any>(`/crm/opportunities/${id}`),
    enabled: Boolean(id),
  });

  const advance = useMutation({
    mutationFn: (toStageKey: string) => api.post(`/crm/opportunities/${id}/stage`, { toStageKey }),
    onSuccess: () => {
      setStageError(null);
      qc.invalidateQueries({ queryKey: ['opportunity', id] });
    },
    onError: (err) => setStageError(err instanceof Error ? err.message : 'Transition rejected'),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const o = data.opportunity;
  const stages = o.pipeline?.stages ?? [];
  const transitions = o.pipeline?.transitions ?? [];
  const currentStage = stages.find((s: any) => s.stageKey === o.stageKey);
  const nextStages = transitions
    .filter((t: any) => t.fromStageKey === o.stageKey)
    .map((t: any) => stages.find((s: any) => s.stageKey === t.toStageKey))
    .filter(Boolean);

  return (
    <div>
      <PageHeader
        title={o.title}
        subtitle={
          <span className="mono">
            {o.recordCode} · {o.pipeline?.pipelineCode} · {currentStage?.label} (position {currentStage?.pipelinePosition})
          </span>
        }
        actions={
          <>
            <button className="btn-ghost" onClick={() => setForecastOpen(true)}>
              Change forecast category
            </button>
            {nextStages.map((s: any) => (
              <button
                key={s.stageKey}
                className={s.pipelinePosition === 90 ? 'btn-primary' : 'btn-ghost'}
                onClick={() => advance.mutate(s.stageKey)}
                disabled={advance.isPending || (s.pipelinePosition === 90 && !data.wonGateSatisfied)}
                title={
                  s.pipelinePosition === 90 && !data.wonGateSatisfied
                    ? 'A contract or MoU reference is needed before this can be marked won.'
                    : undefined
                }
              >
                → {s.label}
              </button>
            ))}
          </>
        }
      />

      {stageError && (
        <div className="mb-4 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-2.5">
          <p className="text-xs text-band-critical">{stageError}</p>
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Expected value" value={money(o.expectedValue ? Number(o.expectedValue) : null, o.currency)} sub={o.currency} drillTo="/crm/forecast" />
        <Metric
          label="Forecast category"
          value={<span className="text-lg">{titleCase(o.forecastCategory)}</span>}
          sub={o.forecastCategoryChangeReason ?? 'A separate, evidenced call from the stage.'}
          drillTo="/crm/forecast"
        />
        <Metric
          label="Stage age"
          value={`${Math.floor((Date.now() - new Date(o.stageEnteredAt).getTime()) / 86_400_000)}d`}
          sub={currentStage?.stageAgeBudgetDays ? `budget ${currentStage.stageAgeBudgetDays}d` : 'no SLA clock on this stage'}
          tone={
            currentStage?.stageAgeBudgetDays &&
            Math.floor((Date.now() - new Date(o.stageEnteredAt).getTime()) / 86_400_000) > currentStage.stageAgeBudgetDays
              ? 'warn'
              : 'neutral'
          }
          noActionReason={currentStage?.stageAgeBudgetDays ? undefined : 'No budget set for this stage.'}
          drillTo="/exceptions"
        />
        <Metric
          label="Won gate"
          value={data.wonGateSatisfied ? 'Satisfied' : 'Blocked'}
          tone={data.wonGateSatisfied ? 'good' : 'warn'}
          sub={data.wonGateSatisfied ? 'A contract or MoU reference exists.' : 'Neither a contract nor an MoU is referenced.'}
          drillTo="/commercial/agreements"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Stage path" subtitle="Stages move one step at a time.">
            <div className="flex flex-wrap items-center gap-1.5">
              {stages
                .filter((s: any) => !s.postAward)
                .sort((a: any, b: any) => a.sequence - b.sequence)
                .map((s: any) => (
                  <div
                    key={s.stageKey}
                    className={`rounded border px-2 py-1 text-2xs ${
                      s.stageKey === o.stageKey
                        ? 'border-accent bg-accent/15 text-ink-50'
                        : s.pipelinePosition === 0
                          ? 'border-ink-800 text-ink-500'
                          : 'border-ink-800 text-ink-400'
                    }`}
                  >
                    {s.label}
                    <span className="ml-1 text-ink-600">{s.pipelinePosition}</span>
                  </div>
                ))}
            </div>
            {currentStage?.requiredFields?.length > 0 && (
              <p className="mt-3 text-2xs text-ink-500">
                Fields required to enter this stage: {currentStage.requiredFields.join(', ')}
              </p>
            )}
          </Card>

          <Card title="Timeline" bodyClassName="p-0">
            {(data.timeline ?? []).length === 0 ? (
              <EmptyState message="Nothing has been logged against this deal yet." />
            ) : (
              <ul className="divide-y divide-ink-850">
                {data.timeline.map((t: any) => (
                  <li key={t.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="chip border-ink-700 text-ink-400">{t.interactionType}</span>
                      <SensitivityChip level={t.sensitivityClass} />
                      <span className="text-2xs text-ink-500">{relative(t.occurredAt)}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-200">{t.subject}</p>
                    {t.notes ? (
                      <p className="mt-0.5 text-2xs text-ink-400">{t.notes}</p>
                    ) : (
                      t.withheld?.some((w: any) => w.path === 'notes') && (
                        <p className="mt-0.5 text-2xs italic text-ink-600">notes withheld · classification ceiling</p>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Detail">
            <dl>
              <Field label="Account">{o.organization?.name ?? '—'}</Field>
              <Field label="Offering">{o.offering?.name ?? '—'}</Field>
              <Field label="Vertical">{titleCase(o.vertical)}</Field>
              <Field label="Strategic value">{o.strategicValue ? titleCase(o.strategicValue) : '—'}</Field>
              <Field label="Expected close">{date(o.expectedCloseDate)}</Field>
              <Field label="Outcome">{o.outcome ? <StatusChip status={o.outcome} tone={o.outcome === 'won' ? 'good' : 'bad'} /> : '—'}</Field>
              {o.legacyStage && <Field label="Legacy stage">{o.legacyStage}</Field>}
            </dl>
          </Card>

          <Card title="Commercial instruments" subtitle="The agreements behind this deal.">
            <dl>
              <Field label="Proposal">
                {data.proposal ? (
                  <span>
                    <span className="mono">{data.proposal.recordCode}</span>{' '}
                    <StatusChip status={data.proposal.response} tone={data.proposal.response === 'accepted' ? 'good' : 'neutral'} />
                  </span>
                ) : (
                  <span className="text-ink-500">none — the offered stage is blocked until one exists</span>
                )}
              </Field>
              <Field label="Quote">
                {data.quote ? (
                  <span>
                    <span className="mono">{data.quote.recordCode}</span>{' '}
                    <StatusChip status={data.quote.status} tone={data.quote.status === 'blocked' ? 'bad' : 'neutral'} />
                  </span>
                ) : (
                  '—'
                )}
              </Field>
              <Field label="Contract">
                {data.contract ? (
                  <Link to="/commercial/agreements" className="mono text-accent-soft hover:underline">
                    {data.contract.recordCode}
                  </Link>
                ) : (
                  '—'
                )}
              </Field>
              <Field label="MoU">
                {data.mou ? (
                  <Link to="/commercial/agreements" className="mono text-accent-soft hover:underline">
                    {data.mou.recordCode}
                  </Link>
                ) : (
                  '—'
                )}
              </Field>
            </dl>
          </Card>

          {data.receivables && (
            <Card title="Receivables" subtitle="What is owed on this deal.">
              <dl>
                <Field label="Outstanding">{money(data.receivables.amountOutstanding ? Number(data.receivables.amountOutstanding) : null)}</Field>
                <Field label="Dunning stage">{data.receivables.dunningStage ?? 'none'}</Field>
              </dl>
            </Card>
          )}

          {data.withheld?.length > 0 && (
            <Card title="Withheld">
              <ul className="space-y-1">
                {data.withheld.map((w: any, i: number) => (
                  <li key={i} className="text-2xs text-ink-500">
                    <span className="font-mono">{w.path}</span> — {w.reason.replace(/_/g, ' ')}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <ForecastModal
        open={forecastOpen}
        onClose={() => setForecastOpen(false)}
        opportunityId={id!}
        current={o.forecastCategory}
        position={currentStage?.pipelinePosition ?? 10}
      />
    </div>
  );
}

function ForecastModal({
  open,
  onClose,
  opportunityId,
  current,
  position,
}: {
  open: boolean;
  onClose: () => void;
  opportunityId: string;
  current: string;
  position: number;
}) {
  const qc = useQueryClient();
  const [to, setTo] = useState('best_case');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => api.post(`/crm/opportunities/${opportunityId}/forecast-category`, { to, reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['opportunity', opportunityId] });
      onClose();
      setError(null);
      setReason('');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Change rejected'),
  });

  const isDemotion = ['pipeline', 'best_case'].indexOf(to) < ['pipeline', 'best_case', 'commit'].indexOf(current);

  return (
    <Modal
      open={open}
      title="Forecast category"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => change.mutate()} disabled={change.isPending || (isDemotion && !reason)}>
            Change
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-2xs text-ink-400">
          Currently <span className="text-ink-100">{titleCase(current)}</span> at pipeline position {position}. Category
          promotion is a deliberate, evidenced call, separate from advancing a stage.
        </p>

        <div className="flex gap-1.5">
          {['pipeline', 'best_case', 'commit'].map((c) => (
            <button
              key={c}
              onClick={() => setTo(c)}
              className={`btn ${to === c ? 'border-accent bg-accent text-white' : 'border-ink-700 bg-ink-850 text-ink-200'}`}
            >
              {titleCase(c)}
            </button>
          ))}
        </div>

        <div className="space-y-1.5 rounded border border-ink-800 bg-ink-950 p-3 text-2xs text-ink-500">
          <p>· Best case needs the deal past the early stages.</p>
          <p>· Commit needs a close date in this period, and the qualification fields filled in on a big deal.</p>
          <p>· Moving a deal down is always allowed, but needs a reason.</p>
        </div>

        <div>
          <label className="label">{isDemotion ? 'Reason (required on a demotion)' : 'Reason (optional)'}</label>
          <textarea className="input min-h-16" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>

        {error && <p className="text-2xs text-band-critical">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Forecast roll-up
// ---------------------------------------------------------------------------

interface RollupResponse {
  perPipeline: Array<{
    pipelineId: string;
    pipelineCode: string;
    pipelineName: string;
    forecastMethod: string;
    currency: string;
    buckets: Array<{ category: string; count: number; rawValue: number; weightedValue: number }>;
    closedWon: number;
    closedLost: number;
    openCount: number;
  }>;
  blended: { rawValue: number; weightedValue: number } | null;
  note: string;
}

export function Forecast() {
  const [blended, setBlended] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['forecast', blended],
    queryFn: () => api.get<RollupResponse>(`/crm/forecast?blended=${blended}`),
  });

  const { data: coverage } = useQuery({
    queryKey: ['coverage'],
    queryFn: () => api.get<{ minPosition: number; count: number; value: number }>('/crm/coverage?minPosition=30'),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Forecast"
        subtitle="What we expect to close, by kind of business."
        actions={
          <button className={blended ? 'btn-primary' : 'btn-ghost'} onClick={() => setBlended((v) => !v)}>
            {blended ? 'Showing blended total' : 'Request blended total'}
          </button>
        }
      />

      {coverage && (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <Metric
            label="Past the qualifying stage"
            value={coverage.count}
            sub="Qualified or beyond, across every pipeline in one pass"
            drillTo="/crm/opportunities?open=true"
          />
          <Metric label="Coverage value" value={money(coverage.value)} sub="Counted on the shared scale, so different kinds of business compare fairly" drillTo="/crm/opportunities" />
          <Metric
            label="Pipelines"
            value={data?.perPipeline.length ?? 0}
            sub="Each with its own motion-native vocabulary"
            drillTo="/admin/pipelines"
          />
        </div>
      )}

      {data?.blended && (
        <Card className="mb-5 border-band-watch/40" title="Blended total — requested explicitly">
          <div className="flex gap-8">
            <div>
              <p className="text-2xs uppercase tracking-wide text-ink-500">Raw</p>
              <p className="text-2xl font-semibold tabular-nums text-ink-50">{money(data.blended.rawValue)}</p>
            </div>
            <div>
              <p className="text-2xs uppercase tracking-wide text-ink-500">Weighted</p>
              <p className="text-2xl font-semibold tabular-nums text-ink-50">{money(data.blended.weightedValue)}</p>
            </div>
          </div>
          <p className="mt-2 text-2xs text-band-watch">{data.note}</p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {data?.perPipeline.map((p) => (
          <Card
            key={p.pipelineId}
            title={p.pipelineName}
            subtitle={
              <span>
                <span className="mono">{p.pipelineCode}</span> · {titleCase(p.forecastMethod)}
              </span>
            }
          >
            <div className="space-y-2">
              {p.buckets.map((b) => (
                <div key={b.category} className="flex items-center justify-between gap-3 border-b border-ink-850 pb-2 last:border-0">
                  <div>
                    <p className="text-xs text-ink-200">{titleCase(b.category)}</p>
                    <p className="text-2xs text-ink-500">{b.count} deals</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium tabular-nums text-ink-100">{money(b.weightedValue, p.currency)}</p>
                    <p className="text-2xs tabular-nums text-ink-500">raw {money(b.rawValue, p.currency)}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex justify-between border-t border-ink-800 pt-2 text-2xs">
              <span className="text-band-strong">won {money(p.closedWon, p.currency)}</span>
              <span className="text-ink-500">lost {money(p.closedLost, p.currency)}</span>
            </div>
            {p.forecastMethod === 'manual_commit' && (
              <p className="mt-2 text-2xs italic text-ink-500">
                Only committed deals count.
              </p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
