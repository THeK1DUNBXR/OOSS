/**
 * The look of a document somebody is handed.
 *
 * Three surfaces print — the tax invoice, a receipt, and the final invoice — and
 * they are the only things in this product that are not the product. Everything
 * else is ink-on-dark with borders carrying the hierarchy; a document is white,
 * it goes on somebody's printer, and a dark invoice is a page nobody can hand
 * over.
 *
 * The stylesheet is here rather than copied into each page because three copies
 * of it would drift, and a receipt that does not look like the invoice it belongs
 * to reads as though it came from somewhere else.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** Two decimals, always. A document that rounds its own lines is not a document. */
export function rupees(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function Sheet({
  /** The app chrome above the sheet, which is never printed. */
  backTo,
  backLabel,
  title,
  subtitle,
  aside,
  watermark,
  children,
}: {
  backTo: string;
  backLabel: string;
  title: string;
  subtitle?: ReactNode;
  /** Live state and links — deliberately outside the sheet, because it moves. */
  aside?: ReactNode;
  watermark?: string | null;
  children: ReactNode;
}) {
  return (
    <div>
      <style>{DOCUMENT_CSS}</style>

      <div className="no-print mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to={backTo} className="text-2xs text-ink-400 hover:text-accent-soft">
            ← {backLabel}
          </Link>
          <h1 className="font-display text-lg text-ink-50">{title}</h1>
          {subtitle && <p className="text-2xs text-ink-500">{subtitle}</p>}
        </div>
        <button className="btn-primary" onClick={() => window.print()}>
          Print or save as PDF
        </button>
      </div>

      {aside && <div className="no-print mb-4">{aside}</div>}

      <article className="doc-sheet">
        {watermark && <div className="doc-watermark">{watermark}</div>}
        {children}
      </article>
    </div>
  );
}

/** The supplier block every document opens with. */
export function SupplierBlock({
  supplier,
  docType,
  meta,
}: {
  supplier: {
    legalName: string;
    tradeName?: string | null;
    gstin: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    pincode: string | null;
    phone: string | null;
    email: string | null;
  };
  docType: string;
  meta: Array<[string, ReactNode]>;
}) {
  return (
    <header className="doc-head">
      <div>
        <h2 className="doc-supplier">{supplier.legalName}</h2>
        {supplier.tradeName && supplier.tradeName !== supplier.legalName && (
          <p className="doc-muted">trading as {supplier.tradeName}</p>
        )}
        <p className="doc-muted">
          {[supplier.addressLine1, supplier.addressLine2, supplier.city, supplier.pincode].filter(Boolean).join(', ') ||
            'Address not on file'}
        </p>
        <p className="doc-muted">{[supplier.phone, supplier.email].filter(Boolean).join(' · ')}</p>
        <p className="doc-ids">
          {supplier.gstin ? (
            <>
              <strong>GSTIN</strong> {supplier.gstin}
            </>
          ) : (
            <span className="doc-flag">No GSTIN on file — set the company registration before issuing this.</span>
          )}
        </p>
      </div>
      <div className="doc-title">
        <p className="doc-doctype">{docType}</p>
        <table className="doc-meta">
          <tbody>
            {meta.map(([label, value]) => (
              <tr key={label}>
                <th>{label}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </header>
  );
}

export function CustomerBlock({
  customer,
  heading = 'Billed to',
  extra,
}: {
  customer: {
    name: string;
    /** Which of the three this is: a student, an institution, an organisation. */
    kindLabel?: string | null;
    /** A learner's own registration number, which both sides quote. */
    registrationNumber?: string | null;
    gstin: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  heading?: string;
  extra?: ReactNode;
}) {
  return (
    <section className="doc-parties">
      <div>
        {/* What is being billed, not only who. "Student" over a name and
            "Institution" over a college's are different documents to anybody
            filing them. */}
        <p className="doc-label">
          {heading}
          {customer.kindLabel ? ` · ${customer.kindLabel}` : ''}
        </p>
        <p className="doc-party-name">{customer.name}</p>
        {customer.registrationNumber && <p className="doc-muted">Registration {customer.registrationNumber}</p>}
        {customer.address && <p className="doc-muted">{customer.address}</p>}
        <p className="doc-muted">{[customer.phone, customer.email].filter(Boolean).join(' · ')}</p>
        <p className="doc-ids">{customer.gstin ? <><strong>GSTIN</strong> {customer.gstin}</> : 'Unregistered customer'}</p>
      </div>
      <div>{extra}</div>
    </section>
  );
}

export function Signature({ legalName }: { legalName: string }) {
  return (
    <div className="doc-signature">
      <p className="doc-muted">For {legalName}</p>
      <p className="doc-sign-line">Authorised signatory</p>
    </div>
  );
}

export const DOCUMENT_CSS = `
.doc-sheet {
  position: relative;
  max-width: 210mm;
  margin: 0 auto;
  padding: 14mm;
  background: #fff;
  color: #17171a;
  font-size: 11px;
  line-height: 1.45;
  border: 1px solid #d8d8de;
  border-radius: 4px;
}
.doc-watermark {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 96px; font-weight: 800; letter-spacing: 0.1em; color: rgba(23,23,26,0.07);
  pointer-events: none; text-transform: uppercase;
}
.doc-head { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #17171a; padding-bottom: 10px; }
.doc-supplier { font-size: 17px; font-weight: 800; letter-spacing: -0.01em; margin: 0; }
.doc-muted { color: #5b5b66; margin: 1px 0; }
.doc-ids { margin-top: 4px; }
.doc-ids strong { font-weight: 700; }
.doc-flag { color: #a4361e; font-weight: 600; }
.doc-title { text-align: right; min-width: 46%; }
.doc-doctype { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; margin: 0 0 4px; }
.doc-meta { margin-left: auto; border-collapse: collapse; }
.doc-meta th { text-align: left; padding: 1px 10px 1px 0; color: #5b5b66; font-weight: 500; }
.doc-meta td { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.doc-parties { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; padding: 10px 0; border-bottom: 1px solid #d8d8de; }
.doc-label { text-transform: uppercase; letter-spacing: 0.1em; font-size: 9px; font-weight: 700; color: #5b5b66; margin: 0 0 2px; }
.doc-party-name { font-size: 13px; font-weight: 700; margin: 0; }
.doc-table { width: 100%; border-collapse: collapse; margin: 12px 0; }
.doc-table th { text-align: left; border-bottom: 1px solid #17171a; padding: 5px 6px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; }
.doc-table td { padding: 5px 6px; border-bottom: 1px solid #ececf0; vertical-align: top; }
.doc-table tr.doc-this-one td { background: #f4f4f7; font-weight: 700; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.doc-foot { display: grid; grid-template-columns: 1.25fr 1fr; gap: 18px; }
.doc-in-words { font-weight: 600; margin: 0; }
.doc-declaration { margin-top: 10px; border: 1px solid #17171a; border-left-width: 3px; padding: 7px 9px; }
.doc-declaration-head { font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 3px; font-size: 10px; }
.doc-declaration p { margin: 2px 0; }
.doc-totals { width: 100%; border-collapse: collapse; }
.doc-totals th { text-align: left; font-weight: 500; color: #3a3a43; padding: 3px 6px; }
.doc-totals td { padding: 3px 6px; }
.doc-totals .doc-total-row th, .doc-totals .doc-total-row td {
  border-top: 1px solid #17171a; font-weight: 800; font-size: 13px; padding-top: 6px;
}
.doc-totals .doc-now-row th, .doc-totals .doc-now-row td {
  background: #17171a; color: #fff; font-weight: 800; font-size: 13px;
}
.doc-section { margin-top: 12px; padding-top: 8px; border-top: 1px solid #d8d8de; }
.doc-section p { margin: 2px 0; }
.doc-terms { margin-top: 14px; padding-top: 8px; border-top: 1px solid #d8d8de; display: grid; gap: 6px; }
.doc-signature { margin-top: 18px; text-align: right; }
.doc-sign-line { border-top: 1px solid #17171a; display: inline-block; padding-top: 3px; margin: 22px 0 0; min-width: 52mm; }
@media print {
  /* .glass catches the portal masthead too — the certificate sheet is the
     one document this shell prints, and its chrome hides the same way the
     ERP sidebar does. */
  .no-print, .sidebar, header.topbar, .glass { display: none !important; }
  body { background: #fff !important; }
  .doc-sheet { border: 0; margin: 0; padding: 0; max-width: none; }
  @page { size: A4; margin: 12mm; }
}
`;
