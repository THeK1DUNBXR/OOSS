/**
 * GST returns.
 *
 * The platform had six totals for a month behind a "GST summary" heading. This is
 * the screen that makes filing a thing somebody can actually do: the two returns
 * computed from the books, what is wrong with each before it is filed, a prepared
 * snapshot, and the acknowledgement recorded against it.
 *
 * Three things are deliberate.
 *
 * **The warnings are above the figures.** A line with no HSN is accepted by the
 * books and rejected by the portal, and finding that out at the deadline is the
 * worst possible moment. What would make the return wrong is the first thing on
 * the screen, not a footnote under a correct-looking total.
 *
 * **Preparing and filing are two buttons.** Preparing is arithmetic and can be
 * done ten times. Filing closes the period — an invoice inside a filed month can
 * no longer be edited — and it asks for the ARN, because a return with no
 * acknowledgement was not filed whatever anybody remembers.
 *
 * **It does not claim to transmit.** There is no GSP integration behind this, and
 * a screen with a "File now" button that only wrote a row would be worse than the
 * honest split: the JSON download is the offline-utility file a preparer uploads.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GST_RETURN_LABELS,
  type GstFilingView,
  type GstReturnType,
} from '@kaizen/shared';
import { api, date, dateTime, money } from '../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Metric,
  PageHeader,
  RecordCode,
  StatusChip,
  Tabs,
} from '../components/ui.js';
import { CreateModal, TextArea, TextInput } from '../components/forms.js';

function thisMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The last twelve months, newest first. A return is filed for a month that has ended. */
function recentPeriods(count = 12): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function rupees(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function GstReturns() {
  const qc = useQueryClient();
  const [period, setPeriod] = useState(thisMonth());
  const [tab, setTab] = useState<GstReturnType>('GSTR1');
  const [filing, setFiling] = useState<GstFilingView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const gstr1 = useQuery({
    queryKey: ['gstr1', period],
    queryFn: () => api.get<any>(`/books/gst/gstr1?period=${period}`),
    enabled: tab === 'GSTR1',
  });
  const gstr3b = useQuery({
    queryKey: ['gstr3b', period],
    queryFn: () => api.get<any>(`/books/gst/gstr3b?period=${period}`),
    enabled: tab === 'GSTR3B',
  });
  const filings = useQuery({
    queryKey: ['gst-filings'],
    queryFn: () => api.get<GstFilingView[]>('/books/gst/filings'),
  });
  const periodState = useQuery({
    queryKey: ['gst-period', period],
    queryFn: () => api.get<{ closed: boolean; filed: Array<{ recordCode: string; returnType: string; arn: string | null }> }>(
      `/books/gst/period?period=${period}`,
    ),
  });

  const prepare = useMutation({
    mutationFn: () => api.post('/books/gst/filings', { returnType: tab, period }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['gst-filings'] });
      qc.invalidateQueries({ queryKey: ['gst-period'] });
    },
    onError: (e: unknown) => setError((e as Error).message),
  });

  const current = tab === 'GSTR1' ? gstr1 : gstr3b;
  const computed = current.data;
  const checks: Array<{ severity: string; code: string; message: string; invoices?: string[] }> =
    computed?.checks ?? [];
  const blocking = checks.filter((c) => c.severity === 'blocking');
  const advisories = checks.filter((c) => c.severity !== 'blocking');
  const preparedForPeriod = (filings.data ?? []).filter(
    (f) => f.period === period && f.returnType === tab && f.status === 'prepared',
  );

  if (current.error) return <ErrorBox error={current.error} />;

  return (
    <div>
      <PageHeader
        title="GST returns"
        subtitle="GSTR-1 and GSTR-3B, computed from the books rather than typed into a spreadsheet. Preparing one snapshots the figures; filing it records the portal's acknowledgement and closes the month."
        actions={
          <select className="input max-w-[10rem]" value={period} onChange={(e) => setPeriod(e.target.value)}>
            {recentPeriods().map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        }
      />

      {error && (
        <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
          {error}
        </p>
      )}

      {periodState.data?.closed && (
        <div className="mb-4 rounded-lg border border-band-strong/40 bg-band-strong/5 px-4 py-2.5">
          <p className="text-xs text-band-strong">
            {period} is closed. {periodState.data.filed.map((f) => `${f.returnType} filed as ${f.recordCode}${f.arn ? ` (ARN ${f.arn})` : ''}`).join('; ')}. An
            invoice dated in this month can no longer be edited — the lawful correction to one already reported is a
            credit or debit note in the current period.
          </p>
        </div>
      )}

      <Tabs
        tabs={[
          { key: 'GSTR1' as GstReturnType, label: 'GSTR-1' },
          { key: 'GSTR3B' as GstReturnType, label: 'GSTR-3B' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {/* Above the figures on purpose. A line with no HSN is accepted by the
          books and rejected by the portal, and the filing deadline is the worst
          possible moment to find that out. */}
      {blocking.length > 0 && (
        <div className="mb-4 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-3">
          <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-band-critical">
            The portal would reject this — {blocking.length} to fix
          </p>
          <ul className="space-y-2">
            {blocking.map((c) => (
              <li key={c.code} className="text-xs text-band-critical">
                {c.message}
                {c.invoices && c.invoices.length > 0 && (
                  <p className="mono mt-0.5 text-2xs text-band-critical/70">
                    {c.invoices.slice(0, 8).join(', ')}
                    {c.invoices.length > 8 ? ` and ${c.invoices.length - 8} more` : ''}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-2xs text-band-critical/70">
            A return can still be prepared with these on it — preparing is arithmetic. It cannot be recorded as filed,
            because that closes the month, and a closed month on a return that never went through is the worst of both.
          </p>
        </div>
      )}

      {advisories.length > 0 && (
        <div className="mb-4 rounded-lg border border-band-watch/40 bg-band-watch/5 px-4 py-3">
          <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-band-watch">Worth a look</p>
          <ul className="list-disc space-y-1 pl-4">
            {advisories.map((c) => (
              <li key={c.code} className="text-xs text-band-watch">
                {c.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {current.isLoading || !computed ? (
        <Loading label={`Computing ${GST_RETURN_LABELS[tab]}`} />
      ) : tab === 'GSTR1' ? (
        <Gstr1View data={computed} />
      ) : (
        <Gstr3bView data={computed} />
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={() => prepare.mutate()} disabled={prepare.isPending}>
          {prepare.isPending ? 'Preparing…' : `Prepare ${tab === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} for ${period}`}
        </button>
        {preparedForPeriod.length > 0 && (
          <span className="text-2xs text-ink-500">
            {preparedForPeriod.length} preparation{preparedForPeriod.length === 1 ? '' : 's'} already snapshotted for this
            month. Preparing again supersedes the earlier one rather than overwriting it.
          </span>
        )}
      </div>

      <h2 className="mb-3 mt-8 font-display text-sm uppercase tracking-wider text-ink-300">Prepared and filed</h2>
      {filings.isLoading ? (
        <Loading />
      ) : (filings.data ?? []).length === 0 ? (
        <Card>
          <EmptyState
            message="Nothing prepared yet."
            hint="A prepared return is a snapshot of the figures as they stood. It is what makes a filed return re-readable after the books have moved on."
          />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Return</th>
                <th>Period</th>
                <th className="text-right">Taxable</th>
                <th className="text-right">Output tax</th>
                <th className="text-right">Credit</th>
                <th className="text-right">Payable in cash</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(filings.data ?? []).map((f) => (
                <tr key={f.id}>
                  <td>
                    <RecordCode code={f.recordCode} />
                  </td>
                  <td className="text-xs text-ink-100">{f.returnType}</td>
                  <td className="text-2xs text-ink-400">{f.period}</td>
                  <td className="text-right tabular-nums text-xs">{money(f.taxableValue)}</td>
                  <td className="text-right tabular-nums text-xs">
                    {money((f.cgstAmount ?? 0) + (f.sgstAmount ?? 0) + (f.igstAmount ?? 0))}
                  </td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">{money(f.inputTaxCredit)}</td>
                  <td className="text-right tabular-nums text-xs">{money(f.netPayable)}</td>
                  <td>
                    <StatusChip
                      status={f.status}
                      tone={f.status === 'filed' ? 'good' : f.status === 'superseded' ? 'neutral' : 'warn'}
                    />
                    {f.arn && <p className="mono mt-0.5 text-2xs text-ink-500">{f.arn}</p>}
                  </td>
                  <td className="whitespace-nowrap">
                    <button
                      className="btn-ghost"
                      onClick={() => api.download(`/books/gst/filings/${f.id}/export`, `${f.recordCode}.json`)}
                    >
                      JSON
                    </button>
                    {f.status === 'prepared' && (
                      <button className="btn-ghost" onClick={() => setFiling(f)}>
                        Mark filed
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p className="mt-3 text-2xs text-ink-600">
        This platform prepares returns; it does not transmit them. The JSON is the offline utility's file, and marking a
        return filed records the acknowledgement the portal gave back.
      </p>

      <MarkFiled filing={filing} onClose={() => setFiling(null)} />
    </div>
  );
}

function MarkFiled({ filing, onClose }: { filing: GstFilingView | null; onClose: () => void }) {
  const [arn, setArn] = useState('');
  const [filedAt, setFiledAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');

  if (!filing) return null;

  return (
    <CreateModal
      open
      title={`Record ${filing.recordCode} as filed`}
      submitLabel="Record it"
      onClose={onClose}
      invalidate={[['gst-filings'], ['gst-period'], ['invoices']]}
      onSubmit={() =>
        api.post(`/books/gst/filings/${filing.id}/file`, {
          arn: arn.trim(),
          filedAt: new Date(filedAt).toISOString(),
          note: note.trim() || null,
        })
      }
    >
      <p className="text-xs text-ink-300">
        {filing.returnType} for {filing.period} — {money(filing.netPayable)} payable in cash on {filing.invoiceCount}{' '}
        invoices.
      </p>
      <TextInput
        label="ARN"
        required
        autoFocus
        value={arn}
        onChange={setArn}
        placeholder="AA330826012345X"
        hint="the portal's acknowledgement"
      />
      <TextInput label="Filed on" type="date" required value={filedAt} onChange={setFiledAt} />
      <TextArea label="Note" value={note} onChange={setNote} rows={2} />
      <p className="rounded border border-ink-800 bg-ink-950 px-3 py-2 text-2xs text-ink-500">
        Recording this closes {filing.period}: an invoice dated in that month can no longer be edited or voided, because
        its figures have been stated to the government. The correction to an invoice already reported is a credit or
        debit note in the current period.
      </p>
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// GSTR-1
// ---------------------------------------------------------------------------

function Gstr1View({ data }: { data: any }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Metric label="Invoices reported" value={data.totals.invoiceCount} />
        <Metric label="Taxable value" value={money(data.totals.taxableValue)} />
        <Metric label="Tax" value={money(data.totals.tax)} />
        <Metric label="Invoice value" value={money(data.totals.invoiceValue)} />
      </div>

      <Card
        title="B2B — registered customers"
        subtitle="Reported invoice by invoice with their GSTIN, because that is what lets them claim the tax back."
        bodyClassName="p-0 overflow-x-auto"
      >
        {data.b2b.length === 0 ? (
          <div className="p-4">
            <EmptyState message="No supplies to registered customers this month." />
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>GSTIN</th>
                <th>Place of supply</th>
                <th className="text-right">Taxable</th>
                <th className="text-right">CGST</th>
                <th className="text-right">SGST</th>
                <th className="text-right">IGST</th>
                <th className="text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {data.b2b.map((row: any) => (
                <tr key={row.invoiceId}>
                  <td className="mono text-2xs">{row.invoiceNumber}</td>
                  <td className="text-xs text-ink-100">{row.customerName}</td>
                  <td className="mono text-2xs text-ink-400">{row.customerGstin}</td>
                  <td className="text-2xs text-ink-400">{row.placeOfSupply ?? '—'}</td>
                  <td className="text-right tabular-nums text-xs">{rupees(row.taxableValue)}</td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">{rupees(row.cgst)}</td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">{rupees(row.sgst)}</td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">{rupees(row.igst)}</td>
                  <td className="text-right tabular-nums text-xs">{rupees(row.invoiceValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="B2CL — large inter-state sales to unregistered customers"
        subtitle="Above ₹2.5 lakh and across a state line: reported invoice by invoice, because the destination state's share of the IGST is settled from this."
        bodyClassName="p-0 overflow-x-auto"
      >
        {data.b2cl.length === 0 ? (
          <div className="p-4">
            <EmptyState message="None this month." />
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Place of supply</th>
                <th className="text-right">Taxable</th>
                <th className="text-right">IGST</th>
                <th className="text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {data.b2cl.map((row: any) => (
                <tr key={row.invoiceId}>
                  <td className="mono text-2xs">{row.invoiceNumber}</td>
                  <td className="text-xs text-ink-100">{row.customerName}</td>
                  <td className="text-2xs text-ink-400">{row.placeOfSupply ?? '—'}</td>
                  <td className="text-right tabular-nums text-xs">{rupees(row.taxableValue)}</td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">{rupees(row.igst)}</td>
                  <td className="text-right tabular-nums text-xs">{rupees(row.invoiceValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="B2CS — unregistered customers"
        subtitle="A rate-wise total rather than a list of invoices. An invoice carrying two rates lands in two rows."
        bodyClassName="p-0 overflow-x-auto"
      >
        {data.b2cs.length === 0 ? (
          <div className="p-4">
            <EmptyState message="No supplies to unregistered customers this month." />
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Rate</th>
                <th className="text-right">Taxable</th>
                <th className="text-right">CGST</th>
                <th className="text-right">SGST</th>
                <th className="text-right">IGST</th>
              </tr>
            </thead>
            <tbody>
              {data.b2cs.map((row: any) => (
                <tr key={`${row.gstRate}-${row.taxableValue}`}>
                  <td className="text-xs">{row.gstRate}%</td>
                  <td className="text-right tabular-nums text-xs">{rupees(row.taxableValue)}</td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">{rupees(row.cgst)}</td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">{rupees(row.sgst)}</td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">{rupees(row.igst)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="HSN / SAC summary"
        subtitle="What was supplied, regardless of to whom. The portal requires a code on every line."
        bodyClassName="p-0 overflow-x-auto"
      >
        {data.hsn.length === 0 ? (
          <div className="p-4">
            <EmptyState message="Nothing supplied this month." />
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Description</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Rate</th>
                <th className="text-right">Taxable</th>
                <th className="text-right">Tax</th>
              </tr>
            </thead>
            <tbody>
              {data.hsn.map((row: any) => (
                <tr key={`${row.hsnSac}-${row.gstRate}`}>
                  <td className={`mono text-2xs ${row.hsnSac === 'UNCLASSIFIED' ? 'text-band-critical' : ''}`}>
                    {row.hsnSac}
                  </td>
                  <td className="text-xs text-ink-300">{row.description}</td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">{row.quantity}</td>
                  <td className="text-right text-2xs text-ink-400">{row.gstRate}%</td>
                  <td className="text-right tabular-nums text-xs">{rupees(row.taxableValue)}</td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">
                    {rupees(row.cgst + row.sgst + row.igst)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="Document summary"
        subtitle="The number range issued and how many of them were cancelled. A gap in an invoice series that the return does not explain is what an audit asks about."
      >
        <dl className="grid grid-cols-2 gap-x-6 sm:grid-cols-5">
          <Field label="From">{data.documentSummary.from ?? '—'}</Field>
          <Field label="To">{data.documentSummary.to ?? '—'}</Field>
          <Field label="Issued">{data.documentSummary.issued}</Field>
          <Field label="Reported">{data.documentSummary.reported}</Field>
          <Field label="Cancelled">{data.documentSummary.cancelled}</Field>
        </dl>
      </Card>

      {data.creditNotes.length > 0 && (
        <Card title="Credit notes" subtitle="Raised this month, reducing what was supplied. Their own table, never a negative invoice.">
          <table className="table">
            <thead>
              <tr>
                <th>Note</th>
                <th>Against</th>
                <th>Issued</th>
                <th>Reason</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.creditNotes.map((c: any) => (
                <tr key={c.recordCode}>
                  <td className="mono text-2xs">{c.recordCode}</td>
                  <td className="mono text-2xs text-ink-400">{c.invoiceNumber}</td>
                  <td className="text-2xs text-ink-400">{date(c.issuedAt)}</td>
                  <td className="text-xs text-ink-300">{c.reason}</td>
                  <td className="text-right tabular-nums text-xs">{rupees(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GSTR-3B
// ---------------------------------------------------------------------------

function Gstr3bView({ data }: { data: any }) {
  const heads = [
    ['IGST', 'igst'],
    ['CGST', 'cgst'],
    ['SGST', 'sgst'],
  ] as const;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Metric label="Outward taxable supplies" value={money(data.outwardSupplies.taxableValue)} />
        <Metric label="Output tax" value={money(data.outwardSupplies.tax)} />
        <Metric label="Credit available" value={money(data.inputTaxCredit.total)} />
        <Metric
          label="Payable in cash"
          value={money(data.payment.totalPayableInCash)}
          tone={data.payment.totalPayableInCash > 0 ? 'warn' : 'good'}
        />
      </div>

      <Card
        title="3.1(a) — outward taxable supplies"
        subtitle="From the same invoices GSTR-1 reports, so the two agree by construction. A discrepancy between them is exactly what a notice asks about."
      >
        <dl className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
          <Field label="Taxable value">{rupees(data.outwardSupplies.taxableValue)}</Field>
          <Field label="IGST">{rupees(data.outwardSupplies.igst)}</Field>
          <Field label="CGST">{rupees(data.outwardSupplies.cgst)}</Field>
          <Field label="SGST">{rupees(data.outwardSupplies.sgst)}</Field>
          <Field label="Invoices">{data.outwardSupplies.invoiceCount}</Field>
          <Field label="Of which B2B">{data.outwardSupplies.b2bCount}</Field>
          <Field label="Invoice value">{rupees(data.outwardSupplies.invoiceValue)}</Field>
        </dl>
      </Card>

      <Card
        title="4(A) — input tax credit available"
        subtitle="From supplier bills in the period, split across the heads the way the supply was: a bill from within the state carried CGST and SGST, and claiming it as IGST credit would be wrong in a way the set-off then compounds."
      >
        <dl className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
          <Field label="IGST">{rupees(data.inputTaxCredit.igst)}</Field>
          <Field label="CGST">{rupees(data.inputTaxCredit.cgst)}</Field>
          <Field label="SGST">{rupees(data.inputTaxCredit.sgst)}</Field>
          <Field label="Total">{rupees(data.inputTaxCredit.total)}</Field>
          <Field label="Bills">{data.inputTaxCredit.billCount}</Field>
          <Field label="Not claimable">{rupees(data.inputTaxCredit.notClaimable)}</Field>
        </dl>
        {data.inputTaxCredit.notClaimable > 0 && (
          <p className="mt-2 text-2xs text-ink-500">
            Tax on bills from suppliers with no GSTIN on file. It was paid and it cannot be claimed — adding their
            registrations, where they have one, moves it into the credit above.
          </p>
        )}
      </Card>

      <Card
        title="3.2 — inter-state supplies to unregistered persons"
        subtitle="Of the supplies above, where they went. The destination state's share of the IGST is settled from this table, so a supply missing from it is money that never reaches the state it was collected for."
        bodyClassName="p-0 overflow-x-auto"
      >
        {data.interStateToUnregistered.length === 0 ? (
          <div className="p-4">
            <EmptyState message="No inter-state supplies to unregistered customers this month." />
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Place of supply</th>
                <th className="text-right">Taxable</th>
                <th className="text-right">IGST</th>
              </tr>
            </thead>
            <tbody>
              {data.interStateToUnregistered.map((row: any) => (
                <tr key={row.placeOfSupply}>
                  <td className="text-xs text-ink-100">{row.placeOfSupply}</td>
                  <td className="text-right tabular-nums text-xs">{rupees(row.taxableValue)}</td>
                  <td className="text-right tabular-nums text-xs">{rupees(row.igst)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="3.1(b)–(e) — everything else supplied"
        subtitle="Reported as zero and reported nonetheless: the portal asks for every row, and a company that starts exporting needs the row to exist before it has a figure in it."
      >
        <dl className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
          <Field label="Zero rated">{rupees(data.otherOutwardSupplies.zeroRated.taxableValue)}</Field>
          <Field label="Nil rated &amp; exempt">{rupees(data.otherOutwardSupplies.nilRatedAndExempt.taxableValue)}</Field>
          <Field label="Non-GST">{rupees(data.otherOutwardSupplies.nonGst.taxableValue)}</Field>
          <Field label="Reverse charge">{rupees(data.otherOutwardSupplies.reverseCharge.taxableValue)}</Field>
        </dl>
        <p className="mt-2 text-2xs text-ink-500">{data.otherOutwardSupplies.note}</p>
      </Card>

      <Card
        title="6.1 — payment of tax"
        subtitle="Credit is set off head by head in the statutory order: IGST credit against IGST first and only then against CGST and SGST; CGST credit against CGST alone. Netting the totals instead produces a figure that is too small whenever the mix differs, and the shortfall arrives as interest."
        bodyClassName="p-0 overflow-x-auto"
      >
        <table className="table">
          <thead>
            <tr>
              <th>Head</th>
              <th className="text-right">Credit utilised</th>
              <th className="text-right">Payable in cash</th>
              <th className="text-right">Credit carried forward</th>
            </tr>
          </thead>
          <tbody>
            {heads.map(([label, key]) => (
              <tr key={key}>
                <td className="text-xs text-ink-100">{label}</td>
                <td className="text-right tabular-nums text-xs text-ink-400">{rupees(data.payment.utilised[key])}</td>
                <td className="text-right tabular-nums text-xs">{rupees(data.payment.payableInCash[key])}</td>
                <td className="text-right tabular-nums text-2xs text-ink-500">
                  {rupees(data.payment.creditCarriedForward[key])}
                </td>
              </tr>
            ))}
            <tr>
              <td className="text-xs font-medium text-ink-50">Total</td>
              <td className="text-right tabular-nums text-xs text-ink-400">{rupees(data.payment.totalUtilised)}</td>
              <td className="text-right tabular-nums text-sm font-medium text-ink-50">
                {rupees(data.payment.totalPayableInCash)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/**
 * The company's own registration, address and bank details.
 *
 * Every invoice is printed from these and every return is filed under them, which
 * is why the screen sits beside the returns rather than in an admin page about
 * something else. The GSTIN is validated here — shape, a real state code and the
 * check digit — because a mistyped registration is rejected by the portal weeks
 * later with nothing to say which field caused it.
 */
export function CompanyDetails() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['company-profile'],
    queryFn: () => api.get<any>('/books/company-profile'),
  });
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.patch('/books/company-profile', numbersFixed(form)),
    onSuccess: () => {
      setFailure(null);
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['company-profile'] });
      qc.invalidateQueries({ queryKey: ['invoice-document'] });
    },
    onError: (e: unknown) => {
      setSaved(false);
      setFailure((e as Error).message);
    },
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Loading label="Loading the company details" />;

  const value = (key: string) => form[key] ?? (data[key] === null || data[key] === undefined ? '' : String(data[key]));
  const set = (key: string) => (v: string) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: v }));
  };

  return (
    <div>
      <PageHeader
        title="Company details"
        subtitle="Who the company is, on paper. An invoice without the supplier's legal name, address and GSTIN is not a tax invoice, and a return is filed under a registration — so these are not settings, they are part of every document the company issues."
        actions={
          <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        }
      />

      {failure && (
        <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
          {failure}
        </p>
      )}
      {saved && <p className="mb-4 text-xs text-band-strong">Saved. Every invoice raised from now on prints these details.</p>}
      {!data.gstin && (
        <div className="mb-4 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-2.5">
          <p className="text-xs text-band-critical">
            No GSTIN yet. Until one is set, invoices print as documents rather than tax invoices and no return can be
            filed.
          </p>
        </div>
      )}

      <DocumentSeries profile={data} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Identity" subtitle="As registered. The legal name is what appears on the invoice.">
          <div className="flex flex-col gap-3">
            <TextInput label="Legal name" required value={value('legalName')} onChange={set('legalName')} />
            <TextInput label="Trading as" value={value('tradeName')} onChange={set('tradeName')} />
            <TextInput
              label="GSTIN"
              value={value('gstin')}
              onChange={(v) => set('gstin')(v.toUpperCase())}
              placeholder="33AABCK1234H1Z2"
              hint="fifteen characters, check digit validated"
            />
            <TextInput label="PAN" value={value('pan')} onChange={(v) => set('pan')(v.toUpperCase())} />
            <TextInput label="CIN" value={value('cin')} onChange={(v) => set('cin')(v.toUpperCase())} />
            {data.stateName && (
              <p className="text-2xs text-ink-500">
                Registered in {data.stateName} ({data.stateCode}). A customer in the same state is charged CGST and SGST;
                one outside it is charged IGST.
              </p>
            )}
          </div>
        </Card>

        <Card title="Registered address" subtitle="Printed at the top of every invoice.">
          <div className="flex flex-col gap-3">
            <TextInput label="Address line 1" value={value('addressLine1')} onChange={set('addressLine1')} />
            <TextInput label="Address line 2" value={value('addressLine2')} onChange={set('addressLine2')} />
            <TextInput label="City" value={value('city')} onChange={set('city')} />
            <TextInput label="Pincode" value={value('pincode')} onChange={set('pincode')} />
            <TextInput label="Phone" value={value('phone')} onChange={set('phone')} />
            <TextInput label="Email" type="email" value={value('email')} onChange={set('email')} />
            <TextInput label="Website" value={value('website')} onChange={set('website')} />
          </div>
        </Card>

        <Card
          title="How customers pay"
          subtitle="Printed in the invoice footer, on purpose: an invoice a customer cannot pay from is half a document."
        >
          <div className="flex flex-col gap-3">
            <TextInput label="Bank" value={value('bankName')} onChange={set('bankName')} />
            <TextInput label="Account name" value={value('bankAccountName')} onChange={set('bankAccountName')} />
            <TextInput label="Account number" value={value('bankAccountNumber')} onChange={set('bankAccountNumber')} />
            <TextInput label="IFSC" value={value('bankIfsc')} onChange={(v) => set('bankIfsc')(v.toUpperCase())} />
            <TextInput label="Branch" value={value('bankBranch')} onChange={set('bankBranch')} />
            <TextInput label="UPI id" value={value('upiId')} onChange={set('upiId')} />
          </div>
        </Card>

        <Card title="Invoice wording" subtitle="The terms and the footnote every invoice carries, and the default credit period.">
          <div className="flex flex-col gap-3">
            <TextArea label="Terms" value={value('invoiceTerms')} onChange={set('invoiceTerms')} rows={3} />
            <TextArea label="Footnote" value={value('invoiceNotes')} onChange={set('invoiceNotes')} rows={2} />
            <TextInput
              label="Default credit period (days)"
              type="number"
              value={value('defaultDueDays')}
              onChange={set('defaultDueDays')}
            />
          </div>
        </Card>
      </div>

      <p className="mt-4 text-2xs text-ink-600">
        Changing these does not restate an invoice already issued: an invoice carries its own copy of the tax it was
        raised under, so reprinting an old one shows what the customer was actually charged.
      </p>
    </div>
  );
}

/**
 * The document numbering, and where each series stands.
 *
 * Two things nobody should have to find out the hard way. The first is the
 * sixteen-character limit: the portal refuses a longer tax invoice number, and
 * `KIPL/I/2026-27/001` is eighteen. It is shown here, with its length, before the
 * first invoice is raised — not at the filing deadline.
 *
 * The second is where a series starts. A company adopting this mid-year has
 * already issued fifteen receipts by hand, and starting again at 001 would put
 * two documents into the world with one number.
 */
function DocumentSeries({ profile }: { profile: any }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<any | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const { data: series = [] } = useQuery({
    queryKey: ['document-series'],
    queryFn: () => api.get<any[]>('/books/company-profile/series'),
  });

  const setYearFormat = useMutation({
    mutationFn: (documentYearFormat: string) => api.patch('/books/company-profile', { documentYearFormat }),
    onSuccess: () => {
      setFailure(null);
      qc.invalidateQueries({ queryKey: ['company-profile'] });
      qc.invalidateQueries({ queryKey: ['document-series'] });
    },
    onError: (e: unknown) => setFailure((e as Error).message),
  });

  const tooLong = series.filter((s) => s.tooLongForThePortal);

  return (
    <Card
      className="mb-4"
      title="Document numbering"
      subtitle="Every document a customer is handed is numbered in the company's own series, per financial year: the short code, the series letter, the year, and a sequence that restarts each April."
    >
      {failure && <p className="mb-3 text-xs text-band-critical">{failure}</p>}

      {tooLong.length > 0 && (
        <div className="mb-3 rounded border border-band-critical/40 bg-band-critical/5 px-3 py-2">
          <p className="text-xs text-band-critical">
            A tax invoice number may be at most sixteen characters, and {tooLong[0].example} is {tooLong[0].length}.
            GSTR-1 would reject every invoice raised under it. Shorten the prefix, or write the year as {' '}
            {profile.documentYearFormat === 'full' ? '26-27' : '2026-27'}.
          </p>
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Series</th>
            <th>Next number</th>
            <th className="text-right">Length</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {series.map((s) => (
            <tr key={s.series}>
              <td className="text-xs text-ink-100">{s.label}</td>
              <td className="mono text-xs">{s.example}</td>
              <td
                className={`text-right tabular-nums text-2xs ${s.tooLongForThePortal ? 'text-band-critical' : 'text-ink-500'}`}
              >
                {s.length}
                {s.series === 'I' ? ' / 16' : ''}
              </td>
              <td>
                <button className="btn-ghost" onClick={() => setEditing(s)}>
                  Start from…
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-800 pt-3">
        <span className="label">Year written as</span>
        {(['short', 'full'] as const).map((format) => (
          <button
            key={format}
            className={`chip transition-colors ${
              (profile.documentYearFormat ?? 'short') === format
                ? 'border-accent/60 text-accent-soft'
                : 'border-ink-800 text-ink-500 hover:border-ink-600'
            }`}
            onClick={() => setYearFormat.mutate(format)}
          >
            {format === 'short' ? '26-27' : '2026-27'}
          </button>
        ))}
        <span className="text-2xs text-ink-600">
          The short form exists because of the sixteen-character limit, not because it reads better.
        </span>
      </div>

      {editing && <SeriesStart series={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function SeriesStart({ series, onClose }: { series: any; onClose: () => void }) {
  const [next, setNext] = useState(String(series.nextNumber));

  return (
    <CreateModal
      open
      title={`Start the ${series.label.toLowerCase()} series from…`}
      submitLabel="Set it"
      onClose={onClose}
      invalidate={[['document-series']]}
      onSubmit={() => api.post('/books/company-profile/series', { series: series.series, nextNumber: Number(next) })}
    >
      <p className="text-xs text-ink-300">
        The next one would be <span className="mono text-ink-100">{series.example}</span>.
      </p>
      <TextInput label="Next number" type="number" required value={next} onChange={setNext} />
      <p className="text-2xs text-ink-500">
        For a company that has already issued some of this year's documents by hand: without this, the platform starts
        again at 001 and puts two documents into the world with one number. A series only moves forwards.
      </p>
    </CreateModal>
  );
}

/** The one numeric field on the form, sent as a number rather than as a string. */
function numbersFixed(form: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(form)) {
    if (key === 'defaultDueDays') {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) out[key] = Math.round(n);
      continue;
    }
    out[key] = raw.trim() === '' ? null : raw.trim();
  }
  return out;
}
