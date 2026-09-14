/**
 * Reprinting a course-sale invoice — the same ledger layout `NewInvoice`
 * prints fresh, rebuilt from the saved, server-authoritative document
 * (`GET /finance/invoices/:id/document`) rather than recomputed. `InvoiceDocument`
 * renders this instead of the generic tax-invoice layout whenever a document
 * carries a `ledger` block, i.e. it was raised with an enrollment date.
 */
import { useState } from 'react';
import type { InvoiceDocumentView } from '@kaizen/shared';
import { LedgerHead, InfoStrip, ScheduleStrip, LedgerTable, TotalsStrip, NoteStrip, SignStrip, type LedgerCompany, type LedgerInvoiceData } from './LedgerSheet.js';
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
      <LedgerHead company={company} />
      <InfoStrip doc={ledgerDoc} />
      <ScheduleStrip doc={ledgerDoc} />
      <LedgerTable rows={ledgerDoc.rows} />
      <TotalsStrip doc={ledgerDoc} />
      <NoteStrip />
      <SignStrip />
    </>
  );

  return (
    <div>
      <DocumentToolbar backTo="/finance/invoices/history" backLabel="Invoice History" onPrint={handlePrint} />
      <DocumentScreen>{sheet}</DocumentScreen>

      {printKey && (
        <PrintPortal key={printKey}>
          <TwoCopyPrintPage render={() => sheet} />
        </PrintPortal>
      )}
    </div>
  );
}
