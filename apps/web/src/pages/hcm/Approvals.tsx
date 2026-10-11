/**
 * HCM — workflow (docs/hcm/workflow.md). /people/approvals.
 *
 * The inbox of everything pending for the signed-in party across every HR
 * request type, plus the self-service control for handing that inbox to
 * someone else while away — a Delegation of Authority.
 */

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { date } from '../../lib/api.js';
import { Card, PageHeader, StatusChip } from '../../components/ui.js';
import { messageOf, NewButton, Row, TextArea, TextInput } from '../../components/forms.js';
import { RequestInbox } from '../../components/hcm/RequestInbox.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';
import { hcmApi, type DelegationRow } from '../../lib/hcmApi.js';

const DELEGATIONS_KEY = ['hcm-workflow-delegations'];

/** Built inside the card so the Revoke button can reach its mutation. */
function delegationColumns(
  onRevoke: (id: string) => void,
  revoking: boolean,
): ReadonlyArray<DataTableColumn<DelegationRow>> {
  return [
    {
      id: 'delegate',
      header: 'Delegate',
      cellClassName: 'mono',
      sortValue: (d) => d.toPartyId,
      cell: (d) => d.toPartyId,
    },
    {
      id: 'scope',
      header: 'Scope',
      sortValue: (d) => d.scope,
      cell: (d) => <StatusChip status={d.scope} tone="neutral" />,
    },
    { id: 'from', header: 'From', sortValue: (d) => d.fromDate, cell: (d) => date(d.fromDate) },
    { id: 'to', header: 'To', sortValue: (d) => d.toDate, cell: (d) => date(d.toDate) },
    { id: 'note', header: 'Note', cellClassName: 'text-ink-400', cell: (d) => d.note ?? '—' },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (d) => (
        <button className="btn-xs" onClick={() => onRevoke(d.id)} disabled={revoking}>
          Revoke
        </button>
      ),
    },
  ];
}

function DelegationsCard() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ toPartyId: '', fromDate: '', toDate: '', note: '' });

  const delegations = useQuery({
    queryKey: DELEGATIONS_KEY,
    queryFn: () => hcmApi.delegations.list(),
  });

  const create = useMutation({
    mutationFn: () =>
      hcmApi.delegations.create({
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
    mutationFn: (id: string) => hcmApi.delegations.revoke(id),
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
            <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
              {error}
            </p>
          )}
          <TextInput
            label="Delegate to (party id)"
            value={form.toPartyId}
            onChange={(v) => setForm((f) => ({ ...f, toPartyId: v }))}
            required
          />
          <Row>
            <TextInput
              label="From"
              type="date"
              value={form.fromDate}
              onChange={(v) => setForm((f) => ({ ...f, fromDate: v }))}
              required
            />
            <TextInput
              label="To"
              type="date"
              value={form.toDate}
              onChange={(v) => setForm((f) => ({ ...f, toDate: v }))}
              required
            />
          </Row>
          <TextArea
            label="Note"
            value={form.note}
            onChange={(v) => setForm((f) => ({ ...f, note: v }))}
            rows={2}
            placeholder="Why, or for how long"
          />
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

      <DataTable
        caption="Delegations you have raised"
        columns={delegationColumns((id) => revoke.mutate(id), revoke.isPending)}
        rows={delegations.data ?? []}
        rowKey={(d) => d.id}
        loading={delegations.isLoading}
        error={delegations.error}
        defaultSort={{ columnId: 'from', direction: 'desc' }}
        emptyMessage="No delegations recorded."
        emptyHint="Nothing routes away from you today."
      />
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
      <RequestInbox subtitle="Approve or reject with a note. A request you raised, or one about you, never appears here — the Self-Dealing Bar keeps it off your own inbox." />
      <DelegationsCard />
    </div>
  );
}
