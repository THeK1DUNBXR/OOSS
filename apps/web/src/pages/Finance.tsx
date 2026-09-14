/**
 * Finance.
 *
 * Three distinct facts the legacy single collection conflated, shown as three
 * distinct surfaces: the obligation (invoice), the movement (payment,
 * append-only), and the allocation (receipt, the many-to-many join that finally
 * makes partial payment representable).
 *
 * Regulated fields — bank account and tax registration references — are
 * structurally excluded from these projections entirely, never merely nulled.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PAYMENT_MODE_LABELS,
  PAYMENT_TYPE_LABELS,
  type InvoiceView,
  type PaymentMode,
  type PaymentType,
  type PaymentView,
  type ReceivablesSummary,
} from '@kaizen/shared';
import { api, date, money, moneyExact, relative, titleCase } from '../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Loading,
  Metric,
  Modal,
  PageHeader,
  RecordCode,
  StatusChip,
  Tabs,
} from '../components/ui.js';
import { NewButton, messageOf } from '../components/forms.js';
import { NewPayment } from '../components/createForms.js';
import { CollectPayment, InvoiceEditor } from '../components/invoiceEditor.js';

export function Invoices() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'open' | 'drafts' | 'all'>('open');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<InvoiceView | null>(null);
  const [collecting, setCollecting] = useState<InvoiceView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => api.get<InvoiceView[]>('/finance/invoices'),
  });

  const issue = useMutation({
    mutationFn: (id: string) => api.post(`/finance/invoices/${id}/issue`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
    onError: (e) => setActionError(messageOf(e)),
  });

  if (error) return <ErrorBox error={error} />;

  const outstanding = data.reduce((s, i) => s + (i.outstanding ?? 0), 0);
  const overdue = data.filter((i) => i.daysOverdue !== null).length;
  const drafts = data.filter((i) => i.status === 'draft');
  const open = data.filter((i) => (i.outstanding ?? 0) > 0 && i.status !== 'draft' && i.status !== 'void');
  const shown = tab === 'drafts' ? drafts : tab === 'open' ? open : data;

  return (
    <div>
      <PageHeader
        title="Invoices"
        subtitle="What customers owe us."
        actions={<NewButton label="Raise an invoice" onClick={() => setCreating(true)} />}
      />
      <InvoiceEditor open={creating} onClose={() => setCreating(false)} />
      <InvoiceEditor open={Boolean(editing)} invoice={editing} onClose={() => setEditing(null)} />
      {collecting && <CollectPayment invoice={collecting} onClose={() => setCollecting(null)} />}

      {actionError && (
        <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
          {actionError}
        </p>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <Metric label="Invoices" value={data.length} drillTo="/finance/invoices" />
        <Metric label="Drafts" value={drafts.length} sub="The only state whose lines can still be changed" />
        <Metric
          label="Outstanding"
          value={money(outstanding)}
          tone={outstanding > 0 ? 'warn' : 'good'}
          drillTo="/finance/receivables"
        />
        <Metric
          label="Overdue"
          value={overdue}
          tone={overdue > 0 ? 'bad' : 'good'}
          sub="Each one is chased automatically, once at each stage"
          drillTo="/exceptions"
        />
      </div>

      <Tabs
        tabs={[
          { key: 'open', label: 'Owed to us', count: open.length },
          { key: 'drafts', label: 'Drafts', count: drafts.length },
          { key: 'all', label: 'Everything', count: data.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {isLoading ? (
        <Loading />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            message={tab === 'drafts' ? 'No drafts.' : tab === 'open' ? 'Nothing is outstanding.' : 'No invoices.'}
            hint="Bill a student, an institution or an organisation."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((inv) => (
            <Card
              key={inv.id}
              title={
                <span className="flex items-baseline gap-2">
                  <RecordCode code={inv.label} />
                  {!inv.recordCode && (
                    <span
                      className="chip border-ink-700 text-ink-500"
                      title="A draft has no number. Numbers are given out when an invoice is issued, so the series stays consecutive."
                    >
                      no number yet
                    </span>
                  )}
                </span>
              }
              subtitle={
                <span>
                  {inv.customerName ?? '—'}
                  {inv.customerGstin ? <span className="mono text-ink-500"> · {inv.customerGstin}</span> : null}
                  {' · '}
                  {inv.issuedDate ? `issued ${date(inv.issuedDate)}` : 'not issued'} · due {date(inv.dueDate)}
                </span>
              }
              actions={
                <>
                  {inv.daysOverdue !== null && (
                    <span className="chip border-band-critical/40 text-band-critical">{inv.daysOverdue}d overdue</span>
                  )}
                  {/* What the document says, which is a different fact from the
                      status: the status follows the receipts, this is what the
                      customer was told. */}
                  <span
                    className={`chip ${
                      inv.paymentType === 'part'
                        ? 'border-band-watch/40 text-band-watch'
                        : inv.paymentType === 'full'
                          ? 'border-band-strong/40 text-band-strong'
                          : 'border-ink-700 text-ink-400'
                    }`}
                  >
                    {PAYMENT_TYPE_LABELS[inv.paymentType as PaymentType] ?? inv.paymentType}
                  </span>
                  <StatusChip
                    status={inv.status}
                    tone={inv.status === 'settled' ? 'good' : inv.status === 'overdue' ? 'bad' : 'neutral'}
                  />
                </>
              }
            >
              <table className="table">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>HSN/SAC</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Rate</th>
                    <th className="text-right">GST</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="text-xs">
                        {l.description}
                        {(l.courseName || l.offeringName) && (
                          <p className="text-2xs text-ink-500">{l.courseName ?? l.offeringName}</p>
                        )}
                      </td>
                      <td className="mono text-2xs text-ink-500">{l.hsnSac ?? '—'}</td>
                      <td className="text-right tabular-nums text-2xs text-ink-400">{l.quantity}</td>
                      <td className="text-right tabular-nums text-2xs text-ink-400">{moneyExact(l.unitPrice, inv.currency)}</td>
                      <td className="text-right tabular-nums text-2xs text-ink-400">{l.gstRate ?? 0}%</td>
                      <td className="text-right tabular-nums text-xs">{moneyExact(l.amount, inv.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-3 flex flex-wrap justify-end gap-5 border-t border-ink-800 pt-3 text-xs">
                <span className="text-ink-400">
                  Taxable <span className="ml-1 tabular-nums text-ink-200">{moneyExact(inv.taxableValue, inv.currency)}</span>
                </span>
                <span className="text-ink-400">
                  {inv.interState ? 'IGST' : 'CGST + SGST'}{' '}
                  <span className="ml-1 tabular-nums text-ink-200">{moneyExact(inv.taxAmount, inv.currency)}</span>
                </span>
                {/* The two figures, on the list as well as on the document. */}
                <span className="font-medium text-ink-100">
                  Total payable <span className="ml-1 tabular-nums">{moneyExact(inv.total, inv.currency)}</span>
                </span>
                {inv.paymentType !== 'credit' && (
                  <span className="text-accent-soft">
                    Paid at issue <span className="ml-1 tabular-nums">{moneyExact(inv.amountPayableNow, inv.currency)}</span>
                    {inv.paymentMode && (
                      <span className="ml-1 text-ink-500">
                        by {PAYMENT_MODE_LABELS[inv.paymentMode as PaymentMode] ?? inv.paymentMode}
                      </span>
                    )}
                  </span>
                )}
                <span className={(inv.outstanding ?? 0) > 0 ? 'font-medium text-band-watch' : 'font-medium text-band-strong'}>
                  Outstanding <span className="ml-1 tabular-nums">{moneyExact(inv.outstanding, inv.currency)}</span>
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-800 pt-3">
                <Link className="btn" to={`/finance/invoices/${inv.id}/document`}>
                  Open the document
                </Link>
                {inv.editable && (
                  <>
                    <button className="btn" onClick={() => setEditing(inv)}>
                      Correct it
                    </button>
                    <button className="btn-primary" onClick={() => issue.mutate(inv.id)} disabled={issue.isPending}>
                      Issue it
                    </button>
                  </>
                )}
                {!inv.editable && (inv.outstanding ?? 0) > 0 && inv.status !== 'void' && (
                  <button className="btn-primary" onClick={() => setCollecting(inv)}>
                    Receipt an instalment
                  </button>
                )}
                {inv.gstFilingId && (
                  <span className="chip border-ink-700 text-ink-500" title="Reported in a filed GSTR-1. The period is closed and this invoice can no longer be changed.">
                    reported
                  </span>
                )}
              </div>

              <p className="mt-2 text-2xs text-ink-600">
                {inv.editable
                  ? 'A draft. Lines and tax can still be changed. Once issued, corrections need a credit note.'
                  : 'Final. Payments made since are recorded as receipts, not changes to this invoice.'}
              </p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function Payments() {
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const [allocating, setAllocating] = useState<PaymentView | null>(null);

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['payments'],
    queryFn: () => api.get<PaymentView[]>('/finance/payments'),
  });

  if (error) return <ErrorBox error={error} />;

  const unallocated = data.reduce((s, p) => s + Math.max(p.unallocated ?? 0, 0), 0);

  return (
    <div>
      <PageHeader
        title="Payments"
        subtitle="Money received. Corrections are added, never written over."
        actions={<NewButton label="Record a payment" onClick={() => setCreating(true)} />}
      />
      <NewPayment open={creating} onClose={() => setCreating(false)} />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Payments" value={data.length} drillTo="/finance/payments" />
        <Metric
          label="Unallocated"
          value={money(unallocated)}
          tone={unallocated > 0 ? 'warn' : 'good'}
          sub="A payment may legitimately exist before its obligation is issued"
          drillTo="/finance/payments"
        />
        <Metric label="Receipts" value={data.reduce((s, p) => s + p.receipts.length, 0)} sub="The allocation join" drillTo="/finance/payments" />
      </div>

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card><EmptyState message="No payments received yet." /></Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Gateway reference</th>
                <th>Received</th>
                <th className="text-right">Amount</th>
                <th className="text-right">Allocated</th>
                <th className="text-right">Unallocated</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td><RecordCode code={p.recordCode} /></td>
                  <td className="mono">{p.gatewayReference}</td>
                  <td className="text-2xs text-ink-400">{relative(p.receivedAt)}</td>
                  <td className="text-right tabular-nums text-xs">{moneyExact(p.amount, p.currency)}</td>
                  <td className="text-right tabular-nums text-xs text-ink-400">{moneyExact(p.allocated, p.currency)}</td>
                  <td className={`text-right tabular-nums text-xs ${(p.unallocated ?? 0) > 0 ? 'text-band-watch' : 'text-ink-500'}`}>
                    {moneyExact(p.unallocated, p.currency)}
                  </td>
                  <td><StatusChip status={p.status} tone={p.status === 'received' ? 'good' : 'neutral'} /></td>
                  <td>
                    {(p.unallocated ?? 0) > 0 && (
                      <button className="btn-ghost" onClick={() => setAllocating(p)}>Allocate</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <AllocateModal payment={allocating} onClose={() => setAllocating(null)} />
    </div>
  );
}

function AllocateModal({ payment, onClose }: { payment: PaymentView | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: invoices = [] } = useQuery({
    queryKey: ['invoices', 'open'],
    queryFn: () => api.get<InvoiceView[]>('/finance/invoices'),
    enabled: Boolean(payment),
  });

  const allocate = useMutation({
    mutationFn: () => api.post(`/finance/payments/${payment!.id}/allocate`, { invoiceId, amount: Number(amount) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
      onClose();
      setAmount('');
      setInvoiceId('');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Allocation failed'),
  });

  if (!payment) return null;
  const open = invoices.filter((i) => (i.outstanding ?? 0) > 0);

  return (
    <Modal
      open
      title={`Allocate ${payment.recordCode}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => allocate.mutate()} disabled={!invoiceId || !amount || allocate.isPending}>
            Create receipt
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-2xs text-ink-400">
          Unallocated: <span className="tabular-nums text-ink-100">{moneyExact(payment.unallocated, payment.currency)}</span>
        </p>
        <div>
          <label className="label">Against invoice</label>
          <select className="input" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
            <option value="">Select…</option>
            {open.map((i) => (
              <option key={i.id} value={i.id}>
                {i.recordCode} — {i.accountName} — {moneyExact(i.outstanding, i.currency)} outstanding
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Amount</label>
          <input className="input" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        {error && <p className="text-2xs text-band-critical">{error}</p>}
      </div>
    </Modal>
  );
}

export function Receivables() {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['receivables'],
    queryFn: () => api.get<ReceivablesSummary[]>('/finance/receivables'),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Receivables"
        subtitle="What is owed, and how late it is."
      />

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card><EmptyState message="Nothing is outstanding — everything billed has been paid." /></Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th className="text-right">Outstanding</th>
                <th>Next due</th>
                <th>Dunning stage</th>
                <th>As of</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={`${r.subjectType}:${r.subjectId}`}>
                  <td className="text-xs text-ink-100">{r.subjectLabel}</td>
                  <td className="text-right tabular-nums text-xs">{moneyExact(r.amountOutstanding, r.currency)}</td>
                  <td className="text-2xs text-ink-400">{date(r.nextDueDate)}</td>
                  <td>
                    {r.dunningStage ? (
                      <StatusChip
                        status={r.dunningStage}
                        tone={r.dunningStage === 'escalated' ? 'bad' : r.dunningStage === 'chase' ? 'warn' : 'neutral'}
                      />
                    ) : (
                      <span className="text-2xs text-ink-600">current</span>
                    )}
                  </td>
                  <td className="text-2xs text-ink-500" title="When this row was last recomputed from the invoices and payments behind it">
                    {relative(r.hydratedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
