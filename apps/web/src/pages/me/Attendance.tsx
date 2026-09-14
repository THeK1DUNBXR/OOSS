/**
 * My attendance — G2 (docs/hcm/time.md).
 *
 * Clock in/out, this week's timesheet with an entry form and a submit
 * button, my overtime requests, my comp-off balance, and a way to raise a
 * regularisation on a day that needs one.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, dateTime } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, Metric, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, NewButton, Row, TextArea, TextInput } from '../../components/forms.js';

interface ClockEventRow {
  id: string;
  kind: 'in' | 'out';
  occurredAt: string;
  source: string;
}

interface TimesheetRow {
  id: string;
  recordCode: string;
  weekStart: string;
  status: string;
  totalHours: string | number;
}

interface TimesheetDetail extends TimesheetRow {
  entries: Array<{ id: string; date: string; projectId: string | null; taskRef: string | null; hours: string | number; billable: boolean }>;
}

interface OvertimeRow {
  id: string;
  date: string;
  hours: string | number;
  reason: string | null;
  status: string;
}

interface CompOffRow {
  id: string;
  earnedOn: string;
  days: string | number;
  expiresOn: string;
  status: string;
}

interface RegularisationRow {
  id: string;
  date: string;
  reason: string;
  status: string;
}

const TIMESHEET_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { draft: 'neutral', submitted: 'warn', approved: 'good', rejected: 'bad' };
const OT_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { requested: 'warn', approved: 'good', rejected: 'bad' };
const COMP_OFF_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { available: 'good', consumed: 'neutral', expired: 'bad' };
const REG_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { submitted: 'warn', approved: 'good', rejected: 'bad' };

export function Attendance() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="My attendance" subtitle="Clock in and out, fill in this week's timesheet, request overtime, and see your comp-off balance." />
      <ClockCard />
      <div className="grid gap-4 lg:grid-cols-2">
        <TimesheetCard />
        <OvertimeCard />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CompOffCard />
        <RegularisationCard />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

function ClockCard() {
  const qc = useQueryClient();

  const events = useQuery({
    queryKey: ['my-clock'],
    queryFn: () => api.get<ClockEventRow[]>('/hcm/time/clock/mine'),
  });

  const punch = useMutation({
    mutationFn: (kind: 'in' | 'out') => api.post(`/hcm/time/clock/mine/${kind}`, { source: 'web' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['my-clock'] }),
  });

  const today = new Date().toISOString().slice(0, 10);
  const todaysEvents = (events.data ?? []).filter((e) => e.occurredAt.slice(0, 10) === today);
  const last = (events.data ?? [])[events.data && events.data.length ? events.data.length - 1 : 0];
  const clockedIn = last?.kind === 'in';

  return (
    <Card
      title="Clock"
      subtitle="One in, one out — the pair becomes today's worked hours once the nightly job reads the roster."
      actions={
        <div className="flex gap-2">
          <button className="btn-primary" disabled={clockedIn || punch.isPending} onClick={() => punch.mutate('in')}>
            Clock in
          </button>
          <button className="btn" disabled={!clockedIn || punch.isPending} onClick={() => punch.mutate('out')}>
            Clock out
          </button>
        </div>
      }
    >
      {punch.error && <ErrorBox error={punch.error} />}
      {events.isLoading && <Loading />}
      {events.error && <ErrorBox error={events.error} />}
      {!events.isLoading && todaysEvents.length === 0 && <EmptyState message="No punches yet today." />}
      {todaysEvents.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-ink-300">
          {todaysEvents.map((e) => (
            <li key={e.id} className="flex items-center gap-2">
              <StatusChip status={e.kind} tone={e.kind === 'in' ? 'good' : 'neutral'} />
              {dateTime(e.occurredAt)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Timesheet
// ---------------------------------------------------------------------------

function TimesheetCard() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), projectId: '', taskRef: '', hours: '8', note: '' });

  const timesheets = useQuery({ queryKey: ['my-timesheets'], queryFn: () => api.get<TimesheetRow[]>('/hcm/time/timesheets/mine') });
  const current = timesheets.data?.[0];

  const detail = useQuery({
    queryKey: ['my-timesheet', current?.id],
    queryFn: () => api.get<TimesheetDetail>(`/hcm/time/timesheets/${current!.id}`),
    enabled: Boolean(current?.id),
  });

  const submit = useMutation({
    mutationFn: () => api.post(`/hcm/time/timesheets/${current!.id}/submit`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-timesheets'] });
      void qc.invalidateQueries({ queryKey: ['my-timesheet'] });
    },
  });

  const removeEntry = useMutation({
    mutationFn: (id: string) => api.del(`/hcm/time/timesheets/entries/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-timesheets'] });
      void qc.invalidateQueries({ queryKey: ['my-timesheet'] });
    },
  });

  const editable = !current || current.status === 'draft' || current.status === 'rejected';

  return (
    <Card
      title="This week's timesheet"
      subtitle={current ? `Week of ${date(current.weekStart)}` : 'No entries logged this week yet.'}
      actions={editable ? <NewButton label="Add entry" onClick={() => setOpen(true)} /> : undefined}
    >
      {timesheets.isLoading && <Loading />}
      {timesheets.error && <ErrorBox error={timesheets.error} />}
      {submit.error && <ErrorBox error={submit.error} />}

      {current && (
        <div className="mb-3 flex items-center justify-between">
          <StatusChip status={current.status} tone={TIMESHEET_TONE[current.status] ?? 'neutral'} />
          <span className="text-sm tabular-nums text-ink-300">{Number(current.totalHours).toFixed(2)} h</span>
        </div>
      )}

      {detail.data && detail.data.entries.length === 0 && <EmptyState message="No entries yet." hint="Add an entry, then submit for approval." />}
      {detail.data && detail.data.entries.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Task</th>
              <th>Hours</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {detail.data.entries.map((e) => (
              <tr key={e.id}>
                <td>{date(e.date)}</td>
                <td>{e.taskRef ?? '—'}</td>
                <td className="tabular-nums">{Number(e.hours).toFixed(2)}</td>
                {editable && (
                  <td className="text-right">
                    <button className="btn text-2xs" onClick={() => removeEntry.mutate(e.id)}>
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {current && current.status !== 'submitted' && current.status !== 'approved' && (
        <div className="mt-3">
          <button className="btn-primary" onClick={() => submit.mutate()} disabled={submit.isPending || !detail.data?.entries.length}>
            Submit for approval
          </button>
        </div>
      )}

      <CreateModal
        open={open}
        title="Add a timesheet entry"
        onClose={() => setOpen(false)}
        invalidate={[['my-timesheets'], ['my-timesheet']]}
        onSubmit={() =>
          api.post('/hcm/time/timesheets/entries', {
            date: form.date,
            projectId: form.projectId || null,
            taskRef: form.taskRef || null,
            hours: Number(form.hours),
            note: form.note || null,
          })
        }
      >
        <Row>
          <TextInput label="Date" type="date" value={form.date} onChange={(v) => setForm({ ...form, date: v })} required />
          <TextInput label="Hours" type="number" value={form.hours} onChange={(v) => setForm({ ...form, hours: v })} required />
        </Row>
        <TextInput label="Task" value={form.taskRef} onChange={(v) => setForm({ ...form, taskRef: v })} hint="Optional" />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Overtime
// ---------------------------------------------------------------------------

function OvertimeCard() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: '', hours: '2', reason: '' });

  const requests = useQuery({ queryKey: ['my-overtime'], queryFn: () => api.get<OvertimeRow[]>('/hcm/time/overtime/mine') });

  return (
    <Card title="My overtime requests" subtitle="Pre-approval before working overtime — approval is also what earns the comp-off." actions={<NewButton label="Request overtime" onClick={() => setOpen(true)} />}>
      {requests.isLoading && <Loading />}
      {requests.error && <ErrorBox error={requests.error} />}
      {requests.data && requests.data.length === 0 && <EmptyState message="No overtime requests yet." />}
      {requests.data && requests.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Hours</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {requests.data.map((r) => (
              <tr key={r.id}>
                <td>{date(r.date)}</td>
                <td className="tabular-nums">{Number(r.hours).toFixed(2)}</td>
                <td><StatusChip status={r.status} tone={OT_TONE[r.status] ?? 'neutral'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Request overtime"
        onClose={() => setOpen(false)}
        invalidate={[['my-overtime']]}
        onSubmit={() => api.post('/hcm/time/overtime', { date: form.date, hours: Number(form.hours), reason: form.reason || null })}
      >
        <Row>
          <TextInput label="Date" type="date" value={form.date} onChange={(v) => setForm({ ...form, date: v })} required />
          <TextInput label="Hours" type="number" value={form.hours} onChange={(v) => setForm({ ...form, hours: v })} required />
        </Row>
        <TextArea label="Reason" value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Comp-off
// ---------------------------------------------------------------------------

function CompOffCard() {
  const compOffs = useQuery({ queryKey: ['my-compoffs'], queryFn: () => api.get<CompOffRow[]>('/hcm/time/comp-offs/mine') });

  const available = (compOffs.data ?? []).filter((c) => c.status === 'available');
  const balance = available.reduce((s, c) => s + Number(c.days), 0);

  return (
    <Card
      title="My comp-off"
      subtitle="Earned from approved overtime or filed holiday work; expires 90 days after it's earned. HR marks a day consumed."
    >
      <Metric label="Available" value={balance.toFixed(2)} sub="days" noActionReason={available.length === 0 ? 'Nothing to use yet.' : undefined} />
      {compOffs.isLoading && <Loading />}
      {compOffs.error && <ErrorBox error={compOffs.error} />}
      {compOffs.data && compOffs.data.length === 0 && <EmptyState message="No comp-off records yet." />}
      {compOffs.data && compOffs.data.length > 0 && (
        <table className="table mt-3">
          <thead>
            <tr>
              <th>Earned on</th>
              <th>Days</th>
              <th>Expires</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {compOffs.data.map((c) => (
              <tr key={c.id}>
                <td>{date(c.earnedOn)}</td>
                <td className="tabular-nums">{Number(c.days).toFixed(2)}</td>
                <td>{date(c.expiresOn)}</td>
                <td><StatusChip status={c.status} tone={COMP_OFF_TONE[c.status] ?? 'neutral'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Regularisation
// ---------------------------------------------------------------------------

function RegularisationCard() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: '', reason: '' });

  const rows = useQuery({ queryKey: ['my-regularisations'], queryFn: () => api.get<RegularisationRow[]>('/hcm/time/regularisations/mine') });

  return (
    <Card title="My regularisations" subtitle="Raise this for a day with a missed punch or a wrong one — it disputes the day until HR decides." actions={<NewButton label="Raise a regularisation" onClick={() => setOpen(true)} />}>
      {rows.isLoading && <Loading />}
      {rows.error && <ErrorBox error={rows.error} />}
      {rows.data && rows.data.length === 0 && <EmptyState message="No regularisation requests yet." />}
      {rows.data && rows.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Reason</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.data.map((r) => (
              <tr key={r.id}>
                <td>{date(r.date)}</td>
                <td className="max-w-xs truncate" title={r.reason}>{r.reason}</td>
                <td><StatusChip status={r.status} tone={REG_TONE[r.status] ?? 'neutral'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Raise a regularisation"
        onClose={() => setOpen(false)}
        invalidate={[['my-regularisations']]}
        onSubmit={() => api.post('/hcm/time/regularisations', { date: form.date, reason: form.reason })}
      >
        <TextInput label="Date" type="date" value={form.date} onChange={(v) => setForm({ ...form, date: v })} required />
        <TextArea label="Reason" value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} required />
      </CreateModal>
    </Card>
  );
}
