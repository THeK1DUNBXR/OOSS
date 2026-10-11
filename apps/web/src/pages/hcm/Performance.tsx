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
import { date, titleCase } from '../../lib/api.js';
import {
  hcmApi,
  type CalibrationDecision,
  type EmploymentOption,
  type OneOnOne,
  type PipRow,
  type ReviewAssignment,
  type ReviewCycle,
} from '../../lib/hcmApi.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';
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

function useEmployments() {
  return useQuery({
    queryKey: ['performance-employments'],
    queryFn: () => hcmApi.hr.employments(),
  });
}

function EmploymentSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: EmploymentOption[];
}) {
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

const PHASE_TONE: Record<string, 'neutral' | 'warn' | 'good'> = {
  self: 'neutral',
  manager: 'neutral',
  calibration: 'warn',
  closed: 'good',
};

const NEXT_PHASE: Record<string, string | null> = {
  self: 'manager',
  manager: 'calibration',
  calibration: 'closed',
  closed: null,
};

function CyclesTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', kind: 'annual' as string, periodLabel: '', startsOn: '', endsOn: '' });

  const cycles = useQuery({
    queryKey: ['performance-cycles'],
    queryFn: () => hcmApi.performance.cycles.list(),
  });

  const advance = useMutation({
    mutationFn: ({ id, phase }: { id: string; phase: string }) => hcmApi.performance.cycles.advance(id, phase),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['performance-cycles'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<ReviewCycle>> = [
    {
      id: 'cycle',
      header: 'Cycle',
      sortValue: (c) => c.name,
      cell: (c) => (
        <>
          {c.name}
          <p className="mono text-2xs text-ink-500">{c.recordCode}</p>
        </>
      ),
    },
    { id: 'kind', header: 'Kind', sortValue: (c) => c.kind, cell: (c) => titleCase(c.kind) },
    { id: 'period', header: 'Period', sortValue: (c) => c.periodLabel, cell: (c) => c.periodLabel },
    {
      id: 'phase',
      header: 'Phase',
      sortValue: (c) => c.phase,
      cell: (c) => <StatusChip status={c.phase} tone={PHASE_TONE[c.phase] ?? 'neutral'} />,
    },
    {
      id: 'dates',
      header: 'Dates',
      sortValue: (c) => c.startsOn,
      cell: (c) => (
        <span className="text-2xs text-ink-400">
          {date(c.startsOn)} – {date(c.endsOn)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (c) =>
        NEXT_PHASE[c.phase] && (
          <button
            className="btn text-2xs"
            disabled={advance.isPending}
            onClick={() => advance.mutate({ id: c.id, phase: NEXT_PHASE[c.phase]! })}
          >
            Advance to {NEXT_PHASE[c.phase]}
          </button>
        ),
    },
  ];

  return (
    <Card
      title="Review cycles"
      subtitle="Each cycle moves self -> manager -> calibration -> closed, one phase at a time. Calibration only opens once every assignment for the cycle has been submitted."
      actions={<NewButton label="New cycle" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Review cycles"
        columns={columns}
        rows={cycles.data ?? []}
        rowKey={(c) => c.id}
        loading={cycles.isLoading}
        error={cycles.error}
        emptyMessage="No review cycles yet."
        emptyHint="Open one to start collecting self and manager reviews."
      />
      {advance.error && <ErrorBox error={advance.error} />}

      <CreateModal
        open={open}
        title="Open a review cycle"
        onClose={() => setOpen(false)}
        invalidate={[['performance-cycles']]}
        onSubmit={() =>
          hcmApi.performance.cycles.create({
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
          <TextInput
            label="Period label"
            value={form.periodLabel}
            onChange={(v) => setForm({ ...form, periodLabel: v })}
            placeholder="FY2026-27"
            required
          />
        </Row>
        <Row>
          <TextInput
            label="Starts on"
            type="date"
            value={form.startsOn}
            onChange={(v) => setForm({ ...form, startsOn: v })}
            required
          />
          <TextInput
            label="Ends on"
            type="date"
            value={form.endsOn}
            onChange={(v) => setForm({ ...form, endsOn: v })}
            required
          />
        </Row>
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

function AssignmentsTab() {
  const [open, setOpen] = useState(false);
  const employments = useEmployments();
  const cycles = useQuery({
    queryKey: ['performance-cycles'],
    queryFn: () => hcmApi.performance.cycles.list(),
  });
  const [form, setForm] = useState({
    cycleId: '',
    employmentRelationshipId: '',
    reviewerEmploymentRelationshipId: '',
    kind: 'manager' as string,
  });

  const assignments = useQuery({
    queryKey: ['performance-assignments', form.cycleId],
    queryFn: () => hcmApi.performance.assignments.list(form.cycleId),
  });

  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  const columns: ReadonlyArray<DataTableColumn<ReviewAssignment>> = [
    {
      id: 'subject',
      header: 'Subject',
      sortValue: (a) => byId.get(a.employmentRelationshipId),
      cell: (a) => byId.get(a.employmentRelationshipId) ?? a.employmentRelationshipId,
    },
    {
      id: 'reviewer',
      header: 'Reviewer',
      sortValue: (a) => byId.get(a.reviewerEmploymentRelationshipId),
      cell: (a) => byId.get(a.reviewerEmploymentRelationshipId) ?? a.reviewerEmploymentRelationshipId,
    },
    { id: 'kind', header: 'Kind', sortValue: (a) => a.kind, cell: (a) => <StatusChip status={a.kind} /> },
    {
      id: 'status',
      header: 'Status',
      sortValue: (a) => a.status,
      cell: (a) => <StatusChip status={a.status} tone={a.status === 'submitted' ? 'good' : 'neutral'} />,
    },
  ];

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
      <DataTable
        caption="Review assignments"
        columns={columns}
        rows={assignments.data ?? []}
        rowKey={(a) => a.id}
        loading={assignments.isLoading}
        error={assignments.error}
        emptyMessage="No review assignments yet."
      />

      <CreateModal
        open={open}
        title="Assign a review"
        onClose={() => setOpen(false)}
        invalidate={[['performance-assignments', form.cycleId]]}
        onSubmit={() =>
          hcmApi.performance.assignments.create({
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
            <EmploymentSelect
              label="Subject"
              value={form.employmentRelationshipId}
              onChange={(v) => setForm({ ...form, employmentRelationshipId: v })}
              options={employments.data}
            />
            <EmploymentSelect
              label="Reviewer"
              value={form.reviewerEmploymentRelationshipId}
              onChange={(v) => setForm({ ...form, reviewerEmploymentRelationshipId: v })}
              options={employments.data}
            />
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

function CalibrationTab() {
  const qc = useQueryClient();
  const employments = useEmployments();
  const cycles = useQuery({
    queryKey: ['performance-cycles'],
    queryFn: () => hcmApi.performance.cycles.list(),
  });
  const [cycleId, setCycleId] = useState('');
  const [openForm, setOpenForm] = useState(false);
  const [participantId, setParticipantId] = useState('');
  const [decisionEmp, setDecisionEmp] = useState('');
  const [decisionForm, setDecisionForm] = useState({
    rating: '3',
    potential: 'medium' as string,
    promotionRecommended: false,
  });

  const sessions = useQuery({
    queryKey: ['performance-calibrations', cycleId],
    queryFn: () => hcmApi.performance.calibrations.list(cycleId),
  });

  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  const openSession = useMutation({
    mutationFn: () =>
      hcmApi.performance.calibrations.open({
        cycleId,
        participants: [{ employmentRelationshipId: participantId }],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['performance-calibrations', cycleId] });
      setOpenForm(false);
    },
  });

  const recordDecision = useMutation({
    mutationFn: (sessionId: string) =>
      hcmApi.performance.calibrations.recordDecisions(sessionId, [
        {
          employmentRelationshipId: decisionEmp,
          rating: decisionForm.rating,
          potential: decisionForm.potential,
          promotionRecommended: decisionForm.promotionRecommended,
        },
      ]),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['performance-calibrations', cycleId] }),
  });

  const close = useMutation({
    mutationFn: (id: string) => hcmApi.performance.calibrations.close(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['performance-calibrations', cycleId] }),
  });

  const decisionColumns: ReadonlyArray<DataTableColumn<CalibrationDecision>> = [
    {
      id: 'person',
      header: 'Person',
      sortValue: (d) => byId.get(d.employmentRelationshipId),
      cell: (d) => byId.get(d.employmentRelationshipId) ?? d.employmentRelationshipId,
    },
    { id: 'rating', header: 'Rating', sortValue: (d) => d.rating, cell: (d) => d.rating },
    { id: 'potential', header: 'Potential', sortValue: (d) => d.potential, cell: (d) => titleCase(d.potential) },
    {
      id: 'promotion',
      header: 'Promotion',
      sortValue: (d) => d.promotionRecommended ?? false,
      cell: (d) => (d.promotionRecommended ? 'Yes' : '—'),
    },
  ];

  return (
    <Card
      title="Calibration"
      subtitle="Opens once a cycle reaches the calibration phase. Closing a session snapshots each decision into that person's final rating — nothing is visible to them until it is individually released."
      actions={<NewButton label="Open session" onClick={() => setOpenForm(true)} />}
    >
      <div className="mb-3 max-w-xs">
        <SelectInput
          label="Cycle"
          value={cycleId as never}
          onChange={setCycleId}
          placeholder="Choose a cycle…"
          options={(cycles.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
        />
      </div>

      {sessions.isLoading && <Loading />}
      {sessions.error && <ErrorBox error={sessions.error} />}
      {sessions.data && sessions.data.length === 0 && (
        <EmptyState message="No calibration sessions for this cycle yet." />
      )}
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
            <DataTable
              caption="Calibration decisions for this session"
              columns={decisionColumns}
              rows={s.decisions}
              rowKey={(d) => d.employmentRelationshipId}
              emptyMessage="No decisions recorded."
            />
          )}
          {s.status === 'open' && employments.data && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <EmploymentSelect
                label="Person"
                value={decisionEmp}
                onChange={setDecisionEmp}
                options={employments.data}
              />
              <SelectInput
                label="Rating"
                value={decisionForm.rating as never}
                onChange={(v) => setDecisionForm({ ...decisionForm, rating: v })}
                options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v }))}
                required
              />
              <SelectInput
                label="Potential"
                value={decisionForm.potential as never}
                onChange={(v) => setDecisionForm({ ...decisionForm, potential: v })}
                options={[
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'high', label: 'High' },
                ]}
                required
              />
              <button
                className="btn"
                disabled={!decisionEmp || recordDecision.isPending}
                onClick={() => recordDecision.mutate(s.id)}
              >
                Record decision
              </button>
            </div>
          )}
        </div>
      ))}
      {(openSession.error || recordDecision.error || close.error) && (
        <ErrorBox error={openSession.error ?? recordDecision.error ?? close.error} />
      )}

      <CreateModal
        open={openForm}
        title="Open a calibration session"
        onClose={() => setOpenForm(false)}
        invalidate={[['performance-calibrations', cycleId]]}
        onSubmit={() => openSession.mutateAsync()}
      >
        <SelectInput
          label="Cycle"
          value={cycleId as never}
          onChange={setCycleId}
          placeholder="Choose a cycle…"
          options={(cycles.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          required
        />
        {employments.data && (
          <EmploymentSelect
            label="First participant"
            value={participantId}
            onChange={setParticipantId}
            options={employments.data}
          />
        )}
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 9-box
// ---------------------------------------------------------------------------

const NINE_BOX_ROWS = ['High potential', 'Medium potential', 'Low potential'];
const NINE_BOX_COLS = ['Low performance', 'Medium performance', 'High performance'];

function NineBoxTab() {
  const employments = useEmployments();
  const cycles = useQuery({
    queryKey: ['performance-cycles'],
    queryFn: () => hcmApi.performance.cycles.list(),
  });
  const [cycleId, setCycleId] = useState('');

  const grid = useQuery({
    queryKey: ['performance-ninebox', cycleId],
    queryFn: () => hcmApi.performance.nineBox(cycleId),
    enabled: !!cycleId,
  });

  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  return (
    <Card
      title="9-box"
      subtitle="Every rated employee at once — needs an all-scope grant on reviews, so this is an HR view rather than a manager one."
    >
      <div className="mb-3 max-w-xs">
        <SelectInput
          label="Cycle"
          value={cycleId as never}
          onChange={setCycleId}
          placeholder="Choose a cycle…"
          options={(cycles.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          required
        />
      </div>
      {!cycleId && <EmptyState message="Choose a cycle to see its 9-box." />}
      {cycleId && grid.isLoading && <Loading />}
      {cycleId && grid.error && <ErrorBox error={grid.error} />}
      {cycleId && grid.data && grid.data.length === 0 && (
        <EmptyState message="No calibrated ratings for this cycle yet." hint="Close a calibration session first." />
      )}
      {cycleId && grid.data && grid.data.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {NINE_BOX_ROWS.map((rowLabel, row) =>
            NINE_BOX_COLS.map((colLabel, col) => {
              const cellItems = grid.data!.filter((g) => g.row === 2 - row && g.col === col);
              return (
                <div key={`${row}-${col}`} className="min-h-24 rounded border border-ink-800 p-2">
                  <p className="text-2xs text-ink-500">
                    {rowLabel} / {colLabel}
                  </p>
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

function FeedbackTab() {
  const employments = useEmployments();
  const [open, setOpen] = useState(false);
  const [employmentRelationshipId, setEmploymentRelationshipId] = useState('');
  const [form, setForm] = useState({
    fromEmploymentRelationshipId: '',
    toEmploymentRelationshipId: '',
    kind: 'praise' as string,
    message: '',
    visibility: 'private' as string,
  });

  const feedback = useQuery({
    queryKey: ['performance-feedback', employmentRelationshipId],
    queryFn: () => hcmApi.performance.feedback.list(employmentRelationshipId),
  });

  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  return (
    <Card
      title="Feedback"
      subtitle="Continuous, outside any cycle."
      actions={<NewButton label="Give feedback" onClick={() => setOpen(true)} />}
    >
      <div className="mb-3 max-w-xs">
        {employments.data && (
          <EmploymentSelect
            label="About"
            value={employmentRelationshipId}
            onChange={setEmploymentRelationshipId}
            options={employments.data}
          />
        )}
      </div>
      {feedback.isLoading && <Loading />}
      {feedback.error && <ErrorBox error={feedback.error} />}
      {feedback.data && feedback.data.length === 0 && <EmptyState message="No feedback recorded yet." />}
      {feedback.data && feedback.data.length > 0 && (
        <ul className="space-y-2">
          {feedback.data.map((f) => (
            <li key={f.id} className="rounded border border-ink-800 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-300">
                  {byId.get(f.fromEmploymentRelationshipId) ?? f.fromEmploymentRelationshipId} →{' '}
                  {byId.get(f.toEmploymentRelationshipId) ?? f.toEmploymentRelationshipId}
                </span>
                <StatusChip status={f.kind} tone={f.kind === 'praise' ? 'good' : 'warn'} />
              </div>
              <p className="mt-1 text-sm text-ink-200">{f.message}</p>
              <p className="mt-1 text-2xs text-ink-500">
                {titleCase(f.visibility)} · {date(f.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}

      <CreateModal
        open={open}
        title="Give feedback"
        onClose={() => setOpen(false)}
        invalidate={[['performance-feedback', employmentRelationshipId]]}
        onSubmit={() => hcmApi.performance.feedback.give(form)}
      >
        {employments.data && (
          <>
            <EmploymentSelect
              label="From"
              value={form.fromEmploymentRelationshipId}
              onChange={(v) => setForm({ ...form, fromEmploymentRelationshipId: v })}
              options={employments.data}
            />
            <EmploymentSelect
              label="To"
              value={form.toEmploymentRelationshipId}
              onChange={(v) => setForm({ ...form, toEmploymentRelationshipId: v })}
              options={employments.data}
            />
          </>
        )}
        <Row>
          <SelectInput
            label="Kind"
            value={form.kind as never}
            onChange={(v) => setForm({ ...form, kind: v })}
            options={[
              { value: 'praise', label: 'Praise' },
              { value: 'constructive', label: 'Constructive' },
            ]}
            required
          />
          <SelectInput
            label="Visibility"
            value={form.visibility as never}
            onChange={(v) => setForm({ ...form, visibility: v })}
            options={[
              { value: 'private', label: 'Private' },
              { value: 'manager', label: 'Manager' },
              { value: 'public', label: 'Public' },
            ]}
            required
          />
        </Row>
        <TextArea label="Message" value={form.message} onChange={(v) => setForm({ ...form, message: v })} required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 1:1s
// ---------------------------------------------------------------------------

function OneOnOnesTab() {
  const qc = useQueryClient();
  const employments = useEmployments();
  const [open, setOpen] = useState(false);
  const [reportId, setReportId] = useState('');
  const [form, setForm] = useState({
    managerEmploymentRelationshipId: '',
    reportEmploymentRelationshipId: '',
    scheduledAt: '',
  });

  const oneOnOnes = useQuery({
    queryKey: ['performance-1on1s', reportId],
    queryFn: () => hcmApi.performance.oneOnOnes.list(reportId),
  });
  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  const complete = useMutation({
    mutationFn: (id: string) => hcmApi.performance.oneOnOnes.complete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['performance-1on1s', reportId] }),
  });

  const columns: ReadonlyArray<DataTableColumn<OneOnOne>> = [
    {
      id: 'manager',
      header: 'Manager',
      sortValue: (o) => byId.get(o.managerEmploymentRelationshipId),
      cell: (o) => byId.get(o.managerEmploymentRelationshipId) ?? o.managerEmploymentRelationshipId,
    },
    {
      id: 'report',
      header: 'Report',
      sortValue: (o) => byId.get(o.reportEmploymentRelationshipId),
      cell: (o) => byId.get(o.reportEmploymentRelationshipId) ?? o.reportEmploymentRelationshipId,
    },
    { id: 'when', header: 'When', sortValue: (o) => o.scheduledAt, cell: (o) => date(o.scheduledAt) },
    {
      id: 'status',
      header: 'Status',
      sortValue: (o) => o.status,
      cell: (o) => <StatusChip status={o.status} tone={o.status === 'completed' ? 'good' : 'neutral'} />,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (o) =>
        o.status === 'scheduled' && (
          <button className="btn text-2xs" onClick={() => complete.mutate(o.id)}>
            Mark completed
          </button>
        ),
    },
  ];

  return (
    <Card
      title="1:1s"
      subtitle="Manager/report check-ins."
      actions={<NewButton label="Schedule" onClick={() => setOpen(true)} />}
    >
      <div className="mb-3 max-w-xs">
        {employments.data && (
          <EmploymentSelect label="Report" value={reportId} onChange={setReportId} options={employments.data} />
        )}
      </div>
      <DataTable
        caption="One-on-one meetings"
        columns={columns}
        rows={oneOnOnes.data ?? []}
        rowKey={(o) => o.id}
        loading={oneOnOnes.isLoading}
        error={oneOnOnes.error}
        emptyMessage="No one-on-ones scheduled."
      />

      <CreateModal
        open={open}
        title="Schedule a 1:1"
        onClose={() => setOpen(false)}
        invalidate={[['performance-1on1s', reportId]]}
        onSubmit={() => hcmApi.performance.oneOnOnes.schedule(form)}
      >
        {employments.data && (
          <>
            <EmploymentSelect
              label="Manager"
              value={form.managerEmploymentRelationshipId}
              onChange={(v) => setForm({ ...form, managerEmploymentRelationshipId: v })}
              options={employments.data}
            />
            <EmploymentSelect
              label="Report"
              value={form.reportEmploymentRelationshipId}
              onChange={(v) => setForm({ ...form, reportEmploymentRelationshipId: v })}
              options={employments.data}
            />
          </>
        )}
        <TextInput
          label="When"
          type="date"
          value={form.scheduledAt}
          onChange={(v) => setForm({ ...form, scheduledAt: v })}
          required
        />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// PIPs
// ---------------------------------------------------------------------------

const PIP_TONE: Record<string, 'neutral' | 'good' | 'bad' | 'warn'> = {
  open: 'warn',
  successful: 'good',
  extended: 'neutral',
  exited: 'bad',
};

function PipsTab() {
  const qc = useQueryClient();
  const employments = useEmployments();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    employmentRelationshipId: '',
    managerEmploymentRelationshipId: '',
    startsOn: '',
    endsOn: '',
    objective: '',
  });

  const pips = useQuery({ queryKey: ['performance-pips'], queryFn: () => hcmApi.performance.pips.list() });
  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  const close = useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: string }) => hcmApi.performance.pips.close(id, outcome),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['performance-pips'] }),
    onError: (e: unknown) => alert(messageOf(e)),
  });

  const columns: ReadonlyArray<DataTableColumn<PipRow>> = [
    {
      id: 'person',
      header: 'Person',
      sortValue: (p) => byId.get(p.employmentRelationshipId),
      cell: (p) => byId.get(p.employmentRelationshipId) ?? p.employmentRelationshipId,
    },
    {
      id: 'window',
      header: 'Window',
      sortValue: (p) => p.startsOn,
      cell: (p) => (
        <span className="text-2xs text-ink-400">
          {date(p.startsOn)} – {date(p.endsOn)}
        </span>
      ),
    },
    {
      id: 'outcome',
      header: 'Outcome',
      sortValue: (p) => p.outcome,
      cell: (p) => <StatusChip status={p.outcome} tone={PIP_TONE[p.outcome]} />,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (p) =>
        p.outcome === 'open' && (
          <div className="flex justify-end gap-1">
            <button className="btn text-2xs" onClick={() => close.mutate({ id: p.id, outcome: 'successful' })}>
              Successful
            </button>
            <button className="btn text-2xs" onClick={() => close.mutate({ id: p.id, outcome: 'extended' })}>
              Extend
            </button>
            <button className="btn text-2xs" onClick={() => close.mutate({ id: p.id, outcome: 'exited' })}>
              Exit
            </button>
          </div>
        ),
    },
  ];

  return (
    <Card
      title="PIPs"
      subtitle="Performance Improvement Plans. Closing one needs a decider who is not the person it is about."
      actions={<NewButton label="Open a PIP" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Performance improvement plans"
        columns={columns}
        rows={pips.data ?? []}
        rowKey={(p) => p.id}
        loading={pips.isLoading}
        error={pips.error}
        emptyMessage="No PIPs open."
        emptyHint="A true and reassuring state, not a gap."
      />

      <CreateModal
        open={open}
        title="Open a PIP"
        onClose={() => setOpen(false)}
        invalidate={[['performance-pips']]}
        onSubmit={() =>
          hcmApi.performance.pips.open({
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
            <EmploymentSelect
              label="Person"
              value={form.employmentRelationshipId}
              onChange={(v) => setForm({ ...form, employmentRelationshipId: v })}
              options={employments.data}
            />
            <EmploymentSelect
              label="Manager"
              value={form.managerEmploymentRelationshipId}
              onChange={(v) => setForm({ ...form, managerEmploymentRelationshipId: v })}
              options={employments.data}
            />
          </>
        )}
        <Row>
          <TextInput
            label="Starts on"
            type="date"
            value={form.startsOn}
            onChange={(v) => setForm({ ...form, startsOn: v })}
            required
          />
          <TextInput
            label="Ends on"
            type="date"
            value={form.endsOn}
            onChange={(v) => setForm({ ...form, endsOn: v })}
            required
          />
        </Row>
        <TextArea
          label="Objective"
          value={form.objective}
          onChange={(v) => setForm({ ...form, objective: v })}
          required
        />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Succession
// ---------------------------------------------------------------------------

function SuccessionTab() {
  const employments = useEmployments();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ positionTitle: '', employmentRelationshipId: '', readiness: 'now' as string });

  const plans = useQuery({
    queryKey: ['performance-succession'],
    queryFn: () => hcmApi.performance.succession.list(),
  });
  const byId = new Map((employments.data ?? []).map((e) => [e.id, e.person.fullName]));

  return (
    <Card
      title="Succession"
      subtitle="Who is ready to step into which position, and how soon. Named candidates who have not been told, so this stays HR-only."
      actions={<NewButton label="New plan" onClick={() => setOpen(true)} />}
    >
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
          hcmApi.performance.succession.create({
            positionTitle: form.positionTitle,
            successors: [{ employmentRelationshipId: form.employmentRelationshipId, readiness: form.readiness }],
          })
        }
      >
        <TextInput
          label="Position"
          value={form.positionTitle}
          onChange={(v) => setForm({ ...form, positionTitle: v })}
          required
        />
        {employments.data && (
          <EmploymentSelect
            label="First successor"
            value={form.employmentRelationshipId}
            onChange={(v) => setForm({ ...form, employmentRelationshipId: v })}
            options={employments.data}
          />
        )}
        <SelectInput
          label="Readiness"
          value={form.readiness as never}
          onChange={(v) => setForm({ ...form, readiness: v })}
          options={[
            { value: 'now', label: 'Ready now' },
            { value: '1yr', label: '1 year' },
            { value: '2yr', label: '2 years' },
          ]}
          required
        />
      </CreateModal>
    </Card>
  );
}
