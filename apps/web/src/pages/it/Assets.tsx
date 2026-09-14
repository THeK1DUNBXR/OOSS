/**
 * Technology — assets and devices (docs/plan/cio.md, workstream A).
 *
 * `FixedAsset` (the books) is cost and depreciation; this is the other half —
 * who is holding the thing, its warranty, and the state it is in. Every
 * button on the detail page comes from `availableTransitions`, computed by
 * the same machine the API enforces against, so this screen can never offer
 * a move that will be refused. Assigning and returning write to the
 * append-only hand-over log; a plain transition (repair/retire/dispose)
 * writes to the append-only event log — neither ever edits an earlier row.
 */

import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, dateTime, relative, titleCase } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Metric,
  Modal,
  PageHeader,
  RecordCode,
  StatusChip,
  Tabs,
} from '../../components/ui.js';
import { NewButton, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AssetStatus = 'in_stock' | 'assigned' | 'in_repair' | 'retired' | 'disposed';
type LifecycleEvent = 'ASSIGN' | 'RETURN' | 'SEND_TO_REPAIR' | 'BACK_FROM_REPAIR' | 'RETIRE' | 'DISPOSE';

const KINDS = ['laptop', 'desktop', 'phone', 'monitor', 'peripheral', 'network', 'server', 'other'] as const;
const CONDITIONS = ['new', 'good', 'fair', 'poor', 'damaged'] as const;

interface AssetRow {
  id: string;
  recordCode: string;
  tag: string;
  kind: string;
  make: string | null;
  model: string | null;
  serial: string | null;
  status: AssetStatus;
  condition: string | null;
  location: string | null;
  division: string | null;
  warrantyEnd: string | null;
  holderPartyId: string | null;
  holderName: string | null;
  availableTransitions: LifecycleEvent[];
}

interface Assignment {
  id: string;
  partyId: string;
  holderName: string | null;
  assignedAt: string;
  assignedById: string | null;
  conditionOut: string | null;
  returnedAt: string | null;
  conditionIn: string | null;
  acknowledgedAt: string | null;
  note: string | null;
}

interface AssetEvent {
  id: string;
  kind: string;
  detail: string;
  actorPartyId: string | null;
  createdAt: string;
}

interface FixedAssetRef {
  id: string;
  recordCode: string;
  name: string;
  cost: number;
  disposedAt: string | null;
}

interface AssetDetailResponse extends AssetRow {
  purchaseDate: string | null;
  purchaseCost: number | null;
  supplierName: string | null;
  vendorId: string | null;
  fixedAssetId: string | null;
  /** Resolved server-side from the bare `fixedAssetId` — never a Prisma
   * relation across workstream files, but the name/cost a person actually
   * wants to see rather than a raw id. */
  fixedAsset: FixedAssetRef | null;
  /** The books' cost when capitalised, else the purchase cost typed in here
   * — never both (Principle 8: money stays in the books). */
  bookValue: number | null;
  notes: string | null;
  assignments: Assignment[];
  events: AssetEvent[];
}

interface Summary {
  notYetMeasured: boolean;
  total: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  warrantyExpiringIn90Days: number;
  unassignedStock: number;
  topHolders: Array<{ partyId: string; fullName: string; count: number }>;
  bookValue: number;
  fixedAssetLinkedCount: number;
}

const STATUS_TONE: Record<AssetStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  in_stock: 'neutral',
  assigned: 'good',
  in_repair: 'warn',
  retired: 'bad',
  disposed: 'bad',
};

const EVENT_LABEL: Record<LifecycleEvent, string> = {
  ASSIGN: 'Assign',
  RETURN: 'Return',
  SEND_TO_REPAIR: 'Send to repair',
  BACK_FROM_REPAIR: 'Back from repair',
  RETIRE: 'Retire',
  DISPOSE: 'Dispose',
};

/** The list endpoint's rows, whichever shape it returns them in — mirrors
 * `rowsOf`/`useList` in `components/createForms.tsx`, kept inline here per
 * the workstream's own file (that file is owned by another surface). */
function rowsOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const items = (data as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

function useList<T>(key: string, path: string, enabled = true) {
  const query = useQuery({ queryKey: [key], queryFn: () => api.get<unknown>(path), enabled });
  return { ...query, rows: rowsOf<T>(query.data) };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function ItAssets() {
  const { can } = useSession();
  const [status, setStatus] = useState<AssetStatus | 'all'>('all');
  const [kind, setKind] = useState<string>('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const summary = useQuery({ queryKey: ['it-assets-summary'], queryFn: () => api.get<Summary>('/it/assets/summary') });

  const params = new URLSearchParams();
  if (status !== 'all') params.set('status', status);
  if (kind) params.set('kind', kind);
  if (search.trim()) params.set('search', search.trim());
  const qs = params.toString();

  const assets = useQuery({
    queryKey: ['it-assets', status, kind, search],
    queryFn: () => api.get<AssetRow[]>(`/it/assets${qs ? `?${qs}` : ''}`),
  });

  if (assets.error) return <ErrorBox error={assets.error} />;

  const s = summary.data;
  const rows = assets.data ?? [];

  return (
    <div>
      <PageHeader
        title="Assets"
        subtitle="Laptops, phones, monitors and everything else IT hands out — who is holding each one, its warranty, and where it stands. Book value and depreciation live in the books; this is the operational half."
        actions={can('it_assets:C') ? <NewButton label="New asset" onClick={() => setCreating(true)} /> : undefined}
      />

      {s?.notYetMeasured ? (
        <Card className="mb-5">
          <EmptyState message="No assets on file yet." hint="Add the first one to start tracking warranty, holders and repairs." />
        </Card>
      ) : (
        s && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Fleet" value={s.total} noActionReason="Every asset on file, any status." />
            <Metric
              label="Warranty expiring"
              value={s.warrantyExpiringIn90Days}
              tone={s.warrantyExpiringIn90Days > 0 ? 'warn' : 'good'}
              noActionReason="Within 90 days, not yet retired or disposed."
            />
            <Metric label="Unassigned stock" value={s.unassignedStock} noActionReason="In stock, ready to issue." />
            <Metric label="Book value" value={`₹${s.bookValue.toLocaleString('en-IN')}`} noActionReason="Sum of purchase cost, non-disposed." />
          </div>
        )
      )}

      <Tabs
        tabs={[
          { key: 'all', label: 'All', count: s?.total },
          { key: 'in_stock', label: 'In stock', count: s?.byStatus.in_stock },
          { key: 'assigned', label: 'Assigned', count: s?.byStatus.assigned },
          { key: 'in_repair', label: 'In repair', count: s?.byStatus.in_repair },
          { key: 'retired', label: 'Retired', count: s?.byStatus.retired },
          { key: 'disposed', label: 'Disposed', count: s?.byStatus.disposed },
        ]}
        active={status}
        onChange={setStatus}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select className="input max-w-40" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Every kind</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {titleCase(k)}
            </option>
          ))}
        </select>
        <input
          className="input max-w-xs"
          placeholder="Search by tag, serial or holder"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Card bodyClassName="p-0">
        {assets.isLoading ? (
          <Loading label="Loading assets" />
        ) : rows.length === 0 ? (
          <EmptyState message="Nothing matches." hint="Widen the tab or filter, or add a new asset." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2">Tag</th>
                  <th className="px-4 py-2">Kind</th>
                  <th className="px-4 py-2">Make / model</th>
                  <th className="px-4 py-2">Holder</th>
                  <th className="px-4 py-2">Warranty</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-b border-ink-850/60">
                    <td className="px-4 py-2">
                      <Link to={`/it/assets/${a.id}`} className="font-medium text-ink-100 hover:text-accent">
                        {a.tag}
                      </Link>
                      <div className="text-2xs text-ink-500">
                        <RecordCode code={a.recordCode} />
                      </div>
                    </td>
                    <td className="px-4 py-2 text-ink-300">{titleCase(a.kind)}</td>
                    <td className="px-4 py-2 text-ink-300">{[a.make, a.model].filter(Boolean).join(' ') || '—'}</td>
                    <td className="px-4 py-2 text-ink-300">{a.holderName ?? '—'}</td>
                    <td className="px-4 py-2 text-ink-300">{a.warrantyEnd ? date(a.warrantyEnd) : '—'}</td>
                    <td className="px-4 py-2">
                      <StatusChip status={a.status} tone={STATUS_TONE[a.status]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="mt-4 text-2xs italic text-ink-500">
        Seats in use, logins and device discovery are not tracked here — every field on this page is typed in.
      </p>

      {creating && <NewAssetModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewAssetModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [tag, setTag] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number] | ''>('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [serial, setSerial] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [purchaseCost, setPurchaseCost] = useState('');
  const [warrantyEnd, setWarrantyEnd] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [location, setLocation] = useState('');
  const [condition, setCondition] = useState<(typeof CONDITIONS)[number] | ''>('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/it/assets', {
        tag,
        kind,
        make: make || undefined,
        model: model || undefined,
        serial: serial || undefined,
        purchaseDate: purchaseDate || undefined,
        purchaseCost: purchaseCost ? Number(purchaseCost) : undefined,
        warrantyEnd: warrantyEnd || undefined,
        supplierName: supplierName || undefined,
        location: location || undefined,
        condition: condition || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-assets'] });
      qc.invalidateQueries({ queryKey: ['it-assets-summary'] });
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="New asset"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-asset-form" className="btn-primary" disabled={mutation.isPending || !tag.trim() || !kind}>
            {mutation.isPending ? 'Saving…' : 'Create'}
          </button>
        </>
      }
    >
      <form
        id="new-asset-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        {error && (
          <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>
        )}
        <TextInput label="Tag" value={tag} onChange={setTag} required autoFocus hint="How it's referred to on the floor" />
        <SelectInput
          label="Kind"
          value={kind}
          onChange={setKind}
          required
          placeholder="Choose a kind"
          options={KINDS.map((k) => ({ value: k, label: titleCase(k) }))}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Make" value={make} onChange={setMake} />
          <TextInput label="Model" value={model} onChange={setModel} />
        </div>
        <TextInput label="Serial" value={serial} onChange={setSerial} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Purchase date" type="date" value={purchaseDate} onChange={setPurchaseDate} />
          <TextInput label="Purchase cost" type="number" value={purchaseCost} onChange={setPurchaseCost} />
        </div>
        <TextInput label="Warranty end" type="date" value={warrantyEnd} onChange={setWarrantyEnd} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Supplier" value={supplierName} onChange={setSupplierName} />
          <TextInput label="Location" value={location} onChange={setLocation} />
        </div>
        <SelectInput
          label="Condition"
          value={condition}
          onChange={setCondition}
          placeholder="Not recorded"
          options={CONDITIONS.map((c) => ({ value: c, label: titleCase(c) }))}
        />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function ItAssetDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useSession();
  const [assigning, setAssigning] = useState(false);
  const [returning, setReturning] = useState(false);
  const [noting, setNoting] = useState(false);
  const [pendingTransition, setPendingTransition] = useState<LifecycleEvent | null>(null);

  const asset = useQuery({ queryKey: ['it-asset', id], queryFn: () => api.get<AssetDetailResponse>(`/it/assets/${id}`), enabled: Boolean(id) });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['it-asset', id] });
    qc.invalidateQueries({ queryKey: ['it-assets'] });
    qc.invalidateQueries({ queryKey: ['it-assets-summary'] });
  };

  const transition = useMutation({
    mutationFn: (event: LifecycleEvent) => api.post(`/it/assets/${id}/transition`, { event }),
    onSuccess: invalidate,
  });

  if (asset.error) return <ErrorBox error={asset.error} />;
  if (asset.isLoading || !asset.data) return <Loading label="Loading the asset" />;

  const a = asset.data;
  const events = a.events ?? [];
  const timeline = useMemo(() => {
    type Row = { id: string; at: string; label: string; body: string };
    const fromAssignments: Row[] = a.assignments.flatMap((row) => {
      const rows: Row[] = [
        {
          id: `${row.id}-out`,
          at: row.assignedAt,
          label: 'Assigned',
          body: `To ${row.holderName ?? row.partyId}${row.conditionOut ? ` — condition ${row.conditionOut}` : ''}${row.note ? `. ${row.note}` : ''}`,
        },
      ];
      if (row.returnedAt) {
        rows.push({
          id: `${row.id}-in`,
          at: row.returnedAt,
          label: 'Returned',
          body: `From ${row.holderName ?? row.partyId}${row.conditionIn ? ` — condition ${row.conditionIn}` : ''}${row.acknowledgedAt ? '' : ' (not yet acknowledged)'}`,
        });
      }
      return rows;
    });
    const fromEvents: Row[] = events.map((e) => ({ id: e.id, at: e.createdAt, label: titleCase(e.kind), body: e.detail }));
    return [...fromAssignments, ...fromEvents].sort((x, y) => y.at.localeCompare(x.at));
  }, [a.assignments, events]);

  const canEdit = can('it_assets:E');
  // Assign/return are their own grant (`A`, distinct from `E`) — the
  // Operations Head cell is `VCEDAX`, not every `E` holder gets to hand an
  // asset to someone.
  const canAssign = can('it_assets:A');
  const permittedFor = (event: LifecycleEvent) => (event === 'ASSIGN' || event === 'RETURN' ? canAssign : canEdit);
  const visibleTransitions = a.availableTransitions.filter(permittedFor);

  return (
    <div>
      <PageHeader
        title={a.tag}
        subtitle={
          <>
            <RecordCode code={a.recordCode} /> · {titleCase(a.kind)}
            {a.make || a.model ? ` · ${[a.make, a.model].filter(Boolean).join(' ')}` : ''}
          </>
        }
        actions={<StatusChip status={a.status} tone={STATUS_TONE[a.status]} />}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <dl className="grid gap-x-6 sm:grid-cols-2">
            <Field label="Serial">{a.serial ?? '—'}</Field>
            <Field label="Condition">{a.condition ? titleCase(a.condition) : '—'}</Field>
            <Field label="Purchase date">{a.purchaseDate ? date(a.purchaseDate) : '—'}</Field>
            <Field label="Purchase cost">{a.purchaseCost != null ? `₹${a.purchaseCost.toLocaleString('en-IN')}` : '—'}</Field>
            <Field label="Warranty end">{a.warrantyEnd ? date(a.warrantyEnd) : '—'}</Field>
            <Field label="Supplier">{a.supplierName ?? '—'}</Field>
            <Field label="Location">{a.location ?? '—'}</Field>
            <Field label="Division">{a.division ?? '—'}</Field>
            <Field label="Linked fixed asset">
              {a.fixedAsset ? (
                <>
                  <RecordCode code={a.fixedAsset.recordCode} /> — {a.fixedAsset.name}
                  {a.fixedAsset.disposedAt && <span className="ml-1 text-2xs text-ink-500">(disposed)</span>}
                </>
              ) : (
                'Not capitalised'
              )}
            </Field>
            <Field label="Book value">
              {a.bookValue != null ? `₹${a.bookValue.toLocaleString('en-IN')}` : '—'}
              <span className="ml-1 text-2xs text-ink-500">
                {a.fixedAsset ? '(from the books)' : a.bookValue != null ? '(purchase cost typed in)' : ''}
              </span>
            </Field>
            <Field label="Holder">{a.holderName ?? 'Nobody — in stock'}</Field>
          </dl>
          {a.notes && (
            <div className="mt-3 border-t border-ink-800 pt-3">
              <p className="text-2xs uppercase tracking-wide text-ink-500">Notes</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-200">{a.notes}</p>
            </div>
          )}
        </Card>

        <Card title="Actions">
          {a.availableTransitions.length === 0 ? (
            <p className="text-2xs text-ink-500">Nothing further — this is where it ends.</p>
          ) : visibleTransitions.length === 0 ? (
            <p className="text-2xs italic text-ink-500">View only from here.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {visibleTransitions.map((event) => (
                <button
                  key={event}
                  className="btn-sm w-full"
                  disabled={transition.isPending}
                  onClick={() => {
                    if (event === 'ASSIGN') setAssigning(true);
                    else if (event === 'RETURN') setReturning(true);
                    else setPendingTransition(event);
                  }}
                >
                  {EVENT_LABEL[event]}
                </button>
              ))}
            </div>
          )}
          {canEdit && (
            <button className="btn-ghost btn-sm mt-3 w-full" onClick={() => setNoting(true)}>
              Add an event / note
            </button>
          )}
        </Card>
      </div>

      <Card title="Timeline" className="mt-4">
        {timeline.length === 0 ? (
          <EmptyState message="Nothing recorded yet." />
        ) : (
          <ul className="flex flex-col gap-3">
            {timeline.map((row) => (
              <li key={row.id} className="flex gap-3 border-b border-ink-850/60 pb-3 last:border-0 last:pb-0">
                <div className="w-24 shrink-0 text-2xs text-ink-500" title={dateTime(row.at)}>
                  {relative(row.at)}
                </div>
                <div>
                  <p className="text-xs font-medium text-ink-100">{row.label}</p>
                  <p className="text-xs text-ink-300">{row.body}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {assigning && (
        <AssignModal
          assetId={a.id}
          onClose={() => setAssigning(false)}
          onDone={() => {
            invalidate();
            setAssigning(false);
          }}
        />
      )}
      {returning && (
        <ReturnModal
          assetId={a.id}
          onClose={() => setReturning(false)}
          onDone={() => {
            invalidate();
            setReturning(false);
          }}
        />
      )}
      {noting && (
        <NoteModal
          assetId={a.id}
          onClose={() => setNoting(false)}
          onDone={() => {
            invalidate();
            setNoting(false);
          }}
        />
      )}
      {pendingTransition && (
        <Modal
          open
          title={EVENT_LABEL[pendingTransition]}
          onClose={() => setPendingTransition(null)}
          footer={
            <>
              <button className="btn" onClick={() => setPendingTransition(null)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={transition.isPending}
                onClick={() => {
                  const event = pendingTransition;
                  transition.mutate(event, { onSuccess: () => setPendingTransition(null) });
                }}
              >
                {transition.isPending ? 'Recording…' : EVENT_LABEL[pendingTransition]}
              </button>
            </>
          }
        >
          <p className="text-sm text-ink-300">
            {a.tag} moves from {titleCase(a.status)} to a new state. This is recorded on the asset's timeline.
          </p>
          {transition.isError && <p className="mt-2 text-sm text-band-critical">{messageOf(transition.error)}</p>}
        </Modal>
      )}
    </div>
  );
}

interface PersonOption {
  id: string;
  fullName: string;
  recordCode: string;
  primaryEmail?: string | null;
}

function AssignModal({ assetId, onClose, onDone }: { assetId: string; onClose: () => void; onDone: () => void }) {
  const [search, setSearch] = useState('');
  const [partyId, setPartyId] = useState('');
  const [conditionOut, setConditionOut] = useState<(typeof CONDITIONS)[number] | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The same small "search a person" pattern `components/createForms.tsx`
  // uses against `/crm/people` — copied inline here rather than editing that
  // file, which belongs to another surface.
  const people = useList<PersonOption>('it-assign-people', `/crm/people?pageSize=200${search ? `&search=${encodeURIComponent(search)}` : ''}`);

  const mutation = useMutation({
    mutationFn: () => api.post(`/it/assets/${assetId}/assign`, { partyId, conditionOut: conditionOut || undefined, note: note || undefined }),
    onSuccess: onDone,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="Assign this asset"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!partyId || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'Assigning…' : 'Assign'}
          </button>
        </>
      }
    >
      {error && (
        <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>
      )}
      <TextInput label="Find a person" value={search} onChange={setSearch} placeholder="Search by name" />
      <div className="mt-2 max-h-40 overflow-y-auto rounded border border-ink-800">
        {people.rows.length === 0 ? (
          <p className="p-2 text-2xs text-ink-500">{people.isLoading ? 'Searching…' : 'No match.'}</p>
        ) : (
          people.rows.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`block w-full px-2 py-1.5 text-left text-xs hover:bg-ink-850 ${partyId === p.id ? 'bg-ink-850 text-accent' : 'text-ink-200'}`}
              onClick={() => setPartyId(p.id)}
            >
              {p.fullName}
            </button>
          ))
        )}
      </div>
      <div className="mt-3">
        <SelectInput
          label="Condition going out"
          value={conditionOut}
          onChange={setConditionOut}
          placeholder="Not recorded"
          options={CONDITIONS.map((c) => ({ value: c, label: titleCase(c) }))}
        />
      </div>
      <TextArea label="Note" value={note} onChange={setNote} rows={2} />
    </Modal>
  );
}

function ReturnModal({ assetId, onClose, onDone }: { assetId: string; onClose: () => void; onDone: () => void }) {
  const [conditionIn, setConditionIn] = useState<(typeof CONDITIONS)[number] | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/it/assets/${assetId}/return`, { conditionIn: conditionIn || undefined, note: note || undefined }),
    onSuccess: onDone,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="Return this asset"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'Recording…' : 'Return to stock'}
          </button>
        </>
      }
    >
      {error && (
        <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>
      )}
      <SelectInput
        label="Condition coming back"
        value={conditionIn}
        onChange={setConditionIn}
        placeholder="Not recorded"
        options={CONDITIONS.map((c) => ({ value: c, label: titleCase(c) }))}
      />
      <TextArea label="Note" value={note} onChange={setNote} rows={2} />
    </Modal>
  );
}

function NoteModal({ assetId, onClose, onDone }: { assetId: string; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'repair' | 'audit' | 'note'>('note');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/it/assets/${assetId}/events`, { kind, detail }),
    onSuccess: onDone,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="Add an event"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!detail.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'Saving…' : 'Record'}
          </button>
        </>
      }
    >
      {error && (
        <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>
      )}
      <SelectInput
        label="Kind"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'note', label: 'Note' },
          { value: 'repair', label: 'Repair' },
          { value: 'audit', label: 'Audit sighting' },
        ]}
      />
      <TextArea label="Detail" value={detail} onChange={setDetail} rows={3} required />
    </Modal>
  );
}
