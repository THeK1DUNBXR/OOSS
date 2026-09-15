/**
 * Reprinting a course-sale invoice — the same ledger layout `NewInvoice`
 * prints fresh, rebuilt from the saved, server-authoritative document
 * (`GET /finance/invoices/:id/document`) rather than recomputed. `InvoiceDocument`
 * renders this instead of the generic tax-invoice layout whenever a document
 * carries a `ledger` block, i.e. it was raised with an enrollment date.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { InvoiceDocumentView } from '@kaizen/shared';
import { money } from '../../lib/api.js';
import {
  LedgerHead,
  InfoStrip,
  ScheduleStrip,
  LedgerTable,
  TotalsStrip,
  NoteStrip,
  SignStrip,
  Watermark,
  type LedgerCompany,
  type LedgerInvoiceData,
} from './LedgerSheet.js';
import { DocumentToolbar, DocumentScreen, TwoCopyPrintPage, PrintPortal } from '../documents/PrintSheet.js';

export function KaizenInvoiceDocument({ doc }: { doc: InvoiceDocumentView }) {
  const [printKey, setPrintKey] = useState<number | null>(null);

  const company: LedgerCompany = {
    name: 'Kaizen Infinities',
    tagline: 'Training & Education Services',
    legalName: doc.supplier.legalName,
    address: [doc.supplier.addressLine1, doc.supplier.addressLine2, doc.supplier.city ? `${doc.supplier.city}-${doc.supplier.pincode ?? ''}` : null]
      .filter(Boolean)
      .join(', '),
    location: doc.supplier.stateName ?? '—',
    stateCode: doc.supplier.stateCode,
    gstin: doc.supplier.gstin,
    phone: doc.supplier.phone,
  };

  const ledgerDoc: LedgerInvoiceData = {
    invoiceNo: doc.recordCode ?? doc.label,
    invoiceDate: doc.issuedDate,
    studentName: doc.customer.name,
    contactNo: doc.customer.phone ?? '—',
    fromTNYes: !doc.interState,
    enrollmentDate: doc.enrollmentDate,
    schedule: doc.ledger?.schedule ?? null,
    rows: doc.ledger?.rows ?? [],
    grandTotal: doc.totals.totalPayable,
    amountInWords: doc.totals.inWords,
  };

  function handlePrint() {
    setPrintKey(Date.now());
    window.setTimeout(() => window.print(), 50);
  }

  const sheet = (
    <>
      {doc.isTempInvoice && <Watermark text="INTERNAL — NOT A TAX INVOICE" />}
      <LedgerHead company={company} />
      <InfoStrip doc={ledgerDoc} />
      <ScheduleStrip doc={ledgerDoc} />
      <LedgerTable rows={ledgerDoc.rows} />
      <TotalsStrip doc={ledgerDoc} />
      <NoteStrip>
        {doc.isTempInvoice && (
          <>
            This is an internal working record, not a tax invoice — it is never issued to the student. Each
            instalment is acknowledged by its own receipt voucher. The tax invoice for this course is raised
            automatically once the fees are paid in full or the student withdraws.{' '}
          </>
        )}
        Note: GST rate is a placeholder — confirm the applicable rate/exemption for your course category. The
        &quot;Student is from Tamil Nadu?&quot; field controls the tax split: Yes charges CGST @9% + SGST @9% (18%
        total, intra-state); No charges IGST @18% instead (inter-state) — whichever doesn&apos;t apply shows as
        Rs.0.00 rather than being hidden, so the calculation stays auditable either way. SAC code is common across
        all courses (9983) — confirm with your accountant. Monthly Fee and Discount % are editable per student
        since pricing is flexible/negotiable; Discount % is set once and applies to the course and its add-ons.
        Add-ons are priced as a fixed total, split evenly across the tenure chosen. Payment schedule: first payment
        due within 3 days of enrollment; subsequent payments fall on the 1st of every month after — pushed to the
        1st of the month after that if fewer than 14 days separate the first payment from the next 1st. Fees once
        paid are non-refundable and non-transferable unless stated otherwise in the admission agreement.
      </NoteStrip>
      <SignStrip />
    </>
  );

  return (
    <div>
      <DocumentToolbar backTo="/finance/invoices/history" backLabel="Invoice History" onPrint={handlePrint} />

      {doc.isTempInvoice && (
        <div className="no-print mb-4 flex flex-wrap items-center gap-4 rounded border-l-2 border-band-watch bg-band-watch/10 px-3 py-2 text-xs">
          <span className="font-medium text-band-watch">Internal working invoice — not a tax document.</span>
          <span className="text-ink-400">
            Received <span className="tabular-nums text-ink-100">{money(doc.position.received)}</span> · Outstanding{' '}
            <span className="tabular-nums text-ink-100">{money(doc.position.outstanding)}</span> · {doc.position.instalments}{' '}
            receipt{doc.position.instalments === 1 ? '' : 's'}
          </span>
          {doc.statements.length > 0 ? (
            <Link className="btn-ghost" to={`/finance/final-invoices/${doc.statements[0]!.id}`}>
              Open the tax invoice
            </Link>
          ) : (
            <span className="text-ink-500">{doc.position.finalizeCourseFeeInvoiceNote}</span>
          )}
        </div>
      )}

      <DocumentScreen>{sheet}</DocumentScreen>

      {printKey && (
        <PrintPortal key={printKey}>
          <TwoCopyPrintPage render={() => sheet} />
        </PrintPortal>
      )}
    </div>
  );
}
