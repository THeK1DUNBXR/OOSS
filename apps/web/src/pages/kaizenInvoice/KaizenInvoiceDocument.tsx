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
import { KI_APP_CSS } from './style.js';
import { LedgerHead, InfoStrip, ScheduleStrip, LedgerTable, TotalsStrip, NoteStrip, SignStrip, type LedgerCompany, type LedgerInvoiceData } from './LedgerSheet.js';
import { PrintPortal } from './PrintPortal.js';

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

  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link to="/finance/invoices/history" className="btn-ghost">
          ← Invoice History
        </Link>
        <button className="btn-primary" onClick={handlePrint}>
          Print or save as PDF
        </button>
      </div>
      <style>{KI_APP_CSS}</style>
      <div className="ki-app">
        <main className="ki-main">
          <div className="ki-panel">
            <LedgerHead company={company} />
            <InfoStrip doc={ledgerDoc} />
            <ScheduleStrip doc={ledgerDoc} />
            <LedgerTable rows={ledgerDoc.rows} />
            <TotalsStrip doc={ledgerDoc} />
            <NoteStrip />
            <SignStrip />
          </div>
        </main>
      </div>

      {printKey && (
        <PrintPortal key={printKey}>
          <div className="ki-print-page">
            <div className="ki-print-half">
              <div className="ki-print-copy">
                <div style={{ textAlign: 'right', fontSize: 8, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--ki-navy)' }}>
                  CUSTOMER COPY
                </div>
                <LedgerHead company={company} />
                <InfoStrip doc={ledgerDoc} />
                <ScheduleStrip doc={ledgerDoc} />
                <LedgerTable rows={ledgerDoc.rows} />
                <TotalsStrip doc={ledgerDoc} />
                <NoteStrip />
                <SignStrip />
              </div>
            </div>
            <div className="ki-fold-line">✂ - - - - - - - - - - - - - - - - fold &amp; cut here - - - - - - - - - - - - - - - - ✂</div>
            <div className="ki-print-half">
              <div className="ki-print-copy">
                <div style={{ textAlign: 'right', fontSize: 8, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--ki-navy)' }}>
                  OFFICE COPY
                </div>
                <LedgerHead company={company} />
                <InfoStrip doc={ledgerDoc} />
                <ScheduleStrip doc={ledgerDoc} />
                <LedgerTable rows={ledgerDoc.rows} />
                <TotalsStrip doc={ledgerDoc} />
                <NoteStrip />
                <SignStrip />
              </div>
            </div>
          </div>
        </PrintPortal>
      )}
    </div>
  );
}
