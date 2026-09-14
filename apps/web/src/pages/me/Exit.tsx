/**
 * My exit — WS10 separations (docs/hcm/separations.md).
 *
 * Submit a resignation, watch it move to accepted, and once it has, see the
 * exit clearance and no-dues status. Nothing here that HR would refuse is
 * offered — a resignation already pending hides the "resign" button, and a
 * decided one hides "withdraw".
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, titleCase } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Field, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, NewButton, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';

interface ResignationRow {
  id: string;
  recordCode: string;
  submittedOn: string;
  requestedLastDay: string;
  agreedLastDay: string | null;
  noticeDays: number;
  reasonCategory: string;
  reasonNote: string | null;
  status: 'submitted' | 'accepted' | 'withdrawn' | 'rejected';
  rejectedReason: string | null;
  offboardingId: string | null;
}

interface ClearanceRow {
  id: string;
  department: string;
  status: 'pending' | 'cleared' | 'blocked';
  note: string | null;
  clearedAt: string | null;
}

interface OffboardingView {
  id: string;
  status: string;
  clearances: ClearanceRow[];
  allCleared: boolean;
  noDues: { id: string; issuedOn: string } | null;
}

const RESIGNATION_TONE: Record<ResignationRow['status'], 'neutral' | 'good' | 'warn' | 'bad'> = {
  submitted: 'warn',
  accepted: 'good',
  withdrawn: 'neutral',
  rejected: 'bad',
};

const CLEARANCE_TONE: Record<ClearanceRow['status'], 'neutral' | 'good' | 'warn' | 'bad'> = {
  pending: 'neutral',
  cleared: 'good',
  blocked: 'bad',
};

type ReasonCategory = ResignationRow['reasonCategory'];

const REASON_OPTIONS: Array<{ value: ReasonCategory; label: string }> = [
  { value: 'personal', label: 'Personal' },
  { value: 'career_growth', label: 'Career growth' },
  { value: 'compensation', label: 'Compensation' },
  { value: 'relocation', label: 'Relocation' },
  { value: 'health', label: 'Health' },
  { value: 'conduct', label: 'Conduct' },
  { value: 'other', label: 'Other' },
];

export function Exit() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ requestedLastDay: string; reasonCategory: ReasonCategory; reasonNote: string }>({
    requestedLastDay: '',
    reasonCategory: 'personal',
    reasonNote: '',
  });

  const resignations = useQuery({
    queryKey: ['my-resignations'],
    queryFn: () => api.get<ResignationRow[]>('/hcm/separations/my/resignations'),
  });
  const noticeDays = useQuery({
    queryKey: ['my-notice-days'],
    queryFn: () => api.get<{ noticeDays: number; buyoutAllowed: boolean; source: string }>('/hcm/separations/my/notice-days'),
  });

  const current = resignations.data
    ?.slice()
    .sort((a, b) => new Date(b.submittedOn).getTime() - new Date(a.submittedOn).getTime())[0];
  const pending = current?.status === 'submitted' ? current : undefined;
  const accepted = resignations.data?.find((r) => r.status === 'accepted' && r.offboardingId);

  const offboarding = useQuery({
    queryKey: ['my-offboarding', accepted?.offboardingId],
    queryFn: () => api.get<OffboardingView | null>('/hcm/separations/my/offboarding'),
    enabled: Boolean(accepted),
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/separations/resignations/${id}/withdraw`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-resignations'] }),
  });

  return (
    <div>
      <PageHeader
        title="My exit"
        subtitle="Submit a resignation, track its acceptance, and once it is accepted, follow your exit clearance and no-dues certificate here."
      />

      <Card
        title="Resignation"
        actions={!pending && !accepted && <NewButton label="Submit resignation" onClick={() => setOpen(true)} />}
      >
        {resignations.isLoading && <Loading />}
        {resignations.error && <ErrorBox error={resignations.error} />}
        {resignations.data && !current && (
          <EmptyState
            message="No resignation on file."
            hint={
              noticeDays.data
                ? `Notice period: ${noticeDays.data.noticeDays} days${noticeDays.data.buyoutAllowed ? ' (buyout allowed)' : ''}.`
                : undefined
            }
          />
        )}
        {current && (
          <dl className="divide-y divide-ink-800">
            <Field label="Status">
              <StatusChip status={current.status} tone={RESIGNATION_TONE[current.status]} />
            </Field>
            <Field label="Record">
              <span className="mono">{current.recordCode}</span>
            </Field>
            <Field label="Submitted">{date(current.submittedOn)}</Field>
            <Field label="Requested last day">{date(current.requestedLastDay)}</Field>
            {current.agreedLastDay && <Field label="Agreed last day">{date(current.agreedLastDay)}</Field>}
            <Field label="Notice period">{current.noticeDays} days</Field>
            <Field label="Reason">{titleCase(current.reasonCategory)}</Field>
            {current.reasonNote && <Field label="Note">{current.reasonNote}</Field>}
            {current.status === 'rejected' && current.rejectedReason && (
              <Field label="Why it was declined">{current.rejectedReason}</Field>
            )}
          </dl>
        )}
        {pending && (
          <div className="mt-4">
            <button
              className="btn text-2xs"
              disabled={withdraw.isPending}
              onClick={() => withdraw.mutate(pending.id)}
            >
              {withdraw.isPending ? 'Withdrawing…' : 'Withdraw resignation'}
            </button>
            {withdraw.isError && <p className="mt-2 text-2xs text-band-critical">{messageOf(withdraw.error)}</p>}
          </div>
        )}
      </Card>

      {accepted && (
        <div className="mt-4">
          <Card title="Exit clearance" subtitle="Every department has to sign off before the final settlement runs.">
            {offboarding.isLoading && <Loading />}
            {offboarding.error && <ErrorBox error={offboarding.error} />}
            {offboarding.data && offboarding.data.clearances.length === 0 && (
              <EmptyState message="HR has not opened your clearance yet." hint="This starts once your last working day is confirmed." />
            )}
            {offboarding.data && offboarding.data.clearances.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th>Status</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {offboarding.data.clearances.map((c) => (
                    <tr key={c.id}>
                      <td>{titleCase(c.department)}</td>
                      <td><StatusChip status={c.status} tone={CLEARANCE_TONE[c.status]} /></td>
                      <td className="text-ink-400">{c.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {offboarding.data?.noDues && (
              <p className="mt-3 text-2xs text-band-strong">No-dues certificate issued {date(offboarding.data.noDues.issuedOn)}.</p>
            )}
          </Card>
        </div>
      )}

      <CreateModal
        open={open}
        title="Submit a resignation"
        submitLabel="Submit"
        onClose={() => setOpen(false)}
        invalidate={[['my-resignations']]}
        onSubmit={() =>
          api.post('/hcm/separations/my/resignations', {
            requestedLastDay: form.requestedLastDay,
            reasonCategory: form.reasonCategory,
            reasonNote: form.reasonNote || undefined,
          })
        }
      >
        <TextInput
          label="Requested last day"
          type="date"
          value={form.requestedLastDay}
          onChange={(v) => setForm({ ...form, requestedLastDay: v })}
          required
          hint={noticeDays.data ? `${noticeDays.data.noticeDays} days' notice usually applies` : undefined}
        />
        <SelectInput
          label="Reason"
          value={form.reasonCategory}
          onChange={(v) => setForm({ ...form, reasonCategory: v })}
          options={REASON_OPTIONS}
        />
        <TextArea label="Note (optional)" value={form.reasonNote} onChange={(v) => setForm({ ...form, reasonNote: v })} />
      </CreateModal>
    </div>
  );
}
