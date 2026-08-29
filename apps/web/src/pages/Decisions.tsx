/**
 * The Decision surface with its calibration widget.
 *
 * `DECISION.confidence` is recorded before the outcome is known. Comparing it
 * against the realised assessment is a computed statistic, not an AI inference —
 * raw material the platform already collects, surfaced rather than discarded.
 */

import { useQuery } from '@tanstack/react-query';
import type { DecisionView } from '@kaizen/shared';
import { api, date, money, relative, titleCase } from '../lib/api.js';
import { Card, ContributionBar, EmptyState, ErrorBox, Loading, Metric, PageHeader, StatusChip } from '../components/ui.js';

interface Calibration {
  buckets: Array<{ band: string; stated: number; realised: number | null; count: number }>;
  sampleSize: number;
  components: readonly string[];
}

export function Decisions() {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['decisions'],
    queryFn: () => api.get<DecisionView[]>('/command/decisions'),
  });

  const { data: calibration } = useQuery({
    queryKey: ['calibration'],
    queryFn: () => api.get<Calibration>('/command/decisions/calibration'),
  });

  if (error) return <ErrorBox error={error} />;

  const analysing = data.filter((d) => !d.evidencePack.complete).length;

  return (
    <div>
      <PageHeader
        title="Decisions"
        subtitle="Calls that genuinely need you. Something arrives here only when nobody below you can settle it, a policy names you specifically, or someone you delegated to handed it back."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Waiting on a decision" value={data.length} drillTo="/command" />
        <Metric
          label="Analysing"
          value={analysing}
          tone={analysing > 0 ? 'warn' : 'good'}
          sub="Evidence pack incomplete — visibly not decidable, with a clock"
          drillTo="/command"
        />
        <Metric
          label="Calibration sample"
          value={calibration?.sampleSize ?? 0}
          sub="Decisions with both a stated confidence and a realised outcome"
          drillTo="/command/decisions"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {isLoading ? (
            <Loading />
          ) : data.length === 0 ? (
            <Card>
              <EmptyState message="Nothing requires authority that exceeds every grant below you." />
            </Card>
          ) : (
            data.map((d) => (
              <Card key={d.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mono">{d.recordCode}</span>
                      <StatusChip
                        status={d.state}
                        tone={d.state === 'AwaitingAuthority' ? 'accent' : d.state === 'Analysing' ? 'warn' : 'neutral'}
                      />
                      <span className="chip border-ink-700 text-ink-400">{titleCase(d.authorityBasis)}</span>
                      {d.requiredAuthorityValue !== null && (
                        <span className="chip border-ink-700 text-ink-400">{money(d.requiredAuthorityValue, d.currency ?? 'INR')}</span>
                      )}
                    </div>

                    <p className="mt-1.5 text-sm font-medium text-ink-100">{d.question}</p>
                    <p className="mt-0.5 text-2xs text-ink-500">
                      {d.subjectLabel} · raised {relative(d.raisedAt)}
                      {d.pointOfNoReturn && ` · point of no return ${date(d.pointOfNoReturn)}`}
                      {d.reviewDueOn && ` · review due ${date(d.reviewDueOn)}`}
                    </p>

                    {!d.evidencePack.complete && (
                      <p className="mt-1.5 text-2xs text-band-watch">
                        Missing evidence: {d.evidencePack.missingComponents.map((m) => m.replace(/_/g, ' ')).join(', ')}
                      </p>
                    )}

                    {d.chosenOption && (
                      <p className="mt-1.5 text-2xs text-ink-300">
                        Decided: {d.chosenOption}
                        {d.confidence !== null && ` · stated confidence ${Math.round(d.confidence * 100)}%`}
                      </p>
                    )}
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-2xs text-ink-500">Dispositions available</p>
                    <div className="mt-1 flex flex-wrap justify-end gap-1">
                      {d.availableDispositions.map((x) => (
                        <span key={x} className="chip border-ink-700 text-ink-400">
                          {x.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>

        <div className="space-y-5">
          <Card
            title="Your decisions, calibrated"
            subtitle="Stated confidence against realised outcome. A computed statistic, not an inference."
          >
            {!calibration || calibration.sampleSize === 0 ? (
              <EmptyState
                message="Not enough past decisions have been reviewed yet to say how well they went."
                hint="Making the call is not the end. A decision is only finished once someone has written down how it turned out and what changed as a result."
              />
            ) : (
              <div className="space-y-2">
                {calibration.buckets
                  .filter((b) => b.count > 0)
                  .map((b) => (
                    <div key={b.band}>
                      <div className="flex items-center justify-between text-2xs">
                        <span className="text-ink-300">{b.band} stated</span>
                        <span className="tabular-nums text-ink-400">
                          {b.realised === null ? '—' : `${b.realised}% realised`} · n={b.count}
                        </span>
                      </div>
                      <div className="mt-1">
                        <ContributionBar
                          value={b.realised ?? 0}
                          max={100}
                          tone={b.realised !== null && Math.abs(b.realised - b.stated) > 20 ? 'warn' : 'accent'}
                        />
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </Card>

          <Card title="The evidence pack" subtitle="Seven mandatory components, assembled before routing — never after.">
            <ol className="space-y-1">
              {(calibration?.components ?? []).map((c, i) => (
                <li key={c} className="text-2xs text-ink-400">
                  {i + 1}. {c.replace(/_/g, ' ')}
                </li>
              ))}
            </ol>
            <p className="mt-3 text-2xs italic text-ink-500">
              An incomplete pack renders Analysing with a visible clock, never as decidable. Request-evidence holds the
              item's queue position and clock rather than dropping it to a parking lot.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
