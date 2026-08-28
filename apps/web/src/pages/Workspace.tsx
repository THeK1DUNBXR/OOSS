/**
 * The Employee / Manager Workspace and the exception queue.
 *
 * A workspace is a different archetype from the Command Center: the unit of
 * attention is a record row and the write path is an ordinary field edit. The
 * relevance ranking is six-band lexicographic — band always dominates score, so
 * ranking cannot be out-argued by a large number.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OpportunityView, LeadView } from '@kaizen/shared';
import { api, date, money, relative, titleCase } from '../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Loading,
  Metric,
  Modal,
  PageHeader,
  RecordCode,
  SeverityChip,
  StatusChip,
  Tabs,
} from '../components/ui.js';
import { useSession } from '../lib/session.js';

export function Workspace() {
  const { user, can } = useSession();
  const qc = useQueryClient();

  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => api.get<any[]>('/crm/tasks?mine=true'),
  });

  const { data: opps } = useQuery({
    queryKey: ['my-opportunities', user?.personId],
    queryFn: () => api.get<{ items: OpportunityView[] }>(`/crm/opportunities?open=true&ownerPartyId=${user!.personId}`),
    enabled: Boolean(user?.personId) && can('opportunities:V'),
  });

  const { data: unrouted } = useQuery({
    queryKey: ['unrouted'],
    queryFn: () => api.get<{ items: LeadView[]; total: number }>('/crm/leads?unrouted=true'),
    enabled: can('leads:V'),
  });

  const { data: exceptions = [] } = useQuery({
    queryKey: ['my-exceptions'],
    queryFn: () => api.get<any[]>('/command/exceptions?mine=true'),
    enabled: can('exceptions:V'),
  });

  const { data: approvals = [] } = useQuery({
    queryKey: ['my-approvals'],
    queryFn: () => api.get<any[]>('/commercial/approvals?mine=true'),
  });

  const complete = useMutation({
    mutationFn: (id: string) => api.post(`/crm/tasks/${id}/complete`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });

  if (!user) return null;

  const overdueTasks = tasks.filter((t) => t.dueAt && new Date(t.dueAt) < new Date()).length;
  const pipelineValue = (opps?.items ?? []).reduce((s, o) => s + (o.expectedValue ?? 0), 0);

  return (
    <div>
      <PageHeader
        title={`Good day, ${user.fullName.split(' ')[0]}`}
        subtitle={
          <span>
            Acting as <span className="text-ink-200">{titleCase(user.roleSlug)}</span> · classification ceiling{' '}
            <span className="text-ink-200">{user.classificationCeiling}</span>
          </span>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Open tasks"
          value={tasks.length}
          sub={overdueTasks > 0 ? `${overdueTasks} overdue` : 'none overdue'}
          tone={overdueTasks > 0 ? 'warn' : 'neutral'}
          drillTo="/workspace"
        />
        {can('opportunities:V') && (
          <Metric label="My open pipeline" value={money(pipelineValue)} sub={`${opps?.items.length ?? 0} opportunities`} drillTo="/crm/pipeline" />
        )}
        {can('exceptions:V') && (
          <Metric
            label="Exceptions owned"
            value={exceptions.length}
            tone={exceptions.length > 0 ? 'warn' : 'good'}
            sub="Every exception arrives pre-owned"
            drillTo="/exceptions"
          />
        )}
        {can('leads:V') && (
          <Metric
            label="Unrouted leads"
            value={unrouted?.total ?? 0}
            tone={(unrouted?.total ?? 0) > 0 ? 'warn' : 'good'}
            sub="Abnormal the moment routing fails, not after a grace period"
            drillTo="/crm/leads"
          />
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="My queue" subtitle="Ranked by band before score — a large number cannot out-argue an urgent band." bodyClassName="p-0">
          {tasks.length === 0 ? (
            <EmptyState message="Nothing due." />
          ) : (
            <ul className="divide-y divide-ink-850">
              {tasks.map((t) => {
                const overdue = t.dueAt && new Date(t.dueAt) < new Date();
                return (
                  <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs text-ink-100">{t.title}</p>
                      <p className="text-2xs text-ink-500">
                        <span className="font-mono">{t.recordCode}</span>
                        {t.dueAt && (
                          <span className={overdue ? 'ml-2 text-band-strained' : 'ml-2'}>
                            due {date(t.dueAt)}
                            {overdue && ' · overdue'}
                          </span>
                        )}
                      </p>
                    </div>
                    <button className="btn-ghost shrink-0" onClick={() => complete.mutate(t.id)}>
                      Complete
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {approvals.length > 0 && (
          <Card title="Awaiting your approval" subtitle="Resolved to you by policy, before any notification fired." bodyClassName="p-0">
            <ul className="divide-y divide-ink-850">
              {approvals.map((a) => (
                <li key={a.id} className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="chip border-accent/40 text-accent-soft">{a.action}</span>
                    {a.slaBreached && <span className="chip border-band-critical/40 text-band-critical">SLA breached</span>}
                  </div>
                  <p className="mt-1 text-xs text-ink-100">{a.subjectLabel}</p>
                  <Link to="/commercial/approvals" className="mt-1 inline-block text-2xs text-accent-soft hover:underline">
                    Open the approval queue →
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {can('opportunities:V') && (
          <Card title="My pipeline" actions={<Link to="/crm/pipeline" className="btn-ghost">Board</Link>} bodyClassName="p-0">
            {(opps?.items ?? []).length === 0 ? (
              <EmptyState message="No open opportunities assigned to you." />
            ) : (
              <ul className="divide-y divide-ink-850">
                {opps!.items.slice(0, 10).map((o) => (
                  <li key={o.id} className="px-4 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link to={`/crm/opportunities/${o.id}`} className="text-xs font-medium text-ink-100 hover:text-accent-soft">
                          {o.title}
                        </Link>
                        <p className="text-2xs text-ink-500">
                          {o.stageLabel} · {o.organizationName ?? '—'}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xs tabular-nums text-ink-200">{money(o.expectedValue, o.currency)}</p>
                        <StatusChip status={o.forecastCategory} tone={o.forecastCategory === 'commit' ? 'good' : 'neutral'} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {can('exceptions:V') && exceptions.length > 0 && (
          <Card title="Exceptions you own" bodyClassName="p-0">
            <ul className="divide-y divide-ink-850">
              {exceptions.slice(0, 10).map((e) => (
                <li key={e.id} className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <SeverityChip severity={e.severity} />
                    <span className="mono">{e.code}</span>
                  </div>
                  <p className="mt-1 text-xs text-ink-100">{e.label}</p>
                  <p className="text-2xs text-ink-500">{e.subjectLabel}</p>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export function Exceptions() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'open' | 'mine' | 'unowned' | 'breached' | 'resolved'>('open');
  const [resolving, setResolving] = useState<any>(null);

  const query =
    tab === 'mine' ? '?mine=true' : tab === 'unowned' ? '?unowned=true' : tab === 'breached' ? '?breached=true' : tab === 'resolved' ? '?state=resolved' : '';

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['exceptions', tab],
    queryFn: () => api.get<any[]>(`/command/exceptions${query}`),
  });

  const acknowledge = useMutation({
    mutationFn: (id: string) => api.post(`/command/exceptions/${id}/acknowledge`, { note: 'Acknowledged.' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exceptions'] }),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Exceptions"
        subtitle="A record in an actionable bad state, with a resolved owner — never a data point buried in a report someone has to notice. Escalation is bounded to four named triggers."
      />

      <Tabs
        tabs={[
          { key: 'open', label: 'Open', count: data.length },
          { key: 'mine', label: 'Mine' },
          { key: 'unowned', label: 'Unowned' },
          { key: 'breached', label: 'SLA breached' },
          { key: 'resolved', label: 'Resolved' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState
            message={tab === 'unowned' ? 'Every open exception has a resolved owner.' : 'Nothing open.'}
            hint="The queue shows zero items only when zero are actually open."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {data.map((e) => (
            <Card key={e.id} bodyClassName="p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SeverityChip severity={e.severity} />
                    <span className="mono">{e.code}</span>
                    <span className="chip border-ink-700 text-ink-400">{e.domain}</span>
                    <StatusChip status={e.state} tone={e.state === 'resolved' ? 'good' : e.state === 'escalated' ? 'warn' : 'neutral'} />
                    {e.slaBreached && <span className="chip border-band-critical/40 text-band-critical">SLA breached</span>}
                    {e.ownerUnresolved && (
                      <span className="chip border-band-strained/40 text-band-strained" title="A routing defect — a measured category feeding H_OPS, not a blank field to notice.">
                        owner unresolved
                      </span>
                    )}
                    {e.ladderRung && <span className="chip border-ink-800 text-ink-500">rung {e.ladderRung}</span>}
                  </div>

                  <p className="mt-1.5 text-xs font-medium text-ink-100">{e.label}</p>
                  <p className="mt-0.5 text-2xs text-ink-400">{e.detail}</p>
                  <p className="mt-1 text-2xs text-ink-500">
                    {e.subjectLabel} · owner {e.ownerName ?? '— unresolved'} · raised {relative(e.raisedAt)}
                    {e.slaDueAt && ` · SLA ${date(e.slaDueAt)}`}
                    {e.escalationTrigger && ` · escalated on ${titleCase(e.escalationTrigger)}`}
                  </p>
                </div>

                {e.state !== 'resolved' && (
                  <div className="flex shrink-0 gap-1">
                    {e.state === 'open' && (
                      <button className="btn-ghost" onClick={() => acknowledge.mutate(e.id)}>
                        Acknowledge
                      </button>
                    )}
                    <button className="btn-primary" onClick={() => setResolving(e)}>
                      Resolve
                    </button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <ResolveModal exception={resolving} onClose={() => setResolving(null)} />
    </div>
  );
}

function ResolveModal({ exception, onClose }: { exception: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');

  const resolve = useMutation({
    mutationFn: () => api.post(`/command/exceptions/${exception.id}/resolve`, { note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['command-center'] });
      onClose();
      setNote('');
    },
  });

  if (!exception) return null;

  return (
    <Modal
      open
      title={`Resolve ${exception.code}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => resolve.mutate()} disabled={!note || resolve.isPending}>
            Resolve
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-200">{exception.label}</p>
        <p className="text-2xs text-ink-400">{exception.detail}</p>
        <div>
          <label className="label">Resolution note (required)</label>
          <textarea className="input min-h-20" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you do about it?" />
        </div>
      </div>
    </Modal>
  );
}
