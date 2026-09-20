/**
 * Time — G2 (docs/hcm/time.md).
 *
 * Seven tabs: shift definitions, roster assignments, the clock-event log,
 * weekly timesheets, overtime pre-approval (which is also how a comp-off gets
 * earned), comp-off balances, and attendance regularisation requests that
 * drive the existing WorkAttendance dispute/regularise machine.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, dateTime } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

type Tab = 'shifts' | 'roster' | 'clock' | 'timesheets' | 'overtime' | 'compoff' | 'regularisations';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'shifts', label: 'Shifts' },
  { key: 'roster', label: 'Roster' },
  { key: 'clock', label: 'Clock' },
  { key: 'timesheets', label: 'Timesheets' },
  { key: 'overtime', label: 'Overtime' },
  { key: 'compoff', label: 'Comp-off' },
  { key: 'regularisations', label: 'Regularisations' },
];

interface EmployeeOption {
  id: string;
  fullName: string;
  status: string;
}

function useEmployeeOptions() {
  return useQuery({
    queryKey: ['time-employees'],
    queryFn: () => api.get<EmployeeOption[]>('/hr/employees'),
  });
}

function EmployeeFilter({ value, onChange, employees }: { value: string; onChange: (v: string) => void; employees: EmployeeOption[] }) {
  return (
    <select className="input max-w-xs" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Everyone</option>
      {employees.map((e) => (
        <option key={e.id} value={e.id}>
          {e.fullName}
        </option>
      ))}
    </select>
  );
}

export function Time() {
  const [tab, setTab] = useState<Tab>('shifts');

  return (
    <>
      <PageHeader
        title="Time"
        subtitle="Shifts, rosters, the clock-event log, weekly timesheets, overtime pre-approval and the comp-off it earns, and attendance regularisation requests."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'shifts' && <ShiftsTab />}
      {tab === 'roster' && <RosterTab />}
      {tab === 'clock' && <ClockTab />}
      {tab === 'timesheets' && <TimesheetsTab />}
      {tab === 'overtime' && <OvertimeTab />}
      {tab === 'compoff' && <CompOffTab />}
      {tab === 'regularisations' && <RegularisationsTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

interface Shift {
  id: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  breakMinutes: number;
  nightShift: boolean;
  active: boolean;
}

function ShiftsTab() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', startTime: '09:00', endTime: '18:00', graceMinutes: '10', breakMinutes: '60', nightShift: false });

  const shifts = useQuery({ queryKey: ['time-shifts'], queryFn: () => api.get<Shift[]>('/hcm/time/shifts') });

  return (
    <Card title="Shifts" subtitle="Start/end are clock time; a night shift is the one case where end reads earlier than start." actions={<NewButton label="Add shift" onClick={() => setOpen(true)} />}>
      {shifts.isLoading && <Loading />}
      {shifts.error && <ErrorBox error={shifts.error} />}
      {shifts.data && shifts.data.length === 0 && <EmptyState message="No shifts defined yet." hint="Add one before assigning a roster." />}
      {shifts.data && shifts.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Hours</th>
              <th>Grace</th>
              <th>Break</th>
              <th>Night</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shifts.data.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.code}</td>
                <td>{s.name}</td>
                <td>{s.startTime}–{s.endTime}</td>
                <td>{s.graceMinutes}m</td>
                <td>{s.breakMinutes}m</td>
                <td>{s.nightShift ? 'Yes' : 'No'}</td>
                <td><StatusChip status={s.active ? 'active' : 'inactive'} tone={s.active ? 'good' : 'neutral'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Add a shift"
        onClose={() => setOpen(false)}
        invalidate={[['time-shifts']]}
        onSubmit={() =>
          api.post('/hcm/time/shifts', {
            code: form.code,
            name: form.name,
            startTime: form.startTime,
            endTime: form.endTime,
            graceMinutes: Number(form.graceMinutes) || 0,
            breakMinutes: Number(form.breakMinutes) || 0,
            nightShift: form.nightShift,
          })
        }
      >
        <Row>
          <TextInput label="Code" value={form.code} onChange={(v) => setForm({ ...form, code: v })} required />
          <TextInput label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        </Row>
        <Row>
          <TextInput label="Start time" hint="HH:MM" value={form.startTime} onChange={(v) => setForm({ ...form, startTime: v })} required />
          <TextInput label="End time" hint="HH:MM" value={form.endTime} onChange={(v) => setForm({ ...form, endTime: v })} required />
        </Row>
        <Row>
          <TextInput label="Grace minutes" type="number" value={form.graceMinutes} onChange={(v) => setForm({ ...form, graceMinutes: v })} />
          <TextInput label="Break minutes" type="number" value={form.breakMinutes} onChange={(v) => setForm({ ...form, breakMinutes: v })} />
        </Row>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input type="checkbox" checked={form.nightShift} onChange={(e) => setForm({ ...form, nightShift: e.target.checked })} />
          Night shift (crosses midnight)
        </label>
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

interface RosterRow {
  id: string;
  employmentRelationshipId: string;
  shiftId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  weeklyOffDays: number[];
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function RosterTab() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employmentRelationshipId: '', shiftId: '', effectiveFrom: '', effectiveTo: '', weeklyOffDays: [0] as number[] });

  const { data: employees = [] } = useEmployeeOptions();
  const { data: shifts = [] } = useQuery({ queryKey: ['time-shifts'], queryFn: () => api.get<Shift[]>('/hcm/time/shifts') });
  const rosters = useQuery({ queryKey: ['time-rosters'], queryFn: () => api.get<RosterRow[]>('/hcm/time/rosters') });

  const nameFor = (id: string) => employees.find((e) => e.id === id)?.fullName ?? id;
  const shiftFor = (id: string) => shifts.find((s) => s.id === id)?.name ?? id;

  const toggleOff = (day: number) => {
    setForm((f) => ({ ...f, weeklyOffDays: f.weeklyOffDays.includes(day) ? f.weeklyOffDays.filter((d) => d !== day) : [...f.weeklyOffDays, day].sort() }));
  };

  return (
    <Card title="Roster assignments" subtitle="Which shift an employment works, over a date range, with its weekly offs." actions={<NewButton label="Assign roster" onClick={() => setOpen(true)} />}>
      {rosters.isLoading && <Loading />}
      {rosters.error && <ErrorBox error={rosters.error} />}
      {rosters.data && rosters.data.length === 0 && <EmptyState message="No roster assignments yet." />}
      {rosters.data && rosters.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Shift</th>
              <th>From</th>
              <th>To</th>
              <th>Weekly offs</th>
            </tr>
          </thead>
          <tbody>
            {rosters.data.map((r) => (
              <tr key={r.id}>
                <td>{nameFor(r.employmentRelationshipId)}</td>
                <td>{shiftFor(r.shiftId)}</td>
                <td>{date(r.effectiveFrom)}</td>
                <td>{r.effectiveTo ? date(r.effectiveTo) : 'Open-ended'}</td>
                <td>{r.weeklyOffDays.map((d) => WEEKDAY_NAMES[d]).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Assign a roster"
        onClose={() => setOpen(false)}
        invalidate={[['time-rosters']]}
        onSubmit={() =>
          api.post('/hcm/time/rosters', {
            employmentRelationshipId: form.employmentRelationshipId,
            shiftId: form.shiftId,
            effectiveFrom: form.effectiveFrom,
            effectiveTo: form.effectiveTo || null,
            weeklyOffDays: form.weeklyOffDays,
          })
        }
      >
        <SelectInput label="Employee" value={form.employmentRelationshipId} onChange={(v) => setForm({ ...form, employmentRelationshipId: v })} required placeholder="Select…" options={employees.map((e) => ({ value: e.id, label: e.fullName }))} />
        <SelectInput label="Shift" value={form.shiftId} onChange={(v) => setForm({ ...form, shiftId: v })} required placeholder="Select…" options={shifts.map((s) => ({ value: s.id, label: `${s.name} (${s.startTime}–${s.endTime})` }))} />
        <Row>
          <TextInput label="Effective from" type="date" value={form.effectiveFrom} onChange={(v) => setForm({ ...form, effectiveFrom: v })} required />
          <TextInput label="Effective to" type="date" value={form.effectiveTo} onChange={(v) => setForm({ ...form, effectiveTo: v })} hint="Optional" />
        </Row>
        <div>
          <p className="label mb-1">Weekly offs</p>
          <div className="flex flex-wrap gap-2">
            {WEEKDAY_NAMES.map((name, day) => (
              <label key={day} className="flex items-center gap-1 text-2xs text-ink-300">
                <input type="checkbox" checked={form.weeklyOffDays.includes(day)} onChange={() => toggleOff(day)} />
                {name}
              </label>
            ))}
          </div>
        </div>
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

interface ClockEventRow {
  id: string;
  kind: string;
  occurredAt: string;
  source: string;
}

function ClockTab() {
  const { data: employees = [] } = useEmployeeOptions();
  const [employmentId, setEmploymentId] = useState('');
  const selected = employmentId || employees[0]?.id || '';

  const events = useQuery({
    queryKey: ['time-clock', selected],
    queryFn: () => api.get<ClockEventRow[]>(`/hcm/time/clock?employmentRelationshipId=${selected}`),
    enabled: Boolean(selected),
  });

  return (
    <Card title="Clock events" subtitle="The raw punch log a nightly job folds into each day's attendance." actions={<EmployeeFilter value={employmentId} onChange={setEmploymentId} employees={employees} />}>
      {!selected && <EmptyState message="No employee selected." />}
      {selected && events.isLoading && <Loading />}
      {selected && events.error && <ErrorBox error={events.error} />}
      {selected && events.data && events.data.length === 0 && <EmptyState message="No clock events recorded for this employee." />}
      {selected && events.data && events.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Kind</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {events.data.map((e) => (
              <tr key={e.id}>
                <td>{dateTime(e.occurredAt)}</td>
                <td><StatusChip status={e.kind} tone={e.kind === 'in' ? 'good' : 'neutral'} /></td>
                <td>{e.source.replace('_', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Timesheets
// ---------------------------------------------------------------------------

interface TimesheetRow {
  id: string;
  recordCode: string;
  employmentRelationshipId: string;
  weekStart: string;
  status: string;
  totalHours: string | number;
}

const TIMESHEET_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = {
  draft: 'neutral',
  submitted: 'warn',
  approved: 'good',
  rejected: 'bad',
};

function TimesheetsTab() {
  const qc = useQueryClient();
  const { data: employees = [] } = useEmployeeOptions();
  const [employmentId, setEmploymentId] = useState('');
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  const timesheets = useQuery({
    queryKey: ['time-timesheets', employmentId],
    queryFn: () => api.get<TimesheetRow[]>(`/hcm/time/timesheets${employmentId ? `?employmentRelationshipId=${employmentId}` : ''}`),
  });

  const nameFor = (id: string) => employees.find((e) => e.id === id)?.fullName ?? id;

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/time/timesheets/${id}/approve`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['time-timesheets'] }),
  });
  const reject = useMutation({
    mutationFn: () => api.post(`/hcm/time/timesheets/${rejecting}/reject`, { note: rejectNote }),
    onSuccess: () => {
      setRejecting(null);
      setRejectNote('');
      void qc.invalidateQueries({ queryKey: ['time-timesheets'] });
    },
  });

  return (
    <Card title="Timesheets" subtitle="Submitted weekly and approved by anyone but the employee who filed them." actions={<EmployeeFilter value={employmentId} onChange={setEmploymentId} employees={employees} />}>
      {timesheets.isLoading && <Loading />}
      {timesheets.error && <ErrorBox error={timesheets.error} />}
      {timesheets.data && timesheets.data.length === 0 && <EmptyState message="No timesheets yet." />}
      {timesheets.data && timesheets.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Employee</th>
              <th>Week of</th>
              <th>Hours</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {timesheets.data.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.recordCode}</td>
                <td>{nameFor(t.employmentRelationshipId)}</td>
                <td>{date(t.weekStart)}</td>
                <td className="tabular-nums">{Number(t.totalHours).toFixed(2)}</td>
                <td><StatusChip status={t.status} tone={TIMESHEET_TONE[t.status] ?? 'neutral'} /></td>
                <td className="text-right">
                  {t.status === 'submitted' && (
                    <div className="flex justify-end gap-2">
                      <button className="btn text-2xs" onClick={() => approve.mutate(t.id)} disabled={approve.isPending}>
                        Approve
                      </button>
                      <button className="btn text-2xs" onClick={() => setRejecting(t.id)}>
                        Reject
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {approve.error && <ErrorBox error={approve.error} />}

      <CreateModal
        open={Boolean(rejecting)}
        title="Reject this timesheet"
        submitLabel="Reject"
        onClose={() => setRejecting(null)}
        onSubmit={() => reject.mutateAsync()}
      >
        <TextArea label="Reason" value={rejectNote} onChange={setRejectNote} required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Overtime
// ---------------------------------------------------------------------------

interface OvertimeRow {
  id: string;
  employmentRelationshipId: string;
  date: string;
  hours: string | number;
  reason: string | null;
  status: string;
}

const OT_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { requested: 'warn', approved: 'good', rejected: 'bad' };

function OvertimeTab() {
  const qc = useQueryClient();
  const { data: employees = [] } = useEmployeeOptions();
  const [employmentId, setEmploymentId] = useState('');

  const requests = useQuery({
    queryKey: ['time-overtime', employmentId],
    queryFn: () => api.get<OvertimeRow[]>(`/hcm/time/overtime${employmentId ? `?employmentRelationshipId=${employmentId}` : ''}`),
  });

  const nameFor = (id: string) => employees.find((e) => e.id === id)?.fullName ?? id;

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      api.post(`/hcm/time/overtime/${id}/${approve ? 'approve' : 'reject'}`, approve ? {} : { note: 'Not approved.' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['time-overtime'] });
      void qc.invalidateQueries({ queryKey: ['time-compoffs'] });
    },
  });

  return (
    <Card title="Overtime requests" subtitle="Approving one is also what earns the comp-off it comes with." actions={<EmployeeFilter value={employmentId} onChange={setEmploymentId} employees={employees} />}>
      {requests.isLoading && <Loading />}
      {requests.error && <ErrorBox error={requests.error} />}
      {decide.error && <ErrorBox error={decide.error} />}
      {requests.data && requests.data.length === 0 && <EmptyState message="No overtime requests yet." />}
      {requests.data && requests.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Date</th>
              <th>Hours</th>
              <th>Reason</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {requests.data.map((r) => (
              <tr key={r.id}>
                <td>{nameFor(r.employmentRelationshipId)}</td>
                <td>{date(r.date)}</td>
                <td className="tabular-nums">{Number(r.hours).toFixed(2)}</td>
                <td className="max-w-xs truncate" title={r.reason ?? ''}>{r.reason ?? '—'}</td>
                <td><StatusChip status={r.status} tone={OT_TONE[r.status] ?? 'neutral'} /></td>
                <td className="text-right">
                  {r.status === 'requested' && (
                    <div className="flex justify-end gap-2">
                      <button className="btn text-2xs" onClick={() => decide.mutate({ id: r.id, approve: true })} disabled={decide.isPending}>
                        Approve
                      </button>
                      <button className="btn text-2xs" onClick={() => decide.mutate({ id: r.id, approve: false })} disabled={decide.isPending}>
                        Reject
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Comp-off
// ---------------------------------------------------------------------------

interface CompOffRow {
  id: string;
  employmentRelationshipId: string;
  earnedFrom: string;
  earnedOn: string;
  days: string | number;
  expiresOn: string;
  status: string;
}

const COMP_OFF_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { available: 'good', consumed: 'neutral', expired: 'bad' };

function CompOffTab() {
  const qc = useQueryClient();
  const { data: employees = [] } = useEmployeeOptions();
  const [employmentId, setEmploymentId] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employmentRelationshipId: '', earnedOn: '', days: '1', note: '' });

  const compOffs = useQuery({
    queryKey: ['time-compoffs', employmentId],
    queryFn: () => api.get<CompOffRow[]>(`/hcm/time/comp-offs${employmentId ? `?employmentRelationshipId=${employmentId}` : ''}`),
  });

  const nameFor = (id: string) => employees.find((e) => e.id === id)?.fullName ?? id;

  const consume = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/time/comp-offs/${id}/consume`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['time-compoffs'] }),
  });

  return (
    <Card
      title="Comp-off"
      subtitle="Earned from approved overtime automatically, or filed directly for holiday work. Expires 90 days after it's earned; marking one consumed is HR's action, ahead of the leave-policy engine doing it through the CO leave type."
      actions={
        <div className="flex items-center gap-2">
          <EmployeeFilter value={employmentId} onChange={setEmploymentId} employees={employees} />
          <NewButton label="Record holiday work" onClick={() => setOpen(true)} />
        </div>
      }
    >
      {compOffs.isLoading && <Loading />}
      {compOffs.error && <ErrorBox error={compOffs.error} />}
      {consume.error && <ErrorBox error={consume.error} />}
      {compOffs.data && compOffs.data.length === 0 && <EmptyState message="No comp-off records yet." />}
      {compOffs.data && compOffs.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Earned from</th>
              <th>Earned on</th>
              <th>Days</th>
              <th>Expires</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {compOffs.data.map((c) => (
              <tr key={c.id}>
                <td>{nameFor(c.employmentRelationshipId)}</td>
                <td>{c.earnedFrom.replace('_', ' ')}</td>
                <td>{date(c.earnedOn)}</td>
                <td className="tabular-nums">{Number(c.days).toFixed(2)}</td>
                <td>{date(c.expiresOn)}</td>
                <td><StatusChip status={c.status} tone={COMP_OFF_TONE[c.status] ?? 'neutral'} /></td>
                <td className="text-right">
                  {c.status === 'available' && (
                    <button className="btn text-2xs" onClick={() => consume.mutate(c.id)} disabled={consume.isPending}>
                      Mark consumed
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
        title="Record comp-off for holiday work"
        onClose={() => setOpen(false)}
        invalidate={[['time-compoffs']]}
        onSubmit={() =>
          api.post('/hcm/time/comp-offs/holiday-work', {
            employmentRelationshipId: form.employmentRelationshipId,
            earnedOn: form.earnedOn,
            days: Number(form.days),
            note: form.note || null,
          })
        }
      >
        <SelectInput label="Employee" value={form.employmentRelationshipId} onChange={(v) => setForm({ ...form, employmentRelationshipId: v })} required placeholder="Select…" options={employees.map((e) => ({ value: e.id, label: e.fullName }))} />
        <Row>
          <TextInput label="Day worked" type="date" value={form.earnedOn} onChange={(v) => setForm({ ...form, earnedOn: v })} required />
          <TextInput label="Days earned" type="number" value={form.days} onChange={(v) => setForm({ ...form, days: v })} hint="Usually 1" required />
        </Row>
        <TextArea label="Note" value={form.note} onChange={(v) => setForm({ ...form, note: v })} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Regularisations
// ---------------------------------------------------------------------------

interface RegularisationRow {
  id: string;
  employmentRelationshipId: string;
  date: string;
  reason: string;
  status: string;
}

const REG_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { submitted: 'warn', approved: 'good', rejected: 'bad' };

function RegularisationsTab() {
  const qc = useQueryClient();
  const { data: employees = [] } = useEmployeeOptions();
  const [employmentId, setEmploymentId] = useState('');
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  const rows = useQuery({
    queryKey: ['time-regularisations', employmentId],
    queryFn: () => api.get<RegularisationRow[]>(`/hcm/time/regularisations${employmentId ? `?employmentRelationshipId=${employmentId}` : ''}`),
  });

  const nameFor = (id: string) => employees.find((e) => e.id === id)?.fullName ?? id;

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/time/regularisations/${id}/approve`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['time-regularisations'] }),
  });
  const reject = useMutation({
    mutationFn: () => api.post(`/hcm/time/regularisations/${rejecting}/reject`, { note: rejectNote }),
    onSuccess: () => {
      setRejecting(null);
      setRejectNote('');
      void qc.invalidateQueries({ queryKey: ['time-regularisations'] });
    },
  });

  return (
    <Card title="Attendance regularisations" subtitle="Submitting one disputes the day; approving it regularises the same WorkAttendance row." actions={<EmployeeFilter value={employmentId} onChange={setEmploymentId} employees={employees} />}>
      {rows.isLoading && <Loading />}
      {rows.error && <ErrorBox error={rows.error} />}
      {approve.error && <ErrorBox error={approve.error} />}
      {rows.data && rows.data.length === 0 && <EmptyState message="No regularisation requests yet." />}
      {rows.data && rows.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Date</th>
              <th>Reason</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.data.map((r) => (
              <tr key={r.id}>
                <td>{nameFor(r.employmentRelationshipId)}</td>
                <td>{date(r.date)}</td>
                <td className="max-w-xs truncate" title={r.reason}>{r.reason}</td>
                <td><StatusChip status={r.status} tone={REG_TONE[r.status] ?? 'neutral'} /></td>
                <td className="text-right">
                  {r.status === 'submitted' && (
                    <div className="flex justify-end gap-2">
                      <button className="btn text-2xs" onClick={() => approve.mutate(r.id)} disabled={approve.isPending}>
                        Approve
                      </button>
                      <button className="btn text-2xs" onClick={() => setRejecting(r.id)}>
                        Reject
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal open={Boolean(rejecting)} title="Reject this request" submitLabel="Reject" onClose={() => setRejecting(null)} onSubmit={() => reject.mutateAsync()}>
        <TextArea label="Reason" value={rejectNote} onChange={setRejectNote} required />
      </CreateModal>
    </Card>
  );
}
