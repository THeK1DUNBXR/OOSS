/**
 * Payroll ops (docs/hcm/payrollops.md, workstream WS8).
 *
 * Eight tabs, one per thing this workstream carries around a run once
 * `people/payroll` (Canon §14) has drafted and approved it: the calendar the
 * period runs against, the components pay is built from, the ad-hoc lines
 * and arrears somebody proposed for it, the reconciliation that catches an
 * unexplained swing before disbursal, the double-entry journal, the bank
 * file, and the questions employees raise about their own payslips.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, dateTime, money, relative } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, messageOf, MoneyInput, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

type Tab = 'calendar' | 'pay-items' | 'adhoc' | 'arrears' | 'reconciliation' | 'journal' | 'bank-advice' | 'queries';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'pay-items', label: 'Pay items' },
  { key: 'adhoc', label: 'Ad-hoc pay' },
  { key: 'arrears', label: 'Arrears' },
  { key: 'reconciliation', label: 'Reconciliation' },
  { key: 'journal', label: 'Journal' },
  { key: 'bank-advice', label: 'Bank advice' },
  { key: 'queries', label: 'Queries' },
];

export function PayrollOps() {
  const [tab, setTab] = useState<Tab>('calendar');
  return (
    <>
      <PageHeader
        title="Payroll ops"
        subtitle="What happens around a run once people/payroll has drafted and approved it: ad-hoc lines and arrears, the double-entry journal, the bank file, a reconciliation before the money leaves, and payslip questions. This screen does not open, compute or approve a run itself — that is Payroll under People."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'calendar' && <CalendarTab />}
      {tab === 'pay-items' && <PayItemsTab />}
      {tab === 'adhoc' && <AdHocTab />}
      {tab === 'arrears' && <ArrearsTab />}
      {tab === 'reconciliation' && <ReconciliationTab />}
      {tab === 'journal' && <JournalTab />}
      {tab === 'bank-advice' && <BankAdviceTab />}
      {tab === 'queries' && <QueriesTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared: the run picker every run-scoped tab uses.
// ---------------------------------------------------------------------------

interface PayrollRunRow {
  id: string;
  recordCode: string;
  payPeriod: string;
  status: string;
  headcount: number;
  grossTotal: number | null;
  netTotal: number | null;
}

function useRuns() {
  return useQuery({ queryKey: ['payrollops-runs'], queryFn: () => api.get<PayrollRunRow[]>('/hr/payroll/runs') });
}

function RunPicker({ value, onChange, onlyApproved }: { value: string; onChange: (id: string) => void; onlyApproved?: boolean }) {
  const runs = useRuns();
  const rows = (runs.data ?? []).filter((r) => !onlyApproved || ['Approved', 'Disbursed', 'Locked'].includes(r.status));
  if (runs.isLoading) return <Loading />;
  if (rows.length === 0) {
    return (
      <EmptyState
        message={onlyApproved ? 'No approved run yet.' : 'No payroll run yet.'}
        hint="Open and approve a run under People → Payroll first."
      />
    );
  }
  return (
    <SelectInput
      label="Payroll run"
      value={value as never}
      onChange={onChange}
      placeholder="Choose a run…"
      options={rows.map((r) => ({ value: r.id, label: `${r.payPeriod} — ${r.recordCode} (${r.status})` }))}
    />
  );
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

interface CalendarRow {
  id: string;
  payPeriod: string;
  attendanceLockAt: string;
  inputFreezeAt: string;
  runByAt: string;
  approveByAt: string;
  payDate: string;
  note: string | null;
  milestone: string;
}

const MILESTONE_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = {
  before_attendance_lock: 'neutral',
  attendance_locked: 'neutral',
  input_frozen: 'warn',
  run_due: 'warn',
  approval_due: 'warn',
  ready_to_pay: 'good',
  past_pay_date: 'bad',
};

function CalendarTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ payPeriod: '', attendanceLockAt: '', inputFreezeAt: '', runByAt: '', approveByAt: '', payDate: '', note: '' });

  const rows = useQuery({ queryKey: ['payrollops-calendar'], queryFn: () => api.get<CalendarRow[]>('/hcm/payrollops/calendar') });

  return (
    <Card
      title="Payroll calendar"
      subtitle="The cutoffs a period runs against — when attendance locks, when other input freezes, and the planned run, approve and pay dates."
      actions={<NewButton label="Set a period's calendar" onClick={() => setOpen(true)} />}
    >
      {rows.isLoading && <Loading />}
      {rows.error && <ErrorBox error={rows.error} />}
      {rows.data && rows.data.length === 0 && <EmptyState message="No period has a calendar set yet." />}
      {rows.data && rows.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Attendance lock</th>
              <th>Input freeze</th>
              <th>Run by</th>
              <th>Approve by</th>
              <th>Pay date</th>
              <th>Stage</th>
            </tr>
          </thead>
          <tbody>
            {rows.data.map((r) => (
              <tr key={r.id}>
                <td>{r.payPeriod}</td>
                <td>{date(r.attendanceLockAt)}</td>
                <td>{date(r.inputFreezeAt)}</td>
                <td>{date(r.runByAt)}</td>
                <td>{date(r.approveByAt)}</td>
                <td>{date(r.payDate)}</td>
                <td><StatusChip status={r.milestone.replace(/_/g, ' ')} tone={MILESTONE_TONE[r.milestone] ?? 'neutral'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Set a period's calendar"
        onClose={() => setOpen(false)}
        invalidate={[['payrollops-calendar']]}
        onSubmit={() =>
          api.post('/hcm/payrollops/calendar', {
            payPeriod: form.payPeriod,
            attendanceLockAt: form.attendanceLockAt,
            inputFreezeAt: form.inputFreezeAt,
            runByAt: form.runByAt,
            approveByAt: form.approveByAt,
            payDate: form.payDate,
            note: form.note || undefined,
          })
        }
      >
        <TextInput label="Pay period" placeholder="YYYY-MM" value={form.payPeriod} onChange={(v) => setForm({ ...form, payPeriod: v })} required />
        <Row>
          <TextInput label="Attendance lock" type="date" value={form.attendanceLockAt} onChange={(v) => setForm({ ...form, attendanceLockAt: v })} required />
          <TextInput label="Input freeze" type="date" value={form.inputFreezeAt} onChange={(v) => setForm({ ...form, inputFreezeAt: v })} required />
        </Row>
        <Row>
          <TextInput label="Run by" type="date" value={form.runByAt} onChange={(v) => setForm({ ...form, runByAt: v })} required />
          <TextInput label="Approve by" type="date" value={form.approveByAt} onChange={(v) => setForm({ ...form, approveByAt: v })} required />
        </Row>
        <TextInput label="Pay date" type="date" value={form.payDate} onChange={(v) => setForm({ ...form, payDate: v })} required />
        <TextArea label="Note" value={form.note} onChange={(v) => setForm({ ...form, note: v })} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Pay items
// ---------------------------------------------------------------------------

interface PayItem {
  id: string;
  code: string;
  name: string;
  kind: string;
  taxable: boolean;
  statutoryBasis: boolean;
  glAccountCode: string;
  active: boolean;
}

function PayItemsTab() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', kind: 'earning' as string, glAccountCode: '', taxable: true, statutoryBasis: false });

  const items = useQuery({ queryKey: ['payrollops-pay-items'], queryFn: () => api.get<PayItem[]>('/hcm/payrollops/pay-items') });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch(`/hcm/payrollops/pay-items/${id}/active`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payrollops-pay-items'] }),
  });

  return (
    <Card
      title="Pay items"
      subtitle="The components pay is built from — earnings, deductions, reimbursements and employer contributions — each with the GL code it costs to."
      actions={can('pay_items:create') && <NewButton label="Add pay item" onClick={() => setOpen(true)} />}
    >
      {items.isLoading && <Loading />}
      {items.error && <ErrorBox error={items.error} />}
      {items.data && items.data.length === 0 && <EmptyState message="No pay items configured yet." hint="A run's own gross/net still works without these — they are for ad-hoc lines and journal costing." />}
      {items.data && items.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Kind</th>
              <th>GL account</th>
              <th>Taxable</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.data.map((i) => (
              <tr key={i.id} className={i.active ? '' : 'opacity-50'}>
                <td className="tabular-nums">{i.code}</td>
                <td>{i.name}</td>
                <td><StatusChip status={i.kind.replace(/_/g, ' ')} /></td>
                <td className="tabular-nums text-2xs">{i.glAccountCode}</td>
                <td>{i.taxable ? 'Yes' : 'No'}</td>
                <td className="text-right">
                  {can('pay_items:edit') && (
                    <button className="btn text-2xs" onClick={() => toggle.mutate({ id: i.id, active: !i.active })}>
                      {i.active ? 'Deactivate' : 'Activate'}
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
        title="Add a pay item"
        onClose={() => setOpen(false)}
        invalidate={[['payrollops-pay-items']]}
        onSubmit={() => api.post('/hcm/payrollops/pay-items', form)}
      >
        <Row>
          <TextInput label="Code" value={form.code} onChange={(v) => setForm({ ...form, code: v.toUpperCase() })} required />
          <SelectInput
            label="Kind"
            value={form.kind}
            onChange={(v) => setForm({ ...form, kind: v })}
            options={[
              { value: 'earning', label: 'Earning' },
              { value: 'deduction', label: 'Deduction' },
              { value: 'reimbursement', label: 'Reimbursement' },
              { value: 'employer_contribution', label: 'Employer contribution' },
            ]}
          />
        </Row>
        <TextInput label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <TextInput label="GL account code" value={form.glAccountCode} onChange={(v) => setForm({ ...form, glAccountCode: v })} placeholder="6020-BONUS" required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Ad-hoc pay
// ---------------------------------------------------------------------------

interface AdHocLine {
  id: string;
  employmentRelationshipId: string;
  payItemId: string;
  payPeriod: string;
  amount: number | null;
  moneyWithheldReason?: string | null;
  reason: string;
  status: string;
}

const ADHOC_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { Proposed: 'warn', Approved: 'good', Rejected: 'bad', Applied: 'neutral' };

function AdHocTab() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employmentRelationshipId: '', payItemId: '', payPeriod: '', amount: '', reason: '' });

  const lines = useQuery({ queryKey: ['payrollops-adhoc'], queryFn: () => api.get<AdHocLine[]>('/hcm/payrollops/adhoc-pay') });
  const items = useQuery({ queryKey: ['payrollops-pay-items'], queryFn: () => api.get<PayItem[]>('/hcm/payrollops/pay-items') });

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.post(`/hcm/payrollops/adhoc-pay/${id}/${approve ? 'approve' : 'reject'}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payrollops-adhoc'] }),
  });
  const [decideError, setDecideError] = useState<string | null>(null);

  return (
    <Card
      title="Ad-hoc pay"
      subtitle="A one-off addition or deduction for a period — proposed by one person, approved by another. Once approved, applying it into a run's figures is a separate step under People → Payroll."
      actions={can('adhoc_pay:create') && <NewButton label="Propose a line" onClick={() => setOpen(true)} />}
    >
      {lines.isLoading && <Loading />}
      {lines.error && <ErrorBox error={lines.error} />}
      {decideError && <p className="mb-2 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{decideError}</p>}
      {lines.data && lines.data.length === 0 && <EmptyState message="No ad-hoc pay lines proposed yet." />}
      {lines.data && lines.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Amount</th>
              <th>Reason</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.data.map((l) => (
              <tr key={l.id}>
                <td>{l.payPeriod}</td>
                <td className="tabular-nums">{money(l.amount)}</td>
                <td>{l.reason}</td>
                <td><StatusChip status={l.status} tone={ADHOC_TONE[l.status] ?? 'neutral'} /></td>
                <td className="text-right">
                  {l.status === 'Proposed' && can('adhoc_pay:approve') && (
                    <div className="flex justify-end gap-1">
                      <button
                        className="btn text-2xs"
                        onClick={() => decide.mutate({ id: l.id, approve: true }, { onError: (e) => setDecideError(messageOf(e)) })}
                      >
                        Approve
                      </button>
                      <button
                        className="btn text-2xs"
                        onClick={() => decide.mutate({ id: l.id, approve: false }, { onError: (e) => setDecideError(messageOf(e)) })}
                      >
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

      <CreateModal
        open={open}
        title="Propose an ad-hoc pay line"
        onClose={() => setOpen(false)}
        invalidate={[['payrollops-adhoc']]}
        onSubmit={() =>
          api.post('/hcm/payrollops/adhoc-pay', {
            employmentRelationshipId: form.employmentRelationshipId,
            payItemId: form.payItemId,
            payPeriod: form.payPeriod,
            amount: Number(form.amount),
            reason: form.reason,
          })
        }
      >
        <TextInput label="Employment relationship id" value={form.employmentRelationshipId} onChange={(v) => setForm({ ...form, employmentRelationshipId: v })} required hint="From the employee's People record" />
        <SelectInput
          label="Pay item"
          value={form.payItemId}
          onChange={(v) => setForm({ ...form, payItemId: v })}
          placeholder="Choose…"
          options={(items.data ?? []).filter((i) => i.active).map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }))}
        />
        <Row>
          <TextInput label="Pay period" placeholder="YYYY-MM" value={form.payPeriod} onChange={(v) => setForm({ ...form, payPeriod: v })} required />
          <MoneyInput label="Amount" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} required />
        </Row>
        <TextArea label="Reason" value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Arrears
// ---------------------------------------------------------------------------

interface ArrearRow {
  id: string;
  employmentRelationshipId: string;
  fromPeriod: string;
  amount: number | null;
  moneyWithheldReason?: string | null;
  reason: string;
  status: string;
  paidInPayPeriod: string | null;
}

const ARREAR_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { Proposed: 'warn', Approved: 'good', Rejected: 'bad', Paid: 'neutral' };

function ArrearsTab() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employmentRelationshipId: '', fromPeriod: '', amount: '', reason: '' });
  const [markPeriod, setMarkPeriod] = useState<Record<string, string>>({});
  const [decideError, setDecideError] = useState<string | null>(null);

  const rows = useQuery({ queryKey: ['payrollops-arrears'], queryFn: () => api.get<ArrearRow[]>('/hcm/payrollops/arrears') });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.post(`/hcm/payrollops/arrears/${id}/${approve ? 'approve' : 'reject'}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payrollops-arrears'] }),
  });
  const markPaid = useMutation({
    mutationFn: ({ id, payPeriod }: { id: string; payPeriod: string }) => api.post(`/hcm/payrollops/arrears/${id}/mark-paid`, { payPeriod }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payrollops-arrears'] }),
  });

  return (
    <Card
      title="Arrears"
      subtitle="A pay adjustment owed for a past period — a delayed increment, a corrected shortfall. Approved the same way as ad-hoc pay; marked paid once a run has actually carried it."
      actions={can('arrears:create') && <NewButton label="Propose an arrear" onClick={() => setOpen(true)} />}
    >
      {rows.isLoading && <Loading />}
      {rows.error && <ErrorBox error={rows.error} />}
      {decideError && <p className="mb-2 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{decideError}</p>}
      {rows.data && rows.data.length === 0 && <EmptyState message="No arrears proposed yet." />}
      {rows.data && rows.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>From period</th>
              <th>Amount</th>
              <th>Reason</th>
              <th>Status</th>
              <th>Paid in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.data.map((a) => (
              <tr key={a.id}>
                <td>{a.fromPeriod}</td>
                <td className="tabular-nums">{money(a.amount)}</td>
                <td>{a.reason}</td>
                <td><StatusChip status={a.status} tone={ARREAR_TONE[a.status] ?? 'neutral'} /></td>
                <td>{a.paidInPayPeriod ?? '—'}</td>
                <td className="text-right">
                  {a.status === 'Proposed' && can('arrears:approve') && (
                    <div className="flex justify-end gap-1">
                      <button className="btn text-2xs" onClick={() => decide.mutate({ id: a.id, approve: true }, { onError: (e) => setDecideError(messageOf(e)) })}>
                        Approve
                      </button>
                      <button className="btn text-2xs" onClick={() => decide.mutate({ id: a.id, approve: false }, { onError: (e) => setDecideError(messageOf(e)) })}>
                        Reject
                      </button>
                    </div>
                  )}
                  {a.status === 'Approved' && can('arrears:edit') && (
                    <div className="flex justify-end gap-1">
                      <input
                        className="input w-24 text-2xs"
                        placeholder="YYYY-MM"
                        value={markPeriod[a.id] ?? ''}
                        onChange={(e) => setMarkPeriod({ ...markPeriod, [a.id]: e.target.value })}
                      />
                      <button
                        className="btn text-2xs"
                        onClick={() => markPeriod[a.id] && markPaid.mutate({ id: a.id, payPeriod: markPeriod[a.id] })}
                      >
                        Mark paid
                      </button>
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
        title="Propose an arrear"
        onClose={() => setOpen(false)}
        invalidate={[['payrollops-arrears']]}
        onSubmit={() =>
          api.post('/hcm/payrollops/arrears', {
            employmentRelationshipId: form.employmentRelationshipId,
            fromPeriod: form.fromPeriod,
            amount: Number(form.amount),
            reason: form.reason,
          })
        }
      >
        <TextInput label="Employment relationship id" value={form.employmentRelationshipId} onChange={(v) => setForm({ ...form, employmentRelationshipId: v })} required />
        <Row>
          <TextInput label="Owed for period" placeholder="YYYY-MM" value={form.fromPeriod} onChange={(v) => setForm({ ...form, fromPeriod: v })} required />
          <MoneyInput label="Amount" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} required />
        </Row>
        <TextArea label="Reason" value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

interface ReconRow {
  id: string;
  payrollRunId: string;
  previousPayrollRunId: string | null;
  unexplainedCount: number;
  generatedAt: string;
  deltas: Array<{ employmentRelationshipId: string; previousNet: number | null; currentNet: number | null; delta: number; deltaPct: number | null; unexplained: boolean; note: string }>;
}

function ReconciliationTab() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [runId, setRunId] = useState('');
  const [previousRunId, setPreviousRunId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const rows = useQuery({ queryKey: ['payrollops-recon'], queryFn: () => api.get<ReconRow[]>('/hcm/payrollops/reconciliations') });
  const generate = useMutation({
    mutationFn: () => api.post<ReconRow>('/hcm/payrollops/reconciliations/generate', { payrollRunId: runId, previousPayrollRunId: previousRunId || undefined }),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['payrollops-recon'] }); },
    onError: (e) => setError(messageOf(e)),
  });

  return (
    <Card
      title="Reconciliation"
      subtitle="A per-employee delta against the previous run, before disbursal — a swing beyond the usual range is flagged while the money has not left yet."
    >
      <div className="mb-4 flex flex-wrap items-end gap-3 border-b border-ink-800 pb-4">
        <div className="w-64"><RunPicker value={runId} onChange={setRunId} onlyApproved /></div>
        <div className="w-64"><RunPicker value={previousRunId} onChange={setPreviousRunId} /></div>
        {can('payroll_reconciliations:create') && (
          <button className="btn-primary" disabled={!runId || generate.isPending} onClick={() => generate.mutate()}>
            {generate.isPending ? 'Comparing…' : 'Run reconciliation'}
          </button>
        )}
      </div>
      {error && <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      {rows.isLoading && <Loading />}
      {rows.error && <ErrorBox error={rows.error} />}
      {rows.data && rows.data.length === 0 && <EmptyState message="No reconciliation has been run yet." />}
      {rows.data && rows.data.length > 0 && (
        <div className="flex flex-col gap-4">
          {rows.data.map((r) => (
            <div key={r.id} className="rounded border border-ink-800 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs text-ink-300">Generated {relative(r.generatedAt)}</p>
                <StatusChip status={r.unexplainedCount > 0 ? `${r.unexplainedCount} unexplained` : 'clean'} tone={r.unexplainedCount > 0 ? 'bad' : 'good'} />
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Previous net</th>
                    <th>Current net</th>
                    <th>Delta</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {r.deltas.slice(0, 25).map((d) => (
                    <tr key={d.employmentRelationshipId}>
                      <td className="text-2xs tabular-nums">{d.employmentRelationshipId.slice(-8)}</td>
                      <td className="tabular-nums">{d.previousNet === null ? '—' : money(d.previousNet)}</td>
                      <td className="tabular-nums">{d.currentNet === null ? '—' : money(d.currentNet)}</td>
                      <td className={`tabular-nums ${d.unexplained ? 'text-band-critical' : ''}`}>{money(d.delta)}{d.deltaPct !== null ? ` (${d.deltaPct}%)` : ''}</td>
                      <td className="text-2xs text-ink-400">{d.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

interface JournalRow {
  id: string;
  payrollRunId: string;
  payPeriod: string;
  lines: Array<{ ledgerAccountCode: string; label: string; costCentre: string; debit: number | null; credit: number | null }>;
  totalDebit: number | null;
  totalCredit: number | null;
  moneyWithheldReason?: string | null;
  status: string;
  transactionId: string | null;
}

interface LedgerAccount {
  id: string;
  name: string;
  accountType: string;
}

const CASH_ACCOUNT_TYPES = ['bank', 'cash', 'wallet'];

function JournalTab() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [runId, setRunId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const journals = useQuery({ queryKey: ['payrollops-journals'], queryFn: () => api.get<JournalRow[]>('/hcm/payrollops/journals') });
  const accounts = useQuery({ queryKey: ['ledger-accounts-for-payroll'], queryFn: () => api.get<LedgerAccount[]>('/books/accounts') });
  const cashAccounts = (accounts.data ?? []).filter((a) => CASH_ACCOUNT_TYPES.includes(a.accountType));

  const generate = useMutation({
    mutationFn: () => api.post('/hcm/payrollops/journals/generate', { payrollRunId: runId }),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['payrollops-journals'] }); },
    onError: (e) => setError(messageOf(e)),
  });
  const post = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/payrollops/journals/${id}/post`, { accountId }),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['payrollops-journals'] }); },
    onError: (e) => setError(messageOf(e)),
  });

  return (
    <Card
      title="Payroll journal"
      subtitle="The double-entry breakdown a run posts as, by division. Debits always equal credits by construction. Posting records the net-pay cash movement in the books; the full breakdown stays here since the books post one cash line at a time, not a multi-line entry."
    >
      <div className="mb-4 flex flex-wrap items-end gap-3 border-b border-ink-800 pb-4">
        <div className="w-64"><RunPicker value={runId} onChange={setRunId} onlyApproved /></div>
        {can('payroll_journals:create') && (
          <button className="btn-primary" disabled={!runId || generate.isPending} onClick={() => generate.mutate()}>
            {generate.isPending ? 'Preparing…' : 'Generate / rebuild journal'}
          </button>
        )}
      </div>
      {error && <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      {journals.isLoading && <Loading />}
      {journals.error && <ErrorBox error={journals.error} />}
      {journals.data && journals.data.length === 0 && <EmptyState message="No journal prepared yet." />}
      {journals.data && journals.data.length > 0 && (
        <div className="flex flex-col gap-4">
          {journals.data.map((j) => (
            <div key={j.id} className="rounded border border-ink-800 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-ink-300">{j.payPeriod}</p>
                <StatusChip status={j.status} tone={j.status === 'Posted' ? 'good' : 'warn'} />
              </div>
              <table className="table mb-2">
                <thead>
                  <tr>
                    <th>Ledger account</th>
                    <th>Cost centre</th>
                    <th className="text-right">Debit</th>
                    <th className="text-right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {j.lines.map((l, idx) => (
                    <tr key={idx}>
                      <td className="text-2xs">{l.label} <span className="text-ink-500">({l.ledgerAccountCode})</span></td>
                      <td>{l.costCentre}</td>
                      <td className="text-right tabular-nums">{l.debit !== null && l.debit > 0 ? money(l.debit) : l.debit === null ? <StatusChip status="withheld" /> : ''}</td>
                      <td className="text-right tabular-nums">{l.credit !== null && l.credit > 0 ? money(l.credit) : l.credit === null ? <StatusChip status="withheld" /> : ''}</td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td colSpan={2}>Total</td>
                    <td className="text-right tabular-nums">{money(j.totalDebit)}</td>
                    <td className="text-right tabular-nums">{money(j.totalCredit)}</td>
                  </tr>
                </tbody>
              </table>
              {j.status === 'Prepared' && (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-64">
                    <SelectInput
                      label="Post net pay from"
                      value={accountId}
                      onChange={setAccountId}
                      placeholder="Choose an account…"
                      options={(accounts.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
                    />
                  </div>
                  <button className="btn-primary" disabled={!accountId || post.isPending} onClick={() => post.mutate(j.id)}>
                    {post.isPending ? 'Posting…' : 'Post to books'}
                  </button>
                </div>
              )}
              {j.status === 'Posted' && <p className="text-2xs text-ink-500">Posted as transaction {j.transactionId}.</p>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Bank advice
// ---------------------------------------------------------------------------

interface BankAdviceSummary {
  id: string;
  payrollRunId: string;
  payPeriod: string;
  format: string;
  count: number;
  total: number;
  generatedAt: string;
}

function BankAdviceTab() {
  const qc = useQueryClient();
  const [runId, setRunId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);

  const advices = useQuery({ queryKey: ['payrollops-advices'], queryFn: () => api.get<BankAdviceSummary[]>('/hcm/payrollops/bank-advices') });
  const detail = useQuery({
    queryKey: ['payrollops-advice-detail', viewingId],
    queryFn: () => api.get<BankAdviceSummary & { fileText: string }>(`/hcm/payrollops/bank-advices/${viewingId}`),
    enabled: Boolean(viewingId),
  });

  const generate = useMutation({
    mutationFn: () => api.post('/hcm/payrollops/bank-advices/generate', { payrollRunId: runId }),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['payrollops-advices'] }); },
    onError: (e) => setError(messageOf(e)),
  });

  return (
    <Card
      title="Bank advice"
      subtitle="The NEFT file for a run's net pay. Held only by HR operations and Finance — never at employee scope."
    >
      <div className="mb-4 flex flex-wrap items-end gap-3 border-b border-ink-800 pb-4">
        <div className="w-64"><RunPicker value={runId} onChange={setRunId} onlyApproved /></div>
        <button className="btn-primary" disabled={!runId || generate.isPending} onClick={() => generate.mutate()}>
          {generate.isPending ? 'Generating…' : 'Generate bank advice'}
        </button>
      </div>
      {error && <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      {advices.isLoading && <Loading />}
      {advices.error && <ErrorBox error={advices.error} />}
      {advices.data && advices.data.length === 0 && <EmptyState message="No bank advice generated yet." />}
      {advices.data && advices.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Format</th>
              <th>Count</th>
              <th>Total</th>
              <th>Generated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {advices.data.map((a) => (
              <tr key={a.id}>
                <td>{a.payPeriod}</td>
                <td>{a.format}</td>
                <td className="tabular-nums">{a.count}</td>
                <td className="tabular-nums">{money(a.total)}</td>
                <td>{dateTime(a.generatedAt)}</td>
                <td className="text-right">
                  <button className="btn text-2xs" onClick={() => setViewingId(viewingId === a.id ? null : a.id)}>
                    {viewingId === a.id ? 'Hide' : 'View file'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {viewingId && detail.data && (
        <pre className="mt-3 max-h-64 overflow-auto rounded border border-ink-800 bg-ink-900 p-3 text-2xs">{detail.data.fileText}</pre>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface PayrollQueryRow {
  id: string;
  employmentRelationshipId: string;
  payPeriod: string;
  subject: string;
  message: string;
  status: string;
  response: string | null;
  respondedAt: string | null;
  createdAt: string;
}

const QUERY_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { Open: 'warn', Responded: 'good', Closed: 'neutral' };

function QueriesTab() {
  const qc = useQueryClient();
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const rows = useQuery({ queryKey: ['payrollops-queries'], queryFn: () => api.get<PayrollQueryRow[]>('/hcm/payrollops/queries') });
  const respond = useMutation({
    mutationFn: ({ id, response, close }: { id: string; response: string; close: boolean }) =>
      api.post(`/hcm/payrollops/queries/${id}/respond`, { response, close }),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['payrollops-queries'] }); },
    onError: (e) => setError(messageOf(e)),
  });

  return (
    <Card title="Payroll queries" subtitle="A question an employee raised about their own payslip — routed here for a response.">
      {error && <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
      {rows.isLoading && <Loading />}
      {rows.error && <ErrorBox error={rows.error} />}
      {rows.data && rows.data.length === 0 && <EmptyState message="No payroll queries raised yet." />}
      {rows.data && rows.data.length > 0 && (
        <div className="flex flex-col gap-3">
          {rows.data.map((q) => (
            <div key={q.id} className="rounded border border-ink-800 p-3">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-ink-100">{q.subject} <span className="ml-2 text-2xs text-ink-500">{q.payPeriod}</span></p>
                <StatusChip status={q.status} tone={QUERY_TONE[q.status] ?? 'neutral'} />
              </div>
              <p className="mb-2 text-xs text-ink-300">{q.message}</p>
              {q.response && <p className="mb-2 rounded bg-ink-900 p-2 text-xs text-ink-300">HR: {q.response}</p>}
              {q.status !== 'Closed' && (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[16rem] flex-1">
                    <TextArea label="Response" value={responses[q.id] ?? ''} onChange={(v) => setResponses({ ...responses, [q.id]: v })} rows={2} />
                  </div>
                  <button
                    className="btn text-2xs"
                    disabled={!responses[q.id]}
                    onClick={() => responses[q.id] && respond.mutate({ id: q.id, response: responses[q.id], close: false })}
                  >
                    Respond
                  </button>
                  <button
                    className="btn-primary text-2xs"
                    disabled={!responses[q.id]}
                    onClick={() => responses[q.id] && respond.mutate({ id: q.id, response: responses[q.id], close: true })}
                  >
                    Respond &amp; close
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
