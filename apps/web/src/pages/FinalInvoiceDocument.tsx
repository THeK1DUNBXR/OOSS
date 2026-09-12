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

import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  PAYMENT_MODE_LABELS,
  type FinalInvoiceDocumentView,
  type FinalInvoiceView,
  type PaymentMode,
} from '@kaizen/shared';
import { api, date, dateTime, money } from '../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, Metric, PageHeader, RecordCode, StatusChip } from '../components/ui.js';
import { CustomerBlock, Sheet, Signature, SupplierBlock, rupees } from './documentSheet.js';

export function FinalInvoiceDocument() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ['final-invoice-document', id],
    queryFn: () => api.get<FinalInvoiceDocumentView>(`/finance/final-invoices/${id}/document`),
    enabled: Boolean(id),
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Loading label="Preparing the statement" />;

  const d = data;

  return (
    <Sheet
      backTo="/finance/final-invoices"
      backLabel="Final invoices"
      title={d.recordCode}
      subtitle={`Raised ${dateTime(d.issuedAt)}${d.issuedBy ? ` by ${d.issuedBy}` : ''} against ${d.invoice.recordCode}, consolidating ${
        d.totals.instalments
      } receipt${d.totals.instalments === 1 ? '' : 's'}.`}
      watermark={d.status === 'superseded' ? 'SUPERSEDED' : null}
      aside={
        <Card
          title="The documents behind this"
          subtitle="The tax invoice it finalises, and every receipt it names."
        >
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <Link to={`/finance/invoices/${d.invoice.id}/document`} className="mono text-ink-100 hover:text-accent-soft">
              {d.invoice.recordCode}
            </Link>
            {d.receipts.map((r) => (
              <span key={r.recordCode} className="mono text-2xs text-ink-400">
                {r.recordCode}
              </span>
            ))}
          </div>
          {d.supersedes.length > 0 && (
            <p className="mt-2 text-2xs text-ink-500">
              Supersedes {d.supersedes.join(', ')}. Earlier statements are kept rather than replaced — each was true when
              it was handed over.
            </p>
          )}
        </Card>
      }
    >
      <SupplierBlock
        supplier={d.supplier}
        docType="Final Invoice"
        meta={[
          ['Statement no.', d.recordCode],
          ['Date', date(d.issuedAt)],
          ['Tax invoice', d.invoice.recordCode],
          ['Invoice date', date(d.invoice.issuedDate)],
        ]}
      />

      <CustomerBlock
        customer={d.customer}
        extra={
          <>
            <p className="doc-label">Status</p>
            <p className="doc-party-name">{d.totals.settled ? 'Settled in full' : 'Balance outstanding'}</p>
            <p className="doc-muted">
              {d.totals.instalments} instalment{d.totals.instalments === 1 ? '' : 's'} received
            </p>
            {d.invoice.placeOfSupply && <p className="doc-muted">Place of supply: {d.invoice.placeOfSupply}</p>}
          </>
        }
      />

      {/* What was billed. Restated from the invoice so the statement stands on its
          own — a customer holding this should not need the invoice beside it. */}
      <p className="doc-label" style={{ marginTop: 12 }}>
        What was billed — tax invoice {d.invoice.recordCode}
      </p>
      <table className="doc-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            <th>HSN/SAC</th>
            <th className="num">Qty</th>
            <th className="num">Rate</th>
            <th className="num">Amount</th>
            <th className="num">GST %</th>
            <th className="num">Tax</th>
          </tr>
        </thead>
        <tbody>
          {d.invoice.lines.map((line, i) => (
            <tr key={`${line.description}-${i}`}>
              <td>{i + 1}</td>
              <td>
                {line.description}
                {line.courseName && !line.description.includes(line.courseName) && (
                  <span className="doc-muted"> · {line.courseName}</span>
                )}
              </td>
              <td>{line.hsnSac ?? '—'}</td>
              <td className="num">{line.quantity}</td>
              <td className="num">{rupees(line.unitPrice)}</td>
              <td className="num">{rupees(line.amount)}</td>
              <td className="num">{line.gstRate}%</td>
              <td className="num">{rupees(line.taxAmount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* The part payments, with their receipt numbers. The reason the document
          exists. */}
      <p className="doc-label">Payments received</p>
      <table className="doc-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Receipt no.</th>
            <th>Date</th>
            <th>Mode</th>
            <th>Reference</th>
            <th className="num">Amount</th>
            <th className="num">Balance after</th>
          </tr>
        </thead>
        <tbody>
          {d.receipts.map((r) => (
            <tr key={r.recordCode}>
              <td>{r.number}</td>
              <td>{r.recordCode}</td>
              <td>{date(r.issuedAt)}</td>
              <td>{r.mode ? (PAYMENT_MODE_LABELS[r.mode as PaymentMode] ?? r.mode) : '—'}</td>
              <td>{r.reference ?? '—'}</td>
              <td className="num">{rupees(r.amount)}</td>
              <td className="num">{rupees(r.balanceAfter)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="doc-foot">
        <div>
          <div className="doc-declaration">
            <p className="doc-declaration-head">
              {d.totals.settled ? 'Settled in full' : 'Balance outstanding'}
            </p>
            <p>
              Tax invoice {d.invoice.recordCode} for ₹{rupees(d.totals.totalPayable)} has been paid in{' '}
              {d.totals.instalments} instalment{d.totals.instalments === 1 ? '' : 's'} totalling ₹
              {rupees(d.totals.totalReceived)}, receipted as {d.receipts.map((r) => r.recordCode).join(', ')}.
            </p>
            {d.totals.creditNoted > 0 && (
              <p>Credit notes of ₹{rupees(d.totals.creditNoted)} have been applied against it.</p>
            )}
            {d.totals.settled ? (
              <p>Nothing further is due.</p>
            ) : (
              <p>
                ₹{rupees(d.totals.balance)} remains payable
                {d.invoice.dueDate ? ` by ${date(d.invoice.dueDate)}` : ''}.
              </p>
            )}
            {d.note && <p className="doc-muted">{d.note}</p>}
          </div>
        </div>

        <table className="doc-totals">
          <tbody>
            <tr>
              <th>Taxable value</th>
              <td className="num">{rupees(d.invoice.taxableValue)}</td>
            </tr>
            {d.invoice.interState ? (
              <tr>
                <th>IGST</th>
                <td className="num">{rupees(d.invoice.igst)}</td>
              </tr>
            ) : (
              <>
                <tr>
                  <th>CGST</th>
                  <td className="num">{rupees(d.invoice.cgst)}</td>
                </tr>
                <tr>
                  <th>SGST</th>
                  <td className="num">{rupees(d.invoice.sgst)}</td>
                </tr>
              </>
            )}
            {d.invoice.roundOff !== 0 && (
              <tr>
                <th>Rounding</th>
                <td className="num">{rupees(d.invoice.roundOff)}</td>
              </tr>
            )}
            <tr className="doc-total-row">
              <th>Total payable</th>
              <td className="num">₹{rupees(d.totals.totalPayable)}</td>
            </tr>
            <tr className="doc-now-row">
              <th>Total received</th>
              <td className="num">₹{rupees(d.totals.totalReceived)}</td>
            </tr>
            {d.totals.creditNoted > 0 && (
              <tr>
                <th>Credit notes</th>
                <td className="num">{rupees(d.totals.creditNoted)}</td>
              </tr>
            )}
            <tr>
              <th>Balance</th>
              <td className="num">{rupees(d.totals.balance)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <footer className="doc-terms">
        {d.supplier.terms && <p>{d.supplier.terms}</p>}
        <Signature legalName={d.supplier.legalName} />
        {d.supplier.footnote && <p className="doc-muted">{d.supplier.footnote}</p>}
      </footer>
    </Sheet>
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
