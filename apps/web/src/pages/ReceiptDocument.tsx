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

import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PAYMENT_MODE_LABELS, type PaymentMode, type ReceiptDocumentView, type ReceiptView } from '@kaizen/shared';
import { api, date, dateTime, money } from '../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, Metric, PageHeader, RecordCode } from '../components/ui.js';
import { CustomerBlock, Sheet, Signature, SupplierBlock, rupees } from './documentSheet.js';

export function ReceiptDocument() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ['receipt-document', id],
    queryFn: () => api.get<ReceiptDocumentView>(`/finance/receipts/${id}/document`),
    enabled: Boolean(id),
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Loading label="Preparing the receipt" />;

  const d = data;
  const modeLabel = PAYMENT_MODE_LABELS[d.payment.mode as PaymentMode] ?? d.payment.mode;

  return (
    <Sheet
      backTo="/finance/receipts"
      backLabel="Receipts"
      title={d.recordCode}
      subtitle={`Instalment ${d.position.instalmentNumber} of ${d.position.instalmentsSoFar} against ${d.invoice.recordCode}, issued ${dateTime(
        d.issuedAt,
      )}${d.issuedBy ? ` by ${d.issuedBy}` : ''}.`}
      aside={
        <Card title="The invoice this is against" subtitle="A receipt is always against one invoice, named by its number.">
          <div className="flex flex-wrap items-center gap-6 text-xs">
            <Link to={`/finance/invoices/${d.invoice.id}/document`} className="mono text-ink-100 hover:text-accent-soft">
              {d.invoice.recordCode}
            </Link>
            <span className="text-ink-400">
              Issued <span className="ml-1 text-ink-200">{date(d.invoice.issuedDate)}</span>
            </span>
            <span className="text-ink-400">
              Due <span className="ml-1 text-ink-200">{date(d.invoice.dueDate)}</span>
            </span>
            <span className="text-ink-400">
              Total payable <span className="ml-1 tabular-nums text-ink-100">{money(d.position.totalPayable)}</span>
            </span>
            <span className={d.position.balanceAfter > 0 ? 'text-band-watch' : 'text-band-strong'}>
              Balance after this <span className="ml-1 tabular-nums">{money(d.position.balanceAfter)}</span>
            </span>
          </div>
        </Card>
      }
    >
      <SupplierBlock
        supplier={d.supplier}
        docType="Receipt"
        meta={[
          ['Receipt no.', d.recordCode],
          ['Date', dateTime(d.issuedAt)],
          ['Against invoice', d.invoice.recordCode],
          ['Instalment', `${d.position.instalmentNumber} of ${d.position.instalmentsSoFar}`],
        ]}
      />

      <CustomerBlock
        customer={d.customer}
        heading="Received from"
        extra={
          <>
            <p className="doc-label">Mode of payment</p>
            <p className="doc-party-name">{modeLabel}</p>
            {d.payment.reference && <p className="doc-muted">Reference {d.payment.reference}</p>}
            <p className="doc-muted">Payment {d.payment.paymentCode}</p>
          </>
        }
      />

      <section className="doc-foot" style={{ marginTop: 12 }}>
        <div>
          <div className="doc-declaration">
            <p className="doc-declaration-head">
              {d.position.isPartPayment ? 'Part payment received' : 'Payment received in full'}
            </p>
            <p>
              Received ₹{rupees(d.position.amountReceivedNow)} by {modeLabel}
              {d.payment.reference ? ` (${d.payment.reference})` : ''} against invoice {d.invoice.recordCode}, which is
              for ₹{rupees(d.position.totalPayable)}.
            </p>
            {d.position.isPartPayment ? (
              <p>
                ₹{rupees(d.position.receivedToDate)} has been received against this invoice in total, leaving ₹
                {rupees(d.position.balanceAfter)} still payable.
              </p>
            ) : (
              <p>This clears the invoice. Nothing further is due on it.</p>
            )}
            {d.payment.note && <p className="doc-muted">{d.payment.note}</p>}
          </div>

          {d.sequence.length > 1 && (
            <>
              <p className="doc-label" style={{ marginTop: 12 }}>
                Instalments against this invoice
              </p>
              <table className="doc-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Receipt</th>
                    <th>Date</th>
                    <th>Mode</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {d.sequence.map((r) => (
                    <tr key={r.recordCode} className={r.isThisOne ? 'doc-this-one' : undefined}>
                      <td>{r.number}</td>
                      <td>{r.recordCode}</td>
                      <td>{date(r.issuedAt)}</td>
                      <td>{r.mode ? (PAYMENT_MODE_LABELS[r.mode as PaymentMode] ?? r.mode) : '—'}</td>
                      <td className="num">{rupees(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        {/* The two figures, which on anything after the first instalment live here
            rather than on the invoice. */}
        <table className="doc-totals">
          <tbody>
            <tr className="doc-total-row">
              <th>Total payable</th>
              <td className="num">₹{rupees(d.position.totalPayable)}</td>
            </tr>
            <tr className="doc-now-row">
              <th>Amount received now</th>
              <td className="num">₹{rupees(d.position.amountReceivedNow)}</td>
            </tr>
            <tr>
              <th>Received to date</th>
              <td className="num">{rupees(d.position.receivedToDate)}</td>
            </tr>
            <tr>
              <th>Balance after this</th>
              <td className="num">{rupees(d.position.balanceAfter)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <footer className="doc-terms">
        <p className="doc-muted">
          Subject to realisation of the instrument where the payment was not in cash.
        </p>
        <Signature legalName={d.supplier.legalName} />
        {d.footnote && <p className="doc-muted">{d.footnote}</p>}
      </footer>
    </Sheet>
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
