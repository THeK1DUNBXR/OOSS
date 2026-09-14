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
    <div className="ki-info-strip">
      <Row k="Invoice No." v={doc.invoiceNo} />
      <Row k="Date" v={doc.invoiceDate ? fmtDate(doc.invoiceDate) : '—'} />
      <Row k="Student Name" v={doc.studentName} />
      <Row k="Contact No." v={doc.contactNo} />
      <Row k="From Tamil Nadu?" v={doc.fromTNYes ? 'Yes' : 'No'} />
      <Row k="Tax Basis" v={taxBasis} />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="ki-row">
      <span className="ki-k">{k}</span>
      <span className="ki-v">{v}</span>
    </div>
  );
}

export function ScheduleStrip({ doc }: { doc: LedgerInvoiceData }) {
  return (
    <div className="ki-schedule-strip">
      <div className="ki-item">
        <div className="ki-k">Enrollment Date</div>
        <div className="ki-v">{doc.enrollmentDate ? fmtDate(doc.enrollmentDate) : '—'}</div>
      </div>
      <div className="ki-item">
        <div className="ki-k">First Payment Due (within 3 days)</div>
        <div className="ki-v">{doc.schedule ? fmtDate(doc.schedule.firstPaymentDue) : '—'}</div>
      </div>
      <div className="ki-item">
        <div className="ki-k">Subsequent Payments From</div>
        <div className="ki-v">{doc.schedule ? fmtDate(doc.schedule.subsequentFrom) : '—'}</div>
      </div>
      <div className="ki-item">
        <div className="ki-k">Then due on</div>
        <div className="ki-v" style={{ fontWeight: 500 }}>
          1st of every month
        </div>
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

export function TotalsStrip({ doc }: { doc: LedgerInvoiceData }) {
  return (
    <div className="ki-totals-strip">
      <div className="ki-words">
        In words: <b>{doc.amountInWords}</b>
      </div>
      <div className="ki-grand">
        <div className="ki-lbl">Grand Total (incl. GST, after discount)</div>
        <div className="ki-amt ki-num">{fmtINR(doc.grandTotal)}</div>
      </div>
    </div>
  );
}

export function NoteStrip() {
  return (
    <div className="ki-note-strip">
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
