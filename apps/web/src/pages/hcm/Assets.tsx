/**
 * Assets, travel & letters (docs/hcm/assets.md).
 *
 * Five tabs: the physical inventory, who is holding what, travel requests
 * (approved under the Self-Dealing Bar), letter requests (fulfilled either
 * through compliance labour's HrLetter issuer or this workstream's own
 * snapshot), and ID cards.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, dateTime } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs, Withheld } from '../../components/ui.js';
import { CreateModal, messageOf, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

type Tab = 'inventory' | 'assignments' | 'travel' | 'letters' | 'idcards';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'inventory', label: 'Inventory' },
  { key: 'assignments', label: 'Assignments' },
  { key: 'travel', label: 'Travel' },
  { key: 'letters', label: 'Letter requests' },
  { key: 'idcards', label: 'ID cards' },
];

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  in_stock: 'good',
  assigned: 'accent',
  repair: 'warn',
  retired: 'bad',
  submitted: 'accent',
  approved: 'good',
  rejected: 'bad',
  settled: 'good',
  requested: 'accent',
  fulfilled: 'good',
  issued: 'good',
  lost: 'bad',
  reissued: 'accent',
  returned: 'neutral',
};

function money(v: number | null): React.ReactNode {
  return v === null ? <Withheld reason="no_permission" /> : `₹${v.toLocaleString('en-IN')}`;
}

export function Assets() {
  const [tab, setTab] = useState<Tab>('inventory');
  return (
    <>
      <PageHeader
        title="Assets, travel & letters"
        subtitle="Physical inventory and who is holding it, travel requests approved by someone other than the traveller, letter requests, and ID cards. Money is shown to a financial-verb holder only — everyone else sees the record with the figure withheld."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'inventory' && <InventoryTab />}
      {tab === 'assignments' && <AssignmentsTab />}
      {tab === 'travel' && <TravelTab />}
      {tab === 'letters' && <LettersTab />}
      {tab === 'idcards' && <IdCardsTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

interface Asset {
  id: string;
  recordCode: string;
  tag: string;
  category: string;
  serial: string | null;
  purchaseDate: string | null;
  cost: number | null;
  status: string;
  note: string | null;
}

function InventoryTab() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ tag: '', category: 'laptop' as Asset['category'], serial: '', cost: '', note: '' });

  const assets = useQuery({ queryKey: ['assets-inventory'], queryFn: () => api.get<Asset[]>('/hcm/assets/inventory') });

  const transition = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.post(`/hcm/assets/inventory/${id}/transition`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets-inventory'] }),
  });

  return (
    <Card
      title="Inventory"
      subtitle="Laptops, phones, access cards and other equipment the company issues and reclaims."
      actions={can('hcm_assets:create') && <NewButton label="Add asset" onClick={() => setOpen(true)} />}
    >
      {assets.isLoading && <Loading />}
      {assets.error && <ErrorBox error={assets.error} />}
      {assets.data && assets.data.length === 0 && (
        <EmptyState message="No assets recorded yet." hint="Add a laptop, phone or access card to start tracking who holds it." />
      )}
      {assets.data && assets.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Tag</th>
              <th>Category</th>
              <th>Serial</th>
              <th>Purchased</th>
              <th>Cost</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {assets.data.map((a) => (
              <tr key={a.id}>
                <td className="font-mono text-2xs">{a.tag}</td>
                <td>{a.category.replace(/_/g, ' ')}</td>
                <td>{a.serial ?? '—'}</td>
                <td>{a.purchaseDate ? date(a.purchaseDate) : '—'}</td>
                <td>{money(a.cost)}</td>
                <td><StatusChip status={a.status} tone={STATUS_TONE[a.status]} /></td>
                <td className="text-right">
                  {can('hcm_assets:edit') && a.status === 'in_stock' && (
                    <button className="btn text-2xs" onClick={() => transition.mutate({ id: a.id, status: 'retired' })}>
                      Retire
                    </button>
                  )}
                  {can('hcm_assets:edit') && a.status === 'repair' && (
                    <button className="btn text-2xs" onClick={() => transition.mutate({ id: a.id, status: 'in_stock' })}>
                      Back in stock
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
        title="Add an asset"
        onClose={() => setOpen(false)}
        invalidate={[['assets-inventory']]}
        onSubmit={() =>
          api.post('/hcm/assets/inventory', {
            tag: form.tag,
            category: form.category,
            serial: form.serial || undefined,
            cost: form.cost ? Number(form.cost) : undefined,
            note: form.note || undefined,
          })
        }
      >
        <Row>
          <TextInput label="Asset tag" value={form.tag} onChange={(v) => setForm({ ...form, tag: v })} required />
          <SelectInput
            label="Category"
            value={form.category}
            onChange={(v) => setForm({ ...form, category: v as Asset['category'] })}
            options={[
              { value: 'laptop', label: 'Laptop' },
              { value: 'phone', label: 'Phone' },
              { value: 'access_card', label: 'Access card' },
              { value: 'other', label: 'Other' },
            ]}
          />
        </Row>
        <Row>
          <TextInput label="Serial number" value={form.serial} onChange={(v) => setForm({ ...form, serial: v })} />
          <TextInput label="Cost" type="number" value={form.cost} onChange={(v) => setForm({ ...form, cost: v })} hint="₹, optional" />
        </Row>
        <TextArea label="Note" value={form.note} onChange={(v) => setForm({ ...form, note: v })} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

interface AssetAssignment {
  id: string;
  assetId: string;
  employmentRelationshipId: string;
  issuedOn: string;
  returnedOn: string | null;
  condition: string;
  asset: Asset;
}

function AssignmentsTab() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [returning, setReturning] = useState<AssetAssignment | null>(null);
  const [returnCondition, setReturnCondition] = useState<'good' | 'fair' | 'poor'>('good');
  const [form, setForm] = useState({ assetId: '', employmentRelationshipId: '', condition: 'good' as 'good' | 'fair' | 'poor' });

  const assignments = useQuery({ queryKey: ['assets-assignments'], queryFn: () => api.get<AssetAssignment[]>('/hcm/assets/assignments') });
  const inStock = useQuery({ queryKey: ['assets-inventory', 'in_stock'], queryFn: () => api.get<Asset[]>('/hcm/assets/inventory?status=in_stock') });

  const returnMutation = useMutation({
    mutationFn: () => api.post(`/hcm/assets/assignments/${returning!.id}/return`, { condition: returnCondition }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets-assignments'] });
      qc.invalidateQueries({ queryKey: ['assets-inventory'] });
      setReturning(null);
    },
  });

  return (
    <Card
      title="Assignments"
      subtitle="Who is holding what, and since when. Returning an item in poor condition sends it to repair instead of straight back to stock."
      actions={can('asset_assignments:create') && <NewButton label="Issue asset" onClick={() => setOpen(true)} />}
    >
      {assignments.isLoading && <Loading />}
      {assignments.error && <ErrorBox error={assignments.error} />}
      {assignments.data && assignments.data.length === 0 && <EmptyState message="No assets are currently issued to anyone." />}
      {assignments.data && assignments.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Employment</th>
              <th>Issued</th>
              <th>Returned</th>
              <th>Condition</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {assignments.data.map((a) => (
              <tr key={a.id}>
                <td className="font-mono text-2xs">{a.asset.tag}</td>
                <td className="font-mono text-2xs">{a.employmentRelationshipId}</td>
                <td>{date(a.issuedOn)}</td>
                <td>{a.returnedOn ? date(a.returnedOn) : '—'}</td>
                <td>{a.condition}</td>
                <td className="text-right">
                  {!a.returnedOn && can('asset_assignments:edit') && (
                    <button className="btn text-2xs" onClick={() => { setReturning(a); setReturnCondition('good'); }}>
                      Return
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
        title="Issue an asset"
        onClose={() => setOpen(false)}
        invalidate={[['assets-assignments'], ['assets-inventory']]}
        onSubmit={() => api.post('/hcm/assets/assignments', form)}
      >
        <SelectInput
          label="Asset"
          value={form.assetId}
          onChange={(v) => setForm({ ...form, assetId: v })}
          placeholder="Choose an in-stock asset"
          required
          options={(inStock.data ?? []).map((a) => ({ value: a.id, label: `${a.tag} (${a.category})` }))}
        />
        <TextInput
          label="Employment relationship ID"
          value={form.employmentRelationshipId}
          onChange={(v) => setForm({ ...form, employmentRelationshipId: v })}
          required
        />
        <SelectInput
          label="Issue condition"
          value={form.condition}
          onChange={(v) => setForm({ ...form, condition: v as typeof form.condition })}
          options={[
            { value: 'good', label: 'Good' },
            { value: 'fair', label: 'Fair' },
            { value: 'poor', label: 'Poor' },
          ]}
        />
      </CreateModal>

      <CreateModal
        open={returning !== null}
        title={`Return ${returning?.asset.tag ?? ''}`}
        submitLabel="Record return"
        onClose={() => setReturning(null)}
        invalidate={[['assets-assignments'], ['assets-inventory']]}
        onSubmit={() => returnMutation.mutateAsync()}
      >
        <SelectInput
          label="Condition on return"
          value={returnCondition}
          onChange={(v) => setReturnCondition(v as typeof returnCondition)}
          options={[
            { value: 'good', label: 'Good — back to stock' },
            { value: 'fair', label: 'Fair — back to stock' },
            { value: 'poor', label: 'Poor — sent to repair' },
          ]}
        />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Travel
// ---------------------------------------------------------------------------

interface TravelRequest {
  id: string;
  recordCode: string;
  employmentRelationshipId: string;
  purpose: string;
  fromLocation: string;
  toLocation: string;
  startDate: string;
  endDate: string;
  mode: string;
  estimatedCost: number | null;
  advanceRequested: number | null;
  status: string;
  expenseClaimId: string | null;
}

function TravelTab() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [settling, setSettling] = useState<TravelRequest | null>(null);
  const [claimId, setClaimId] = useState('');

  const requests = useQuery({ queryKey: ['assets-travel'], queryFn: () => api.get<TravelRequest[]>('/hcm/assets/travel') });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      api.post(`/hcm/assets/travel/${id}/decide`, { decision }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets-travel'] }),
    onError: (e) => setError(messageOf(e)),
  });

  const settle = useMutation({
    mutationFn: () => api.post(`/hcm/assets/travel/${settling!.id}/settle`, { expenseClaimId: claimId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets-travel'] });
      setSettling(null);
      setClaimId('');
    },
  });

  return (
    <Card
      title="Travel requests"
      subtitle="Submitted from an employee's own /me/requests. Decided here by someone other than the traveller — the Self-Dealing Bar refuses a traveller deciding their own request."
    >
      {error && <ErrorBox error={error} />}
      {requests.isLoading && <Loading />}
      {requests.error && <ErrorBox error={requests.error} />}
      {requests.data && requests.data.length === 0 && <EmptyState message="No travel requests yet." />}
      {requests.data && requests.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Route</th>
              <th>Dates</th>
              <th>Mode</th>
              <th>Est. cost</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {requests.data.map((r) => (
              <tr key={r.id}>
                <td className="font-mono text-2xs">{r.recordCode}</td>
                <td>{r.fromLocation} → {r.toLocation}<p className="text-2xs text-ink-500">{r.purpose}</p></td>
                <td>{date(r.startDate)} – {date(r.endDate)}</td>
                <td>{r.mode}</td>
                <td>{money(r.estimatedCost)}</td>
                <td><StatusChip status={r.status} tone={STATUS_TONE[r.status]} /></td>
                <td className="text-right whitespace-nowrap">
                  {r.status === 'submitted' && can('travel_requests:approve') && (
                    <>
                      <button className="btn text-2xs" onClick={() => decide.mutate({ id: r.id, decision: 'approved' })}>
                        Approve
                      </button>{' '}
                      <button className="btn text-2xs" onClick={() => decide.mutate({ id: r.id, decision: 'rejected' })}>
                        Reject
                      </button>
                    </>
                  )}
                  {r.status === 'approved' && can('travel_requests:edit') && (
                    <button className="btn text-2xs" onClick={() => { setSettling(r); setClaimId(''); }}>
                      Settle
                    </button>
                  )}
                  {r.status === 'settled' && <span className="text-2xs text-ink-500 font-mono">{r.expenseClaimId}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={settling !== null}
        title="Settle against an expense claim"
        submitLabel="Settle"
        onClose={() => setSettling(null)}
        invalidate={[['assets-travel']]}
        onSubmit={() => settle.mutateAsync()}
      >
        <TextInput label="Expense claim ID" value={claimId} onChange={setClaimId} required hint="From Payroll ops → Expense claims" />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

interface LetterRequest {
  id: string;
  employmentRelationshipId: string;
  kind: string;
  status: string;
  number: string | null;
  hrLetterId: string | null;
  snapshot: { body: string } | null;
  createdAt: string;
}

function LettersTab() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<LetterRequest | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [viewing, setViewing] = useState<LetterRequest | null>(null);

  const requests = useQuery({ queryKey: ['assets-letters'], queryFn: () => api.get<LetterRequest[]>('/hcm/assets/letters') });

  const fulfil = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/assets/letters/${id}/fulfil`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets-letters'] }),
    onError: (e) => setError(messageOf(e)),
  });

  const reject = useMutation({
    mutationFn: () => api.post(`/hcm/assets/letters/${rejecting!.id}/reject`, { note: rejectNote }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets-letters'] });
      setRejecting(null);
      setRejectNote('');
    },
  });

  return (
    <Card
      title="Letter requests"
      subtitle="Address proof, salary certificate, NOC and visa letters are this workstream's own snapshot; an experience letter issues through compliance labour as a real HrLetter."
    >
      {error && <ErrorBox error={error} />}
      {requests.isLoading && <Loading />}
      {requests.error && <ErrorBox error={requests.error} />}
      {requests.data && requests.data.length === 0 && <EmptyState message="No letter requests yet." />}
      {requests.data && requests.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Employment</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Number</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {requests.data.map((r) => (
              <tr key={r.id}>
                <td className="font-mono text-2xs">{r.employmentRelationshipId}</td>
                <td>{r.kind.replace(/_/g, ' ')}</td>
                <td><StatusChip status={r.status} tone={STATUS_TONE[r.status]} /></td>
                <td className="font-mono text-2xs">{r.number ?? '—'}</td>
                <td className="text-right whitespace-nowrap">
                  {r.status === 'requested' && can('letter_requests:edit') && (
                    <>
                      <button className="btn text-2xs" onClick={() => fulfil.mutate(r.id)}>
                        Fulfil
                      </button>{' '}
                      <button className="btn text-2xs" onClick={() => { setRejecting(r); setRejectNote(''); }}>
                        Reject
                      </button>
                    </>
                  )}
                  {r.status === 'fulfilled' && r.snapshot && (
                    <button className="btn text-2xs" onClick={() => setViewing(r)}>
                      View
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {viewing?.snapshot && (
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

      <CreateModal
        open={rejecting !== null}
        title="Reject this letter request"
        submitLabel="Reject"
        onClose={() => setRejecting(null)}
        invalidate={[['assets-letters']]}
        onSubmit={() => reject.mutateAsync()}
      >
        <TextArea label="Reason" value={rejectNote} onChange={setRejectNote} required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ID cards
// ---------------------------------------------------------------------------

interface IdCard {
  id: string;
  employmentRelationshipId: string;
  cardNumber: string;
  status: string;
  issuedOn: string;
  returnedOn: string | null;
}

function IdCardsTab() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [employmentId, setEmploymentId] = useState('');

  const cards = useQuery({ queryKey: ['assets-idcards'], queryFn: () => api.get<IdCard[]>('/hcm/assets/idcards') });

  const issue = useMutation({
    mutationFn: () => api.post('/hcm/assets/idcards', { employmentRelationshipId: employmentId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets-idcards'] }),
  });

  const lost = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/assets/idcards/${id}/lost`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets-idcards'] }),
  });

  const returned = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/assets/idcards/${id}/return`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets-idcards'] }),
  });

  return (
    <Card
      title="ID cards"
      subtitle="A lost card is marked lost and a fresh card number is issued in the same action — the old row stays as the record of what happened to it."
      actions={can('hcm_assets:create') && <NewButton label="Issue card" onClick={() => { setEmploymentId(''); setOpen(true); }} />}
    >
      {cards.isLoading && <Loading />}
      {cards.error && <ErrorBox error={cards.error} />}
      {cards.data && cards.data.length === 0 && <EmptyState message="No ID cards issued yet." />}
      {cards.data && cards.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Employment</th>
              <th>Card number</th>
              <th>Status</th>
              <th>Issued</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cards.data.map((c) => (
              <tr key={c.id}>
                <td className="font-mono text-2xs">{c.employmentRelationshipId}</td>
                <td className="font-mono text-2xs">{c.cardNumber}</td>
                <td><StatusChip status={c.status} tone={STATUS_TONE[c.status]} /></td>
                <td>{date(c.issuedOn)}</td>
                <td className="text-right whitespace-nowrap">
                  {c.status === 'issued' && can('hcm_assets:edit') && (
                    <>
                      <button className="btn text-2xs" onClick={() => lost.mutate(c.id)}>
                        Report lost
                      </button>{' '}
                      <button className="btn text-2xs" onClick={() => returned.mutate(c.id)}>
                        Return
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal open={open} title="Issue an ID card" onClose={() => setOpen(false)} invalidate={[['assets-idcards']]} onSubmit={() => issue.mutateAsync()}>
        <TextInput label="Employment relationship ID" value={employmentId} onChange={setEmploymentId} required />
      </CreateModal>
    </Card>
  );
}
