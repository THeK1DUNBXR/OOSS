/**
 * A receipt, and the list of them.
 *
 * This is where part payments live. The tax invoice is final and states the whole
 * obligation; every instalment against it produces one of these — its own number,
 * its own time, the invoice it is against, the amount, how it was paid and what
 * was left afterwards.
 *
 * The two figures a customer needs are here rather than on the invoice: what the
 * invoice is for, and what they are handing over now. They are read from the
 * receipt's own snapshot, so reprinting the first receipt six months later still
 * shows the balance as it stood on the day — which is the entire reason a receipt
 * is a document and not a view of the current position.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { amountInWords, PAYMENT_MODE_LABELS, type PaymentMode, type ReceiptDocumentView, type ReceiptView } from '@kaizen/shared';
import { api, dateTime, money } from '../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, Metric, PageHeader, RecordCode } from '../components/ui.js';
import { fmtDate, fmtINR } from './kaizenInvoice/calc.js';
import { LedgerHead, InfoGrid, InfoRow, DateBoxGrid, DateBoxItem, TotalsStrip, NoteStrip, SignStrip, type LedgerCompany } from './kaizenInvoice/LedgerSheet.js';
import { DocumentToolbar, DocumentScreen, TwoCopyPrintPage, PrintPortal } from './documents/PrintSheet.js';

export function ReceiptDocument() {
  const { id } = useParams<{ id: string }>();
  const [printKey, setPrintKey] = useState<number | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['receipt-document', id],
    queryFn: () => api.get<ReceiptDocumentView>(`/finance/receipts/${id}/document`),
    enabled: Boolean(id),
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Loading label="Preparing the receipt" />;

  const d = data;
  const modeLabel = PAYMENT_MODE_LABELS[d.payment.mode as PaymentMode] ?? d.payment.mode;

  const company: LedgerCompany = {
    name: 'Kaizen Infinities',
    tagline: 'Training & Education Services',
    legalName: d.supplier.legalName,
    address: [d.supplier.addressLine1, d.supplier.addressLine2, d.supplier.city ? `${d.supplier.city}-${d.supplier.pincode ?? ''}` : null]
      .filter(Boolean)
      .join(', '),
    location: '—',
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
      <LedgerHead company={company} />
      <InfoGrid>
        <InfoRow k="Receipt No." v={d.recordCode} />
        <InfoRow k="Date" v={fmtDate(d.issuedAt)} />
        <InfoRow k="Student/Customer Name" v={d.customer.name} />
        <InfoRow k="Contact No." v={d.customer.phone ?? '—'} />
        <InfoRow k="Against Invoice No." v={d.invoice.recordCode} />
        <InfoRow k="Invoice Date" v={fmtDate(d.invoice.issuedDate)} />
      </InfoGrid>
      <DateBoxGrid columns={4}>
        <DateBoxItem k="Amount Received" v={fmtINR(d.position.amountReceivedNow)} />
        <DateBoxItem k="Mode" v={modeLabel} bold={false} />
        <DateBoxItem k="Balance Before" v={fmtINR(d.position.balanceAfter + d.position.amountReceivedNow)} />
        <DateBoxItem k="Balance After" v={fmtINR(d.position.balanceAfter)} />
      </DateBoxGrid>

      {d.sequence.length > 1 && (
        <div className="ki-ledger-scroll">
          <table className="ki-ledger">
            <thead>
              <tr>
                <th>No.</th>
                <th>Receipt</th>
                <th>Date</th>
                <th>Mode</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {d.sequence.map((r) => (
                <tr key={r.recordCode} className={r.isThisOne ? 'ki-course-row' : undefined}>
                  <td>{r.number}</td>
                  <td className="ki-name-cell">{r.recordCode}</td>
                  <td>{fmtDate(r.issuedAt)}</td>
                  <td>{r.mode ? (PAYMENT_MODE_LABELS[r.mode as PaymentMode] ?? r.mode) : '—'}</td>
                  <td className="ki-total-cell">{fmtINR(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <TotalsStrip
        doc={{ amountInWords: amountInWords(d.position.amountReceivedNow), grandTotal: d.position.amountReceivedNow, label: 'Amount Received' }}
      />

      <NoteStrip>
        This receipt acknowledges money received against the invoice named above; the tax invoice remains the tax
        document.
        {d.payment.reference && ` Reference: ${d.payment.reference}.`}
        {d.payment.note && ` ${d.payment.note}`}
        {d.footnote && ` ${d.footnote}`}
      </NoteStrip>
      <SignStrip />
    </>
  );

  return (
    <div>
      <DocumentToolbar backTo="/finance/receipts" backLabel="Receipts" onPrint={handlePrint} />
      <DocumentScreen>{sheet}</DocumentScreen>

      {printKey && (
        <PrintPortal key={printKey}>
          <TwoCopyPrintPage render={() => sheet} />
        </PrintPortal>
      )}
    </div>
  );
}

/**
 * Every receipt issued.
 *
 * Its own surface because a receipt is its own document: "find me the receipt for
 * the twenty thousand that student paid in March" is a question asked about
 * receipts, not about invoices, and answering it through the invoice list means
 * knowing which invoice first.
 */
export function Receipts() {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['receipts'],
    queryFn: () => api.get<ReceiptView[]>('/finance/receipts'),
  });

  if (error) return <ErrorBox error={error} />;

  const total = data.reduce((s, r) => s + r.amount, 0);
  const partPayments = data.filter((r) => !r.settledIt).length;

  return (
    <div>
      <PageHeader
        title="Receipts"
        subtitle="What has been received, instalment by instalment."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Receipts" value={data.length} />
        <Metric label="Received" value={money(total)} />
        <Metric
          label="Part payments"
          value={partPayments}
          sub="Receipts that left a balance behind"
          tone={partPayments > 0 ? 'warn' : 'good'}
        />
      </div>

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState
            message="Nothing received yet."
            hint="Take a payment against an invoice and its receipt appears here."
          />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Issued</th>
                <th>Customer</th>
                <th>Against</th>
                <th>Mode</th>
                <th className="text-right">Amount</th>
                <th className="text-right">Invoice total</th>
                <th className="text-right">Balance after</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <RecordCode code={r.recordCode} />
                  </td>
                  <td className="text-2xs text-ink-400">{dateTime(r.issuedAt)}</td>
                  <td className="text-xs text-ink-100">{r.customerName ?? '—'}</td>
                  <td className="mono text-2xs text-ink-400">{r.invoiceCode ?? 'fee instalment'}</td>
                  <td className="text-2xs text-ink-400">
                    {r.paymentMode ? (PAYMENT_MODE_LABELS[r.paymentMode as PaymentMode] ?? r.paymentMode) : '—'}
                    {r.paymentReference && <p className="mono text-ink-600">{r.paymentReference}</p>}
                  </td>
                  <td className="text-right tabular-nums text-xs">{money(r.amount)}</td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">{money(r.subjectTotal)}</td>
                  <td
                    className={`text-right tabular-nums text-xs ${
                      r.balanceAfter > 0 ? 'text-band-watch' : 'text-band-strong'
                    }`}
                  >
                    {money(r.balanceAfter)}
                  </td>
                  <td>
                    <Link className="btn-ghost" to={`/finance/receipts/${r.id}`}>
                      Open
                    </Link>
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
