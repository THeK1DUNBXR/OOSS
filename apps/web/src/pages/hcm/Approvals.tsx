/**
 * HCM — workflow (docs/hcm/workflow.md). /people/approvals.
 *
 * The inbox of everything pending for the signed-in party across every HR
 * request type, plus the self-service control for handing that inbox to
 * someone else while away — a Delegation of Authority.
 */

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { messageOf, NewButton, Row, TextArea, TextInput } from '../../components/forms.js';
import { RequestInbox } from '../../components/hcm/RequestInbox.js';

interface Delegation {
  id: string;
  fromPartyId: string;
  toPartyId: string;
  fromDate: string;
  toDate: string;
  scope: string;
  note: string | null;
  revokedAt: string | null;
}

const DELEGATIONS_KEY = ['hcm-workflow-delegations'];

function DelegationsCard() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ toPartyId: '', fromDate: '', toDate: '', note: '' });

  const delegations = useQuery({ queryKey: DELEGATIONS_KEY, queryFn: () => api.get<Delegation[]>('/hcm/workflow/delegations') });

  const create = useMutation({
    mutationFn: () =>
      api.post('/hcm/workflow/delegations', {
        toPartyId: form.toPartyId,
        fromDate: form.fromDate,
        toDate: form.toDate,
        note: form.note || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DELEGATIONS_KEY });
      setForm({ toPartyId: '', fromDate: '', toDate: '', note: '' });
      setOpen(false);
      setError(null);
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/workflow/delegations/${id}/revoke`),
    onSuccess: () => qc.invalidateQueries({ queryKey: DELEGATIONS_KEY }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate();
  };

  return (
    <Card
      title="Your delegations"
      subtitle="Hand your approval inbox to a colleague for a date range — a manager, hr grant, or finance grant level resolved to you will route to them instead until the delegation ends."
      actions={<NewButton label="New delegation" onClick={() => setOpen((v) => !v)} />}
    >
      {open && (
        <form onSubmit={submit} className="mb-4 flex flex-col gap-3 rounded-md border border-ink-800 bg-ink-900 p-3">
          {error && (
            <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>
          )}
          <TextInput label="Delegate to (party id)" value={form.toPartyId} onChange={(v) => setForm((f) => ({ ...f, toPartyId: v }))} required />
          <Row>
            <TextInput label="From" type="date" value={form.fromDate} onChange={(v) => setForm((f) => ({ ...f, fromDate: v }))} required />
            <TextInput label="To" type="date" value={form.toDate} onChange={(v) => setForm((f) => ({ ...f, toDate: v }))} required />
          </Row>
          <TextArea label="Note" value={form.note} onChange={(v) => setForm((f) => ({ ...f, note: v }))} rows={2} placeholder="Why, or for how long" />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Create delegation'}
            </button>
          </div>
        </form>
      )}

      {delegations.isLoading && <Loading />}
      {delegations.error && <ErrorBox error={delegations.error} />}
      {delegations.data && delegations.data.length === 0 && (
        <EmptyState message="No delegations recorded." hint="Nothing routes away from you today." />
      )}
      {delegations.data && delegations.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Delegate</th>
              <th>Scope</th>
              <th>From</th>
              <th>To</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {delegations.data.map((d) => (
              <tr key={d.id}>
                <td className="mono">{d.toPartyId}</td>
                <td>
                  <StatusChip status={d.scope} tone="neutral" />
                </td>
                <td>{date(d.fromDate)}</td>
                <td>{date(d.toDate)}</td>
                <td className="text-ink-400">{d.note ?? '—'}</td>
                <td>
                  <button className="btn-xs" onClick={() => revoke.mutate(d.id)} disabled={revoke.isPending}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function Approvals() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Approvals"
        subtitle="Everything an HR request has routed to you, across every request type — leave, expense, WFH exceptions and anything else another part of the system opens against the generic HR request engine."
      />
      <RequestInbox
        subtitle="Approve or reject with a note. A request you raised, or one about you, never appears here — the Self-Dealing Bar keeps it off your own inbox."
      />
      <DelegationsCard />
    </div>
  );
}
