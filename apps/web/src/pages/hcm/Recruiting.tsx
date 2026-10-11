/**
 * Recruiting — HCM (docs/hcm/recruiting.md).
 *
 * A full ATS on top of the existing Requisitions/Applications machines that
 * PeopleOps → Hiring already exposes: this screen never re-implements a
 * requisition or an application transition, it reads them for pickers and
 * the pipeline board and adds everything on top — postings, candidates,
 * interviews, offers, referrals, background verification and onboarding.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { date, dateTime, money } from '../../lib/api.js';
import {
  decimalAmount,
  hcmApi,
  type BgvRow,
  type CandidateRow,
  type InterviewRound,
  type JobPosting,
  type OfferRow,
  type OnboardingTask,
  type OnboardingTemplate,
  type RecruitingFunnel,
  type ReferralRow,
} from '../../lib/hcmApi.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Loading,
  Metric,
  PageHeader,
  StatusChip,
  Tabs,
  Withheld,
} from '../../components/ui.js';
import { CreateModal, messageOf, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

type Tab = 'pipeline' | 'postings' | 'candidates' | 'interviews' | 'offers' | 'referrals' | 'bgv' | 'onboarding';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'postings', label: 'Postings' },
  { key: 'candidates', label: 'Candidates' },
  { key: 'interviews', label: 'Interviews' },
  { key: 'offers', label: 'Offers' },
  { key: 'referrals', label: 'Referrals' },
  { key: 'bgv', label: 'BGV' },
  { key: 'onboarding', label: 'Onboarding' },
];

export function Recruiting() {
  const [tab, setTab] = useState<Tab>('pipeline');

  return (
    <>
      <PageHeader
        title="Recruiting"
        subtitle="Job postings, candidates, interviews, offers, referrals and background verification, on top of the Requisitions and Applications tracked in People → Hiring. Onboarding checklists are instantiated once a candidate joins."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'pipeline' && <PipelineTab />}
      {tab === 'postings' && <PostingsTab />}
      {tab === 'candidates' && <CandidatesTab />}
      {tab === 'interviews' && <InterviewsTab />}
      {tab === 'offers' && <OffersTab />}
      {tab === 'referrals' && <ReferralsTab />}
      {tab === 'bgv' && <BgvTab />}
      {tab === 'onboarding' && <OnboardingTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared reads: requisitions and applications, owned by hiring.ts and read
// here only for pickers and the pipeline board.
// ---------------------------------------------------------------------------

function useRequisitions() {
  return useQuery({ queryKey: ['hr-requisitions'], queryFn: () => hcmApi.hr.requisitions() });
}
function useApplications() {
  return useQuery({ queryKey: ['hr-applications'], queryFn: () => hcmApi.hr.applications() });
}

// ---------------------------------------------------------------------------
// Pipeline — a read-only kanban of applications by funnel bucket.
// ---------------------------------------------------------------------------

const FUNNEL_COLUMNS: Array<{ key: string; label: string; tone: 'neutral' | 'accent' | 'good' | 'bad' }> = [
  { key: 'open', label: 'Open', tone: 'neutral' },
  { key: 'offer', label: 'Offer', tone: 'accent' },
  { key: 'hired', label: 'Hired', tone: 'good' },
  { key: 'closed', label: 'Closed', tone: 'bad' },
];

function PipelineTab() {
  const applications = useApplications();
  const funnel = useQuery({
    queryKey: ['recruiting-funnel'],
    queryFn: () => hcmApi.recruiting.funnel(),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label="Mean time to hire"
          value={funnel.data?.meanTimeToHireDays != null ? `${funnel.data.meanTimeToHireDays}d` : 'Not measured'}
          drillTo="/people/recruiting"
        />
        <Metric
          label="Offer acceptance"
          value={
            funnel.data?.offerAcceptanceRatePct != null ? `${funnel.data.offerAcceptanceRatePct}%` : 'Not measured'
          }
          {...(funnel.data?.offerAcceptanceRatePct == null
            ? { noActionReason: 'No offer has been decided yet.' }
            : { drillTo: '/people/recruiting' })}
        />
        <Metric
          label="Open applications"
          value={applications.data?.filter((a) => a.funnelBucket === 'open').length ?? '—'}
          drillTo="/people/recruiting"
        />
        <Metric
          label="In offer stage"
          value={applications.data?.filter((a) => a.funnelBucket === 'offer').length ?? '—'}
          drillTo="/people/recruiting"
        />
      </div>

      {applications.isLoading && <Loading />}
      {applications.error && <ErrorBox error={applications.error} />}
      {applications.data && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FUNNEL_COLUMNS.map((col) => {
            const rows = applications.data!.filter((a) => a.funnelBucket === col.key);
            return (
              <Card
                key={col.key}
                title={col.label}
                subtitle={`${rows.length} application${rows.length === 1 ? '' : 's'}`}
                bodyClassName="flex flex-col gap-2 p-3"
              >
                {rows.length === 0 && <p className="px-1 py-4 text-center text-2xs text-ink-500">None right now.</p>}
                {rows.map((a) => (
                  <div key={a.id} className="rounded border border-ink-800 bg-ink-900 p-2">
                    <p className="text-xs font-medium text-ink-100">{a.candidate.fullName}</p>
                    <p className="text-2xs text-ink-500">{a.requisition.position.job.title}</p>
                    <div className="mt-1">
                      <StatusChip
                        status={a.status}
                        tone={col.tone === 'bad' ? 'bad' : col.tone === 'good' ? 'good' : 'neutral'}
                      />
                    </div>
                  </div>
                ))}
              </Card>
            );
          })}
        </div>
      )}

      {funnel.data && funnel.data.sourceEffectiveness.length > 0 && (
        <Card title="Source effectiveness" subtitle="Which candidate sources actually convert to a join.">
          <DataTable
            caption="Applications and hires by candidate source"
            columns={SOURCE_COLUMNS}
            rows={funnel.data.sourceEffectiveness}
            rowKey={(s) => s.source}
            emptyMessage="No candidate sources recorded yet."
          />
        </Card>
      )}
    </div>
  );
}

type SourceRow = RecruitingFunnel['sourceEffectiveness'][number];

const SOURCE_COLUMNS: ReadonlyArray<DataTableColumn<SourceRow>> = [
  {
    id: 'source',
    header: 'Source',
    sortValue: (s) => s.source,
    cell: (s) => <span className="capitalize">{s.source.replace(/_/g, ' ')}</span>,
  },
  {
    id: 'applications',
    header: 'Applications',
    align: 'right',
    sortValue: (s) => s.applications,
    cell: (s) => s.applications,
  },
  { id: 'hired', header: 'Hired', align: 'right', sortValue: (s) => s.hired, cell: (s) => s.hired },
  {
    id: 'hireRate',
    header: 'Hire rate',
    align: 'right',
    sortValue: (s) => s.hireRate,
    cell: (s) => (s.hireRate != null ? `${s.hireRate}%` : 'Not measured'),
  },
];

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

function PostingsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const requisitions = useRequisitions();
  const postings = useQuery({
    queryKey: ['recruiting-postings'],
    queryFn: () => hcmApi.recruiting.postings.list(),
  });
  const [form, setForm] = useState({
    requisitionId: '',
    title: '',
    description: '',
    channel: 'internal' as 'internal' | 'external' | 'referral',
  });

  const transitionMut = useMutation({
    mutationFn: ({ id, event }: { id: string; event: string }) => hcmApi.recruiting.postings.transition(id, event),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recruiting-postings'] }),
  });

  const openRequisitions = requisitions.data ?? [];

  const columns: ReadonlyArray<DataTableColumn<JobPosting>> = [
    {
      id: 'code',
      header: 'Code',
      sortValue: (p) => p.recordCode,
      cell: (p) => <span className="mono">{p.recordCode}</span>,
    },
    { id: 'title', header: 'Title', sortValue: (p) => p.title, cell: (p) => p.title },
    { id: 'channel', header: 'Channel', sortValue: (p) => p.channel, cell: (p) => <StatusChip status={p.channel} /> },
    {
      id: 'status',
      header: 'Status',
      sortValue: (p) => p.status,
      cell: (p) => (
        <StatusChip
          status={p.status}
          tone={p.status === 'Published' ? 'good' : p.status === 'Cancelled' ? 'bad' : 'neutral'}
        />
      ),
    },
    {
      id: 'published',
      header: 'Published',
      sortValue: (p) => p.publishedAt,
      cell: (p) => (p.publishedAt ? date(p.publishedAt) : '—'),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (p) => (
        <div className="flex justify-end gap-1">
          {p.availableTransitions.map((event) => (
            <button
              key={event}
              className="btn text-2xs"
              disabled={transitionMut.isPending}
              onClick={() => transitionMut.mutate({ id: p.id, event })}
            >
              {event.toLowerCase()}
            </button>
          ))}
        </div>
      ),
    },
  ];

  return (
    <Card
      title="Job postings"
      subtitle="A published listing against an open requisition. A requisition can be reposted more than once."
      actions={<NewButton label="New posting" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Job postings"
        columns={columns}
        rows={postings.data ?? []}
        rowKey={(p) => p.id}
        loading={postings.isLoading}
        error={postings.error}
        emptyMessage="No job postings yet."
        emptyHint="A posting is drafted against an open requisition, then published."
      />

      <CreateModal
        open={open}
        title="Draft a job posting"
        onClose={() => setOpen(false)}
        invalidate={[['recruiting-postings']]}
        onSubmit={() => hcmApi.recruiting.postings.create(form)}
      >
        <SelectInput
          label="Requisition"
          value={form.requisitionId}
          onChange={(v) => setForm({ ...form, requisitionId: v })}
          placeholder={openRequisitions.length === 0 ? 'No open requisitions' : 'Choose a requisition'}
          options={openRequisitions.map((r) => ({
            value: r.id,
            label: `${r.recordCode} — ${r.position.job.title} (${r.status})`,
          }))}
          required
        />
        <TextInput label="Title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} required />
        <TextArea
          label="Description"
          value={form.description}
          onChange={(v) => setForm({ ...form, description: v })}
          required
        />
        <SelectInput
          label="Channel"
          value={form.channel}
          onChange={(v) => setForm({ ...form, channel: v })}
          options={[
            { value: 'internal', label: 'Internal' },
            { value: 'external', label: 'External' },
            { value: 'referral', label: 'Referral' },
          ]}
        />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function CandidatesTab() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const candidates = useQuery({
    queryKey: ['recruiting-candidates', q],
    queryFn: () => hcmApi.recruiting.candidates.list(q),
  });

  const columns: ReadonlyArray<DataTableColumn<CandidateRow>> = [
    {
      id: 'name',
      header: 'Name',
      sortValue: (c) => c.person?.fullName,
      cell: (c) => c.person?.fullName ?? '—',
    },
    {
      id: 'contact',
      header: 'Contact',
      cell: (c) => (
        <span className="text-2xs text-ink-400">{c.person?.primaryEmail ?? c.person?.primaryPhone ?? '—'}</span>
      ),
    },
    { id: 'source', header: 'Source', sortValue: (c) => c.source, cell: (c) => <StatusChip status={c.source} /> },
    {
      id: 'currentCtc',
      header: 'Current CTC',
      align: 'right',
      sortValue: (c) => decimalAmount(c.currentCtc),
      cell: (c) => (c.currentCtc != null ? money(decimalAmount(c.currentCtc)) : <Withheld reason="no_permission" />),
    },
    {
      id: 'expectedCtc',
      header: 'Expected CTC',
      align: 'right',
      sortValue: (c) => decimalAmount(c.expectedCtc),
      cell: (c) => (c.expectedCtc != null ? money(decimalAmount(c.expectedCtc)) : <Withheld reason="no_permission" />),
    },
    {
      id: 'notice',
      header: 'Notice',
      align: 'right',
      sortValue: (c) => c.noticeDays,
      cell: (c) => c.noticeDays ?? '—',
    },
  ];

  const [form, setForm] = useState({
    fullName: '',
    primaryPhone: '',
    primaryEmail: '',
    source: 'direct',
    resumeText: '',
    currentCtc: '',
    expectedCtc: '',
    noticeDays: '',
  });

  return (
    <Card
      title="Candidates"
      subtitle="Every candidate is a Person — the same record that becomes their employee record on hire. Money is withheld unless the candidates:financial grant is held."
      actions={<NewButton label="Add candidate" onClick={() => setOpen(true)} />}
    >
      <div className="mb-3">
        <TextInput label="Search by name" value={q} onChange={setQ} placeholder="Search" />
      </div>
      <DataTable
        caption="Candidates"
        columns={columns}
        rows={candidates.data ?? []}
        rowKey={(c) => c.id}
        loading={candidates.isLoading}
        error={candidates.error}
        emptyMessage="No candidates recorded yet."
      />

      <CreateModal
        open={open}
        title="Add a candidate"
        onClose={() => setOpen(false)}
        invalidate={[['recruiting-candidates', q]]}
        onSubmit={() =>
          hcmApi.recruiting.candidates.create({
            fullName: form.fullName,
            primaryPhone: form.primaryPhone || undefined,
            primaryEmail: form.primaryEmail || undefined,
            source: form.source,
            resumeText: form.resumeText || undefined,
            currentCtc: form.currentCtc ? Number(form.currentCtc) : undefined,
            expectedCtc: form.expectedCtc ? Number(form.expectedCtc) : undefined,
            noticeDays: form.noticeDays ? Number(form.noticeDays) : undefined,
          })
        }
      >
        <TextInput
          label="Full name"
          value={form.fullName}
          onChange={(v) => setForm({ ...form, fullName: v })}
          required
        />
        <Row>
          <TextInput label="Phone" value={form.primaryPhone} onChange={(v) => setForm({ ...form, primaryPhone: v })} />
          <TextInput
            label="Email"
            type="email"
            value={form.primaryEmail}
            onChange={(v) => setForm({ ...form, primaryEmail: v })}
          />
        </Row>
        <SelectInput
          label="Source"
          value={form.source}
          onChange={(v) => setForm({ ...form, source: v })}
          options={[
            { value: 'direct', label: 'Direct' },
            { value: 'referral', label: 'Referral' },
            { value: 'agency', label: 'Agency' },
            { value: 'job_board', label: 'Job board' },
            { value: 'campus', label: 'Campus' },
          ]}
        />
        <Row>
          <TextInput
            label="Current CTC"
            type="number"
            value={form.currentCtc}
            onChange={(v) => setForm({ ...form, currentCtc: v })}
            hint="Annual, ₹"
          />
          <TextInput
            label="Expected CTC"
            type="number"
            value={form.expectedCtc}
            onChange={(v) => setForm({ ...form, expectedCtc: v })}
            hint="Annual, ₹"
          />
        </Row>
        <TextInput
          label="Notice period (days)"
          type="number"
          value={form.noticeDays}
          onChange={(v) => setForm({ ...form, noticeDays: v })}
        />
        <TextArea label="Resume notes" value={form.resumeText} onChange={(v) => setForm({ ...form, resumeText: v })} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

function InterviewsTab() {
  const applications = useApplications();
  const [applicationId, setApplicationId] = useState('');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [scoreFor, setScoreFor] = useState<InterviewRound | null>(null);
  const [form, setForm] = useState({
    roundNo: '1',
    kind: 'phone' as 'phone' | 'technical' | 'hr' | 'panel',
    scheduledAt: '',
    interviewerPartyIds: '',
    mode: 'video' as 'video' | 'onsite' | 'phone',
  });
  const [scoreForm, setScoreForm] = useState({
    recommendation: 'hire' as 'strong_hire' | 'hire' | 'no_hire' | 'strong_no_hire',
    notes: '',
    score: '3',
  });

  const schedulable = (applications.data ?? []).filter((a) => a.status === 'Screening' || a.status === 'Interviewing');

  const rounds = useQuery({
    queryKey: ['recruiting-interviews', applicationId],
    queryFn: () => hcmApi.recruiting.interviews.rounds(applicationId),
    enabled: !!applicationId,
  });

  const scorecards = useQuery({
    queryKey: ['recruiting-scorecards', scoreFor?.id],
    queryFn: () => hcmApi.recruiting.interviews.scorecards(scoreFor!.id),
    enabled: !!scoreFor,
  });

  const complete = useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: 'advance' | 'reject' | 'hold' }) =>
      hcmApi.recruiting.interviews.complete(id, outcome),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recruiting-interviews', applicationId] }),
  });

  const roundColumns: ReadonlyArray<DataTableColumn<InterviewRound>> = [
    { id: 'round', header: 'Round', sortValue: (r) => r.roundNo, cell: (r) => r.roundNo },
    { id: 'kind', header: 'Kind', sortValue: (r) => r.kind, cell: (r) => <StatusChip status={r.kind} /> },
    { id: 'when', header: 'When', sortValue: (r) => r.scheduledAt, cell: (r) => dateTime(r.scheduledAt) },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => (
        <StatusChip
          status={r.status}
          tone={
            r.status === 'Completed' ? 'good' : r.status === 'Cancelled' || r.status === 'NoShow' ? 'bad' : 'neutral'
          }
        />
      ),
    },
    {
      id: 'outcome',
      header: 'Outcome',
      sortValue: (r) => r.outcome,
      cell: (r) =>
        r.outcome ? (
          <StatusChip
            status={r.outcome}
            tone={r.outcome === 'advance' ? 'good' : r.outcome === 'reject' ? 'bad' : 'warn'}
          />
        ) : (
          '—'
        ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <button className="btn text-2xs" onClick={() => setScoreFor(r)}>
            Scorecards
          </button>
          {r.status === 'Scheduled' && (
            <>
              <button className="btn text-2xs" onClick={() => complete.mutate({ id: r.id, outcome: 'advance' })}>
                Advance
              </button>
              <button className="btn text-2xs" onClick={() => complete.mutate({ id: r.id, outcome: 'reject' })}>
                Reject
              </button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Choose an application"
        subtitle="Only applications currently in Screening or Interviewing can take a new round."
      >
        <SelectInput
          label="Application"
          value={applicationId}
          onChange={setApplicationId}
          placeholder={schedulable.length === 0 ? 'No schedulable applications' : 'Choose an application'}
          options={schedulable.map((a) => ({
            value: a.id,
            label: `${a.recordCode} — ${a.candidate.fullName} (${a.status})`,
          }))}
        />
      </Card>

      {applicationId && (
        <Card title="Interview rounds" actions={<NewButton label="Schedule round" onClick={() => setOpen(true)} />}>
          <DataTable
            caption="Interview rounds for this application"
            columns={roundColumns}
            rows={rounds.data ?? []}
            rowKey={(r) => r.id}
            loading={rounds.isLoading}
            error={rounds.error}
            emptyMessage="No rounds scheduled for this application yet."
          />

          <CreateModal
            open={open}
            title="Schedule an interview round"
            onClose={() => setOpen(false)}
            invalidate={[['recruiting-interviews', applicationId]]}
            onSubmit={() =>
              hcmApi.recruiting.interviews.schedule({
                applicationId,
                roundNo: Number(form.roundNo),
                kind: form.kind,
                scheduledAt: form.scheduledAt,
                mode: form.mode,
                interviewerPartyIds: form.interviewerPartyIds
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          >
            <Row>
              <TextInput
                label="Round no."
                type="number"
                value={form.roundNo}
                onChange={(v) => setForm({ ...form, roundNo: v })}
                required
              />
              <SelectInput
                label="Kind"
                value={form.kind}
                onChange={(v) => setForm({ ...form, kind: v })}
                options={[
                  { value: 'phone', label: 'Phone' },
                  { value: 'technical', label: 'Technical' },
                  { value: 'hr', label: 'HR' },
                  { value: 'panel', label: 'Panel' },
                ]}
              />
            </Row>
            <TextInput
              label="Scheduled at"
              type="date"
              value={form.scheduledAt}
              onChange={(v) => setForm({ ...form, scheduledAt: v })}
              required
            />
            <SelectInput
              label="Mode"
              value={form.mode}
              onChange={(v) => setForm({ ...form, mode: v })}
              options={[
                { value: 'video', label: 'Video' },
                { value: 'onsite', label: 'Onsite' },
                { value: 'phone', label: 'Phone' },
              ]}
            />
            <TextInput
              label="Interviewer party IDs"
              value={form.interviewerPartyIds}
              onChange={(v) => setForm({ ...form, interviewerPartyIds: v })}
              hint="Comma-separated Person IDs"
            />
          </CreateModal>
        </Card>
      )}

      {scoreFor && (
        <Card
          title={`Scorecards — round ${scoreFor.roundNo}`}
          actions={
            <button className="btn text-2xs" onClick={() => setScoreFor(null)}>
              Close
            </button>
          }
        >
          {scorecards.data && scorecards.data.length === 0 && (
            <EmptyState message="No scorecards submitted for this round yet." />
          )}
          {scorecards.data && scorecards.data.length > 0 && (
            <ul className="flex flex-col gap-2">
              {scorecards.data.map((s) => (
                <li key={s.id} className="rounded border border-ink-800 p-2 text-sm">
                  <StatusChip status={s.recommendation} tone={s.recommendation.includes('no_hire') ? 'bad' : 'good'} />
                  {s.notes && <p className="mt-1 text-2xs text-ink-400">{s.notes}</p>}
                </li>
              ))}
            </ul>
          )}
          <ScoreForm roundId={scoreFor.id} form={scoreForm} setForm={setScoreForm} />
        </Card>
      )}
    </div>
  );
}

function ScoreForm({
  roundId,
  form,
  setForm,
}: {
  roundId: string;
  form: { recommendation: 'strong_hire' | 'hire' | 'no_hire' | 'strong_no_hire'; notes: string; score: string };
  setForm: (f: {
    recommendation: 'strong_hire' | 'hire' | 'no_hire' | 'strong_no_hire';
    notes: string;
    score: string;
  }) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: () =>
      hcmApi.recruiting.interviews.submitScorecard(roundId, {
        competencyScores: { overall: Number(form.score) },
        recommendation: form.recommendation,
        notes: form.notes || undefined,
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['recruiting-scorecards', roundId] });
    },
    onError: (e) => setError(messageOf(e)),
  });

  return (
    <div className="mt-3 border-t border-ink-800 pt-3">
      {error && <p className="mb-2 text-2xs text-band-critical">{error}</p>}
      <Row>
        <SelectInput
          label="Recommendation"
          value={form.recommendation}
          onChange={(v) => setForm({ ...form, recommendation: v })}
          options={[
            { value: 'strong_hire', label: 'Strong hire' },
            { value: 'hire', label: 'Hire' },
            { value: 'no_hire', label: 'No hire' },
            { value: 'strong_no_hire', label: 'Strong no hire' },
          ]}
        />
        <TextInput
          label="Overall score (1–5)"
          type="number"
          value={form.score}
          onChange={(v) => setForm({ ...form, score: v })}
        />
      </Row>
      <TextArea label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
      <button className="btn-primary mt-2" disabled={submit.isPending} onClick={() => submit.mutate()}>
        {submit.isPending ? 'Submitting…' : 'Submit scorecard'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

function OffersTab() {
  const qc = useQueryClient();
  const applications = useApplications();
  const [open, setOpen] = useState(false);
  const [joining, setJoining] = useState<OfferRow | null>(null);
  const [joinDate, setJoinDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [form, setForm] = useState({ applicationId: '', ctc: '', joiningDate: '', validUntil: '' });

  const offers = useQuery({
    queryKey: ['recruiting-offers'],
    queryFn: () => hcmApi.recruiting.offers.list(),
  });
  const selectable = (applications.data ?? []).filter((a) => a.status === 'Selected');
  const byId = new Map((applications.data ?? []).map((a) => [a.id, a]));

  const transitionMut = useMutation({
    mutationFn: ({ id, event, declineReason }: { id: string; event: string; declineReason?: string }) =>
      hcmApi.recruiting.offers.transition(id, event, declineReason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recruiting-offers'] });
      qc.invalidateQueries({ queryKey: ['hr-applications'] });
    },
  });

  const joinMut = useMutation({
    mutationFn: () => hcmApi.recruiting.offers.joinAndOnboard(joining!.applicationId, joinDate),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-applications'] });
      qc.invalidateQueries({ queryKey: ['hr-requisitions'] });
      setJoining(null);
    },
  });

  const columns: ReadonlyArray<DataTableColumn<OfferRow>> = [
    {
      id: 'code',
      header: 'Code',
      sortValue: (o) => o.recordCode,
      cell: (o) => <span className="mono">{o.recordCode}</span>,
    },
    {
      id: 'candidate',
      header: 'Candidate',
      sortValue: (o) => byId.get(o.applicationId)?.candidate.fullName,
      cell: (o) => byId.get(o.applicationId)?.candidate.fullName ?? '—',
    },
    {
      id: 'ctc',
      header: 'CTC',
      align: 'right',
      sortValue: (o) => decimalAmount(o.ctc),
      cell: (o) => (o.ctc != null ? money(decimalAmount(o.ctc)) : <Withheld reason="no_permission" />),
    },
    { id: 'joining', header: 'Joining', sortValue: (o) => o.joiningDate, cell: (o) => date(o.joiningDate) },
    {
      id: 'status',
      header: 'Status',
      sortValue: (o) => o.status,
      cell: (o) => (
        <StatusChip
          status={o.status}
          tone={
            o.status === 'Accepted' ? 'good' : o.status === 'Declined' || o.status === 'Rescinded' ? 'bad' : 'neutral'
          }
        />
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (o) => (
        <div className="flex justify-end gap-1">
          {o.availableTransitions.map((event) => (
            <button
              key={event}
              className="btn text-2xs"
              disabled={transitionMut.isPending}
              onClick={() => transitionMut.mutate({ id: o.id, event })}
            >
              {event.toLowerCase()}
            </button>
          ))}
          {o.status === 'Accepted' && (
            <button className="btn-primary text-2xs" onClick={() => setJoining(o)}>
              Join &amp; onboard
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <Card
      title="Offers"
      subtitle="Approval needs someone other than the proposer (Self-Dealing Bar). CTC is withheld unless offers:financial is held."
      actions={<NewButton label="Draft offer" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Offers"
        columns={columns}
        rows={offers.data ?? []}
        rowKey={(o) => o.id}
        loading={offers.isLoading}
        error={offers.error}
        emptyMessage="No offers drafted yet."
        emptyHint="An offer is drafted once a candidate reaches Selected."
      />

      <CreateModal
        open={open}
        title="Draft an offer"
        onClose={() => setOpen(false)}
        invalidate={[['recruiting-offers']]}
        onSubmit={() => hcmApi.recruiting.offers.create({ ...form, ctc: Number(form.ctc) })}
      >
        <SelectInput
          label="Application"
          value={form.applicationId}
          onChange={(v) => setForm({ ...form, applicationId: v })}
          placeholder={selectable.length === 0 ? 'No Selected applications' : 'Choose an application'}
          options={selectable.map((a) => ({ value: a.id, label: `${a.recordCode} — ${a.candidate.fullName}` }))}
          required
        />
        <TextInput
          label="CTC (annual, ₹)"
          type="number"
          value={form.ctc}
          onChange={(v) => setForm({ ...form, ctc: v })}
          required
        />
        <Row>
          <TextInput
            label="Joining date"
            type="date"
            value={form.joiningDate}
            onChange={(v) => setForm({ ...form, joiningDate: v })}
            required
          />
          <TextInput
            label="Valid until"
            type="date"
            value={form.validUntil}
            onChange={(v) => setForm({ ...form, validUntil: v })}
            required
          />
        </Row>
      </CreateModal>

      {joining && (
        <CreateModal
          open={!!joining}
          title={`Join ${byId.get(joining.applicationId)?.candidate.fullName ?? 'candidate'}`}
          submitLabel="Join and onboard"
          onClose={() => setJoining(null)}
          onSubmit={() => joinMut.mutateAsync()}
        >
          <TextInput label="Hire effective date" type="date" value={joinDate} onChange={setJoinDate} required />
        </CreateModal>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

const REFERRAL_NEXT: Record<string, string[]> = {
  Submitted: ['Shortlisted', 'Rejected'],
  Shortlisted: ['Hired', 'Rejected'],
  Hired: ['BonusPaid'],
};

function ReferralsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const referrals = useQuery({
    queryKey: ['recruiting-referrals'],
    queryFn: () => hcmApi.recruiting.referrals.list(),
  });
  const [form, setForm] = useState({
    referrerEmploymentId: '',
    fullName: '',
    primaryPhone: '',
    primaryEmail: '',
    bonusAmount: '',
  });

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => hcmApi.recruiting.referrals.setStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recruiting-referrals'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<ReferralRow>> = [
    {
      id: 'referrer',
      header: 'Referrer employment',
      sortValue: (r) => r.referrerEmploymentId,
      cell: (r) => <span className="mono text-2xs">{r.referrerEmploymentId}</span>,
    },
    {
      id: 'bonus',
      header: 'Bonus',
      align: 'right',
      sortValue: (r) => decimalAmount(r.bonusAmount),
      cell: (r) => (r.bonusAmount != null ? money(decimalAmount(r.bonusAmount)) : <Withheld reason="no_permission" />),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => (
        <StatusChip
          status={r.status}
          tone={r.status === 'BonusPaid' ? 'good' : r.status === 'Rejected' ? 'bad' : 'neutral'}
        />
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) => (
        <div className="flex justify-end gap-1">
          {(REFERRAL_NEXT[r.status] ?? []).map((next) => (
            <button key={next} className="btn text-2xs" onClick={() => statusMut.mutate({ id: r.id, status: next })}>
              {next.toLowerCase()}
            </button>
          ))}
        </div>
      ),
    },
  ];

  return (
    <Card
      title="Referrals"
      subtitle="An employee-sourced candidate. The bonus is tracked here; payroll pays it once BonusPaid. Withheld unless referrals:financial is held."
      actions={<NewButton label="Record referral" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Referrals"
        columns={columns}
        rows={referrals.data ?? []}
        rowKey={(r) => r.id}
        loading={referrals.isLoading}
        error={referrals.error}
        emptyMessage="No referrals recorded yet."
      />

      <CreateModal
        open={open}
        title="Record a referral"
        onClose={() => setOpen(false)}
        invalidate={[['recruiting-referrals']]}
        onSubmit={() =>
          hcmApi.recruiting.referrals.create({
            referrerEmploymentId: form.referrerEmploymentId,
            candidate: {
              fullName: form.fullName,
              primaryPhone: form.primaryPhone || undefined,
              primaryEmail: form.primaryEmail || undefined,
            },
            bonusAmount: form.bonusAmount ? Number(form.bonusAmount) : undefined,
          })
        }
      >
        <TextInput
          label="Referring employment ID"
          value={form.referrerEmploymentId}
          onChange={(v) => setForm({ ...form, referrerEmploymentId: v })}
          required
          hint="From People → Employees"
        />
        <TextInput
          label="Candidate name"
          value={form.fullName}
          onChange={(v) => setForm({ ...form, fullName: v })}
          required
        />
        <Row>
          <TextInput label="Phone" value={form.primaryPhone} onChange={(v) => setForm({ ...form, primaryPhone: v })} />
          <TextInput
            label="Email"
            type="email"
            value={form.primaryEmail}
            onChange={(v) => setForm({ ...form, primaryEmail: v })}
          />
        </Row>
        <TextInput
          label="Bonus amount (₹)"
          type="number"
          value={form.bonusAmount}
          onChange={(v) => setForm({ ...form, bonusAmount: v })}
        />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Background verification
// ---------------------------------------------------------------------------

function BgvTab() {
  const qc = useQueryClient();
  const applications = useApplications();
  const [open, setOpen] = useState(false);
  const bgvs = useQuery({
    queryKey: ['recruiting-bgv'],
    queryFn: () => hcmApi.recruiting.bgv.list(),
  });
  const [form, setForm] = useState({ applicationId: '', vendor: '', checks: 'identity, address' });

  const updateMut = useMutation({
    mutationFn: ({ id, status, outcome }: { id: string; status: string; outcome?: string }) =>
      hcmApi.recruiting.bgv.update(id, { status, outcome }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recruiting-bgv'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<BgvRow>> = [
    { id: 'vendor', header: 'Vendor', sortValue: (b) => b.vendor, cell: (b) => b.vendor },
    {
      id: 'checks',
      header: 'Checks',
      cell: (b) => <span className="text-2xs text-ink-400">{b.checks.join(', ')}</span>,
    },
    { id: 'status', header: 'Status', sortValue: (b) => b.status, cell: (b) => <StatusChip status={b.status} /> },
    {
      id: 'outcome',
      header: 'Outcome',
      sortValue: (b) => b.outcome,
      cell: (b) =>
        b.outcome ? (
          <StatusChip
            status={b.outcome}
            tone={b.outcome === 'clear' ? 'good' : b.outcome === 'adverse' ? 'bad' : 'neutral'}
          />
        ) : (
          '—'
        ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (b) =>
        b.status !== 'Completed' && (
          <div className="flex justify-end gap-1">
            <button
              className="btn text-2xs"
              onClick={() => updateMut.mutate({ id: b.id, status: 'Completed', outcome: 'clear' })}
            >
              Clear
            </button>
            <button
              className="btn text-2xs"
              onClick={() => updateMut.mutate({ id: b.id, status: 'Completed', outcome: 'adverse' })}
            >
              Adverse
            </button>
          </div>
        ),
    },
  ];

  return (
    <Card
      title="Background verification"
      subtitle="Run against an application before joining, or an employment just after."
      actions={<NewButton label="Start a check" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Background verification checks"
        columns={columns}
        rows={bgvs.data ?? []}
        rowKey={(b) => b.id}
        loading={bgvs.isLoading}
        error={bgvs.error}
        emptyMessage="No background checks started yet."
      />

      <CreateModal
        open={open}
        title="Start a background check"
        onClose={() => setOpen(false)}
        invalidate={[['recruiting-bgv']]}
        onSubmit={() =>
          hcmApi.recruiting.bgv.create({
            applicationId: form.applicationId || undefined,
            vendor: form.vendor,
            checks: form.checks
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      >
        <SelectInput
          label="Application"
          value={form.applicationId}
          onChange={(v) => setForm({ ...form, applicationId: v })}
          placeholder="Choose an application"
          options={(applications.data ?? []).map((a) => ({
            value: a.id,
            label: `${a.recordCode} — ${a.candidate.fullName}`,
          }))}
          required
        />
        <TextInput label="Vendor" value={form.vendor} onChange={(v) => setForm({ ...form, vendor: v })} required />
        <TextInput
          label="Checks"
          value={form.checks}
          onChange={(v) => setForm({ ...form, checks: v })}
          hint="Comma-separated"
        />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

const TEMPLATE_COLUMNS: ReadonlyArray<DataTableColumn<OnboardingTemplate>> = [
  { id: 'title', header: 'Title', sortValue: (t) => t.title, cell: (t) => t.title },
  { id: 'category', header: 'Category', sortValue: (t) => t.category, cell: (t) => t.category },
  { id: 'assignee', header: 'Assignee', sortValue: (t) => t.assignee, cell: (t) => <StatusChip status={t.assignee} /> },
  {
    id: 'dueOffset',
    header: 'Due offset',
    align: 'right',
    sortValue: (t) => t.dueOffsetDays,
    cell: (t) => `${t.dueOffsetDays}d`,
  },
];

function OnboardingTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [employmentId, setEmploymentId] = useState('');
  const templates = useQuery({
    queryKey: ['recruiting-onboarding-templates'],
    queryFn: () => hcmApi.recruiting.onboarding.templates(),
  });
  const [form, setForm] = useState({
    title: '',
    category: 'general',
    assignee: 'hr' as 'hr' | 'it' | 'manager' | 'employee',
    dueOffsetDays: '0',
  });

  const tasks = useQuery({
    queryKey: ['recruiting-onboarding-tasks', employmentId],
    queryFn: () => hcmApi.recruiting.onboarding.tasks(employmentId),
    enabled: !!employmentId,
  });

  const complete = useMutation({
    mutationFn: ({ id, skip }: { id: string; skip: boolean }) => hcmApi.recruiting.onboarding.completeTask(id, skip),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recruiting-onboarding-tasks', employmentId] }),
  });

  const taskColumns: ReadonlyArray<DataTableColumn<OnboardingTask>> = [
    { id: 'task', header: 'Task', sortValue: (t) => t.title, cell: (t) => t.title },
    {
      id: 'assignee',
      header: 'Assignee',
      sortValue: (t) => t.assignee,
      cell: (t) => <StatusChip status={t.assignee} />,
    },
    {
      id: 'due',
      header: 'Due',
      sortValue: (t) => t.dueDate,
      cell: (t) => (t.dueDate ? date(t.dueDate) : '—'),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (t) => t.status,
      cell: (t) => (
        <StatusChip
          status={t.status}
          tone={t.status === 'Done' ? 'good' : t.status === 'Skipped' ? 'bad' : 'neutral'}
        />
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (t) =>
        t.status === 'Pending' && (
          <div className="flex justify-end gap-1">
            <button className="btn text-2xs" onClick={() => complete.mutate({ id: t.id, skip: false })}>
              Done
            </button>
            <button className="btn text-2xs" onClick={() => complete.mutate({ id: t.id, skip: true })}>
              Skip
            </button>
          </div>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Task templates"
        subtitle="Instantiated onto every new joiner's checklist when they join through Offers → Join &amp; onboard."
        actions={<NewButton label="Add template" onClick={() => setOpen(true)} />}
      >
        <DataTable
          caption="Onboarding task templates"
          columns={TEMPLATE_COLUMNS}
          rows={templates.data ?? []}
          rowKey={(t) => t.id}
          loading={templates.isLoading}
          error={templates.error}
          emptyMessage="No onboarding task templates yet."
        />

        <CreateModal
          open={open}
          title="Add an onboarding task template"
          onClose={() => setOpen(false)}
          invalidate={[['recruiting-onboarding-templates']]}
          onSubmit={() =>
            hcmApi.recruiting.onboarding.createTemplate({ ...form, dueOffsetDays: Number(form.dueOffsetDays) })
          }
        >
          <TextInput label="Title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} required />
          <Row>
            <TextInput label="Category" value={form.category} onChange={(v) => setForm({ ...form, category: v })} />
            <SelectInput
              label="Assignee"
              value={form.assignee}
              onChange={(v) => setForm({ ...form, assignee: v })}
              options={[
                { value: 'hr', label: 'HR' },
                { value: 'it', label: 'IT' },
                { value: 'manager', label: 'Manager' },
                { value: 'employee', label: 'Employee' },
              ]}
            />
          </Row>
          <TextInput
            label="Due offset (days from joining)"
            type="number"
            value={form.dueOffsetDays}
            onChange={(v) => setForm({ ...form, dueOffsetDays: v })}
          />
        </CreateModal>
      </Card>

      <Card title="A joiner's checklist" subtitle="Look up the instantiated tasks for one employment.">
        <TextInput
          label="Employment ID"
          value={employmentId}
          onChange={setEmploymentId}
          placeholder="From People → Employees, or the offer you just joined"
        />
        {employmentId && (
          <div className="mt-3">
            <DataTable
              caption="Onboarding tasks for this employment"
              columns={taskColumns}
              rows={tasks.data ?? []}
              rowKey={(t) => t.id}
              loading={tasks.isLoading}
              error={tasks.error}
              emptyMessage="No onboarding tasks instantiated for this employment yet."
            />
          </div>
        )}
      </Card>
    </div>
  );
}
