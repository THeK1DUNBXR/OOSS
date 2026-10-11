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
import { date, money } from '../../lib/api.js';
import {
  decimalAmount,
  hcmApi,
  type Asset,
  type AssetAssignment,
  type IdCard,
  type LetterRequest,
  type TravelRequest,
} from '../../lib/hcmApi.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';
import { useSession } from '../../lib/session.js';
import { Card, ErrorBox, PageHeader, StatusChip, Tabs, Withheld } from '../../components/ui.js';
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

/**
 * A null money value is withheld, not zero: the API nulls it for a caller
 * without the financial grant, and a withheld figure must not read as ₹0.
 */
function moneyOrWithheld(v: string | null): React.ReactNode {
  return v === null ? <Withheld reason="no_permission" /> : money(decimalAmount(v));
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

function InventoryTab() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    tag: '',
    category: 'laptop' as Asset['category'],
    serial: '',
    cost: '',
    note: '',
  });

  const assets = useQuery({ queryKey: ['assets-inventory'], queryFn: () => hcmApi.assets.inventory.list() });

  const transition = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => hcmApi.assets.inventory.transition(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets-inventory'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<Asset>> = [
    {
      id: 'tag',
      header: 'Tag',
      sortValue: (a) => a.tag,
      cell: (a) => <span className="font-mono text-2xs">{a.tag}</span>,
    },
    { id: 'category', header: 'Category', sortValue: (a) => a.category, cell: (a) => a.category.replace(/_/g, ' ') },
    { id: 'serial', header: 'Serial', sortValue: (a) => a.serial, cell: (a) => a.serial ?? '—' },
    {
      id: 'purchased',
      header: 'Purchased',
      sortValue: (a) => a.purchaseDate,
      cell: (a) => (a.purchaseDate ? date(a.purchaseDate) : '—'),
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      sortValue: (a) => decimalAmount(a.cost),
      cell: (a) => moneyOrWithheld(a.cost),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (a) => a.status,
      cell: (a) => <StatusChip status={a.status} tone={STATUS_TONE[a.status]} />,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (a) => (
        <>
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
        </>
      ),
    },
  ];

  return (
    <Card
      title="Inventory"
      subtitle="Laptops, phones, access cards and other equipment the company issues and reclaims."
      actions={can('hcm_assets:create') && <NewButton label="Add asset" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Asset inventory"
        columns={columns}
        rows={assets.data ?? []}
        rowKey={(a) => a.id}
        loading={assets.isLoading}
        error={assets.error}
        emptyMessage="No assets recorded yet."
        emptyHint="Add a laptop, phone or access card to start tracking who holds it."
      />

      <CreateModal
        open={open}
        title="Add an asset"
        onClose={() => setOpen(false)}
        invalidate={[['assets-inventory']]}
        onSubmit={() =>
          hcmApi.assets.inventory.create({
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
          <TextInput
            label="Cost"
            type="number"
            value={form.cost}
            onChange={(v) => setForm({ ...form, cost: v })}
            hint="₹, optional"
          />
        </Row>
        <TextArea label="Note" value={form.note} onChange={(v) => setForm({ ...form, note: v })} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

function AssignmentsTab() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [returning, setReturning] = useState<AssetAssignment | null>(null);
  const [returnCondition, setReturnCondition] = useState<'good' | 'fair' | 'poor'>('good');
  const [form, setForm] = useState({
    assetId: '',
    employmentRelationshipId: '',
    condition: 'good' as 'good' | 'fair' | 'poor',
  });

  const assignments = useQuery({
    queryKey: ['assets-assignments'],
    queryFn: () => hcmApi.assets.assignments.list(),
  });
  const inStock = useQuery({
    queryKey: ['assets-inventory', 'in_stock'],
    queryFn: () => hcmApi.assets.inventory.list('in_stock'),
  });

  const returnMutation = useMutation({
    mutationFn: () => hcmApi.assets.assignments.return(returning!.id, returnCondition),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets-assignments'] });
      qc.invalidateQueries({ queryKey: ['assets-inventory'] });
      setReturning(null);
    },
  });

  const columns: ReadonlyArray<DataTableColumn<AssetAssignment>> = [
    {
      id: 'asset',
      header: 'Asset',
      sortValue: (a) => a.asset.tag,
      cell: (a) => <span className="font-mono text-2xs">{a.asset.tag}</span>,
    },
    {
      id: 'employment',
      header: 'Employment',
      sortValue: (a) => a.employmentRelationshipId,
      cell: (a) => <span className="font-mono text-2xs">{a.employmentRelationshipId}</span>,
    },
    { id: 'issued', header: 'Issued', sortValue: (a) => a.issuedOn, cell: (a) => date(a.issuedOn) },
    {
      id: 'returned',
      header: 'Returned',
      sortValue: (a) => a.returnedOn,
      cell: (a) => (a.returnedOn ? date(a.returnedOn) : '—'),
    },
    { id: 'condition', header: 'Condition', sortValue: (a) => a.condition, cell: (a) => a.condition },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (a) =>
        !a.returnedOn &&
        can('asset_assignments:edit') && (
          <button
            className="btn text-2xs"
            onClick={() => {
              setReturning(a);
              setReturnCondition('good');
            }}
          >
            Return
          </button>
        ),
    },
  ];

  return (
    <Card
      title="Assignments"
      subtitle="Who is holding what, and since when. Returning an item in poor condition sends it to repair instead of straight back to stock."
      actions={can('asset_assignments:create') && <NewButton label="Issue asset" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Asset assignments"
        columns={columns}
        rows={assignments.data ?? []}
        rowKey={(a) => a.id}
        loading={assignments.isLoading}
        error={assignments.error}
        emptyMessage="No assets are currently issued to anyone."
      />

      <CreateModal
        open={open}
        title="Issue an asset"
        onClose={() => setOpen(false)}
        invalidate={[['assets-assignments'], ['assets-inventory']]}
        onSubmit={() => hcmApi.assets.assignments.issue(form)}
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

function TravelTab() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [settling, setSettling] = useState<TravelRequest | null>(null);
  const [claimId, setClaimId] = useState('');

  const requests = useQuery({
    queryKey: ['assets-travel'],
    queryFn: () => hcmApi.assets.travel.list(),
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      hcmApi.assets.travel.decide(id, decision),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets-travel'] }),
    onError: (e) => setError(messageOf(e)),
  });

  const settle = useMutation({
    mutationFn: () => hcmApi.assets.travel.settle(settling!.id, claimId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets-travel'] });
      setSettling(null);
      setClaimId('');
    },
  });

  const columns: ReadonlyArray<DataTableColumn<TravelRequest>> = [
    {
      id: 'code',
      header: 'Code',
      sortValue: (r) => r.recordCode,
      cell: (r) => <span className="font-mono text-2xs">{r.recordCode}</span>,
    },
    {
      id: 'route',
      header: 'Route',
      sortValue: (r) => r.fromLocation,
      cell: (r) => (
        <>
          {r.fromLocation} → {r.toLocation}
          <p className="text-2xs text-ink-500">{r.purpose}</p>
        </>
      ),
    },
    {
      id: 'dates',
      header: 'Dates',
      sortValue: (r) => r.startDate,
      cell: (r) => (
        <>
          {date(r.startDate)} – {date(r.endDate)}
        </>
      ),
    },
    { id: 'mode', header: 'Mode', sortValue: (r) => r.mode, cell: (r) => r.mode },
    {
      id: 'cost',
      header: 'Est. cost',
      align: 'right',
      sortValue: (r) => decimalAmount(r.estimatedCost),
      cell: (r) => moneyOrWithheld(r.estimatedCost),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => <StatusChip status={r.status} tone={STATUS_TONE[r.status]} />,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cellClassName: 'whitespace-nowrap',
      cell: (r) => (
        <>
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
            <button
              className="btn text-2xs"
              onClick={() => {
                setSettling(r);
                setClaimId('');
              }}
            >
              Settle
            </button>
          )}
          {r.status === 'settled' && <span className="font-mono text-2xs text-ink-500">{r.expenseClaimId}</span>}
        </>
      ),
    },
  ];

  return (
    <Card
      title="Travel requests"
      subtitle="Submitted from an employee's own /me/requests. Decided here by someone other than the traveller — the Self-Dealing Bar refuses a traveller deciding their own request."
    >
      {error && <ErrorBox error={error} />}
      <DataTable
        caption="Travel requests"
        columns={columns}
        rows={requests.data ?? []}
        rowKey={(r) => r.id}
        loading={requests.isLoading}
        error={requests.error}
        emptyMessage="No travel requests yet."
      />

      <CreateModal
        open={settling !== null}
        title="Settle against an expense claim"
        submitLabel="Settle"
        onClose={() => setSettling(null)}
        invalidate={[['assets-travel']]}
        onSubmit={() => settle.mutateAsync()}
      >
        <TextInput
          label="Expense claim ID"
          value={claimId}
          onChange={setClaimId}
          required
          hint="From Payroll ops → Expense claims"
        />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

function LettersTab() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<LetterRequest | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [viewing, setViewing] = useState<LetterRequest | null>(null);

  const requests = useQuery({
    queryKey: ['assets-letters'],
    queryFn: () => hcmApi.assets.letters.list(),
  });

  const fulfil = useMutation({
    mutationFn: (id: string) => hcmApi.assets.letters.fulfil(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets-letters'] }),
    onError: (e) => setError(messageOf(e)),
  });

  const reject = useMutation({
    mutationFn: () => hcmApi.assets.letters.reject(rejecting!.id, rejectNote),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets-letters'] });
      setRejecting(null);
      setRejectNote('');
    },
  });

  const columns: ReadonlyArray<DataTableColumn<LetterRequest>> = [
    {
      id: 'employment',
      header: 'Employment',
      sortValue: (r) => r.employmentRelationshipId,
      cell: (r) => <span className="font-mono text-2xs">{r.employmentRelationshipId}</span>,
    },
    { id: 'kind', header: 'Kind', sortValue: (r) => r.kind, cell: (r) => r.kind.replace(/_/g, ' ') },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => <StatusChip status={r.status} tone={STATUS_TONE[r.status]} />,
    },
    {
      id: 'number',
      header: 'Number',
      sortValue: (r) => r.number,
      cell: (r) => <span className="font-mono text-2xs">{r.number ?? '—'}</span>,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cellClassName: 'whitespace-nowrap',
      cell: (r) => (
        <>
          {r.status === 'requested' && can('letter_requests:edit') && (
            <>
              <button className="btn text-2xs" onClick={() => fulfil.mutate(r.id)}>
                Fulfil
              </button>{' '}
              <button
                className="btn text-2xs"
                onClick={() => {
                  setRejecting(r);
                  setRejectNote('');
                }}
              >
                Reject
              </button>
            </>
          )}
          {r.status === 'fulfilled' && r.snapshot && (
            <button className="btn text-2xs" onClick={() => setViewing(r)}>
              View
            </button>
          )}
        </>
      ),
    },
  ];

  return (
    <Card
      title="Letter requests"
      subtitle="Address proof, salary certificate, NOC and visa letters are this workstream's own snapshot; an experience letter issues through compliance labour as a real HrLetter."
    >
      {error && <ErrorBox error={error} />}
      <DataTable
        caption="Letter requests"
        columns={columns}
        rows={requests.data ?? []}
        rowKey={(r) => r.id}
        loading={requests.isLoading}
        error={requests.error}
        emptyMessage="No letter requests yet."
      />

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

function IdCardsTab() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [employmentId, setEmploymentId] = useState('');

  const cards = useQuery({ queryKey: ['assets-idcards'], queryFn: () => hcmApi.assets.idCards.list() });

  const issue = useMutation({
    mutationFn: () => hcmApi.assets.idCards.issue(employmentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets-idcards'] }),
  });

  const lost = useMutation({
    mutationFn: (id: string) => hcmApi.assets.idCards.reportLost(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets-idcards'] }),
  });

  const returned = useMutation({
    mutationFn: (id: string) => hcmApi.assets.idCards.returnCard(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets-idcards'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<IdCard>> = [
    {
      id: 'employment',
      header: 'Employment',
      sortValue: (c) => c.employmentRelationshipId,
      cell: (c) => <span className="font-mono text-2xs">{c.employmentRelationshipId}</span>,
    },
    {
      id: 'number',
      header: 'Card number',
      sortValue: (c) => c.cardNumber,
      cell: (c) => <span className="font-mono text-2xs">{c.cardNumber}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (c) => c.status,
      cell: (c) => <StatusChip status={c.status} tone={STATUS_TONE[c.status]} />,
    },
    { id: 'issued', header: 'Issued', sortValue: (c) => c.issuedOn, cell: (c) => date(c.issuedOn) },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cellClassName: 'whitespace-nowrap',
      cell: (c) =>
        c.status === 'issued' &&
        can('hcm_assets:edit') && (
          <>
            <button className="btn text-2xs" onClick={() => lost.mutate(c.id)}>
              Report lost
            </button>{' '}
            <button className="btn text-2xs" onClick={() => returned.mutate(c.id)}>
              Return
            </button>
          </>
        ),
    },
  ];

  return (
    <Card
      title="ID cards"
      subtitle="A lost card is marked lost and a fresh card number is issued in the same action — the old row stays as the record of what happened to it."
      actions={
        can('hcm_assets:create') && (
          <NewButton
            label="Issue card"
            onClick={() => {
              setEmploymentId('');
              setOpen(true);
            }}
          />
        )
      }
    >
      <DataTable
        caption="ID cards"
        columns={columns}
        rows={cards.data ?? []}
        rowKey={(c) => c.id}
        loading={cards.isLoading}
        error={cards.error}
        emptyMessage="No ID cards issued yet."
      />

      <CreateModal
        open={open}
        title="Issue an ID card"
        onClose={() => setOpen(false)}
        invalidate={[['assets-idcards']]}
        onSubmit={() => issue.mutateAsync()}
      >
        <TextInput label="Employment relationship ID" value={employmentId} onChange={setEmploymentId} required />
      </CreateModal>
    </Card>
  );
}
