/**
 * Leads.
 *
 * The creation form shows no Owner field at all — ownership is entirely
 * routing-determined, and the creation-time actor must never leak into
 * owner_party_id through any code path. A separately-permissioned override
 * exists as a distinct action, so "owner is whoever's logged in" cannot
 * reappear by a different UI path.
 */

import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VERTICALS, VERTICAL_LABELS, type LeadView, type RoutingAuditView } from '@kaizen/shared';
import { api, date, money, relative, titleCase } from '../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  RecordCode,
  StatusChip,
  Tabs,
} from '../components/ui.js';
import { useSession } from '../lib/session.js';

type LeadTab = 'all' | 'unrouted' | 'mine';

export function Leads() {
  const { user, can } = useSession();
  const [tab, setTab] = useState<LeadTab>('all');
  const [createOpen, setCreateOpen] = useState(false);

  const query =
    tab === 'unrouted' ? '?unrouted=true' : tab === 'mine' && user ? `?ownerPartyId=${user.personId}` : '';

  const { data, isLoading, error } = useQuery({
    queryKey: ['leads', tab],
    queryFn: () => api.get<{ items: LeadView[]; total: number }>(`/crm/leads${query}`),
  });

  const { data: unroutedData } = useQuery({
    queryKey: ['leads', 'unrouted-count'],
    queryFn: () => api.get<{ total: number }>('/crm/leads?unrouted=true&pageSize=1'),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle="New enquiries, and who is looking after each."
        actions={
          can('leads:C') && (
            <button className="btn-primary" onClick={() => setCreateOpen(true)}>
              New lead
            </button>
          )
        }
      />

      <Tabs
        tabs={[
          { key: 'all', label: 'All', count: data?.total },
          { key: 'unrouted', label: 'Unrouted', count: unroutedData?.total },
          { key: 'mine', label: 'Mine' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState
            message={tab === 'unrouted' ? 'Every open lead has a resolved owner.' : 'No leads match.'}
            hint={tab === 'unrouted' ? 'Leads that are still open with nobody assigned.' : undefined}
          />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Lead</th>
                <th>Pipeline / Stage</th>
                <th>Owner</th>
                <th className="text-right">Score</th>
                <th className="text-right">Value</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((l) => (
                <tr key={l.id}>
                  <td>
                    <RecordCode code={l.recordCode} to={`/crm/leads/${l.id}`} />
                  </td>
                  <td>
                    <Link to={`/crm/leads/${l.id}`} className="text-xs font-medium text-ink-100 hover:text-accent-soft">
                      {l.title}
                    </Link>
                    <p className="text-2xs text-ink-500">
                      {l.personName ?? '—'}
                      {l.organizationName && ` · ${l.organizationName}`}
                    </p>
                  </td>
                  <td>
                    <span className="mono">{l.pipelineCode}</span>
                    <p className="text-2xs text-ink-300">{l.stageLabel}</p>
                  </td>
                  <td>
                    {l.unrouted ? (
                      <div>
                        <StatusChip status="unrouted" tone="warn" />
                        {l.unroutedReason && (
                          <p className="mt-0.5 text-2xs text-ink-500" title="The two unrouted causes need different remedies.">
                            {titleCase(l.unroutedReason)}
                          </p>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-ink-300">{l.ownerName ?? 'assigned'}</span>
                    )}
                  </td>
                  <td className="text-right tabular-nums text-xs">{l.score}</td>
                  <td className="text-right tabular-nums text-xs">{money(l.estimatedValue, l.currency)}</td>
                  <td>
                    <span className={`text-xs ${l.stageAgeBreached ? 'text-band-strained' : 'text-ink-400'}`}>
                      {l.stageAgeDays}d
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <CreateLeadModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateLeadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [vertical, setVertical] = useState<string>('sap_enterprise');
  const [district, setDistrict] = useState('Chennai');
  const [value, setValue] = useState('');
  const [source, setSource] = useState('inbound_website');
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Array<Record<string, unknown>> | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post('/crm/leads', {
        title,
        person: { fullName, primaryPhone: phone || null, primaryEmail: email || null },
        vertical,
        district,
        source,
        estimatedValue: value ? Number(value) : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      onClose();
      setTitle('');
      setFullName('');
      setPhone('');
      setEmail('');
      setError(null);
      setCandidates(null);
    },
    onError: (err) => {
      const e = err as { code?: string; message: string; candidates?: Array<Record<string, unknown>> };
      setError(e.message);
      // The 409-with-candidates path: the operator confirms the match or
      // explicitly force-creates with a reason.
      if (e.code === 'DUPLICATE') setCandidates(e.candidates ?? []);
    },
  });

  return (
    <Modal
      open={open}
      title="New lead"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!title || !fullName || (!phone && !email) || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create and route'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">Lead title</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is this about?" />
        </div>

        <div className="rounded-lg border border-ink-800 bg-ink-950 p-3">
          <p className="mb-2 text-2xs text-ink-400">
            A phone or an email is needed, so an existing person is recognised.
          </p>
          <div className="space-y-2">
            <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full name" />
            <div className="grid grid-cols-2 gap-2">
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" />
              <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Vertical</label>
            <select className="input" value={vertical} onChange={(e) => setVertical(e.target.value)}>
              {VERTICALS.map((v) => (
                <option key={v} value={v}>
                  {VERTICAL_LABELS[v]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">District</label>
            <input className="input" value={district} onChange={(e) => setDistrict(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Source</label>
            <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
              {['inbound_website', 'referral', 'event', 'campaign', 'manual', 'cold_outreach'].map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Estimated value</label>
            <input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0" type="number" />
          </div>
        </div>

        {/* No Owner field. Ownership is routing-determined. */}
        <p className="rounded border border-ink-800 bg-ink-950 px-3 py-2 text-2xs text-ink-500">
          Nobody outside the territory or specialism is picked. The rest are scored.
        </p>

        {error && <p className="text-2xs text-band-critical">{error}</p>}

        {candidates && candidates.length > 0 && (
          <div className="rounded-lg border border-band-watch/40 bg-band-watch/5 p-3">
            <p className="text-xs font-medium text-band-watch">Existing people match these details</p>
            <div className="mt-2 space-y-1.5">
              {candidates.map((c, i) => (
                <div key={i} className="text-2xs text-ink-300">
                  <span className="mono">{String(c.recordCode)}</span> {String(c.fullName)}
                  <span className="text-ink-500">
                    {' '}
                    · {String(c.maskedPhone ?? '')} {String(c.maskedEmail ?? '')}
                  </span>
                  {Boolean(c.statutoryRetentionFloor) && (
                    <span className="ml-1 text-band-critical" title="Holds an active employee or student affiliation with a statutory retention floor.">
                      · never auto-merges
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Lead detail, with the routing-audit view
// ---------------------------------------------------------------------------

export function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useSession();

  const { data, isLoading, error } = useQuery({
    queryKey: ['lead', id],
    queryFn: () => api.get<{ lead: any; timeline: any[]; routingAudit: RoutingAuditView | null }>(`/crm/leads/${id}`),
    enabled: Boolean(id),
  });

  const convert = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/crm/leads/${id}/convert`, {}),
    onSuccess: (opp) => navigate(`/crm/opportunities/${opp.id}`),
  });

  const reroute = useMutation({
    mutationFn: () => api.post(`/crm/leads/${id}/reroute`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead', id] }),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const lead = data.lead;
  const stage = lead.pipeline?.stages?.find((s: any) => s.stageKey === lead.stageKey);
  const audit = (data.routingAudit?.candidates ?? []) as any[];

  return (
    <div>
      <PageHeader
        title={lead.title}
        subtitle={
          <span className="mono">
            {lead.recordCode} · {lead.pipeline?.pipelineCode} · {stage?.label}
          </span>
        }
        actions={
          <>
            <button className="btn-ghost" onClick={() => reroute.mutate()} disabled={reroute.isPending}>
              Re-evaluate routing
            </button>
            {can('opportunities:C') && lead.leadStatus === 'open' && (
              <button className="btn-primary" onClick={() => convert.mutate()} disabled={convert.isPending}>
                Convert to opportunity
              </button>
            )}
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Routing audit" subtitle="Who was considered, and why the winner won.">
            {audit.length === 0 ? (
              <EmptyState message="No record of how this was assigned." />
            ) : (
              <div className="space-y-2">
                {audit.map((c) => (
                  <div
                    key={c.candidateId}
                    className={`rounded-lg border p-3 ${c.won ? 'border-accent/50 bg-accent/5' : 'border-ink-800 bg-ink-950'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-ink-100">
                        {c.candidateName}
                        {c.won && <span className="ml-2 chip border-accent/40 text-accent-soft">winner</span>}
                        {c.tieBreakApplied && (
                          <span className="ml-1 chip border-ink-700 text-ink-400" title="Used only to break a tie between equally good matches.">
                            tie-break
                          </span>
                        )}
                      </p>
                      <span className="text-sm font-semibold tabular-nums text-ink-100">{c.total?.toFixed?.(1) ?? c.total}</span>
                    </div>

                    {!c.passedHardFilters ? (
                      <p className="mt-1 text-2xs text-band-strained">
                        Failed the {c.hardFilterFailure} hard filter — never scored on the soft factors at all, because
                        assigning outside territory or grant is an authorization error, not a preference.
                      </p>
                    ) : (
                      <div className="mt-2 space-y-1">
                        {c.factors?.map((f: any) => (
                          <div key={f.factor} className="flex items-center gap-2 text-2xs">
                            <span className="w-40 shrink-0 text-ink-400">{titleCase(f.factor)}</span>
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-800">
                              <div className="h-full bg-accent" style={{ width: `${Math.min(f.raw * 100, 100)}%` }} />
                            </div>
                            <span className="w-20 shrink-0 text-right tabular-nums text-ink-400">
                              {f.weighted.toFixed(1)} / {f.weight}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Timeline" bodyClassName="p-0">
            {data.timeline.length === 0 ? (
              <EmptyState message="Nobody has logged a call or meeting yet." hint="Untouched leads are flagged automatically." />
            ) : (
              <ul className="divide-y divide-ink-850">
                {data.timeline.map((t: any) => (
                  <li key={t.id} className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="chip border-ink-700 text-ink-400">{t.interactionType}</span>
                      <span className="text-2xs text-ink-500">{relative(t.occurredAt)}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-200">{t.subject}</p>
                    {t.notes && <p className="mt-0.5 text-2xs text-ink-400">{t.notes}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Detail">
            <dl>
              <Field label="Status">
                <StatusChip status={lead.leadStatus} tone={lead.leadStatus === 'converted' ? 'good' : 'neutral'} />
              </Field>
              <Field label="Owner">{lead.ownerPartyId ? 'assigned' : <StatusChip status="unrouted" tone="warn" />}</Field>
              <Field label="Territory">{lead.territory?.name ?? '—'}</Field>
              <Field label="Vertical">{titleCase(lead.vertical)}</Field>
              <Field label="Offering">{lead.offering?.name ?? '—'}</Field>
              <Field label="Estimated value">{money(lead.estimatedValue ? Number(lead.estimatedValue) : null, lead.currency)}</Field>
              <Field label="Source">{titleCase(lead.source)}</Field>
              <Field label="Created">{date(lead.createdAt)}</Field>
            </dl>
          </Card>

          <Card title="Lead score" subtitle="Every factor is shown.">
            <p className="text-3xl font-semibold tabular-nums text-ink-50">{lead.score}</p>
            <ul className="mt-2 space-y-0.5">
              {(lead.scoreReasons ?? []).map((r: string, i: number) => (
                <li key={i} className="text-2xs text-ink-400">
                  {r}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
