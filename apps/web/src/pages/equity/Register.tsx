/**
 * The register — the ledger of every allotment and transfer, proposed,
 * approved, made effective or reversed.
 *
 * Authority is separated structurally (PRODUCT.md): a proposer never sees an
 * approve control on their own row, whether or not the server would refuse
 * it — the UI mirrors the separation the gate already enforces.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SHARE_TRANSACTION_TYPE_LABELS,
  type HolderView,
  type ShareClassView,
  type ShareTransactionStatus,
  type ShareTransactionView,
} from '@kaizen/shared';
import { api, date, money } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, MoneyInput, NewButton, Row, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';

const today = () => new Date().toISOString().slice(0, 10);

function useHolders() {
  return useQuery({
    queryKey: ['equity-holders', 'picker'],
    queryFn: () => api.get<{ items: HolderView[] }>('/equity/holders'),
  });
}

function useShareClasses() {
  return useQuery({
    queryKey: ['equity-share-classes', 'picker'],
    queryFn: () => api.get<{ items: ShareClassView[] }>('/equity/share-classes'),
  });
}

/** Equity-kind transactions from the books, offered as the consideration for
 *  an allotment or a transfer — the rule that keeps the register from ever
 *  holding money movement of its own (equity-portal plan §3.6). */
function useEquityConsiderations() {
  return useQuery({
    queryKey: ['books-transactions', 'equity-consideration'],
    queryFn: () =>
      api.get<Array<{ id: string; recordCode: string; categoryKind: string | null; amount: number | null; txnDate: string; counterparty: string | null }>>(
        '/books/transactions?take=200',
      ),
    select: (rows) => rows.filter((t) => t.categoryKind === 'equity'),
  });
}

function ConsiderationPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { data: rows = [] } = useEquityConsiderations();
  return (
    <SelectInput
      label="Consideration"
      hint="a Transaction posted to an 'equity' ledger category"
      value={value}
      onChange={onChange}
      placeholder={rows.length ? 'Not linked yet' : 'No equity-kind transaction recorded yet — link it later'}
      options={rows.map((t) => ({
        value: t.id,
        label: `${t.recordCode} · ${money(t.amount)} · ${date(t.txnDate)}${t.counterparty ? ` · ${t.counterparty}` : ''}`,
      }))}
    />
  );
}

function NewAllotment({ open, onClose }: { open: boolean; onClose: () => void }) {
  const holders = useHolders();
  const classes = useShareClasses();
  const [shareClassId, setShareClassId] = useState('');
  const [toHolderId, setToHolderId] = useState('');
  const [count, setCount] = useState('');
  const [pricePerShare, setPrice] = useState('');
  const [effectiveOn, setEffectiveOn] = useState(today());
  const [considerationTransactionId, setConsideration] = useState('');
  const [boardResolutionRef, setResolution] = useState('');

  return (
    <CreateModal
      open={open}
      title="New allotment"
      submitLabel="Propose it"
      onClose={onClose}
      invalidate={[['equity-ledger']]}
      onSubmit={() =>
        api.post('/equity/ledger/allotments', {
          shareClassId,
          toHolderId,
          count: Number(count),
          pricePerShare: pricePerShare ? Number(pricePerShare) : null,
          effectiveOn,
          considerationTransactionId: considerationTransactionId || null,
          boardResolutionRef: boardResolutionRef || null,
        })
      }
    >
      <Row>
        <SelectInput
          label="Class"
          required
          value={shareClassId}
          onChange={setShareClassId}
          placeholder="Choose a class"
          options={(classes.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
        />
        <SelectInput
          label="Holder"
          required
          value={toHolderId}
          onChange={setToHolderId}
          placeholder="Who is allotted these shares"
          options={(holders.data?.items ?? []).map((h) => ({ value: h.id, label: `${h.displayName} (${h.folioNumber})` }))}
        />
      </Row>
      <Row>
        <TextInput label="Count" type="number" required value={count} onChange={setCount} />
        <MoneyInput label="Price per share" value={pricePerShare} onChange={setPrice} />
      </Row>
      <Row>
        <TextInput label="Effective on" type="date" required value={effectiveOn} onChange={setEffectiveOn} />
        <TextInput label="Board resolution ref." value={boardResolutionRef} onChange={setResolution} />
      </Row>
      <ConsiderationPicker value={considerationTransactionId} onChange={setConsideration} />
      <p className="text-2xs text-ink-500">
        A priced allotment left unlinked to a consideration shows as awaiting consideration on the cap table until
        one is attached.
      </p>
    </CreateModal>
  );
}

function NewTransfer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const holders = useHolders();
  const classes = useShareClasses();
  const [shareClassId, setShareClassId] = useState('');
  const [fromHolderId, setFromHolderId] = useState('');
  const [toHolderId, setToHolderId] = useState('');
  const [count, setCount] = useState('');
  const [pricePerShare, setPrice] = useState('');
  const [effectiveOn, setEffectiveOn] = useState(today());
  const [considerationTransactionId, setConsideration] = useState('');

  return (
    <CreateModal
      open={open}
      title="New transfer"
      submitLabel="Propose it"
      onClose={onClose}
      invalidate={[['equity-ledger']]}
      onSubmit={() =>
        api.post('/equity/ledger/transfers', {
          shareClassId,
          fromHolderId,
          toHolderId,
          count: Number(count),
          pricePerShare: pricePerShare ? Number(pricePerShare) : null,
          effectiveOn,
          considerationTransactionId: considerationTransactionId || null,
        })
      }
    >
      <SelectInput
        label="Class"
        required
        value={shareClassId}
        onChange={setShareClassId}
        placeholder="Choose a class"
        options={(classes.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
      />
      <Row>
        <SelectInput
          label="From"
          required
          value={fromHolderId}
          onChange={setFromHolderId}
          placeholder="Transferor"
          options={(holders.data?.items ?? []).map((h) => ({ value: h.id, label: `${h.displayName} (${h.folioNumber})` }))}
        />
        <SelectInput
          label="To"
          required
          value={toHolderId}
          onChange={setToHolderId}
          placeholder="Transferee"
          options={(holders.data?.items ?? []).map((h) => ({ value: h.id, label: `${h.displayName} (${h.folioNumber})` }))}
        />
      </Row>
      <Row>
        <TextInput label="Count" type="number" required value={count} onChange={setCount} />
        <MoneyInput label="Price per share" value={pricePerShare} onChange={setPrice} />
      </Row>
      <TextInput label="Effective on" type="date" required value={effectiveOn} onChange={setEffectiveOn} />
      <ConsiderationPicker value={considerationTransactionId} onChange={setConsideration} />
    </CreateModal>
  );
}

/** The reason a reject or a reverse asks for — the server refuses without one. */
function ReasonModal({
  open,
  title,
  submitLabel,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  return (
    <CreateModal
      open={open}
      title={title}
      submitLabel={submitLabel}
      onClose={onClose}
      invalidate={[['equity-ledger']]}
      onSubmit={() => onSubmit(reason)}
    >
      <TextArea label="Reason" required value={reason} onChange={setReason} rows={3} />
    </CreateModal>
  );
}

const STATUS_TONE: Record<ShareTransactionStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  proposed: 'accent',
  approved: 'neutral',
  effective: 'good',
  reversed: 'bad',
  rejected: 'bad',
};

export function Register() {
  const { can, user } = useSession();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<ShareTransactionStatus | 'all'>('all');
  const [creatingAllotment, setCreatingAllotment] = useState(false);
  const [creatingTransfer, setCreatingTransfer] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reversing, setReversing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['equity-ledger'],
    queryFn: () => api.get<{ items: ShareTransactionView[] }>('/equity/ledger'),
  });
  const holders = useHolders();
  const classes = useShareClasses();

  const act = useMutation({
    mutationFn: (input: { id: string; path: string }) => api.post(`/equity/ledger/${input.id}/${input.path}`),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['equity-ledger'] });
      qc.invalidateQueries({ queryKey: ['equity-cap-table'] });
    },
    onError: (e) => setError(messageOf(e)),
  });

  if (loadError) return <ErrorBox error={loadError} />;

  const holderName = (id: string | null) => (id ? holders.data?.items.find((h) => h.id === id)?.displayName ?? id : '—');
  const className = (id: string) => classes.data?.items.find((c) => c.id === id)?.name ?? id;

  const rows = (data?.items ?? []).filter((t) => statusFilter === 'all' || t.status === statusFilter);
  const counts = (data?.items ?? []).reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <NewAllotment open={creatingAllotment} onClose={() => setCreatingAllotment(false)} />
      <NewTransfer open={creatingTransfer} onClose={() => setCreatingTransfer(false)} />
      {rejecting && (
        <ReasonModal
          open
          title="Reject this transaction"
          submitLabel="Reject it"
          onClose={() => setRejecting(null)}
          onSubmit={async (reason) => {
            await api.post(`/equity/ledger/${rejecting}/reject`, { reason });
            setRejecting(null);
          }}
        />
      )}
      {reversing && (
        <ReasonModal
          open
          title="Reverse this transaction"
          submitLabel="Reverse it"
          onClose={() => setReversing(null)}
          onSubmit={async (reason) => {
            await api.post(`/equity/ledger/${reversing}/reverse`, { reason });
            setReversing(null);
          }}
        />
      )}

      <PageHeader
        title="Share register"
        subtitle="Every allotment and transfer, proposed through to effective."
        actions={
          <>
            {can('share_ledger:C') && <NewButton label="New allotment" onClick={() => setCreatingAllotment(true)} />}
            {can('share_ledger:C') && <NewButton label="New transfer" onClick={() => setCreatingTransfer(true)} />}
          </>
        }
      />

      {error && (
        <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
          {error}
        </p>
      )}

      <Tabs
        tabs={[
          { key: 'all', label: 'All', count: data?.items.length ?? 0 },
          { key: 'proposed', label: 'Proposed', count: counts.proposed ?? 0 },
          { key: 'approved', label: 'Approved', count: counts.approved ?? 0 },
          { key: 'effective', label: 'Effective', count: counts.effective ?? 0 },
          { key: 'reversed', label: 'Reversed', count: counts.reversed ?? 0 },
          { key: 'rejected', label: 'Rejected', count: counts.rejected ?? 0 },
        ]}
        active={statusFilter}
        onChange={setStatusFilter}
      />

      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            message="Nothing in the register yet."
            hint="Propose an allotment to bring the first holder onto the cap table."
          />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Class</th>
                  <th>From → to</th>
                  <th className="text-right">Count</th>
                  <th className="text-right">Price</th>
                  <th>Effective on</th>
                  <th>Range</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const isOwnProposal = user && t.proposedByPartyId === user.personId;
                  return (
                    <tr key={t.id}>
                      <td className="mono text-2xs">
                        {t.recordCode}
                        <div className="text-xs text-ink-100">{SHARE_TRANSACTION_TYPE_LABELS[t.type]}</div>
                      </td>
                      <td className="text-ink-300">{className(t.shareClassId)}</td>
                      <td className="text-2xs text-ink-400">
                        {holderName(t.fromHolderId)} → {holderName(t.toHolderId)}
                      </td>
                      <td className="text-right tabular-nums">{t.count.toLocaleString('en-IN')}</td>
                      <td className="text-right tabular-nums">{money(t.pricePerShare)}</td>
                      <td className="text-2xs text-ink-400">{date(t.effectiveOn)}</td>
                      <td className="mono text-2xs text-ink-500">
                        {t.distinctiveFrom && t.distinctiveTo ? `${t.distinctiveFrom}–${t.distinctiveTo}` : '—'}
                      </td>
                      <td>
                        <StatusChip status={t.status} tone={STATUS_TONE[t.status]} />
                        {isOwnProposal && t.status === 'proposed' && (
                          <p className="mt-1 text-2xs italic text-ink-500">
                            You proposed this; another approver must act.
                          </p>
                        )}
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-1">
                          {t.status === 'proposed' && !isOwnProposal && can('share_ledger:approve') && (
                            <>
                              <button
                                className="btn-ghost"
                                onClick={() => act.mutate({ id: t.id, path: 'approve' })}
                                disabled={act.isPending}
                              >
                                Approve
                              </button>
                              <button className="btn-ghost" onClick={() => setRejecting(t.id)}>
                                Reject
                              </button>
                            </>
                          )}
                          {t.status === 'approved' && can('share_ledger:approve') && (
                            <button
                              className="btn-primary btn-sm"
                              onClick={() => act.mutate({ id: t.id, path: 'effective' })}
                              disabled={act.isPending}
                            >
                              Make effective
                            </button>
                          )}
                          {t.status === 'effective' && can('share_ledger:C') && can('share_ledger:approve') && (
                            <button className="btn-ghost" onClick={() => setReversing(t.id)}>
                              Reverse
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
