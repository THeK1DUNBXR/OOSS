/**
 * Raising and editing an invoice.
 *
 * One component for both, because a draft and a new invoice are the same form
 * with a different verb — and the previous single-purpose one could not edit at
 * all, which meant a typo in a line was permanent.
 *
 * What it is built around:
 *
 * **The lines are editable, and a line can be a course.** Choosing a course
 * fills the description, the fee, the rate and the SAC from the catalogue, so
 * somebody at a counter raises a correct tax invoice by naming what was sold
 * rather than by knowing the price list. Everything stays overridable, because a
 * negotiated price is a real thing.
 *
 * **The tax is shown as it will be charged.** CGST and SGST within the state, a
 * single IGST across a state line, computed per line and totalled — because an
 * invoice carrying an 18% service and a 5% good cannot be described by one rate.
 * The figures here are the client's own arithmetic for the preview only; the
 * server prices the invoice, and the two agreeing is something the tests assert
 * rather than something this file promises.
 *
 * **Payment is part of raising it.** How much is being taken as the document is
 * handed over, and how. The two totals — payable, and payable now — are shown
 * while the invoice is being typed, not just on the printed copy, because the
 * person at the counter is the one who has to say the second number out loud.
 *
 * What is taken at issue is what the invoice says, and it is the last thing the
 * invoice ever says about payment: a tax invoice is final. Instalments after that
 * are receipts, issued from the invoice's own page, each its own document.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  GST_RATES,
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  computeGst,
  paymentTypeFor,
  round2,
  type CourseView,
  type InvoiceView,
  type PaymentMode,
} from '@kaizen/shared';
import { api } from '../lib/api.js';
import { CreateModal, MoneyInput, Row, SelectInput, TextArea, TextInput } from './forms.js';

interface Named {
  id: string;
  name: string;
}

function rowsOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const items = (data as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

function useList<T>(key: string, path: string, enabled = true) {
  const query = useQuery({ queryKey: [key], queryFn: () => api.get<unknown>(path), enabled });
  return { ...query, rows: rowsOf<T>(query.data) };
}

const today = () => new Date().toISOString().slice(0, 10);

interface EditorLine {
  courseId: string;
  /** The student's place on the course — what a fee line actually bills. */
  enrollmentId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  /**
   * The two faces of one discount, kept in step with each other as either is
   * typed — never both sent to the server, which would be an instruction that
   * disagrees with itself about which figure is the true one.
   */
  discountPercent: string;
  discountAmount: string;
  gstRate: string;
  hsnSac: string;
}

const emptyLine: EditorLine = {
  courseId: '',
  enrollmentId: '',
  description: '',
  quantity: '1',
  unitPrice: '',
  discountPercent: '',
  discountAmount: '',
  gstRate: '18',
  hsnSac: '',
};

function linesFrom(invoice: InvoiceView | null): EditorLine[] {
  if (!invoice || invoice.lines.length === 0) return [{ ...emptyLine }];
  return invoice.lines.map((l) => ({
    courseId: l.courseId ?? '',
    enrollmentId: l.enrollmentId ?? '',
    description: l.description,
    quantity: String(l.quantity ?? 1),
    // The fee before the discount, which is what the counter re-opens a draft
    // to see and adjust — not the already-discounted amount the server stores.
    unitPrice: String(l.unitPrice ?? round2(((l.amount ?? 0) + (l.discountAmount ?? 0)) / Math.max(l.quantity ?? 1, 1)) ?? ''),
    discountPercent: l.discountPercent ? String(l.discountPercent) : '',
    discountAmount: l.discountAmount ? String(l.discountAmount) : '',
    gstRate: String(l.gstRate ?? 0),
    hsnSac: l.hsnSac ?? '',
  }));
}

/** unitPrice x quantity, before any discount. */
function grossOf(line: EditorLine): number {
  return round2(Number(line.unitPrice || 0) * Number(line.quantity || 1));
}

export function InvoiceEditor({
  open,
  onClose,
  invoice,
  /** Pre-selects a person, for billing a student from their own page. */
  personId: initialPersonId,
  /** Pre-selects the enrolment being billed, from that same page. */
  enrollmentId: initialEnrollmentId,
}: {
  open: boolean;
  onClose: () => void;
  /** A draft being corrected. Absent when raising a new one. */
  invoice?: InvoiceView | null;
  personId?: string | null;
  enrollmentId?: string | null;
}) {
  const editing = Boolean(invoice);
  const organizations = useList<Named>('organizations', '/crm/organizations?pageSize=200', open);
  const institutions = useList<Named>('institutions', '/crm/institutions?pageSize=200', open);
  const students = useList<{ id: string; personId: string; fullName: string; registrationNumber: string | null; primaryPhone: string | null }>(
    'students-picker',
    '/crm/students?pageSize=200',
    open,
  );
  const courses = useList<CourseView>('courses', '/education/courses', open);
  const states = useList<{ code: string; name: string }>('gst-states', '/books/gst/states', open);
  /**
   * Our own state code, for the preview's inter-state reading.
   *
   * An employee raising an invoice cannot read the company profile endpoint —
   * it carries the bank account number — so this is allowed to fail. The
   * preview then shows the intra-state pair, and the server still prices the
   * invoice from the profile it can read: the document is right either way, and
   * only the preview is less sure of itself.
   */
  const { data: profile } = useQuery({
    queryKey: ['company-profile'],
    queryFn: () => api.get<{ stateCode: string | null; gstin: string | null; defaultDueDays: number }>('/books/company-profile'),
    enabled: open,
    retry: false,
  });

  /**
   * Which of the three this invoice is for.
   *
   * "Customer" is the role, not the record: a student, a college and a business
   * are three different parties and the document says which one it is
   * addressed to. The server stores a person id or an organisation id and reads
   * the kind off the row, so this choice is about what the picker offers rather
   * than about a field being sent.
   */
  const [billTo, setBillTo] = useState<'student' | 'institution' | 'organization'>(
    invoice?.personId || initialPersonId ? 'student' : 'organization',
  );
  const [organizationId, setOrganizationId] = useState(invoice?.accountId ?? '');
  const [personId, setPersonId] = useState(invoice?.personId ?? initialPersonId ?? '');
  const [customerGstin, setCustomerGstin] = useState(invoice?.customerGstin ?? '');
  const [placeOfSupply, setPlaceOfSupply] = useState(invoice?.placeOfSupply ?? '');
  const [dueInDays, setDueInDays] = useState('30');
  const [dueDate, setDueDate] = useState(invoice?.dueDate ? invoice.dueDate.slice(0, 10) : '');
  const [division, setDivision] = useState(invoice?.division ?? '');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<EditorLine[]>(linesFrom(invoice ?? null));

  /**
   * The enrolments of whoever is being billed.
   *
   * Choosing one fills the course, the fee and the SAC, and ties the fee to the
   * student's actual place on the course — so "has this enrolment been paid for"
   * has an answer rather than a guess read off the description.
   */
  const enrolments = useList<{
    id: string;
    recordCode: string;
    personId: string;
    courseName: string;
    cohortName: string;
    status: string;
  }>('enrollments-for-billing', '/education/enrollments?limit=200', open && billTo === 'student');

  const [issueNow, setIssueNow] = useState(true);
  const [payingNow, setPayingNow] = useState('');
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [paymentReference, setPaymentReference] = useState('');

  // Reopening the modal on a different invoice has to start from that invoice,
  // not from whatever the last one left behind.
  useEffect(() => {
    if (!open) return;
    setLines(linesFrom(invoice ?? null));
    if (!invoice && initialEnrollmentId) {
      // Filled once the enrolment list has loaded, by the effect below.
      setLines([{ ...emptyLine, enrollmentId: initialEnrollmentId }]);
    }
    setBillTo(invoice?.personId || initialPersonId ? 'student' : 'organization');
    setOrganizationId(invoice?.accountId ?? '');
    setPersonId(invoice?.personId ?? initialPersonId ?? '');
    setCustomerGstin(invoice?.customerGstin ?? '');
    setPlaceOfSupply(invoice?.placeOfSupply ?? '');
    setDueDate(invoice?.dueDate ? invoice.dueDate.slice(0, 10) : '');
    setDivision(invoice?.division ?? '');
    setPayingNow('');
  }, [open, invoice, initialPersonId, initialEnrollmentId]);

  /**
   * Fill the pre-selected enrolment's line once the catalogue has arrived.
   *
   * Separate from the reset above because the price comes from the course and
   * the course list is a second request: filling it in the same tick would set
   * the description and leave the fee blank.
   */
  useEffect(() => {
    if (!open || invoice || !initialEnrollmentId) return;
    if (!enrolments.rows.length || !courses.rows.length) return;
    setLines((current) =>
      current.length === 1 && current[0].enrollmentId === initialEnrollmentId && !current[0].unitPrice
        ? [fillFromEnrolment(current[0], initialEnrollmentId, enrolments.rows, courses.rows)]
        : current,
    );
  }, [open, invoice, initialEnrollmentId, enrolments.rows, courses.rows]);

  const setLine = (i: number, patch: Partial<EditorLine>) =>
    setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  /**
   * Typing a discount percentage derives its rupee amount off the line's own
   * gross fee. Typing a rupee amount derives its percentage the same way.
   * Whichever the counter typed last is the one they meant; the other field
   * is always what falls out of it against the current fee, never a second
   * value that could drift from the first.
   */
  const setDiscountPercent = (i: number, value: string) =>
    setLines((ls) =>
      ls.map((l, k) => {
        if (k !== i) return l;
        const gross = grossOf(l);
        const pct = Math.max(0, Math.min(100, Number(value || 0)));
        const amount = gross > 0 ? round2((gross * pct) / 100) : 0;
        return { ...l, discountPercent: value, discountAmount: value === '' ? '' : String(amount) };
      }),
    );

  const setDiscountAmount = (i: number, value: string) =>
    setLines((ls) =>
      ls.map((l, k) => {
        if (k !== i) return l;
        const gross = grossOf(l);
        const amount = Math.max(0, Math.min(gross, Number(value || 0)));
        const pct = gross > 0 ? round2((amount / gross) * 100) : 0;
        return { ...l, discountAmount: value, discountPercent: value === '' ? '' : String(pct) };
      }),
    );

  /**
   * Editing the fee or the quantity moves the gross the discount is a share
   * of. A stored rupee discount would then be a stale figure that no longer
   * says what it claims to; re-deriving it from the last percentage the
   * counter set keeps the two telling the same story as the fee changes under
   * them. A line with no percentage entered yet (a bare rupee discount typed
   * before ever touching the fee) is left as it is — there is no percentage
   * to re-derive it from.
   */
  const setLineAndRepriceDiscount = (i: number, patch: Partial<EditorLine>) =>
    setLines((ls) =>
      ls.map((l, k) => {
        if (k !== i) return l;
        const next = { ...l, ...patch };
        if (!next.discountPercent) return next;
        const gross = grossOf(next);
        const pct = Math.max(0, Math.min(100, Number(next.discountPercent || 0)));
        next.discountAmount = gross > 0 ? String(round2((gross * pct) / 100)) : '0';
        return next;
      }),
    );

  /** Choosing a course fills the line from the catalogue. */
  const pickCourse = (i: number, courseId: string) => {
    const course = courses.rows.find((c) => c.id === courseId);
    if (!course) {
      setLine(i, { courseId: '', enrollmentId: '' });
      return;
    }
    setLine(i, {
      courseId,
      enrollmentId: '',
      description: `${course.name} (${course.code})`,
      unitPrice: course.feeAmount !== null ? String(course.feeAmount) : '',
      // A discount is a share of a specific fee. Naming a different course
      // means a different fee, and carrying the old discount forward would
      // either overstate a small one or exceed the size of a large one.
      discountPercent: '',
      discountAmount: '',
      gstRate: String(course.gstRate ?? 18),
      hsnSac: course.hsnSac ?? '',
    });
  };

  /** Choosing an enrolment fills the course, and then the course fills the rest. */
  const pickEnrolment = (i: number, enrollmentId: string) => {
    if (!enrolments.rows.find((e) => e.id === enrollmentId)) {
      setLine(i, { enrollmentId: '' });
      return;
    }
    setLines((ls) =>
      ls.map((l, k) => (k === i ? fillFromEnrolment(l, enrollmentId, enrolments.rows, courses.rows) : l)),
    );
  };

  const theirEnrolments = enrolments.rows.filter((e) => e.personId === personId);

  /**
   * The tax reading, from the two registrations where both exist and from the
   * place of supply otherwise. The same order the server uses, which is why the
   * preview and the saved invoice agree.
   */
  const ourState = profile?.stateCode ?? null;
  const theirState = customerGstin.length >= 2 ? customerGstin.slice(0, 2) : placeOfSupply || null;
  const interState = Boolean(ourState && theirState && ourState !== theirState);

  const gst = useMemo(
    () =>
      computeGst(
        lines
          .filter((l) => Number(l.unitPrice) > 0)
          .map((l) => ({
            // Taxed on what the fee actually is after its own discount, not on
            // the pre-discount figure — the same reading the server prices from.
            taxableValue: round2(grossOf(l) - Number(l.discountAmount || 0)),
            gstRate: Number(l.gstRate || 0),
          })),
        interState,
      ),
    [lines, interState],
  );

  const collected = round2(Number(payingNow || 0));
  const declared = paymentTypeFor(gst.grandTotal, collected);
  const balance = round2(Math.max(gst.grandTotal - collected, 0));

  const payload = () => ({
    ...(billTo === 'student' ? { personId: personId || null } : { organizationId: organizationId || null }),
    customerGstin: customerGstin.trim() || null,
    placeOfSupply: placeOfSupply || null,
    ...(dueDate ? { dueDate } : { dueInDays: Number(dueInDays || profile?.defaultDueDays || 30) }),
    division: division || null,
    notes: notes.trim() || null,
    lines: lines
      .filter((l) => (l.description.trim() || l.courseId) && Number(l.unitPrice) > 0)
      .map((l) => ({
        courseId: l.courseId || null,
        enrollmentId: l.enrollmentId || null,
        description: l.description.trim() || null,
        quantity: Number(l.quantity || 1),
        unitPrice: Number(l.unitPrice),
        // Sent as a rupee amount only, never alongside a percentage: the two
        // are kept in step with each other client-side already, and the
        // server refuses a line given both as an instruction that disagrees
        // with itself about which figure is the true one.
        discountAmount: Number(l.discountAmount || 0),
        gstRate: Number(l.gstRate || 0),
        hsnSac: l.hsnSac.trim() || null,
      })),
  });

  const submit = () => {
    if (editing) return api.patch(`/finance/invoices/${invoice!.id}`, payload());
    return api.post('/finance/invoices', {
      ...payload(),
      issue: issueNow,
      payment:
        issueNow && collected > 0
          ? {
              amount: collected,
              mode: paymentMode,
              reference: paymentReference.trim() || null,
              receivedAt: new Date().toISOString(),
            }
          : null,
    });
  };

  return (
    <CreateModal
      open={open}
      title={editing ? `Correct ${invoice!.label}` : 'Raise an invoice'}
      submitLabel={editing ? 'Save the draft' : issueNow ? 'Issue it' : 'Save as draft'}
      width="max-w-4xl"
      onClose={onClose}
      invalidate={[['invoices'], ['receivables'], ['payments'], ['learner-timeline']]}
      onSubmit={submit}
    >
      {/* ---- Who is being billed ------------------------------------------ */}
      <div>
        <p className="label">Who is this for?</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {(
            [
              ['student', 'A student'],
              ['institution', 'A school or college'],
              ['organization', 'An organisation'],
            ] as Array<[typeof billTo, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setBillTo(value);
                // The two id fields are separate on purpose: switching between
                // them must not leave the previous choice behind to be sent.
                if (value === 'student') setOrganizationId('');
                else setPersonId('');
              }}
              className={`chip transition-colors ${
                billTo === value ? 'border-accent/60 text-accent-soft' : 'border-ink-800 text-ink-500 hover:border-ink-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-2xs text-ink-500">
        The invoice says which of the three it is for.
      </p>

      {billTo === 'student' ? (
        <SelectInput
          label="Student"
          required
          value={personId}
          onChange={setPersonId}
          placeholder={students.rows.length ? 'Choose a student' : 'No students yet — add one first'}
          options={students.rows.map((p) => ({
            value: p.personId,
            label: [p.fullName, p.registrationNumber ?? p.primaryPhone].filter(Boolean).join(' — '),
          }))}
        />
      ) : billTo === 'institution' ? (
        <SelectInput
          label="School or college"
          required
          value={organizationId}
          onChange={setOrganizationId}
          placeholder={institutions.rows.length ? 'Choose one' : 'None on file yet'}
          options={institutions.rows.map((o) => ({ value: o.id, label: o.name }))}
        />
      ) : (
        <SelectInput
          label="Organisation"
          required
          value={organizationId}
          onChange={setOrganizationId}
          placeholder={organizations.rows.length ? 'Choose one' : 'None on file yet'}
          options={organizations.rows.map((o) => ({ value: o.id, label: o.name }))}
        />
      )}

      <Row>
        <TextInput
          label="Their GSTIN"
          value={customerGstin}
          onChange={(v) => setCustomerGstin(v.toUpperCase())}
          placeholder="33AABCK1234H1Z2"
          hint="blank for an unregistered customer"
        />
        <SelectInput
          label="Place of supply"
          value={placeOfSupply}
          onChange={setPlaceOfSupply}
          placeholder={ourState ? `Our own state (${ourState})` : 'Which state'}
          options={states.rows.map((s) => ({ value: s.code, label: `${s.code} — ${s.name}` }))}
          hint={interState ? 'across a state line — IGST' : 'within the state — CGST + SGST'}
        />
      </Row>

      <Row>
        {dueDate ? (
          <TextInput label="Due by" type="date" value={dueDate} onChange={setDueDate} />
        ) : (
          <TextInput label="Due in (days)" type="number" value={dueInDays} onChange={setDueInDays} />
        )}
        <SelectInput
          label="Division"
          value={division}
          onChange={setDivision}
          placeholder="Not stated"
          options={[
            { value: 'software', label: 'Software' },
            { value: 'skill', label: 'Skill Development' },
            { value: 'education', label: 'Education' },
            { value: 'shared', label: 'Shared' },
          ]}
        />
      </Row>

      {/* ---- Lines -------------------------------------------------------- */}
      <div>
        <p className="label mb-1">What they are being billed for</p>
        <div className="flex flex-col gap-3">
          {lines.map((line, i) => (
            <div key={i} className="rounded border border-ink-800 bg-ink-950/60 p-3">
              {billTo === 'student' && theirEnrolments.length > 0 && (
                <SelectInput
                  label="Which enrolment"
                  value={line.enrollmentId}
                  onChange={(v) => pickEnrolment(i, v)}
                  placeholder="Not a course fee"
                  options={theirEnrolments.map((e) => ({
                    value: e.id,
                    label: `${e.courseName} — ${e.cohortName} (${e.recordCode})`,
                  }))}
                  hint="ties the fee to their place on the course"
                />
              )}
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <SelectInput
                  label="Course"
                  value={line.courseId}
                  onChange={(v) => pickCourse(i, v)}
                  placeholder="Not a course — type it below"
                  options={courses.rows.map((c) => ({
                    value: c.id,
                    label: c.feeAmount !== null ? `${c.name} (${c.code}) — ₹${c.feeAmount.toLocaleString('en-IN')}` : `${c.name} (${c.code})`,
                  }))}
                  hint="fills the price, rate and SAC"
                />
                <button
                  type="button"
                  className="btn-quiet mt-5 h-9"
                  aria-label="Remove line"
                  onClick={() => setLines((ls) => (ls.length === 1 ? ls : ls.filter((_, k) => k !== i)))}
                >
                  ✕
                </button>
              </div>
              <TextInput
                label="Description"
                value={line.description}
                onChange={(v) => setLine(i, { description: v })}
                placeholder="SAP support, September"
              />
              <div className="mt-2 grid gap-2 sm:grid-cols-4">
                <TextInput
                  label="Qty"
                  type="number"
                  value={line.quantity}
                  onChange={(v) => setLineAndRepriceDiscount(i, { quantity: v })}
                />
                <MoneyInput
                  label="Price each"
                  value={line.unitPrice}
                  onChange={(v) => setLineAndRepriceDiscount(i, { unitPrice: v })}
                />
                <SelectInput
                  label="GST %"
                  value={line.gstRate}
                  onChange={(v) => setLine(i, { gstRate: v })}
                  options={GST_RATES.map((r) => ({ value: String(r), label: `${r}%` }))}
                />
                <TextInput
                  label="HSN / SAC"
                  value={line.hsnSac}
                  onChange={(v) => setLine(i, { hsnSac: v })}
                  placeholder="999293"
                  hint="the return needs it"
                />
              </div>
              {/* The discount, either way round: type a percentage and the rupee
                  figure follows it, or type the rupee figure and the percentage
                  follows that — always the same one discount, never two that
                  could disagree. */}
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <TextInput
                  label="Discount %"
                  type="number"
                  value={line.discountPercent}
                  onChange={(v) => setDiscountPercent(i, v)}
                  placeholder="0"
                />
                <MoneyInput
                  label="Discount amount"
                  value={line.discountAmount}
                  onChange={(v) => setDiscountAmount(i, v)}
                  hint="either field — the other follows it"
                />
              </div>
              <p className="mt-1 text-right text-2xs text-ink-500">
                {Number(line.discountAmount || 0) > 0 ? (
                  <>
                    Course fee{' '}
                    <span className="tabular-nums text-ink-400 line-through">
                      ₹{grossOf(line).toLocaleString('en-IN')}
                    </span>{' '}
                    − discount{' '}
                    <span className="tabular-nums text-ink-400">
                      ₹{Number(line.discountAmount || 0).toLocaleString('en-IN')}
                    </span>{' '}
                    = payable{' '}
                    <span className="tabular-nums text-ink-200">
                      ₹{round2(grossOf(line) - Number(line.discountAmount || 0)).toLocaleString('en-IN')}
                    </span>
                  </>
                ) : (
                  <>
                    Line total <span className="tabular-nums text-ink-200">₹{grossOf(line).toLocaleString('en-IN')}</span>
                  </>
                )}
              </p>
            </div>
          ))}
        </div>
        <button type="button" className="btn-quiet mt-2" onClick={() => setLines((ls) => [...ls, { ...emptyLine }])}>
          + Another line
        </button>
      </div>

      {/* ---- The tax, as it will be charged ------------------------------- */}
      <div className="rounded border border-ink-800 bg-ink-950 p-3 text-xs">
        <dl className="grid gap-1">
          <Figure label="Taxable value" value={gst.taxableValue} />
          {interState ? (
            <Figure label="IGST" value={gst.igst} />
          ) : (
            <>
              <Figure label="CGST" value={gst.cgst} />
              <Figure label="SGST" value={gst.sgst} />
            </>
          )}
          {gst.roundOff !== 0 && <Figure label="Rounding" value={gst.roundOff} />}
          <div className="mt-1 flex items-baseline justify-between border-t border-ink-800 pt-1">
            <dt className="font-medium text-ink-100">Total payable</dt>
            <dd className="font-display tabular-nums text-base text-ink-50">
              ₹{gst.grandTotal.toLocaleString('en-IN')}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-2xs text-ink-600">
          {interState
            ? 'Across a state line, so one IGST instead of a CGST/SGST pair.'
            : 'Within the state, so the tax splits into CGST and SGST. Worked out line by line.'}
        </p>
      </div>

      {/* ---- Payment ------------------------------------------------------ */}
      {!editing && (
        <>
          <label className="flex items-center gap-2 text-sm text-ink-200">
            <input type="checkbox" checked={issueNow} onChange={(e) => setIssueNow(e.target.checked)} />
            Issue it now
          </label>
          {!issueNow && (
            <p className="text-2xs text-ink-500">
              A draft can still be changed. An issued invoice is corrected by a credit note.
            </p>
          )}

          {issueNow && (
            <div className="rounded border border-ink-800 bg-ink-950/60 p-3">
              <p className="label mb-2">What are they paying now</p>
              <Row>
                <MoneyInput
                  label="Amount payable now"
                  value={payingNow}
                  onChange={setPayingNow}
                  hint="leave blank for a credit sale"
                />
                <SelectInput
                  label="How"
                  value={paymentMode}
                  onChange={setPaymentMode}
                  options={PAYMENT_MODES.map((m) => ({ value: m, label: PAYMENT_MODE_LABELS[m] }))}
                />
              </Row>
              <div className="mt-2">
                <TextInput
                  label="Reference"
                  value={paymentReference}
                  onChange={setPaymentReference}
                  placeholder="UTR, UPI reference or cheque number"
                />
              </div>

              {/* The two figures the customer is told, before the document is even
                  raised — because the person at the counter has to say the second
                  one out loud. */}
              <dl className="mt-3 grid gap-1 border-t border-ink-800 pt-2 text-xs">
                <Figure label="Total payable" value={gst.grandTotal} strong />
                <Figure label="Amount payable now" value={collected} strong />
                {declared === 'part' && <Figure label="Balance after this" value={balance} tone="warn" />}
              </dl>
              <p className="mt-2 text-2xs text-ink-500">
                {declared === 'full'
                  ? 'The invoice will read Full payment, and a receipt will be issued for it.'
                  : declared === 'part'
                    ? `The invoice will read Part payment — ₹${collected.toLocaleString('en-IN')} paid by ${PAYMENT_MODE_LABELS[paymentMode]}, ₹${balance.toLocaleString('en-IN')} still owed — and a receipt will be issued for this instalment.`
                    : 'Nothing collected now, so the invoice will read Payable on credit with its due date.'}
              </p>
              <p className="mt-1 text-2xs text-ink-600">
                The last thing this invoice says about payment. Later instalments are receipts.
              </p>
            </div>
          )}
        </>
      )}

      <TextArea label="Notes on the invoice" value={notes} onChange={setNotes} rows={2} hint="printed under the lines" />
    </CreateModal>
  );
}

/** One place that turns an enrolment into a priced fee line. */
function fillFromEnrolment(
  line: EditorLine,
  enrollmentId: string,
  enrolments: Array<{ id: string; courseName: string }>,
  courses: CourseView[],
): EditorLine {
  const enrolment = enrolments.find((e) => e.id === enrollmentId);
  if (!enrolment) return { ...line, enrollmentId: '' };
  const course = courses.find((c) => c.name === enrolment.courseName);
  return {
    ...line,
    enrollmentId,
    courseId: course?.id ?? '',
    description: course ? `${course.name} (${course.code}) — course fee` : `${enrolment.courseName} — course fee`,
    unitPrice: course?.feeAmount != null ? String(course.feeAmount) : line.unitPrice,
    gstRate: String(course?.gstRate ?? 18),
    hsnSac: course?.hsnSac ?? line.hsnSac,
  };
}

function Figure({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: number;
  strong?: boolean;
  tone?: 'warn';
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? 'text-ink-200' : 'text-ink-400'}>{label}</dt>
      <dd
        className={`tabular-nums ${
          tone === 'warn' ? 'text-band-watch' : strong ? 'font-medium text-ink-50' : 'text-ink-200'
        }`}
      >
        ₹{value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </dd>
    </div>
  );
}

/**
 * Taking an instalment against an invoice that is already out, and issuing the
 * receipt for it.
 *
 * The counter case the platform could not represent: somebody paid half last
 * week and is paying the rest now. It is one call because it is one act — the
 * money arrives, a receipt allocates it, and the customer walks away holding a
 * numbered document for what they handed over.
 *
 * It does not touch the invoice. A tax invoice is final, and an instalment
 * arriving afterwards is a new fact with its own document rather than an edit to
 * one the customer is already holding.
 */
export function CollectPayment({
  invoice,
  onClose,
}: {
  invoice: InvoiceView | null;
  onClose: () => void;
}) {
  const outstanding = invoice?.outstanding ?? 0;
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PaymentMode>('cash');
  const [reference, setReference] = useState('');

  useEffect(() => {
    setAmount(outstanding > 0 ? String(outstanding) : '');
    setReference('');
  }, [invoice?.id, outstanding]);

  if (!invoice) return null;

  const taking = round2(Number(amount || 0));
  const after = round2(Math.max(outstanding - taking, 0));

  return (
    <CreateModal
      open
      title={`Receipt an instalment against ${invoice.label}`}
      submitLabel="Issue the receipt"
      onClose={onClose}
      invalidate={[
        ['invoices'],
        ['payments'],
        ['receipts'],
        ['receivables'],
        ['learner-timeline'],
        ['invoice-document'],
      ]}
      onSubmit={() =>
        api.post(`/finance/invoices/${invoice.id}/collect`, {
          amount: taking,
          mode,
          reference: reference.trim() || null,
          receivedAt: new Date().toISOString(),
        })
      }
    >
      <dl className="grid gap-1 rounded border border-ink-800 bg-ink-950 p-3 text-xs">
        <Figure label="Total payable" value={invoice.total ?? 0} strong />
        <Figure label="Already paid" value={invoice.allocated ?? 0} />
        <Figure label="Still outstanding" value={outstanding} tone="warn" />
      </dl>

      <Row>
        <MoneyInput label="Taking now" required value={amount} onChange={setAmount} />
        <SelectInput
          label="How"
          value={mode}
          onChange={setMode}
          options={PAYMENT_MODES.map((m) => ({ value: m, label: PAYMENT_MODE_LABELS[m] }))}
        />
      </Row>
      <TextInput label="Reference" value={reference} onChange={setReference} placeholder="UTR, UPI reference or cheque number" />

      <p className="text-2xs text-ink-500">
        {after > 0
          ? `A part payment: the receipt will say ₹${taking.toLocaleString('en-IN')} of ₹${(invoice.total ?? 0).toLocaleString('en-IN')}, leaving ₹${after.toLocaleString('en-IN')} owed.`
          : 'This clears the invoice, and the receipt will say so.'}
      </p>
      <p className="text-2xs text-ink-600">
        The invoice is not changed. A receipt is issued for what is paid.
      </p>
    </CreateModal>
  );
}
