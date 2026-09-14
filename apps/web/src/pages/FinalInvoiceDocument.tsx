/**
 * The final invoice, and the list of them.
 *
 * The document raised once the instalments are done. Neither of the other two can
 * answer the question a customer asks at the end — "what did I owe, what have I
 * paid, and against which receipts" — because the tax invoice predates the
 * payments and each receipt only knows about itself.
 *
 * So this names them all: the total payable, every instalment with its receipt
 * number and date, what has been received, and what is left. Read from the
 * statement's own snapshot, because a statement handed over on the 12th has to
 * still say what it said on the 12th — a further instalment produces a new
 * statement rather than editing the old one.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  amountInWords,
  PAYMENT_MODE_LABELS,
  type FinalInvoiceDocumentView,
  type FinalInvoiceView,
  type PaymentMode,
} from '@kaizen/shared';
import { api, date, dateTime, money } from '../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, Metric, PageHeader, RecordCode, StatusChip } from '../components/ui.js';
import { fmtDate, fmtINR } from './kaizenInvoice/calc.js';
import {
  LedgerHead,
  InfoGrid,
  InfoRow,
  DateBoxGrid,
  DateBoxItem,
  TotalsStrip,
  NoteStrip,
  SignStrip,
  Watermark,
  type LedgerCompany,
} from './kaizenInvoice/LedgerSheet.js';
import { DocumentToolbar, DocumentScreen, TwoCopyPrintPage, PrintPortal } from './documents/PrintSheet.js';

export function FinalInvoiceDocument() {
  const { id } = useParams<{ id: string }>();
  const [printKey, setPrintKey] = useState<number | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['final-invoice-document', id],
    queryFn: () => api.get<FinalInvoiceDocumentView>(`/finance/final-invoices/${id}/document`),
    enabled: Boolean(id),
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Loading label="Preparing the statement" />;

  const d = data;

  const company: LedgerCompany = {
    name: 'Kaizen Infinities',
    tagline: 'Training & Education Services',
    legalName: d.supplier.legalName,
    address: [d.supplier.addressLine1, d.supplier.addressLine2, d.supplier.city ? `${d.supplier.city}-${d.supplier.pincode ?? ''}` : null]
      .filter(Boolean)
      .join(', '),
    location: d.supplier.stateName ?? '—',
    stateCode: null,
    gstin: d.supplier.gstin,
    phone: d.supplier.phone,
  };

  function handlePrint() {
    setPrintKey(Date.now());
    window.setTimeout(() => window.print(), 50);
  }

  const sheet = (
    <>
      {d.status === 'superseded' && <Watermark text="SUPERSEDED" />}
      <LedgerHead company={company} />
      <InfoGrid>
        <InfoRow k="No." v={d.recordCode} />
        <InfoRow k="Date" v={fmtDate(d.issuedAt)} />
        <InfoRow k="Student/Customer Name" v={d.customer.name} />
        <InfoRow k="Contact No." v={d.customer.phone ?? '—'} />
        <InfoRow k="Against Invoice No." v={d.invoice.recordCode} />
        <InfoRow k="Invoice Date" v={fmtDate(d.invoice.issuedDate)} />
      </InfoGrid>
      <DateBoxGrid columns={3}>
        <DateBoxItem k="Total Payable" v={fmtINR(d.totals.totalPayable)} />
        <DateBoxItem k="Received" v={fmtINR(d.totals.totalReceived)} />
        <DateBoxItem k="Balance" v={fmtINR(d.totals.balance)} />
      </DateBoxGrid>

      <p style={{ padding: '8px 22px 0', fontSize: 12, fontWeight: 700 }}>
        What was billed — tax invoice {d.invoice.recordCode}
      </p>
      <div className="ki-ledger-scroll">
        <table className="ki-ledger">
          <thead>
            <tr>
              <th>#</th>
              <th>Description</th>
              <th>HSN/SAC</th>
              <th>Qty</th>
              <th>Rate</th>
              <th>Amount</th>
              <th>GST %</th>
              <th>Tax</th>
            </tr>
          </thead>
          <tbody>
            {d.invoice.lines.map((line, i) => (
              <tr key={`${line.description}-${i}`}>
                <td>{i + 1}</td>
                <td className="ki-name-cell">
                  {line.description}
                  {line.courseName && !line.description.includes(line.courseName) && ` · ${line.courseName}`}
                </td>
                <td>{line.hsnSac ?? '—'}</td>
                <td>{line.quantity}</td>
                <td>{fmtINR(line.unitPrice)}</td>
                <td>{fmtINR(line.amount)}</td>
                <td>{line.gstRate}%</td>
                <td className="ki-total-cell">{fmtINR(line.taxAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ padding: '10px 22px 0', fontSize: 12, fontWeight: 700 }}>Receipts</p>
      <div className="ki-ledger-scroll">
        <table className="ki-ledger">
          <thead>
            <tr>
              <th>No.</th>
              <th>Date</th>
              <th>Mode</th>
              <th>Amount</th>
              <th>Balance after</th>
            </tr>
          </thead>
          <tbody>
            {d.receipts.map((r) => (
              <tr key={r.recordCode}>
                <td>{r.number}</td>
                <td>{fmtDate(r.issuedAt)}</td>
                <td>{r.mode ? (PAYMENT_MODE_LABELS[r.mode as PaymentMode] ?? r.mode) : '—'}</td>
                <td>{fmtINR(r.amount)}</td>
                <td className="ki-total-cell">{fmtINR(r.balanceAfter)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <TotalsStrip doc={{ amountInWords: amountInWords(d.totals.totalPayable), grandTotal: d.totals.totalPayable, label: 'Grand Total (total payable)' }} />

      <NoteStrip>
        This statement restates tax invoice {d.invoice.recordCode} and every receipt against it, as they stood on
        the day it was raised.
        {d.totals.settled ? ' Settled in full — nothing further is due.' : ` Balance of ${money(d.totals.balance)} remains payable.`}
        {d.supersedes.length > 0 && ` Supersedes ${d.supersedes.join(', ')}.`}
        {d.note && ` ${d.note}`}
      </NoteStrip>
      <SignStrip />
    </>
  );

  return (
    <div>
      <DocumentToolbar backTo="/finance/final-invoices" backLabel="Final invoices" onPrint={handlePrint} />
      <DocumentScreen>{sheet}</DocumentScreen>

      {printKey && (
        <PrintPortal key={printKey}>
          <TwoCopyPrintPage render={() => sheet} />
        </PrintPortal>
      )}
    </div>
  );
}

export function FinalInvoices() {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['final-invoices'],
    queryFn: () => api.get<FinalInvoiceView[]>('/finance/final-invoices'),
  });

  if (error) return <ErrorBox error={error} />;

  const current = data.filter((f) => f.status === 'issued');
  const settled = current.filter((f) => f.settled).length;

  return (
    <div>
      <PageHeader
        title="Final invoices"
        subtitle="Raised once the instalments are done: what was billed, and every receipt."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Statements" value={current.length} />
        <Metric label="Settled" value={settled} tone={settled === current.length ? 'good' : 'warn'} />
        <Metric
          label="Still owed"
          value={money(current.reduce((s, f) => s + f.balance, 0))}
          tone={current.some((f) => f.balance > 0) ? 'warn' : 'good'}
        />
      </div>

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState
            message="None raised yet."
            hint="Open a part-paid invoice and raise one from there."
          />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Statement</th>
                <th>Raised</th>
                <th>Against</th>
                <th>Receipts</th>
                <th className="text-right">Total payable</th>
                <th className="text-right">Received</th>
                <th className="text-right">Balance</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((f) => (
                <tr key={f.id}>
                  <td>
                    <RecordCode code={f.recordCode} />
                  </td>
                  <td className="text-2xs text-ink-400">{date(f.issuedAt)}</td>
                  <td className="mono text-2xs text-ink-400">{f.invoiceCode}</td>
                  <td className="mono text-2xs text-ink-500">{f.receiptCodes.join(', ')}</td>
                  <td className="text-right tabular-nums text-xs">{money(f.totalPayable)}</td>
                  <td className="text-right tabular-nums text-xs">{money(f.totalReceived)}</td>
                  <td className={`text-right tabular-nums text-xs ${f.balance > 0 ? 'text-band-watch' : 'text-band-strong'}`}>
                    {money(f.balance)}
                  </td>
                  <td>
                    <StatusChip
                      status={f.status === 'superseded' ? 'superseded' : f.settled ? 'settled' : 'part paid'}
                      tone={f.status === 'superseded' ? 'neutral' : f.settled ? 'good' : 'warn'}
                    />
                  </td>
                  <td>
                    <Link className="btn-ghost" to={`/finance/final-invoices/${f.id}`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p className="mt-3 text-2xs text-ink-600">
        A later statement supersedes this one. Both stay on file.
      </p>
    </div>
  );
}
