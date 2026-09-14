/**
 * Labour — F. Labour law and conduct (docs/plan/compliance.md).
 *
 * Seven tabs, one per thing this workstream carries: holidays, the leave
 * year-end run and encashment, working-hours breaches and overtime accrual,
 * statutory register downloads, POSH (committee, complaints, annual report —
 * complaints visible only to a holder of the grant), disciplinary cases, and
 * the letters a hire or an exit issues. Nothing here transmits a filing or a
 * return; it prepares and, where the plan names one, files what this
 * platform can honestly record.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, dateTime } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Field, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, messageOf, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

type Tab = 'holidays' | 'leave' | 'hours' | 'registers' | 'posh' | 'disciplinary' | 'letters';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'holidays', label: 'Holidays' },
  { key: 'leave', label: 'Leave year-end' },
  { key: 'hours', label: 'Hours' },
  { key: 'registers', label: 'Registers' },
  { key: 'posh', label: 'POSH' },
  { key: 'disciplinary', label: 'Disciplinary' },
  { key: 'letters', label: 'Letters' },
];

export function ComplianceLabour() {
  const [tab, setTab] = useState<Tab>('holidays');

  return (
    <>
      <PageHeader
        title="Labour"
        subtitle="Holidays, leave carry-forward and encashment, working-hours caps, statutory registers, POSH, disciplinary cases and letters. This screen prepares and records — it does not file the POSH annual report with the District Officer or any other portal on its own."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'holidays' && <HolidaysTab />}
      {tab === 'leave' && <LeaveTab />}
      {tab === 'hours' && <HoursTab />}
      {tab === 'registers' && <RegistersTab />}
      {tab === 'posh' && <PoshTab />}
      {tab === 'disciplinary' && <DisciplinaryTab />}
      {tab === 'letters' && <LettersTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

interface Holiday {
  id: string;
  date: string;
  name: string;
  kind: string;
  state: string | null;
  note: string | null;
}

function HolidaysTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: '', name: '', kind: 'national' as 'national' | 'state' | 'restricted', state: '', note: '' });

  const holidays = useQuery({ queryKey: ['labour-holidays'], queryFn: () => api.get<Holiday[]>('/compliance/labour/holidays') });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/compliance/labour/holidays/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['labour-holidays'] }),
  });

  return (
    <Card
      title="Holidays"
      subtitle="Fixed national holidays plus whatever the state notifies through the year."
      actions={<NewButton label="Add holiday" onClick={() => setOpen(true)} />}
    >
      {holidays.isLoading && <Loading />}
      {holidays.error && <ErrorBox error={holidays.error} />}
      {holidays.data && holidays.data.length === 0 && <EmptyState message="No holidays recorded for this year yet." />}
      {holidays.data && holidays.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Name</th>
              <th>Kind</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {holidays.data.map((h) => (
              <tr key={h.id}>
                <td>{date(h.date)}</td>
                <td>
                  {h.name}
                  {h.note && <p className="text-2xs text-ink-500">{h.note}</p>}
                </td>
                <td><StatusChip status={h.kind} /></td>
                <td>{h.state ?? '—'}</td>
                <td className="text-right">
                  <button className="btn text-2xs" onClick={() => remove.mutate(h.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Add a holiday"
        onClose={() => setOpen(false)}
        invalidate={[['labour-holidays']]}
        onSubmit={() =>
          api.post('/compliance/labour/holidays', {
            date: form.date,
            name: form.name,
            kind: form.kind,
            state: form.state || undefined,
            note: form.note || undefined,
          })
        }
      >
        <Row>
          <TextInput label="Date" type="date" value={form.date} onChange={(v) => setForm({ ...form, date: v })} required />
          <SelectInput
            label="Kind"
            value={form.kind}
            onChange={(v) => setForm({ ...form, kind: v })}
            options={[
              { value: 'national', label: 'National' },
              { value: 'state', label: 'State' },
              { value: 'restricted', label: 'Restricted' },
            ]}
          />
        </Row>
        <TextInput label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <TextInput label="State (if not national)" value={form.state} onChange={(v) => setForm({ ...form, state: v })} placeholder="TN" />
        <TextArea label="Note" value={form.note} onChange={(v) => setForm({ ...form, note: v })} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Leave year-end
// ---------------------------------------------------------------------------

function LeaveTab() {
  const [result, setResult] = useState<{ processed: number; notified: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [encashForm, setEncashForm] = useState({ employmentId: '', leaveTypeId: '', days: '' });
  const [encashResult, setEncashResult] = useState<string | null>(null);

  const runClose = useMutation({
    mutationFn: () => api.post<{ processed: number; notified: number }>('/compliance/labour/leave/year-close/run'),
    onSuccess: (r) => {
      setResult(r);
      setError(null);
    },
    onError: (e) => setError(messageOf(e)),
  });

  const encash = useMutation({
    mutationFn: () =>
      api.post<{ encashment: { days: number; amount: number } }>(`/compliance/labour/leave/${encashForm.employmentId}/encash`, {
        leaveTypeId: encashForm.leaveTypeId,
        days: Number(encashForm.days),
      }),
    onSuccess: (r) => setEncashResult(`Encashed ${r.encashment.days} days for ₹${r.encashment.amount}.`),
    onError: (e) => setError(messageOf(e)),
  });

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Carry-forward and lapse (1 April)"
        subtitle="Per leave type carrying a cap, every balance above it is trimmed and the excess lapsed. Idempotent — a second run in the same financial year does nothing."
      >
        {error && <ErrorBox error={error} />}
        <button className="btn-primary" onClick={() => runClose.mutate()} disabled={runClose.isPending}>
          {runClose.isPending ? 'Running…' : 'Run year-end close now'}
        </button>
        {result && (
          <p className="mt-3 text-sm text-ink-300">
            {result.processed} balance{result.processed === 1 ? '' : 's'} closed, {result.notified} exception{result.notified === 1 ? '' : 's'} raised.
          </p>
        )}
      </Card>

      <Card title="Encash leave" subtitle="Encashable leave types only, up to the type's maximum encashable days. Amount is basic/26 × days.">
        <Row>
          <TextInput label="Employment ID" value={encashForm.employmentId} onChange={(v) => setEncashForm({ ...encashForm, employmentId: v })} required />
          <TextInput label="Leave type ID" value={encashForm.leaveTypeId} onChange={(v) => setEncashForm({ ...encashForm, leaveTypeId: v })} required />
        </Row>
        <TextInput label="Days" type="number" value={encashForm.days} onChange={(v) => setEncashForm({ ...encashForm, days: v })} required />
        <button className="btn-primary mt-3" onClick={() => encash.mutate()} disabled={encash.isPending}>
          {encash.isPending ? 'Encashing…' : 'Encash'}
        </button>
        {encashResult && <p className="mt-3 text-sm text-ink-300">{encashResult}</p>}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

function HoursTab() {
  const [result, setResult] = useState<{ processed: number; notified: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [employmentId, setEmploymentId] = useState('');

  const runCheck = useMutation({
    mutationFn: () => api.post<{ processed: number; notified: number }>('/compliance/labour/hours/check/run'),
    onSuccess: (r) => {
      setResult(r);
      setError(null);
    },
    onError: (e) => setError(messageOf(e)),
  });

  const overtime = useQuery({
    queryKey: ['labour-overtime', employmentId],
    queryFn: () => api.get<Array<{ isoWeek: string; hours: number; rate: number; amount: number }>>(`/compliance/labour/hours/${employmentId}/overtime`),
    enabled: employmentId.length > 0,
  });

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Weekly hours cap check"
        subtitle="Sums last week's attendance per employment against the weekly cap; a breach raises an exception rather than posting overtime silently."
      >
        {error && <ErrorBox error={error} />}
        <button className="btn-primary" onClick={() => runCheck.mutate()} disabled={runCheck.isPending}>
          {runCheck.isPending ? 'Running…' : 'Run hours check now'}
        </button>
        {result && (
          <p className="mt-3 text-sm text-ink-300">
            {result.processed} employment{result.processed === 1 ? '' : 's'} checked, {result.notified} breach{result.notified === 1 ? '' : 'es'} raised.
          </p>
        )}
      </Card>

      <Card title="Overtime accrual" subtitle="Hours × 2 × basic/(26×8), by ISO week.">
        <TextInput label="Employment ID" value={employmentId} onChange={setEmploymentId} placeholder="Paste an employment relationship id" />
        {overtime.isLoading && employmentId && <Loading />}
        {overtime.data && overtime.data.length === 0 && <EmptyState message="No overtime accrued for this employment yet." />}
        {overtime.data && overtime.data.length > 0 && (
          <table className="table mt-3">
            <thead>
              <tr>
                <th>Week</th>
                <th>Hours</th>
                <th>Rate</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {overtime.data.map((r) => (
                <tr key={r.isoWeek}>
                  <td>{r.isoWeek}</td>
                  <td>{r.hours}</td>
                  <td>₹{r.rate.toFixed(2)}</td>
                  <td>₹{r.amount.toFixed(2)}</td>
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
// Registers
// ---------------------------------------------------------------------------

function RegistersTab() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [fy, setFy] = useState('');
  const [error, setError] = useState<string | null>(null);

  const download = async (path: string, name: string) => {
    try {
      await api.download(path, name);
      setError(null);
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <Card title="Statutory registers" subtitle="Each downloads as a CSV under the register's statutory name, and each download is itself audited.">
      {error && <ErrorBox error={error} />}
      <div className="flex flex-col gap-4">
        <Field label="Wages register">
          <div className="flex flex-wrap items-center gap-2">
            <input className="input w-40" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
            <button className="btn" onClick={() => download(`/compliance/labour/registers/wages?period=${period}`, `wages-${period}.csv`)}>
              Download
            </button>
          </div>
        </Field>
        <Field label="Leave register">
          <div className="flex flex-wrap items-center gap-2">
            <input className="input w-40" placeholder="FY2026-27" value={fy} onChange={(e) => setFy(e.target.value)} />
            <button className="btn" onClick={() => download(`/compliance/labour/registers/leave?fy=${fy}`, `leave-${fy}.csv`)}>
              Download
            </button>
          </div>
        </Field>
        <Field label="Muster roll">
          <div className="flex flex-wrap items-center gap-2">
            <input className="input w-40" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
            <button className="btn" onClick={() => download(`/compliance/labour/registers/muster-roll?period=${period}`, `muster-roll-${period}.csv`)}>
              Download
            </button>
          </div>
        </Field>
        <Field label="Employees register (Form Q-like)">
          <button className="btn" onClick={() => download('/compliance/labour/registers/employees', 'employees.csv')}>
            Download
          </button>
        </Field>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// POSH
// ---------------------------------------------------------------------------

interface IccMember {
  id: string;
  role: string;
  isWoman: boolean;
  externalName: string | null;
  appointedOn: string;
  termEnds: string | null;
}

interface PoshComplaint {
  id: string;
  number: string;
  status: string;
  receivedOn: string;
  inquiryDueAt: string;
}

function PoshTab() {
  const qc = useQueryClient();
  const [memberOpen, setMemberOpen] = useState(false);
  const [complaintOpen, setComplaintOpen] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear());
  const [memberForm, setMemberForm] = useState({ role: 'member' as 'presiding' | 'member' | 'external', externalName: '', isWoman: false, appointedOn: '' });
  const [complaintForm, setComplaintForm] = useState({ complainantText: '', respondentText: '', receivedOn: '' });

  const members = useQuery({ queryKey: ['posh-members'], queryFn: () => api.get<IccMember[]>('/compliance/labour/posh/committee') });
  const validation = useQuery({
    queryKey: ['posh-validate'],
    queryFn: () => api.post<{ compliant: boolean; missing: string[] }>('/compliance/labour/posh/committee/validate'),
  });
  const complaints = useQuery({
    queryKey: ['posh-complaints'],
    queryFn: () => api.get<PoshComplaint[]>('/compliance/labour/posh/complaints'),
    retry: false,
  });
  const report = useQuery({
    queryKey: ['posh-report', year],
    queryFn: () =>
      api.get<{ snapshot: { received: number; disposed: number; pending: number; pendingOver90Days: number; workshopsHeld: number }; status: string }>(
        `/compliance/labour/posh/annual-report/${year}`,
      ),
  });

  return (
    <div className="flex flex-col gap-4">
      <Card title="Internal Committee" actions={<NewButton label="Add member" onClick={() => setMemberOpen(true)} />}>
        {validation.data && (
          <div className={`mb-3 rounded border px-3 py-2 text-sm ${validation.data.compliant ? 'border-band-strong/40 text-band-strong' : 'border-band-critical/40 text-band-critical'}`}>
            {validation.data.compliant ? 'The committee meets the POSH Act Sec 4(2) composition.' : (
              <ul className="list-disc pl-4">
                {validation.data.missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {members.isLoading && <Loading />}
        {members.data && members.data.length === 0 && <EmptyState message="No committee members appointed yet." />}
        {members.data && members.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Name</th>
                <th>Woman</th>
                <th>Appointed</th>
                <th>Term ends</th>
              </tr>
            </thead>
            <tbody>
              {members.data.map((m) => (
                <tr key={m.id}>
                  <td><StatusChip status={m.role} /></td>
                  <td>{m.externalName ?? m.id}</td>
                  <td>{m.isWoman ? 'Yes' : 'No'}</td>
                  <td>{date(m.appointedOn)}</td>
                  <td>{m.termEnds ? date(m.termEnds) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <CreateModal
          open={memberOpen}
          title="Add a committee member"
          onClose={() => setMemberOpen(false)}
          invalidate={[['posh-members'], ['posh-validate']]}
          onSubmit={() => api.post('/compliance/labour/posh/committee', memberForm)}
        >
          <SelectInput
            label="Role"
            value={memberForm.role}
            onChange={(v) => setMemberForm({ ...memberForm, role: v })}
            options={[
              { value: 'presiding', label: 'Presiding officer' },
              { value: 'member', label: 'Member' },
              { value: 'external', label: 'External member' },
            ]}
          />
          <TextInput label="Name" value={memberForm.externalName} onChange={(v) => setMemberForm({ ...memberForm, externalName: v })} required />
          <label className="mt-2 flex items-center gap-2 text-sm text-ink-300">
            <input type="checkbox" checked={memberForm.isWoman} onChange={(e) => setMemberForm({ ...memberForm, isWoman: e.target.checked })} />
            Woman
          </label>
          <TextInput label="Appointed on" type="date" value={memberForm.appointedOn} onChange={(v) => setMemberForm({ ...memberForm, appointedOn: v })} required />
        </CreateModal>
      </Card>

      <Card title="Complaints" subtitle="Visible only to a holder of posh_cases:view. Never counted anywhere else." actions={<NewButton label="Record complaint" onClick={() => setComplaintOpen(true)} />}>
        {complaints.error && <EmptyState message="Not visible from this account — POSH complaints need posh_cases:view." />}
        {complaints.data && complaints.data.length === 0 && <EmptyState message="No complaints recorded." />}
        {complaints.data && complaints.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Received</th>
                <th>Status</th>
                <th>Inquiry due</th>
              </tr>
            </thead>
            <tbody>
              {complaints.data.map((c) => (
                <tr key={c.id}>
                  <td>{c.number}</td>
                  <td>{date(c.receivedOn)}</td>
                  <td><StatusChip status={c.status} /></td>
                  <td>{date(c.inquiryDueAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <CreateModal
          open={complaintOpen}
          title="Record a POSH complaint"
          onClose={() => setComplaintOpen(false)}
          invalidate={[['posh-complaints']]}
          onSubmit={() => api.post('/compliance/labour/posh/complaints', complaintForm)}
        >
          <TextArea label="Complainant" value={complaintForm.complainantText} onChange={(v) => setComplaintForm({ ...complaintForm, complainantText: v })} required />
          <TextArea label="Respondent" value={complaintForm.respondentText} onChange={(v) => setComplaintForm({ ...complaintForm, respondentText: v })} required />
          <TextInput label="Received on" type="date" value={complaintForm.receivedOn} onChange={(v) => setComplaintForm({ ...complaintForm, receivedOn: v })} required />
        </CreateModal>
      </Card>

      <Card title="Annual report" subtitle="POSH Act Sec 21 — a snapshot for the year, prepared here and filed once ready.">
        <div className="mb-3 flex items-center gap-2">
          <input className="input w-28" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          <button className="btn" onClick={() => qc.invalidateQueries({ queryKey: ['posh-report', year] })}>
            Refresh
          </button>
        </div>
        {report.data && (
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Field label="Received">{report.data.snapshot.received}</Field>
            <Field label="Disposed">{report.data.snapshot.disposed}</Field>
            <Field label="Pending">{report.data.snapshot.pending}</Field>
            <Field label="Pending > 90 days">{report.data.snapshot.pendingOver90Days}</Field>
            <Field label="Workshops held">{report.data.snapshot.workshopsHeld}</Field>
          </dl>
        )}
        {report.data && <p className="mt-3 text-2xs text-ink-500">Status: {report.data.status}</p>}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Disciplinary
// ---------------------------------------------------------------------------

interface DisciplinaryCase {
  id: string;
  employmentRelationshipId: string;
  employmentFullName: string | null;
  employmentRecordCode: string | null;
  status: string;
  showCauseIssuedAt: string;
  replyDueAt: string;
  outcome: string | null;
}

function DisciplinaryTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employmentRelationshipId: '', note: '' });

  const cases = useQuery({ queryKey: ['disciplinary-cases'], queryFn: () => api.get<DisciplinaryCase[]>('/compliance/labour/disciplinary') });

  return (
    <Card title="Disciplinary cases" subtitle="Show-cause, reply, inquiry, decision, close. Evidence recorded at each step becomes part of that person's record." actions={<NewButton label="Open case" onClick={() => setOpen(true)} />}>
      {cases.isLoading && <Loading />}
      {cases.data && cases.data.length === 0 && <EmptyState message="No disciplinary cases open." />}
      {cases.data && cases.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Employment</th>
              <th>Status</th>
              <th>Show-cause issued</th>
              <th>Reply due</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {cases.data.map((c) => (
              <tr key={c.id}>
                <td className="text-2xs" title={c.employmentRecordCode ?? c.employmentRelationshipId}>
                  {c.employmentFullName ?? c.employmentRelationshipId}
                </td>
                <td><StatusChip status={c.status} /></td>
                <td>{dateTime(c.showCauseIssuedAt)}</td>
                <td>{dateTime(c.replyDueAt)}</td>
                <td>{c.outcome ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CreateModal
        open={open}
        title="Open a disciplinary case"
        onClose={() => setOpen(false)}
        invalidate={[['disciplinary-cases']]}
        onSubmit={() => api.post('/compliance/labour/disciplinary', form)}
      >
        <TextInput label="Employment ID" value={form.employmentRelationshipId} onChange={(v) => setForm({ ...form, employmentRelationshipId: v })} required />
        <TextArea label="Show-cause note" value={form.note} onChange={(v) => setForm({ ...form, note: v })} required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

interface HrLetter {
  id: string;
  kind: string;
  number: string;
  issuedAt: string;
}

function LettersTab() {
  const [employmentId, setEmploymentId] = useState('');
  const [viewing, setViewing] = useState<{ number: string; snapshot: { body: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const letters = useQuery({
    queryKey: ['labour-letters', employmentId],
    queryFn: () => api.get<HrLetter[]>(`/compliance/labour/letters?employmentId=${employmentId}`),
    enabled: employmentId.length > 0,
  });

  const view = async (id: string) => {
    try {
      const doc = await api.get<{ number: string; snapshot: { body: string } }>(`/compliance/labour/letters/${id}/document`);
      setViewing(doc);
      setError(null);
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <Card
      title="Letters"
      subtitle="Offer, appointment, confirmation, relieving, experience, warning. Final once issued — a correction is a new letter, never an edit. Appointment letters issue automatically when an offer is accepted; relieving and experience letters issue automatically on offboarding."
    >
      <TextInput label="Employment ID" value={employmentId} onChange={setEmploymentId} placeholder="Paste an employment relationship id" />
      {error && <ErrorBox error={error} />}
      {letters.isLoading && employmentId && <Loading />}
      {letters.data && letters.data.length === 0 && <EmptyState message="No letters issued for this employment yet." />}
      {letters.data && letters.data.length > 0 && (
        <table className="table mt-3">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Number</th>
              <th>Issued</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {letters.data.map((l) => (
              <tr key={l.id}>
                <td><StatusChip status={l.kind} /></td>
                <td>{l.number}</td>
                <td>{dateTime(l.issuedAt)}</td>
                <td className="text-right">
                  <button className="btn text-2xs" onClick={() => view(l.id)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {viewing && (
        <div className="mt-4 rounded border border-ink-700 bg-ink-900 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-2xs uppercase tracking-wide text-ink-500">{viewing.number}</span>
            <button className="btn text-2xs" onClick={() => setViewing(null)}>
              Close
            </button>
          </div>
          <pre className="whitespace-pre-wrap text-sm text-ink-200">{viewing.snapshot.body}</pre>
        </div>
      )}
    </Card>
  );
}
