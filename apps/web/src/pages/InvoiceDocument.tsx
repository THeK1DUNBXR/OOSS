/**
 * The tax invoice, as the customer gets it.
 *
 * Final. It is raised once, it states the whole obligation and what was handed
 * over on the day, and nothing that happens afterwards changes it — the copy in
 * the customer's file has to still read the same in three years, so a reprint
 * cannot silently show today's balance.
 *
 * Which is why the live position is above the sheet rather than on it. What has
 * been received since, the instalments and their receipt numbers, and the button
 * that raises the final invoice all sit in the app chrome, which does not print.
 * The sheet carries only what was true at issue.
 *
 * Every figure comes from the server. There is not one arithmetic operation in
 * this file, and that is the point: the copy the customer holds and the ledger
 * have to agree.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PAYMENT_MODE_LABELS,
  PAYMENT_TYPE_LABELS,
  type InvoiceDocumentView,
  type PaymentMode,
  type PaymentType,
} from '@kaizen/shared';
import { api, date, money } from '../lib/api.js';
import { Card, ErrorBox, Loading } from '../components/ui.js';
import { messageOf } from '../components/forms.js';
import { CustomerBlock, Sheet, Signature, SupplierBlock, rupees } from './documentSheet.js';

export function InvoiceDocument() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['invoice-document', id],
    queryFn: () => api.get<InvoiceDocumentView>(`/finance/invoices/${id}/document`),
    enabled: Boolean(id),
  });

  const raiseFinal = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/finance/invoices/${id}/final-invoice`, {}),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['invoice-document', id] });
      qc.invalidateQueries({ queryKey: ['final-invoices'] });
    },
    onError: (e) => setError(messageOf(e)),
  });

  if (loadError) return <ErrorBox error={loadError} />;
  if (isLoading || !data) return <Loading label="Preparing the invoice" />;

  const d = data;
  const paymentLabel = PAYMENT_TYPE_LABELS[d.payment.type as PaymentType] ?? d.payment.type;
  const modeLabel = d.payment.mode ? (PAYMENT_MODE_LABELS[d.payment.mode as PaymentMode] ?? d.payment.mode) : null;

  return (
    <Sheet
      backTo="/finance/invoices"
      backLabel="Invoices"
      title={d.label}
      subtitle={
        d.status === 'draft'
          ? 'A draft. It gets its date and number when you issue it.'
          : `Issued ${date(d.issuedDate)}${d.raisedBy ? ` by ${d.raisedBy}` : ''}${
              d.draftReference ? ` (drafted as ${d.draftReference})` : ''
            }. Final: what it says does not change.`
      }
      watermark={d.status === 'draft' ? 'DRAFT' : d.status === 'void' ? 'VOID' : null}
      aside={
        <>
          {error && (
            <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
              {error}
            </p>
          )}
          <Card
            title="Where this account stands today"
            subtitle="Deliberately not on the invoice. The invoice is final; this moves."
          >
            <div className="flex flex-wrap gap-6 text-xs">
              <span className="text-ink-400">
                Received <span className="ml-1 tabular-nums text-ink-100">{money(d.position.received)}</span>
              </span>
              {d.position.creditNoted > 0 && (
                <span className="text-ink-400">
                  Credit notes <span className="ml-1 tabular-nums text-ink-100">{money(d.position.creditNoted)}</span>
                </span>
              )}
              <span className={d.position.settled ? 'text-band-strong' : 'text-band-watch'}>
                Outstanding <span className="ml-1 tabular-nums">{money(d.position.outstanding)}</span>
              </span>
              <span className="text-ink-400">
                Instalments <span className="ml-1 tabular-nums text-ink-100">{d.position.instalments}</span>
              </span>
            </div>

            {d.receipts.length > 0 && (
              <table className="table mt-3">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Receipt</th>
                    <th>Issued</th>
                    <th>Mode</th>
                    <th className="text-right">Amount</th>
                    <th className="text-right">Balance after</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.receipts.map((r) => (
                    <tr key={r.id}>
                      <td className="text-2xs text-ink-500">{r.number}</td>
                      <td className="mono text-2xs">{r.recordCode}</td>
                      <td className="text-2xs text-ink-400">{date(r.issuedAt)}</td>
                      <td className="text-2xs text-ink-400">
                        {r.mode ? (PAYMENT_MODE_LABELS[r.mode as PaymentMode] ?? r.mode) : '—'}
                      </td>
                      <td className="text-right tabular-nums text-xs">{money(r.amount)}</td>
                      <td className="text-right tabular-nums text-2xs text-ink-400">{money(r.balanceAfter)}</td>
                      <td>
                        <Link className="btn-ghost" to={`/finance/receipts/${r.id}`}>
                          Open receipt
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {d.statements.length > 0 && (
              <div className="mt-3 border-t border-ink-800 pt-3">
                <p className="label mb-1">Final invoices raised</p>
                <ul className="space-y-1">
                  {d.statements.map((st) => (
                    <li key={st.id} className="flex flex-wrap items-center gap-3 text-2xs">
                      <Link to={`/finance/final-invoices/${st.id}`} className="mono text-ink-200 hover:text-accent-soft">
                        {st.recordCode}
                      </Link>
                      <span className="text-ink-500">{date(st.issuedAt)}</span>
                      <span className="text-ink-400">
                        {st.receiptCount} receipt{st.receiptCount === 1 ? '' : 's'} · received {money(st.totalReceived)} ·
                        balance {money(st.balance)}
                      </span>
                      {st.status === 'superseded' && <span className="chip border-ink-700 text-ink-500">superseded</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2 border-t border-ink-800 pt-3">
              {d.position.canRaiseFinalInvoice && (
                <button className="btn-primary" onClick={() => raiseFinal.mutate()} disabled={raiseFinal.isPending}>
                  {raiseFinal.isPending ? 'Raising…' : 'Raise a final invoice'}
                </button>
              )}
              {!d.position.canRaiseFinalInvoice && d.status !== 'draft' && (
                <p className="text-2xs text-ink-500">
                  Nothing received yet.
                </p>
              )}
            </div>
          </Card>
        </>
      }
    >
      <SupplierBlock
        supplier={d.supplier}
        docType="Tax Invoice"
        meta={[
          ['Invoice no.', d.recordCode ?? 'not yet issued'],
          ['Date', date(d.issuedDate)],
          ['Due', date(d.dueDate)],
          ['Place of supply', d.placeOfSupply ?? '—'],
        ]}
      />

      <CustomerBlock
        customer={d.customer}
        extra={
          <>
            <p className="doc-label">Supply</p>
            <p className="doc-muted">
              {d.interState
                ? 'Inter-state — integrated tax (IGST) applies.'
                : 'Intra-state — central and state tax (CGST + SGST) apply.'}
            </p>
            <p className="doc-muted">{d.customer.supplyType.toUpperCase()}</p>
            {d.division && <p className="doc-muted">Division: {d.division}</p>}
          </>
        }
      />

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
          {d.lines.map((line, i) => (
            <tr key={line.id}>
              <td>{i + 1}</td>
              <td>
                {line.description}
                {/* Only where the description does not already say it: a line
                    reading "Full Stack Development (FSD-24) — course fee" does
                    not want "· Full Stack Development" after it. */}
                {line.courseCode && !line.description.includes(line.courseCode) && (
                  <span className="doc-muted"> · {line.courseCode}</span>
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

      <section className="doc-foot">
        <div>
          <p className="doc-label">Total in words</p>
          <p className="doc-in-words">{d.totals.inWords}</p>

          {d.payment.isPartPayment && (
            <>
              <p className="doc-label" style={{ marginTop: 10 }}>
                Amount payable now, in words
              </p>
              <p className="doc-in-words">{d.totals.payableNowInWords}</p>
            </>
          )}

          {/* What the invoice said on the day. Fixed: an instalment arriving
              afterwards is a receipt, not an amendment to this. */}
          <div className="doc-declaration">
            <p className="doc-declaration-head">{paymentLabel}</p>
            {d.payment.type === 'part' && (
              <p>
                ₹{rupees(d.totals.amountPayableNow)} received on issue against a total of ₹
                {rupees(d.totals.totalPayable)}. Balance of ₹{rupees(d.totals.balanceAtIssue)} payable by{' '}
                {date(d.dueDate)}, receipted separately as each instalment is received.
              </p>
            )}
            {d.payment.type === 'full' && <p>Received in full on issue. Nothing further is due on this invoice.</p>}
            {d.payment.type === 'credit' && (
              <p>Nothing collected on issue. ₹{rupees(d.totals.totalPayable)} payable by {date(d.dueDate)}.</p>
            )}
            {modeLabel && (
              <p>
                <strong>Mode of payment:</strong> {modeLabel}
                {d.payment.reference ? ` — ${d.payment.reference}` : ''}
              </p>
            )}
            <p className="doc-muted">
              This invoice is final. Payments received against it are acknowledged by separate numbered receipts.
            </p>
          </div>
        </div>

        <table className="doc-totals">
          <tbody>
            <tr>
              <th>Taxable value</th>
              <td className="num">{rupees(d.tax.taxableValue)}</td>
            </tr>
            {d.interState ? (
              <tr>
                <th>IGST</th>
                <td className="num">{rupees(d.tax.igst)}</td>
              </tr>
            ) : (
              <>
                <tr>
                  <th>CGST</th>
                  <td className="num">{rupees(d.tax.cgst)}</td>
                </tr>
                <tr>
                  <th>SGST</th>
                  <td className="num">{rupees(d.tax.sgst)}</td>
                </tr>
              </>
            )}
            {d.tax.roundOff !== 0 && (
              <tr>
                <th>Rounding</th>
                <td className="num">{rupees(d.tax.roundOff)}</td>
              </tr>
            )}
            {/* Both figures, always. On a full payment they are the same number
                and it is still printed twice, because a customer should not have
                to work out which of the two they are looking at. */}
            <tr className="doc-total-row">
              <th>Total payable</th>
              <td className="num">₹{rupees(d.totals.totalPayable)}</td>
            </tr>
            <tr className="doc-now-row">
              <th>Amount payable now</th>
              <td className="num">₹{rupees(d.totals.amountPayableNow)}</td>
            </tr>
            {d.totals.balanceAtIssue > 0 && (
              <tr>
                <th>Balance at issue</th>
                <td className="num">{rupees(d.totals.balanceAtIssue)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {d.notes && (
        <section className="doc-section">
          <p className="doc-label">Notes</p>
          <p>{d.notes}</p>
        </section>
      )}

      {d.supplier.bank && (
        <section className="doc-section">
          <p className="doc-label">Payment details</p>
          <p>
            {[
              d.supplier.bank.accountName,
              d.supplier.bank.name,
              d.supplier.bank.branch,
              d.supplier.bank.accountNumber ? `A/c ${d.supplier.bank.accountNumber}` : null,
              d.supplier.bank.ifsc ? `IFSC ${d.supplier.bank.ifsc}` : null,
              d.supplier.bank.upiId ? `UPI ${d.supplier.bank.upiId}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </section>
      )}

      <footer className="doc-terms">
        {d.supplier.terms && <p>{d.supplier.terms}</p>}
        <Signature legalName={d.supplier.legalName} />
        {d.supplier.footnote && <p className="doc-muted">{d.supplier.footnote}</p>}
      </footer>
    </Sheet>
  );
}
