/**
 * Technology — portfolio and budget (docs/plan/cio.md, workstream G).
 *
 * Portfolio (kanban by stage, tabs by theme), Initiative detail (business
 * case, budget vs spend, updates feed, transitions with the same gate-result
 * modal `Agreements` in Commercial.tsx renders), Roadmap (a quarters x
 * themes grid), Budget (FY picker, planned/actual/variance, run vs grow),
 * Technical debt (list, transitions).
 */

import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DIVISION_LABELS, type Division } from '@kaizen/shared';
import { api, dateTime, money, titleCase } from '../../lib/api.js';
import {
  Card,
  ContributionBar,
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
import { CreateModal, MoneyInput, NewButton, Row, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const THEMES = ['run', 'grow', 'transform'] as const;
const THEME_LABELS: Record<string, string> = { run: 'Run', grow: 'Grow', transform: 'Transform' };

const STAGES = ['idea', 'assessed', 'approved', 'in_flight', 'delivered', 'benefits_realised', 'cancelled'] as const;
const STAGE_LABELS: Record<string, string> = {
  idea: 'Idea',
  assessed: 'Assessed',
  approved: 'Approved',
  in_flight: 'In flight',
  delivered: 'Delivered',
  benefits_realised: 'Benefits realised',
  cancelled: 'Cancelled',
};

function RagChip({ rag }: { rag: string | null }) {
  if (!rag) return <span className="chip border-ink-700 text-ink-500">no RAG yet</span>;
  const tone = rag === 'green' ? 'good' : rag === 'amber' ? 'warn' : 'bad';
  return <StatusChip status={rag} tone={tone} />;
}

interface PersonRow {
  id: string;
  personId: string;
  fullName: string;
}

/** A sponsor/owner picker, in the same shape `NewEnrollment`'s contact
 * search uses in createForms.tsx — a searchable select built from a small
 * list, not a new component in a file this workstream may not edit. */
function usePeople(enabled: boolean) {
  const { data = [] } = useQuery({
    queryKey: ['it-portfolio-people'],
    queryFn: () => api.get<PersonRow[]>('/hr/employees?pageSize=500'),
    enabled,
  });
  return data;
}

function PersonPicker({
  label,
  value,
  onChange,
  people,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  people: PersonRow[];
  required?: boolean;
}) {
  return (
    <SelectInput
      label={label}
      required={required}
      value={value}
      onChange={onChange}
      placeholder={people.length ? 'Search by name' : 'Nobody on file yet'}
      options={people.map((p) => ({ value: p.personId, label: p.fullName }))}
    />
  );
}

// ---------------------------------------------------------------------------
// Portfolio — kanban by stage, tabs by theme
// ---------------------------------------------------------------------------

interface InitiativeRow {
  id: string;
  recordCode: string;
  title: string;
  theme: string;
  stage: string;
  rag: string | null;
  budget: number;
  currency: string;
  targetQuarter: string | null;
  sponsorPartyId: string;
  ownerPartyId: string;
}

interface PortfolioSummary {
  notYetMeasured: boolean;
  byStage: Record<string, number>;
  byRag: { green: number; amber: number; red: number; total: number; worst: string | null };
}

export function ItPortfolio() {
  const [theme, setTheme] = useState<'all' | (typeof THEMES)[number]>('all');
  const [creating, setCreating] = useState(false);
  const { can } = useSession();

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['it-initiatives', theme],
    queryFn: () => api.get<InitiativeRow[]>(`/it/initiatives${theme === 'all' ? '' : `?theme=${theme}`}`),
  });

  const { data: summary } = useQuery({
    queryKey: ['it-initiatives-summary'],
    queryFn: () => api.get<PortfolioSummary>('/it/initiatives/summary'),
  });

  const people = usePeople(creating);
  const [title, setTitle] = useState('');
  const [itTheme, setItTheme] = useState<(typeof THEMES)[number]>('run');
  const [sponsorPartyId, setSponsorPartyId] = useState('');
  const [ownerPartyId, setOwnerPartyId] = useState('');
  const [businessCase, setBusinessCase] = useState('');
  const [expectedBenefit, setExpectedBenefit] = useState('');
  const [budget, setBudget] = useState('');
  const [targetQuarter, setTargetQuarter] = useState('');

  const resetForm = () => {
    setTitle('');
    setItTheme('run');
    setSponsorPartyId('');
    setOwnerPartyId('');
    setBusinessCase('');
    setExpectedBenefit('');
    setBudget('');
    setTargetQuarter('');
  };

  const byStage = useMemo(() => {
    const map: Record<string, InitiativeRow[]> = {};
    for (const s of STAGES) map[s] = [];
    for (const row of data) (map[row.stage] ??= []).push(row);
    return map;
  }, [data]);

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Portfolio"
        subtitle="Every technology initiative, from idea to benefits realised. Approving a sponsor's own initiative reroutes on the Self-Dealing Bar."
        actions={can('it_initiatives:create') ? <NewButton label="New initiative" onClick={() => setCreating(true)} /> : undefined}
      />

      {summary && !summary.notYetMeasured && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="In flight" value={summary.byStage.in_flight ?? 0} drillTo="/it/portfolio" />
          <Metric label="Delivered" value={summary.byStage.delivered ?? 0} drillTo="/it/portfolio" />
          <Metric label="Red" value={summary.byRag.red} tone={summary.byRag.red > 0 ? 'bad' : 'neutral'} drillTo="/it/portfolio" />
          <Metric label="Amber" value={summary.byRag.amber} tone={summary.byRag.amber > 0 ? 'warn' : 'neutral'} drillTo="/it/portfolio" />
        </div>
      )}
      {summary?.notYetMeasured && (
        <Card className="mb-4"><EmptyState message="Nothing to measure yet" hint="No initiatives have been proposed." /></Card>
      )}

      <Tabs
        tabs={[{ key: 'all', label: 'All themes' }, ...THEMES.map((t) => ({ key: t, label: THEME_LABELS[t] }))]}
        active={theme}
        onChange={setTheme}
      />

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card><EmptyState message="No initiatives yet." hint="Propose one to see it here." /></Card>
      ) : (
        <div className="grid gap-3 overflow-x-auto pb-2 sm:grid-cols-2 lg:grid-cols-4">
          {STAGES.filter((s) => s !== 'cancelled').map((stage) => (
            <div key={stage} className="min-w-[240px]">
              <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-400">
                {STAGE_LABELS[stage]} <span className="text-ink-600">({byStage[stage].length})</span>
              </p>
              <div className="space-y-2">
                {byStage[stage].map((i) => (
                  <Link key={i.id} to={`/it/portfolio/${i.id}`} className="block">
                    <Card bodyClassName="p-3">
                      <div className="flex items-center justify-between gap-2">
                        <RecordCode code={i.recordCode} />
                        <RagChip rag={i.rag} />
                      </div>
                      <p className="mt-1 text-sm font-medium text-ink-100">{i.title}</p>
                      <p className="mt-1 text-2xs text-ink-500">
                        {THEME_LABELS[i.theme] ?? titleCase(i.theme)} · {money(i.budget, i.currency)}
                      </p>
                    </Card>
                  </Link>
                ))}
                {byStage[stage].length === 0 && <p className="text-2xs italic text-ink-600">Nothing here.</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      <CreateModal
        open={creating}
        title="New initiative"
        onClose={() => {
          setCreating(false);
          resetForm();
        }}
        invalidate={[['it-initiatives'], ['it-initiatives-summary']]}
        onSubmit={() =>
          api.post('/it/initiatives', {
            title,
            theme: itTheme,
            sponsorPartyId,
            ownerPartyId,
            businessCase: businessCase || null,
            expectedBenefit: expectedBenefit || null,
            budget: Number(budget || 0),
            targetQuarter: targetQuarter || null,
          })
        }
      >
        <TextInput label="Title" required value={title} onChange={setTitle} placeholder="Migrate the helpdesk to the new ticketing system" />
        <Row>
          <SelectInput label="Theme" value={itTheme} onChange={(v: (typeof THEMES)[number]) => setItTheme(v)} options={THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] }))} />
          <MoneyInput label="Budget" required value={budget} onChange={setBudget} />
        </Row>
        <Row>
          <PersonPicker label="Sponsor (accountable for funding)" required value={sponsorPartyId} onChange={setSponsorPartyId} people={people} />
          <PersonPicker label="Owner (accountable for delivery)" required value={ownerPartyId} onChange={setOwnerPartyId} people={people} />
        </Row>
        <TextArea label="Business case" value={businessCase} onChange={setBusinessCase} rows={3} />
        <TextArea label="Expected benefit" value={expectedBenefit} onChange={setExpectedBenefit} rows={2} />
        <TextInput label="Target quarter" value={targetQuarter} onChange={setTargetQuarter} placeholder="FY2026-27 Q3" />
        <p className="text-2xs text-ink-500">
          The sponsor is who the Self-Dealing Bar checks: they can never be the one who approves this initiative's own funding.
        </p>
      </CreateModal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Initiative detail
// ---------------------------------------------------------------------------

interface InitiativeDetailView extends InitiativeRow {
  businessCase: string | null;
  expectedBenefit: string | null;
  ragReason: string | null;
  ragSetAt: string | null;
  spendToDate: number;
  availableTransitions: string[];
  updates: Array<{ id: string; body: string; rag: string; authorPartyId: string | null; at: string }>;
}

export function ItInitiativeDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { can } = useSession();
  const [gateResult, setGateResult] = useState<{ reason: string; resolvedApproverRole: string | null; resolutionTier: number; selfDealingBarTripped: boolean } | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateBody, setUpdateBody] = useState('');
  const [updateRag, setUpdateRag] = useState('green');

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['it-initiative', id],
    queryFn: () => api.get<InitiativeDetailView>(`/it/initiatives/${id}`),
    enabled: Boolean(id),
  });

  const transition = useMutation({
    mutationFn: (event: string) => api.post<{ applied: boolean; reason: string | null; approvalStepId: string | null; resolvedApproverRole?: string | null; resolutionTier?: number; selfDealingBarTripped?: boolean }>(`/it/initiatives/${id}/transition`, { event }),
    onSuccess: (res) => {
      setError(null);
      if (!res.applied) {
        setGateResult({
          reason: res.reason ?? '',
          resolvedApproverRole: res.resolvedApproverRole ?? null,
          resolutionTier: res.resolutionTier ?? 0,
          selfDealingBarTripped: res.selfDealingBarTripped ?? false,
        });
      }
      qc.invalidateQueries({ queryKey: ['it-initiative', id] });
      qc.invalidateQueries({ queryKey: ['it-initiatives'] });
    },
    onError: (e) => setError(messageOf(e)),
  });

  const postUpdate = useMutation({
    mutationFn: () => api.post(`/it/initiatives/${id}/updates`, { body: updateBody, rag: updateRag }),
    onSuccess: () => {
      setPosting(false);
      setUpdateBody('');
      qc.invalidateQueries({ queryKey: ['it-initiative', id] });
    },
    onError: (e) => setError(messageOf(e)),
  });

  if (loadError) return <ErrorBox error={loadError} />;
  if (isLoading || !data) return <Loading />;

  return (
    <div>
      <PageHeader
        title={data.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <RecordCode code={data.recordCode} />
            <StatusChip status={data.stage} tone={data.stage === 'benefits_realised' ? 'good' : data.stage === 'cancelled' ? 'bad' : 'neutral'} />
            <RagChip rag={data.rag} />
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-1">
            {data.availableTransitions.map((t) => (
              <button
                key={t}
                className={t === 'APPROVE' ? 'btn-primary' : 'btn-ghost'}
                onClick={() => transition.mutate(t)}
                disabled={transition.isPending}
                title={t === 'APPROVE' ? "Runs the approval gate on the sponsor's Self-Dealing Bar." : undefined}
              >
                → {titleCase(t.toLowerCase())}
              </button>
            ))}
          </div>
        }
      />

      {error && <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Business case">
            <dl>
              <Field label="Business case">{data.businessCase || '—'}</Field>
              <Field label="Expected benefit">{data.expectedBenefit || '—'}</Field>
              <Field label="Target quarter">{data.targetQuarter || '—'}</Field>
              <Field label="Current RAG reason">{data.ragReason || '—'}</Field>
            </dl>
          </Card>

          <Card
            title="Updates"
            actions={can('it_initiatives:edit') || can('it_initiatives:create') ? <NewButton label="Post update" onClick={() => setPosting(true)} /> : undefined}
          >
            {data.updates.length === 0 ? (
              <EmptyState message="No updates posted yet." />
            ) : (
              <ul className="space-y-3">
                {data.updates.map((u) => (
                  <li key={u.id} className="border-b border-ink-800 pb-2 last:border-0">
                    <div className="flex items-center gap-2 text-2xs text-ink-500">
                      <RagChip rag={u.rag} />
                      <span>{dateTime(u.at)}</span>
                    </div>
                    <p className="mt-1 text-sm text-ink-200">{u.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Budget vs spend">
            <Metric label="Budget" value={money(data.budget, data.currency)} noActionReason="Set at proposal." />
            <div className="mt-3">
              <Metric label="Spend to date" value={money(data.spendToDate, data.currency)} sub="Summed from linked vendor bills." noActionReason="Computed, not stored." />
            </div>
            <p className="mt-3 text-2xs text-ink-500">
              Spend to date sums the linked vendor bills only. Licence spend is not yet joined in — see docs/it/portfolio.md.
            </p>
          </Card>
        </div>
      </div>

      <Modal
        open={posting}
        title="Post an update"
        onClose={() => setPosting(false)}
        footer={
          <>
            <button className="btn" onClick={() => setPosting(false)}>Cancel</button>
            <button className="btn-primary" disabled={postUpdate.isPending} onClick={() => postUpdate.mutate()}>
              {postUpdate.isPending ? 'Posting…' : 'Post'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <SelectInput label="RAG" value={updateRag} onChange={setUpdateRag} options={[{ value: 'green', label: 'Green' }, { value: 'amber', label: 'Amber' }, { value: 'red', label: 'Red' }]} />
          <TextArea label="What's happened" required value={updateBody} onChange={setUpdateBody} rows={4} />
        </div>
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
                  <span className="text-band-watch">
                    Tripped — the sponsor may never be the approver. Resolution rerouted to the next tier.
                  </span>
                </Field>
              )}
            </dl>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roadmap
// ---------------------------------------------------------------------------

interface RoadmapItemRow {
  id: string;
  quarter: string;
  theme: string;
  initiativeId: string | null;
  milestone: string;
  dueAt: string | null;
  done: boolean;
}

function nextQuarters(n = 6): string[] {
  const now = new Date();
  const startMonth = Math.floor(now.getUTCMonth() / 3) * 3; // the current calendar quarter's first month
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), startMonth + i * 3, 1));
    out.push(quarterLabel(d));
  }
  return [...new Set(out)];
}

function quarterLabel(d: Date): string {
  const m = d.getUTCMonth(); // 0-indexed
  const fyStartYear = m >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const fy = `FY${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}`;
  const q = Math.floor(((m + 9) % 12) / 3) + 1; // April..June -> 1
  return `${fy} Q${q}`;
}

export function ItRoadmap() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const quarters = useMemo(() => nextQuarters(6), []);

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['it-roadmap'],
    queryFn: () => api.get<RoadmapItemRow[]>('/it/roadmap'),
  });

  const { data: initiatives = [] } = useQuery({
    queryKey: ['it-initiatives', 'all'],
    queryFn: () => api.get<InitiativeRow[]>('/it/initiatives'),
    enabled: creating,
  });

  const [quarter, setQuarter] = useState(quarters[0] ?? '');
  const [theme, setTheme] = useState<(typeof THEMES)[number]>('run');
  const [initiativeId, setInitiativeId] = useState('');
  const [milestone, setMilestone] = useState('');
  const [dueAt, setDueAt] = useState('');

  const byCell = useMemo(() => {
    const map = new Map<string, RoadmapItemRow[]>();
    for (const item of data) {
      const key = `${item.quarter}|${item.theme}`;
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    return map;
  }, [data]);

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Roadmap"
        subtitle="Milestones on the quarter x theme grid."
        actions={can('it_initiatives:create') ? <NewButton label="Add item" onClick={() => setCreating(true)} /> : undefined}
      />

      {isLoading ? (
        <Loading />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-separate border-spacing-2">
            <thead>
              <tr>
                <th className="text-left text-2xs uppercase text-ink-500">Theme</th>
                {quarters.map((q) => (
                  <th key={q} className="text-left text-2xs uppercase text-ink-500">{q}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {THEMES.map((t) => (
                <tr key={t}>
                  <td className="align-top text-xs font-medium text-ink-300">{THEME_LABELS[t]}</td>
                  {quarters.map((q) => {
                    const items = byCell.get(`${q}|${t}`) ?? [];
                    return (
                      <td key={q} className="align-top">
                        <div className="min-h-[48px] space-y-1">
                          {items.map((item) => (
                            <div key={item.id} className={`rounded border border-ink-800 bg-ink-900 p-1.5 text-2xs ${item.done ? 'opacity-50 line-through' : ''}`}>
                              {item.milestone}
                            </div>
                          ))}
                          {items.length === 0 && <span className="text-2xs text-ink-700">—</span>}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.length === 0 && !isLoading && <Card className="mt-4"><EmptyState message="No roadmap items yet." /></Card>}

      <CreateModal
        open={creating}
        title="Add a roadmap item"
        onClose={() => setCreating(false)}
        invalidate={[['it-roadmap']]}
        onSubmit={() =>
          api.post('/it/roadmap/items', {
            quarter,
            theme,
            initiativeId: initiativeId || null,
            milestone,
            dueAt: dueAt || null,
          })
        }
      >
        <Row>
          <SelectInput label="Quarter" value={quarter} onChange={setQuarter} options={quarters.map((q) => ({ value: q, label: q }))} />
          <SelectInput label="Theme" value={theme} onChange={(v: (typeof THEMES)[number]) => setTheme(v)} options={THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] }))} />
        </Row>
        <SelectInput
          label="Initiative (optional)"
          value={initiativeId}
          onChange={setInitiativeId}
          placeholder="Not tied to a funded initiative"
          options={initiatives.map((i) => ({ value: i.id, label: `${i.recordCode} — ${i.title}` }))}
        />
        <TextInput label="Milestone" required value={milestone} onChange={setMilestone} placeholder="Cut over to the new system" />
        <TextInput label="Due" type="date" value={dueAt} onChange={setDueAt} />
      </CreateModal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

const CATEGORIES = ['licences', 'hardware', 'vendors', 'cloud', 'people', 'other'] as const;
const KINDS = ['run', 'grow'] as const;
const DIVISIONS = ['software', 'skill', 'education', 'shared'] as const;

interface BudgetLine {
  id: string;
  category: string;
  division: string | null;
  kind: string;
  planned: number;
  actual: number;
  variance: number;
  status: string;
}

interface BudgetForFyView {
  fy: string;
  lines: BudgetLine[];
  plannedTotal: number;
  actualTotal: number;
}

interface BudgetSummaryView {
  notYetMeasured: boolean;
  fy: string | null;
  plannedTotal: number;
  actualTotal: number;
  byDivision: Array<{ division: string; planned: number; actual: number; variance: number; run: number; grow: number }>;
  runTotal: number;
  growTotal: number;
}

function currentFy(): string {
  const now = new Date();
  const m = now.getUTCMonth();
  const startYear = m >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `FY${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function fyOptions(): string[] {
  const now = currentFy();
  const start = Number(now.slice(2, 6));
  const out: string[] = [];
  for (let y = start - 1; y <= start + 1; y++) out.push(`FY${y}-${String((y + 1) % 100).padStart(2, '0')}`);
  return out;
}

export function ItBudget() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [fy, setFy] = useState(currentFy());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['it-budget', fy],
    queryFn: () => api.get<BudgetForFyView>(`/it/budget?fy=${encodeURIComponent(fy)}`),
  });

  const { data: summary } = useQuery({
    queryKey: ['it-budget-summary', fy],
    queryFn: () => api.get<BudgetSummaryView>(`/it/budget/summary?fy=${encodeURIComponent(fy)}`),
  });

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/it/budget/lines/${id}/approve`),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['it-budget', fy] });
    },
    onError: (e) => setError(messageOf(e)),
  });

  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('licences');
  const [division, setDivision] = useState<(typeof DIVISIONS)[number]>('shared');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('run');
  const [planned, setPlanned] = useState('');

  if (loadError) return <ErrorBox error={loadError} />;

  return (
    <div>
      <PageHeader
        title="Budget"
        subtitle="Planned vs actual, by category and division. Actuals are summed from the books every time you look — nothing here is stored."
        actions={can('it_budgets:create') ? <NewButton label="New line" onClick={() => setCreating(true)} /> : undefined}
      />

      <div className="mb-4 flex items-center gap-2">
        <SelectInput label="Financial year" value={fy} onChange={setFy} options={fyOptions().map((f) => ({ value: f, label: f }))} />
      </div>

      {error && <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Planned" value={money(summary.plannedTotal)} noActionReason="Set on each budget line." />
          <Metric label="Actual" value={money(summary.actualTotal)} noActionReason="Summed from the books." />
          <Metric label="Run" value={money(summary.runTotal)} noActionReason="Kind = run." />
          <Metric label="Grow" value={money(summary.growTotal)} noActionReason="Kind = grow." />
        </div>
      )}

      {summary && !summary.notYetMeasured && summary.byDivision.length > 0 && (
        <Card title="Run vs grow, by division" className="mb-4">
          <div className="space-y-3">
            {summary.byDivision.map((d) => (
              <div key={d.division}>
                <div className="mb-1 flex items-center justify-between text-2xs">
                  <span className="font-medium text-ink-200">{DIVISION_LABELS[d.division as Division] ?? titleCase(d.division)}</span>
                  <span className="text-ink-500">{money(d.run)} run · {money(d.grow)} grow</span>
                </div>
                <ContributionBar value={d.run} max={d.run + d.grow || 1} tone="accent" />
              </div>
            ))}
          </div>
        </Card>
      )}

      {isLoading ? (
        <Loading />
      ) : !data || data.lines.length === 0 ? (
        <Card><EmptyState message="Nothing to measure yet" hint={`No budget lines for ${fy}.`} /></Card>
      ) : (
        <Card bodyClassName="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-800 text-2xs uppercase text-ink-500">
                <th className="px-3 py-2 text-left">Category</th>
                <th className="px-3 py-2 text-left">Division</th>
                <th className="px-3 py-2 text-left">Kind</th>
                <th className="px-3 py-2 text-right">Planned</th>
                <th className="px-3 py-2 text-right">Actual</th>
                <th className="px-3 py-2 text-right">Variance</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id} className="border-b border-ink-900 last:border-0">
                  <td className="px-3 py-2">{titleCase(l.category)}</td>
                  <td className="px-3 py-2">{l.division ? DIVISION_LABELS[l.division as Division] ?? titleCase(l.division) : '—'}</td>
                  <td className="px-3 py-2">{titleCase(l.kind)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(l.planned)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(l.actual)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${l.variance < 0 ? 'text-band-critical' : 'text-ink-300'}`}>{money(l.variance)}</td>
                  <td className="px-3 py-2"><StatusChip status={l.status} tone={l.status === 'approved' ? 'good' : 'neutral'} /></td>
                  <td className="px-3 py-2 text-right">
                    {l.status === 'draft' && can('it_budgets:approve') && (
                      <button className="btn-ghost" disabled={approve.isPending} onClick={() => approve.mutate(l.id)}>
                        Approve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <CreateModal
        open={creating}
        title={`Budget for ${fy}`}
        submitLabel="Set it"
        onClose={() => setCreating(false)}
        invalidate={[['it-budget'], ['it-budget-summary']]}
        onSubmit={() =>
          api.post('/it/budget/lines', {
            fy,
            category,
            division,
            kind,
            planned: Number(planned || 0),
          })
        }
      >
        <Row>
          <SelectInput label="Category" value={category} onChange={(v: (typeof CATEGORIES)[number]) => setCategory(v)} options={CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} />
          <SelectInput label="Kind" value={kind} onChange={(v: (typeof KINDS)[number]) => setKind(v)} options={KINDS.map((k) => ({ value: k, label: titleCase(k) }))} />
        </Row>
        <Row>
          <SelectInput label="Division" value={division} onChange={(v: (typeof DIVISIONS)[number]) => setDivision(v)} options={DIVISIONS.map((d) => ({ value: d, label: DIVISION_LABELS[d] }))} />
          <MoneyInput label="Planned" required value={planned} onChange={setPlanned} />
        </Row>
        <p className="text-2xs text-ink-500">
          Whoever proposes this line cannot be the one who approves it — the proposer never approves.
        </p>
      </CreateModal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Technical debt
// ---------------------------------------------------------------------------

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

interface TechDebtRow {
  id: string;
  recordCode: string;
  title: string;
  severity: string;
  status: string;
  effortDays: number | null;
  interest: string | null;
  applicationId: string | null;
  initiativeId: string | null;
  availableTransitions?: string[];
}

interface TechDebtSummaryView {
  notYetMeasured: boolean;
  bySeverity: Record<string, number>;
  openCount: number;
}

export function ItTechDebt() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [status, setStatus] = useState('all');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data = [], isLoading, error: loadError } = useQuery({
    queryKey: ['it-tech-debt', status],
    queryFn: () => api.get<TechDebtRow[]>(`/it/tech-debt${status === 'all' ? '' : `?status=${status}`}`),
  });

  const { data: summary } = useQuery({
    queryKey: ['it-tech-debt-summary'],
    queryFn: () => api.get<TechDebtSummaryView>('/it/tech-debt/summary'),
  });

  const transition = useMutation({
    mutationFn: ({ id, event }: { id: string; event: string }) => api.post(`/it/tech-debt/${id}/transition`, { event }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['it-tech-debt'] });
      qc.invalidateQueries({ queryKey: ['it-tech-debt-summary'] });
    },
    onError: (e) => setError(messageOf(e)),
  });

  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>('medium');
  const [effortDays, setEffortDays] = useState('');
  const [interest, setInterest] = useState('');

  if (loadError) return <ErrorBox error={loadError} />;

  const TRANSITIONS: Record<string, string> = { PLAN: 'Plan', START: 'Start', RETIRE: 'Retire', ACCEPT: 'Accept', REOPEN: 'Reopen' };

  return (
    <div>
      <PageHeader
        title="Technical debt"
        subtitle="What it would cost to fix, and what it costs to leave."
        actions={can('it_tech_debt:create') ? <NewButton label="New item" onClick={() => setCreating(true)} /> : undefined}
      />

      {summary && !summary.notYetMeasured && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Metric label="Open" value={summary.openCount} drillTo="/it/tech-debt" />
          {SEVERITIES.map((s) => (
            <Metric key={s} label={titleCase(s)} value={summary.bySeverity[s] ?? 0} tone={s === 'critical' && (summary.bySeverity[s] ?? 0) > 0 ? 'bad' : 'neutral'} drillTo="/it/tech-debt" />
          ))}
        </div>
      )}
      {summary?.notYetMeasured && <Card className="mb-4"><EmptyState message="Nothing to measure yet" hint="No technical-debt items recorded." /></Card>}

      {error && <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      <Tabs
        tabs={[
          { key: 'all', label: 'All' },
          { key: 'open', label: 'Open' },
          { key: 'planned', label: 'Planned' },
          { key: 'in_progress', label: 'In progress' },
          { key: 'accepted', label: 'Accepted' },
          { key: 'retired', label: 'Retired' },
        ]}
        active={status}
        onChange={setStatus}
      />

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card><EmptyState message="No technical-debt items." /></Card>
      ) : (
        <div className="space-y-2">
          {data.map((item) => (
            <Card key={item.id} bodyClassName="p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <RecordCode code={item.recordCode} />
                    <StatusChip status={item.severity} tone={item.severity === 'critical' || item.severity === 'high' ? 'bad' : item.severity === 'medium' ? 'warn' : 'neutral'} />
                    <StatusChip status={item.status} tone={item.status === 'retired' ? 'good' : 'neutral'} />
                  </div>
                  <p className="mt-1 text-sm font-medium text-ink-100">{item.title}</p>
                  {item.interest && <p className="mt-1 text-2xs text-ink-500">Cost of leaving: {item.interest}</p>}
                  {item.effortDays != null && <p className="text-2xs text-ink-600">{item.effortDays} days effort</p>}
                </div>
                <div className="flex shrink-0 flex-wrap gap-1">
                  {(['PLAN', 'START', 'RETIRE', 'ACCEPT', 'REOPEN'] as const)
                    .filter((e) => legalFrom(item.status, e))
                    .map((e) => (
                      <button key={e} className="btn-ghost" disabled={transition.isPending} onClick={() => transition.mutate({ id: item.id, event: e })}>
                        → {TRANSITIONS[e]}
                      </button>
                    ))}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <CreateModal
        open={creating}
        title="New technical-debt item"
        onClose={() => setCreating(false)}
        invalidate={[['it-tech-debt'], ['it-tech-debt-summary']]}
        onSubmit={() =>
          api.post('/it/tech-debt', {
            title,
            severity,
            effortDays: effortDays ? Number(effortDays) : null,
            interest: interest || null,
          })
        }
      >
        <TextInput label="Title" required value={title} onChange={setTitle} placeholder="The old helpdesk still runs on end-of-life PHP" />
        <Row>
          <SelectInput label="Severity" value={severity} onChange={(v: (typeof SEVERITIES)[number]) => setSeverity(v)} options={SEVERITIES.map((s) => ({ value: s, label: titleCase(s) }))} />
          <TextInput label="Effort (days)" type="number" value={effortDays} onChange={setEffortDays} />
        </Row>
        <TextArea label="What it costs to leave" value={interest} onChange={setInterest} rows={3} placeholder="Security patches have stopped; every incident on it costs a day." />
      </CreateModal>
    </div>
  );
}

/** A client-side mirror of the tech-debt machine, just for which buttons to
 * show — the server is the authority and refuses anything illegal. */
function legalFrom(status: string, event: string): boolean {
  const table: Record<string, string[]> = {
    open: ['PLAN', 'RETIRE', 'ACCEPT'],
    planned: ['START', 'RETIRE', 'ACCEPT'],
    in_progress: ['RETIRE', 'ACCEPT'],
    accepted: ['RETIRE', 'REOPEN'],
    retired: [],
  };
  return table[status]?.includes(event) ?? false;
}
