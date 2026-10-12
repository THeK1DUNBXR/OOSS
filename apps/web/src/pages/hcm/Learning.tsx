/**
 * Learning — WS6 learning (docs/hcm/learning.md).
 *
 * Tabs: Programs (the catalogue), Sessions (scheduled runs), Enrollments
 * (nominate → approve → attend → complete), Certifications (issued and
 * directly-entered, with the expiry ladder), Mandatory (who owes what and by
 * when), IDPs, and Budget (utilisation against completed spend).
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { date, money } from '../../lib/api.js';
import {
  decimalAmount,
  hcmApi,
  type IndividualDevelopmentPlan,
  type MandatoryTrainingRow,
  type MandatoryTrainingRule,
  type TrainingBudget,
  type TrainingCertification,
  type TrainingEnrollment,
  type TrainingProgram,
  type TrainingSession,
} from '../../lib/hcmApi.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';
import { Card, PageHeader, StatusChip, Tabs, Metric } from '../../components/ui.js';
import {
  CreateModal,
  messageOf,
  MoneyInput,
  NewButton,
  Row,
  SelectInput,
  TextArea,
  TextInput,
} from '../../components/forms.js';

type Tab = 'programs' | 'sessions' | 'enrollments' | 'certifications' | 'mandatory' | 'idps' | 'budget';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'programs', label: 'Programs' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'enrollments', label: 'Enrollments' },
  { key: 'certifications', label: 'Certifications' },
  { key: 'mandatory', label: 'Mandatory' },
  { key: 'idps', label: 'IDPs' },
  { key: 'budget', label: 'Budget' },
];

export function Learning() {
  const [tab, setTab] = useState<Tab>('programs');

  return (
    <>
      <PageHeader
        title="Learning"
        subtitle="The training catalogue, who is booked into what, certifications and their expiry, mandatory-training compliance, development plans and the training budget."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'programs' && <ProgramsTab />}
      {tab === 'sessions' && <SessionsTab />}
      {tab === 'enrollments' && <EnrollmentsTab />}
      {tab === 'certifications' && <CertificationsTab />}
      {tab === 'mandatory' && <MandatoryTab />}
      {tab === 'idps' && <IdpsTab />}
      {tab === 'budget' && <BudgetTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

function ProgramsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: '',
    kind: 'classroom' as 'classroom' | 'online' | 'certification' | 'mandatory',
    provider: '',
    cost: '0',
    validityMonths: '',
  });

  const programs = useQuery({
    queryKey: ['learning-programs'],
    queryFn: () => hcmApi.learning.programs.list(),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      hcmApi.learning.programs.setActive(id, isActive),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-programs'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<TrainingProgram>> = [
    { id: 'title', header: 'Title', sortValue: (p) => p.title, cell: (p) => p.title },
    { id: 'kind', header: 'Kind', sortValue: (p) => p.kind, cell: (p) => <StatusChip status={p.kind} /> },
    { id: 'provider', header: 'Provider', sortValue: (p) => p.provider, cell: (p) => p.provider ?? '—' },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      sortValue: (p) => decimalAmount(p.cost),
      cell: (p) => money(decimalAmount(p.cost)),
    },
    {
      id: 'validity',
      header: 'Validity',
      sortValue: (p) => p.validityMonths,
      cell: (p) => (p.validityMonths ? `${p.validityMonths} months` : '—'),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (p) => p.isActive,
      cell: (p) => <StatusChip status={p.isActive ? 'active' : 'inactive'} tone={p.isActive ? 'good' : 'neutral'} />,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (p) => (
        <button className="btn text-2xs" onClick={() => toggleActive.mutate({ id: p.id, isActive: !p.isActive })}>
          {p.isActive ? 'Deactivate' : 'Activate'}
        </button>
      ),
    },
  ];

  return (
    <Card
      title="Training programs"
      subtitle="Classroom, online, certification and mandatory courses the company runs or sponsors."
      actions={<NewButton label="Add program" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Training programs"
        columns={columns}
        rows={programs.data ?? []}
        rowKey={(p) => p.id}
        loading={programs.isLoading}
        error={programs.error}
        emptyMessage="No training programs yet."
        emptyHint="Add one to start scheduling sessions against it."
      />

      <CreateModal
        open={open}
        title="Add a training program"
        onClose={() => setOpen(false)}
        invalidate={[['learning-programs']]}
        onSubmit={() =>
          hcmApi.learning.programs.create({
            title: form.title,
            kind: form.kind,
            provider: form.provider || undefined,
            cost: Number(form.cost) || 0,
            validityMonths: form.validityMonths ? Number(form.validityMonths) : undefined,
          })
        }
      >
        <TextInput
          label="Title"
          value={form.title}
          onChange={(v) => setForm({ ...form, title: v })}
          required
          autoFocus
        />
        <Row>
          <SelectInput
            label="Kind"
            value={form.kind}
            onChange={(v) => setForm({ ...form, kind: v })}
            options={[
              { value: 'classroom', label: 'Classroom' },
              { value: 'online', label: 'Online' },
              { value: 'certification', label: 'Certification' },
              { value: 'mandatory', label: 'Mandatory' },
            ]}
          />
          <TextInput label="Provider" value={form.provider} onChange={(v) => setForm({ ...form, provider: v })} />
        </Row>
        <Row>
          <MoneyInput label="Cost" value={form.cost} onChange={(v) => setForm({ ...form, cost: v })} />
          <TextInput
            label="Validity (months)"
            type="number"
            value={form.validityMonths}
            onChange={(v) => setForm({ ...form, validityMonths: v })}
            hint="Leave blank if it never expires"
          />
        </Row>
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function SessionsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ programId: '', startsAt: '', endsAt: '', trainer: '', seats: '20', location: '' });

  const programs = useQuery({
    queryKey: ['learning-programs'],
    queryFn: () => hcmApi.learning.programs.list(),
  });
  const sessions = useQuery({
    queryKey: ['learning-sessions'],
    queryFn: () => hcmApi.learning.sessions.list(),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'completed' | 'cancelled' }) =>
      hcmApi.learning.sessions.setStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-sessions'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<TrainingSession>> = [
    { id: 'program', header: 'Program', sortValue: (r) => r.program.title, cell: (r) => r.program.title },
    { id: 'starts', header: 'Starts', sortValue: (r) => r.startsAt, cell: (r) => date(r.startsAt) },
    { id: 'trainer', header: 'Trainer', sortValue: (r) => r.trainer, cell: (r) => r.trainer ?? '—' },
    { id: 'seats', header: 'Seats', align: 'right', sortValue: (r) => r.seats, cell: (r) => r.seats },
    { id: 'location', header: 'Location', sortValue: (r) => r.location, cell: (r) => r.location ?? '—' },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => (
        <StatusChip
          status={r.status}
          tone={r.status === 'completed' ? 'good' : r.status === 'cancelled' ? 'bad' : 'neutral'}
        />
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) =>
        r.status === 'scheduled' && (
          <button className="btn text-2xs" onClick={() => setStatus.mutate({ id: r.id, status: 'completed' })}>
            Mark completed
          </button>
        ),
    },
  ];

  return (
    <Card
      title="Sessions"
      subtitle="A scheduled running of a program — a batch, a cohort, a booked slot."
      actions={<NewButton label="Schedule session" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Training sessions"
        columns={columns}
        rows={sessions.data ?? []}
        rowKey={(r) => r.id}
        loading={sessions.isLoading}
        error={sessions.error}
        emptyMessage="No sessions scheduled yet."
        emptyHint="Add a program first, then schedule a session against it."
      />

      <CreateModal
        open={open}
        title="Schedule a session"
        onClose={() => setOpen(false)}
        invalidate={[['learning-sessions']]}
        onSubmit={() =>
          hcmApi.learning.sessions.create({
            programId: form.programId,
            startsAt: form.startsAt,
            endsAt: form.endsAt,
            trainer: form.trainer || undefined,
            seats: Number(form.seats) || 0,
            location: form.location || undefined,
          })
        }
      >
        <SelectInput
          label="Program"
          value={form.programId}
          onChange={(v) => setForm({ ...form, programId: v })}
          placeholder="Choose a program"
          options={(programs.data ?? []).map((p) => ({ value: p.id, label: p.title }))}
          required
        />
        <Row>
          <TextInput
            label="Starts"
            type="date"
            value={form.startsAt}
            onChange={(v) => setForm({ ...form, startsAt: v })}
            required
          />
          <TextInput
            label="Ends"
            type="date"
            value={form.endsAt}
            onChange={(v) => setForm({ ...form, endsAt: v })}
            required
          />
        </Row>
        <Row>
          <TextInput label="Trainer" value={form.trainer} onChange={(v) => setForm({ ...form, trainer: v })} />
          <TextInput label="Seats" type="number" value={form.seats} onChange={(v) => setForm({ ...form, seats: v })} />
        </Row>
        <TextInput label="Location / link" value={form.location} onChange={(v) => setForm({ ...form, location: v })} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Enrollments
// ---------------------------------------------------------------------------

function EnrollmentsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ sessionId: '', employmentRelationshipId: '' });

  const sessions = useQuery({
    queryKey: ['learning-sessions'],
    queryFn: () => hcmApi.learning.sessions.list(),
  });
  const employees = useQuery({ queryKey: ['learning-employees'], queryFn: () => hcmApi.hr.employees() });
  const enrollments = useQuery({
    queryKey: ['learning-enrollments'],
    queryFn: () => hcmApi.learning.enrollments.list(),
  });

  const nameFor = (id: string) => employees.data?.find((e) => e.id === id)?.fullName ?? id;

  const approve = useMutation({
    mutationFn: (id: string) => hcmApi.learning.enrollments.approve(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-enrollments'] }),
  });
  const reject = useMutation({
    mutationFn: (id: string) => hcmApi.learning.enrollments.reject(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-enrollments'] }),
  });
  const attend = useMutation({
    mutationFn: ({ id, attended }: { id: string; attended: boolean }) =>
      hcmApi.learning.enrollments.attend(id, attended),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-enrollments'] }),
  });
  const complete = useMutation({
    mutationFn: (id: string) => hcmApi.learning.enrollments.complete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['learning-enrollments'] });
      qc.invalidateQueries({ queryKey: ['learning-certifications'] });
    },
  });

  const columns: ReadonlyArray<DataTableColumn<TrainingEnrollment>> = [
    {
      id: 'employee',
      header: 'Employee',
      sortValue: (e) => nameFor(e.employmentRelationshipId),
      cell: (e) => nameFor(e.employmentRelationshipId),
    },
    {
      id: 'program',
      header: 'Program',
      sortValue: (e) => e.session.program.title,
      cell: (e) => e.session.program.title,
    },
    { id: 'session', header: 'Session', sortValue: (e) => e.session.startsAt, cell: (e) => date(e.session.startsAt) },
    {
      id: 'status',
      header: 'Status',
      sortValue: (e) => e.status,
      cell: (e) => (
        <StatusChip
          status={e.status}
          tone={
            e.status === 'completed' ? 'good' : e.status === 'rejected' || e.status === 'no_show' ? 'bad' : 'neutral'
          }
        />
      ),
    },
    { id: 'score', header: 'Score', align: 'right', sortValue: (e) => e.score, cell: (e) => e.score ?? '—' },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (e) => (
        <div className="flex justify-end gap-2">
          {e.status === 'nominated' && (
            <>
              <button className="btn text-2xs" onClick={() => approve.mutate(e.id)}>
                Approve
              </button>
              <button className="btn text-2xs" onClick={() => reject.mutate(e.id)}>
                Reject
              </button>
            </>
          )}
          {e.status === 'approved' && (
            <>
              <button className="btn text-2xs" onClick={() => attend.mutate({ id: e.id, attended: true })}>
                Attended
              </button>
              <button className="btn text-2xs" onClick={() => attend.mutate({ id: e.id, attended: false })}>
                No-show
              </button>
            </>
          )}
          {e.status === 'attended' && (
            <button className="btn-primary text-2xs" onClick={() => complete.mutate(e.id)}>
              Complete
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <Card
      title="Enrollments"
      subtitle="Nominated → approved → attended → completed. Approving your own nomination is refused."
      actions={<NewButton label="Nominate" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Training enrollments"
        columns={columns}
        rows={enrollments.data ?? []}
        rowKey={(e) => e.id}
        loading={enrollments.isLoading}
        error={enrollments.error}
        emptyMessage="No enrollments yet."
      />
      {(approve.error || reject.error || attend.error || complete.error) && (
        <p className="mt-2 text-2xs text-band-critical">
          {messageOf(approve.error ?? reject.error ?? attend.error ?? complete.error)}
        </p>
      )}

      <CreateModal
        open={open}
        title="Nominate someone for a session"
        submitLabel="Nominate"
        onClose={() => setOpen(false)}
        invalidate={[['learning-enrollments']]}
        onSubmit={() => hcmApi.learning.enrollments.nominate(form)}
      >
        <SelectInput
          label="Session"
          value={form.sessionId}
          onChange={(v) => setForm({ ...form, sessionId: v })}
          placeholder="Choose a session"
          options={(sessions.data ?? []).map((s) => ({
            value: s.id,
            label: `${s.program.title} — ${date(s.startsAt)}`,
          }))}
          required
        />
        <SelectInput
          label="Employee"
          value={form.employmentRelationshipId}
          onChange={(v) => setForm({ ...form, employmentRelationshipId: v })}
          placeholder="Choose an employee"
          options={(employees.data ?? []).map((e) => ({ value: e.id, label: e.fullName }))}
          required
        />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Certifications
// ---------------------------------------------------------------------------

function CertificationsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employmentRelationshipId: '', name: '', issuer: '', issuedOn: '', expiresOn: '' });

  const employees = useQuery({ queryKey: ['learning-employees'], queryFn: () => hcmApi.hr.employees() });
  const certs = useQuery({
    queryKey: ['learning-certifications'],
    queryFn: () => hcmApi.learning.certifications.list(),
  });
  const nameFor = (id: string) => employees.data?.find((e) => e.id === id)?.fullName ?? id;

  const verify = useMutation({
    mutationFn: (id: string) => hcmApi.learning.certifications.verify(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-certifications'] }),
  });
  const runExpiryCheck = useMutation({
    mutationFn: () => hcmApi.learning.certifications.runExpiryCheck(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-certifications'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<TrainingCertification>> = [
    {
      id: 'code',
      header: 'Code',
      sortValue: (c) => c.recordCode,
      cell: (c) => <span className="mono">{c.recordCode}</span>,
    },
    {
      id: 'employee',
      header: 'Employee',
      sortValue: (c) => nameFor(c.employmentRelationshipId),
      cell: (c) => nameFor(c.employmentRelationshipId),
    },
    { id: 'name', header: 'Name', sortValue: (c) => c.name, cell: (c) => c.name },
    { id: 'issued', header: 'Issued', sortValue: (c) => c.issuedOn, cell: (c) => date(c.issuedOn) },
    {
      id: 'expires',
      header: 'Expires',
      sortValue: (c) => c.expiresOn,
      cell: (c) => (c.expiresOn ? date(c.expiresOn) : 'Never'),
    },
    {
      id: 'verified',
      header: 'Verified',
      sortValue: (c) => c.verified,
      cell: (c) => (
        <StatusChip status={c.verified ? 'verified' : 'unverified'} tone={c.verified ? 'good' : 'neutral'} />
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (c) =>
        !c.verified && (
          <button className="btn text-2xs" onClick={() => verify.mutate(c.id)}>
            Verify
          </button>
        ),
    },
  ];

  return (
    <Card
      title="Certifications"
      subtitle="Issued by completing a certification-kind program, or entered directly. Never self-verified."
      actions={
        <>
          <button className="btn text-2xs" onClick={() => runExpiryCheck.mutate()} disabled={runExpiryCheck.isPending}>
            {runExpiryCheck.isPending ? 'Checking…' : 'Run expiry check'}
          </button>
          <NewButton label="Add certification" onClick={() => setOpen(true)} />
        </>
      }
    >
      <DataTable
        caption="Certifications on file"
        columns={columns}
        rows={certs.data ?? []}
        rowKey={(c) => c.id}
        loading={certs.isLoading}
        error={certs.error}
        emptyMessage="No certifications on file yet."
      />
      {verify.error && <p className="mt-2 text-2xs text-band-critical">{messageOf(verify.error)}</p>}

      <CreateModal
        open={open}
        title="Add a certification"
        onClose={() => setOpen(false)}
        invalidate={[['learning-certifications']]}
        onSubmit={() =>
          hcmApi.learning.certifications.create({
            employmentRelationshipId: form.employmentRelationshipId,
            name: form.name,
            issuer: form.issuer || undefined,
            issuedOn: form.issuedOn,
            expiresOn: form.expiresOn || undefined,
          })
        }
      >
        <SelectInput
          label="Employee"
          value={form.employmentRelationshipId}
          onChange={(v) => setForm({ ...form, employmentRelationshipId: v })}
          placeholder="Choose an employee"
          options={(employees.data ?? []).map((e) => ({ value: e.id, label: e.fullName }))}
          required
        />
        <TextInput label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <Row>
          <TextInput label="Issuer" value={form.issuer} onChange={(v) => setForm({ ...form, issuer: v })} />
          <TextInput
            label="Issued on"
            type="date"
            value={form.issuedOn}
            onChange={(v) => setForm({ ...form, issuedOn: v })}
            required
          />
        </Row>
        <TextInput
          label="Expires on"
          type="date"
          value={form.expiresOn}
          onChange={(v) => setForm({ ...form, expiresOn: v })}
          hint="Leave blank if it never expires"
        />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Mandatory training
// ---------------------------------------------------------------------------

function MandatoryTab() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ programId: '', dueWithinDaysOfJoin: '30', recurrenceMonths: '' });

  const programs = useQuery({
    queryKey: ['learning-programs'],
    queryFn: () => hcmApi.learning.programs.list(),
  });
  const employees = useQuery({ queryKey: ['learning-employees'], queryFn: () => hcmApi.hr.employees() });
  const rules = useQuery({
    queryKey: ['learning-mandatory-rules'],
    queryFn: () => hcmApi.learning.mandatory.rules(),
  });
  const status = useQuery({
    queryKey: ['learning-mandatory-status'],
    queryFn: () => hcmApi.learning.mandatory.status(),
  });
  const nameFor = (id: string) => employees.data?.find((e) => e.id === id)?.fullName ?? id;

  // Undefined until the compliance feed loads: showing 0 would read as "nothing overdue".
  const overdueCount = status.data?.filter((r) => r.overdue).length;

  const ruleColumns: ReadonlyArray<DataTableColumn<MandatoryTrainingRule>> = [
    { id: 'program', header: 'Program', sortValue: (r) => r.program.title, cell: (r) => r.program.title },
    {
      id: 'due',
      header: 'Due within (days of join)',
      align: 'right',
      sortValue: (r) => r.dueWithinDaysOfJoin,
      cell: (r) => r.dueWithinDaysOfJoin ?? '—',
    },
    {
      id: 'recurs',
      header: 'Recurs (months)',
      align: 'right',
      sortValue: (r) => r.recurrenceMonths,
      cell: (r) => r.recurrenceMonths ?? '—',
    },
  ];

  const statusColumns: ReadonlyArray<DataTableColumn<MandatoryTrainingRow>> = [
    {
      id: 'employee',
      header: 'Employee',
      sortValue: (r) => nameFor(r.employmentRelationshipId),
      cell: (r) => nameFor(r.employmentRelationshipId),
    },
    { id: 'program', header: 'Program', sortValue: (r) => r.programTitle, cell: (r) => r.programTitle },
    { id: 'due', header: 'Due', sortValue: (r) => r.dueDate, cell: (r) => (r.dueDate ? date(r.dueDate) : '—') },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.overdue,
      cell: (r) => <StatusChip status={r.overdue ? 'overdue' : 'on track'} tone={r.overdue ? 'bad' : 'good'} />,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          label="Mandatory rules"
          value={rules.data?.length ?? '—'}
          noActionReason="Informational — see the table below to act on one."
        />
        <Metric
          label="Overdue"
          value={overdueCount ?? '—'}
          tone={overdueCount === undefined ? undefined : overdueCount > 0 ? 'warn' : 'good'}
          noActionReason="Every overdue row is listed below."
        />
      </div>

      <Card
        title="Mandatory training rules"
        subtitle="Ties a program to a due window from date of join, with an optional recurrence."
        actions={<NewButton label="Add rule" onClick={() => setOpen(true)} />}
      >
        <DataTable
          caption="Mandatory training rules"
          columns={ruleColumns}
          rows={rules.data ?? []}
          rowKey={(r) => r.id}
          loading={rules.isLoading}
          error={rules.error}
          emptyMessage="No mandatory-training rules yet."
        />

        <CreateModal
          open={open}
          title="Add a mandatory-training rule"
          onClose={() => setOpen(false)}
          invalidate={[['learning-mandatory-rules'], ['learning-mandatory-status']]}
          onSubmit={() =>
            hcmApi.learning.mandatory.createRule({
              programId: form.programId,
              dueWithinDaysOfJoin: form.dueWithinDaysOfJoin ? Number(form.dueWithinDaysOfJoin) : undefined,
              recurrenceMonths: form.recurrenceMonths ? Number(form.recurrenceMonths) : undefined,
            })
          }
        >
          <SelectInput
            label="Program"
            value={form.programId}
            onChange={(v) => setForm({ ...form, programId: v })}
            placeholder="Choose a program"
            options={(programs.data ?? []).map((p) => ({ value: p.id, label: p.title }))}
            required
          />
          <Row>
            <TextInput
              label="Due within days of join"
              type="number"
              value={form.dueWithinDaysOfJoin}
              onChange={(v) => setForm({ ...form, dueWithinDaysOfJoin: v })}
            />
            <TextInput
              label="Recurs every (months)"
              type="number"
              value={form.recurrenceMonths}
              onChange={(v) => setForm({ ...form, recurrenceMonths: v })}
              hint="Leave blank if it is a one-time requirement"
            />
          </Row>
        </CreateModal>
      </Card>

      <Card title="Compliance status" subtitle="Every active employee against every active rule.">
        <DataTable
          caption="Mandatory training compliance"
          columns={statusColumns}
          rows={status.data ?? []}
          rowKey={(r) => `${r.ruleId}:${r.employmentRelationshipId}`}
          loading={status.isLoading}
          error={status.error}
          emptyMessage="Nothing is due — no active mandatory rules, or every employee is within their window."
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IDPs
// ---------------------------------------------------------------------------

function IdpsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employmentRelationshipId: '', goalsText: '', mentorId: '', reviewDate: '' });

  const employees = useQuery({ queryKey: ['learning-employees'], queryFn: () => hcmApi.hr.employees() });
  const idps = useQuery({ queryKey: ['learning-idps'], queryFn: () => hcmApi.learning.idps.list() });
  const nameFor = (id: string) => employees.data?.find((e) => e.id === id)?.fullName ?? id;

  const close = useMutation({
    mutationFn: (id: string) => hcmApi.learning.idps.close(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-idps'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<IndividualDevelopmentPlan>> = [
    {
      id: 'employee',
      header: 'Employee',
      sortValue: (i) => nameFor(i.employmentRelationshipId),
      cell: (i) => nameFor(i.employmentRelationshipId),
    },
    {
      id: 'goals',
      header: 'Goals',
      cell: (i) => <span className="max-w-sm text-2xs text-ink-400">{(i.goals?.items ?? []).join('; ') || '—'}</span>,
    },
    {
      id: 'review',
      header: 'Review date',
      sortValue: (i) => i.reviewDate,
      cell: (i) => (i.reviewDate ? date(i.reviewDate) : '—'),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (i) => i.status,
      cell: (i) => <StatusChip status={i.status} tone={i.status === 'active' ? 'good' : 'neutral'} />,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (i) =>
        i.status === 'active' && (
          <button className="btn text-2xs" onClick={() => close.mutate(i.id)}>
            Close
          </button>
        ),
    },
  ];

  return (
    <Card
      title="Individual development plans"
      subtitle="A mentor, goals and a review date — separate from a performance-cycle goal, because this is a growth intention, not a measured commitment."
      actions={<NewButton label="Add IDP" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Individual development plans"
        columns={columns}
        rows={idps.data ?? []}
        rowKey={(i) => i.id}
        loading={idps.isLoading}
        error={idps.error}
        emptyMessage="No development plans yet."
      />

      <CreateModal
        open={open}
        title="Add a development plan"
        onClose={() => setOpen(false)}
        invalidate={[['learning-idps']]}
        onSubmit={() =>
          hcmApi.learning.idps.create({
            employmentRelationshipId: form.employmentRelationshipId,
            goals: {
              items: form.goalsText
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean),
            },
            reviewDate: form.reviewDate || undefined,
          })
        }
      >
        <SelectInput
          label="Employee"
          value={form.employmentRelationshipId}
          onChange={(v) => setForm({ ...form, employmentRelationshipId: v })}
          placeholder="Choose an employee"
          options={(employees.data ?? []).map((e) => ({ value: e.id, label: e.fullName }))}
          required
        />
        <TextArea
          label="Goals (one per line)"
          value={form.goalsText}
          onChange={(v) => setForm({ ...form, goalsText: v })}
        />
        <TextInput
          label="Review date"
          type="date"
          value={form.reviewDate}
          onChange={(v) => setForm({ ...form, reviewDate: v })}
        />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

function BudgetTab() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ fy: '', division: '', amount: '' });

  const budgets = useQuery({
    queryKey: ['learning-budgets'],
    queryFn: () => hcmApi.learning.budgets.list(),
  });

  const columns: ReadonlyArray<DataTableColumn<TrainingBudget>> = [
    { id: 'fy', header: 'FY', sortValue: (b) => b.fy, cell: (b) => b.fy },
    { id: 'division', header: 'Division', sortValue: (b) => b.division, cell: (b) => b.division ?? 'All' },
    {
      id: 'amount',
      header: 'Amount',
      align: 'right',
      sortValue: (b) => decimalAmount(b.amount),
      cell: (b) => money(decimalAmount(b.amount)),
    },
    { id: 'spent', header: 'Spent', align: 'right', sortValue: (b) => b.spent, cell: (b) => money(b.spent) },
    {
      id: 'utilisation',
      header: 'Utilisation',
      align: 'right',
      sortValue: (b) => b.utilisationPercent,
      cell: (b) => (b.utilisationPercent == null ? '—' : `${b.utilisationPercent}%`),
    },
  ];

  return (
    <Card
      title="Training budget"
      subtitle="Utilisation is the cost of every completed enrollment whose session started in that financial year — not split by division, since this workstream has no reliable employee-to-division join of its own."
      actions={<NewButton label="Add budget" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Training budget by financial year"
        columns={columns}
        rows={budgets.data ?? []}
        rowKey={(b) => b.id}
        loading={budgets.isLoading}
        error={budgets.error}
        emptyMessage="No training budget recorded yet."
      />

      <CreateModal
        open={open}
        title="Add a training budget"
        onClose={() => setOpen(false)}
        invalidate={[['learning-budgets']]}
        onSubmit={() =>
          hcmApi.learning.budgets.create({
            fy: form.fy,
            division: form.division || undefined,
            amount: Number(form.amount) || 0,
          })
        }
      >
        <TextInput
          label="Financial year"
          value={form.fy}
          onChange={(v) => setForm({ ...form, fy: v })}
          placeholder="FY2026-27"
          required
        />
        <Row>
          <TextInput
            label="Division"
            value={form.division}
            onChange={(v) => setForm({ ...form, division: v })}
            hint="Leave blank for the whole company"
          />
          <MoneyInput label="Amount" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} required />
        </Row>
      </CreateModal>
    </Card>
  );
}
