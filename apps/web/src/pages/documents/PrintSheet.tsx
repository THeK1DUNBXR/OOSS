/**
 * The screen chrome and print-page scaffolding shared by every printed
 * document — the tax invoice, the receipt, and the final invoice — so all
 * three sit inside the same `.ki-app` preview and print as the same
 * CUSTOMER COPY / OFFICE COPY pair on one A4 sheet with a fold-and-cut line,
 * the way the course-invoice ledger already does (`KaizenInvoiceDocument`).
 *
 * Kept here rather than duplicated per document: a receipt whose print
 * scaffolding drifts from the invoice's reads as though it came from a
 * different product.
 */
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { KI_APP_CSS } from '../kaizenInvoice/style.js';
import { PrintPortal } from '../kaizenInvoice/PrintPortal.js';

/** The back-link + print button above the on-screen preview. Never printed. */
export function DocumentToolbar({ backTo, backLabel, onPrint }: { backTo: string; backLabel: string; onPrint: () => void }) {
  return (
    <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
      <Link to={backTo} className="btn-ghost">
        ← {backLabel}
      </Link>
      <button className="btn-primary" onClick={onPrint}>
        Print or save as PDF
      </button>
    </div>
  );
}

/** The on-screen live preview: the ledger visual language, one panel, no copies. */
export function DocumentScreen({ children }: { children: ReactNode }) {
  return (
    <>
      <style>{KI_APP_CSS}</style>
      <div className="ki-app">
        <main className="ki-main">
          <div className="ki-panel">{children}</div>
        </main>
      </div>
    </>
  );
}

export function CopyLabel({ label }: { label: 'CUSTOMER COPY' | 'OFFICE COPY' }) {
  return (
    <div style={{ textAlign: 'right', fontSize: 8, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--ki-navy)' }}>
      {label}
    </div>
  );
}

/**
 * The printed A4 page: the same sheet content rendered twice — once as the
 * customer's copy, once as the office's — separated by the dashed
 * fold-and-cut line, exactly as the reference tool prints it.
 */
export function TwoCopyPrintPage({ render }: { render: (copy: 'CUSTOMER COPY' | 'OFFICE COPY') => ReactNode }) {
  return (
    <div className="ki-print-page">
      <div className="ki-print-half">
        <div className="ki-print-copy">
          <CopyLabel label="CUSTOMER COPY" />
          {render('CUSTOMER COPY')}
        </div>
      </div>
      <div className="ki-fold-line">✂ - - - - - - - - - - - - - - - - fold &amp; cut here - - - - - - - - - - - - - - - - ✂</div>
      <div className="ki-print-half">
        <div className="ki-print-copy">
          <CopyLabel label="OFFICE COPY" />
          {render('OFFICE COPY')}
        </div>
      </div>
    </div>
  );
}

export { PrintPortal };
