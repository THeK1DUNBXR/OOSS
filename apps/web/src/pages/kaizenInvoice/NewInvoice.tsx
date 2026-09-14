/**
 * "New Invoice" — raising a course-sale tax invoice the way a Kaizen
 * Infinities counter actually does it: pick a course, a tenure and any
 * add-ons, and each course entered here becomes its own separate invoice
 * (its own number, its own tax split, its own printed sheet) even though
 * they're entered together for the same student.
 *
 * The live preview on the right is computed client-side (`calc.ts`, the same
 * formulas `invoicing.ts`'s `ledger` block uses server-side) purely so a
 * counter sees the numbers before committing to anything — "Save & Print"
 * then raises the real invoice(s) and prints the server's own copy of them,
 * the same preview-then-reprice pattern `InvoiceEditor` already uses
 * elsewhere in this app.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { amountInWords, computePaymentSchedule, round2 } from '@kaizen/shared';
import type { CompanyProfileView, CourseView } from '@kaizen/shared';
import { api } from '../../lib/api.js';
import { ErrorBox, Loading, PageHeader } from '../../components/ui.js';
import { messageOf } from '../../components/forms.js';
import { KI_APP_CSS } from './style.js';
import { computeRowMath, fmtINR } from './calc.js';
import {
  LedgerHead,
  InfoStrip,
  ScheduleStrip,
  LedgerTable,
  TotalsStrip,
  NoteStrip,
  SignStrip,
  type LedgerCompany,
  type LedgerInvoiceData,
  type LedgerRowData,
} from './LedgerSheet.js';
import { PrintPortal } from './PrintPortal.js';

interface AddonEntry {
  id: number;
  courseAddonId: string;
}
interface CourseEntry {
  id: number;
  courseId: string;
  tenureMonths: number | null;
  discountPercent: number;
  /**
   * The total payable this entry was last set to override, as typed — empty
   * when nobody has used the override and `discountPercent` is just whatever
   * it is. Kept around (not just the derived percent) so that changing the
   * tenure or an add-on afterward can re-solve for the percent that still
   * hits the same target total, the same way the generic invoice editor
   * re-derives a rupee discount when the fee under it changes.
   */
  overrideTotal: string;
  addons: AddonEntry[];
}

let seq = 0;
function blankEntry(): CourseEntry {
  seq += 1;
  return { id: seq, courseId: '', tenureMonths: null, discountPercent: 0, overrideTotal: '', addons: [] };
}

/**
 * What this entry's course + add-ons come to with no discount at all — the
 * figure "Total Payable" is read against to solve for a discount percentage.
 *
 * Every line in one entry shares one discount percentage, so the entry's
 * total is linear in it: total(d) = zeroDiscountTotal x (1 - d/100),
 * regardless of the course and its add-ons carrying different GST rates —
 * each line's own tax scales down with the same (1-d) its taxable value
 * does. Solving the other way is just algebra on that one line.
 */
function zeroDiscountTotal(entry: CourseEntry, course: CourseView | undefined): number {
  if (!course || !entry.tenureMonths) return 0;
  const plan = course.feePlans.find((p) => p.tenureMonths === entry.tenureMonths);
  if (!plan) return 0;
  let total = plan.monthlyFee * entry.tenureMonths * (1 + (course.gstRate ?? 18) / 100);
  for (const a of entry.addons) {
    const addon = course.addons.find((x) => x.id === a.courseAddonId);
    if (!addon) continue;
    total += addon.price * (1 + (addon.gstRate ?? 18) / 100);
  }
  return round2(total);
}

/** Solves `zeroDiscountTotal x (1 - d/100) = target` for `d`, clamped to a sane range. */
function discountPercentForTarget(target: number, zeroDiscount: number): number {
  if (zeroDiscount <= 0) return 0;
  return round2(Math.max(0, Math.min(100, 100 * (1 - target / zeroDiscount))));
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const TN_STATE_CODE = '33';

export function NewInvoice() {
  const { data: courses, isLoading: loadingCourses, error: coursesError } = useQuery({
    queryKey: ['courses', { includeRetired: false }],
    queryFn: () => api.get<CourseView[]>('/education/courses'),
  });
  const { data: company, error: companyError } = useQuery({
    queryKey: ['company-profile'],
    queryFn: () => api.get<CompanyProfileView>('/books/company-profile'),
  });
  const { data: states } = useQuery({
    queryKey: ['gst-states'],
    queryFn: () => api.get<Array<{ code: string; name: string }>>('/books/gst/states'),
  });

  const [invoiceDate, setInvoiceDate] = useState(todayISO());
  const [enrollmentDate, setEnrollmentDate] = useState(todayISO());
  const [studentName, setStudentName] = useState('');
  const [contactNo, setContactNo] = useState('');
  const [fromTN, setFromTN] = useState<'Yes' | 'No'>('Yes');
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [entries, setEntries] = useState<CourseEntry[]>(() => [blankEntry()]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [printBatch, setPrintBatch] = useState<{ docs: LedgerInvoiceData[]; key: number } | null>(null);

  const courseById = useMemo(() => new Map((courses ?? []).map((c) => [c.id, c])), [courses]);

  /**
   * Merges a patch into one entry and, where a "Total Payable" override is
   * active, re-solves the discount percentage against the entry's new
   * course/tenure/add-ons so the override still holds — the same reasoning
   * `invoiceEditor.tsx` uses to reprice a rupee discount when the fee under
   * it changes.
   */
  function updateEntry(id: number, patch: Partial<CourseEntry>) {
    setEntries((es) =>
      es.map((e) => {
        if (e.id !== id) return e;
        const next = { ...e, ...patch };
        if (next.overrideTotal !== '') {
          const course = courseById.get(next.courseId);
          const zeroDiscount = zeroDiscountTotal(next, course);
          const target = Number(next.overrideTotal);
          if (!Number.isNaN(target)) next.discountPercent = discountPercentForTarget(target, zeroDiscount);
        }
        return next;
      }),
    );
  }
  function setEntryCourse(id: number, courseId: string) {
    const course = courseById.get(courseId);
    const firstTenure = course?.feePlans[0]?.tenureMonths ?? null;
    updateEntry(id, { courseId, tenureMonths: firstTenure, addons: [] });
  }
  /** Editing the percentage directly is the counter overriding the override — the target total no longer applies. */
  function setEntryDiscountPercent(id: number, value: number) {
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, discountPercent: value, overrideTotal: '' } : e)));
  }
  function setEntryOverrideTotal(id: number, value: string) {
    setEntries((es) =>
      es.map((e) => {
        if (e.id !== id) return e;
        const course = courseById.get(e.courseId);
        const zeroDiscount = zeroDiscountTotal(e, course);
        const target = Number(value);
        const discountPercent =
          value === '' || Number.isNaN(target) ? e.discountPercent : discountPercentForTarget(target, zeroDiscount);
        return { ...e, overrideTotal: value, discountPercent };
      }),
    );
  }
  function addCourseEntry() {
    setEntries((es) => [...es, blankEntry()]);
  }
  function removeCourseEntry(id: number) {
    setEntries((es) => (es.length <= 1 ? es : es.filter((e) => e.id !== id)));
  }
  function addAddon(entryId: number) {
    seq += 1;
    updateEntry(entryId, {
      addons: [...(entries.find((e) => e.id === entryId)?.addons ?? []), { id: seq, courseAddonId: '' }],
    });
  }
  function removeAddon(entryId: number, addonRowId: number) {
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return;
    updateEntry(entryId, { addons: entry.addons.filter((a) => a.id !== addonRowId) });
  }
  function setAddonChoice(entryId: number, addonRowId: number, courseAddonId: string) {
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return;
    updateEntry(entryId, {
      addons: entry.addons.map((a) => (a.id === addonRowId ? { ...a, courseAddonId } : a)),
    });
  }

  const interState = fromTN === 'No';

  // ---- Live preview: one set of rows per course entry that names a course ----
  const invoicePreviews = useMemo(() => {
    return entries
      .filter((e) => e.courseId && e.tenureMonths)
      .map((entry) => {
        const course = courseById.get(entry.courseId)!;
        const plan = course.feePlans.find((p) => p.tenureMonths === entry.tenureMonths);
        const monthlyFee = plan?.monthlyFee ?? 0;
        const tenure = entry.tenureMonths!;
        const courseMath = computeRowMath(monthlyFee, tenure, entry.discountPercent, course.gstRate ?? 18, interState);
        const rows: LedgerRowData[] = [
          {
            hsnSac: course.hsnSac,
            courseName: course.name,
            addonName: null,
            monthlyFee,
            tenureMonths: tenure,
            discountPercent: entry.discountPercent,
            ...courseMath,
            isCourseRow: true,
          },
        ];
        for (const a of entry.addons) {
          const addon = course.addons.find((x) => x.id === a.courseAddonId);
          if (!addon) continue;
          const addonMonthly = addon.price / tenure;
          const addonMath = computeRowMath(addonMonthly, tenure, entry.discountPercent, addon.gstRate ?? 18, interState);
          rows.push({
            hsnSac: addon.hsnSac,
            courseName: null,
            addonName: addon.name,
            monthlyFee: addonMonthly,
            tenureMonths: tenure,
            discountPercent: entry.discountPercent,
            ...addonMath,
            isCourseRow: false,
          });
        }
        const grandTotal = rows.reduce((s, r) => s + r.total, 0);
        return { entry, course, rows, grandTotal };
      });
  }, [entries, courseById, interState]);

  const combinedTotal = invoicePreviews.reduce((s, p) => s + p.grandTotal, 0);
  const schedule = computePaymentSchedule(enrollmentDate);

  const sharedDocFields: Omit<LedgerInvoiceData, 'rows' | 'grandTotal' | 'amountInWords' | 'invoiceNo'> = {
    invoiceDate,
    studentName: studentName || '[Student full name]',
    contactNo: contactNo || '[10-digit mobile]',
    fromTNYes: fromTN === 'Yes',
    enrollmentDate,
    schedule,
  };

  const companyBlock: LedgerCompany | null = company
    ? {
        name: 'Kaizen Infinities',
        tagline: 'Training & Education Services',
        legalName: company.legalName,
        address: [company.addressLine1, company.addressLine2, company.city ? `${company.city}-${company.pincode ?? ''}` : null]
          .filter(Boolean)
          .join(', '),
        location: company.stateName ?? '—',
        stateCode: company.stateCode,
        gstin: company.gstin,
        phone: company.phone,
      }
    : null;

  const canSubmit =
    invoicePreviews.length > 0 &&
    studentName.trim().length > 0 &&
    contactNo.trim().length > 0 &&
    (fromTN === 'Yes' || placeOfSupply) &&
    !submitting;

  async function handleSaveAndPrint() {
    setSubmitError(null);
    setSubmitting(true);
    try {
      let personId: string | null = null;
      const invoiceIds: string[] = [];

      for (const preview of invoicePreviews) {
        const assignBody: { personId?: string; fullName?: string; primaryPhone?: string | null } = personId
          ? { personId }
          : { fullName: studentName.trim(), primaryPhone: contactNo.trim() || null };
        const enrollment: { id: string; personId: string } = await api.post(
          `/education/courses/${preview.course.id}/assign`,
          assignBody,
        );
        personId = enrollment.personId;

        const lines: Array<Record<string, unknown>> = [
          {
            courseId: preview.course.id,
            enrollmentId: enrollment.id,
            quantity: preview.entry.tenureMonths,
            unitPrice: preview.course.feePlans.find((p) => p.tenureMonths === preview.entry.tenureMonths)?.monthlyFee,
            discountPercent: preview.entry.discountPercent,
          },
        ];
        for (const a of preview.entry.addons) {
          const addon = preview.course.addons.find((x) => x.id === a.courseAddonId);
          if (!addon) continue;
          lines.push({
            courseId: preview.course.id,
            courseAddonId: addon.id,
            enrollmentId: enrollment.id,
            quantity: preview.entry.tenureMonths,
            unitPrice: addon.price / (preview.entry.tenureMonths ?? 1),
            discountPercent: preview.entry.discountPercent,
          });
        }

        const invoice = await api.post<{ id: string }>('/finance/invoices', {
          personId,
          interState,
          placeOfSupply: fromTN === 'Yes' ? TN_STATE_CODE : placeOfSupply,
          enrollmentDate,
          issuedDate: invoiceDate,
          division: 'education',
          issue: true,
          lines,
        });
        invoiceIds.push(invoice.id);
      }

      const docs = await Promise.all(
        invoiceIds.map((id) => api.get<{ recordCode: string | null; label: string; ledger: unknown }>(`/finance/invoices/${id}/document`)),
      );

      const ledgerDocs: LedgerInvoiceData[] = docs.map((doc) => {
        const l = doc.ledger as { schedule: LedgerInvoiceData['schedule']; rows: LedgerRowData[] } | null;
        const total = (l?.rows ?? []).reduce((s, r) => s + r.total, 0);
        return {
          ...sharedDocFields,
          invoiceNo: doc.label,
          schedule: l?.schedule ?? null,
          rows: l?.rows ?? [],
          grandTotal: total,
          amountInWords: amountInWords(total),
        };
      });

      setPrintBatch({ docs: ledgerDocs, key: Date.now() });
      window.setTimeout(() => window.print(), 50);

      // Reset for the next student, the same way the reference tool does.
      setStudentName('');
      setContactNo('');
      setFromTN('Yes');
      setPlaceOfSupply('');
      setEntries([blankEntry()]);
    } catch (e) {
      setSubmitError(messageOf(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (loadingCourses) return <Loading />;
  if (coursesError) return <ErrorBox error={coursesError} />;
  if (companyError) return <ErrorBox error={companyError} />;

  return (
    <div>
      <PageHeader title="New Invoice" subtitle="Raise a course invoice — one course entered here becomes one printed tax invoice." />
      <style>{KI_APP_CSS}</style>
      <div className="ki-app">
        <main className="ki-main">
          <div className="ki-layout">
            <div className="ki-panel">
              <div className="ki-panel-head">Invoice Details</div>
              <div className="ki-panel-body">
                <div className="ki-field">
                  <label>Invoice Date</label>
                  <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
                </div>
                <div className="ki-field">
                  <label>Enrollment Date</label>
                  <input type="date" value={enrollmentDate} onChange={(e) => setEnrollmentDate(e.target.value)} />
                </div>
                <div className="ki-field">
                  <label>Student Name</label>
                  <input type="text" placeholder="Full name" value={studentName} onChange={(e) => setStudentName(e.target.value)} />
                </div>
                <div className="ki-field">
                  <label>Contact No.</label>
                  <input type="tel" placeholder="10-digit mobile" value={contactNo} onChange={(e) => setContactNo(e.target.value)} />
                </div>
                <div className="ki-field">
                  <label>Student is from Tamil Nadu?</label>
                  <select value={fromTN} onChange={(e) => setFromTN(e.target.value as 'Yes' | 'No')}>
                    <option value="Yes">Yes — CGST @9% + SGST @9% (intra-state)</option>
                    <option value="No">No — IGST @18% (inter-state)</option>
                  </select>
                </div>
                {fromTN === 'No' && (
                  <div className="ki-field">
                    <label>Student&apos;s state</label>
                    <select value={placeOfSupply} onChange={(e) => setPlaceOfSupply(e.target.value)}>
                      <option value="">Select a state…</option>
                      {(states ?? []).map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <div className="ki-hint">Needed to name the place of supply on an inter-state invoice.</div>
                  </div>
                )}

                <hr style={{ border: 'none', borderTop: '1px solid var(--ki-line)', margin: '14px 0' }} />

                {entries.map((entry, idx) => {
                  const course = entry.courseId ? courseById.get(entry.courseId) : undefined;
                  return (
                    <div className="ki-course-entry" key={entry.id}>
                      <div className="ki-course-entry-head">
                        <span>Course {idx + 1}</span>
                        {entries.length > 1 && (
                          <button className="ki-btn-remove" onClick={() => removeCourseEntry(entry.id)}>
                            Remove course
                          </button>
                        )}
                      </div>

                      <div className="ki-field">
                        <label>Course</label>
                        <select value={entry.courseId} onChange={(e) => setEntryCourse(entry.id, e.target.value)}>
                          <option value="">Select a course…</option>
                          {(courses ?? []).map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="ki-field">
                        <label>Tenure</label>
                        <select
                          disabled={!course}
                          value={entry.tenureMonths ?? ''}
                          onChange={(e) => updateEntry(entry.id, { tenureMonths: Number(e.target.value) })}
                        >
                          {!course ? (
                            <option value="">Select course first</option>
                          ) : (
                            course.feePlans.map((p) => (
                              <option key={p.tenureMonths} value={p.tenureMonths}>
                                {p.tenureMonths} {p.tenureMonths === 1 ? 'month' : 'months'}
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                      {course && course.feePlans.length > 0 && course.feePlans.length < 4 && (
                        <div className="ki-hint" style={{ marginBottom: 8 }}>
                          Only {course.feePlans.map((p) => p.tenureMonths).join('/')}-month plan(s) available
                          {course.hours ? ` — course runs ${course.hours} hrs.` : '.'}
                        </div>
                      )}

                      <div className="ki-field-row">
                        <div className="ki-field">
                          <label>
                            Discount % <span style={{ fontWeight: 400, color: 'var(--ki-muted)' }}>(this course + its add-ons)</span>
                          </label>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={0.5}
                            value={entry.discountPercent}
                            onChange={(e) => setEntryDiscountPercent(entry.id, Number(e.target.value) || 0)}
                          />
                        </div>
                        <div className="ki-field">
                          <label>
                            Total Payable <span style={{ fontWeight: 400, color: 'var(--ki-muted)' }}>(override)</span>
                          </label>
                          <input
                            type="number"
                            min={0}
                            step={1}
                            placeholder="leave blank to use %"
                            value={entry.overrideTotal}
                            onChange={(e) => setEntryOverrideTotal(entry.id, e.target.value)}
                          />
                        </div>
                      </div>
                      {entry.overrideTotal !== '' && (
                        <div className="ki-hint" style={{ marginTop: -8, marginBottom: 8 }}>
                          Solved as {entry.discountPercent.toFixed(2)}% off — type in either field, the other follows it.
                        </div>
                      )}

                      {entry.addons.map((a, aidx) => (
                        <div className="ki-addon-row" key={a.id}>
                          <div className="ki-addon-row-head">
                            <span>Add-on {aidx + 1}</span>
                            <button className="ki-btn-remove" onClick={() => removeAddon(entry.id, a.id)}>
                              Remove
                            </button>
                          </div>
                          <select
                            value={a.courseAddonId}
                            onChange={(e) => setAddonChoice(entry.id, a.id, e.target.value)}
                            style={{
                              width: '100%',
                              padding: '7px 8px',
                              border: '1px solid var(--ki-line-strong)',
                              borderRadius: 3,
                              fontSize: 13,
                              fontFamily: "'IBM Plex Sans',sans-serif",
                            }}
                          >
                            <option value="">Select add-on…</option>
                            {(course?.addons ?? []).map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name} — {fmtINR(o.price)}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                      <button className="ki-btn-add small" disabled={!course} onClick={() => addAddon(entry.id)}>
                        + Add an add-on
                      </button>
                    </div>
                  );
                })}
                <button className="ki-btn-add" onClick={addCourseEntry}>
                  + Add another course
                </button>
                <div className="ki-hint" style={{ marginTop: 6 }}>
                  Each course below becomes its own separate invoice — with its own invoice number, its own add-ons,
                  and its own tax split — even though you&apos;re entering them together for the same student.
                </div>

                {submitError && (
                  <p className="ki-hint" style={{ color: 'var(--ki-red)', marginTop: 10 }}>
                    {submitError}
                  </p>
                )}
                <button className="ki-btn-primary" disabled={!canSubmit} onClick={handleSaveAndPrint}>
                  {submitting ? 'Saving…' : 'Save & Print all'}
                </button>
              </div>
            </div>

            <div className="ki-panel">
              {!companyBlock || invoicePreviews.length === 0 ? (
                <>
                  {companyBlock && <LedgerHead company={companyBlock} />}
                  <InfoStrip doc={{ ...sharedDocFields, invoiceNo: '(assigned when saved)', rows: [], grandTotal: 0, amountInWords: '' }} />
                  <ScheduleStrip doc={{ ...sharedDocFields, invoiceNo: '', rows: [], grandTotal: 0, amountInWords: '' }} />
                  <div className="ki-empty-note">Select a course on the left to build the invoice(s).</div>
                </>
              ) : (
                <>
                  <LedgerHead company={companyBlock} />
                  <InfoStrip doc={{ ...sharedDocFields, invoiceNo: '(assigned when saved)', rows: [], grandTotal: 0, amountInWords: '' }} />
                  <ScheduleStrip doc={{ ...sharedDocFields, invoiceNo: '', rows: [], grandTotal: 0, amountInWords: '' }} />
                  {invoicePreviews.map((p, idx) => (
                    <div className="ki-ledger-section" key={p.entry.id}>
                      <div className="ki-ledger-section-label">
                        <span className="ki-n">{idx + 1}</span> Invoice {idx + 1} of {invoicePreviews.length} — {p.course.name}
                      </div>
                      <LedgerTable rows={p.rows} />
                      <TotalsStrip
                        doc={{ ...sharedDocFields, invoiceNo: '', rows: [], grandTotal: p.grandTotal, amountInWords: amountInWords(p.grandTotal) }}
                      />
                    </div>
                  ))}
                  {invoicePreviews.length > 1 && (
                    <div className="ki-combined-summary">
                      <span>{invoicePreviews.length} separate invoices will be saved and printed, each with its own invoice number</span>
                      <span>
                        Combined total (reference only, not on any single invoice): <b>{fmtINR(combinedTotal)}</b>
                      </span>
                    </div>
                  )}
                  <NoteStrip />
                  <SignStrip />
                </>
              )}
            </div>
          </div>
        </main>
      </div>

      {printBatch && companyBlock && (
        <PrintPortal key={printBatch.key}>
          {printBatch.docs.map((doc, i) => (
            <div className="ki-print-page" key={i}>
              <div className="ki-print-half">
                <div className="ki-print-copy">
                  <div style={{ textAlign: 'right', fontSize: 8, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--ki-navy)' }}>
                    CUSTOMER COPY
                  </div>
                  <LedgerHead company={companyBlock} />
                  <InfoStrip doc={doc} />
                  <ScheduleStrip doc={doc} />
                  <LedgerTable rows={doc.rows} />
                  <TotalsStrip doc={doc} />
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
                  <LedgerHead company={companyBlock} />
                  <InfoStrip doc={doc} />
                  <ScheduleStrip doc={doc} />
                  <LedgerTable rows={doc.rows} />
                  <TotalsStrip doc={doc} />
                  <NoteStrip />
                  <SignStrip />
                </div>
              </div>
            </div>
          ))}
        </PrintPortal>
      )}
    </div>
  );
}
