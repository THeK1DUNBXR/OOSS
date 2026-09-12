/**
 * The course catalogue.
 *
 * A course used to be creatable and then permanent — no edit, no retire, no
 * price. That is the wrong shape for a catalogue: a fee goes up, a programme
 * lengthens, a course stops being sold, and a list that can only be appended to
 * fills with rows nobody dares touch.
 *
 * The price is on the card rather than hidden in an edit form, because this page
 * is read as a price list at least as often as it is read as a syllabus. What a
 * customer actually pays — fee plus tax — is shown beside the fee, since that is
 * the number somebody at a counter says out loud.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GST_RATES, type CourseView } from '@kaizen/shared';
import { api, money } from '../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Metric,
  PageHeader,
  RecordCode,
  StatusChip,
  Tabs,
} from '../components/ui.js';
import { CreateModal, MoneyInput, NewButton, Row, SelectInput, TextArea, TextInput, messageOf } from '../components/forms.js';

export function Courses() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'selling' | 'all'>('selling');
  const [editing, setEditing] = useState<CourseView | null>(null);
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState<CourseView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data = [], isLoading, error: loadError } = useQuery({
    queryKey: ['courses', tab],
    queryFn: () => api.get<CourseView[]>(`/education/courses${tab === 'all' ? '?includeRetired=true' : ''}`),
  });

  const retire = useMutation({
    mutationFn: (id: string) => api.post(`/education/courses/${id}/retire`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['courses'] }),
    onError: (e) => setError(messageOf(e)),
  });
  const reactivate = useMutation({
    mutationFn: (id: string) => api.patch(`/education/courses/${id}`, { active: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['courses'] }),
    onError: (e) => setError(messageOf(e)),
  });

  if (loadError) return <ErrorBox error={loadError} />;

  const priced = data.filter((c) => c.feeAmount !== null).length;
  const unpriced = data.filter((c) => c.active && c.feeAmount === null);

  return (
    <div>
      <PageHeader
        title="Courses"
        subtitle="What we teach and what it costs. A course carries its fee, its tax rate and its SAC, so raising an invoice for one does not mean knowing the price list."
        actions={<NewButton label="Add a course" onClick={() => setCreating(true)} />}
      />

      <CourseForm open={creating} onClose={() => setCreating(false)} />
      <CourseForm open={Boolean(editing)} course={editing} onClose={() => setEditing(null)} />
      {assigning && <AssignCourse course={assigning} onClose={() => setAssigning(null)} />}

      {error && (
        <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
          {error}
        </p>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Courses" value={data.length} />
        <Metric label="Priced" value={`${priced} of ${data.length}`} tone={unpriced.length ? 'warn' : 'good'} />
        <Metric label="Students" value={data.reduce((s, c) => s + c.enrolledCount, 0)} drillTo="/education/enrollments" />
      </div>

      {unpriced.length > 0 && (
        <div className="mb-4 rounded-lg border border-band-watch/40 bg-band-watch/5 px-4 py-2.5">
          <p className="text-xs text-band-watch">
            {unpriced.length} course{unpriced.length === 1 ? ' has' : 's have'} no fee set, so a line billing{' '}
            {unpriced.length === 1 ? 'it' : 'them'} has to be priced by hand every time:{' '}
            {unpriced.map((c) => c.code).join(', ')}.
          </p>
        </div>
      )}

      <Tabs
        tabs={[
          { key: 'selling' as const, label: 'On offer', count: data.filter((c) => c.active).length },
          { key: 'all' as const, label: 'Including retired' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState
            message="No courses yet."
            hint="A course is the syllabus and the price. A batch is one run of it, with dates and people."
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.map((c) => (
            <Card
              key={c.id}
              title={c.name}
              subtitle={
                <span>
                  <span className="mono">{c.code}</span> · <RecordCode code={c.recordCode} />
                </span>
              }
              actions={
                <StatusChip status={c.active ? 'on offer' : 'retired'} tone={c.active ? 'good' : 'neutral'} />
              }
            >
              {c.description && <p className="mb-3 text-2xs text-ink-400">{c.description}</p>}
              <dl className="grid grid-cols-2 gap-x-4">
                <Field label="Fee">{c.feeAmount === null ? <span className="text-band-watch">not set</span> : money(c.feeAmount)}</Field>
                <Field label="With tax">{c.feeWithTax === null ? '—' : money(c.feeWithTax)}</Field>
                <Field label="GST">{c.gstRate ?? 0}%</Field>
                <Field label="SAC">{c.hsnSac ?? <span className="text-band-watch">not set</span>}</Field>
                <Field label="Length">{c.durationWeeks ? `${c.durationWeeks} weeks` : '—'}</Field>
                <Field label="Students">
                  <Link to="/education/enrollments" className="hover:text-accent-soft">
                    {c.enrolledCount} on {c.batchCount} batch{c.batchCount === 1 ? '' : 'es'}
                  </Link>
                </Field>
              </dl>

              <div className="mt-3 flex flex-wrap gap-2 border-t border-ink-800 pt-3">
                <button className="btn" onClick={() => setEditing(c)}>
                  Edit
                </button>
                {c.active && (
                  <button className="btn-primary" onClick={() => setAssigning(c)}>
                    Assign a student
                  </button>
                )}
                {c.active ? (
                  <button className="btn-quiet" onClick={() => retire.mutate(c.id)} disabled={retire.isPending}>
                    Retire
                  </button>
                ) : (
                  <button className="btn-quiet" onClick={() => reactivate.mutate(c.id)} disabled={reactivate.isPending}>
                    Put back on offer
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <p className="mt-4 text-2xs text-ink-600">
        Retiring a course is never a delete: students hold enrolments on courses withdrawn years ago and their record has
        to keep reading correctly. A retired course stops being billable and disappears from the pickers.
      </p>
    </div>
  );
}

/** Add or edit. The same fields either way, because a catalogue row has one shape. */
function CourseForm({
  open,
  course,
  onClose,
}: {
  open: boolean;
  course?: CourseView | null;
  onClose: () => void;
}) {
  const editing = Boolean(course);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [durationWeeks, setWeeks] = useState('');
  const [feeAmount, setFee] = useState('');
  const [gstRate, setGstRate] = useState('18');
  const [hsnSac, setHsnSac] = useState('999293');
  const [division, setDivision] = useState('education');

  useEffect(() => {
    if (!open) return;
    setName(course?.name ?? '');
    setCode(course?.code ?? '');
    setDescription(course?.description ?? '');
    setWeeks(course?.durationWeeks ? String(course.durationWeeks) : '');
    setFee(course?.feeAmount !== null && course?.feeAmount !== undefined ? String(course.feeAmount) : '');
    setGstRate(String(course?.gstRate ?? 18));
    setHsnSac(course?.hsnSac ?? '999293');
    setDivision(course?.division ?? 'education');
  }, [open, course]);

  const body = () => ({
    name,
    code: code || name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 16),
    description: description.trim() || null,
    durationWeeks: durationWeeks ? Number(durationWeeks) : null,
    feeAmount: feeAmount === '' ? null : Number(feeAmount),
    gstRate: Number(gstRate),
    hsnSac: hsnSac.trim() || null,
    division,
  });

  return (
    <CreateModal
      open={open}
      title={editing ? `Edit ${course!.code}` : 'Add a course'}
      submitLabel={editing ? 'Save it' : 'Add it'}
      onClose={onClose}
      invalidate={[['courses']]}
      onSubmit={() => (editing ? api.patch(`/education/courses/${course!.id}`, body()) : api.post('/education/courses', body()))}
    >
      <Row>
        <TextInput label="Name" required autoFocus value={name} onChange={setName} placeholder="Full Stack Development" />
        <TextInput label="Code" hint="made from the name if blank" value={code} onChange={setCode} placeholder="FSD-24" />
      </Row>
      <TextArea label="What it covers" value={description} onChange={setDescription} rows={2} />
      <Row>
        <TextInput label="Length (weeks)" type="number" value={durationWeeks} onChange={setWeeks} />
        <SelectInput
          label="Division"
          value={division}
          onChange={setDivision}
          options={[
            { value: 'education', label: 'Education' },
            { value: 'skill', label: 'Skill Development' },
            { value: 'software', label: 'Software' },
            { value: 'shared', label: 'Shared' },
          ]}
        />
      </Row>
      <Row>
        <MoneyInput label="Fee before tax" value={feeAmount} onChange={setFee} hint="what a seat costs" />
        <SelectInput
          label="GST rate"
          value={gstRate}
          onChange={setGstRate}
          options={GST_RATES.map((r) => ({ value: String(r), label: `${r}%` }))}
        />
      </Row>
      <TextInput
        label="SAC"
        value={hsnSac}
        onChange={setHsnSac}
        placeholder="999293"
        hint="999293 is commercial training and coaching"
      />
      <p className="text-2xs text-ink-500">
        These three are why an employee can raise a correct tax invoice for a course without knowing the price list or
        the tax code. A fee change applies from now on — invoices already raised keep their own copy of the price, which
        is what reprinting an old one shows.
      </p>
    </CreateModal>
  );
}

/**
 * Putting a customer on a course.
 *
 * With no batch named the course's rolling intake is used — a real batch, created
 * on first use, because a walk-in genuinely has none and inventing one per person
 * would report sixty batches of one.
 */
export function AssignCourse({
  course,
  personId,
  onClose,
}: {
  course: CourseView;
  /** Pre-selected, when assigning from a customer's own page. */
  personId?: string | null;
  onClose: () => void;
}) {
  const people = useQuery({
    queryKey: ['people-picker'],
    queryFn: () => api.get<any>('/crm/people?pageSize=200'),
  });
  const colleges = useQuery({
    queryKey: ['colleges'],
    queryFn: () => api.get<any>('/crm/institutions?pageSize=200'),
  });

  const rows = <T,>(data: unknown): T[] =>
    Array.isArray(data) ? (data as T[]) : Array.isArray((data as any)?.items) ? ((data as any).items as T[]) : [];

  const [who, setWho] = useState<'new' | 'existing'>(personId ? 'existing' : 'new');
  const [existingId, setExistingId] = useState(personId ?? '');
  const [fullName, setFullName] = useState('');
  const [primaryPhone, setPhone] = useState('');
  const [primaryEmail, setEmail] = useState('');
  const [cohortId, setCohortId] = useState('');
  const [institutionId, setInstitutionId] = useState('');
  const [isMinor, setIsMinor] = useState(false);
  const [guardianName, setGuardianName] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');

  return (
    <CreateModal
      open
      title={`Assign ${course.name}`}
      submitLabel="Assign it"
      onClose={onClose}
      invalidate={[['enrollments'], ['courses'], ['cohorts'], ['people']]}
      onSubmit={() =>
        api.post(`/education/courses/${course.id}/assign`, {
          cohortId: cohortId || null,
          ...(who === 'existing'
            ? { personId: existingId }
            : { fullName, primaryPhone: primaryPhone || null, primaryEmail: primaryEmail || null }),
          institutionId: institutionId || null,
          isMinor,
          guardianName: guardianName || null,
          guardianPhone: guardianPhone || null,
        })
      }
    >
      <div className="flex gap-2">
        {(
          [
            ['existing', 'Somebody already on file'],
            ['new', 'Somebody new'],
          ] as Array<['existing' | 'new', string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setWho(value)}
            className={`chip transition-colors ${
              who === value ? 'border-accent/60 text-accent-soft' : 'border-ink-800 text-ink-500 hover:border-ink-600'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {who === 'existing' ? (
        <SelectInput
          label="Which person"
          required
          value={existingId}
          onChange={setExistingId}
          placeholder={rows(people.data).length ? 'Search the contacts on file' : 'Nobody on file yet'}
          options={rows<{ id: string; fullName: string; primaryPhone?: string | null }>(people.data).map((p) => ({
            value: p.id,
            label: p.primaryPhone ? `${p.fullName} — ${p.primaryPhone}` : p.fullName,
          }))}
          hint="they keep their record and gain a student role on it"
        />
      ) : (
        <>
          <TextInput label="Name" required autoFocus value={fullName} onChange={setFullName} />
          <Row>
            <TextInput label="Phone" type="tel" value={primaryPhone} onChange={setPhone} />
            <TextInput label="Email" type="email" value={primaryEmail} onChange={setEmail} />
          </Row>
        </>
      )}

      <SelectInput
        label="Batch"
        value={cohortId}
        onChange={setCohortId}
        placeholder="The course's rolling intake"
        options={course.cohorts.map((h) => ({
          value: h.id,
          label: `${h.name} — ${h.enrolledCount}/${h.capacity} seats`,
        }))}
        hint="leave blank for somebody joining whenever they joined"
      />
      <SelectInput
        label="Which college are they from"
        value={institutionId}
        onChange={setInstitutionId}
        placeholder="Not from a college"
        options={rows<{ id: string; name: string }>(colleges.data).map((c) => ({ value: c.id, label: c.name }))}
        hint="leave blank for a direct enrolment"
      />

      <label className="flex items-center gap-2 text-sm text-ink-200">
        <input type="checkbox" checked={isMinor} onChange={(e) => setIsMinor(e.target.checked)} />
        Under 18
      </label>
      {isMinor && (
        <Row>
          <TextInput label="Guardian name" value={guardianName} onChange={setGuardianName} />
          <TextInput label="Guardian phone" required type="tel" value={guardianPhone} onChange={setGuardianPhone} />
        </Row>
      )}

      <p className="text-2xs text-ink-500">
        Assigning a course starts the student's timeline: attendance, weekly scores, their questions, their feedback and
        anything that goes wrong all hang off this enrolment.
        {course.feeAmount !== null && ' The fee can be invoiced from their own page afterwards, in full or in part.'}
      </p>
    </CreateModal>
  );
}
