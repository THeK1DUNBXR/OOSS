/**
 * "Invoice History" — the reference tool's searchable list of every course
 * invoice raised, rebuilt on the real invoice list rather than a browser-local
 * database: `GET /finance/invoices` is already scoped to what this signed-in
 * user is allowed to see (an employee's own, a finance head's everything),
 * so the search/reprint experience here is the same list the rest of the app
 * already trusts, just filtered to the course-sale invoices this feature
 * raises and laid out to match the reference tool's own table.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { InvoiceView } from '@kaizen/shared';
import { api, date } from '../../lib/api.js';
import { ErrorBox, Loading, PageHeader } from '../../components/ui.js';
import { KI_APP_CSS } from './style.js';
import { fmtINR } from './calc.js';

export function InvoiceHistory() {
  const [query, setQuery] = useState('');
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => api.get<InvoiceView[]>('/finance/invoices'),
  });

  // This screen is the course-sale ledger specifically — every invoice this
  // feature raises carries `division: 'education'`. A generic line-item
  // invoice (raised from the ordinary Invoices list) never shows up here.
  const courseInvoices = useMemo(() => data.filter((i) => i.division === 'education'), [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return courseInvoices;
    return courseInvoices.filter((i) => {
      const course = i.lines.find((l) => l.courseName)?.courseName ?? '';
      return (
        (i.label ?? '').toLowerCase().includes(q) ||
        (i.customerName ?? '').toLowerCase().includes(q) ||
        course.toLowerCase().includes(q)
      );
    });
  }, [courseInvoices, query]);

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader title="Invoice History" subtitle="Every course invoice raised, searchable by number, student or course." />
      <style>{KI_APP_CSS}</style>
      <div className="ki-app">
        <main className="ki-main">
          <span className="ki-pill-tag" style={{ color: 'var(--ki-black)', marginBottom: 14, display: 'inline-flex' }}>
            Saved Invoices
          </span>
          <div className="ki-catalog-toolbar" style={{ marginTop: 14 }}>
            <input
              type="text"
              placeholder="Search by invoice no., student, or course…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="ki-count">
              {filtered.length} of {courseInvoices.length} saved invoices
            </span>
          </div>
          <div className="ki-cat-scroll">
            <table className="ki-cat">
              <thead>
                <tr>
                  <th>Invoice No.</th>
                  <th>Date</th>
                  <th>Student</th>
                  <th>Course</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Receipts</th>
                  <th>Final Invoice</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="ki-notes-cell">
                      No saved invoices yet — use &quot;Save &amp; Print&quot; on the New Invoice screen.
                    </td>
                  </tr>
                ) : (
                  filtered.map((inv) => {
                    const course = inv.lines.find((l) => l.courseName)?.courseName ?? '';
                    return (
                      <tr key={inv.id}>
                        <td>
                          <b>{inv.label}</b>
                        </td>
                        <td>{inv.issuedDate ? date(inv.issuedDate) : '—'}</td>
                        <td>{inv.customerName ?? ''}</td>
                        <td className="ki-notes-cell">{course}</td>
                        <td className="ki-num-cell">{inv.total !== null ? fmtINR(inv.total) : '—'}</td>
                        <td style={{ textTransform: 'capitalize' }}>{inv.status.replace('_', ' ')}</td>
                        <td>
                          {inv.receiptCount > 0 ? (
                            <Link className="ki-btn-remove" style={{ color: 'var(--ki-navy)' }} to={`/finance/invoices/${inv.id}/document`}>
                              {inv.receiptCount} receipt{inv.receiptCount === 1 ? '' : 's'}
                            </Link>
                          ) : (
                            <span style={{ color: 'var(--ki-muted)' }}>—</span>
                          )}
                        </td>
                        <td>
                          {inv.finalInvoiceId ? (
                            <Link
                              className="ki-btn-remove"
                              style={{ color: 'var(--ki-navy)' }}
                              to={`/finance/final-invoices/${inv.finalInvoiceId}`}
                            >
                              {inv.finalInvoiceCode}
                            </Link>
                          ) : (
                            <span style={{ color: 'var(--ki-muted)' }}>—</span>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <Link className="ki-btn-remove" style={{ color: 'var(--ki-navy)' }} to={`/finance/invoices/${inv.id}/document`}>
                            Reprint
                          </Link>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 11, color: 'var(--ki-muted)', marginTop: 14, lineHeight: 1.6 }}>
            Every invoice here is the same record the rest of the platform reads. It is the internal working record
            a course&apos;s instalments are tracked against — never a tax document, never handed to the student, and
            not reported in GST returns. Each instalment&apos;s own receipt voucher is the student&apos;s document
            along the way; the &quot;Final Invoice&quot; column links the tax invoice raised automatically once fees
            are paid in full or the student withdraws. &quot;Reprint&quot; opens the invoice&apos;s own printable
            document; nothing here can be edited or deleted once issued.
          </p>
        </main>
      </div>
    </div>
  );
}
