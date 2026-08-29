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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvoiceView, PaymentView, ReceivablesSummary } from '@kaizen/shared';
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
} from '../components/ui.js';

export function Invoices() {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => api.get<InvoiceView[]>('/finance/invoices'),
  });

  if (error) return <ErrorBox error={error} />;

  const outstanding = data.reduce((s, i) => s + (i.outstanding ?? 0), 0);
  const overdue = data.filter((i) => i.daysOverdue !== null).length;

  return (
    <div>
      <PageHeader
        title="Invoices"
        subtitle="What customers owe us. How and when each invoice counts as revenue is worked out from what was sold, so nobody in sales has to decide it deal by deal."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Invoices" value={data.length} drillTo="/finance/invoices" />
        <Metric label="Outstanding" value={money(outstanding)} tone={outstanding > 0 ? 'warn' : 'good'} drillTo="/finance/receivables" />
        <Metric label="Overdue" value={overdue} tone={overdue > 0 ? 'bad' : 'good'} sub="Each one is chased automatically, once at each stage" drillTo="/exceptions" />
      </div>

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card><EmptyState message="No invoices." /></Card>
      ) : (
        <div className="space-y-3">
          {data.map((inv) => (
            <Card
              key={inv.id}
              title={<RecordCode code={inv.recordCode} />}
              subtitle={
                <span>
                  {inv.accountName ?? '—'} · issued {date(inv.issuedDate)} · due {date(inv.dueDate)}
                </span>
              }
              actions={
                <>
                  {inv.daysOverdue !== null && (
                    <span className="chip border-band-critical/40 text-band-critical">{inv.daysOverdue}d overdue</span>
                  )}
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
                    <th>Revenue method</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="text-xs">
                        {l.description}
                        {l.offeringName && <p className="text-2xs text-ink-500">{l.offeringName}</p>}
                      </td>
                      <td className="text-2xs text-ink-400">{titleCase(l.revenueMethod)}</td>
                      <td className="text-right tabular-nums text-xs">{moneyExact(l.amount, inv.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-3 flex flex-wrap justify-end gap-6 border-t border-ink-800 pt-3 text-xs">
                <span className="text-ink-400">
                  Total <span className="ml-1 tabular-nums text-ink-200">{moneyExact(inv.total, inv.currency)}</span>
                </span>
                <span className="text-ink-400">
                  Allocated <span className="ml-1 tabular-nums text-ink-200">{moneyExact(inv.allocated, inv.currency)}</span>
                </span>
                <span className={inv.outstanding && inv.outstanding > 0 ? 'font-medium text-band-watch' : 'font-medium text-band-strong'}>
                  Outstanding <span className="ml-1 tabular-nums">{moneyExact(inv.outstanding, inv.currency)}</span>
                </span>
              </div>
              <p className="mt-2 text-2xs text-ink-600">
                Only the sum of allocated receipts determines what has actually been paid against this obligation.
              </p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function Payments() {
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
        subtitle="Money actually received. Nothing here is ever edited or deleted — a mistake is corrected by adding a reversing entry, so the history always shows what really happened."
      />

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
        <p className="rounded border border-ink-800 bg-ink-950 px-3 py-2 text-2xs text-ink-500">
          A receipt is the allocation join. Partial payment across several obligations is representable because the
          join is many-to-many rather than a status on one row.
        </p>
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
        subtitle="A disposable, event-hydrated projection. CRM holds no authoritative money state — this is safe to rebuild, discard or re-hydrate at any time."
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
                <th>Hydrated</th>
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
                  <td className="text-2xs text-ink-500">{relative(r.hydratedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
