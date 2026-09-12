/**
 * The Chairman Command Center.
 *
 * The aggregation gradient runs DOWN — domain → factor → reading → record.
 * The unit of attention is an exception, a decision, or a health-band
 * transition, never a record row. The write path is a different object class
 * entirely: a DECISION disposition, a bounded DELEGATION, or an
 * AUTHORITY_GRANT change — never a field edit on an operational record.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommandCenterResponse, DecisionView, ExceptionView, HealthScoreView } from '@kaizen/shared';
import { api, money, relative, titleCase } from '../lib/api.js';
import { NOT_MEASURED, domainAsks, domainName, words } from '../lib/words.js';
import {
  BandChip,
  Card,
  ContributionBar,
  EmptyState,
  ErrorBox,
  Loading,
  Modal,
  PageHeader,
  SeverityChip,
} from '../components/ui.js';

export function CommandCenter() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['command-center'],
    queryFn: () => api.get<CommandCenterResponse>('/command'),
    refetchInterval: 120_000,
  });

  const markSeen = useMutation({
    mutationFn: () => api.post('/command/what-changed/seen'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['command-center'] }),
  });

  const recompute = useMutation({
    mutationFn: () => api.post('/command/health/recompute'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['command-center'] }),
  });

  if (isLoading) return <Loading label="Getting today's picture" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Today at Kaizen"
        subtitle="How the business is doing, and what needs you."
        actions={
          <>
            <button className="btn-ghost" onClick={() => recompute.mutate()} disabled={recompute.isPending}>
              {recompute.isPending ? 'Refreshing…' : 'Refresh the numbers'}
            </button>
            <button className="btn-ghost" onClick={() => markSeen.mutate()} disabled={markSeen.isPending}>
              Mark all as read
            </button>
          </>
        }
      />

      {/* Stated as a fact on arrival, rather than a question someone has to
          think to ask. */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-ink-800 bg-ink-900 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums text-ink-50">{data.banner.waitingCount}</span>
          <span className="text-xs text-ink-400">things waiting on someone</span>
        </div>
        {data.banner.oldestClockHours !== null && (
          <div className="flex items-baseline gap-2 border-l border-ink-800 pl-4">
            <span className="text-2xl font-semibold tabular-nums text-band-watch">{data.banner.oldestClockHours}h</span>
            <span className="text-xs text-ink-400">the longest one has been waiting</span>
          </div>
        )}
        <span className="ml-auto text-2xs text-ink-500">Correct as of {new Date(data.asOf).toLocaleString('en-IN')}</span>
      </div>

      <PulseStrip pulse={data.pulse} />

      <div className="grid gap-5 xl:grid-cols-2">
        <AttentionQueue items={data.attentionQueue} />
        <DecisionQueue items={data.decisionQueue} />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <WhatChanged data={data.whatChanged} onSeen={() => markSeen.mutate()} />
        <LiveAndHandled data={data.liveAndHandled} />
      </div>

      <PeopleCapability />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Company Pulse — ten domains, each a tile that answers "how much room before
// this crosses" alongside "where it is now". Never a bare number.
// ---------------------------------------------------------------------------

function PulseStrip({ pulse }: { pulse: HealthScoreView[] }) {
  const [open, setOpen] = useState<HealthScoreView | null>(null);

  return (
    <>
      <Card
        title="How the business is doing"
        subtitle="Ten areas, scored out of 100. Click one to see what is moving it."
        bodyClassName="p-3"
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {pulse.map((p) => (
            <button
              key={p.domainCode}
              onClick={() => p.state === 'measured' && setOpen(p)}
              disabled={p.state !== 'measured'}
              className={`rounded-lg border border-ink-800 bg-ink-950 p-3 text-left transition-colors ${
                p.state === 'measured' ? 'hover:border-ink-600' : 'opacity-60'
              }`}
            >
              <div className="flex items-start justify-between gap-1">
                <span className="text-xs font-medium text-ink-100" title={p.domainCode}>
                  {domainName(p.domainCode, p.domainName)}
                </span>
                {p.trend && (
                  <span className={p.trend === 'up' ? 'text-band-strong' : p.trend === 'down' ? 'text-band-critical' : 'text-ink-500'}>
                    {p.trend === 'up' ? '↗' : p.trend === 'down' ? '↘' : '→'}
                  </span>
                )}
              </div>
              <p className="mt-0.5 line-clamp-2 text-2xs text-ink-500">{domainAsks(p.domainCode)}</p>

              {p.state === 'measured' ? (
                <>
                  <p className="mt-1.5 text-xl font-semibold tabular-nums text-ink-50">{p.score?.toFixed(1)}</p>
                  <div className="mt-1.5">
                    <BandChip band={p.band} />
                  </div>
                  {p.distanceToEdge !== null && (
                    <p className="mt-1.5 text-2xs text-ink-500">
                      {p.distanceToEdge.toFixed(0)} points before this slips further
                    </p>
                  )}
                  {p.largestNegativeContributor && (
                    <p className="mt-0.5 line-clamp-2 text-2xs text-band-strained" title={p.largestNegativeContributor}>
                      Biggest drag: {p.largestNegativeContributor.replace(/\s−[\d.]+ pts$/, '')}
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-3 text-xs italic text-ink-500">{NOT_MEASURED}</p>
              )}
            </button>
          ))}
        </div>
      </Card>

      {/* Hop 1 of the three-hop drill: the domain decomposes into its weighted
          factors, every one shown alongside the others rather than hidden
          behind an aggregate. */}
      <Modal
        open={Boolean(open)}
        title={open ? domainName(open.domainCode, open.domainName) : ''}
        onClose={() => setOpen(null)}
        width="max-w-3xl"
      >
        {open && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div>
                <p className="text-3xl font-semibold tabular-nums text-ink-50">{open.score?.toFixed(1)}</p>
                <BandChip band={open.band} />
              </div>
              <div className="flex-1 text-xs text-ink-400">
                <p>{domainAsks(open.domainCode)}</p>
                <p className="mt-1">
                  {open.distanceToEdge?.toFixed(0)} points of room before this slips into the next band down.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <p className="section-title">What is driving this</p>
              {open.factors.map((f) => (
                <div key={f.factor} className="rounded-lg border border-ink-800 bg-ink-950 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-ink-100">
                        {f.label}
                        {f.quarantined && (
                          <span
                            className="ml-2 chip border-band-watch/40 text-band-watch"
                            title="This has never gone down, so it is not telling us anything. Not counted until it is fixed."
                          >
                            not trustworthy
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-2xs text-ink-400">{f.narrative}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold tabular-nums text-ink-100">
                        {f.contribution.toFixed(1)}
                        <span className="text-ink-500"> / {f.weight}</span>
                      </p>
                      <p className="text-2xs text-ink-500">surrendered {(f.weight - f.contribution).toFixed(1)}</p>
                    </div>
                  </div>
                  <div className="mt-2">
                    <ContributionBar
                      value={f.contribution}
                      max={f.weight}
                      tone={f.contribution / f.weight < 0.4 ? 'bad' : f.contribution / f.weight < 0.7 ? 'warn' : 'accent'}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-2xs text-ink-500">
                    <span>
                      reading {f.value} against target {f.target}
                    </span>
                    {/* Hop 3: the reading resolves to its underlying records,
                        five-axis filtered exactly as any other read. */}
                    <Link to={f.drillPath} className="text-accent-soft hover:underline" onClick={() => setOpen(null)}>
                      Open source records →
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Attention Queue — every exception arrives pre-owned.
// ---------------------------------------------------------------------------

function AttentionQueue({ items }: { items: ExceptionView[] }) {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/command/exceptions/${id}/acknowledge`, { note: 'Acknowledged from the Command Center.' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['command-center'] }),
  });

  return (
    <Card
      title="Needs your attention"
      subtitle="Yours to handle, overdue, or unclaimed."
      actions={<Link to="/exceptions" className="btn-ghost">See everything</Link>}
      bodyClassName="max-h-[26rem] overflow-y-auto p-0"
    >
      {items.length === 0 ? (
        <EmptyState
          message="Nothing needs you right now."
          hint="Nothing is waiting on you."
        />
      ) : (
        <ul className="divide-y divide-ink-850">
          {items.map((e) => (
            <li key={e.id} className="px-4 py-3 hover:bg-ink-850/50">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SeverityChip severity={e.severity} />
                    {e.slaBreached && (
                      <span className="chip border-band-critical/50 text-band-critical">Past its deadline</span>
                    )}
                    {e.ownerPartyId === null && (
                      <span
                        className="chip border-band-strained/40 text-band-strained"
                        title="Nobody has been assigned this. Our routing rules have a gap."
                      >
                        Nobody assigned
                      </span>
                    )}
                    {e.escalationRung > 0 && (
                      <span className="chip border-ink-700 text-ink-400" title={`Escalation step ${e.escalationRung} — ${titleCase(e.escalationTrigger)}`}>
                        Escalated
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs font-medium text-ink-100">{e.label}</p>
                  <p className="mt-0.5 line-clamp-2 text-2xs text-ink-400">{e.detail}</p>
                  <p className="mt-1 text-2xs text-ink-500">
                    {e.subjectLabel} · {e.ownerName ? `with ${e.ownerName}` : 'not yet assigned to anyone'} ·
                    noticed {relative(e.raisedAt)} · <span className="mono">{e.code}</span>
                  </p>
                  {e.ranked && (
                    <p className="mt-1 text-2xs italic text-ink-600" title="Why this is where it is in the list.">
                      Near the top because: {e.ranked.whyRanked.join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button className="btn-ghost" onClick={() => navigate(e.drillPath)}>
                    Open
                  </button>
                  {e.state === 'open' && (
                    <button className="btn-ghost" onClick={() => ack.mutate(e.id)} disabled={ack.isPending}>
                      Got it
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Decision Queue — four dispositions, all exclusively human acts.
// ---------------------------------------------------------------------------

function DecisionQueue({ items }: { items: DecisionView[] }) {
  const [open, setOpen] = useState<DecisionView | null>(null);

  return (
    <>
      <Card
        title="Waiting on your decision"
        subtitle="Nobody below you can settle these."
        bodyClassName="max-h-[26rem] overflow-y-auto p-0"
      >
        {items.length === 0 ? (
          <EmptyState message="No decisions are waiting on you." />
        ) : (
          <ul className="divide-y divide-ink-850">
            {items.map((d) => (
              <li key={d.id} className="px-4 py-3 hover:bg-ink-850/50">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mono">{d.recordCode}</span>
                      {d.evidencePack.complete ? (
                        <span className="chip border-band-strong/40 text-band-strong">Ready to decide</span>
                      ) : (
                        <span
                          className="chip border-band-watch/40 text-band-watch"
                          title="Some background is still being gathered. You can decide now, but you do not have to."
                        >
                          Still gathering facts
                        </span>
                      )}
                      <span className="chip border-ink-700 text-ink-400">{words(d.authorityBasis)}</span>
                    </div>
                    <p className="mt-1 text-xs font-medium text-ink-100">{d.question}</p>
                    <p className="mt-0.5 text-2xs text-ink-500">
                      {d.subjectLabel} · came to you {relative(d.raisedAt)}
                      {d.pointOfNoReturn && ` · too late to act after ${new Date(d.pointOfNoReturn).toLocaleDateString('en-IN')}`}
                    </p>
                  </div>
                  <button className="btn-primary shrink-0" onClick={() => setOpen(d)}>
                    Review
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <DecisionModal decision={open} onClose={() => setOpen(null)} />
    </>
  );
}

function DecisionModal({ decision, onClose }: { decision: DecisionView | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [disposition, setDisposition] = useState<string>('decide');
  const [rationale, setRationale] = useState('');
  const [chosenOption, setChosenOption] = useState('');
  const [confidence, setConfidence] = useState(0.7);
  const [deferUntil, setDeferUntil] = useState('');
  const [error, setError] = useState<string | null>(null);

  const dispose = useMutation({
    mutationFn: () =>
      api.post(`/command/decisions/${decision!.id}/dispose`, {
        disposition,
        rationale,
        chosenOption: disposition === 'decide' ? chosenOption : undefined,
        confidence: disposition === 'decide' ? confidence : undefined,
        deferUntil: disposition === 'defer' ? new Date(deferUntil).toISOString() : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['command-center'] });
      onClose();
      setRationale('');
      setChosenOption('');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Disposition failed'),
  });

  if (!decision) return null;
  const pack = decision.evidencePack;

  return (
    <Modal
      open
      title="A decision for you"
      onClose={onClose}
      width="max-w-3xl"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="btn-primary"
            disabled={dispose.isPending || !rationale || (disposition === 'decide' && !chosenOption) || (disposition === 'defer' && !deferUntil)}
            onClick={() => dispose.mutate()}
          >
            {dispose.isPending ? 'Saving…' : `Save this ${words(disposition).toLowerCase()}`}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium text-ink-50">{decision.question}</p>
          <p className="mt-1 text-2xs text-ink-500">
            {decision.subjectLabel} · {words(decision.authorityBasis)}
            {decision.requiredAuthorityValue && ` · ${money(decision.requiredAuthorityValue, decision.currency ?? 'INR')}`}
          </p>
        </div>

        {!pack.complete && (
          <div className="rounded border border-band-watch/40 bg-band-watch/5 p-3">
            <p className="text-xs font-medium text-band-watch">Some background is still missing</p>
            <p className="mt-1 text-2xs text-ink-400">
              Still to come: {pack.missingComponents.map((m) => words(m).toLowerCase()).join(', ')}. Until
              that is in, the only thing you can do here is ask for it — deciding without it would not be
              a real decision.
            </p>
          </div>
        )}

        <div className="space-y-3 rounded-lg border border-ink-800 bg-ink-950 p-3">
          <p className="section-title">What you are deciding on</p>

          {pack.rejectedOptions.length > 0 && (
            <div>
              <p className="mb-1 text-2xs uppercase tracking-wide text-ink-500">Options considered and rejected</p>
              {pack.rejectedOptions.map((o, i) => (
                <div key={i} className="mb-1.5 rounded border border-ink-800 p-2 text-2xs">
                  <p className="font-medium text-ink-200">{o.option}</p>
                  <p className="mt-0.5 text-ink-400">
                    outcome: {o.outcome} · risk: {o.risk} · cost: {o.cost}
                  </p>
                </div>
              ))}
            </div>
          )}

          <div>
            <p className="mb-1 text-2xs uppercase tracking-wide text-ink-500">The always-present no-action option</p>
            <p className="text-2xs text-ink-300">
              {pack.noActionOption.consequence} <span className="text-ink-500">— by {pack.noActionOption.by}</span>
            </p>
          </div>

          {pack.modelView && (
            <div>
              <p className="mb-1 text-2xs uppercase tracking-wide text-ink-500">
                {pack.modelView.label} <span className="text-band-watch">— this is a model, not a fact</span>
              </p>
              <p className="text-2xs text-ink-300">{pack.modelView.statement}</p>
            </div>
          )}

          {pack.nearestPrecedents.length > 0 && (
            <div>
              <p className="mb-1 text-2xs uppercase tracking-wide text-ink-500">Nearest precedents</p>
              {pack.nearestPrecedents.map((p) => (
                <p key={p.decisionId} className="text-2xs text-ink-300">
                  {p.question} → <span className="text-ink-400">{p.outcome}</span>
                </p>
              ))}
            </div>
          )}

          <div>
            <p className="mb-1 text-2xs uppercase tracking-wide text-ink-500">Constraints and grant exercised</p>
            <p className="text-2xs text-ink-300">
              {pack.constraintsAndGrant.constraint} <span className="text-ink-500">({pack.constraintsAndGrant.grantExercised})</span>
            </p>
          </div>
        </div>

        <div>
          <p className="label">Disposition</p>
          <div className="flex flex-wrap gap-1.5">
            {['decide', 'delegate', 'defer', 'request_evidence'].map((d) => {
              const available = decision.availableDispositions.includes(d);
              return (
                <button
                  key={d}
                  disabled={!available}
                  onClick={() => setDisposition(d)}
                  className={`btn ${
                    disposition === d ? 'border-accent bg-accent text-white' : 'border-ink-700 bg-ink-850 text-ink-200'
                  } disabled:opacity-30`}
                  title={available ? undefined : 'Unavailable until the evidence pack is complete.'}
                >
                  {d.replace(/_/g, ' ')}
                </button>
              );
            })}
          </div>
        </div>

        {disposition === 'decide' && (
          <>
            <div>
              <label className="label">Chosen option</label>
              <input className="input" value={chosenOption} onChange={(e) => setChosenOption(e.target.value)} placeholder="What are you deciding?" />
            </div>
            <div>
              <label className="label">
                Confidence — recorded before the outcome is known, so calibration can be measured later
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={confidence}
                  onChange={(e) => setConfidence(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="w-12 text-right text-sm tabular-nums text-ink-100">{Math.round(confidence * 100)}%</span>
              </div>
            </div>
          </>
        )}

        {disposition === 'defer' && (
          <div>
            <label className="label">Defer until</label>
            <input type="date" className="input" value={deferUntil} onChange={(e) => setDeferUntil(e.target.value)} />
            {decision.pointOfNoReturn && (
              <p className="mt-1 text-2xs text-band-watch">
                Refused outright — not merely warned — if this falls after the point of no return
                ({new Date(decision.pointOfNoReturn).toLocaleDateString('en-IN')}).
              </p>
            )}
          </div>
        )}

        <div>
          <label className="label">Rationale (required)</label>
          <textarea className="input min-h-20" value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Why this, and why now?" />
        </div>

        {error && <p className="text-2xs text-band-critical">{error}</p>}

      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// What Changed
// ---------------------------------------------------------------------------

function WhatChanged({ data, onSeen }: { data: CommandCenterResponse['whatChanged']; onSeen: () => void }) {
  return (
    <Card
      title="What changed"
      subtitle={`Since you last looked, ${new Date(data.watermark).toLocaleString('en-IN')}. ${data.suppressedBelowMateriality} smaller changes are not listed — they were too minor to be worth your time.`}
      actions={<button className="btn-ghost" onClick={onSeen}>I have read this</button>}
      bodyClassName="max-h-[26rem] overflow-y-auto p-0"
    >
      {data.narrative && (
        <div className="border-b border-ink-800 bg-ink-950/60 p-4">
          {/* The mandatory reconciliation line, computed — never a stylistic
              flourish. Every claim below resolves to an admitted delta item. */}
          <p className="text-xs font-medium text-ink-100">{data.narrative.reconciliationLine}</p>
          <p className="mt-1.5 text-2xs leading-relaxed text-ink-400">{data.narrative.body}</p>
        </div>
      )}

      {data.items.length === 0 ? (
        <EmptyState message="Nothing significant has changed since you last looked." />
      ) : (
        <ul className="divide-y divide-ink-850">
          {data.items.map((d) => (
            <li key={d.id} className="px-4 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-ink-100">{d.headline}</span>
                    {d.severity && <SeverityChip severity={d.severity} />}
                    {d.newToView && (
                      <span className="chip border-accent/40 text-accent-soft" title="This is not new — you just gained access to it. It was already there.">
                        Newly visible to you
                      </span>
                    )}
                    {d.handledWithoutYou && (
                      <span className="chip border-ink-700 text-ink-400">handled without you</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-2xs text-ink-400">
                    {d.detail} · {relative(d.occurredAt)}
                    {d.materiality !== null && ` · ${money(d.materiality)}`}
                  </p>
                </div>
                <Link to={d.drillPath} className="shrink-0 text-2xs text-accent-soft hover:underline">
                  open →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Live & Handled
// ---------------------------------------------------------------------------

function LiveAndHandled({ data }: { data: CommandCenterResponse['liveAndHandled'] }) {
  return (
    <Card
      title="Live & Handled"
      subtitle="One row per kind of automation. Failures are listed on their own."
      bodyClassName="max-h-[26rem] overflow-y-auto p-0"
    >
      <table className="table">
        <thead>
          <tr>
            <th>Class</th>
            <th className="text-right">Runs</th>
            <th className="text-right">Success</th>
            <th className="text-right">Exceptions</th>
            <th className="text-right" title="What an agent wanted to do but was not allowed to.">
              Shortfall
            </th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.automationClass}>
              <td>
                <p className="text-xs text-ink-100">{r.label}</p>
                {r.topDefinition && <p className="mono">{r.topDefinition}</p>}
              </td>
              <td className="text-right tabular-nums">
                {r.count === 0 ? (
                  <span className="text-ink-500" title="An automation class that normally fires and suddenly does not is itself a signal.">
                    nothing ran
                  </span>
                ) : (
                  r.count
                )}
              </td>
              <td className="text-right tabular-nums">{r.successRate.toFixed(0)}%</td>
              <td className={`text-right tabular-nums ${r.exceptionCount > 0 ? 'text-band-critical' : ''}`}>{r.exceptionCount}</td>
              <td className={`text-right tabular-nums ${r.authorityShortfall > 0 ? 'text-band-watch' : ''}`}>{r.authorityShortfall}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.authorityInForce.length > 0 && (
        <div className="border-t border-ink-800 p-4">
          <p className="section-title mb-2">Authority in force</p>
          <div className="space-y-1.5">
            {data.authorityInForce.slice(0, 6).map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 text-2xs">
                <span className="truncate text-ink-300">
                  {a.principalLabel} · {a.authorityClass.replace(/_/g, ' ')}
                </span>
                <span className="shrink-0 tabular-nums text-ink-400">{money(a.ceilingValue, a.currency ?? 'INR')}</span>
              </div>
            ))}
          </div>
          <Link to="/admin/agents" className="mt-2 inline-block text-2xs text-accent-soft hover:underline">
            Inspect, narrow or revoke →
          </Link>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// People & Capability — unit-level only, k>=5 enforced in the data contract.
// ---------------------------------------------------------------------------

interface CapabilityRow {
  unit: string;
  headcount: number | null;
  roleCoverage: number | null;
  singlePointsOfFailure: number | null;
  withheld: boolean;
  withheldReason: string | null;
  note: string | null;
}

function PeopleCapability() {
  const { data = [] } = useQuery({
    queryKey: ['people-capability'],
    queryFn: () => api.get<CapabilityRow[]>('/command/people-capability'),
  });

  return (
    <Card
      title="People & Capability"
      subtitle="Capacity, coverage and single points of failure, by team."
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {data.map((u) => (
          <div key={u.unit} className="rounded-lg border border-ink-800 bg-ink-950 p-3">
            <p className="text-2xs uppercase tracking-wide text-ink-500">{u.unit}</p>
            {u.withheld ? (
              <>
                <p className="mt-2 text-xs text-ink-400">WITHHELD</p>
                <p className="mt-1 text-2xs text-ink-500">{u.note}</p>
              </>
            ) : (
              <>
                <p className="mt-1.5 text-xl font-semibold tabular-nums text-ink-50">{u.headcount}</p>
                <p className="mt-1 text-2xs text-ink-400">{u.roleCoverage} distinct roles</p>
                {u.singlePointsOfFailure ? (
                  <p className="mt-0.5 text-2xs text-band-watch">
                    {u.singlePointsOfFailure} single point{u.singlePointsOfFailure === 1 ? '' : 's'} of failure
                  </p>
                ) : (
                  <p className="mt-0.5 text-2xs text-ink-500">no single points of failure</p>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      {data.length === 0 && <EmptyState message="Too few people to show without identifying them." />}
    </Card>
  );
}
