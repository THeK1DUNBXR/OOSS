/**
 * The Kanban board.
 *
 * Columns render from PIPELINE_STAGE.sequence and label — one component, no
 * vertical-specific code branch. An admissions counsellor's board reads
 * "New Enquiry → Counselled → Course Selected"; an enterprise seller's reads
 * "Discovered → Engaged → Qualified"; neither sees the other's vocabulary by
 * default, and neither label is hard-coded per role.
 *
 * A card shows stage and forecast category simultaneously, because they are two
 * different axes. Drag validates against PIPELINE_TRANSITION before the round
 * trip and shows the server's rejection reason inline.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PipelineView } from '@kaizen/shared';
import { api, money, titleCase } from '../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../components/ui.js';
import { humanize } from '../lib/words.js';

interface BoardCard {
  id: string;
  recordCode: string;
  title: string;
  organizationName: string | null;
  offeringName?: string | null;
  personName?: string | null;
  expectedValue?: number | null;
  currency?: string;
  forecastCategory?: string;
  score?: number;
  ownerPartyId: string | null;
  unrouted?: boolean;
  stageAgeDays: number;
  stageAgeBreached: boolean;
  wonGateSatisfied?: boolean;
}

interface BoardColumn {
  stageKey: string;
  label: string;
  pipelinePosition: number;
  defaultProbability: number;
  stageAgeBudgetDays: number | null;
  requiredFields: string[];
  isTerminal: boolean;
  opportunities: BoardCard[];
  leads: BoardCard[];
}

interface BoardResponse {
  pipeline: { id: string; pipelineCode: string; name: string; commercialMotion: string; defaultForecastMethod: string };
  columns: BoardColumn[];
  transitions: Array<{ fromStageKey: string | null; toStageKey: string }>;
}

const FORECAST_TONE: Record<string, 'neutral' | 'accent' | 'good' | 'warn'> = {
  pipeline: 'neutral',
  best_case: 'accent',
  commit: 'good',
  closed_won: 'good',
  closed_lost: 'warn',
};

export function Pipeline() {
  const qc = useQueryClient();
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; from: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: pipelines = [], isLoading: loadingPipelines } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => api.get<PipelineView[]>('/pipelines'),
  });

  useEffect(() => {
    if (pipelineId || !pipelines.length) return;
    // Land on the motion carrying the most live work rather than the
    // alphabetically first one.
    const busiest = [...pipelines].sort(
      (a, b) =>
        ((b as any).opportunityCount ?? 0) + ((b as any).leadCount ?? 0) -
        (((a as any).opportunityCount ?? 0) + ((a as any).leadCount ?? 0)),
    )[0];
    setPipelineId(busiest.id);
  }, [pipelines, pipelineId]);

  const { data: board, isLoading, error: boardError } = useQuery({
    queryKey: ['board', pipelineId],
    queryFn: () => api.get<BoardResponse>(`/pipelines/${pipelineId}/board`),
    enabled: Boolean(pipelineId),
  });

  const move = useMutation({
    mutationFn: ({ id, toStageKey }: { id: string; toStageKey: string }) =>
      api.post(`/crm/opportunities/${id}/stage`, { toStageKey }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['board', pipelineId] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Transition rejected'),
  });

  /** Client-side validation against the transition graph, before the round trip. */
  const permitted = useMemo(() => {
    const set = new Set<string>();
    for (const t of board?.transitions ?? []) set.add(`${t.fromStageKey ?? ''}→${t.toStageKey}`);
    return set;
  }, [board]);

  if (loadingPipelines) return <Loading label="Loading pipelines" />;
  if (boardError) return <ErrorBox error={boardError} />;

  return (
    <div>
      <PageHeader
        title="Pipeline"
        subtitle="Your deals, by how far along they are."
        actions={
          <div className="flex flex-wrap gap-1">
            {pipelines.map((p) => (
              <button
                key={p.id}
                onClick={() => setPipelineId(p.id)}
                className={`btn ${p.id === pipelineId ? 'border-accent bg-accent text-white' : 'border-ink-700 bg-ink-850 text-ink-200'}`}
                title={p.usable ? undefined : (p.usableReason ?? undefined)}
              >
                {p.pipelineCode.replace('PL-', '')}
              </button>
            ))}
          </div>
        }
      />

      {board && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-ink-800 bg-ink-900 px-4 py-2.5">
          <div>
            <p className="text-xs font-medium text-ink-100">{board.pipeline.name}</p>
            <p className="text-2xs text-ink-500">
              {titleCase(board.pipeline.commercialMotion)} · forecast method:{' '}
              <span className="text-ink-400">{titleCase(board.pipeline.defaultForecastMethod)}</span>
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-2.5">
          <p className="text-xs text-band-critical">{error}</p>
        </div>
      )}

      {isLoading && <Loading label="Loading board" />}

      {board && (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {board.columns.map((col) => {
            const cards = [...col.opportunities, ...col.leads];
            const value = col.opportunities.reduce((s, c) => s + (c.expectedValue ?? 0), 0);
            const canDrop = dragging ? permitted.has(`${dragging.from}→${col.stageKey}`) : false;

            return (
              <div
                key={col.stageKey}
                onDragOver={(e) => {
                  if (canDrop) e.preventDefault();
                }}
                onDrop={() => {
                  if (dragging && canDrop) move.mutate({ id: dragging.id, toStageKey: col.stageKey });
                  setDragging(null);
                }}
                className={`w-72 shrink-0 rounded-lg border bg-ink-900 transition-colors ${
                  dragging
                    ? canDrop
                      ? 'border-accent/60 bg-accent/5'
                      : 'border-ink-850 opacity-50'
                    : 'border-ink-800'
                }`}
              >
                <div className="border-b border-ink-800 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-semibold text-ink-100">{col.label}</p>
                    <span className="mono shrink-0" title="The canonical cross-pipeline ordinal">
                      {col.pipelinePosition}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-2xs text-ink-500">
                    <span>{cards.length} · {col.defaultProbability}%</span>
                    {value > 0 && <span className="tabular-nums">{money(value)}</span>}
                  </div>
                  {col.stageAgeBudgetDays && (
                    <p className="mt-0.5 text-2xs text-ink-600">SLA {col.stageAgeBudgetDays}d</p>
                  )}
                  {col.requiredFields.length > 0 && (
                    <p className="mt-0.5 text-2xs text-ink-600" title="Must be filled in before a card can move into this stage.">
                      requires {col.requiredFields.map((f) => humanize(f)).join(', ')}
                    </p>
                  )}
                </div>

                <div className="max-h-[calc(100vh-20rem)] space-y-2 overflow-y-auto p-2">
                  {cards.length === 0 && <p className="px-1 py-4 text-center text-2xs text-ink-600">Empty</p>}

                  {col.opportunities.map((c) => (
                    <Link
                      key={c.id}
                      to={`/crm/opportunities/${c.id}`}
                      draggable={!col.isTerminal}
                      onDragStart={() => setDragging({ id: c.id, from: col.stageKey })}
                      onDragEnd={() => setDragging(null)}
                      className="block cursor-grab rounded-md border border-ink-800 bg-ink-950 p-2.5 transition-colors hover:border-ink-600 active:cursor-grabbing"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="mono">{c.recordCode}</span>
                        {c.stageAgeBreached && (
                          <span className="chip border-band-strained/40 text-band-strained" title={`${c.stageAgeDays}d against a ${col.stageAgeBudgetDays}d budget`}>
                            {c.stageAgeDays}d
                          </span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs font-medium text-ink-100">{c.title}</p>
                      {c.organizationName && <p className="mt-0.5 truncate text-2xs text-ink-500">{c.organizationName}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        {c.expectedValue !== null && c.expectedValue !== undefined && (
                          <span className="text-2xs font-medium tabular-nums text-ink-300">{money(c.expectedValue, c.currency)}</span>
                        )}
                        {c.forecastCategory && (
                          <StatusChip status={humanize(c.forecastCategory)} tone={FORECAST_TONE[c.forecastCategory] ?? 'neutral'} />
                        )}
                        {col.pipelinePosition >= 50 && !c.wonGateSatisfied && (
                          <span className="chip border-band-watch/40 text-band-watch" title="Cannot mark won until a contract or MoU reference exists.">
                            no award artefact
                          </span>
                        )}
                      </div>
                    </Link>
                  ))}

                  {col.leads.map((c) => (
                    <Link
                      key={c.id}
                      to={`/crm/leads/${c.id}`}
                      className="block rounded-md border border-dashed border-ink-800 bg-ink-950/60 p-2.5 transition-colors hover:border-ink-600"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="mono">{c.recordCode}</span>
                        <span className="chip border-ink-700 text-ink-500">lead</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs font-medium text-ink-200">{c.title}</p>
                      <p className="mt-0.5 truncate text-2xs text-ink-500">{c.personName ?? c.organizationName ?? '—'}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        {c.score !== undefined && <span className="chip border-ink-700 text-ink-400">score {c.score}</span>}
                        {c.unrouted && (
                          <span className="chip border-band-strained/40 text-band-strained" title="Still open, and nobody owns it">
                            unrouted
                          </span>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {board?.columns.length === 0 && (
        <EmptyState message="This pipeline has no open stages." hint="A pipeline with no entry or terminal stage is rejected as incomplete." />
      )}
    </div>
  );
}
