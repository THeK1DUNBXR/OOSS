/**
 * Technology — security and governance (docs/plan/cio.md, workstream F).
 *
 * Risks (heatmap + list + detail), Policies (draft → published →
 * superseded|retired, publish gated on `it_policies:approve` with a gate
 * modal like `Agreements` in `Commercial.tsx`, acknowledge for the caller),
 * Controls (library + record a test), Access Reviews (campaigns + item
 * decisions + close), Findings (by severity/status + transitions). Every
 * button a detail screen offers comes from `availableTransitions`, computed
 * by the same machine the API enforces against.
 */

import { useState, Fragment } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, dateTime, relative, titleCase } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Field, Loading, Metric, Modal, PageHeader, RecordCode, StatusChip, Tabs } from '../../components/ui.js';
import { NewButton, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';

function rowsOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const items = (data as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

const BAND_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  low: 'good',
  medium: 'accent',
  high: 'warn',
  critical: 'bad',
};

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>;
}

// ===========================================================================
// Risks
// ===========================================================================

type RiskEvent = 'START_TREATING' | 'ACCEPT' | 'CLOSE' | 'REOPEN';

interface RiskRow {
  id: string;
  recordCode: string;
  title: string;
  category: string;
  ownerPartyId: string;
  likelihoodInherent: number;
  impactInherent: number;
  scoreInherent: number;
  bandInherent: string;
  likelihoodResidual: number | null;
  impactResidual: number | null;
  scoreResidual: number | null;
  bandResidual: string | null;
  treatment: string;
  treatmentPlan: string | null;
  reviewDueAt: string | null;
  status: string;
  controlIds: string[];
  availableTransitions: RiskEvent[];
}

interface RisksSummary {
  notYetMeasured: boolean;
  total: number;
  byBand: Record<string, number>;
  open: number;
  reviewsOverdue: number;
}

const CATEGORIES = ['infrastructure', 'application', 'vendor', 'people', 'process', 'physical', 'compliance', 'other'];
const TREATMENTS = ['accept', 'mitigate', 'transfer', 'avoid'];
const SCALE = [1, 2, 3, 4, 5];

export function ItRisks() {
  const { can } = useSession();
  const [band, setBand] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [creating, setCreating] = useState(false);

  const summary = useQuery({ queryKey: ['it-risks-summary'], queryFn: () => api.get<RisksSummary>('/it/risks/summary') });
  const params = new URLSearchParams();
  if (band) params.set('band', band);
  if (status) params.set('status', status);
  const qs = params.toString();
  const risks = useQuery({ queryKey: ['it-risks', band, status], queryFn: () => api.get<RiskRow[]>(`/it/risks${qs ? `?${qs}` : ''}`) });

  if (risks.error) return <ErrorBox error={risks.error} />;
  const s = summary.data;
  const rows = risks.data ?? [];

  // 5x5 heatmap over inherent likelihood/impact — the band of the seeded
  // scoring table at the midpoint score for each cell, coloured via the same
  // band chips the list uses.
  const cellBand = (likelihood: number, impact: number): string => {
    const hits = rows.filter((r) => r.likelihoodInherent === likelihood && r.impactInherent === impact);
    if (hits.length === 0) return '';
    return hits[0].bandInherent;
  };

  return (
    <div>
      <PageHeader
        title="Risks"
        subtitle="The IT risk register: inherent and residual likelihood x impact, scored from a dated banding table, with treatment and a review date. Nothing here is a fixed constant — change the bands and future risks score against the new table."
        actions={can('it_risks:C') ? <NewButton label="New risk" onClick={() => setCreating(true)} /> : undefined}
      />

      {s?.notYetMeasured ? (
        <Card className="mb-5"><EmptyState message="No risks on file yet." hint="Add the first one to start the register." /></Card>
      ) : (
        s && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Total" value={s.total} noActionReason="Every risk on file." />
            <Metric label="Open or treating" value={s.open} tone={s.open > 0 ? 'warn' : 'good'} noActionReason="Not yet accepted or closed." />
            <Metric label="Reviews overdue" value={s.reviewsOverdue} tone={s.reviewsOverdue > 0 ? 'bad' : 'good'} noActionReason="Past their review date, still open or treating." />
            <Metric label="Critical band" value={s.byBand.critical ?? 0} tone={(s.byBand.critical ?? 0) > 0 ? 'bad' : 'good'} noActionReason="Residual if scored, else inherent." />
          </div>
        )
      )}

      <Card title="Heatmap" className="mb-5">
        <p className="mb-2 text-2xs text-ink-500">Inherent likelihood (rows) x impact (columns). A cell's colour is the band of a risk scored there.</p>
        <div className="grid grid-cols-6 gap-1 text-2xs">
          <div />
          {SCALE.map((i) => (
            <div key={`h-${i}`} className="text-center text-ink-500">{i}</div>
          ))}
          {SCALE.slice().reverse().map((l) => (
            <Fragment key={`row-${l}`}>
              <div className="flex items-center text-ink-500">{l}</div>
              {SCALE.map((i) => {
                const b = cellBand(l, i);
                return (
                  <div
                    key={`${l}-${i}`}
                    className={`flex h-8 items-center justify-center rounded border border-ink-800 ${b ? `bg-band-${b === 'low' ? 'strong' : b === 'medium' ? 'watch' : b === 'high' ? 'watch' : 'critical'}/20` : 'bg-ink-900'}`}
                    title={`Likelihood ${l} x impact ${i} = ${l * i}${b ? ` — ${b}` : ''}`}
                  >
                    {b ? <StatusChip status={b} tone={BAND_TONE[b]} /> : <span className="text-ink-700">·</span>}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </Card>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select className="input max-w-40" value={band} onChange={(e) => setBand(e.target.value)}>
          <option value="">Every band</option>
          {['low', 'medium', 'high', 'critical'].map((b) => (
            <option key={b} value={b}>{titleCase(b)}</option>
          ))}
        </select>
        <select className="input max-w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Every status</option>
          {['open', 'treating', 'accepted', 'closed'].map((st) => (
            <option key={st} value={st}>{titleCase(st)}</option>
          ))}
        </select>
      </div>

      <Card bodyClassName="p-0">
        {risks.isLoading ? (
          <Loading label="Loading risks" />
        ) : rows.length === 0 ? (
          <EmptyState message="Nothing matches." hint="Widen the filter, or add a new risk." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2">Risk</th>
                  <th className="px-4 py-2">Category</th>
                  <th className="px-4 py-2">Band</th>
                  <th className="px-4 py-2">Treatment</th>
                  <th className="px-4 py-2">Review due</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-ink-850/60">
                    <td className="px-4 py-2">
                      <Link to={`/it/risks/${r.id}`} className="font-medium text-ink-100 hover:text-accent">{r.title}</Link>
                      <div className="text-2xs text-ink-500"><RecordCode code={r.recordCode} /></div>
                    </td>
                    <td className="px-4 py-2 text-ink-300">{titleCase(r.category)}</td>
                    <td className="px-4 py-2"><StatusChip status={r.bandResidual ?? r.bandInherent} tone={BAND_TONE[r.bandResidual ?? r.bandInherent]} /></td>
                    <td className="px-4 py-2 text-ink-300">{titleCase(r.treatment)}</td>
                    <td className="px-4 py-2 text-ink-300">{r.reviewDueAt ? date(r.reviewDueAt) : '—'}</td>
                    <td className="px-4 py-2"><StatusChip status={r.status} tone={r.status === 'closed' ? 'neutral' : r.status === 'accepted' ? 'good' : 'warn'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && <NewRiskModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewRiskModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [ownerPartyId, setOwnerPartyId] = useState('');
  const [likelihood, setLikelihood] = useState<number>(3);
  const [impact, setImpact] = useState<number>(3);
  const [treatment, setTreatment] = useState('mitigate');
  const [treatmentPlan, setTreatmentPlan] = useState('');
  const [reviewDueAt, setReviewDueAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/it/risks', {
        title,
        category,
        ownerPartyId,
        likelihoodInherent: likelihood,
        impactInherent: impact,
        treatment,
        treatmentPlan: treatmentPlan || undefined,
        reviewDueAt: reviewDueAt || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-risks'] });
      qc.invalidateQueries({ queryKey: ['it-risks-summary'] });
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="New risk"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!title.trim() || !category || !ownerPartyId.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'Saving…' : 'Create'}
          </button>
        </>
      }
    >
      <ErrorLine error={error} />
      <div className="flex flex-col gap-3">
        <TextInput label="Title" value={title} onChange={setTitle} required autoFocus />
        <SelectInput label="Category" value={category} onChange={setCategory} required placeholder="Choose a category" options={CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} />
        <TextInput label="Owner (party id)" value={ownerPartyId} onChange={setOwnerPartyId} required hint="Who is accountable for this risk." />
        <div className="grid grid-cols-2 gap-3">
          <SelectInput label="Likelihood (1-5)" value={String(likelihood)} onChange={(v) => setLikelihood(Number(v))} options={SCALE.map((n) => ({ value: String(n), label: String(n) }))} />
          <SelectInput label="Impact (1-5)" value={String(impact)} onChange={(v) => setImpact(Number(v))} options={SCALE.map((n) => ({ value: String(n), label: String(n) }))} />
        </div>
        <SelectInput label="Treatment" value={treatment} onChange={setTreatment} options={TREATMENTS.map((t) => ({ value: t, label: titleCase(t) }))} />
        <TextArea label="Treatment plan" value={treatmentPlan} onChange={setTreatmentPlan} rows={2} />
        <TextInput label="Review due" type="date" value={reviewDueAt} onChange={setReviewDueAt} />
      </div>
    </Modal>
  );
}

export function ItRiskDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useSession();
  const [scoring, setScoring] = useState(false);

  const risk = useQuery({ queryKey: ['it-risk', id], queryFn: () => api.get<RiskRow>(`/it/risks/${id}`), enabled: Boolean(id) });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['it-risk', id] });
    qc.invalidateQueries({ queryKey: ['it-risks'] });
    qc.invalidateQueries({ queryKey: ['it-risks-summary'] });
  };
  const transition = useMutation({
    mutationFn: (event: RiskEvent) => api.post(`/it/risks/${id}/transition`, { event }),
    onSuccess: invalidate,
  });

  if (risk.error) return <ErrorBox error={risk.error} />;
  if (risk.isLoading || !risk.data) return <Loading label="Loading the risk" />;
  const r = risk.data;
  const canEdit = can('it_risks:E');

  return (
    <div>
      <PageHeader
        title={r.title}
        subtitle={<><RecordCode code={r.recordCode} /> · {titleCase(r.category)}</>}
        actions={<StatusChip status={r.status} tone={r.status === 'closed' ? 'neutral' : r.status === 'accepted' ? 'good' : 'warn'} />}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Scoring" className="lg:col-span-2">
          <dl className="grid gap-x-6 sm:grid-cols-2">
            <Field label="Inherent"><StatusChip status={r.bandInherent} tone={BAND_TONE[r.bandInherent]} /> — likelihood {r.likelihoodInherent} x impact {r.impactInherent} = {r.scoreInherent}</Field>
            <Field label="Residual">
              {r.bandResidual ? (
                <><StatusChip status={r.bandResidual} tone={BAND_TONE[r.bandResidual]} /> — likelihood {r.likelihoodResidual} x impact {r.impactResidual} = {r.scoreResidual}</>
              ) : (
                'Not yet scored'
              )}
            </Field>
            <Field label="Treatment">{titleCase(r.treatment)}</Field>
            <Field label="Review due">{r.reviewDueAt ? date(r.reviewDueAt) : '—'}</Field>
          </dl>
          {r.treatmentPlan && (
            <div className="mt-3 border-t border-ink-800 pt-3">
              <p className="text-2xs uppercase tracking-wide text-ink-500">Treatment plan</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-200">{r.treatmentPlan}</p>
            </div>
          )}
          {canEdit && (
            <button className="btn-ghost btn-sm mt-3" onClick={() => setScoring(true)}>Record residual score</button>
          )}
        </Card>

        <Card title="Actions">
          {!canEdit ? (
            <p className="text-2xs italic text-ink-500">View only from here.</p>
          ) : r.availableTransitions.length === 0 ? (
            <p className="text-2xs text-ink-500">Nothing further — this is where it ends.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {r.availableTransitions.map((event) => (
                <button key={event} className="btn-sm w-full" disabled={transition.isPending} onClick={() => transition.mutate(event)}>
                  {titleCase(event.replace('_', ' '))}
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      {scoring && (
        <ResidualScoreModal riskId={r.id} onClose={() => setScoring(false)} onDone={() => { invalidate(); setScoring(false); }} />
      )}
    </div>
  );
}

function ResidualScoreModal({ riskId, onClose, onDone }: { riskId: string; onClose: () => void; onDone: () => void }) {
  const [likelihood, setLikelihood] = useState<number>(3);
  const [impact, setImpact] = useState<number>(3);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.patch(`/it/risks/${riskId}`, { likelihoodResidual: likelihood, impactResidual: impact }),
    onSuccess: onDone,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal open title="Record residual score" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Saving…' : 'Save'}</button></>}>
      <ErrorLine error={error} />
      <div className="grid grid-cols-2 gap-3">
        <SelectInput label="Residual likelihood" value={String(likelihood)} onChange={(v) => setLikelihood(Number(v))} options={SCALE.map((n) => ({ value: String(n), label: String(n) }))} />
        <SelectInput label="Residual impact" value={String(impact)} onChange={(v) => setImpact(Number(v))} options={SCALE.map((n) => ({ value: String(n), label: String(n) }))} />
      </div>
      <p className="mt-2 text-2xs text-ink-500">Scored against the risk banding table in force today — never a fixed constant.</p>
    </Modal>
  );
}

// ===========================================================================
// Policies
// ===========================================================================

type PolicyEvent = 'PUBLISH' | 'SUPERSEDE' | 'RETIRE';

interface PolicyRow {
  id: string;
  recordCode: string;
  code: string;
  title: string;
  body: string;
  version: number;
  status: string;
  drafterPartyId: string;
  appliesToRoleSlugs: string[];
  reacknowledgeMonths: number | null;
  publishedAt: string | null;
  availableTransitions: PolicyEvent[];
  acknowledgedByMe?: boolean;
}

interface PoliciesSummary {
  notYetMeasured: boolean;
  published: number;
  drafts: number;
  acknowledgementRate: number | null;
}

const POLICY_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  draft: 'neutral',
  published: 'good',
  superseded: 'accent',
  retired: 'bad',
};

export function ItPolicies() {
  const { can } = useSession();
  const [status, setStatus] = useState<string>('');
  const [creating, setCreating] = useState(false);

  const summary = useQuery({ queryKey: ['it-policies-summary'], queryFn: () => api.get<PoliciesSummary>('/it/policies/summary') });
  const policies = useQuery({ queryKey: ['it-policies', status], queryFn: () => api.get<PolicyRow[]>(`/it/policies${status ? `?status=${status}` : ''}`) });
  const awaiting = useQuery({ queryKey: ['it-policies-awaiting'], queryFn: () => api.get<PolicyRow[]>('/it/policies/awaiting') });

  if (policies.error) return <ErrorBox error={policies.error} />;
  const s = summary.data;
  const rows = policies.data ?? [];

  return (
    <div>
      <PageHeader
        title="Policies"
        subtitle="IT policy documents staff acknowledge. A published version is immutable — a change opens a new draft version rather than editing the text underneath someone who has already read it."
        actions={can('it_policies:C') ? <NewButton label="New policy" onClick={() => setCreating(true)} /> : undefined}
      />

      {awaiting.data && awaiting.data.length > 0 && (
        <Card className="mb-5" title="Awaiting your acknowledgement">
          <ul className="flex flex-col gap-1.5">
            {awaiting.data.map((p) => (
              <li key={p.id} className="text-xs text-ink-200">
                <Link to={`/it/policies/${p.id}`} className="text-accent hover:underline">{p.title}</Link> (v{p.version})
              </li>
            ))}
          </ul>
        </Card>
      )}

      {s?.notYetMeasured ? (
        <Card className="mb-5"><EmptyState message="No policies on file yet." /></Card>
      ) : (
        s && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric label="Published" value={s.published} noActionReason="Current policies staff may need to acknowledge." />
            <Metric label="Drafts" value={s.drafts} noActionReason="Not yet published." />
            <Metric
              label="Acknowledgement rate"
              value={s.acknowledgementRate === null ? 'Not yet measured' : `${Math.round(s.acknowledgementRate * 100)}%`}
              tone={s.acknowledgementRate === null ? 'neutral' : s.acknowledgementRate >= 0.9 ? 'good' : 'warn'}
              noActionReason="Across every published policy's target audience."
            />
          </div>
        )
      )}

      <Tabs
        tabs={[
          { key: '', label: 'All' },
          { key: 'draft', label: 'Draft' },
          { key: 'published', label: 'Published' },
          { key: 'superseded', label: 'Superseded' },
          { key: 'retired', label: 'Retired' },
        ]}
        active={status}
        onChange={setStatus}
      />

      <Card bodyClassName="p-0">
        {policies.isLoading ? (
          <Loading label="Loading policies" />
        ) : rows.length === 0 ? (
          <EmptyState message="Nothing matches." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2">Policy</th>
                  <th className="px-4 py-2">Code</th>
                  <th className="px-4 py-2">Version</th>
                  <th className="px-4 py-2">Published</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-b border-ink-850/60">
                    <td className="px-4 py-2">
                      <Link to={`/it/policies/${p.id}`} className="font-medium text-ink-100 hover:text-accent">{p.title}</Link>
                      <div className="text-2xs text-ink-500"><RecordCode code={p.recordCode} /></div>
                    </td>
                    <td className="px-4 py-2 text-ink-300">{p.code}</td>
                    <td className="px-4 py-2 text-ink-300">v{p.version}</td>
                    <td className="px-4 py-2 text-ink-300">{p.publishedAt ? date(p.publishedAt) : '—'}</td>
                    <td className="px-4 py-2"><StatusChip status={p.status} tone={POLICY_TONE[p.status]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && <NewPolicyModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewPolicyModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reacknowledgeMonths, setReacknowledgeMonths] = useState('12');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post('/it/policies', { code, title, body, reacknowledgeMonths: reacknowledgeMonths ? Number(reacknowledgeMonths) : undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-policies'] });
      qc.invalidateQueries({ queryKey: ['it-policies-summary'] });
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="New policy draft"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!code.trim() || !title.trim() || !body.trim() || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Saving…' : 'Create draft'}</button></>}
    >
      <ErrorLine error={error} />
      <div className="flex flex-col gap-3">
        <TextInput label="Code" value={code} onChange={setCode} required autoFocus hint="e.g. IT-POL-REMOTE-ACCESS" />
        <TextInput label="Title" value={title} onChange={setTitle} required />
        <TextArea label="Body" value={body} onChange={setBody} rows={8} required />
        <TextInput label="Re-acknowledge every (months)" type="number" value={reacknowledgeMonths} onChange={setReacknowledgeMonths} />
      </div>
    </Modal>
  );
}

export function ItPolicyDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useSession();
  const [gateResult, setGateResult] = useState<{ applied: boolean; reason: string; approvalStepId: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const policy = useQuery({ queryKey: ['it-policy', id], queryFn: () => api.get<PolicyRow>(`/it/policies/${id}`), enabled: Boolean(id) });
  const acks = useQuery({
    queryKey: ['it-policy-acks', id],
    queryFn: () => api.get<Array<{ id: string; partyId: string; acknowledgedAt: string }>>(`/it/policies/${id}/acknowledgements`),
    enabled: Boolean(id) && can('it_policies:E'),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['it-policy', id] });
    qc.invalidateQueries({ queryKey: ['it-policies'] });
    qc.invalidateQueries({ queryKey: ['it-policies-summary'] });
    qc.invalidateQueries({ queryKey: ['it-policies-awaiting'] });
  };

  const publish = useMutation({
    mutationFn: () => api.post<{ applied: boolean; reason: string; approvalStepId: string | null }>(`/it/policies/${id}/publish`, {}),
    onSuccess: (res) => {
      setError(null);
      if (!res.applied) setGateResult(res);
      invalidate();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });
  const newVersion = useMutation({
    mutationFn: () => api.post<PolicyRow>(`/it/policies/${id}/new-version`, {}),
    onSuccess: (res) => {
      invalidate();
      window.location.href = `/it/policies/${res.id}`;
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });
  const retire = useMutation({ mutationFn: () => api.post(`/it/policies/${id}/retire`, {}), onSuccess: invalidate, onError: (e: unknown) => setError(messageOf(e)) });
  const acknowledge = useMutation({ mutationFn: () => api.post(`/it/policies/${id}/acknowledge`, {}), onSuccess: invalidate, onError: (e: unknown) => setError(messageOf(e)) });

  if (policy.error) return <ErrorBox error={policy.error} />;
  if (policy.isLoading || !policy.data) return <Loading label="Loading the policy" />;
  const p = policy.data;
  const canApprove = can('it_policies:approve');
  const canEdit = can('it_policies:E');

  return (
    <div>
      <PageHeader
        title={p.title}
        subtitle={<><RecordCode code={p.recordCode} /> · {p.code} · v{p.version}</>}
        actions={<StatusChip status={p.status} tone={POLICY_TONE[p.status]} />}
      />

      <ErrorLine error={error} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Body" className="lg:col-span-2">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-200">{p.body}</p>
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Actions">
            <div className="flex flex-col gap-2">
              {p.status === 'draft' && canApprove && (
                <button className="btn-primary btn-sm w-full" disabled={publish.isPending} onClick={() => publish.mutate()}>
                  {publish.isPending ? 'Publishing…' : 'Publish'}
                </button>
              )}
              {p.status === 'draft' && !canApprove && (
                <p className="text-2xs italic text-ink-500">Publishing needs `it_policies:approve` — the drafter never publishes their own draft.</p>
              )}
              {p.status === 'published' && canEdit && (
                <button className="btn-sm w-full" onClick={() => newVersion.mutate()} disabled={newVersion.isPending}>
                  {newVersion.isPending ? 'Opening…' : 'Open new version'}
                </button>
              )}
              {(p.status === 'draft' || p.status === 'published') && canEdit && (
                <button className="btn-ghost btn-sm w-full" onClick={() => retire.mutate()} disabled={retire.isPending}>Retire</button>
              )}
              {p.status === 'published' && p.acknowledgedByMe === false && (
                <button className="btn-primary btn-sm w-full" onClick={() => acknowledge.mutate()} disabled={acknowledge.isPending}>
                  {acknowledge.isPending ? 'Recording…' : 'I have read and acknowledge this'}
                </button>
              )}
              {p.status === 'published' && p.acknowledgedByMe === true && (
                <p className="text-2xs text-band-strong">You have acknowledged v{p.version}.</p>
              )}
            </div>
          </Card>

          <Card title="Details">
            <dl>
              <Field label="Applies to roles">{p.appliesToRoleSlugs.length ? p.appliesToRoleSlugs.join(', ') : 'Everyone'}</Field>
              <Field label="Re-acknowledge every">{p.reacknowledgeMonths ? `${p.reacknowledgeMonths} months` : 'Once per version'}</Field>
              <Field label="Published">{p.publishedAt ? date(p.publishedAt) : 'Not yet'}</Field>
            </dl>
          </Card>

          {canEdit && (
            <Card title="Acknowledgements">
              {!acks.data || acks.data.length === 0 ? (
                <EmptyState message="Nobody has acknowledged this version yet." />
              ) : (
                <ul className="flex flex-col gap-1 text-2xs text-ink-300">
                  {acks.data.map((a) => (
                    <li key={a.id}>{a.partyId} — {date(a.acknowledgedAt)}</li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>

      <Modal open={Boolean(gateResult)} title="Approval required" onClose={() => setGateResult(null)}>
        {gateResult && (
          <div className="space-y-3">
            <p className="text-xs text-ink-200">{gateResult.reason}</p>
            <p className="text-2xs text-ink-500">
              The Self-Dealing Bar means the drafter of a policy never publishes their own draft — this rerouted to the
              next approval tier instead of applying directly.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ===========================================================================
// Controls
// ===========================================================================

interface ControlRow {
  id: string;
  recordCode: string;
  code: string;
  title: string;
  frameworkRefs: Array<{ framework: string; ref: string }>;
  ownerPartyId: string;
  frequencyDays: number;
  lastTestedAt: string | null;
  lastResult: string | null;
  status: string;
}

interface ControlsSummary {
  notYetMeasured: boolean;
  active: number;
  testedInPeriod: number;
  failing: number;
  overdue: number;
}

const RESULT_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { pass: 'good', partial: 'warn', fail: 'bad' };

export function ItControls() {
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<ControlRow | null>(null);

  const summary = useQuery({ queryKey: ['it-controls-summary'], queryFn: () => api.get<ControlsSummary>('/it/controls/summary') });
  const controls = useQuery({ queryKey: ['it-controls'], queryFn: () => api.get<ControlRow[]>('/it/controls') });

  if (controls.error) return <ErrorBox error={controls.error} />;
  const s = summary.data;
  const rows = controls.data ?? [];

  return (
    <div>
      <PageHeader
        title="Controls"
        subtitle="The control library — mapped to the frameworks that name each one (ISO 27001 Annex A to start), tested on its own cadence. lastTestedAt and lastResult are a projection of the append-only test log, never edited directly."
        actions={can('it_controls:C') ? <NewButton label="New control" onClick={() => setCreating(true)} /> : undefined}
      />

      {s?.notYetMeasured ? (
        <Card className="mb-5"><EmptyState message="No controls on file yet." /></Card>
      ) : (
        s && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Active" value={s.active} noActionReason="Not retired." />
            <Metric label="Tested (90d)" value={s.testedInPeriod} noActionReason="Tested in the last 90 days." />
            <Metric label="Failing" value={s.failing} tone={s.failing > 0 ? 'bad' : 'good'} noActionReason="Last result was a fail." />
            <Metric label="Overdue" value={s.overdue} tone={s.overdue > 0 ? 'warn' : 'good'} noActionReason="Past their own frequency, or never tested." />
          </div>
        )
      )}

      <Card bodyClassName="p-0">
        {controls.isLoading ? (
          <Loading label="Loading controls" />
        ) : rows.length === 0 ? (
          <EmptyState message="No controls yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2">Control</th>
                  <th className="px-4 py-2">Frameworks</th>
                  <th className="px-4 py-2">Frequency</th>
                  <th className="px-4 py-2">Last tested</th>
                  <th className="px-4 py-2">Result</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-b border-ink-850/60">
                    <td className="px-4 py-2">
                      <p className="font-medium text-ink-100">{c.title}</p>
                      <div className="text-2xs text-ink-500"><RecordCode code={c.recordCode} /> · {c.code}</div>
                    </td>
                    <td className="px-4 py-2 text-ink-300">{c.frameworkRefs.map((f) => `${f.framework} ${f.ref}`).join(', ') || '—'}</td>
                    <td className="px-4 py-2 text-ink-300">every {c.frequencyDays}d</td>
                    <td className="px-4 py-2 text-ink-300">{c.lastTestedAt ? date(c.lastTestedAt) : 'Never'}</td>
                    <td className="px-4 py-2">{c.lastResult ? <StatusChip status={c.lastResult} tone={RESULT_TONE[c.lastResult]} /> : '—'}</td>
                    <td className="px-4 py-2">
                      {can('it_controls:E') && (
                        <button className="btn-ghost btn-sm" onClick={() => setTesting(c)}>Record a test</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && <NewControlModal onClose={() => setCreating(false)} />}
      {testing && <RecordTestModal control={testing} onClose={() => setTesting(null)} />}
    </div>
  );
}

function NewControlModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [framework, setFramework] = useState('ISO27001');
  const [ref, setRef] = useState('');
  const [ownerPartyId, setOwnerPartyId] = useState('');
  const [frequencyDays, setFrequencyDays] = useState('90');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/it/controls', {
        code,
        title,
        frameworkRefs: ref.trim() ? [{ framework, ref }] : [],
        ownerPartyId,
        frequencyDays: Number(frequencyDays),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-controls'] });
      qc.invalidateQueries({ queryKey: ['it-controls-summary'] });
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal open title="New control" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!code.trim() || !title.trim() || !ownerPartyId.trim() || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Saving…' : 'Create'}</button></>}>
      <ErrorLine error={error} />
      <div className="flex flex-col gap-3">
        <TextInput label="Code" value={code} onChange={setCode} required autoFocus hint="e.g. A.8.9" />
        <TextInput label="Title" value={title} onChange={setTitle} required />
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="Framework" value={framework} onChange={setFramework} />
          <TextInput label="Reference" value={ref} onChange={setRef} hint="e.g. A.8.9" />
        </div>
        <TextInput label="Owner (party id)" value={ownerPartyId} onChange={setOwnerPartyId} required />
        <TextInput label="Frequency (days)" type="number" value={frequencyDays} onChange={setFrequencyDays} required />
      </div>
    </Modal>
  );
}

function RecordTestModal({ control, onClose }: { control: ControlRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<'pass' | 'fail' | 'partial'>('pass');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/it/controls/${control.id}/test`, { result, notes: notes || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-controls'] });
      qc.invalidateQueries({ queryKey: ['it-controls-summary'] });
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal open title={`Record a test — ${control.title}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Saving…' : 'Record'}</button></>}>
      <ErrorLine error={error} />
      <SelectInput label="Result" value={result} onChange={setResult} options={[{ value: 'pass', label: 'Pass' }, { value: 'partial', label: 'Partial' }, { value: 'fail', label: 'Fail' }]} />
      <TextArea label="Notes" value={notes} onChange={setNotes} rows={3} />
    </Modal>
  );
}

// ===========================================================================
// Access reviews
// ===========================================================================

type AccessReviewEvent = 'START_PROGRESS' | 'CLOSE';

interface CampaignRow {
  id: string;
  recordCode: string;
  name: string;
  scope: string;
  scopeRef: string | null;
  dueAt: string;
  status: string;
  itemCount: number;
  decidedCount?: number;
  availableTransitions: AccessReviewEvent[];
}

interface CampaignItem {
  id: string;
  partyId: string;
  partyName: string;
  affiliationId: string | null;
  roleSlug: string | null;
  applicationId: string | null;
  reviewerPartyId: string | null;
  decision: string | null;
  decidedAt: string | null;
  note: string | null;
}

const CAMPAIGN_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = { open: 'warn', in_progress: 'accent', closed: 'good' };

export function ItAccessReviews() {
  const { can } = useSession();
  const [opening, setOpening] = useState(false);
  const campaigns = useQuery({ queryKey: ['it-access-reviews'], queryFn: () => api.get<CampaignRow[]>('/it/access-reviews') });

  if (campaigns.error) return <ErrorBox error={campaigns.error} />;
  const rows = campaigns.data ?? [];

  return (
    <div>
      <PageHeader
        title="Access Reviews"
        subtitle="A campaign is a point-in-time sweep of who has access to what. Opening one materialises one item per active affiliation in scope; a reviewer may never decide their own row."
        actions={can('it_access_reviews:C') ? <NewButton label="Open campaign" onClick={() => setOpening(true)} /> : undefined}
      />

      <Card bodyClassName="p-0">
        {campaigns.isLoading ? (
          <Loading label="Loading campaigns" />
        ) : rows.length === 0 ? (
          <EmptyState message="No campaigns yet." hint="Open one to start a sweep." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2">Campaign</th>
                  <th className="px-4 py-2">Scope</th>
                  <th className="px-4 py-2">Due</th>
                  <th className="px-4 py-2">Progress</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-b border-ink-850/60">
                    <td className="px-4 py-2">
                      <Link to={`/it/access-reviews/${c.id}`} className="font-medium text-ink-100 hover:text-accent">{c.name}</Link>
                      <div className="text-2xs text-ink-500"><RecordCode code={c.recordCode} /></div>
                    </td>
                    <td className="px-4 py-2 text-ink-300">{titleCase(c.scope)}{c.scopeRef ? ` (${c.scopeRef})` : ''}</td>
                    <td className="px-4 py-2 text-ink-300">{date(c.dueAt)}</td>
                    <td className="px-4 py-2 text-ink-300">{c.decidedCount ?? 0} / {c.itemCount}</td>
                    <td className="px-4 py-2"><StatusChip status={c.status} tone={CAMPAIGN_TONE[c.status] ?? 'neutral'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {opening && <OpenCampaignModal onClose={() => setOpening(false)} />}
    </div>
  );
}

function OpenCampaignModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'all' | 'role' | 'application'>('all');
  const [scopeRef, setScopeRef] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post('/it/access-reviews', { name, scope, scopeRef: scope === 'all' ? undefined : scopeRef, dueAt }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-access-reviews'] });
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal open title="Open an access-review campaign" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!name.trim() || !dueAt || (scope !== 'all' && !scopeRef.trim()) || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Opening…' : 'Open'}</button></>}>
      <ErrorLine error={error} />
      <div className="flex flex-col gap-3">
        <TextInput label="Name" value={name} onChange={setName} required autoFocus />
        <SelectInput label="Scope" value={scope} onChange={setScope} options={[{ value: 'all', label: 'Everyone' }, { value: 'role', label: 'A role' }, { value: 'application', label: 'An application' }]} />
        {scope !== 'all' && (
          <TextInput label={scope === 'role' ? 'Role slug' : 'Application id'} value={scopeRef} onChange={setScopeRef} required />
        )}
        <TextInput label="Due date" type="date" value={dueAt} onChange={setDueAt} required />
      </div>
    </Modal>
  );
}

export function ItAccessReviewDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<CampaignItem | null>(null);

  const campaign = useQuery({
    queryKey: ['it-access-review', id],
    queryFn: () => api.get<CampaignRow & { items: CampaignItem[] }>(`/it/access-reviews/${id}`),
    enabled: Boolean(id),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['it-access-review', id] });
    qc.invalidateQueries({ queryKey: ['it-access-reviews'] });
  };
  const close = useMutation({ mutationFn: () => api.post(`/it/access-reviews/${id}/close`, {}), onSuccess: invalidate, onError: (e: unknown) => setError(messageOf(e)) });

  if (campaign.error) return <ErrorBox error={campaign.error} />;
  if (campaign.isLoading || !campaign.data) return <Loading label="Loading the campaign" />;
  const c = campaign.data;
  const canEdit = can('it_access_reviews:E');
  const undecided = c.items.filter((i) => !i.decidedAt).length;

  return (
    <div>
      <PageHeader
        title={c.name}
        subtitle={<><RecordCode code={c.recordCode} /> · {titleCase(c.scope)}{c.scopeRef ? ` (${c.scopeRef})` : ''} · due {date(c.dueAt)}</>}
        actions={<StatusChip status={c.status} tone={CAMPAIGN_TONE[c.status] ?? 'neutral'} />}
      />

      <ErrorLine error={error} />

      {c.status !== 'closed' && canEdit && (
        <div className="mb-4">
          <button className="btn-primary btn-sm" disabled={undecided > 0 || close.isPending} onClick={() => close.mutate()} title={undecided > 0 ? `${undecided} item(s) still need a decision.` : undefined}>
            {close.isPending ? 'Closing…' : `Close campaign${undecided > 0 ? ` (${undecided} left)` : ''}`}
          </button>
        </div>
      )}

      <Card bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                <th className="px-4 py-2">Party</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Decision</th>
                <th className="px-4 py-2">Decided</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {c.items.map((i) => (
                <tr key={i.id} className="border-b border-ink-850/60">
                  <td className="px-4 py-2 text-ink-200">{i.partyName}</td>
                  <td className="px-4 py-2 text-ink-300">{i.roleSlug ?? '—'}</td>
                  <td className="px-4 py-2">{i.decision ? <StatusChip status={i.decision} tone={i.decision === 'revoke' ? 'bad' : i.decision === 'modify' ? 'warn' : 'good'} /> : <span className="text-2xs text-ink-500">Pending</span>}</td>
                  <td className="px-4 py-2 text-2xs text-ink-500" title={i.decidedAt ? dateTime(i.decidedAt) : undefined}>{i.decidedAt ? relative(i.decidedAt) : '—'}</td>
                  <td className="px-4 py-2">
                    {c.status !== 'closed' && !i.decidedAt && canEdit && (
                      <button className="btn-ghost btn-sm" onClick={() => setDeciding(i)}>Decide</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {deciding && (
        <DecideItemModal
          reviewId={c.id}
          item={deciding}
          onClose={() => setDeciding(null)}
          onDone={() => { invalidate(); setDeciding(null); }}
        />
      )}
    </div>
  );
}

function DecideItemModal({ reviewId, item, onClose, onDone }: { reviewId: string; item: CampaignItem; onClose: () => void; onDone: () => void }) {
  const [decision, setDecision] = useState<'keep' | 'revoke' | 'modify'>('keep');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/it/access-reviews/${reviewId}/items/${item.id}/decide`, { decision, note: note || undefined }),
    onSuccess: onDone,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal open title={`Decide — ${item.partyName}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Saving…' : 'Record decision'}</button></>}>
      <ErrorLine error={error} />
      <SelectInput label="Decision" value={decision} onChange={setDecision} options={[{ value: 'keep', label: 'Keep' }, { value: 'modify', label: 'Modify' }, { value: 'revoke', label: 'Revoke' }]} />
      {decision === 'revoke' && (
        <p className="mt-1 text-2xs text-band-watch">Revoke does not change the affiliation itself — it raises an exception for the Operations Head to act on.</p>
      )}
      <TextArea label="Note" value={note} onChange={setNote} rows={2} />
    </Modal>
  );
}

// ===========================================================================
// Findings
// ===========================================================================

type FindingEvent = 'START' | 'ACCEPT_RISK' | 'FIX' | 'VERIFY' | 'REOPEN';

interface FindingRow {
  id: string;
  recordCode: string;
  title: string;
  source: string;
  severity: string;
  cvss: number | null;
  description: string | null;
  applicationId: string | null;
  assetId: string | null;
  dueAt: string;
  status: string;
  changeId: string | null;
  availableTransitions: FindingEvent[];
}

interface FindingsSummary {
  notYetMeasured: boolean;
  openBySeverity: Record<string, number>;
  overdue: number;
}

const SEVERITY_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { critical: 'bad', high: 'bad', medium: 'warn', low: 'neutral' };
const FINDING_STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = {
  open: 'warn',
  in_progress: 'warn',
  risk_accepted: 'neutral',
  fixed: 'good',
  verified: 'good',
};

export function ItFindings() {
  const { can } = useSession();
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);

  const summary = useQuery({ queryKey: ['it-findings-summary'], queryFn: () => api.get<FindingsSummary>('/it/findings/summary') });
  const params = new URLSearchParams();
  if (severity) params.set('severity', severity);
  if (status) params.set('status', status);
  const qs = params.toString();
  const findings = useQuery({ queryKey: ['it-findings', severity, status], queryFn: () => api.get<FindingRow[]>(`/it/findings${qs ? `?${qs}` : ''}`) });
  const qc = useQueryClient();

  const transition = useMutation({
    mutationFn: ({ id, event }: { id: string; event: FindingEvent }) => api.post(`/it/findings/${id}/transition`, { event }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-findings'] });
      qc.invalidateQueries({ queryKey: ['it-findings-summary'] });
    },
  });

  if (findings.error) return <ErrorBox error={findings.error} />;
  const s = summary.data;
  const rows = findings.data ?? [];

  return (
    <div>
      <PageHeader
        title="Findings"
        subtitle="Security findings from a pentest, a scan, an audit, or raised internally. Each one's due date follows the remediation SLA table in force the day it was raised — critical 7 days, high 30, medium 90, low 180 by default."
        actions={can('it_findings:C') ? <NewButton label="New finding" onClick={() => setCreating(true)} /> : undefined}
      />

      {s?.notYetMeasured ? (
        <Card className="mb-5"><EmptyState message="No findings on file yet." /></Card>
      ) : (
        s && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {(['critical', 'high', 'medium', 'low'] as const).map((sev) => (
              <Metric key={sev} label={titleCase(sev)} value={s.openBySeverity[sev] ?? 0} tone={s.openBySeverity[sev] > 0 ? (sev === 'critical' || sev === 'high' ? 'bad' : 'warn') : 'good'} noActionReason="Open or in progress." />
            ))}
            <Metric label="Overdue" value={s.overdue} tone={s.overdue > 0 ? 'bad' : 'good'} noActionReason="Past due, still open." />
          </div>
        )
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select className="input max-w-40" value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="">Every severity</option>
          {['critical', 'high', 'medium', 'low'].map((sv) => (
            <option key={sv} value={sv}>{titleCase(sv)}</option>
          ))}
        </select>
        <select className="input max-w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Every status</option>
          {['open', 'in_progress', 'risk_accepted', 'fixed', 'verified'].map((st) => (
            <option key={st} value={st}>{titleCase(st.replace('_', ' '))}</option>
          ))}
        </select>
      </div>

      <Card bodyClassName="p-0">
        {findings.isLoading ? (
          <Loading label="Loading findings" />
        ) : rows.length === 0 ? (
          <EmptyState message="Nothing matches." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2">Finding</th>
                  <th className="px-4 py-2">Source</th>
                  <th className="px-4 py-2">Severity</th>
                  <th className="px-4 py-2">Due</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.id} className="border-b border-ink-850/60">
                    <td className="px-4 py-2">
                      <p className="font-medium text-ink-100">{f.title}</p>
                      <div className="text-2xs text-ink-500"><RecordCode code={f.recordCode} /></div>
                    </td>
                    <td className="px-4 py-2 text-ink-300">{titleCase(f.source)}</td>
                    <td className="px-4 py-2"><StatusChip status={f.severity} tone={SEVERITY_TONE[f.severity]} /></td>
                    <td className="px-4 py-2 text-ink-300">{date(f.dueAt)}</td>
                    <td className="px-4 py-2"><StatusChip status={f.status} tone={FINDING_STATUS_TONE[f.status]} /></td>
                    <td className="px-4 py-2">
                      {can('it_findings:E') && (
                        <div className="flex flex-wrap justify-end gap-1">
                          {f.availableTransitions.map((event) => (
                            <button key={event} className="btn-ghost btn-sm" disabled={transition.isPending} onClick={() => transition.mutate({ id: f.id, event })}>
                              {titleCase(event.replace('_', ' '))}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && <NewFindingModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewFindingModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [source, setSource] = useState<'pentest' | 'scan' | 'audit' | 'internal'>('scan');
  const [severity, setSeverity] = useState<'critical' | 'high' | 'medium' | 'low'>('medium');
  const [cvss, setCvss] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post('/it/findings', { title, source, severity, cvss: cvss ? Number(cvss) : undefined, description: description || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-findings'] });
      qc.invalidateQueries({ queryKey: ['it-findings-summary'] });
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal open title="New finding" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!title.trim() || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Saving…' : 'Create'}</button></>}>
      <ErrorLine error={error} />
      <div className="flex flex-col gap-3">
        <TextInput label="Title" value={title} onChange={setTitle} required autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <SelectInput label="Source" value={source} onChange={setSource} options={[{ value: 'pentest', label: 'Pentest' }, { value: 'scan', label: 'Scan' }, { value: 'audit', label: 'Audit' }, { value: 'internal', label: 'Internal' }]} />
          <SelectInput label="Severity" value={severity} onChange={setSeverity} options={[{ value: 'critical', label: 'Critical' }, { value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }]} />
        </div>
        <TextInput label="CVSS (optional)" type="number" value={cvss} onChange={setCvss} />
        <TextArea label="Description" value={description} onChange={setDescription} rows={3} />
      </div>
    </Modal>
  );
}
