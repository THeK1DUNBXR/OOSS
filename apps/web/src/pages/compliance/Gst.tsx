/**
 * GST completion (docs/plan/compliance.md, workstream B).
 *
 * The GSTR-1/3B screen (`GstReturns.tsx`) prepares and files returns; this is
 * where the facts feeding them are entered — a line's supply classification,
 * a vendor bill's reverse charge, debit notes, an issued invoice's e-invoice
 * status, and the GSTR-2B reconciliation. Six tabs, one per fact.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NOTE_REASON_CODES, NOTE_REASON_LABELS, type NoteReasonCode } from '@kaizen/shared';
import { api, money, date } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, Metric, PageHeader, RecordCode, StatusChip, Tabs } from '../../components/ui.js';
import { MoneyInput, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';

type Tab = 'classification' | 'rcm' | 'notes' | 'einvoice' | 'gstr2b' | 'exposure';

function thisMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function ComplianceGst() {
  const [tab, setTab] = useState<Tab>('classification');
  return (
    <>
      <PageHeader
        title="GST"
        subtitle="Supply classification, reverse charge, notes, e-invoicing, and GSTR-2B — what feeds GSTR-1/3B. This platform prepares filings; it does not transmit them."
      />
      <Tabs
        tabs={[
          { key: 'classification', label: 'Classification' },
          { key: 'rcm', label: 'Reverse charge' },
          { key: 'notes', label: 'Notes' },
          { key: 'einvoice', label: 'E-invoicing' },
          { key: 'gstr2b', label: 'GSTR-2B' },
          { key: 'exposure', label: 'Exposure' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'classification' && <ClassificationTab />}
      {tab === 'rcm' && <RcmTab />}
      {tab === 'notes' && <NotesTab />}
      {tab === 'einvoice' && <EInvoiceTab />}
      {tab === 'gstr2b' && <Gstr2bTab />}
      {tab === 'exposure' && <ExposureTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function ClassificationTab() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const lines = useQuery({
    queryKey: ['gst-unclassified'],
    queryFn: () => api.get<any[]>('/compliance/gst/classification/unclassified'),
  });

  const classify = useMutation({
    mutationFn: (input: { invoiceId: string; lineId: string; supplyType: string; exemptionNotification?: string | null }) =>
      api.patch(`/compliance/gst/invoices/${input.invoiceId}/lines/${input.lineId}/classify`, {
        supplyType: input.supplyType,
        exemptionNotification: input.exemptionNotification,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gst-unclassified'] }),
    onError: (e) => setError(messageOf(e)),
  });

  if (lines.isLoading) return <Loading />;
  if (lines.error) return <ErrorBox error={lines.error} />;

  return (
    <Card>
      {error && <ErrorBox error={error} />}
      <p className="mb-3 text-xs text-ink-400">
        Draft lines billing a course flagged exempt, still marked taxable — added before the exemption was set, or
        entered by hand. Setting a supply type here is what keeps the line off GSTR-1/3B's taxable turnover.
      </p>
      {!lines.data?.length ? (
        <EmptyState message="Nothing needs classifying." />
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-2xs uppercase text-ink-500">
            <tr>
              <th className="pb-2">Invoice</th>
              <th className="pb-2">Line</th>
              <th className="pb-2">Amount</th>
              <th className="pb-2">Set to exempt</th>
            </tr>
          </thead>
          <tbody>
            {lines.data.map((l: any) => (
              <tr key={l.id} className="border-t border-ink-800">
                <td className="py-2">{l.invoice?.draftReference ?? l.invoiceId}</td>
                <td className="py-2">{l.description}</td>
                <td className="py-2 tabular-nums">{money(l.amount)}</td>
                <td className="py-2">
                  <button
                    className="btn-secondary"
                    onClick={() =>
                      classify.mutate({
                        invoiceId: l.invoiceId,
                        lineId: l.id,
                        supplyType: 'exempt',
                        exemptionNotification: '12/2017-CT(R) entry 66',
                      })
                    }
                  >
                    Mark exempt
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

// ---------------------------------------------------------------------------
// Reverse charge
// ---------------------------------------------------------------------------

function RcmTab() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [rateFor, setRateFor] = useState<Record<string, string>>({});

  const flagged = useQuery({
    queryKey: ['gst-rcm-flagged'],
    queryFn: () => api.get<any[]>('/compliance/gst/rcm/flagged-bills'),
  });
  const selfInvoices = useQuery({
    queryKey: ['gst-rcm-self'],
    queryFn: () => api.get<any[]>('/compliance/gst/rcm/self-invoices'),
  });

  const apply = useMutation({
    mutationFn: (input: { billId: string; ratePct: number }) =>
      api.post(`/compliance/gst/vendor-bills/${input.billId}/rcm`, { ratePct: input.ratePct }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gst-rcm-flagged'] });
      qc.invalidateQueries({ queryKey: ['gst-rcm-self'] });
    },
    onError: (e) => setError(messageOf(e)),
  });

  return (
    <div className="space-y-4">
      {error && <ErrorBox error={error} />}
      <Card>
        <h3 className="mb-2 text-sm font-medium text-ink-100">Vendor bills flagged reverse-charged</h3>
        {flagged.isLoading ? (
          <Loading />
        ) : !flagged.data?.length ? (
          <EmptyState message="No vendor bill has reverse charge applied yet." />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-2xs uppercase text-ink-500">
              <tr>
                <th className="pb-2">Vendor</th>
                <th className="pb-2">Bill</th>
                <th className="pb-2">Tax under RCM</th>
              </tr>
            </thead>
            <tbody>
              {flagged.data.map((b: any) => (
                <tr key={b.id} className="border-t border-ink-800">
                  <td className="py-2">{b.vendorName}</td>
                  <td className="py-2"><RecordCode code={b.recordCode} /></td>
                  <td className="py-2 tabular-nums">{money(b.rcmTaxAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <h3 className="mb-2 text-sm font-medium text-ink-100">Apply reverse charge to a bill</h3>
        <p className="mb-3 text-xs text-ink-400">
          Enter the bill id (from Books → Vendor bills) and the rate. Raises the self-invoice Sec 31(3)(f) requires.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <TextInput
            label="Vendor bill id"
            value={rateFor.billId ?? ''}
            onChange={(v) => setRateFor((s) => ({ ...s, billId: v }))}
          />
          <TextInput
            label="Rate %"
            type="number"
            value={rateFor.rate ?? ''}
            onChange={(v) => setRateFor((s) => ({ ...s, rate: v }))}
          />
          <button
            className="btn-primary"
            disabled={!rateFor.billId || !rateFor.rate}
            onClick={() => apply.mutate({ billId: rateFor.billId, ratePct: Number(rateFor.rate) })}
          >
            Apply RCM
          </button>
        </div>
      </Card>

      <Card>
        <h3 className="mb-2 text-sm font-medium text-ink-100">Self-invoices</h3>
        {!selfInvoices.data?.length ? (
          <EmptyState message="No self-invoice has been raised yet." />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-2xs uppercase text-ink-500">
              <tr>
                <th className="pb-2">Number</th>
                <th className="pb-2">Period</th>
                <th className="pb-2">Taxable value</th>
                <th className="pb-2">CGST</th>
                <th className="pb-2">SGST</th>
                <th className="pb-2">IGST</th>
              </tr>
            </thead>
            <tbody>
              {selfInvoices.data.map((r: any) => (
                <tr key={r.id} className="border-t border-ink-800">
                  <td className="py-2">{r.number}</td>
                  <td className="py-2">{r.period}</td>
                  <td className="py-2 tabular-nums">{money(r.taxableValue)}</td>
                  <td className="py-2 tabular-nums">{money(r.cgstAmount)}</td>
                  <td className="py-2 tabular-nums">{money(r.sgstAmount)}</td>
                  <td className="py-2 tabular-nums">{money(r.igstAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function NotesTab() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [reasonCode, setReasonCode] = useState<NoteReasonCode | ''>('');
  const [note, setNote] = useState('');

  const debitNotes = useQuery({ queryKey: ['gst-debit-notes'], queryFn: () => api.get<any[]>('/compliance/gst/debit-notes') });
  const creditNotes = useQuery({ queryKey: ['gst-credit-notes'], queryFn: () => api.get<any[]>('/compliance/gst/credit-notes') });

  const issue = useMutation({
    mutationFn: () =>
      api.post(`/compliance/gst/invoices/${invoiceId}/debit-note`, { amount: Number(amount), reasonCode, note: note || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gst-debit-notes'] });
      setOpen(false);
      setInvoiceId('');
      setAmount('');
      setReasonCode('');
      setNote('');
    },
    onError: (e) => setError(messageOf(e)),
  });

  return (
    <div className="space-y-4">
      {error && <ErrorBox error={error} />}
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink-100">Debit notes</h3>
          <button className="btn-primary" onClick={() => setOpen(true)}>
            Issue debit note
          </button>
        </div>
        {!debitNotes.data?.length ? (
          <EmptyState message="No debit note has been issued." />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-2xs uppercase text-ink-500">
              <tr>
                <th className="pb-2">Number</th>
                <th className="pb-2">Amount</th>
                <th className="pb-2">Reason</th>
                <th className="pb-2">Issued</th>
              </tr>
            </thead>
            <tbody>
              {debitNotes.data.map((n: any) => (
                <tr key={n.id} className="border-t border-ink-800">
                  <td className="py-2"><RecordCode code={n.recordCode} /></td>
                  <td className="py-2 tabular-nums">{money(n.amount)}</td>
                  <td className="py-2">{NOTE_REASON_LABELS[n.reasonCode as NoteReasonCode] ?? n.reasonCode}</td>
                  <td className="py-2">{date(n.issuedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <h3 className="mb-2 text-sm font-medium text-ink-100">Credit notes</h3>
        {!creditNotes.data?.length ? (
          <EmptyState message="No credit note has been issued." />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-2xs uppercase text-ink-500">
              <tr>
                <th className="pb-2">Number</th>
                <th className="pb-2">Amount</th>
                <th className="pb-2">Reason</th>
                <th className="pb-2">Issued</th>
              </tr>
            </thead>
            <tbody>
              {creditNotes.data.map((n: any) => (
                <tr key={n.id} className="border-t border-ink-800">
                  <td className="py-2"><RecordCode code={n.recordCode} /></td>
                  <td className="py-2 tabular-nums">{money(n.amount)}</td>
                  <td className="py-2">
                    {n.reasonCode ? (NOTE_REASON_LABELS[n.reasonCode as NoteReasonCode] ?? n.reasonCode) : <StatusChip status="no reason code" tone="warn" />}
                  </td>
                  <td className="py-2">{date(n.issuedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {open && (
        <Card>
          <h3 className="mb-2 text-sm font-medium text-ink-100">Issue a debit note</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput label="Invoice id" value={invoiceId} onChange={setInvoiceId} required />
            <MoneyInput label="Amount" value={amount} onChange={setAmount} required />
            <SelectInput
              label="Reason"
              value={reasonCode}
              onChange={(v) => setReasonCode(v as NoteReasonCode)}
              placeholder="Choose a reason"
              options={NOTE_REASON_CODES.map((r) => ({ value: r, label: NOTE_REASON_LABELS[r] }))}
              required
            />
            <TextArea label="Note (optional)" value={note} onChange={setNote} />
          </div>
          <div className="mt-3 flex gap-2">
            <button className="btn-primary" disabled={!invoiceId || !amount || !reasonCode} onClick={() => issue.mutate()}>
              Issue
            </button>
            <button className="btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// E-invoicing
// ---------------------------------------------------------------------------

function EInvoiceTab() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const config = useQuery({ queryKey: ['gst-einvoice-config'], queryFn: () => api.get<any>('/compliance/gst/einvoice/config') });
  const statusList = useQuery({ queryKey: ['gst-einvoice-status'], queryFn: () => api.get<any[]>('/compliance/gst/einvoice/status') });

  const request = useMutation({
    mutationFn: (invoiceId: string) => api.post(`/compliance/gst/invoices/${invoiceId}/einvoice`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gst-einvoice-status'] }),
    onError: (e) => setError(messageOf(e)),
  });

  return (
    <div className="space-y-4">
      {error && <ErrorBox error={error} />}
      <Card>
        <h3 className="mb-2 text-sm font-medium text-ink-100">Provider</h3>
        {config.data ? (
          <p className="text-sm text-ink-300">
            Configured: <span className="font-medium">{config.data.provider}</span>
          </p>
        ) : (
          <EmptyState
            message="No e-invoicing provider is configured."
            hint="Requesting an IRN is refused until one is set up — nothing is silently left blank."
          />
        )}
      </Card>
      <Card>
        <h3 className="mb-2 text-sm font-medium text-ink-100">Issued invoices</h3>
        {!statusList.data?.length ? (
          <EmptyState message="Nothing issued yet." />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-2xs uppercase text-ink-500">
              <tr>
                <th className="pb-2">Invoice</th>
                <th className="pb-2">Total</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">IRN</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {statusList.data.map((i: any) => (
                <tr key={i.id} className="border-t border-ink-800">
                  <td className="py-2"><RecordCode code={i.recordCode} /></td>
                  <td className="py-2 tabular-nums">{money(i.grandTotal)}</td>
                  <td className="py-2">
                    <StatusChip
                      status={i.eInvoiceStatus}
                      tone={i.eInvoiceStatus === 'registered' ? 'good' : i.eInvoiceStatus === 'failed' ? 'bad' : 'neutral'}
                    />
                  </td>
                  <td className="py-2">{i.irn ?? '—'}</td>
                  <td className="py-2 text-right">
                    {i.eInvoiceStatus === 'pending' && (
                      <button className="btn-secondary" onClick={() => request.mutate(i.id)}>
                        Request IRN
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GSTR-2B
// ---------------------------------------------------------------------------

function Gstr2bTab() {
  const qc = useQueryClient();
  const [period, setPeriod] = useState(thisMonth());
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState('');

  const summary = useQuery({
    queryKey: ['gst-2b-summary', period],
    queryFn: () => api.get<any>(`/compliance/gst/gstr2b/${period}/summary`),
  });
  const matches = useQuery({
    queryKey: ['gst-2b-matches', period],
    queryFn: () => api.get<any[]>(`/compliance/gst/gstr2b/${period}/matches`),
  });

  const doImport = useMutation({
    mutationFn: () => {
      const parsed = JSON.parse(raw || '{"b2b":[]}');
      return api.post(`/compliance/gst/gstr2b/${period}/import`, { b2b: parsed.b2b ?? parsed });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gst-2b-summary', period] });
      qc.invalidateQueries({ queryKey: ['gst-2b-matches', period] });
      setRaw('');
    },
    onError: (e) => setError(messageOf(e)),
  });

  return (
    <div className="space-y-4">
      {error && <ErrorBox error={error} />}
      <div className="flex items-end gap-2">
        <TextInput label="Period" value={period} onChange={setPeriod} placeholder="YYYY-MM" />
      </div>

      {summary.data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Eligible ITC (2B)" value={money(summary.data.eligibleItc)} />
          <Metric label="Claimed in books" value={money(summary.data.claimedInBooks)} />
          <Metric label="Difference" value={money(summary.data.difference)} />
          <Metric label="Matched" value={String(summary.data.counts?.matched ?? 0)} />
        </div>
      )}

      <Card>
        <h3 className="mb-2 text-sm font-medium text-ink-100">Import the offline JSON</h3>
        <TextArea
          label="b2b rows, as JSON"
          value={raw}
          onChange={setRaw}
          rows={6}
          placeholder='{"b2b":[{"ctin":"...","inum":"...","idt":"05-01-2026","val":1180,"itms":[{"txval":1000,"camt":90,"samt":90}]}]}'
        />
        <button className="btn-primary mt-2" disabled={!raw} onClick={() => doImport.mutate()}>
          Import and match
        </button>
      </Card>

      <Card>
        <h3 className="mb-2 text-sm font-medium text-ink-100">Match table</h3>
        {!matches.data?.length ? (
          <EmptyState message="Nothing imported for this period yet." />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-2xs uppercase text-ink-500">
              <tr>
                <th className="pb-2">Vendor GSTIN</th>
                <th className="pb-2">Invoice no.</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Difference</th>
              </tr>
            </thead>
            <tbody>
              {matches.data.map((m: any) => (
                <tr key={m.id} className="border-t border-ink-800">
                  <td className="py-2">{m.ctin ?? '—'}</td>
                  <td className="py-2">{m.inum ?? '—'}</td>
                  <td className="py-2">
                    <StatusChip status={m.status.replace(/_/g, ' ')} tone={m.status === 'matched' ? 'good' : m.status === 'mismatch' ? 'warn' : 'bad'} />
                  </td>
                  <td className="py-2 tabular-nums">{money(m.difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exposure
// ---------------------------------------------------------------------------

function ExposureTab() {
  const [period, setPeriod] = useState(thisMonth());
  const exposure = useQuery({
    queryKey: ['gst-exposure', period],
    queryFn: () => api.get<any>(`/compliance/gst/exposure/${period}`),
  });

  return (
    <div className="space-y-4">
      <TextInput label="Period" value={period} onChange={setPeriod} placeholder="YYYY-MM" />
      {exposure.isLoading ? (
        <Loading />
      ) : exposure.error ? (
        <ErrorBox error={exposure.error} />
      ) : !exposure.data?.rateTable ? (
        <EmptyState message="No late-fee/interest rate table is seeded yet." />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-left text-2xs uppercase text-ink-500">
              <tr>
                <th className="pb-2">Return</th>
                <th className="pb-2">Due</th>
                <th className="pb-2">Filed</th>
                <th className="pb-2">Days late</th>
                <th className="pb-2">Late fee</th>
                <th className="pb-2">Interest</th>
              </tr>
            </thead>
            <tbody>
              {exposure.data.returns.map((r: any) => (
                <tr key={r.returnType} className="border-t border-ink-800">
                  <td className="py-2">{r.returnType}</td>
                  <td className="py-2">{r.dueDate}</td>
                  <td className="py-2">
                    <StatusChip status={r.filed ? 'filed' : 'not filed'} tone={r.filed ? 'good' : 'warn'} />
                  </td>
                  <td className="py-2 tabular-nums">{r.daysLate}</td>
                  <td className="py-2 tabular-nums">{money(r.lateFee)}</td>
                  <td className="py-2 tabular-nums">{money(r.interest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
