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
import { api, date, money } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs, Metric } from '../../components/ui.js';
import { CreateModal, messageOf, MoneyInput, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

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

interface Program {
  id: string;
  title: string;
  kind: string;
  provider: string | null;
  durationHours: number | null;
  cost: number;
  skillIds: string[];
  validityMonths: number | null;
  isActive: boolean;
}

function ProgramsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: '', kind: 'classroom' as 'classroom' | 'online' | 'certification' | 'mandatory',
    provider: '', cost: '0', validityMonths: '',
  });

  const programs = useQuery({ queryKey: ['learning-programs'], queryFn: () => api.get<Program[]>('/hcm/learning/programs') });

  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.patch(`/hcm/learning/programs/${id}`, { isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-programs'] }),
  });

  return (
    <Card
      title="Training programs"
      subtitle="Classroom, online, certification and mandatory courses the company runs or sponsors."
      actions={<NewButton label="Add program" onClick={() => setOpen(true)} />}
    >
      {programs.isLoading && <Loading />}
      {programs.error && <ErrorBox error={programs.error} />}
      {programs.data && programs.data.length === 0 && (
        <EmptyState message="No training programs yet." hint="Add one to start scheduling sessions against it." />
      )}
      {programs.data && programs.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Kind</th>
              <th>Provider</th>
              <th>Cost</th>
              <th>Validity</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {programs.data.map((p) => (
              <tr key={p.id}>
                <td>{p.title}</td>
                <td><StatusChip status={p.kind} /></td>
                <td>{p.provider ?? '—'}</td>
                <td className="tabular-nums">{money(p.cost)}</td>
                <td>{p.validityMonths ? `${p.validityMonths} months` : '—'}</td>
                <td><StatusChip status={p.isActive ? 'active' : 'inactive'} tone={p.isActive ? 'good' : 'neutral'} /></td>
                <td className="text-right">
                  <button className="btn text-2xs" onClick={() => toggleActive.mutate({ id: p.id, isActive: !p.isActive })}>
                    {p.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Add a training program"
        onClose={() => setOpen(false)}
        invalidate={[['learning-programs']]}
        onSubmit={() =>
          api.post('/hcm/learning/programs', {
            title: form.title,
            kind: form.kind,
            provider: form.provider || undefined,
            cost: Number(form.cost) || 0,
            validityMonths: form.validityMonths ? Number(form.validityMonths) : undefined,
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

interface Session {
  id: string;
  programId: string;
  startsAt: string;
  endsAt: string;
  trainer: string | null;
  seats: number;
  location: string | null;
  status: string;
  program: { title: string; kind: string; cost: number };
}

function SessionsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ programId: '', startsAt: '', endsAt: '', trainer: '', seats: '20', location: '' });

  const programs = useQuery({ queryKey: ['learning-programs'], queryFn: () => api.get<Program[]>('/hcm/learning/programs') });
  const sessions = useQuery({ queryKey: ['learning-sessions'], queryFn: () => api.get<Session[]>('/hcm/learning/sessions') });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'completed' | 'cancelled' }) =>
      api.post(`/hcm/learning/sessions/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-sessions'] }),
  });

  return (
    <Card
      title="Sessions"
      subtitle="A scheduled running of a program — a batch, a cohort, a booked slot."
      actions={<NewButton label="Schedule session" onClick={() => setOpen(true)} />}
    >
      {sessions.isLoading && <Loading />}
      {sessions.error && <ErrorBox error={sessions.error} />}
      {sessions.data && sessions.data.length === 0 && (
        <EmptyState message="No sessions scheduled yet." hint="Add a program first, then schedule a session against it." />
      )}
      {sessions.data && sessions.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Program</th>
              <th>Starts</th>
              <th>Trainer</th>
              <th>Seats</th>
              <th>Location</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.data.map((s) => (
              <tr key={s.id}>
                <td>{s.program.title}</td>
                <td>{date(s.startsAt)}</td>
                <td>{s.trainer ?? '—'}</td>
                <td className="tabular-nums">{s.seats}</td>
                <td>{s.location ?? '—'}</td>
                <td><StatusChip status={s.status} tone={s.status === 'completed' ? 'good' : s.status === 'cancelled' ? 'bad' : 'neutral'} /></td>
                <td className="text-right">
                  {s.status === 'scheduled' && (
                    <button className="btn text-2xs" onClick={() => setStatus.mutate({ id: s.id, status: 'completed' })}>
                      Mark completed
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Schedule a session"
        onClose={() => setOpen(false)}
        invalidate={[['learning-sessions']]}
        onSubmit={() =>
          api.post('/hcm/learning/sessions', {
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
          <TextInput label="Starts" type="date" value={form.startsAt} onChange={(v) => setForm({ ...form, startsAt: v })} required />
          <TextInput label="Ends" type="date" value={form.endsAt} onChange={(v) => setForm({ ...form, endsAt: v })} required />
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

interface Enrollment {
  id: string;
  sessionId: string;
  employmentRelationshipId: string;
  status: string;
  score: number | null;
  session: { startsAt: string; program: { title: string; kind: string } };
}

interface Employee {
  id: string;
  fullName: string;
}

function EnrollmentsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ sessionId: '', employmentRelationshipId: '' });

  const sessions = useQuery({ queryKey: ['learning-sessions'], queryFn: () => api.get<Session[]>('/hcm/learning/sessions') });
  const employees = useQuery({ queryKey: ['learning-employees'], queryFn: () => api.get<Employee[]>('/hr/employees') });
  const enrollments = useQuery({ queryKey: ['learning-enrollments'], queryFn: () => api.get<Enrollment[]>('/hcm/learning/enrollments') });

  const nameFor = (id: string) => employees.data?.find((e) => e.id === id)?.fullName ?? id;

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/learning/enrollments/${id}/approve`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-enrollments'] }),
  });
  const reject = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/learning/enrollments/${id}/reject`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-enrollments'] }),
  });
  const attend = useMutation({
    mutationFn: ({ id, attended }: { id: string; attended: boolean }) => api.post(`/hcm/learning/enrollments/${id}/attendance`, { attended }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-enrollments'] }),
  });
  const complete = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/learning/enrollments/${id}/complete`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['learning-enrollments'] });
      qc.invalidateQueries({ queryKey: ['learning-certifications'] });
    },
  });

  return (
    <Card
      title="Enrollments"
      subtitle="Nominated → approved → attended → completed. Approving your own nomination is refused."
      actions={<NewButton label="Nominate" onClick={() => setOpen(true)} />}
    >
      {enrollments.isLoading && <Loading />}
      {enrollments.error && <ErrorBox error={enrollments.error} />}
      {enrollments.data && enrollments.data.length === 0 && <EmptyState message="No enrollments yet." />}
      {enrollments.data && enrollments.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Program</th>
              <th>Session</th>
              <th>Status</th>
              <th>Score</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {enrollments.data.map((e) => (
              <tr key={e.id}>
                <td>{nameFor(e.employmentRelationshipId)}</td>
                <td>{e.session.program.title}</td>
                <td>{date(e.session.startsAt)}</td>
                <td>
                  <StatusChip
                    status={e.status}
                    tone={e.status === 'completed' ? 'good' : e.status === 'rejected' || e.status === 'no_show' ? 'bad' : 'neutral'}
                  />
                </td>
                <td className="tabular-nums">{e.score ?? '—'}</td>
                <td className="text-right space-x-2">
                  {e.status === 'nominated' && (
                    <>
                      <button className="btn text-2xs" onClick={() => approve.mutate(e.id)}>Approve</button>
                      <button className="btn text-2xs" onClick={() => reject.mutate(e.id)}>Reject</button>
                    </>
                  )}
                  {e.status === 'approved' && (
                    <>
                      <button className="btn text-2xs" onClick={() => attend.mutate({ id: e.id, attended: true })}>Attended</button>
                      <button className="btn text-2xs" onClick={() => attend.mutate({ id: e.id, attended: false })}>No-show</button>
                    </>
                  )}
                  {e.status === 'attended' && (
                    <button className="btn-primary text-2xs" onClick={() => complete.mutate(e.id)}>Complete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
        onSubmit={() => api.post('/hcm/learning/enrollments', form)}
      >
        <SelectInput
          label="Session"
          value={form.sessionId}
          onChange={(v) => setForm({ ...form, sessionId: v })}
          placeholder="Choose a session"
          options={(sessions.data ?? []).map((s) => ({ value: s.id, label: `${s.program.title} — ${date(s.startsAt)}` }))}
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

interface Certification {
  id: string;
  recordCode: string;
  employmentRelationshipId: string;
  name: string;
  issuer: string | null;
  issuedOn: string;
  expiresOn: string | null;
  verified: boolean;
}

function CertificationsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employmentRelationshipId: '', name: '', issuer: '', issuedOn: '', expiresOn: '' });

  const employees = useQuery({ queryKey: ['learning-employees'], queryFn: () => api.get<Employee[]>('/hr/employees') });
  const certs = useQuery({ queryKey: ['learning-certifications'], queryFn: () => api.get<Certification[]>('/hcm/learning/certifications') });
  const nameFor = (id: string) => employees.data?.find((e) => e.id === id)?.fullName ?? id;

  const verify = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/learning/certifications/${id}/verify`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-certifications'] }),
  });
  const runExpiryCheck = useMutation({
    mutationFn: () => api.post('/hcm/learning/certifications/expiry-check'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-certifications'] }),
  });

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
      {certs.isLoading && <Loading />}
      {certs.error && <ErrorBox error={certs.error} />}
      {certs.data && certs.data.length === 0 && <EmptyState message="No certifications on file yet." />}
      {certs.data && certs.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Employee</th>
              <th>Name</th>
              <th>Issued</th>
              <th>Expires</th>
              <th>Verified</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {certs.data.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.recordCode}</td>
                <td>{nameFor(c.employmentRelationshipId)}</td>
                <td>{c.name}</td>
                <td>{date(c.issuedOn)}</td>
                <td>{c.expiresOn ? date(c.expiresOn) : 'Never'}</td>
                <td><StatusChip status={c.verified ? 'verified' : 'unverified'} tone={c.verified ? 'good' : 'neutral'} /></td>
                <td className="text-right">
                  {!c.verified && (
                    <button className="btn text-2xs" onClick={() => verify.mutate(c.id)}>Verify</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {verify.error && <p className="mt-2 text-2xs text-band-critical">{messageOf(verify.error)}</p>}

      <CreateModal
        open={open}
        title="Add a certification"
        onClose={() => setOpen(false)}
        invalidate={[['learning-certifications']]}
        onSubmit={() =>
          api.post('/hcm/learning/certifications', {
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
          <TextInput label="Issued on" type="date" value={form.issuedOn} onChange={(v) => setForm({ ...form, issuedOn: v })} required />
        </Row>
        <TextInput label="Expires on" type="date" value={form.expiresOn} onChange={(v) => setForm({ ...form, expiresOn: v })} hint="Leave blank if it never expires" />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Mandatory training
// ---------------------------------------------------------------------------

interface MandatoryRule {
  id: string;
  programId: string;
  dueWithinDaysOfJoin: number | null;
  recurrenceMonths: number | null;
  program: { title: string };
}

interface MandatoryRow {
  ruleId: string;
  programId: string;
  programTitle: string;
  employmentRelationshipId: string;
  dueDate: string | null;
  overdue: boolean;
}

function MandatoryTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ programId: '', dueWithinDaysOfJoin: '30', recurrenceMonths: '' });

  const programs = useQuery({ queryKey: ['learning-programs'], queryFn: () => api.get<Program[]>('/hcm/learning/programs') });
  const employees = useQuery({ queryKey: ['learning-employees'], queryFn: () => api.get<Employee[]>('/hr/employees') });
  const rules = useQuery({ queryKey: ['learning-mandatory-rules'], queryFn: () => api.get<MandatoryRule[]>('/hcm/learning/mandatory-rules') });
  const status = useQuery({ queryKey: ['learning-mandatory-status'], queryFn: () => api.get<MandatoryRow[]>('/hcm/learning/mandatory-status') });
  const nameFor = (id: string) => employees.data?.find((e) => e.id === id)?.fullName ?? id;

  const overdueCount = status.data?.filter((r) => r.overdue).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Mandatory rules" value={rules.data?.length ?? '—'} noActionReason="Informational — see the table below to act on one." />
        <Metric
          label="Overdue"
          value={overdueCount}
          tone={overdueCount > 0 ? 'warn' : 'good'}
          noActionReason="Every overdue row is listed below."
        />
      </div>

      <Card
        title="Mandatory training rules"
        subtitle="Ties a program to a due window from date of join, with an optional recurrence."
        actions={<NewButton label="Add rule" onClick={() => setOpen(true)} />}
      >
        {rules.isLoading && <Loading />}
        {rules.error && <ErrorBox error={rules.error} />}
        {rules.data && rules.data.length === 0 && <EmptyState message="No mandatory-training rules yet." />}
        {rules.data && rules.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Program</th>
                <th>Due within (days of join)</th>
                <th>Recurs (months)</th>
              </tr>
            </thead>
            <tbody>
              {rules.data.map((r) => (
                <tr key={r.id}>
                  <td>{r.program.title}</td>
                  <td className="tabular-nums">{r.dueWithinDaysOfJoin ?? '—'}</td>
                  <td className="tabular-nums">{r.recurrenceMonths ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <CreateModal
          open={open}
          title="Add a mandatory-training rule"
          onClose={() => setOpen(false)}
          invalidate={[['learning-mandatory-rules'], ['learning-mandatory-status']]}
          onSubmit={() =>
            api.post('/hcm/learning/mandatory-rules', {
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
            <TextInput label="Due within days of join" type="number" value={form.dueWithinDaysOfJoin} onChange={(v) => setForm({ ...form, dueWithinDaysOfJoin: v })} />
            <TextInput label="Recurs every (months)" type="number" value={form.recurrenceMonths} onChange={(v) => setForm({ ...form, recurrenceMonths: v })} hint="Leave blank if it is a one-time requirement" />
          </Row>
        </CreateModal>
      </Card>

      <Card title="Compliance status" subtitle="Every active employee against every active rule.">
        {status.isLoading && <Loading />}
        {status.error && <ErrorBox error={status.error} />}
        {status.data && status.data.length === 0 && <EmptyState message="Nothing is due — no active mandatory rules, or every employee is within their window." />}
        {status.data && status.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Program</th>
                <th>Due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {status.data.map((r) => (
                <tr key={`${r.ruleId}:${r.employmentRelationshipId}`}>
                  <td>{nameFor(r.employmentRelationshipId)}</td>
                  <td>{r.programTitle}</td>
                  <td>{r.dueDate ? date(r.dueDate) : '—'}</td>
                  <td><StatusChip status={r.overdue ? 'overdue' : 'on track'} tone={r.overdue ? 'bad' : 'good'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IDPs
// ---------------------------------------------------------------------------

interface Idp {
  id: string;
  employmentRelationshipId: string;
  goals: { items?: string[] } | null;
  mentorId: string | null;
  reviewDate: string | null;
  status: string;
}

function IdpsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employmentRelationshipId: '', goalsText: '', mentorId: '', reviewDate: '' });

  const employees = useQuery({ queryKey: ['learning-employees'], queryFn: () => api.get<Employee[]>('/hr/employees') });
  const idps = useQuery({ queryKey: ['learning-idps'], queryFn: () => api.get<Idp[]>('/hcm/learning/idps') });
  const nameFor = (id: string) => employees.data?.find((e) => e.id === id)?.fullName ?? id;

  const close = useMutation({
    mutationFn: (id: string) => api.patch(`/hcm/learning/idps/${id}`, { status: 'closed' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-idps'] }),
  });

  return (
    <Card
      title="Individual development plans"
      subtitle="A mentor, goals and a review date — separate from a performance-cycle goal, because this is a growth intention, not a measured commitment."
      actions={<NewButton label="Add IDP" onClick={() => setOpen(true)} />}
    >
      {idps.isLoading && <Loading />}
      {idps.error && <ErrorBox error={idps.error} />}
      {idps.data && idps.data.length === 0 && <EmptyState message="No development plans yet." />}
      {idps.data && idps.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Goals</th>
              <th>Review date</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {idps.data.map((i) => (
              <tr key={i.id}>
                <td>{nameFor(i.employmentRelationshipId)}</td>
                <td className="max-w-sm text-2xs text-ink-400">{(i.goals?.items ?? []).join('; ') || '—'}</td>
                <td>{i.reviewDate ? date(i.reviewDate) : '—'}</td>
                <td><StatusChip status={i.status} tone={i.status === 'active' ? 'good' : 'neutral'} /></td>
                <td className="text-right">
                  {i.status === 'active' && (
                    <button className="btn text-2xs" onClick={() => close.mutate(i.id)}>Close</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Add a development plan"
        onClose={() => setOpen(false)}
        invalidate={[['learning-idps']]}
        onSubmit={() =>
          api.post('/hcm/learning/idps', {
            employmentRelationshipId: form.employmentRelationshipId,
            goals: { items: form.goalsText.split('\n').map((s) => s.trim()).filter(Boolean) },
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
        <TextArea label="Goals (one per line)" value={form.goalsText} onChange={(v) => setForm({ ...form, goalsText: v })} />
        <TextInput label="Review date" type="date" value={form.reviewDate} onChange={(v) => setForm({ ...form, reviewDate: v })} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

interface Budget {
  id: string;
  fy: string;
  division: string | null;
  amount: number;
  spent: number;
  utilisationPercent: number | null;
}

function BudgetTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ fy: '', division: '', amount: '' });

  const budgets = useQuery({ queryKey: ['learning-budgets'], queryFn: () => api.get<Budget[]>('/hcm/learning/budgets') });

  return (
    <Card
      title="Training budget"
      subtitle="Utilisation is the cost of every completed enrollment whose session started in that financial year — not split by division, since this workstream has no reliable employee-to-division join of its own."
      actions={<NewButton label="Add budget" onClick={() => setOpen(true)} />}
    >
      {budgets.isLoading && <Loading />}
      {budgets.error && <ErrorBox error={budgets.error} />}
      {budgets.data && budgets.data.length === 0 && <EmptyState message="No training budget recorded yet." />}
      {budgets.data && budgets.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>FY</th>
              <th>Division</th>
              <th>Amount</th>
              <th>Spent</th>
              <th>Utilisation</th>
            </tr>
          </thead>
          <tbody>
            {budgets.data.map((b) => (
              <tr key={b.id}>
                <td>{b.fy}</td>
                <td>{b.division ?? 'All'}</td>
                <td className="tabular-nums">{money(b.amount)}</td>
                <td className="tabular-nums">{money(b.spent)}</td>
                <td className="tabular-nums">{b.utilisationPercent == null ? '—' : `${b.utilisationPercent}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Add a training budget"
        onClose={() => setOpen(false)}
        invalidate={[['learning-budgets']]}
        onSubmit={() => api.post('/hcm/learning/budgets', { fy: form.fy, division: form.division || undefined, amount: Number(form.amount) || 0 })}
      >
        <TextInput label="Financial year" value={form.fy} onChange={(v) => setForm({ ...form, fy: v })} placeholder="FY2026-27" required />
        <Row>
          <TextInput label="Division" value={form.division} onChange={(v) => setForm({ ...form, division: v })} hint="Leave blank for the whole company" />
          <MoneyInput label="Amount" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} required />
        </Row>
      </CreateModal>
    </Card>
  );
}
