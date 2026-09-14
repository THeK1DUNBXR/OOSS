/**
 * The printed course-invoice ledger — one course (plus its add-ons) on one
 * document. Pure presentation: every figure it renders is already computed,
 * either by the server's `ledger` block (a saved/reprinted invoice) or by
 * `calc.ts`'s preview math (a batch not yet saved) — this component does no
 * arithmetic of its own, the same discipline the rest of the app's document
 * views hold to.
 *
 * Used, unchanged, on screen inside `.ki-app` (the live preview) and inside
 * the print portal under `#ki-print-root` (customer copy + office copy) —
 * the two contexts share every class name in `style.ts`, scoped differently
 * per root, so the markup itself never has to know which one it is in.
 */
import type { ReactNode } from 'react';
import { fmtINR, fmtDate } from './calc.js';

export interface LedgerRowData {
  hsnSac: string | null;
  courseName: string | null;
  addonName: string | null;
  monthlyFee: number;
  tenureMonths: number;
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  effectiveMonthly: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  isCourseRow: boolean;
}

export interface LedgerCompany {
  name: string;
  tagline: string;
  legalName: string;
  address: string;
  location: string;
  stateCode: string | null;
  gstin: string | null;
  phone: string | null;
}

export interface LedgerInvoiceData {
  invoiceNo: string;
  invoiceDate: string | null;
  studentName: string;
  contactNo: string;
  fromTNYes: boolean;
  enrollmentDate: string | null;
  schedule: { firstPaymentDue: string; subsequentFrom: string } | null;
  rows: LedgerRowData[];
  grandTotal: number;
  amountInWords: string;
  label?: string;
}

export function LedgerHead({ company }: { company: LedgerCompany }) {
  return (
    <div className="ki-ledger-head">
      <img src="/kaizen-logo.png" alt="" />
      <div className="ki-co">
        <h2>{company.name}</h2>
        <div className="ki-sub">{company.tagline}</div>
      </div>
      <div className="ki-meta">
        <div className="ki-addr">
          <b>{company.legalName}</b>
        </div>
        <div className="ki-addr">{company.address}</div>
        <div>
          Location: {company.location} | State Code: {company.stateCode ?? '—'} | Ph: {company.phone ?? '—'}
        </div>
        <div>GST No: {company.gstin ?? '—'}</div>
      </div>
    </div>
  );
}

export function InfoStrip({ doc }: { doc: LedgerInvoiceData }) {
  const taxBasis = doc.fromTNYes
    ? 'Yes — CGST @9% + SGST @9% (intra-state)'
    : 'No — IGST @18% (inter-state)';
  return (
    <InfoGrid>
      <InfoRow k="Invoice No." v={doc.invoiceNo} />
      <InfoRow k="Date" v={doc.invoiceDate ? fmtDate(doc.invoiceDate) : '—'} />
      <InfoRow k="Student Name" v={doc.studentName} />
      <InfoRow k="Contact No." v={doc.contactNo} />
      <InfoRow k="From Tamil Nadu?" v={doc.fromTNYes ? 'Yes' : 'No'} />
      <InfoRow k="Tax Basis" v={taxBasis} />
    </InfoGrid>
  );
}

/**
 * The dotted-leader header row (label left, bold value right) and the grid
 * that lays six of them out two-per-row — shared by every printed document,
 * not only the course ledger, so a receipt's "Receipt No. / Date" row looks
 * exactly like the invoice's "Invoice No. / Date" row above it.
 */
export function InfoGrid({ children }: { children: ReactNode }) {
  return <div className="ki-info-strip">{children}</div>;
}

export function InfoRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="ki-row">
      <span className="ki-k">{k}</span>
      <span className="ki-v">{v}</span>
    </div>
  );
}

export function ScheduleStrip({ doc }: { doc: LedgerInvoiceData }) {
  return (
    <DateBoxGrid columns={4}>
      <DateBoxItem k="Enrollment Date" v={doc.enrollmentDate ? fmtDate(doc.enrollmentDate) : '—'} />
      <DateBoxItem k="First Payment Due (within 3 days)" v={doc.schedule ? fmtDate(doc.schedule.firstPaymentDue) : '—'} />
      <DateBoxItem k="Subsequent Payments From" v={doc.schedule ? fmtDate(doc.schedule.subsequentFrom) : '—'} />
      <DateBoxItem k="Then due on" v="1st of every month" bold={false} />
    </DateBoxGrid>
  );
}

/**
 * The boxed date/figure strip — a row of bordered pills, four to the row on
 * the course invoice's enrollment schedule and however many a receipt or
 * final invoice needs for its own "Balance before / after" or totals strip.
 */
export function DateBoxGrid({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <div className="ki-schedule-strip" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {children}
    </div>
  );
}

export function DateBoxItem({ k, v, bold = true }: { k: string; v: ReactNode; bold?: boolean }) {
  return (
    <div className="ki-item">
      <div className="ki-k">{k}</div>
      <div className="ki-v" style={bold ? undefined : { fontWeight: 500 }}>
        {v}
      </div>
    </div>
  );
}

export function LedgerTable({ rows }: { rows: LedgerRowData[] }) {
  return (
    <div className="ki-ledger-scroll">
      <table className="ki-ledger">
        <thead>
          <tr>
            <th>SAC</th>
            <th>Course</th>
            <th>Add-on</th>
            <th>Monthly Fee</th>
            <th>Tenure</th>
            <th>Subtotal</th>
            <th>Disc %</th>
            <th>Disc Amt</th>
            <th>Eff. Monthly</th>
            <th>Taxable</th>
            <th>CGST@9%</th>
            <th>SGST@9%</th>
            <th>IGST@18%</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.isCourseRow ? 'ki-course-row' : 'ki-addon-row-r'}>
              <td>{r.hsnSac ?? ''}</td>
              <td className="ki-name-cell">{r.courseName ?? ''}</td>
              <td className="ki-name-cell">{r.addonName ?? ''}</td>
              <td>{fmtINR(r.monthlyFee)}</td>
              <td>{r.tenureMonths || ''}</td>
              <td>{fmtINR(r.subtotal)}</td>
              <td>{r.discountPercent ? `${Number(r.discountPercent.toFixed(1))}%` : '0%'}</td>
              <td>{fmtINR(r.discountAmount)}</td>
              <td>{fmtINR(r.effectiveMonthly)}</td>
              <td>{fmtINR(r.taxable)}</td>
              <td>{fmtINR(r.cgst)}</td>
              <td>{fmtINR(r.sgst)}</td>
              <td>{fmtINR(r.igst)}</td>
              <td className="ki-total-cell">{fmtINR(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface TotalsData {
  amountInWords: string;
  grandTotal: number;
  /** "Grand Total (incl. GST, after discount)" on the course ledger; a
   * receipt or final invoice names its own figure instead. */
  label?: string;
}

/** `NewInvoice`'s preview keeps passing its whole `LedgerInvoiceData` shape
 * here unchanged — only `amountInWords`/`grandTotal`/`label` are ever read. */
export function TotalsStrip({ doc }: { doc: TotalsData | LedgerInvoiceData }) {
  return (
    <div className="ki-totals-strip">
      <div className="ki-words">
        In words: <b>{doc.amountInWords}</b>
      </div>
      <div className="ki-grand">
        <div className="ki-lbl">{doc.label ?? 'Grand Total (incl. GST, after discount)'}</div>
        <div className="ki-amt ki-num">{fmtINR(doc.grandTotal)}</div>
      </div>
    </div>
  );
}

/** The course-invoice's own note text — every other document passes its own via `children`. */
export function NoteStrip({ children }: { children?: ReactNode }) {
  return (
    <div className="ki-note-strip">
      {children ?? (
        <>
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
        </>
      )}
    </div>
  );
}

export function SignStrip() {
  return (
    <div className="ki-sign-strip">
      <div className="ki-line">Received by (Student/Parent)</div>
      <div className="ki-line">Authorized Signatory — Kaizen Infinities</div>
    </div>
  );
}

/** A diagonal "DRAFT" / "VOID" / "SUPERSEDED" stamp across a printed copy. */
export function Watermark({ text }: { text: string }) {
  return <div className="ki-watermark">{text}</div>;
}

export function LedgerSheet({ company, doc }: { company: LedgerCompany; doc: LedgerInvoiceData }) {
  return (
    <>
      <LedgerHead company={company} />
      <InfoStrip doc={doc} />
      <ScheduleStrip doc={doc} />
      {doc.rows.length === 0 ? (
        <div className="ki-empty-note">Select a course on the left to build the invoice(s).</div>
      ) : (
        <>
          <LedgerTable rows={doc.rows} />
          <TotalsStrip doc={doc} />
        </>
      )}
      <NoteStrip />
      <SignStrip />
    </>
  );
}
