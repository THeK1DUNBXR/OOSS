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
import { DocumentScreen, TwoCopyPrintPage, PrintPortal } from './documents/PrintSheet.js';
import { KaizenInvoiceDocument } from './kaizenInvoice/KaizenInvoiceDocument.js';

/**
 * A widened view of the tax invoice, for two fields another workstream is
 * adding to the printed sheet — the receipts issued against it and the
 * final invoice raised against it, restated on the tax invoice's own print
 * so a copy handed over later still shows what happened against it. Read
 * only with optional chaining: until that field lands server-side, both
 * blocks below simply render nothing.
 */
type InvoiceDocumentViewWithFinal = InvoiceDocumentView & {
  /** The standing final invoice, derived from `statements`: the latest one not superseded. */
  finalInvoice?: { recordCode: string; issuedAt: string } | null;
};

export function InvoiceDocument() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [printKey, setPrintKey] = useState<number | null>(null);

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

  // A course-sale invoice (raised with an enrollment date) prints as the
  // Kaizen course ledger, not this generic tax-invoice layout — same
  // underlying document, a different printed shape.
  if (data.ledger) return <KaizenInvoiceDocument doc={data} />;

  const standing = [...data.statements].filter((st) => st.status !== 'superseded').sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0];
  const d: InvoiceDocumentViewWithFinal = { ...data, finalInvoice: standing ? { recordCode: standing.recordCode, issuedAt: standing.issuedAt } : null };
  const paymentLabel = PAYMENT_TYPE_LABELS[d.payment.type as PaymentType] ?? d.payment.type;
  const modeLabel = d.payment.mode ? (PAYMENT_MODE_LABELS[d.payment.mode as PaymentMode] ?? d.payment.mode) : null;
  // A discount column is only worth the ink when at least one line actually
  // carries one — an invoice with none should not print a column of dashes.
  const hasDiscount = d.lines.some((l) => l.discountAmount > 0);
  const docType = d.invoiceType === 'bill_of_supply' ? 'Bill of Supply' : 'Tax Invoice';

  const company: LedgerCompany = {
    name: 'Kaizen Infinities',
    tagline: 'Training & Education Services',
    legalName: d.supplier.legalName,
    address: [d.supplier.addressLine1, d.supplier.addressLine2, d.supplier.city ? `${d.supplier.city}-${d.supplier.pincode ?? ''}` : null]
      .filter(Boolean)
      .join(', '),
    location: d.supplier.stateName ?? '—',
    stateCode: d.supplier.stateCode,
    gstin: d.supplier.gstin,
    phone: d.supplier.phone,
  };

  function handlePrint() {
    setPrintKey(Date.now());
    window.setTimeout(() => window.print(), 50);
  }

  const sheet = (
    <>
      {(d.status === 'draft' || d.status === 'void') && <Watermark text={d.status === 'draft' ? 'DRAFT' : 'VOID'} />}
      <LedgerHead company={company} />
      <InfoGrid>
        <InfoRow k="No." v={d.recordCode ?? 'not yet issued'} />
        <InfoRow k="Date" v={fmtDate(d.issuedDate)} />
        <InfoRow k="Student/Customer Name" v={d.customer.name} />
        <InfoRow k="Contact No." v={d.customer.phone ?? '—'} />
        <InfoRow k="From Tamil Nadu?" v={d.interState ? 'No' : 'Yes'} />
        <InfoRow
          k="Tax Basis"
          v={d.interState ? 'IGST @18% (inter-state)' : 'CGST + SGST (intra-state)'}
        />
      </InfoGrid>
      <DateBoxGrid columns={d.reverseCharge ? 3 : 2}>
        <DateBoxItem k="Due" v={fmtDate(d.dueDate)} />
        <DateBoxItem k="Place of supply" v={d.placeOfSupply ?? '—'} />
        {d.reverseCharge && <DateBoxItem k="Tax payable" v="Reverse charge (recipient)" />}
      </DateBoxGrid>

      <div className="ki-ledger-scroll">
        <table className="ki-ledger">
          <thead>
            <tr>
              <th>#</th>
              <th>Description</th>
              <th>HSN/SAC</th>
              <th>Qty</th>
              <th>Rate</th>
              {hasDiscount && (
                <>
                  <th>Course fee</th>
                  <th>Discount</th>
                </>
              )}
              <th>Amount</th>
              <th>GST %</th>
              <th>Tax</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((line, i) => (
              <tr key={line.id}>
                <td>{i + 1}</td>
                <td className="ki-name-cell">
                  {line.description}
                  {line.courseCode && !line.description.includes(line.courseCode) && ` · ${line.courseCode}`}
                </td>
                <td>{line.hsnSac ?? '—'}</td>
                <td>{line.quantity}</td>
                <td>{fmtINR(line.unitPrice)}</td>
                {hasDiscount && (
                  <>
                    <td>{fmtINR(line.grossAmount)}</td>
                    <td>{line.discountAmount > 0 ? `${fmtINR(line.discountAmount)} (${line.discountPercent}%)` : '—'}</td>
                  </>
                )}
                <td>{fmtINR(line.amount)}</td>
                <td>{line.gstRate}%</td>
                <td className="ki-total-cell">{fmtINR(line.taxAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {d.receipts?.length ? (
        <>
          <p style={{ padding: '10px 22px 0', fontSize: 12, fontWeight: 700 }}>Receipts issued against this invoice</p>
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
                  <tr key={r.id}>
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
        </>
      ) : null}

      {d.finalInvoice && (
        <p style={{ padding: '8px 22px 0', fontSize: 11, fontWeight: 700 }}>
          Final invoice: {d.finalInvoice.recordCode} dated {fmtDate(d.finalInvoice.issuedAt)}
        </p>
      )}

      <TotalsStrip doc={{ amountInWords: d.totals.inWords, grandTotal: d.totals.totalPayable, label: 'Total Payable' }} />

      <NoteStrip>
        {docType === 'Bill of Supply' ? 'Bill of supply — no tax is charged on this document. ' : ''}
        {d.payment.type === 'part' &&
          `${money(d.totals.amountPayableNow)} received on issue against a total of ${money(d.totals.totalPayable)}. Balance of ${money(
            d.totals.balanceAtIssue,
          )} payable by ${date(d.dueDate)}, receipted separately as each instalment is received. `}
        {d.payment.type === 'full' && 'Received in full on issue. Nothing further is due on this invoice. '}
        {d.payment.type === 'credit' && `Nothing collected on issue. ${money(d.totals.totalPayable)} payable by ${date(d.dueDate)}. `}
        {modeLabel && `Mode of payment: ${modeLabel}${d.payment.reference ? ` — ${d.payment.reference}` : ''}. `}
        This invoice is final. Payments received against it are acknowledged by separate numbered receipts.
        {d.notes && ` ${d.notes}`}
        {d.supplier.bank &&
          ` Payment details: ${[
            d.supplier.bank.accountName,
            d.supplier.bank.name,
            d.supplier.bank.branch,
            d.supplier.bank.accountNumber ? `A/c ${d.supplier.bank.accountNumber}` : null,
            d.supplier.bank.ifsc ? `IFSC ${d.supplier.bank.ifsc}` : null,
            d.supplier.bank.upiId ? `UPI ${d.supplier.bank.upiId}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}.`}
        {d.supplier.terms && ` ${d.supplier.terms}`}
        {d.supplier.footnote && ` ${d.supplier.footnote}`}
      </NoteStrip>
      <SignStrip />
    </>
  );

  return (
    <div>
      {error && (
        <p className="no-print mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
          {error}
        </p>
      )}
      <div className="no-print mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/finance/invoices" className="text-2xs text-ink-400 hover:text-accent-soft">
            ← Invoices
          </Link>
          <h1 className="font-display text-lg text-ink-50">{d.label}</h1>
          <p className="text-2xs text-ink-500">
            {d.status === 'draft'
              ? 'A draft. It gets its date and number when you issue it.'
              : `Issued ${date(d.issuedDate)}${d.raisedBy ? ` by ${d.raisedBy}` : ''}${
                  d.draftReference ? ` (drafted as ${d.draftReference})` : ''
                }. Final: what it says does not change.`}
          </p>
        </div>
        <button className="btn-primary" onClick={handlePrint}>
          Print or save as PDF
        </button>
      </div>

      <Card
        className="no-print mb-4"
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
            <p className="text-2xs text-ink-500">Nothing received yet.</p>
          )}
        </div>
      </Card>

      <DocumentScreen>{sheet}</DocumentScreen>

      {printKey && (
        <PrintPortal key={printKey}>
          <TwoCopyPrintPage render={() => sheet} />
        </PrintPortal>
      )}
    </div>
  );
}
