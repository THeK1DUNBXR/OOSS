/**
 * Commercial objects: the offering catalog and price book, quotes with the
 * discount-authority gate, proposals, the three agreement families, approval
 * steps and win/loss reviews.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgreementView, OfferingView, QuoteView, WinLossReviewView } from '@kaizen/shared';
import { LOST_REASONS } from '@kaizen/shared';
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
  StatusChip,
  Tabs,
} from '../components/ui.js';
import { NewButton } from '../components/forms.js';
import { NewOffering } from '../components/createForms.js';
import { useSession } from '../lib/session.js';

// ---------------------------------------------------------------------------
// Offering catalog
// ---------------------------------------------------------------------------

export function Offerings() {
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const { can } = useSession();
  const [priceFor, setPriceFor] = useState<OfferingView | null>(null);

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['offerings'],
    queryFn: () => api.get<OfferingView[]>('/commercial/offerings'),
  });

  if (error) return <ErrorBox error={error} />;

  const gaps = data.filter((o) => o.coverageGap).length;

  return (
    <div>
      <NewOffering open={creating} onClose={() => setCreating(false)} />
      <PageHeader
        actions={<NewButton label="Add an offering" onClick={() => setCreating(true)} />}
        title="What we sell"
        subtitle="Everything Kaizen sells, with its prices. Keeping this straight is what lets finance work out revenue automatically instead of asking about every deal."
      />

      {gaps > 0 && (
        <div className="mb-4 rounded-lg border border-band-watch/40 bg-band-watch/5 px-4 py-2.5">
          <p className="text-xs text-band-watch">
            {gaps} active offering{gaps === 1 ? '' : 's'} can be selected but not priced — a coverage gap, not a normal
            state. DET-CRM-OFF-01 raises this to the catalog owner.
          </p>
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.map((o) => (
            <Card
              key={o.id}
              title={o.name}
              subtitle={
                <span>
                  <span className="mono">{o.offeringCode}</span> · {titleCase(o.vertical)}
                </span>
              }
              actions={<StatusChip status={o.status} tone={o.status === 'active' ? 'good' : o.status === 'retired' ? 'neutral' : 'warn'} />}
            >
              <p className="text-2xs text-ink-400">{o.description}</p>

              <dl className="mt-3 grid grid-cols-2 gap-x-4">
                <Field label="Delivery model">{titleCase(o.deliveryModel)}</Field>
                <Field label="Revenue treatment">
                  <span title="The field Finance reads to derive recognition without a manual sales conversation per deal.">
                    {titleCase(o.defaultRevenueTreatment)}
                  </span>
                </Field>
              </dl>

              <div className="mt-3 border-t border-ink-850 pt-3">
                {o.coverageGap ? (
                  <p className="text-2xs text-band-watch">No price book entry — reps can select this but cannot price it.</p>
                ) : (
                  o.activePriceBookEntries.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 text-2xs">
                      <span className="text-ink-400">
                        {p.priceBookName} · v{p.version}
                      </span>
                      <span className="tabular-nums text-ink-200">
                        {money(p.unitPrice, p.currency)}
                        <span className="ml-1.5 text-ink-500">max {p.maxDiscountPct}% off</span>
                      </span>
                    </div>
                  ))
                )}
                {can('price_book_entries:C') && (
                  <button className="btn-ghost mt-2 w-full" onClick={() => setPriceFor(o)}>
                    Publish new price version
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <NewPriceModal offering={priceFor} onClose={() => setPriceFor(null)} />
    </div>
  );
}

function NewPriceModal({ offering, onClose }: { offering: OfferingView | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [unitPrice, setUnitPrice] = useState('');
  const [maxDiscountPct, setMaxDiscountPct] = useState('10');
  const [frequency, setFrequency] = useState('one_time');
  const [error, setError] = useState<string | null>(null);

  const publish = useMutation({
    mutationFn: () =>
      api.post(`/commercial/offerings/${offering!.id}/prices`, {
        currency: 'INR',
        unitPrice: Number(unitPrice),
        billingFrequency: frequency,
        maxDiscountPct: Number(maxDiscountPct),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['offerings'] });
      onClose();
      setUnitPrice('');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Publish failed'),
  });

  if (!offering) return null;

  return (
    <Modal
      open
      title={`New price version — ${offering.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => publish.mutate()} disabled={!unitPrice || publish.isPending}>
            Publish version
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="rounded border border-ink-800 bg-ink-950 px-3 py-2 text-2xs text-ink-500">
          Repricing never mutates an existing entry. This creates a new version and flips the prior row to superseded,
          so a quote built against the old price stays reproducible six months later.
        </p>
        <div>
          <label className="label">Unit price (INR)</label>
          <input className="input" type="number" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Billing frequency</label>
            <select className="input" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
              {['one_time', 'monthly', 'annual', 'per_seat', 'milestone'].map((f) => (
                <option key={f} value={f}>{titleCase(f)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Max discount %</label>
            <input className="input" type="number" min={0} max={100} value={maxDiscountPct} onChange={(e) => setMaxDiscountPct(e.target.value)} />
            <p className="mt-1 text-2xs text-ink-500">Required, deliberately set. There is no default ceiling.</p>
          </div>
        </div>
        {error && <p className="text-2xs text-band-critical">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export function Quotes() {
  const qc = useQueryClient();
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['quotes'],
    queryFn: () => api.get<QuoteView[]>('/commercial/quotes'),
  });

  const issue = useMutation({
    mutationFn: (id: string) => api.post(`/commercial/quotes/${id}/issue`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['quotes'] }),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Quotes"
        subtitle="Prices quoted to customers. Each line remembers the exact price it was quoted at, so a quote still adds up correctly months later even after list prices change."
      />

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState message="No quotes." />
        </Card>
      ) : (
        <div className="space-y-4">
          {data.map((q) => (
            <Card
              key={q.id}
              title={
                <span>
                  <span className="mono">{q.recordCode}</span> <span className="ml-2">v{q.version}</span>
                </span>
              }
              subtitle={q.issuedAt ? `Issued ${date(q.issuedAt)} · valid until ${date(q.validUntil)}` : 'Not yet issued'}
              actions={
                <>
                  <StatusChip
                    status={q.status}
                    tone={q.status === 'issued' ? 'good' : q.status === 'blocked' ? 'bad' : 'neutral'}
                  />
                  {(q.status === 'draft' || q.status === 'blocked') && (
                    <button className="btn-primary" onClick={() => issue.mutate(q.id)} disabled={issue.isPending}>
                      Attempt issue
                    </button>
                  )}
                </>
              }
            >
              {q.blockedReason && (
                <div className="mb-3 rounded border border-band-critical/40 bg-band-critical/5 px-3 py-2">
                  <p className="text-xs text-band-critical">Issue blocked — {q.blockedReason}</p>
                  <p className="mt-1 text-2xs text-ink-400">
                    The whole quote blocks; there is no partial issue with some lines through and some blocked. An
                    approval step is open against the resolved authority holder.
                  </p>
                </div>
              )}

              <table className="table">
                <thead>
                  <tr>
                    <th>Offering</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">List</th>
                    <th className="text-right">Discount</th>
                    <th className="text-right">Ceiling</th>
                    <th className="text-right">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {q.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <p className="text-xs text-ink-100">{l.offeringName}</p>
                        <p className="mono">entry v{l.priceBookEntryVersion}</p>
                      </td>
                      <td className="text-right tabular-nums text-xs">{l.quantity}</td>
                      <td className="text-right tabular-nums text-xs">{money(l.listUnitPrice)}</td>
                      <td className={`text-right tabular-nums text-xs ${l.overCeiling ? 'text-band-critical' : ''}`}>
                        {l.discountPct}%
                      </td>
                      <td className="text-right tabular-nums text-2xs text-ink-500">{l.maxDiscountPct}%</td>
                      <td className="text-right tabular-nums text-xs">{money(l.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-3 flex justify-end gap-6 border-t border-ink-800 pt-3 text-xs">
                <span className="text-ink-400">
                  Subtotal <span className="ml-1 tabular-nums text-ink-200">{money(q.subtotal)}</span>
                </span>
                <span className="text-ink-400">
                  Discount <span className="ml-1 tabular-nums text-ink-200">{money(q.discountTotal)}</span>
                </span>
                <span className="font-medium text-ink-100">
                  Total <span className="ml-1 tabular-nums">{money(q.grandTotal)}</span>
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export function Proposals() {
  const qc = useQueryClient();
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['proposals'],
    queryFn: () => api.get<any[]>('/commercial/proposals'),
  });

  const send = useMutation({
    mutationFn: (id: string) => api.post(`/commercial/proposals/${id}/send`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proposals'] }),
  });

  const respond = useMutation({
    mutationFn: ({ id, response }: { id: string; response: string }) =>
      api.post(`/commercial/proposals/${id}/respond`, { response }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proposals'] }),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Proposals"
        subtitle="A proposal is a real entity with a lifecycle, not a stage value plus two timestamps. An opportunity cannot enter the offered stage with nothing proposed."
      />

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card><EmptyState message="No proposals." /></Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Proposal</th>
                <th className="text-right">Value</th>
                <th>Sent</th>
                <th>Valid until</th>
                <th>Response</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td><RecordCode code={p.recordCode} /></td>
                  <td className="text-xs text-ink-100">{p.title}</td>
                  <td className="text-right tabular-nums text-xs">{money(p.totalValue, p.currency)}</td>
                  <td className="text-2xs text-ink-400">{p.sentAt ? relative(p.sentAt) : '—'}</td>
                  <td className="text-2xs text-ink-400">{date(p.validUntil)}</td>
                  <td>
                    <StatusChip
                      status={p.response}
                      tone={p.response === 'accepted' ? 'good' : p.response === 'rejected' ? 'bad' : 'neutral'}
                    />
                    {p.stalledNotifiedAt && (
                      <p className="mt-0.5 text-2xs text-band-watch" title="Flagged automatically after too long with no reply. Weekends are not counted.">stalled</p>
                    )}
                  </td>
                  <td>
                    <div className="flex gap-1">
                      {!p.sentAt && (
                        <button className="btn-ghost" onClick={() => send.mutate(p.id)}>Send</button>
                      )}
                      {p.sentAt && p.response === 'pending' && (
                        <>
                          <button className="btn-ghost" onClick={() => respond.mutate({ id: p.id, response: 'accepted' })}>
                            Accepted
                          </button>
                          <button className="btn-ghost" onClick={() => respond.mutate({ id: p.id, response: 'rejected' })}>
                            Rejected
                          </button>
                        </>
                      )}
                    </div>
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
// Agreements — MoU, Contract, Partner Agreement
// ---------------------------------------------------------------------------

const KIND_PATHS = { mou: 'mous', contract: 'contracts', partner_agreement: 'partner-agreements' } as const;

export function Agreements() {
  const [kind, setKind] = useState<'mou' | 'contract' | 'partner_agreement'>('mou');
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [gateResult, setGateResult] = useState<any>(null);

  const { data = [], isLoading, error: loadError } = useQuery({
    queryKey: ['agreements', kind],
    queryFn: () => api.get<AgreementView[]>(`/commercial/${KIND_PATHS[kind]}`),
  });

  const transition = useMutation({
    mutationFn: ({ id, toStatus }: { id: string; toStatus: string }) =>
      api.post<any>(`/commercial/${KIND_PATHS[kind]}/${id}/transition`, { toStatus, note: 'Transitioned from the agreements surface.' }),
    onSuccess: (res) => {
      setError(null);
      // A non-permitted gate does not throw: it opens an approval step against
      // the resolved authority holder, so the escalation ladder is a control on
      // the failing action rather than a dead end.
      if (!res.applied) setGateResult(res);
      qc.invalidateQueries({ queryKey: ['agreements', kind] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Transition rejected'),
  });

  if (loadError) return <ErrorBox error={loadError} />;

  return (
    <div>
      <PageHeader
        title="Agreements"
        subtitle="MoU, Contract and Partner Agreement share a design pattern because the business facts differ: a coverage instrument may carry zero value; a contract is always a priced commitment."
      />

      <Tabs
        tabs={[
          { key: 'mou', label: 'MoUs' },
          { key: 'contract', label: 'Contracts' },
          { key: 'partner_agreement', label: 'Partner Agreements' },
        ]}
        active={kind}
        onChange={setKind}
      />

      {error && (
        <div className="mb-3 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-2.5">
          <p className="text-xs text-band-critical">{error}</p>
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card><EmptyState message={`No ${kind.replace('_', ' ')}s.`} /></Card>
      ) : (
        <div className="space-y-3">
          {data.map((a) => (
            <Card key={a.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <RecordCode code={a.recordCode} />
                    <StatusChip
                      status={a.status}
                      tone={
                        ['active', 'signed'].includes(a.status)
                          ? 'good'
                          : ['expiring', 'expired'].includes(a.status)
                            ? 'warn'
                            : a.status === 'terminated'
                              ? 'bad'
                              : 'neutral'
                      }
                    />
                    {a.strategicValue === 'high' && (
                      <span className="chip border-accent/40 text-accent-soft" title="Escalates to the top approval tier on an OR gate, regardless of value.">
                        strategic
                      </span>
                    )}
                    {a.daysToExpiry !== null && a.daysToExpiry <= 120 && a.daysToExpiry >= 0 && (
                      <span className="chip border-band-watch/40 text-band-watch">{a.daysToExpiry}d to expiry</span>
                    )}
                  </div>

                  <p className="mt-1.5 text-sm font-medium text-ink-100">{a.title}</p>
                  <p className="text-2xs text-ink-500">
                    {a.organizationName ?? '—'}
                    {a.agreementType && ` · ${titleCase(a.agreementType)}`}
                  </p>

                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-2xs text-ink-400">
                    <span>
                      value <span className="tabular-nums text-ink-200">{money(a.commercialValue, a.currency)}</span>
                      {a.commercialValue === 0 && (
                        <span className="ml-1 text-ink-600" title="Zero is a valid coverage-instrument state for an MoU; a contract must be priced.">
                          (coverage instrument)
                        </span>
                      )}
                    </span>
                    <span>
                      {date(a.startDate)} → {date(a.endDate)}
                    </span>
                    {a.legacyReference && (
                      <span className="text-ink-600" title="The pre-migration identifier, preserved verbatim.">
                        formerly {a.legacyReference}
                      </span>
                    )}
                    {a.expiryNotifiedDays.length > 0 && (
                      <span title="Reminders already sent. Each one is only ever sent once, however many times the check runs.">
                        ladder: {a.expiryNotifiedDays.join(', ')}d
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap gap-1">
                  {a.availableTransitions.map((t) => (
                    <button
                      key={t}
                      className={a.requiresApprovalFor.includes(t) ? 'btn-primary' : 'btn-ghost'}
                      onClick={() => transition.mutate({ id: a.id, toStatus: t })}
                      disabled={transition.isPending}
                      title={a.requiresApprovalFor.includes(t) ? 'A privileged transition — runs the approval gate.' : undefined}
                    >
                      → {titleCase(t)}
                      {a.requiresApprovalFor.includes(t) && ' ⛨'}
                    </button>
                  ))}
                  {a.availableTransitions.length === 0 && (
                    <span className="text-2xs text-ink-600" title="expiring, expired and renewed are job-driven, never user transitions.">
                      no user transition available
                    </span>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={Boolean(gateResult)} title="Approval required" onClose={() => setGateResult(null)}>
        {gateResult && (
          <div className="space-y-3">
            <p className="text-xs text-ink-200">{gateResult.reason}</p>
            <dl className="rounded border border-ink-800 bg-ink-950 p-3">
              <Field label="Who this goes to for approval">
                {titleCase(gateResult.resolvedApproverRole)} (tier {gateResult.resolutionTier + 1})
              </Field>
              {gateResult.selfDealingBarTripped && (
                <Field label="Self-Dealing Bar">
                  <span className="text-band-watch">
                    Tripped — the approver may never be the subject owner. Resolution rerouted to the next tier, and
                    the attempt is audited as a watched pattern.
                  </span>
                </Field>
              )}
            </dl>
            <p className="text-2xs text-ink-500">
              An approval step is open and the resolved holder has been notified. system_admin is never a valid
              resolution target at any tier, and no AI principal may execute this transition at any grant size.
            </p>
            <Link to="/commercial/approvals" className="btn-ghost" onClick={() => setGateResult(null)}>
              Open the approval queue
            </Link>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export function Approvals() {
  const qc = useQueryClient();
  const [note, setNote] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api.get<any[]>('/commercial/approvals'),
  });

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      api.post(`/commercial/approvals/${id}/decide`, { approve, note: note[id] || 'Decided.' }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['approvals'] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Decision rejected'),
  });

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Approval routes to whoever holds authority at decision time, not at block time. The Self-Dealing Bar is unconditional: a requester may never approve their own step."
      />

      {error && (
        <div className="mb-3 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-2.5">
          <p className="text-xs text-band-critical">{error}</p>
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card><EmptyState message="Nothing is waiting for approval." /></Card>
      ) : (
        <div className="space-y-3">
          {data.map((s) => (
            <Card key={s.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="chip border-accent/40 text-accent-soft">{s.action}</span>
                    <StatusChip status={s.state} tone={s.state === 'escalated' ? 'warn' : 'neutral'} />
                    {s.slaBreached && <span className="chip border-band-critical/40 text-band-critical">SLA breached</span>}
                    {s.selfDealingBarTripped && (
                      <span className="chip border-band-watch/40 text-band-watch">self-dealing bar</span>
                    )}
                  </div>
                  <p className="mt-1.5 text-xs font-medium text-ink-100">{s.subjectLabel}</p>
                  <p className="text-2xs text-ink-500">
                    {titleCase(s.subjectType)} · requested {relative(s.requestedAt)} · resolved to{' '}
                    {titleCase(s.resolvedApproverRole)} (tier {s.resolutionTier + 1})
                    {s.requestedValue !== null && ` · ${moneyExact(s.requestedValue, s.currency ?? 'INR')}`}
                  </p>
                  <input
                    className="input mt-2"
                    placeholder="Decision note (required)"
                    value={note[s.id] ?? ''}
                    onChange={(e) => setNote({ ...note, [s.id]: e.target.value })}
                  />
                </div>
                <div className="flex shrink-0 flex-col gap-1.5">
                  <button className="btn-primary" onClick={() => decide.mutate({ id: s.id, approve: true })} disabled={decide.isPending}>
                    Approve
                  </button>
                  <button className="btn-danger" onClick={() => decide.mutate({ id: s.id, approve: false })} disabled={decide.isPending}>
                    Decline
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Win / Loss
// ---------------------------------------------------------------------------

export function WinLoss() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<WinLossReviewView | null>(null);

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['win-loss'],
    queryFn: () => api.get<WinLossReviewView[]>('/commercial/win-loss'),
  });

  const { data: lessons = [] } = useQuery({
    queryKey: ['lessons'],
    queryFn: () => api.get<any[]>('/commercial/lessons?limit=10'),
  });

  if (error) return <ErrorBox error={error} />;

  const overdue = data.filter((r) => r.overdue).length;
  const pending = data.filter((r) => !r.completedAt).length;

  return (
    <div>
      <PageHeader
        title="Win / Loss Review"
        subtitle="A structured post-mortem capturing named competitor, real decision-maker and real lost stage — feeding Company Memory's lesson distillation."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Reviews" value={data.length} sub="Across opportunities and MoUs" drillTo="/commercial/win-loss" />
        <Metric label="Pending" value={pending} tone={pending > 0 ? 'warn' : 'neutral'} sub="Not yet completed" drillTo="/commercial/win-loss" />
        <Metric label="Overdue" value={overdue} tone={overdue > 0 ? 'bad' : 'good'} sub="Mandatory and past the grace period" drillTo="/exceptions" />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {isLoading ? (
            <Loading />
          ) : data.length === 0 ? (
            <Card><EmptyState message="No reviews yet." /></Card>
          ) : (
            <div className="space-y-3">
              {data.map((r) => (
                <Card key={r.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <RecordCode code={r.recordCode} />
                        <StatusChip status={r.outcome} tone={r.outcome === 'won' ? 'good' : 'bad'} />
                        {r.mandatory && (
                          <span className="chip border-accent/40 text-accent-soft" title={`Mandatory under: ${r.mandatoryBasis}`}>
                            mandatory
                          </span>
                        )}
                        {r.overdue && <span className="chip border-band-critical/40 text-band-critical">overdue</span>}
                        {r.completedAt && <span className="chip border-band-strong/40 text-band-strong">complete</span>}
                      </div>
                      <p className="mt-1.5 text-xs font-medium text-ink-100">{r.subjectLabel}</p>
                      <p className="text-2xs text-ink-500">
                        {r.mandatoryBasis === 'not_mandatory' ? 'Below both thresholds' : `Gate: ${r.mandatoryBasis}`}
                        {r.commercialValueSnapshot !== null && ` · ${money(r.commercialValueSnapshot)} frozen at close`}
                      </p>
                      {r.competitorName && <p className="mt-1 text-2xs text-ink-400">Lost to {r.competitorName} at {r.realLostStage}</p>}
                      {r.lesson && <p className="mt-1.5 text-2xs italic text-ink-300">"{r.lesson}"</p>}
                    </div>
                    {!r.completedAt && (
                      <button className="btn-primary shrink-0" onClick={() => setEditing(r)}>
                        Complete
                      </button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <Card title="Company Memory" subtitle="Lessons distilled from completed reviews." bodyClassName="p-0">
          {lessons.length === 0 ? (
            <EmptyState message="No lessons have been written down yet." />
          ) : (
            <ul className="divide-y divide-ink-850">
              {lessons.map((l) => (
                <li key={l.id} className="px-4 py-3">
                  <p className="text-xs font-medium text-ink-100">{l.title}</p>
                  <p className="mt-1 text-2xs leading-relaxed text-ink-400">{l.body}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {(l.tags ?? []).map((t: string, i: number) => (
                      <span key={i} className="chip border-ink-800 text-ink-500">{t}</span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <CompleteReviewModal review={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function CompleteReviewModal({ review, onClose }: { review: WinLossReviewView | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [competitorName, setCompetitorName] = useState('');
  const [realLostStage, setRealLostStage] = useState('');
  const [lostReason, setLostReason] = useState<string>('competitor');
  const [otherText, setOtherText] = useState('');
  const [lesson, setLesson] = useState('');
  const [error, setError] = useState<string | null>(null);

  const complete = useMutation({
    mutationFn: () =>
      api.post(`/commercial/win-loss/${review!.id}/complete`, {
        competitorName: competitorName || null,
        realLostStage: realLostStage || null,
        lostReason,
        lostReasonOtherText: lostReason === 'other' ? otherText : null,
        lesson: lesson || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['win-loss'] });
      qc.invalidateQueries({ queryKey: ['lessons'] });
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed'),
  });

  if (!review) return null;

  return (
    <Modal
      open
      title={`Complete review — ${review.recordCode}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => complete.mutate()} disabled={complete.isPending || (review.mandatory && !lesson)}>
            Record
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-2xs text-ink-400">{review.subjectLabel}</p>
        {review.mandatory && (
          <p className="rounded border border-accent/40 bg-accent/5 px-3 py-2 text-2xs text-accent-soft">
            Mandatory under: {review.mandatoryBasis}. A lesson is required — the gate is an OR, computed once and
            frozen at terminal-state entry.
          </p>
        )}
        <div>
          <label className="label">Competitor (if any)</label>
          <input className="input" value={competitorName} onChange={(e) => setCompetitorName(e.target.value)} />
        </div>
        <div>
          <label className="label">Real lost stage</label>
          <input className="input" value={realLostStage} onChange={(e) => setRealLostStage(e.target.value)} placeholder="Where the deal was actually lost, not where it was marked" />
        </div>
        <div>
          <label className="label">Lost reason</label>
          <select className="input" value={lostReason} onChange={(e) => setLostReason(e.target.value)}>
            {LOST_REASONS.map((r) => (
              <option key={r} value={r}>{titleCase(r)}</option>
            ))}
          </select>
        </div>
        {lostReason === 'other' && (
          <div>
            <label className="label">Describe (required when other)</label>
            <input className="input" value={otherText} onChange={(e) => setOtherText(e.target.value)} />
          </div>
        )}
        <div>
          <label className="label">Lesson {review.mandatory && '(required)'}</label>
          <textarea className="input min-h-20" value={lesson} onChange={(e) => setLesson(e.target.value)} placeholder="What would we do differently, and at which stage?" />
        </div>
        {error && <p className="text-2xs text-band-critical">{error}</p>}
      </div>
    </Modal>
  );
}
