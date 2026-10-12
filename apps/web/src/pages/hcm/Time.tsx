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
import { date, dateTime } from '../../lib/api.js';
import {
  hcmApi,
  type HrEmployeeRow,
  type TimeClockEvent,
  type TimeCompOffRow,
  type TimeOvertimeRow,
  type TimeRegularisationRow,
  type TimeRosterRow,
  type TimeShift,
  type TimeTimesheet,
} from '../../lib/hcmApi.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';
import { Card, EmptyState, ErrorBox, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
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

function useEmployeeOptions() {
  return useQuery({
    queryKey: ['time-employees'],
    queryFn: () => hcmApi.hr.employees(),
  });
}

function EmployeeFilter({
  value,
  onChange,
  employees,
}: {
  value: string;
  onChange: (v: string) => void;
  employees: HrEmployeeRow[];
}) {
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

function ShiftsTab() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    code: '',
    name: '',
    startTime: '09:00',
    endTime: '18:00',
    graceMinutes: '10',
    breakMinutes: '60',
    nightShift: false,
  });

  const shifts = useQuery({ queryKey: ['time-shifts'], queryFn: () => hcmApi.time.shifts.list() });

  const columns: ReadonlyArray<DataTableColumn<TimeShift>> = [
    { id: 'code', header: 'Code', sortValue: (r) => r.code, cell: (r) => <span className="mono">{r.code}</span> },
    { id: 'name', header: 'Name', sortValue: (r) => r.name, cell: (r) => r.name },
    { id: 'hours', header: 'Hours', sortValue: (r) => r.startTime, cell: (r) => `${r.startTime}–${r.endTime}` },
    {
      id: 'grace',
      header: 'Grace',
      align: 'right',
      sortValue: (r) => r.graceMinutes,
      cell: (r) => `${r.graceMinutes}m`,
    },
    {
      id: 'break',
      header: 'Break',
      align: 'right',
      sortValue: (r) => r.breakMinutes,
      cell: (r) => `${r.breakMinutes}m`,
    },
    { id: 'night', header: 'Night', sortValue: (r) => r.nightShift, cell: (r) => (r.nightShift ? 'Yes' : 'No') },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.active,
      cell: (r) => <StatusChip status={r.active ? 'active' : 'inactive'} tone={r.active ? 'good' : 'neutral'} />,
    },
  ];

  return (
    <Card
      title="Shifts"
      subtitle="Start/end are clock time; a night shift is the one case where end reads earlier than start."
      actions={<NewButton label="Add shift" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Shifts"
        columns={columns}
        rows={shifts.data ?? []}
        rowKey={(r) => r.id}
        loading={shifts.isLoading}
        error={shifts.error}
        emptyMessage="No shifts defined yet."
        emptyHint="Add one before assigning a roster."
      />

      <CreateModal
        open={open}
        title="Add a shift"
        onClose={() => setOpen(false)}
        invalidate={[['time-shifts']]}
        onSubmit={() =>
          hcmApi.time.shifts.create({
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
          <TextInput
            label="Start time"
            hint="HH:MM"
            value={form.startTime}
            onChange={(v) => setForm({ ...form, startTime: v })}
            required
          />
          <TextInput
            label="End time"
            hint="HH:MM"
            value={form.endTime}
            onChange={(v) => setForm({ ...form, endTime: v })}
            required
          />
        </Row>
        <Row>
          <TextInput
            label="Grace minutes"
            type="number"
            value={form.graceMinutes}
            onChange={(v) => setForm({ ...form, graceMinutes: v })}
          />
          <TextInput
            label="Break minutes"
            type="number"
            value={form.breakMinutes}
            onChange={(v) => setForm({ ...form, breakMinutes: v })}
          />
        </Row>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input
            type="checkbox"
            checked={form.nightShift}
            onChange={(e) => setForm({ ...form, nightShift: e.target.checked })}
          />
          Night shift (crosses midnight)
        </label>
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function RosterTab() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    employmentRelationshipId: '',
    shiftId: '',
    effectiveFrom: '',
    effectiveTo: '',
    weeklyOffDays: [0] as number[],
  });

  const { data: employees = [] } = useEmployeeOptions();
  const { data: shifts = [] } = useQuery({
    queryKey: ['time-shifts'],
    queryFn: () => hcmApi.time.shifts.list(),
  });
  const rosters = useQuery({ queryKey: ['time-rosters'], queryFn: () => hcmApi.time.rosters.list() });

  const nameFor = (id: string) => employees.find((e) => e.id === id)?.fullName ?? id;
  const shiftFor = (id: string) => shifts.find((s) => s.id === id)?.name ?? id;

  const toggleOff = (day: number) => {
    setForm((f) => ({
      ...f,
      weeklyOffDays: f.weeklyOffDays.includes(day)
        ? f.weeklyOffDays.filter((d) => d !== day)
        : [...f.weeklyOffDays, day].sort(),
    }));
  };

  const columns: ReadonlyArray<DataTableColumn<TimeRosterRow>> = [
    {
      id: 'employee',
      header: 'Employee',
      sortValue: (r) => nameFor(r.employmentRelationshipId),
      cell: (r) => nameFor(r.employmentRelationshipId),
    },
    { id: 'shift', header: 'Shift', sortValue: (r) => shiftFor(r.shiftId), cell: (r) => shiftFor(r.shiftId) },
    { id: 'from', header: 'From', sortValue: (r) => r.effectiveFrom, cell: (r) => date(r.effectiveFrom) },
    {
      id: 'to',
      header: 'To',
      sortValue: (r) => r.effectiveTo,
      cell: (r) => (r.effectiveTo ? date(r.effectiveTo) : 'Open-ended'),
    },
    {
      id: 'offs',
      header: 'Weekly offs',
      cell: (r) => r.weeklyOffDays.map((d) => WEEKDAY_NAMES[d]).join(', '),
    },
  ];

  return (
    <Card
      title="Roster assignments"
      subtitle="Which shift an employment works, over a date range, with its weekly offs."
      actions={<NewButton label="Assign roster" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Roster assignments"
        columns={columns}
        rows={rosters.data ?? []}
        rowKey={(r) => r.id}
        loading={rosters.isLoading}
        error={rosters.error}
        emptyMessage="No roster assignments yet."
      />

      <CreateModal
        open={open}
        title="Assign a roster"
        onClose={() => setOpen(false)}
        invalidate={[['time-rosters']]}
        onSubmit={() =>
          hcmApi.time.rosters.assign({
            employmentRelationshipId: form.employmentRelationshipId,
            shiftId: form.shiftId,
            effectiveFrom: form.effectiveFrom,
            effectiveTo: form.effectiveTo || null,
            weeklyOffDays: form.weeklyOffDays,
          })
        }
      >
        <SelectInput
          label="Employee"
          value={form.employmentRelationshipId}
          onChange={(v) => setForm({ ...form, employmentRelationshipId: v })}
          required
          placeholder="Select…"
          options={employees.map((e) => ({ value: e.id, label: e.fullName }))}
        />
        <SelectInput
          label="Shift"
          value={form.shiftId}
          onChange={(v) => setForm({ ...form, shiftId: v })}
          required
          placeholder="Select…"
          options={shifts.map((s) => ({ value: s.id, label: `${s.name} (${s.startTime}–${s.endTime})` }))}
        />
        <Row>
          <TextInput
            label="Effective from"
            type="date"
            value={form.effectiveFrom}
            onChange={(v) => setForm({ ...form, effectiveFrom: v })}
            required
          />
          <TextInput
            label="Effective to"
            type="date"
            value={form.effectiveTo}
            onChange={(v) => setForm({ ...form, effectiveTo: v })}
            hint="Optional"
          />
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

function ClockTab() {
  const { data: employees = [] } = useEmployeeOptions();
  const [employmentId, setEmploymentId] = useState('');
  const selected = employmentId || employees[0]?.id || '';

  const events = useQuery({
    queryKey: ['time-clock', selected],
    queryFn: () => hcmApi.time.clock.list(selected),
    enabled: Boolean(selected),
  });

  const columns: ReadonlyArray<DataTableColumn<TimeClockEvent>> = [
    { id: 'when', header: 'When', sortValue: (e) => e.occurredAt, cell: (e) => dateTime(e.occurredAt) },
    {
      id: 'kind',
      header: 'Kind',
      sortValue: (e) => e.kind,
      cell: (e) => <StatusChip status={e.kind} tone={e.kind === 'in' ? 'good' : 'neutral'} />,
    },
    { id: 'source', header: 'Source', sortValue: (e) => e.source, cell: (e) => e.source.replace('_', ' ') },
  ];

  return (
    <Card
      title="Clock events"
      subtitle="The raw punch log a nightly job folds into each day's attendance."
      actions={<EmployeeFilter value={employmentId} onChange={setEmploymentId} employees={employees} />}
    >
      {!selected && <EmptyState message="No employee selected." />}
      <DataTable
        caption="Clock events for the selected employee"
        columns={columns}
        rows={events.data ?? []}
        rowKey={(e) => e.id}
        loading={events.isLoading}
        error={events.error}
        emptyMessage="No clock events recorded for this employee."
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Timesheets
// ---------------------------------------------------------------------------

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
    queryFn: () => hcmApi.time.timesheets.list(employmentId),
  });

  const nameFor = (id: string) => employees.find((e) => e.id === id)?.fullName ?? id;

  const approve = useMutation({
    mutationFn: (id: string) => hcmApi.time.timesheets.approve(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['time-timesheets'] }),
  });
  const reject = useMutation({
    mutationFn: () => hcmApi.time.timesheets.reject(rejecting!, rejectNote),
    onSuccess: () => {
      setRejecting(null);
      setRejectNote('');
      void qc.invalidateQueries({ queryKey: ['time-timesheets'] });
    },
  });

  const columns: ReadonlyArray<DataTableColumn<TimeTimesheet>> = [
    {
      id: 'code',
      header: 'Code',
      sortValue: (t) => t.recordCode,
      cell: (t) => <span className="mono">{t.recordCode}</span>,
    },
    {
      id: 'employee',
      header: 'Employee',
      sortValue: (t) => nameFor(t.employmentRelationshipId),
      cell: (t) => nameFor(t.employmentRelationshipId),
    },
    { id: 'week', header: 'Week of', sortValue: (t) => t.weekStart, cell: (t) => date(t.weekStart) },
    {
      id: 'hours',
      header: 'Hours',
      align: 'right',
      sortValue: (t) => Number(t.totalHours),
      cell: (t) => Number(t.totalHours).toFixed(2),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (t) => t.status,
      cell: (t) => <StatusChip status={t.status} tone={TIMESHEET_TONE[t.status] ?? 'neutral'} />,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (t) =>
        t.status === 'submitted' && (
          <div className="flex justify-end gap-2">
            <button className="btn text-2xs" onClick={() => approve.mutate(t.id)} disabled={approve.isPending}>
              Approve
            </button>
            <button className="btn text-2xs" onClick={() => setRejecting(t.id)}>
              Reject
            </button>
          </div>
        ),
    },
  ];

  return (
    <Card
      title="Timesheets"
      subtitle="Submitted weekly and approved by anyone but the employee who filed them."
      actions={<EmployeeFilter value={employmentId} onChange={setEmploymentId} employees={employees} />}
    >
      <DataTable
        caption="Timesheets"
        columns={columns}
        rows={timesheets.data ?? []}
        rowKey={(t) => t.id}
        loading={timesheets.isLoading}
        error={timesheets.error}
        emptyMessage="No timesheets yet."
      />
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

const OT_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = {
  requested: 'warn',
  approved: 'good',
  rejected: 'bad',
};

function OvertimeTab() {
  const qc = useQueryClient();
  const { data: employees = [] } = useEmployeeOptions();
  const [employmentId, setEmploymentId] = useState('');

  const requests = useQuery({
    queryKey: ['time-overtime', employmentId],
    queryFn: () => hcmApi.time.overtime.list(employmentId),
  });

  const nameFor = (id: string) => employees.find((e) => e.id === id)?.fullName ?? id;

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => hcmApi.time.overtime.decide(id, approve),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['time-overtime'] });
      void qc.invalidateQueries({ queryKey: ['time-compoffs'] });
    },
  });

  const columns: ReadonlyArray<DataTableColumn<TimeOvertimeRow>> = [
    {
      id: 'employee',
      header: 'Employee',
      sortValue: (r) => nameFor(r.employmentRelationshipId),
      cell: (r) => nameFor(r.employmentRelationshipId),
    },
    { id: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => date(r.date) },
    {
      id: 'hours',
      header: 'Hours',
      align: 'right',
      sortValue: (r) => Number(r.hours),
      cell: (r) => Number(r.hours).toFixed(2),
    },
    {
      id: 'reason',
      header: 'Reason',
      cell: (r) => (
        <span className="block max-w-xs truncate" title={r.reason ?? ''}>
          {r.reason ?? '—'}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => <StatusChip status={r.status} tone={OT_TONE[r.status] ?? 'neutral'} />,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) =>
        r.status === 'requested' && (
          <div className="flex justify-end gap-2">
            <button
              className="btn text-2xs"
              onClick={() => decide.mutate({ id: r.id, approve: true })}
              disabled={decide.isPending}
            >
              Approve
            </button>
            <button
              className="btn text-2xs"
              onClick={() => decide.mutate({ id: r.id, approve: false })}
              disabled={decide.isPending}
            >
              Reject
            </button>
          </div>
        ),
    },
  ];

  return (
    <Card
      title="Overtime requests"
      subtitle="Approving one is also what earns the comp-off it comes with."
      actions={<EmployeeFilter value={employmentId} onChange={setEmploymentId} employees={employees} />}
    >
      <DataTable
        caption="Overtime requests"
        columns={columns}
        rows={requests.data ?? []}
        rowKey={(r) => r.id}
        loading={requests.isLoading}
        error={requests.error}
        emptyMessage="No overtime requests yet."
      />
      {decide.error && <ErrorBox error={decide.error} />}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Comp-off
// ---------------------------------------------------------------------------

const COMP_OFF_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = {
  available: 'good',
  consumed: 'neutral',
  expired: 'bad',
};

function CompOffTab() {
  const qc = useQueryClient();
  const { data: employees = [] } = useEmployeeOptions();
  const [employmentId, setEmploymentId] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employmentRelationshipId: '', earnedOn: '', days: '1', note: '' });

  const compOffs = useQuery({
    queryKey: ['time-compoffs', employmentId],
    queryFn: () => hcmApi.time.compOffs.list(employmentId),
  });

  const nameFor = (id: string) => employees.find((e) => e.id === id)?.fullName ?? id;

  const consume = useMutation({
    mutationFn: (id: string) => hcmApi.time.compOffs.consume(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['time-compoffs'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<TimeCompOffRow>> = [
    {
      id: 'employee',
      header: 'Employee',
      sortValue: (c) => nameFor(c.employmentRelationshipId),
      cell: (c) => nameFor(c.employmentRelationshipId),
    },
    { id: 'from', header: 'Earned from', sortValue: (c) => c.earnedFrom, cell: (c) => c.earnedFrom.replace('_', ' ') },
    { id: 'earned', header: 'Earned on', sortValue: (c) => c.earnedOn, cell: (c) => date(c.earnedOn) },
    {
      id: 'days',
      header: 'Days',
      align: 'right',
      sortValue: (c) => Number(c.days),
      cell: (c) => Number(c.days).toFixed(2),
    },
    { id: 'expires', header: 'Expires', sortValue: (c) => c.expiresOn, cell: (c) => date(c.expiresOn) },
    {
      id: 'status',
      header: 'Status',
      sortValue: (c) => c.status,
      cell: (c) => <StatusChip status={c.status} tone={COMP_OFF_TONE[c.status] ?? 'neutral'} />,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (c) =>
        c.status === 'available' && (
          <button className="btn text-2xs" onClick={() => consume.mutate(c.id)} disabled={consume.isPending}>
            Mark consumed
          </button>
        ),
    },
  ];

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
      <DataTable
        caption="Comp-off balances"
        columns={columns}
        rows={compOffs.data ?? []}
        rowKey={(c) => c.id}
        loading={compOffs.isLoading}
        error={compOffs.error}
        emptyMessage="No comp-off records yet."
      />
      {consume.error && <ErrorBox error={consume.error} />}

      <CreateModal
        open={open}
        title="Record comp-off for holiday work"
        onClose={() => setOpen(false)}
        invalidate={[['time-compoffs']]}
        onSubmit={() =>
          hcmApi.time.compOffs.recordHolidayWork({
            employmentRelationshipId: form.employmentRelationshipId,
            earnedOn: form.earnedOn,
            days: Number(form.days),
            note: form.note || null,
          })
        }
      >
        <SelectInput
          label="Employee"
          value={form.employmentRelationshipId}
          onChange={(v) => setForm({ ...form, employmentRelationshipId: v })}
          required
          placeholder="Select…"
          options={employees.map((e) => ({ value: e.id, label: e.fullName }))}
        />
        <Row>
          <TextInput
            label="Day worked"
            type="date"
            value={form.earnedOn}
            onChange={(v) => setForm({ ...form, earnedOn: v })}
            required
          />
          <TextInput
            label="Days earned"
            type="number"
            value={form.days}
            onChange={(v) => setForm({ ...form, days: v })}
            hint="Usually 1"
            required
          />
        </Row>
        <TextArea label="Note" value={form.note} onChange={(v) => setForm({ ...form, note: v })} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Regularisations
// ---------------------------------------------------------------------------

const REG_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = {
  submitted: 'warn',
  approved: 'good',
  rejected: 'bad',
};

function RegularisationsTab() {
  const qc = useQueryClient();
  const { data: employees = [] } = useEmployeeOptions();
  const [employmentId, setEmploymentId] = useState('');
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  const rows = useQuery({
    queryKey: ['time-regularisations', employmentId],
    queryFn: () => hcmApi.time.regularisations.list(employmentId),
  });

  const nameFor = (id: string) => employees.find((e) => e.id === id)?.fullName ?? id;

  const approve = useMutation({
    mutationFn: (id: string) => hcmApi.time.regularisations.approve(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['time-regularisations'] }),
  });
  const reject = useMutation({
    mutationFn: () => hcmApi.time.regularisations.reject(rejecting!, rejectNote),
    onSuccess: () => {
      setRejecting(null);
      setRejectNote('');
      void qc.invalidateQueries({ queryKey: ['time-regularisations'] });
    },
  });

  const columns: ReadonlyArray<DataTableColumn<TimeRegularisationRow>> = [
    {
      id: 'employee',
      header: 'Employee',
      sortValue: (r) => nameFor(r.employmentRelationshipId),
      cell: (r) => nameFor(r.employmentRelationshipId),
    },
    { id: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => date(r.date) },
    {
      id: 'reason',
      header: 'Reason',
      cell: (r) => (
        <span className="block max-w-xs truncate" title={r.reason}>
          {r.reason}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => <StatusChip status={r.status} tone={REG_TONE[r.status] ?? 'neutral'} />,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) =>
        r.status === 'submitted' && (
          <div className="flex justify-end gap-2">
            <button className="btn text-2xs" onClick={() => approve.mutate(r.id)} disabled={approve.isPending}>
              Approve
            </button>
            <button className="btn text-2xs" onClick={() => setRejecting(r.id)}>
              Reject
            </button>
          </div>
        ),
    },
  ];

  return (
    <Card
      title="Attendance regularisations"
      subtitle="Submitting one disputes the day; approving it regularises the same WorkAttendance row."
      actions={<EmployeeFilter value={employmentId} onChange={setEmploymentId} employees={employees} />}
    >
      <DataTable
        caption="Attendance regularisations"
        columns={columns}
        rows={rows.data ?? []}
        rowKey={(r) => r.id}
        loading={rows.isLoading}
        error={rows.error}
        emptyMessage="No regularisation requests yet."
      />
      {approve.error && <ErrorBox error={approve.error} />}

      <CreateModal
        open={Boolean(rejecting)}
        title="Reject this request"
        submitLabel="Reject"
        onClose={() => setRejecting(null)}
        onSubmit={() => reject.mutateAsync()}
      >
        <TextArea label="Reason" value={rejectNote} onChange={setRejectNote} required />
      </CreateModal>
    </Card>
  );
}
