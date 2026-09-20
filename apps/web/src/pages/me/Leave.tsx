/**
 * My leave — WS3 leavepolicy (docs/hcm/leavepolicy.md).
 *
 * Balances, history, applying for leave with a live policy check before
 * submitting, restricted-holiday elections, and anything resolved to me to
 * decide in somebody else's approval chain.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, messageOf, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

interface EmployeeRow {
  id: string;
  fullName: string;
}

interface LeaveBalance {
  id: string;
  leaveTypeId: string;
  leaveTypeName: string;
  leaveTypeCode: string;
  balanceDays: number | null;
  heldDays: number | null;
  availableDays: number;
}

interface LeaveRequestRow {
  id: string;
  recordCode: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: string;
  availableTransitions: string[];
}

interface ValidationResult {
  ok: boolean;
  violations: Array<{ code: string; message: string }>;
  effectiveDays: number;
  documentRequired: boolean;
  policy: { id: string; name: string } | null;
}

interface Holiday {
  id: string;
  date: string;
  name: string;
  kind: string;
}

interface Election {
  id: string;
  holidayId: string;
  fy: string;
  electedAt: string;
}

interface InboxRow {
  id: string;
  leaveRequestId: string;
  level: number;
  kind: string;
}

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = {
  Draft: 'neutral',
  Submitted: 'warn',
  PendingApproval: 'warn',
  Approved: 'good',
  InProgress: 'good',
  Extended: 'good',
  Completed: 'neutral',
  Rejected: 'bad',
  Cancelled: 'neutral',
  Withdrawn: 'neutral',
};

function currentFy(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const startYear = now.getUTCMonth() >= 3 ? y : y - 1; // April start.
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function Leave() {
  const qc = useQueryClient();
  const [applying, setApplying] = useState(false);
  const [form, setForm] = useState({ leaveTypeId: '', startDate: '', endDate: '', reason: '' });
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [electing, setElecting] = useState(false);
  const [holidayId, setHolidayId] = useState('');

  const my = useQuery({ queryKey: ['me-leave-employment'], queryFn: () => api.get<EmployeeRow[]>('/hr/employees') });
  const employmentId = my.data?.[0]?.id ?? null;

  const balances = useQuery({
    queryKey: ['me-leave-balances', employmentId],
    queryFn: () => api.get<LeaveBalance[]>(`/hr/employees/${employmentId}/leave-balances`),
    enabled: Boolean(employmentId),
  });

  const requests = useQuery({ queryKey: ['me-leave-requests'], queryFn: () => api.get<LeaveRequestRow[]>('/hr/leave-requests') });

  const elections = useQuery({
    queryKey: ['me-leave-elections', employmentId],
    queryFn: () => api.get<Election[]>(`/hcm/leavepolicy/restricted-holiday-elections?employmentRelationshipId=${employmentId}`),
    enabled: Boolean(employmentId),
  });

  const restrictedHolidays = useQuery({
    queryKey: ['me-leave-restricted-holidays'],
    queryFn: () => api.get<Holiday[]>(`/compliance/labour/holidays?year=${new Date().getFullYear()}`).then((rows) => rows.filter((h) => h.kind === 'restricted')),
  });

  const inbox = useQuery({ queryKey: ['me-leave-inbox'], queryFn: () => api.get<InboxRow[]>('/hcm/leavepolicy/approvals/inbox') });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      api.post(`/hcm/leavepolicy/approvals/${id}/decide`, { decision }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me-leave-inbox'] }),
  });

  const elect = useMutation({
    mutationFn: () => api.post('/hcm/leavepolicy/restricted-holiday-elections', { employmentRelationshipId: employmentId, holidayId, fy: currentFy() }),
    onSuccess: () => {
      setElecting(false);
      setHolidayId('');
      void qc.invalidateQueries({ queryKey: ['me-leave-elections'] });
    },
  });

  const withdrawElection = useMutation({
    mutationFn: (id: string) => api.del(`/hcm/leavepolicy/restricted-holiday-elections/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me-leave-elections'] }),
  });

  const runValidation = async () => {
    if (!employmentId || !form.leaveTypeId || !form.startDate || !form.endDate) return;
    setValidating(true);
    try {
      const result = await api.post<ValidationResult>('/hcm/leavepolicy/validate', {
        employmentRelationshipId: employmentId,
        leaveTypeId: form.leaveTypeId,
        startDate: form.startDate,
        endDate: form.endDate,
      });
      setValidation(result);
    } catch (e) {
      setValidation({ ok: false, violations: [{ code: 'error', message: messageOf(e) }], effectiveDays: 0, documentRequired: false, policy: null });
    } finally {
      setValidating(false);
    }
  };

  return (
    <div>
      <PageHeader title="My leave" subtitle="Balances follow from holds, settlements and reversals. Apply for leave, elect a restricted holiday, or decide something resolved to you." />

      {inbox.data && inbox.data.length > 0 && (
        <Card title="Waiting for your decision" className="mb-4">
          <div className="space-y-2">
            {inbox.data.map((row) => (
              <div key={row.id} className="flex items-center justify-between rounded border border-band-warn/30 bg-band-warn/5 p-2 text-2xs">
                <span>Level {row.level} ({row.kind.replace('_', ' ')}) of a leave request</span>
                <div className="flex gap-2">
                  <button className="btn text-2xs" onClick={() => decide.mutate({ id: row.id, decision: 'approved' })} disabled={decide.isPending}>
                    Approve
                  </button>
                  <button className="btn text-2xs" onClick={() => decide.mutate({ id: row.id, decision: 'rejected' })} disabled={decide.isPending}>
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
          {decide.error && <ErrorBox error={decide.error} />}
        </Card>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {balances.data?.map((b) => (
          <Card key={b.id} title={b.leaveTypeName}>
            <div className="text-2xl font-semibold tabular-nums">{b.availableDays}</div>
            <div className="text-2xs text-ink-300">available of {b.balanceDays ?? 0} ({b.heldDays ?? 0} held)</div>
          </Card>
        ))}
      </div>

      <Card
        title="History"
        subtitle="Every request you have filed, oldest decision last."
        actions={
          <button className="btn-primary text-2xs" onClick={() => { setApplying(true); setValidation(null); }} disabled={!employmentId}>
            Apply for leave
          </button>
        }
      >
        {my.isLoading && <Loading />}
        {!my.isLoading && !employmentId && <EmptyState message="No employment record found for you." />}
        {requests.isLoading && <Loading />}
        {requests.error && <ErrorBox error={requests.error} />}
        {requests.data && requests.data.length === 0 && <EmptyState message="No leave requested yet." />}
        {requests.data && requests.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Type</th>
                <th>From</th>
                <th>To</th>
                <th className="num">Days</th>
                <th>Reason</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {requests.data.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.recordCode}</td>
                  <td>{r.leaveTypeName}</td>
                  <td className="num">{date(r.startDate)}</td>
                  <td className="num">{date(r.endDate)}</td>
                  <td className="num">{r.days}</td>
                  <td className="max-w-[16rem] truncate">{r.reason ?? '—'}</td>
                  <td>
                    <StatusChip status={r.status} tone={STATUS_TONE[r.status] ?? 'neutral'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Restricted holidays" subtitle="Elect up to two per financial year." className="mt-4">
        {elections.data && elections.data.length === 0 && <EmptyState message="No restricted holiday elected this year." />}
        {elections.data && elections.data.length > 0 && (
          <ul className="space-y-1 text-sm">
            {elections.data.map((e) => {
              const h = restrictedHolidays.data?.find((rh) => rh.id === e.holidayId);
              return (
                <li key={e.id} className="flex items-center justify-between">
                  <span>{h ? `${h.name} — ${date(h.date)}` : e.holidayId} ({e.fy})</span>
                  <button className="btn text-2xs" onClick={() => withdrawElection.mutate(e.id)}>
                    Withdraw
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <button className="btn mt-3 text-2xs" onClick={() => setElecting(true)} disabled={!employmentId}>
          Elect a restricted holiday
        </button>
        {(elect.error || withdrawElection.error) && <ErrorBox error={elect.error ?? withdrawElection.error} />}
      </Card>

      <CreateModal
        open={applying}
        title="Apply for leave"
        onClose={() => setApplying(false)}
        invalidate={[['me-leave-requests'], ['me-leave-balances']]}
        onSubmit={() =>
          api.post('/hr/leave-requests', {
            employmentRelationshipId: employmentId,
            leaveTypeId: form.leaveTypeId,
            startDate: form.startDate,
            endDate: form.endDate,
            reason: form.reason || null,
          })
        }
        onCreated={() => setForm({ leaveTypeId: '', startDate: '', endDate: '', reason: '' })}
      >
        <SelectInput
          label="Leave type"
          value={form.leaveTypeId}
          onChange={(v) => setForm({ ...form, leaveTypeId: v })}
          required
          placeholder="Select…"
          options={(balances.data ?? []).map((b) => ({ value: b.leaveTypeId, label: `${b.leaveTypeName} (${b.availableDays} available)` }))}
        />
        <Row>
          <TextInput label="From" type="date" value={form.startDate} onChange={(v) => setForm({ ...form, startDate: v })} required />
          <TextInput label="To" type="date" value={form.endDate} onChange={(v) => setForm({ ...form, endDate: v })} required />
        </Row>
        <TextArea label="Reason" value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} />
        <button type="button" className="btn text-2xs" onClick={runValidation} disabled={validating}>
          {validating ? 'Checking…' : 'Check against policy'}
        </button>
        {validation && (
          <div className={`rounded border-l-2 px-3 py-2 text-sm ${validation.ok ? 'border-band-good bg-band-good/10' : 'border-band-warn bg-band-warn/10'}`}>
            {validation.policy && <p className="mb-1 text-2xs text-ink-300">Checked against {validation.policy.name}.</p>}
            {validation.ok ? (
              <p>This request meets its policy — {validation.effectiveDays} day(s) charged.</p>
            ) : (
              <ul className="list-disc pl-4">
                {validation.violations.map((v, i) => (
                  <li key={i}>{v.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CreateModal>

      <CreateModal
        open={electing}
        title="Elect a restricted holiday"
        onClose={() => setElecting(false)}
        onSubmit={() => elect.mutateAsync()}
      >
        <SelectInput
          label="Holiday"
          value={holidayId}
          onChange={setHolidayId}
          required
          placeholder="Select…"
          options={(restrictedHolidays.data ?? []).map((h) => ({ value: h.id, label: `${h.name} — ${date(h.date)}` }))}
        />
      </CreateModal>
    </div>
  );
}
