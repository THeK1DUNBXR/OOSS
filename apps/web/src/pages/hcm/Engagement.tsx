/**
 * Engagement — announcements, recognition, pulse surveys, the HR helpdesk and
 * policy documents (docs/hcm/engagement.md).
 *
 * The Helpdesk tab's confidential queue is a separate, deliberately
 * unmerged list — the same discipline Compliance/Labour applies to POSH
 * complaints: reaching it takes the grant, never an inference from the
 * general queue or its counts.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dateTime } from '../../lib/api.js';
import {
  hcmApi,
  type HrCase,
  type PolicyDocument,
  type PulseSurvey,
  type Recognition,
  type RecognitionLeaderboardRow,
} from '../../lib/hcmApi.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

type Tab = 'announcements' | 'recognition' | 'surveys' | 'helpdesk' | 'policies';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'announcements', label: 'Announcements' },
  { key: 'recognition', label: 'Recognition' },
  { key: 'surveys', label: 'Surveys' },
  { key: 'helpdesk', label: 'Helpdesk' },
  { key: 'policies', label: 'Policies' },
];

export function Engagement() {
  const [tab, setTab] = useState<Tab>('announcements');
  return (
    <>
      <PageHeader
        title="Engagement"
        subtitle="Announcements, recognition, pulse surveys, the HR helpdesk and company policies. A confidential grievance case is never mixed into the general helpdesk queue or its counts."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'announcements' && <AnnouncementsTab />}
      {tab === 'recognition' && <RecognitionTab />}
      {tab === 'surveys' && <SurveysTab />}
      {tab === 'helpdesk' && <HelpdeskTab />}
      {tab === 'policies' && <PoliciesTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

function AnnouncementsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', pinned: false, acknowledgementRequired: false });

  const announcements = useQuery({
    queryKey: ['eng-announcements'],
    queryFn: () => hcmApi.engagement.announcements.list(),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => hcmApi.engagement.announcements.withdraw(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eng-announcements'] }),
  });

  return (
    <Card
      title="Announcements"
      subtitle="Company-wide and targeted broadcasts. Pinned ones stay at the top; ones requiring acknowledgement feed every reader's pending-acks list until they ack."
      actions={<NewButton label="New announcement" onClick={() => setOpen(true)} />}
    >
      {announcements.isLoading && <Loading />}
      {announcements.error && <ErrorBox error={announcements.error} />}
      {announcements.data && announcements.data.length === 0 && <EmptyState message="No announcements yet." />}
      {announcements.data && announcements.data.length > 0 && (
        <div className="flex flex-col gap-2">
          {announcements.data.map((a) => (
            <div key={a.id} className="rounded-md border border-ink-800 bg-ink-900 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {a.pinned && <span className="chip border-accent/40 bg-accent/10 text-accent-soft">Pinned</span>}
                  <p className="text-sm font-medium text-ink-100">{a.title}</p>
                  <StatusChip
                    status={a.status}
                    tone={a.status === 'published' ? 'good' : a.status === 'withdrawn' ? 'bad' : 'neutral'}
                  />
                  {a.acknowledgementRequired && (
                    <span className="chip border-band-watch/40 text-band-watch">Ack required</span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-2xs text-ink-500">
                  <span>{dateTime(a.publishAt)}</span>
                  {a.status === 'published' && (
                    <button className="btn text-2xs" onClick={() => withdraw.mutate(a.id)}>
                      Withdraw
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-2 text-xs text-ink-300">{a.body}</p>
            </div>
          ))}
        </div>
      )}

      <CreateModal
        open={open}
        title="New announcement"
        onClose={() => setOpen(false)}
        invalidate={[['eng-announcements']]}
        onSubmit={() =>
          hcmApi.engagement.announcements.create({
            title: form.title,
            body: form.body,
            pinned: form.pinned,
            acknowledgementRequired: form.acknowledgementRequired,
            publishNow: true,
          })
        }
      >
        <TextInput label="Title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} required />
        <TextArea label="Body" value={form.body} onChange={(v) => setForm({ ...form, body: v })} rows={4} required />
        <Row>
          <label className="flex items-center gap-2 text-xs text-ink-300">
            <input
              type="checkbox"
              checked={form.pinned}
              onChange={(e) => setForm({ ...form, pinned: e.target.checked })}
            />
            Pin to top
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-300">
            <input
              type="checkbox"
              checked={form.acknowledgementRequired}
              onChange={(e) => setForm({ ...form, acknowledgementRequired: e.target.checked })}
            />
            Require acknowledgement
          </label>
        </Row>
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

function RecognitionTab() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ toPartyId: '', badge: '', message: '', points: '10' });

  const recognitions = useQuery({
    queryKey: ['eng-recognitions'],
    queryFn: () => hcmApi.engagement.recognitions.list(),
  });
  const leaderboard = useQuery({
    queryKey: ['eng-recognition-leaderboard'],
    queryFn: () => hcmApi.engagement.recognitions.leaderboard(),
    retry: false,
  });

  const LEADERBOARD_COLUMNS: ReadonlyArray<DataTableColumn<RecognitionLeaderboardRow>> = [
    {
      id: 'person',
      header: 'Person',
      sortValue: (row) => row.toPartyId,
      cell: (row) => <span className="mono text-2xs">{row.toPartyId.slice(0, 8)}</span>,
    },
    { id: 'count', header: 'Recognitions', align: 'right', sortValue: (row) => row.count, cell: (row) => row.count },
    {
      id: 'points',
      header: 'Points',
      align: 'right',
      sortValue: (row) => row.totalPoints,
      cell: (row) => row.totalPoints,
    },
  ];

  const RECOGNITION_COLUMNS: ReadonlyArray<DataTableColumn<Recognition>> = [
    { id: 'when', header: 'When', sortValue: (r) => r.createdAt, cell: (r) => dateTime(r.createdAt) },
    {
      id: 'from',
      header: 'From',
      sortValue: (r) => r.fromPartyId,
      cell: (r) => <span className="mono text-2xs">{r.fromPartyId.slice(0, 8)}</span>,
    },
    {
      id: 'to',
      header: 'To',
      sortValue: (r) => r.toPartyId,
      cell: (r) => <span className="mono text-2xs">{r.toPartyId.slice(0, 8)}</span>,
    },
    { id: 'badge', header: 'Badge', sortValue: (r) => r.badge, cell: (r) => r.badge },
    { id: 'message', header: 'Message', cell: (r) => <span className="text-ink-300">{r.message}</span> },
    { id: 'points', header: 'Points', align: 'right', sortValue: (r) => r.points, cell: (r) => r.points },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Recognition"
        subtitle="Kudos given and received. Everyone sees what they gave or received; only HR sees the full ledger."
        actions={<NewButton label="Give recognition" onClick={() => setOpen(true)} />}
      >
        <DataTable
          caption="Recognition ledger"
          columns={RECOGNITION_COLUMNS}
          rows={recognitions.data ?? []}
          rowKey={(r) => r.id}
          loading={recognitions.isLoading}
          error={recognitions.error}
          emptyMessage="No recognition yet."
          emptyHint="Give kudos to a colleague to start the ledger."
        />
      </Card>
      <CreateModal
        open={open}
        title="Give recognition"
        onClose={() => setOpen(false)}
        invalidate={[['eng-recognitions'], ['eng-recognition-leaderboard']]}
        onSubmit={() =>
          hcmApi.engagement.recognitions.give({
            toPartyId: form.toPartyId,
            badge: form.badge,
            message: form.message,
            points: Number(form.points) || 0,
          })
        }
      >
        <TextInput
          label="Recipient party id"
          value={form.toPartyId}
          onChange={(v) => setForm({ ...form, toPartyId: v })}
          required
          hint="The person id — a directory picker lands with WS1."
        />
        <TextInput
          label="Badge"
          value={form.badge}
          onChange={(v) => setForm({ ...form, badge: v })}
          required
          placeholder="Team player"
        />
        <TextArea label="Message" value={form.message} onChange={(v) => setForm({ ...form, message: v })} required />
        <TextInput label="Points" type="number" value={form.points} onChange={(v) => setForm({ ...form, points: v })} />
      </CreateModal>

      {leaderboard.data && leaderboard.data.length > 0 && (
        <Card title="Leaderboard" subtitle="Total recognition points received, HR view.">
          <DataTable
            caption="Recognition leaderboard"
            columns={LEADERBOARD_COLUMNS}
            rows={leaderboard.data ?? []}
            rowKey={(row) => row.toPartyId}
            emptyMessage="No recognition points awarded yet."
          />
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surveys
// ---------------------------------------------------------------------------

function SurveysTab() {
  const [open, setOpen] = useState(false);
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: '',
    questionText: '',
    questionType: 'enps' as 'enps' | 'scale' | 'text',
    anonymous: true,
    days: '14',
  });
  const qc = useQueryClient();

  const surveys = useQuery({
    queryKey: ['eng-surveys'],
    queryFn: () => hcmApi.engagement.surveys.list(),
  });
  const openMutation = useMutation({
    mutationFn: (id: string) => hcmApi.engagement.surveys.open(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eng-surveys'] }),
  });
  const closeMutation = useMutation({
    mutationFn: (id: string) => hcmApi.engagement.surveys.close(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eng-surveys'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<PulseSurvey>> = [
    {
      id: 'title',
      header: 'Title',
      sortValue: (row) => row.title,
      cell: (row) => (
        <>
          {row.title}
          {row.anonymous && <span className="ml-2 chip border-ink-700 text-ink-400">Anonymous</span>}
        </>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (row) => row.status,
      cell: (row) => (
        <StatusChip
          status={row.status}
          tone={row.status === 'open' ? 'good' : row.status === 'closed' ? 'neutral' : 'warn'}
        />
      ),
    },
    { id: 'opens', header: 'Opens', sortValue: (row) => row.opensAt, cell: (row) => dateTime(row.opensAt) },
    { id: 'closes', header: 'Closes', sortValue: (row) => row.closesAt, cell: (row) => dateTime(row.closesAt) },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (row) => (
        <div className="flex justify-end gap-2">
          {row.status === 'draft' && (
            <button className="btn text-2xs" onClick={() => openMutation.mutate(row.id)}>
              Open
            </button>
          )}
          {row.status === 'open' && (
            <button className="btn text-2xs" onClick={() => closeMutation.mutate(row.id)}>
              Close
            </button>
          )}
          <button className="btn text-2xs" onClick={() => setResultsFor(row.id)}>
            Results
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Pulse surveys"
        subtitle="A single-question pulse or eNPS check, or a longer survey — each with its own audience and anonymity."
        actions={<NewButton label="New survey" onClick={() => setOpen(true)} />}
      >
        <DataTable
          caption="Pulse surveys"
          columns={columns}
          rows={surveys.data ?? []}
          rowKey={(row) => row.id}
          loading={surveys.isLoading}
          error={surveys.error}
          emptyMessage="No surveys yet."
        />
      </Card>

      <CreateModal
        open={open}
        title="New survey"
        onClose={() => setOpen(false)}
        invalidate={[['eng-surveys']]}
        onSubmit={() =>
          hcmApi.engagement.surveys.create({
            title: form.title,
            anonymous: form.anonymous,
            questions: [{ id: 'q1', type: form.questionType, text: form.questionText }],
            opensAt: new Date().toISOString(),
            closesAt: new Date(Date.now() + (Number(form.days) || 14) * 86_400_000).toISOString(),
          })
        }
      >
        <TextInput label="Title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} required />
        <SelectInput
          label="Question type"
          value={form.questionType}
          onChange={(v) => setForm({ ...form, questionType: v })}
          options={[
            { value: 'enps', label: 'eNPS (0-10)' },
            { value: 'scale', label: 'Scale (0-10)' },
            { value: 'text', label: 'Free text' },
          ]}
        />
        <TextArea
          label="Question"
          value={form.questionText}
          onChange={(v) => setForm({ ...form, questionText: v })}
          required
        />
        <Row>
          <TextInput
            label="Open for (days)"
            type="number"
            value={form.days}
            onChange={(v) => setForm({ ...form, days: v })}
          />
          <label className="flex items-center gap-2 pt-6 text-xs text-ink-300">
            <input
              type="checkbox"
              checked={form.anonymous}
              onChange={(e) => setForm({ ...form, anonymous: e.target.checked })}
            />
            Anonymous responses
          </label>
        </Row>
      </CreateModal>

      {resultsFor && <SurveyResultsCard id={resultsFor} onClose={() => setResultsFor(null)} />}
    </div>
  );
}

function SurveyResultsCard({ id, onClose }: { id: string; onClose: () => void }) {
  const results = useQuery({
    queryKey: ['eng-survey-results', id],
    queryFn: () => hcmApi.engagement.surveys.results(id),
  });

  return (
    <Card
      title="Results"
      subtitle={results.data ? `${results.data.survey.title} — ${results.data.totalResponses} response(s)` : undefined}
      actions={
        <button className="btn text-2xs" onClick={onClose}>
          Close
        </button>
      }
    >
      {results.isLoading && <Loading />}
      {results.error && <ErrorBox error={results.error} />}
      {results.data && results.data.totalResponses === 0 && <EmptyState message="No responses yet." />}
      {results.data &&
        results.data.questions.map((q) => (
          <div key={q.questionId} className="border-b border-ink-800 py-2 last:border-0">
            <p className="text-xs font-medium text-ink-200">{q.text}</p>
            {q.type === 'enps' && (
              <p className="mt-1 text-2xs text-ink-400">
                eNPS <span className="font-semibold text-ink-100">{q.score ?? '—'}</span> · {q.promoters} promoter(s),{' '}
                {q.passives} passive(s), {q.detractors} detractor(s)
              </p>
            )}
            {q.type === 'scale' && (
              <p className="mt-1 text-2xs text-ink-400">
                Average {q.average?.toFixed(1) ?? '—'} over {q.responses} response(s)
              </p>
            )}
            {q.type === 'text' && (
              <ul className="mt-1 list-disc pl-4 text-2xs text-ink-400">
                {(q.answers ?? []).map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpdesk
// ---------------------------------------------------------------------------

function HelpdeskTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [showConfidential, setShowConfidential] = useState(false);
  const [form, setForm] = useState<{
    category: 'payroll' | 'leave' | 'policy' | 'it' | 'grievance' | 'other';
    priority: 'low' | 'normal' | 'high' | 'urgent';
    subject: string;
    body: string;
  }>({ category: 'other', priority: 'normal', subject: '', body: '' });

  const cases = useQuery({ queryKey: ['eng-hr-cases'], queryFn: () => hcmApi.engagement.hrCases.list() });
  const confidential = useQuery({
    queryKey: ['eng-hr-cases-confidential'],
    queryFn: () => hcmApi.engagement.hrCases.confidential(),
    enabled: showConfidential,
    retry: false,
  });

  const resolve = useMutation({
    mutationFn: (id: string) => hcmApi.engagement.hrCases.resolve(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eng-hr-cases'] });
      qc.invalidateQueries({ queryKey: ['eng-hr-cases-confidential'] });
    },
  });

  const caseColumns: ReadonlyArray<DataTableColumn<HrCase>> = [
    {
      id: 'case',
      header: 'Case',
      sortValue: (c) => c.recordCode,
      cell: (c) => <span className="mono text-2xs">{c.recordCode}</span>,
    },
    {
      id: 'category',
      header: 'Category',
      sortValue: (c) => c.category,
      cell: (c) => c.category.replace(/_/g, ' '),
    },
    {
      id: 'priority',
      header: 'Priority',
      sortValue: (c) => c.priority,
      cell: (c) => (
        <StatusChip
          status={c.priority}
          tone={c.priority === 'urgent' ? 'bad' : c.priority === 'high' ? 'warn' : 'neutral'}
        />
      ),
    },
    { id: 'subject', header: 'Subject', sortValue: (c) => c.subject, cell: (c) => c.subject },
    {
      id: 'status',
      header: 'Status',
      sortValue: (c) => c.status,
      cell: (c) => (
        <StatusChip status={c.status} tone={c.status === 'resolved' || c.status === 'closed' ? 'good' : 'neutral'} />
      ),
    },
    { id: 'sla', header: 'SLA due', sortValue: (c) => c.slaDueAt, cell: (c) => dateTime(c.slaDueAt) },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (c) =>
        c.status !== 'resolved' &&
        c.status !== 'closed' && (
          <button className="btn text-2xs" onClick={() => resolve.mutate(c.id)}>
            Mark resolved
          </button>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Helpdesk queue"
        subtitle="Every non-confidential case. A grievance is automatically confidential and never appears here — see the confidential queue below."
        actions={<NewButton label="Raise a case" onClick={() => setOpen(true)} />}
      >
        <DataTable
          caption="Helpdesk queue"
          columns={caseColumns}
          rows={cases.data ?? []}
          rowKey={(c) => c.id}
          loading={cases.isLoading}
          error={cases.error}
          emptyMessage="No open cases."
        />
      </Card>

      <Card
        title="Confidential cases"
        subtitle="Grievances and anything else marked confidential. Visible only to a holder of the hr_cases grant at all scope — a 403 here means the grant is not held, not that there is nothing to see."
        actions={
          <button className="btn text-2xs" onClick={() => setShowConfidential(true)}>
            Reveal
          </button>
        }
      >
        {!showConfidential && (
          <EmptyState
            message="Hidden until you choose to reveal it."
            hint="A deliberate extra step, the same one POSH complaints take."
          />
        )}
        {showConfidential && (
          <DataTable
            caption="Confidential HR cases"
            columns={caseColumns}
            rows={confidential.data ?? []}
            rowKey={(c) => c.id}
            loading={confidential.isLoading}
            error={confidential.error}
            emptyMessage="No confidential cases."
          />
        )}
      </Card>

      <CreateModal
        open={open}
        title="Raise a case"
        onClose={() => setOpen(false)}
        invalidate={[['eng-hr-cases'], ['eng-hr-cases-confidential']]}
        onSubmit={() => hcmApi.engagement.hrCases.create(form)}
      >
        <Row>
          <SelectInput
            label="Category"
            value={form.category}
            onChange={(v) => setForm({ ...form, category: v })}
            options={[
              { value: 'payroll', label: 'Payroll' },
              { value: 'leave', label: 'Leave' },
              { value: 'policy', label: 'Policy' },
              { value: 'it', label: 'IT' },
              { value: 'grievance', label: 'Grievance (confidential)' },
              { value: 'other', label: 'Other' },
            ]}
          />
          <SelectInput
            label="Priority"
            value={form.priority}
            onChange={(v) => setForm({ ...form, priority: v })}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'normal', label: 'Normal' },
              { value: 'high', label: 'High' },
              { value: 'urgent', label: 'Urgent' },
            ]}
          />
        </Row>
        <TextInput label="Subject" value={form.subject} onChange={(v) => setForm({ ...form, subject: v })} required />
        <TextArea
          label="Describe the issue"
          value={form.body}
          onChange={(v) => setForm({ ...form, body: v })}
          required
          rows={4}
        />
      </CreateModal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

function PoliciesTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [statusFor, setStatusFor] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', version: '1.0', body: '', acknowledgementRequired: true });

  const policies = useQuery({
    queryKey: ['eng-policies'],
    queryFn: () => hcmApi.engagement.policies.list(),
  });
  const status = useQuery({
    queryKey: ['eng-policy-status', statusFor],
    queryFn: () => hcmApi.engagement.policies.status(statusFor!),
    enabled: Boolean(statusFor),
    retry: false,
  });
  const publish = useMutation({
    mutationFn: (id: string) => hcmApi.engagement.policies.publish(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eng-policies'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<PolicyDocument>> = [
    { id: 'title', header: 'Title', sortValue: (p) => p.title, cell: (p) => p.title },
    {
      id: 'version',
      header: 'Version',
      sortValue: (p) => p.version,
      cell: (p) => <span className="mono">{p.version}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (p) => p.status,
      cell: (p) => (
        <StatusChip
          status={p.status}
          tone={p.status === 'published' ? 'good' : p.status === 'superseded' ? 'neutral' : 'warn'}
        />
      ),
    },
    {
      id: 'effective',
      header: 'Effective from',
      sortValue: (p) => p.effectiveFrom,
      cell: (p) => dateTime(p.effectiveFrom),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (p) => (
        <div className="flex justify-end gap-2">
          {p.status === 'draft' && (
            <button className="btn text-2xs" onClick={() => publish.mutate(p.id)}>
              Publish
            </button>
          )}
          {p.acknowledgementRequired && (
            <button className="btn text-2xs" onClick={() => setStatusFor(p.id)}>
              Ack status
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Policy documents"
        subtitle="Versioned company policies. Publishing a new version supersedes the previous published one under the same title."
        actions={<NewButton label="New policy" onClick={() => setOpen(true)} />}
      >
        <DataTable
          caption="Policy documents"
          columns={columns}
          rows={policies.data ?? []}
          rowKey={(p) => p.id}
          loading={policies.isLoading}
          error={policies.error}
          emptyMessage="No policy documents yet."
        />
      </Card>

      {statusFor && status.data && (
        <Card
          title="Acknowledgement status"
          actions={
            <button className="btn text-2xs" onClick={() => setStatusFor(null)}>
              Close
            </button>
          }
        >
          <p className="text-sm text-ink-200">
            {status.data.ackCount} acknowledgement(s) recorded for {status.data.policy.title} v
            {status.data.policy.version}.
          </p>
        </Card>
      )}

      <CreateModal
        open={open}
        title="New policy document"
        onClose={() => setOpen(false)}
        invalidate={[['eng-policies']]}
        onSubmit={() =>
          hcmApi.engagement.policies.create({
            title: form.title,
            version: form.version,
            body: form.body,
            acknowledgementRequired: form.acknowledgementRequired,
            effectiveFrom: new Date().toISOString(),
          })
        }
      >
        <TextInput label="Title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} required />
        <TextInput label="Version" value={form.version} onChange={(v) => setForm({ ...form, version: v })} required />
        <TextArea label="Body" value={form.body} onChange={(v) => setForm({ ...form, body: v })} rows={6} required />
        <label className="flex items-center gap-2 text-xs text-ink-300">
          <input
            type="checkbox"
            checked={form.acknowledgementRequired}
            onChange={(e) => setForm({ ...form, acknowledgementRequired: e.target.checked })}
          />
          Require acknowledgement
        </label>
      </CreateModal>
    </div>
  );
}
