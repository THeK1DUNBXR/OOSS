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
import { api, dateTime } from '../../lib/api.js';
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

interface Announcement {
  id: string;
  recordCode: string;
  title: string;
  body: string;
  status: string;
  pinned: boolean;
  acknowledgementRequired: boolean;
  publishAt: string;
  expiresAt: string | null;
}

function AnnouncementsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', pinned: false, acknowledgementRequired: false });

  const announcements = useQuery({ queryKey: ['eng-announcements'], queryFn: () => api.get<Announcement[]>('/hcm/engagement/announcements') });
  const withdraw = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/engagement/announcements/${id}/withdraw`),
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
                  <StatusChip status={a.status} tone={a.status === 'published' ? 'good' : a.status === 'withdrawn' ? 'bad' : 'neutral'} />
                  {a.acknowledgementRequired && <span className="chip border-band-watch/40 text-band-watch">Ack required</span>}
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
          api.post('/hcm/engagement/announcements', {
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
            <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} />
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

interface Recognition {
  id: string;
  recordCode: string;
  fromPartyId: string;
  toPartyId: string;
  badge: string;
  message: string;
  points: number;
  createdAt: string;
}

function RecognitionTab() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ toPartyId: '', badge: '', message: '', points: '10' });

  const recognitions = useQuery({ queryKey: ['eng-recognitions'], queryFn: () => api.get<Recognition[]>('/hcm/engagement/recognitions') });
  const leaderboard = useQuery({
    queryKey: ['eng-recognition-leaderboard'],
    queryFn: () => api.get<Array<{ toPartyId: string; totalPoints: number; count: number }>>('/hcm/engagement/recognitions/leaderboard'),
    retry: false,
  });

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Recognition"
        subtitle="Kudos given and received. Everyone sees what they gave or received; only HR sees the full ledger."
        actions={<NewButton label="Give recognition" onClick={() => setOpen(true)} />}
      >
        {recognitions.isLoading && <Loading />}
        {recognitions.error && <ErrorBox error={recognitions.error} />}
        {recognitions.data && recognitions.data.length === 0 && (
          <EmptyState message="No recognition yet." hint="Give kudos to a colleague to start the ledger." />
        )}
        {recognitions.data && recognitions.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>From</th>
                <th>To</th>
                <th>Badge</th>
                <th>Message</th>
                <th className="text-right">Points</th>
              </tr>
            </thead>
            <tbody>
              {recognitions.data.map((r) => (
                <tr key={r.id}>
                  <td>{dateTime(r.createdAt)}</td>
                  <td className="mono text-2xs">{r.fromPartyId.slice(0, 8)}</td>
                  <td className="mono text-2xs">{r.toPartyId.slice(0, 8)}</td>
                  <td>{r.badge}</td>
                  <td className="text-ink-300">{r.message}</td>
                  <td className="text-right tabular-nums">{r.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <CreateModal
        open={open}
        title="Give recognition"
        onClose={() => setOpen(false)}
        invalidate={[['eng-recognitions'], ['eng-recognition-leaderboard']]}
        onSubmit={() =>
          api.post('/hcm/engagement/recognitions', {
            toPartyId: form.toPartyId,
            badge: form.badge,
            message: form.message,
            points: Number(form.points) || 0,
          })
        }
      >
        <TextInput label="Recipient party id" value={form.toPartyId} onChange={(v) => setForm({ ...form, toPartyId: v })} required hint="The person id — a directory picker lands with WS1." />
        <TextInput label="Badge" value={form.badge} onChange={(v) => setForm({ ...form, badge: v })} required placeholder="Team player" />
        <TextArea label="Message" value={form.message} onChange={(v) => setForm({ ...form, message: v })} required />
        <TextInput label="Points" type="number" value={form.points} onChange={(v) => setForm({ ...form, points: v })} />
      </CreateModal>

      {leaderboard.data && leaderboard.data.length > 0 && (
        <Card title="Leaderboard" subtitle="Total recognition points received, HR view.">
          <table className="table">
            <thead>
              <tr>
                <th>Person</th>
                <th className="text-right">Recognitions</th>
                <th className="text-right">Points</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.data.map((row) => (
                <tr key={row.toPartyId}>
                  <td className="mono text-2xs">{row.toPartyId.slice(0, 8)}</td>
                  <td className="text-right tabular-nums">{row.count}</td>
                  <td className="text-right tabular-nums">{row.totalPoints}</td>
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
// Surveys
// ---------------------------------------------------------------------------

interface PulseSurvey {
  id: string;
  recordCode: string;
  title: string;
  anonymous: boolean;
  status: string;
  opensAt: string;
  closesAt: string;
}

function SurveysTab() {
  const [open, setOpen] = useState(false);
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', questionText: '', questionType: 'enps' as 'enps' | 'scale' | 'text', anonymous: true, days: '14' });
  const qc = useQueryClient();

  const surveys = useQuery({ queryKey: ['eng-surveys'], queryFn: () => api.get<PulseSurvey[]>('/hcm/engagement/surveys') });
  const openMutation = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/engagement/surveys/${id}/open`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eng-surveys'] }),
  });
  const closeMutation = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/engagement/surveys/${id}/close`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eng-surveys'] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Pulse surveys"
        subtitle="A single-question pulse or eNPS check, or a longer survey — each with its own audience and anonymity."
        actions={<NewButton label="New survey" onClick={() => setOpen(true)} />}
      >
        {surveys.isLoading && <Loading />}
        {surveys.error && <ErrorBox error={surveys.error} />}
        {surveys.data && surveys.data.length === 0 && <EmptyState message="No surveys yet." />}
        {surveys.data && surveys.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Opens</th>
                <th>Closes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {surveys.data.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.title}
                    {s.anonymous && <span className="ml-2 chip border-ink-700 text-ink-400">Anonymous</span>}
                  </td>
                  <td><StatusChip status={s.status} tone={s.status === 'open' ? 'good' : s.status === 'closed' ? 'neutral' : 'warn'} /></td>
                  <td>{dateTime(s.opensAt)}</td>
                  <td>{dateTime(s.closesAt)}</td>
                  <td className="flex justify-end gap-2 text-right">
                    {s.status === 'draft' && (
                      <button className="btn text-2xs" onClick={() => openMutation.mutate(s.id)}>
                        Open
                      </button>
                    )}
                    {s.status === 'open' && (
                      <button className="btn text-2xs" onClick={() => closeMutation.mutate(s.id)}>
                        Close
                      </button>
                    )}
                    <button className="btn text-2xs" onClick={() => setResultsFor(s.id)}>
                      Results
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <CreateModal
        open={open}
        title="New survey"
        onClose={() => setOpen(false)}
        invalidate={[['eng-surveys']]}
        onSubmit={() =>
          api.post('/hcm/engagement/surveys', {
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
        <TextArea label="Question" value={form.questionText} onChange={(v) => setForm({ ...form, questionText: v })} required />
        <Row>
          <TextInput label="Open for (days)" type="number" value={form.days} onChange={(v) => setForm({ ...form, days: v })} />
          <label className="flex items-center gap-2 pt-6 text-xs text-ink-300">
            <input type="checkbox" checked={form.anonymous} onChange={(e) => setForm({ ...form, anonymous: e.target.checked })} />
            Anonymous responses
          </label>
        </Row>
      </CreateModal>

      {resultsFor && <SurveyResultsCard id={resultsFor} onClose={() => setResultsFor(null)} />}
    </div>
  );
}

interface QuestionResult {
  questionId: string;
  text: string;
  type: string;
  responses?: number;
  average?: number | null;
  answers?: string[];
  promoters?: number;
  passives?: number;
  detractors?: number;
  score?: number | null;
}

function SurveyResultsCard({ id, onClose }: { id: string; onClose: () => void }) {
  const results = useQuery({
    queryKey: ['eng-survey-results', id],
    queryFn: () => api.get<{ survey: PulseSurvey; totalResponses: number; questions: QuestionResult[] }>(`/hcm/engagement/surveys/${id}/results`),
  });

  return (
    <Card title="Results" subtitle={results.data ? `${results.data.survey.title} — ${results.data.totalResponses} response(s)` : undefined} actions={<button className="btn text-2xs" onClick={onClose}>Close</button>}>
      {results.isLoading && <Loading />}
      {results.error && <ErrorBox error={results.error} />}
      {results.data && results.data.totalResponses === 0 && <EmptyState message="No responses yet." />}
      {results.data && results.data.questions.map((q) => (
        <div key={q.questionId} className="border-b border-ink-800 py-2 last:border-0">
          <p className="text-xs font-medium text-ink-200">{q.text}</p>
          {q.type === 'enps' && (
            <p className="mt-1 text-2xs text-ink-400">
              eNPS <span className="font-semibold text-ink-100">{q.score ?? '—'}</span> · {q.promoters} promoter(s), {q.passives} passive(s), {q.detractors} detractor(s)
            </p>
          )}
          {q.type === 'scale' && <p className="mt-1 text-2xs text-ink-400">Average {q.average?.toFixed(1) ?? '—'} over {q.responses} response(s)</p>}
          {q.type === 'text' && (
            <ul className="mt-1 list-disc pl-4 text-2xs text-ink-400">
              {(q.answers ?? []).map((a, i) => <li key={i}>{a}</li>)}
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

interface HrCase {
  id: string;
  recordCode: string;
  category: string;
  priority: string;
  status: string;
  subject: string;
  confidential: boolean;
  slaDueAt: string;
  raisedByPartyId: string;
  assigneePartyId: string | null;
}

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

  const cases = useQuery({ queryKey: ['eng-hr-cases'], queryFn: () => api.get<HrCase[]>('/hcm/engagement/hr-cases') });
  const confidential = useQuery({
    queryKey: ['eng-hr-cases-confidential'],
    queryFn: () => api.get<HrCase[]>('/hcm/engagement/hr-cases/confidential'),
    enabled: showConfidential,
    retry: false,
  });

  const resolve = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/engagement/hr-cases/${id}/transition`, { status: 'resolved' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eng-hr-cases'] });
      qc.invalidateQueries({ queryKey: ['eng-hr-cases-confidential'] });
    },
  });

  const renderRow = (c: HrCase) => (
    <tr key={c.id}>
      <td className="mono text-2xs">{c.recordCode}</td>
      <td>{c.category.replace(/_/g, ' ')}</td>
      <td><StatusChip status={c.priority} tone={c.priority === 'urgent' ? 'bad' : c.priority === 'high' ? 'warn' : 'neutral'} /></td>
      <td>{c.subject}</td>
      <td><StatusChip status={c.status} tone={c.status === 'resolved' || c.status === 'closed' ? 'good' : 'neutral'} /></td>
      <td>{dateTime(c.slaDueAt)}</td>
      <td className="text-right">
        {c.status !== 'resolved' && c.status !== 'closed' && (
          <button className="btn text-2xs" onClick={() => resolve.mutate(c.id)}>
            Mark resolved
          </button>
        )}
      </td>
    </tr>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Helpdesk queue"
        subtitle="Every non-confidential case. A grievance is automatically confidential and never appears here — see the confidential queue below."
        actions={<NewButton label="Raise a case" onClick={() => setOpen(true)} />}
      >
        {cases.isLoading && <Loading />}
        {cases.error && <ErrorBox error={cases.error} />}
        {cases.data && cases.data.length === 0 && <EmptyState message="No open cases." />}
        {cases.data && cases.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Category</th>
                <th>Priority</th>
                <th>Subject</th>
                <th>Status</th>
                <th>SLA due</th>
                <th />
              </tr>
            </thead>
            <tbody>{cases.data.map(renderRow)}</tbody>
          </table>
        )}
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
        {!showConfidential && <EmptyState message="Hidden until you choose to reveal it." hint="A deliberate extra step, the same one POSH complaints take." />}
        {showConfidential && confidential.isLoading && <Loading />}
        {showConfidential && confidential.error && <ErrorBox error={confidential.error} />}
        {showConfidential && confidential.data && confidential.data.length === 0 && <EmptyState message="No confidential cases." />}
        {showConfidential && confidential.data && confidential.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Category</th>
                <th>Priority</th>
                <th>Subject</th>
                <th>Status</th>
                <th>SLA due</th>
                <th />
              </tr>
            </thead>
            <tbody>{confidential.data.map(renderRow)}</tbody>
          </table>
        )}
      </Card>

      <CreateModal
        open={open}
        title="Raise a case"
        onClose={() => setOpen(false)}
        invalidate={[['eng-hr-cases'], ['eng-hr-cases-confidential']]}
        onSubmit={() => api.post('/hcm/engagement/hr-cases', form)}
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
        <TextArea label="Describe the issue" value={form.body} onChange={(v) => setForm({ ...form, body: v })} required rows={4} />
      </CreateModal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

interface PolicyDocument {
  id: string;
  recordCode: string;
  title: string;
  version: string;
  status: string;
  effectiveFrom: string;
  acknowledgementRequired: boolean;
}

function PoliciesTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [statusFor, setStatusFor] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', version: '1.0', body: '', acknowledgementRequired: true });

  const policies = useQuery({ queryKey: ['eng-policies'], queryFn: () => api.get<PolicyDocument[]>('/hcm/engagement/policies') });
  const status = useQuery({
    queryKey: ['eng-policy-status', statusFor],
    queryFn: () => api.get<{ policy: PolicyDocument; ackCount: number }>(`/hcm/engagement/policies/${statusFor}/status`),
    enabled: Boolean(statusFor),
    retry: false,
  });
  const publish = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/engagement/policies/${id}/publish`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eng-policies'] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Policy documents"
        subtitle="Versioned company policies. Publishing a new version supersedes the previous published one under the same title."
        actions={<NewButton label="New policy" onClick={() => setOpen(true)} />}
      >
        {policies.isLoading && <Loading />}
        {policies.error && <ErrorBox error={policies.error} />}
        {policies.data && policies.data.length === 0 && <EmptyState message="No policy documents yet." />}
        {policies.data && policies.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Version</th>
                <th>Status</th>
                <th>Effective from</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {policies.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.title}</td>
                  <td className="mono">{p.version}</td>
                  <td><StatusChip status={p.status} tone={p.status === 'published' ? 'good' : p.status === 'superseded' ? 'neutral' : 'warn'} /></td>
                  <td>{dateTime(p.effectiveFrom)}</td>
                  <td className="flex justify-end gap-2 text-right">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {statusFor && status.data && (
        <Card title="Acknowledgement status" actions={<button className="btn text-2xs" onClick={() => setStatusFor(null)}>Close</button>}>
          <p className="text-sm text-ink-200">
            {status.data.ackCount} acknowledgement(s) recorded for {status.data.policy.title} v{status.data.policy.version}.
          </p>
        </Card>
      )}

      <CreateModal
        open={open}
        title="New policy document"
        onClose={() => setOpen(false)}
        invalidate={[['eng-policies']]}
        onSubmit={() =>
          api.post('/hcm/engagement/policies', {
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
