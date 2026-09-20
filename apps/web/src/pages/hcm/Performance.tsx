/**
 * Performance — WS5 (docs/hcm/performance.md).
 *
 * Review cycles and talent management: cycles move through a fixed phase
 * order (self -> manager -> calibration -> closed); calibration snapshots a
 * rating and 9-box placement per person; a rating stays invisible to the
 * person it is about until the cycle closes and it is individually released.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, titleCase } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, messageOf, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

type Tab = 'cycles' | 'assignments' | 'calibration' | 'ninebox' | 'feedback' | 'oneOnOnes' | 'pips' | 'succession';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'cycles', label: 'Cycles' },
  { key: 'assignments', label: 'Assignments' },
  { key: 'calibration', label: 'Calibration' },
  { key: 'ninebox', label: '9-box' },
  { key: 'feedback', label: 'Feedback' },
  { key: 'oneOnOnes', label: '1:1s' },
  { key: 'pips', label: 'PIPs' },
  { key: 'succession', label: 'Succession' },
];

interface EmploymentOption {
  id: string;
  person: { fullName: string };
}

function useEmployments() {
  return useQuery({ queryKey: ['performance-employments'], queryFn: () => api.get<EmploymentOption[]>('/hr/employments?status=Active') });
}

function EmploymentSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: EmploymentOption[] }) {
  return (
    <SelectInput
      label={label}
      value={value as never}
      onChange={onChange as never}
      placeholder="Choose a person…"
      options={options.map((o) => ({ value: o.id, label: o.person.fullName }))}
      required
    />
  );
}

export function Performance() {
  const [tab, setTab] = useState<Tab>('cycles');
  return (
    <>
      <PageHeader
        title="Performance"
        subtitle="Review cycles, calibration and the 9-box, continuous feedback, 1:1s, PIPs and succession. A rating stays with HR until the cycle closes and it is released to the person it is about."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'cycles' && <CyclesTab />}
      {tab === 'assignments' && <AssignmentsTab />}
      {tab === 'calibration' && <CalibrationTab />}
      {tab === 'ninebox' && <NineBoxTab />}
      {tab === 'feedback' && <FeedbackTab />}
      {tab === 'oneOnOnes' && <OneOnOnesTab />}
      {tab === 'pips' && <PipsTab />}
      {tab === 'succession' && <SuccessionTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

interface ReviewCycle {
  id: string;
  recordCode: string;
  name: string;
  kind: string;
  periodLabel: string;
  phase: string;
  startsOn: string;
  endsOn: string;
}

const PHASE_TONE: Record<string, 'neutral' | 'warn' | 'good'> = {
  self: 'neutral',
  manager: 'neutral',
  calibration: 'warn',
  closed: 'good',
};

const NEXT_PHASE: Record<string, string | null> = { self: 'manager', manager: 'calibration', calibration: 'closed', closed: null };

function CyclesTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', kind: 'annual' as string, periodLabel: '', startsOn: '', endsOn: '' });

  const cycles = useQuery({ queryKey: ['performance-cycles'], queryFn: () => api.get<ReviewCycle[]>('/hcm/performance/review-cycles') });

  const advance = useMutation({
    mutationFn: ({ id, phase }: { id: string; phase: string }) => api.post(`/hcm/performance/review-cycles/${id}/phase`, { phase }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['performance-cycles'] }),
  });

  return (
    <Card
      title="Review cycles"
      subtitle="Each cycle moves self -> manager -> calibration -> closed, one phase at a time. Calibration only opens once every assignment for the cycle has been submitted."
      actions={<NewButton label="New cycle" onClick={() => setOpen(true)} />}
    >
      {cycles.isLoading && <Loading />}
      {cycles.error && <ErrorBox error={cycles.error} />}
      {cycles.data && cycles.data.length === 0 && <EmptyState message="No review cycles yet." hint="Open one to start collecting self and manager reviews." />}
      {cycles.data && cycles.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Cycle</th>
              <th>Kind</th>
              <th>Period</th>
              <th>Phase</th>
              <th>Dates</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cycles.data.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.name}
                  <p className="mono text-2xs text-ink-500">{c.recordCode}</p>
                </td>
                <td>{titleCase(c.kind)}</td>
                <td>{c.periodLabel}</td>
                <td><StatusChip status={c.phase} tone={PHASE_TONE[c.phase] ?? 'neutral'} /></td>
                <td className="text-2xs text-ink-400">{date(c.startsOn)} – {date(c.endsOn)}</td>
                <td className="text-right">
                  {NEXT_PHASE[c.phase] && (
                    <button
                      className="btn text-2xs"
                      disabled={advance.isPending}
                      onClick={() => advance.mutate({ id: c.id, phase: NEXT_PHASE[c.phase]! })}
                    >
                      Advance to {NEXT_PHASE[c.phase]}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {advance.error && <ErrorBox error={advance.error} />}

      <CreateModal
        open={open}
        title="Open a review cycle"
        onClose={() => setOpen(false)}
        invalidate={[['performance-cycles']]}
        onSubmit={() =>
          api.post('/hcm/performance/review-cycles', {
            name: form.name,
            kind: form.kind,
            periodLabel: form.periodLabel,
            startsOn: form.startsOn,
            endsOn: form.endsOn,
          })
        }
      >
        <TextInput label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <Row>
          <SelectInput
            label="Kind"
            value={form.kind as never}
            onChange={(v) => setForm({ ...form, kind: v })}
            options={[
              { value: 'annual', label: 'Annual' },
              { value: 'half', label: 'Half-yearly' },
              { value: 'quarter', label: 'Quarterly' },
              { value: 'probation', label: 'Probation' },
            ]}
            required
          />
          <TextInput label="Period label" value={form.periodLabel} onChange={(v) => setForm({ ...form, periodLabel: v })} placeholder="FY2026-27" required />
        </Row>
        <Row>
          <TextInput label="Starts on" type="date" value={form.startsOn} onChange={(v) => setForm({ ...form, startsOn: v })} required />
          <TextInput label="Ends on" type="date" value={form.endsOn} onChange={(v) => setForm({ ...form, endsOn: v })} required />
        </Row>
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

interface ReviewAssignment {
  id: string;
  cycleId: string;
  employmentRelationshipId: string;
  reviewerEmploymentRelationshipId: string;
  kind: string;
  status: string;
  response: { comments: string | null } | null;
}

function AssignmentsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const employments = useEmployments();
  const cycles = useQuery({ queryKey: ['performance-cycles'], queryFn: () => api.get<ReviewCycle[]>('/hcm/performance/review-cycles') });
  const [form, setForm] = useState({ cycleId: '', employmentRelationshipId: '', reviewerEmploymentRelationshipId: '', kind: 'manager' as string });

  const assignments = useQuery({
    queryKey: ['performance-assignments', form.cycleId],
    queryFn: () => api.get<ReviewAssignment[]>(`/hcm/performance/review-assignments${form.cycleId ? `?cycleId=${form.cycleId}` : ''}`),
  });

  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  return (
    <Card
      title="Review assignments"
      subtitle="One row per reviewer per subject. A reviewer never reviews themselves outside the self form."
      actions={<NewButton label="Assign a review" onClick={() => setOpen(true)} />}
    >
      <div className="mb-3 max-w-xs">
        <SelectInput
          label="Filter by cycle"
          value={form.cycleId as never}
          onChange={(v) => setForm({ ...form, cycleId: v })}
          placeholder="All cycles"
          options={(cycles.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
        />
      </div>
      {assignments.isLoading && <Loading />}
      {assignments.error && <ErrorBox error={assignments.error} />}
      {assignments.data && assignments.data.length === 0 && <EmptyState message="No review assignments yet." />}
      {assignments.data && assignments.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Reviewer</th>
              <th>Kind</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {assignments.data.map((a) => (
              <tr key={a.id}>
                <td>{byId.get(a.employmentRelationshipId) ?? a.employmentRelationshipId}</td>
                <td>{byId.get(a.reviewerEmploymentRelationshipId) ?? a.reviewerEmploymentRelationshipId}</td>
                <td><StatusChip status={a.kind} /></td>
                <td><StatusChip status={a.status} tone={a.status === 'submitted' ? 'good' : 'neutral'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Assign a review"
        onClose={() => setOpen(false)}
        invalidate={[['performance-assignments', form.cycleId]]}
        onSubmit={() =>
          api.post('/hcm/performance/review-assignments', {
            cycleId: form.cycleId,
            employmentRelationshipId: form.employmentRelationshipId,
            reviewerEmploymentRelationshipId: form.reviewerEmploymentRelationshipId,
            kind: form.kind,
          })
        }
      >
        <SelectInput
          label="Cycle"
          value={form.cycleId as never}
          onChange={(v) => setForm({ ...form, cycleId: v })}
          placeholder="Choose a cycle…"
          options={(cycles.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          required
        />
        {employments.data && (
          <>
            <EmploymentSelect label="Subject" value={form.employmentRelationshipId} onChange={(v) => setForm({ ...form, employmentRelationshipId: v })} options={employments.data} />
            <EmploymentSelect label="Reviewer" value={form.reviewerEmploymentRelationshipId} onChange={(v) => setForm({ ...form, reviewerEmploymentRelationshipId: v })} options={employments.data} />
          </>
        )}
        <SelectInput
          label="Kind"
          value={form.kind as never}
          onChange={(v) => setForm({ ...form, kind: v })}
          options={[
            { value: 'self', label: 'Self' },
            { value: 'manager', label: 'Manager' },
            { value: 'peer', label: 'Peer' },
            { value: 'upward', label: 'Upward' },
            { value: 'skip', label: 'Skip-level' },
          ]}
          required
        />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

interface CalibrationSession {
  id: string;
  cycleId: string;
  status: string;
  decisions: Array<{ employmentRelationshipId: string; rating: string; potential: string; promotionRecommended?: boolean }> | null;
}

function CalibrationTab() {
  const qc = useQueryClient();
  const employments = useEmployments();
  const cycles = useQuery({ queryKey: ['performance-cycles'], queryFn: () => api.get<ReviewCycle[]>('/hcm/performance/review-cycles') });
  const [cycleId, setCycleId] = useState('');
  const [openForm, setOpenForm] = useState(false);
  const [participantId, setParticipantId] = useState('');
  const [decisionEmp, setDecisionEmp] = useState('');
  const [decisionForm, setDecisionForm] = useState({ rating: '3', potential: 'medium' as string, promotionRecommended: false });

  const sessions = useQuery({
    queryKey: ['performance-calibrations', cycleId],
    queryFn: () => api.get<CalibrationSession[]>(`/hcm/performance/calibrations${cycleId ? `?cycleId=${cycleId}` : ''}`),
  });

  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  const openSession = useMutation({
    mutationFn: () => api.post('/hcm/performance/calibrations', { cycleId, participants: [{ employmentRelationshipId: participantId }] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['performance-calibrations', cycleId] });
      setOpenForm(false);
    },
  });

  const recordDecision = useMutation({
    mutationFn: (sessionId: string) =>
      api.patch(`/hcm/performance/calibrations/${sessionId}`, {
        decisions: [
          {
            employmentRelationshipId: decisionEmp,
            rating: decisionForm.rating,
            potential: decisionForm.potential,
            promotionRecommended: decisionForm.promotionRecommended,
          },
        ],
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['performance-calibrations', cycleId] }),
  });

  const close = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/performance/calibrations/${id}/close`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['performance-calibrations', cycleId] }),
  });

  return (
    <Card
      title="Calibration"
      subtitle="Opens once a cycle reaches the calibration phase. Closing a session snapshots each decision into that person's final rating — nothing is visible to them until it is individually released."
      actions={<NewButton label="Open session" onClick={() => setOpenForm(true)} />}
    >
      <div className="mb-3 max-w-xs">
        <SelectInput label="Cycle" value={cycleId as never} onChange={setCycleId} placeholder="Choose a cycle…" options={(cycles.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
      </div>

      {sessions.isLoading && <Loading />}
      {sessions.error && <ErrorBox error={sessions.error} />}
      {sessions.data && sessions.data.length === 0 && <EmptyState message="No calibration sessions for this cycle yet." />}
      {(sessions.data ?? []).map((s) => (
        <div key={s.id} className="mb-4 rounded border border-ink-800 p-3">
          <div className="mb-2 flex items-center justify-between">
            <StatusChip status={s.status} tone={s.status === 'closed' ? 'good' : 'neutral'} />
            {s.status === 'open' && (
              <button className="btn text-2xs" onClick={() => close.mutate(s.id)} disabled={close.isPending}>
                Close session
              </button>
            )}
          </div>
          {s.decisions && s.decisions.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Rating</th>
                  <th>Potential</th>
                  <th>Promotion</th>
                </tr>
              </thead>
              <tbody>
                {s.decisions.map((d) => (
                  <tr key={d.employmentRelationshipId}>
                    <td>{byId.get(d.employmentRelationshipId) ?? d.employmentRelationshipId}</td>
                    <td>{d.rating}</td>
                    <td>{titleCase(d.potential)}</td>
                    <td>{d.promotionRecommended ? 'Yes' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {s.status === 'open' && employments.data && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <EmploymentSelect label="Person" value={decisionEmp} onChange={setDecisionEmp} options={employments.data} />
              <SelectInput label="Rating" value={decisionForm.rating as never} onChange={(v) => setDecisionForm({ ...decisionForm, rating: v })} options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v }))} required />
              <SelectInput
                label="Potential"
                value={decisionForm.potential as never}
                onChange={(v) => setDecisionForm({ ...decisionForm, potential: v })}
                options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]}
                required
              />
              <button className="btn" disabled={!decisionEmp || recordDecision.isPending} onClick={() => recordDecision.mutate(s.id)}>
                Record decision
              </button>
            </div>
          )}
        </div>
      ))}
      {(openSession.error || recordDecision.error || close.error) && <ErrorBox error={openSession.error ?? recordDecision.error ?? close.error} />}

      <CreateModal open={openForm} title="Open a calibration session" onClose={() => setOpenForm(false)} invalidate={[['performance-calibrations', cycleId]]} onSubmit={() => openSession.mutateAsync()}>
        <SelectInput label="Cycle" value={cycleId as never} onChange={setCycleId} placeholder="Choose a cycle…" options={(cycles.data ?? []).map((c) => ({ value: c.id, label: c.name }))} required />
        {employments.data && <EmploymentSelect label="First participant" value={participantId} onChange={setParticipantId} options={employments.data} />}
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 9-box
// ---------------------------------------------------------------------------

interface NineBoxCell {
  employmentRelationshipId: string;
  rating: string;
  potential: string;
  row: number;
  col: number;
  label: string;
}

const NINE_BOX_ROWS = ['High potential', 'Medium potential', 'Low potential'];
const NINE_BOX_COLS = ['Low performance', 'Medium performance', 'High performance'];

function NineBoxTab() {
  const employments = useEmployments();
  const cycles = useQuery({ queryKey: ['performance-cycles'], queryFn: () => api.get<ReviewCycle[]>('/hcm/performance/review-cycles') });
  const [cycleId, setCycleId] = useState('');

  const grid = useQuery({
    queryKey: ['performance-ninebox', cycleId],
    queryFn: () => api.get<NineBoxCell[]>(`/hcm/performance/nine-box?cycleId=${cycleId}`),
    enabled: !!cycleId,
  });

  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  return (
    <Card title="9-box" subtitle="Every rated employee at once — needs an all-scope grant on reviews, so this is an HR view rather than a manager one.">
      <div className="mb-3 max-w-xs">
        <SelectInput label="Cycle" value={cycleId as never} onChange={setCycleId} placeholder="Choose a cycle…" options={(cycles.data ?? []).map((c) => ({ value: c.id, label: c.name }))} required />
      </div>
      {!cycleId && <EmptyState message="Choose a cycle to see its 9-box." />}
      {cycleId && grid.isLoading && <Loading />}
      {cycleId && grid.error && <ErrorBox error={grid.error} />}
      {cycleId && grid.data && grid.data.length === 0 && <EmptyState message="No calibrated ratings for this cycle yet." hint="Close a calibration session first." />}
      {cycleId && grid.data && grid.data.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {NINE_BOX_ROWS.map((rowLabel, row) =>
            NINE_BOX_COLS.map((colLabel, col) => {
              const cellItems = grid.data!.filter((g) => g.row === 2 - row && g.col === col);
              return (
                <div key={`${row}-${col}`} className="min-h-24 rounded border border-ink-800 p-2">
                  <p className="text-2xs text-ink-500">{rowLabel} / {colLabel}</p>
                  <ul className="mt-1 space-y-0.5">
                    {cellItems.map((c) => (
                      <li key={c.employmentRelationshipId} className="text-xs text-ink-200">
                        {byId.get(c.employmentRelationshipId) ?? c.employmentRelationshipId}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            }),
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

interface FeedbackRow {
  id: string;
  fromEmploymentRelationshipId: string;
  toEmploymentRelationshipId: string;
  kind: string;
  message: string;
  visibility: string;
  createdAt: string;
}

function FeedbackTab() {
  const qc = useQueryClient();
  const employments = useEmployments();
  const [open, setOpen] = useState(false);
  const [employmentRelationshipId, setEmploymentRelationshipId] = useState('');
  const [form, setForm] = useState({ fromEmploymentRelationshipId: '', toEmploymentRelationshipId: '', kind: 'praise' as string, message: '', visibility: 'private' as string });

  const feedback = useQuery({
    queryKey: ['performance-feedback', employmentRelationshipId],
    queryFn: () => api.get<FeedbackRow[]>(`/hcm/performance/feedback${employmentRelationshipId ? `?employmentRelationshipId=${employmentRelationshipId}` : ''}`),
  });

  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  return (
    <Card title="Feedback" subtitle="Continuous, outside any cycle." actions={<NewButton label="Give feedback" onClick={() => setOpen(true)} />}>
      <div className="mb-3 max-w-xs">
        {employments.data && <EmploymentSelect label="About" value={employmentRelationshipId} onChange={setEmploymentRelationshipId} options={employments.data} />}
      </div>
      {feedback.isLoading && <Loading />}
      {feedback.error && <ErrorBox error={feedback.error} />}
      {feedback.data && feedback.data.length === 0 && <EmptyState message="No feedback recorded yet." />}
      {feedback.data && feedback.data.length > 0 && (
        <ul className="space-y-2">
          {feedback.data.map((f) => (
            <li key={f.id} className="rounded border border-ink-800 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-300">{byId.get(f.fromEmploymentRelationshipId) ?? f.fromEmploymentRelationshipId} → {byId.get(f.toEmploymentRelationshipId) ?? f.toEmploymentRelationshipId}</span>
                <StatusChip status={f.kind} tone={f.kind === 'praise' ? 'good' : 'warn'} />
              </div>
              <p className="mt-1 text-sm text-ink-200">{f.message}</p>
              <p className="mt-1 text-2xs text-ink-500">{titleCase(f.visibility)} · {date(f.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}

      <CreateModal
        open={open}
        title="Give feedback"
        onClose={() => setOpen(false)}
        invalidate={[['performance-feedback', employmentRelationshipId]]}
        onSubmit={() => api.post('/hcm/performance/feedback', form)}
      >
        {employments.data && (
          <>
            <EmploymentSelect label="From" value={form.fromEmploymentRelationshipId} onChange={(v) => setForm({ ...form, fromEmploymentRelationshipId: v })} options={employments.data} />
            <EmploymentSelect label="To" value={form.toEmploymentRelationshipId} onChange={(v) => setForm({ ...form, toEmploymentRelationshipId: v })} options={employments.data} />
          </>
        )}
        <Row>
          <SelectInput label="Kind" value={form.kind as never} onChange={(v) => setForm({ ...form, kind: v })} options={[{ value: 'praise', label: 'Praise' }, { value: 'constructive', label: 'Constructive' }]} required />
          <SelectInput label="Visibility" value={form.visibility as never} onChange={(v) => setForm({ ...form, visibility: v })} options={[{ value: 'private', label: 'Private' }, { value: 'manager', label: 'Manager' }, { value: 'public', label: 'Public' }]} required />
        </Row>
        <TextArea label="Message" value={form.message} onChange={(v) => setForm({ ...form, message: v })} required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 1:1s
// ---------------------------------------------------------------------------

interface OneOnOne {
  id: string;
  managerEmploymentRelationshipId: string;
  reportEmploymentRelationshipId: string;
  scheduledAt: string;
  status: string;
}

function OneOnOnesTab() {
  const qc = useQueryClient();
  const employments = useEmployments();
  const [open, setOpen] = useState(false);
  const [reportId, setReportId] = useState('');
  const [form, setForm] = useState({ managerEmploymentRelationshipId: '', reportEmploymentRelationshipId: '', scheduledAt: '' });

  const oneOnOnes = useQuery({
    queryKey: ['performance-1on1s', reportId],
    queryFn: () => api.get<OneOnOne[]>(`/hcm/performance/one-on-ones${reportId ? `?employmentRelationshipId=${reportId}` : ''}`),
  });
  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  const complete = useMutation({
    mutationFn: (id: string) => api.patch(`/hcm/performance/one-on-ones/${id}`, { status: 'completed' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['performance-1on1s', reportId] }),
  });

  return (
    <Card title="1:1s" subtitle="Manager/report check-ins." actions={<NewButton label="Schedule" onClick={() => setOpen(true)} />}>
      <div className="mb-3 max-w-xs">
        {employments.data && <EmploymentSelect label="Report" value={reportId} onChange={setReportId} options={employments.data} />}
      </div>
      {oneOnOnes.isLoading && <Loading />}
      {oneOnOnes.error && <ErrorBox error={oneOnOnes.error} />}
      {oneOnOnes.data && oneOnOnes.data.length === 0 && <EmptyState message="No 1:1s scheduled yet." />}
      {oneOnOnes.data && oneOnOnes.data.length > 0 && (
        <table className="table">
          <thead>
            <tr><th>Manager</th><th>Report</th><th>When</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {oneOnOnes.data.map((o) => (
              <tr key={o.id}>
                <td>{byId.get(o.managerEmploymentRelationshipId) ?? o.managerEmploymentRelationshipId}</td>
                <td>{byId.get(o.reportEmploymentRelationshipId) ?? o.reportEmploymentRelationshipId}</td>
                <td>{date(o.scheduledAt)}</td>
                <td><StatusChip status={o.status} tone={o.status === 'completed' ? 'good' : 'neutral'} /></td>
                <td className="text-right">
                  {o.status === 'scheduled' && <button className="btn text-2xs" onClick={() => complete.mutate(o.id)}>Mark completed</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Schedule a 1:1"
        onClose={() => setOpen(false)}
        invalidate={[['performance-1on1s', reportId]]}
        onSubmit={() => api.post('/hcm/performance/one-on-ones', form)}
      >
        {employments.data && (
          <>
            <EmploymentSelect label="Manager" value={form.managerEmploymentRelationshipId} onChange={(v) => setForm({ ...form, managerEmploymentRelationshipId: v })} options={employments.data} />
            <EmploymentSelect label="Report" value={form.reportEmploymentRelationshipId} onChange={(v) => setForm({ ...form, reportEmploymentRelationshipId: v })} options={employments.data} />
          </>
        )}
        <TextInput label="When" type="date" value={form.scheduledAt} onChange={(v) => setForm({ ...form, scheduledAt: v })} required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// PIPs
// ---------------------------------------------------------------------------

interface PipRow {
  id: string;
  employmentRelationshipId: string;
  startsOn: string;
  endsOn: string;
  outcome: string;
}

const PIP_TONE: Record<string, 'neutral' | 'good' | 'bad' | 'warn'> = { open: 'warn', successful: 'good', extended: 'neutral', exited: 'bad' };

function PipsTab() {
  const qc = useQueryClient();
  const employments = useEmployments();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employmentRelationshipId: '', managerEmploymentRelationshipId: '', startsOn: '', endsOn: '', objective: '' });

  const pips = useQuery({ queryKey: ['performance-pips'], queryFn: () => api.get<PipRow[]>('/hcm/performance/pips') });
  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  const close = useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: string }) => api.post(`/hcm/performance/pips/${id}/close`, { outcome }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['performance-pips'] }),
    onError: (e: unknown) => alert(messageOf(e)),
  });

  return (
    <Card title="PIPs" subtitle="Performance Improvement Plans. Closing one needs a decider who is not the person it is about." actions={<NewButton label="Open a PIP" onClick={() => setOpen(true)} />}>
      {pips.isLoading && <Loading />}
      {pips.error && <ErrorBox error={pips.error} />}
      {pips.data && pips.data.length === 0 && <EmptyState message="No PIPs open." hint="A true and reassuring state, not a gap." />}
      {pips.data && pips.data.length > 0 && (
        <table className="table">
          <thead><tr><th>Person</th><th>Window</th><th>Outcome</th><th /></tr></thead>
          <tbody>
            {pips.data.map((p) => (
              <tr key={p.id}>
                <td>{byId.get(p.employmentRelationshipId) ?? p.employmentRelationshipId}</td>
                <td className="text-2xs text-ink-400">{date(p.startsOn)} – {date(p.endsOn)}</td>
                <td><StatusChip status={p.outcome} tone={PIP_TONE[p.outcome]} /></td>
                <td className="text-right">
                  {p.outcome === 'open' && (
                    <div className="flex justify-end gap-1">
                      <button className="btn text-2xs" onClick={() => close.mutate({ id: p.id, outcome: 'successful' })}>Successful</button>
                      <button className="btn text-2xs" onClick={() => close.mutate({ id: p.id, outcome: 'extended' })}>Extend</button>
                      <button className="btn text-2xs" onClick={() => close.mutate({ id: p.id, outcome: 'exited' })}>Exit</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Open a PIP"
        onClose={() => setOpen(false)}
        invalidate={[['performance-pips']]}
        onSubmit={() =>
          api.post('/hcm/performance/pips', {
            employmentRelationshipId: form.employmentRelationshipId,
            managerEmploymentRelationshipId: form.managerEmploymentRelationshipId || undefined,
            startsOn: form.startsOn,
            endsOn: form.endsOn,
            objectives: [{ description: form.objective }],
          })
        }
      >
        {employments.data && (
          <>
            <EmploymentSelect label="Person" value={form.employmentRelationshipId} onChange={(v) => setForm({ ...form, employmentRelationshipId: v })} options={employments.data} />
            <EmploymentSelect label="Manager" value={form.managerEmploymentRelationshipId} onChange={(v) => setForm({ ...form, managerEmploymentRelationshipId: v })} options={employments.data} />
          </>
        )}
        <Row>
          <TextInput label="Starts on" type="date" value={form.startsOn} onChange={(v) => setForm({ ...form, startsOn: v })} required />
          <TextInput label="Ends on" type="date" value={form.endsOn} onChange={(v) => setForm({ ...form, endsOn: v })} required />
        </Row>
        <TextArea label="Objective" value={form.objective} onChange={(v) => setForm({ ...form, objective: v })} required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Succession
// ---------------------------------------------------------------------------

interface SuccessionPlan {
  id: string;
  positionTitle: string;
  successors: Array<{ employmentRelationshipId: string; readiness: string }>;
}

function SuccessionTab() {
  const qc = useQueryClient();
  const employments = useEmployments();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ positionTitle: '', employmentRelationshipId: '', readiness: 'now' as string });

  const plans = useQuery({ queryKey: ['performance-succession'], queryFn: () => api.get<SuccessionPlan[]>('/hcm/performance/succession-plans') });
  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  return (
    <Card title="Succession" subtitle="Who is ready to step into which position, and how soon. Named candidates who have not been told, so this stays HR-only." actions={<NewButton label="New plan" onClick={() => setOpen(true)} />}>
      {plans.isLoading && <Loading />}
      {plans.error && <ErrorBox error={plans.error} />}
      {plans.data && plans.data.length === 0 && <EmptyState message="No succession plans yet." />}
      {plans.data && plans.data.length > 0 && (
        <ul className="space-y-2">
          {plans.data.map((p) => (
            <li key={p.id} className="rounded border border-ink-800 p-3">
              <p className="text-sm font-medium text-ink-100">{p.positionTitle}</p>
              <ul className="mt-1 space-y-0.5">
                {p.successors.map((s, i) => (
                  <li key={i} className="text-xs text-ink-300">
                    {byId.get(s.employmentRelationshipId) ?? s.employmentRelationshipId} — ready {s.readiness}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <CreateModal
        open={open}
        title="New succession plan"
        onClose={() => setOpen(false)}
        invalidate={[['performance-succession']]}
        onSubmit={() =>
          api.post('/hcm/performance/succession-plans', {
            positionTitle: form.positionTitle,
            successors: [{ employmentRelationshipId: form.employmentRelationshipId, readiness: form.readiness }],
          })
        }
      >
        <TextInput label="Position" value={form.positionTitle} onChange={(v) => setForm({ ...form, positionTitle: v })} required />
        {employments.data && <EmploymentSelect label="First successor" value={form.employmentRelationshipId} onChange={(v) => setForm({ ...form, employmentRelationshipId: v })} options={employments.data} />}
        <SelectInput
          label="Readiness"
          value={form.readiness as never}
          onChange={(v) => setForm({ ...form, readiness: v })}
          options={[{ value: 'now', label: 'Ready now' }, { value: '1yr', label: '1 year' }, { value: '2yr', label: '2 years' }]}
          required
        />
      </CreateModal>
    </Card>
  );
}
