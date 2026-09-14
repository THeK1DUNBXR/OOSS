/**
 * Technology — incidents, problems and changes (docs/plan/cio.md,
 * workstream E).
 *
 * Incidents run a live timeline (declared → acknowledged → mitigated →
 * resolved → closed), each stamp set once; sev1/sev2 need a published
 * post-incident review before they can close, and a published review is
 * final. Changes run the same approval-gate shape the CRM agreements do:
 * standard changes are pre-approved by kind, normal and emergency changes
 * go through the Operations Head (or the chairman, when the raiser IS the
 * Operations Head — the Self-Dealing Bar), and a normal change cannot be
 * scheduled inside a freeze window unless the freeze itself allows it.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime, titleCase } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
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
} from '../../components/ui.js';
import { CreateModal, messageOf, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IncidentSeverity = 'sev1' | 'sev2' | 'sev3' | 'sev4';
type IncidentStatus = 'declared' | 'acknowledged' | 'mitigated' | 'resolved' | 'closed';

interface IncidentUpdate {
  id: string;
  body: string;
  authorPartyId: string | null;
  at: string;
}

interface Incident {
  id: string;
  recordCode: string | null;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  affectedApplicationIds: string[];
  detectedAt: string;
  acknowledgedAt: string | null;
  mitigatedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  commanderPartyId: string | null;
  impact: string | null;
  customerFacing: boolean;
  problemId: string | null;
  reviewRequired: boolean;
  reviewBody: string | null;
  reviewPublishedAt: string | null;
  updates?: IncidentUpdate[];
  availableTransitions?: string[];
}

type ProblemStatus = 'open' | 'analysing' | 'known_error' | 'resolved' | 'closed';

interface Problem {
  id: string;
  recordCode: string | null;
  title: string;
  status: ProblemStatus;
  rootCause: string | null;
  knownError: boolean;
  workaround: string | null;
  incidentIds: string[];
  availableTransitions?: string[];
  linkedIncidents?: Incident[];
}

type ChangeKind = 'standard' | 'normal' | 'emergency';
type ChangeStatus = 'draft' | 'submitted' | 'approved' | 'scheduled' | 'implemented' | 'reviewed' | 'failed' | 'rolled_back' | 'rejected';

interface Change {
  id: string;
  recordCode: string | null;
  title: string;
  kind: ChangeKind;
  risk: 'low' | 'medium' | 'high';
  status: ChangeStatus;
  plan: string;
  rollbackPlan: string;
  windowStart: string;
  windowEnd: string;
  requesterPartyId: string;
  implementationNote: string | null;
  reviewNote: string | null;
  availableTransitions?: string[];
  freezeInForce?: { name: string; startsAt: string; endsAt: string } | null;
}

interface Freeze {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  allowEmergency: boolean;
}

interface GateResult {
  applied: boolean;
  approvalStepId: string | null;
  resolvedApproverRole: string | null;
  resolutionTier: number;
  selfDealingBarTripped: boolean;
  reason: string;
}

const SEVERITY_LABEL: Record<IncidentSeverity, string> = { sev1: 'Sev1 — business-stopping', sev2: 'Sev2 — major', sev3: 'Sev3 — minor', sev4: 'Sev4 — cosmetic' };
const SEVERITY_TONE: Record<IncidentSeverity, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = { sev1: 'bad', sev2: 'bad', sev3: 'warn', sev4: 'neutral' };
const INCIDENT_STATUS_TONE: Record<IncidentStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  declared: 'bad', acknowledged: 'warn', mitigated: 'accent', resolved: 'good', closed: 'neutral',
};
const CHANGE_STATUS_TONE: Record<ChangeStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  draft: 'neutral', submitted: 'accent', approved: 'accent', scheduled: 'accent', implemented: 'warn',
  reviewed: 'good', failed: 'bad', rolled_back: 'bad', rejected: 'bad',
};

// ---------------------------------------------------------------------------
// Incidents — list
// ---------------------------------------------------------------------------

type IncidentTab = 'open' | 'sev12' | 'resolved' | 'all';

export function ItIncidents() {
  const [tab, setTab] = useState<IncidentTab>('open');
  const [declareOpen, setDeclareOpen] = useState(false);
  const { can } = useSession();

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['it-incidents'],
    queryFn: () => api.get<Incident[]>('/it/incidents'),
  });
  const { data: summary } = useQuery({
    queryKey: ['it-incidents-summary'],
    queryFn: () => api.get<any>('/it/incidents/summary'),
  });

  const filtered = data.filter((i) => {
    if (tab === 'open') return i.status !== 'closed';
    if (tab === 'sev12') return i.severity === 'sev1' || i.severity === 'sev2';
    if (tab === 'resolved') return i.status === 'resolved' || i.status === 'closed';
    return true;
  });

  return (
    <div>
      <PageHeader
        title="Incidents"
        subtitle="A live outage from declared to closed. Sev1/sev2 need a published post-incident review before they can close. The platform does not page anyone — declaring and updating is typed in here."
        actions={can('it_incidents:C') && <NewButton label="Declare incident" onClick={() => setDeclareOpen(true)} />}
      />

      {summary && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Open sev1/sev2" value={summary.notYetMeasured ? '—' : summary.openBySeverity.sev1 + summary.openBySeverity.sev2} sub={summary.notYetMeasured ? 'Nothing to measure yet' : `${summary.openBySeverity.sev1} sev1 · ${summary.openBySeverity.sev2} sev2`} drillTo="/it/incidents" />
          <Metric label="MTTR (30d)" value={summary.mttrMinutes30d == null ? 'Not yet measured' : `${Math.round(summary.mttrMinutes30d)}m`} noActionReason={summary.mttrMinutes30d == null ? 'No incident resolved in the last 30 days.' : undefined} drillTo={summary.mttrMinutes30d != null ? '/it/incidents' : undefined} />
          <Metric label="Customer-facing, open" value={summary.notYetMeasured ? '—' : summary.customerFacingOpen} drillTo="/it/incidents" />
          <Metric label="Reviews outstanding" value={summary.notYetMeasured ? '—' : summary.reviewsOutstanding} tone={summary.reviewsOutstanding > 0 ? 'warn' : 'neutral'} drillTo="/it/incidents" />
        </div>
      )}

      <Tabs
        tabs={[
          { key: 'open', label: 'Open' },
          { key: 'sev12', label: 'Sev1/2' },
          { key: 'resolved', label: 'Resolved' },
          { key: 'all', label: 'All' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {error ? (
        <ErrorBox error={error} />
      ) : isLoading ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <Card><EmptyState message="No incidents here." hint="A quiet queue is not the same as a healthy estate — check the other tabs." /></Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((i) => (
            <Link key={i.id} to={`/it/incidents/${i.id}`} className="block">
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <RecordCode code={i.recordCode} />
                      <StatusChip status={SEVERITY_LABEL[i.severity]} tone={SEVERITY_TONE[i.severity]} />
                      <StatusChip status={i.status} tone={INCIDENT_STATUS_TONE[i.status]} />
                      {i.customerFacing && <span className="chip border-band-watch/40 text-band-watch">customer-facing</span>}
                      {i.reviewRequired && !i.reviewPublishedAt && (i.status === 'resolved' || i.status === 'closed') && (
                        <span className="chip border-band-critical/40 text-band-critical">review outstanding</span>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-ink-100">{i.title}</p>
                  </div>
                  <span className="shrink-0 text-2xs text-ink-500">detected {dateTime(i.detectedAt)}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <DeclareIncidentModal open={declareOpen} onClose={() => setDeclareOpen(false)} />
    </div>
  );
}

function DeclareIncidentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ title: '', severity: 'sev3' as IncidentSeverity, impact: '', customerFacing: false });

  return (
    <CreateModal
      open={open}
      title="Declare an incident"
      submitLabel="Declare"
      onClose={onClose}
      invalidate={[['it-incidents'], ['it-incidents-summary']]}
      onSubmit={() =>
        api.post('/it/incidents', {
          title: form.title,
          severity: form.severity,
          impact: form.impact || undefined,
          customerFacing: form.customerFacing,
        })
      }
    >
      <TextInput label="Title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} required autoFocus />
      <SelectInput
        label="Severity"
        value={form.severity}
        onChange={(v) => setForm({ ...form, severity: v })}
        options={[
          { value: 'sev1', label: 'Sev1 — business-stopping' },
          { value: 'sev2', label: 'Sev2 — major' },
          { value: 'sev3', label: 'Sev3 — minor' },
          { value: 'sev4', label: 'Sev4 — cosmetic' },
        ]}
        hint="Sev1/sev2 need a published review before they can close."
      />
      <TextArea label="Impact" value={form.impact} onChange={(v) => setForm({ ...form, impact: v })} rows={2} placeholder="What's affected and how badly." />
      <label className="flex items-center gap-2 text-xs text-ink-300">
        <input type="checkbox" checked={form.customerFacing} onChange={(e) => setForm({ ...form, customerFacing: e.target.checked })} />
        Customer-facing
      </label>
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// Incident detail
// ---------------------------------------------------------------------------

const INCIDENT_TRANSITION_LABEL: Record<string, string> = { ACKNOWLEDGE: 'Acknowledge', MITIGATE: 'Mitigate', RESOLVE: 'Resolve', CLOSE: 'Close' };

export function ItIncidentDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [updateBody, setUpdateBody] = useState('');
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [reviewBody, setReviewBody] = useState<string | null>(null);

  const { data: incident, isLoading, error } = useQuery({
    queryKey: ['it-incident', id],
    queryFn: () => api.get<Incident>(`/it/incidents/${id}`),
    enabled: Boolean(id),
  });

  const transition = useMutation({
    mutationFn: (event: string) => api.post(`/it/incidents/${id}/transition`, { event }),
    onSuccess: () => {
      setTransitionError(null);
      qc.invalidateQueries({ queryKey: ['it-incident', id] });
      qc.invalidateQueries({ queryKey: ['it-incidents'] });
    },
    onError: (err) => setTransitionError(messageOf(err)),
  });

  const postUpdate = useMutation({
    mutationFn: () => api.post(`/it/incidents/${id}/updates`, { body: updateBody }),
    onSuccess: () => {
      setUpdateBody('');
      qc.invalidateQueries({ queryKey: ['it-incident', id] });
    },
  });

  const saveReview = useMutation({
    mutationFn: (publish: boolean) => api.post(`/it/incidents/${id}/review`, { reviewBody: reviewBody ?? incident?.reviewBody ?? '', publish }),
    onSuccess: () => {
      setTransitionError(null);
      qc.invalidateQueries({ queryKey: ['it-incident', id] });
    },
    onError: (err) => setTransitionError(messageOf(err)),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!incident) return null;

  const reviewLocked = Boolean(incident.reviewPublishedAt);
  const bodyValue = reviewBody ?? incident.reviewBody ?? '';

  return (
    <div>
      <PageHeader
        title={incident.title}
        subtitle={<span className="mono">{incident.recordCode}</span>}
        actions={(incident.availableTransitions ?? []).map((t) => (
          <button key={t} className={t === 'CLOSE' ? 'btn-primary' : 'btn-ghost'} disabled={transition.isPending} onClick={() => transition.mutate(t)}>
            → {INCIDENT_TRANSITION_LABEL[t] ?? titleCase(t)}
          </button>
        ))}
      />

      {transitionError && (
        <div className="mb-4 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-2.5">
          <p className="text-xs text-band-critical">{transitionError}</p>
        </div>
      )}

      <div className="mb-5 flex flex-wrap gap-1.5">
        <StatusChip status={SEVERITY_LABEL[incident.severity]} tone={SEVERITY_TONE[incident.severity]} />
        <StatusChip status={incident.status} tone={INCIDENT_STATUS_TONE[incident.status]} />
        {incident.customerFacing && <span className="chip border-band-watch/40 text-band-watch">customer-facing</span>}
        {incident.problemId && (
          <Link to={`/it/problems/${incident.problemId}`} className="chip border-accent/40 text-accent-soft hover:underline">
            linked problem
          </Link>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Timeline" className="lg:col-span-1">
          <dl>
            <Field label="Detected">{dateTime(incident.detectedAt)}</Field>
            <Field label="Acknowledged">{incident.acknowledgedAt ? dateTime(incident.acknowledgedAt) : '—'}</Field>
            <Field label="Mitigated">{incident.mitigatedAt ? dateTime(incident.mitigatedAt) : '—'}</Field>
            <Field label="Resolved">{incident.resolvedAt ? dateTime(incident.resolvedAt) : '—'}</Field>
            <Field label="Closed">{incident.closedAt ? dateTime(incident.closedAt) : '—'}</Field>
            {incident.impact && <Field label="Impact">{incident.impact}</Field>}
          </dl>
        </Card>

        <Card title="Updates" className="lg:col-span-2">
          <div className="mb-3 flex flex-col gap-2">
            <TextArea label="Post an update" value={updateBody} onChange={setUpdateBody} rows={2} placeholder="What changed, what's being tried next." />
            <button className="btn-ghost self-end" disabled={!updateBody.trim() || postUpdate.isPending} onClick={() => postUpdate.mutate()}>
              Post update
            </button>
          </div>
          {(incident.updates ?? []).length === 0 ? (
            <EmptyState message="No updates posted yet." />
          ) : (
            <div className="space-y-2">
              {[...(incident.updates ?? [])].reverse().map((u) => (
                <div key={u.id} className="rounded border border-ink-800 bg-ink-950 p-2.5">
                  <p className="text-2xs text-ink-500">{dateTime(u.at)}</p>
                  <p className="mt-0.5 text-sm text-ink-200">{u.body}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {incident.reviewRequired && (
        <Card title="Post-incident review" subtitle={reviewLocked ? `Published ${dateTime(incident.reviewPublishedAt)} — final.` : 'Required before this incident can close.'} className="mt-4">
          <TextArea label="Review" value={bodyValue} onChange={(v) => setReviewBody(v)} rows={5} required={!reviewLocked} hint={reviewLocked ? 'Locked — a published review is never edited.' : undefined} />
          {!reviewLocked && (
            <div className="mt-2 flex justify-end gap-2">
              <button className="btn-ghost" disabled={saveReview.isPending} onClick={() => saveReview.mutate(false)}>
                Save draft
              </button>
              <button className="btn-primary" disabled={saveReview.isPending || !bodyValue.trim()} onClick={() => saveReview.mutate(true)}>
                Publish
              </button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

export function ItProblems() {
  const [status, setStatus] = useState<'' | ProblemStatus>('');
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['it-problems', status],
    queryFn: () => api.get<Problem[]>(`/it/problems${status ? `?status=${status}` : ''}`),
  });

  return (
    <div>
      <PageHeader title="Problems" subtitle="The root cause an incident (or several) points back to. A known error has a documented workaround with no fix shipped yet." />
      <Tabs
        tabs={[
          { key: '', label: 'All' },
          { key: 'open', label: 'Open' },
          { key: 'analysing', label: 'Analysing' },
          { key: 'known_error', label: 'Known error' },
          { key: 'resolved', label: 'Resolved' },
        ]}
        active={status}
        onChange={setStatus}
      />
      {error ? <ErrorBox error={error} /> : isLoading ? <Loading /> : data.length === 0 ? (
        <Card><EmptyState message="No problems recorded." /></Card>
      ) : (
        <div className="space-y-2">
          {data.map((p) => (
            <Link key={p.id} to={`/it/problems/${p.id}`} className="block">
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <RecordCode code={p.recordCode} />
                      <StatusChip status={p.status} tone={p.status === 'resolved' || p.status === 'closed' ? 'good' : p.status === 'known_error' ? 'warn' : 'neutral'} />
                      {p.knownError && <span className="chip border-band-watch/40 text-band-watch">known error</span>}
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-ink-100">{p.title}</p>
                  </div>
                  <span className="shrink-0 text-2xs text-ink-500">{p.incidentIds.length} linked incident{p.incidentIds.length === 1 ? '' : 's'}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

const PROBLEM_TRANSITION_LABEL: Record<string, string> = { ANALYSE: 'Start analysis', MARK_KNOWN_ERROR: 'Mark known error', RESOLVE: 'Resolve', REOPEN: 'Reopen', CLOSE: 'Close' };

export function ItProblemDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data: problem, isLoading, error: loadError } = useQuery({
    queryKey: ['it-problem', id],
    queryFn: () => api.get<Problem>(`/it/problems/${id}`),
    enabled: Boolean(id),
  });

  const transition = useMutation({
    mutationFn: (event: string) => api.post(`/it/problems/${id}/transition`, { event }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['it-problem', id] });
      qc.invalidateQueries({ queryKey: ['it-problems'] });
    },
    onError: (err) => setError(messageOf(err)),
  });

  if (isLoading) return <Loading />;
  if (loadError) return <ErrorBox error={loadError} />;
  if (!problem) return null;

  return (
    <div>
      <PageHeader
        title={problem.title}
        subtitle={<span className="mono">{problem.recordCode}</span>}
        actions={(problem.availableTransitions ?? []).map((t) => (
          <button key={t} className="btn-ghost" disabled={transition.isPending} onClick={() => transition.mutate(t)}>
            → {PROBLEM_TRANSITION_LABEL[t] ?? titleCase(t)}
          </button>
        ))}
      />
      {error && (
        <div className="mb-4 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-2.5">
          <p className="text-xs text-band-critical">{error}</p>
        </div>
      )}
      <div className="mb-4"><StatusChip status={problem.status} tone={problem.status === 'resolved' || problem.status === 'closed' ? 'good' : 'neutral'} /></div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Root cause and workaround">
          <dl>
            <Field label="Root cause">{problem.rootCause ?? '—'}</Field>
            <Field label="Known error">{problem.knownError ? 'Yes' : 'No'}</Field>
            <Field label="Workaround">{problem.workaround ?? '—'}</Field>
          </dl>
        </Card>
        <Card title="Linked incidents">
          {(problem.linkedIncidents ?? []).length === 0 ? (
            <EmptyState message="No incidents linked." />
          ) : (
            <div className="space-y-1.5">
              {(problem.linkedIncidents ?? []).map((i) => (
                <Link key={i.id} to={`/it/incidents/${i.id}`} className="flex items-center justify-between rounded border border-ink-800 bg-ink-950 px-2.5 py-2 hover:border-ink-700">
                  <span className="text-sm text-ink-200">{i.title}</span>
                  <StatusChip status={i.status} tone={INCIDENT_STATUS_TONE[i.status]} />
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

type ChangeTab = 'awaiting' | 'scheduled' | 'week' | 'mine' | 'all';

export function ItChanges() {
  const [tab, setTab] = useState<ChangeTab>('awaiting');
  const [newOpen, setNewOpen] = useState(false);
  const [freezesOpen, setFreezesOpen] = useState(false);
  const { can } = useSession();

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['it-changes'],
    queryFn: () => api.get<Change[]>('/it/changes'),
  });
  const { data: summary } = useQuery({
    queryKey: ['it-changes-summary'],
    queryFn: () => api.get<any>('/it/changes/summary'),
  });

  const filtered = data.filter((c) => {
    if (tab === 'awaiting') return c.status === 'submitted';
    if (tab === 'scheduled') return c.status === 'scheduled';
    if (tab === 'week') {
      const start = new Date(c.windowStart).getTime();
      return c.status === 'scheduled' && start <= Date.now() + 7 * 86_400_000 && start >= Date.now() - 86_400_000;
    }
    if (tab === 'mine') return true; // narrowed server-side already for @own scopes
    return true;
  });

  // The server gates `declareFreeze` on `it_changes:edit` alone — match it
  // exactly, so this button is never shown to someone the API would refuse.
  const canDeclareFreeze = can('it_changes:E');

  return (
    <div>
      <PageHeader
        title="Changes"
        subtitle="Standard changes are pre-approved by kind. Normal and emergency changes go through approval, and cannot be scheduled inside a freeze window unless the freeze itself allows it."
        actions={
          <>
            {canDeclareFreeze && <button className="btn-ghost" onClick={() => setFreezesOpen(true)}>Freezes</button>}
            {can('it_changes:C') && <NewButton label="New change" onClick={() => setNewOpen(true)} />}
          </>
        }
      />

      {summary?.freezeInForce && (
        <div className="mb-4 rounded-lg border border-band-watch/40 bg-band-watch/10 px-4 py-2.5">
          <p className="text-xs text-band-watch">
            A freeze is in force: <strong>{summary.freezeInForce.name}</strong>, until {dateTime(summary.freezeInForce.until)}.
            {' '}Blocks {(summary.freezeInForce.blockedKinds ?? []).map(titleCase).join(', ') || 'nothing'} changes from being scheduled.
          </p>
        </div>
      )}

      {summary && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Awaiting approval" value={summary.notYetMeasured ? '—' : summary.awaitingApproval} drillTo="/it/changes" />
          <Metric label="Scheduled this week" value={summary.notYetMeasured ? '—' : summary.scheduledThisWeek} drillTo="/it/changes" />
          <Metric label="Success rate (90d)" value={summary.successRate90d == null ? 'Not yet measured' : `${Math.round(summary.successRate90d * 100)}%`} noActionReason={summary.successRate90d == null ? 'No change has reached reviewed/failed/rolled back in 90 days.' : undefined} drillTo={summary.successRate90d != null ? '/it/changes' : undefined} />
          <Metric label="Freeze in force" value={summary.freezeInForce ? summary.freezeInForce.name : 'None'} tone={summary.freezeInForce ? 'warn' : 'neutral'} drillTo="/it/changes" />
        </div>
      )}

      <Tabs
        tabs={[
          { key: 'awaiting', label: 'Awaiting approval' },
          { key: 'scheduled', label: 'Scheduled' },
          { key: 'week', label: 'This week' },
          { key: 'mine', label: 'Mine' },
          { key: 'all', label: 'All' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {error ? (
        <ErrorBox error={error} />
      ) : isLoading ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <Card><EmptyState message="No changes here." /></Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => (
            <Link key={c.id} to={`/it/changes/${c.id}`} className="block">
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <RecordCode code={c.recordCode} />
                      <StatusChip status={c.status} tone={CHANGE_STATUS_TONE[c.status]} />
                      <span className="chip border-ink-700 text-ink-300">{titleCase(c.kind)}</span>
                      <span className="chip border-ink-700 text-ink-300">{titleCase(c.risk)} risk</span>
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-ink-100">{c.title}</p>
                  </div>
                  <span className="shrink-0 text-2xs text-ink-500">{dateTime(c.windowStart)} → {dateTime(c.windowEnd)}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <NewChangeModal open={newOpen} onClose={() => setNewOpen(false)} />
      <FreezesModal open={freezesOpen} onClose={() => setFreezesOpen(false)} />
    </div>
  );
}

function NewChangeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ title: '', kind: 'standard' as ChangeKind, risk: 'low' as Change['risk'], plan: '', rollbackPlan: '', windowStart: '', windowEnd: '' });

  return (
    <CreateModal
      open={open}
      title="New change"
      submitLabel="Create"
      width="max-w-xl"
      onClose={onClose}
      invalidate={[['it-changes'], ['it-changes-summary']]}
      onSubmit={() =>
        api.post('/it/changes', {
          title: form.title,
          kind: form.kind,
          risk: form.risk,
          plan: form.plan,
          rollbackPlan: form.rollbackPlan,
          windowStart: form.windowStart,
          windowEnd: form.windowEnd,
        })
      }
    >
      <TextInput label="Title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} required autoFocus />
      <Row>
        <SelectInput
          label="Kind"
          value={form.kind}
          onChange={(v) => setForm({ ...form, kind: v })}
          options={[
            { value: 'standard', label: 'Standard — pre-approved' },
            { value: 'normal', label: 'Normal — needs approval' },
            { value: 'emergency', label: 'Emergency — needs approval' },
          ]}
        />
        <SelectInput
          label="Risk"
          value={form.risk}
          onChange={(v) => setForm({ ...form, risk: v })}
          options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]}
        />
      </Row>
      <TextArea label="Plan" value={form.plan} onChange={(v) => setForm({ ...form, plan: v })} required rows={3} />
      <TextArea label="Rollback plan" value={form.rollbackPlan} onChange={(v) => setForm({ ...form, rollbackPlan: v })} required rows={2} />
      <Row>
        <TextInput label="Window start" type="date" value={form.windowStart} onChange={(v) => setForm({ ...form, windowStart: v })} required />
        <TextInput label="Window end" type="date" value={form.windowEnd} onChange={(v) => setForm({ ...form, windowEnd: v })} required />
      </Row>
    </CreateModal>
  );
}

function FreezesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [declareOpen, setDeclareOpen] = useState(false);
  const { data = [] } = useQuery({
    queryKey: ['it-change-freezes'],
    queryFn: () => api.get<Freeze[]>('/it/changes/freezes'),
    enabled: open,
  });

  return (
    <Modal open={open} title="Change freezes" onClose={onClose} width="max-w-xl">
      <div className="mb-3 flex justify-end">
        <NewButton label="Declare a freeze" onClick={() => setDeclareOpen(true)} />
      </div>
      {data.length === 0 ? (
        <EmptyState message="No freezes declared." />
      ) : (
        <div className="space-y-2">
          {data.map((f) => (
            <div key={f.id} className="rounded border border-ink-800 bg-ink-950 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-ink-100">{f.name}</p>
                {f.allowEmergency && <span className="chip border-band-watch/40 text-band-watch">emergency allowed</span>}
              </div>
              <p className="text-2xs text-ink-500">{dateTime(f.startsAt)} → {dateTime(f.endsAt)}</p>
              <p className="mt-1 text-xs text-ink-300">{f.reason}</p>
            </div>
          ))}
        </div>
      )}
      <DeclareFreezeModal open={declareOpen} onClose={() => setDeclareOpen(false)} />
    </Modal>
  );
}

function DeclareFreezeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', startsAt: '', endsAt: '', reason: '', allowEmergency: false });

  return (
    <CreateModal
      open={open}
      title="Declare a freeze"
      submitLabel="Declare"
      onClose={onClose}
      invalidate={[['it-change-freezes'], ['it-changes-summary']]}
      onSubmit={() => api.post('/it/changes/freezes', form)}
    >
      <TextInput label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required autoFocus />
      <Row>
        <TextInput label="Starts" type="date" value={form.startsAt} onChange={(v) => setForm({ ...form, startsAt: v })} required />
        <TextInput label="Ends" type="date" value={form.endsAt} onChange={(v) => setForm({ ...form, endsAt: v })} required />
      </Row>
      <TextArea label="Reason" value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} required rows={2} />
      <label className="flex items-center gap-2 text-xs text-ink-300">
        <input type="checkbox" checked={form.allowEmergency} onChange={(e) => setForm({ ...form, allowEmergency: e.target.checked })} />
        Allow an emergency change to be scheduled inside this freeze
      </label>
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// Change detail
// ---------------------------------------------------------------------------

const CHANGE_TRANSITION_LABEL: Record<string, string> = {
  SUBMIT: 'Submit', APPROVE: 'Approve', REJECT: 'Reject', SCHEDULE: 'Schedule',
  IMPLEMENT: 'Implement', FAIL: 'Mark failed', REVIEW: 'Review', ROLLBACK: 'Roll back',
};

export function ItChangeDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { can } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [gateResult, setGateResult] = useState<GateResult | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteValue, setNoteValue] = useState('');

  const { data: change, isLoading, error: loadError } = useQuery({
    queryKey: ['it-change', id],
    queryFn: () => api.get<Change>(`/it/changes/${id}`),
    enabled: Boolean(id),
  });

  const transition = useMutation({
    mutationFn: (input: { event: string; note?: string }) => api.post<GateResult & { change: Change }>(`/it/changes/${id}/transition`, input),
    onSuccess: (res) => {
      setError(null);
      setNoteFor(null);
      setNoteValue('');
      if (!res.applied) setGateResult(res);
      qc.invalidateQueries({ queryKey: ['it-change', id] });
      qc.invalidateQueries({ queryKey: ['it-changes'] });
    },
    onError: (err) => setError(messageOf(err)),
  });

  if (isLoading) return <Loading />;
  if (loadError) return <ErrorBox error={loadError} />;
  if (!change) return null;

  const needsNote = (t: string) => t === 'IMPLEMENT' || t === 'REVIEW';
  // A control the grant does not permit is omitted, never shown disabled —
  // `APPROVE` needs `it_changes:approve`; everything else needs only the
  // `it_changes:approve` machine to have offered it at all (the server's own
  // `edit`/`create` checks on the other transitions track the matrix, and a
  // refusal there still surfaces through `transitionError`).
  const visibleTransitions = (change.availableTransitions ?? []).filter((t) => t !== 'APPROVE' || can('it_changes:approve'));

  return (
    <div>
      <PageHeader
        title={change.title}
        subtitle={<span className="mono">{change.recordCode}</span>}
        actions={visibleTransitions.map((t) => {
          const gated = t === 'APPROVE';
          return (
            <button
              key={t}
              className={t === 'APPROVE' || t === 'SCHEDULE' ? 'btn-primary' : 'btn-ghost'}
              disabled={transition.isPending}
              title={gated ? 'A privileged transition — runs the approval gate.' : undefined}
              onClick={() => (needsNote(t) ? setNoteFor(t) : transition.mutate({ event: t }))}
            >
              → {CHANGE_TRANSITION_LABEL[t] ?? titleCase(t)}
              {gated && ' ⛨'}
            </button>
          );
        })}
      />

      {error && (
        <div className="mb-4 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-2.5">
          <p className="text-xs text-band-critical">{error}</p>
        </div>
      )}

      <div className="mb-5 flex flex-wrap gap-1.5">
        <StatusChip status={change.status} tone={CHANGE_STATUS_TONE[change.status]} />
        <span className="chip border-ink-700 text-ink-300">{titleCase(change.kind)}</span>
        <span className="chip border-ink-700 text-ink-300">{titleCase(change.risk)} risk</span>
      </div>

      {change.freezeInForce && (
        <div className="mb-4 rounded-lg border border-band-watch/40 bg-band-watch/10 px-4 py-2.5">
          <p className="text-xs text-band-watch">
            A freeze is in force now: <strong>{change.freezeInForce.name}</strong>, until {dateTime(change.freezeInForce.endsAt)}.
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Plan">
          <dl>
            <Field label="Window">{dateTime(change.windowStart)} → {dateTime(change.windowEnd)}</Field>
            <Field label="Plan">{change.plan}</Field>
            <Field label="Rollback plan">{change.rollbackPlan}</Field>
          </dl>
        </Card>
        <Card title="Implementation and review">
          <dl>
            <Field label="Implementation note">{change.implementationNote ?? '—'}</Field>
            <Field label="Review note">{change.reviewNote ?? '—'}</Field>
          </dl>
        </Card>
      </div>

      <Modal open={Boolean(noteFor)} title={noteFor === 'IMPLEMENT' ? 'Implementation note' : 'Review note'} onClose={() => setNoteFor(null)}
        footer={
          <>
            <button className="btn" onClick={() => setNoteFor(null)}>Cancel</button>
            <button className="btn-primary" disabled={!noteValue.trim() || transition.isPending} onClick={() => transition.mutate({ event: noteFor!, note: noteValue })}>
              Save
            </button>
          </>
        }
      >
        <TextArea label={noteFor === 'IMPLEMENT' ? 'What happened' : 'How it went'} value={noteValue} onChange={setNoteValue} rows={4} required hint="Set once — this cannot be edited afterwards." />
      </Modal>

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
                  <span className="text-band-watch">Tripped — the approver may never be the subject owner. Resolution rerouted to the next tier.</span>
                </Field>
              )}
            </dl>
          </div>
        )}
      </Modal>
    </div>
  );
}
