/**
 * Students — the people who take the courses.
 *
 * The list the product did not have. A learner used to be reachable only as
 * "a person who appears in an enrolment", which is why the question "how many
 * students do we have" had no screen to answer it, and why the only way to
 * invoice a walk-in was to invent a company for them.
 *
 * A student is a person carrying a student record, so Contacts still holds the
 * human and this holds what makes them a learner: their registration number,
 * the college they came from, where they are up to, and the state their tax is
 * charged in.
 */

import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, date } from '../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  PageHeader,
  RecordCode,
  StatusChip,
  Tabs,
} from '../components/ui.js';
import { NewStudent } from '../components/createForms.js';
import { useSession } from '../lib/session.js';

interface StudentRow {
  id: string;
  personId: string;
  recordCode: string;
  fullName: string;
  primaryPhone: string | null;
  primaryEmail: string | null;
  registrationNumber: string | null;
  status: string;
  address: string | null;
  placeOfSupply: string | null;
  gstin: string | null;
  institution: { id: string; name: string; recordCode: string } | null;
  enrolmentCount: number;
  createdAt: string;
}

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'accent' | 'warn'> = {
  prospective: 'neutral',
  active: 'accent',
  alumni: 'good',
  withdrawn: 'warn',
};

const STATUS_LABEL: Record<string, string> = {
  prospective: 'Enquiring',
  active: 'On a course',
  alumni: 'Finished',
  withdrawn: 'Left',
};

export function Students() {
  const { can } = useSession();
  const [tab, setTab] = useState<'all' | 'active' | 'prospective' | 'alumni'>('all');
  const [q, setQ] = useState('');
  // `?new=1` opens the form on arrival, so a button elsewhere saying "Add a
  // student" adds one rather than landing somebody on a list.
  const [search, setSearch] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(() => search.get('new') === '1');
  useEffect(() => {
    if (search.get('new') !== '1') return;
    setCreateOpen(true);
    const rest = new URLSearchParams(search);
    rest.delete('new');
    setSearch(rest, { replace: true });
  }, [search, setSearch]);

  const params = new URLSearchParams();
  if (tab !== 'all') params.set('status', tab);
  if (q) params.set('q', q);

  const { data, isLoading, error } = useQuery({
    queryKey: ['students', tab, q],
    queryFn: () => api.get<{ items: StudentRow[]; total: number }>(`/crm/students?${params}`),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Students"
        subtitle="Everyone who takes a course with us. One record per learner — their registration number, where they came from, and what they are on."
        actions={
          can('students:C') && (
            <button className="btn-primary" onClick={() => setCreateOpen(true)}>
              Add a student
            </button>
          )
        }
      />

      <div className="mb-3">
        <input
          className="input max-w-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, registration number or phone…"
        />
      </div>

      <Tabs
        tabs={[
          { key: 'all', label: 'All', count: data?.total },
          { key: 'active', label: 'On a course' },
          { key: 'prospective', label: 'Enquiring' },
          { key: 'alumni', label: 'Finished' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState
            message={q ? 'No students match what you searched for.' : 'No students yet.'}
            hint={
              q
                ? undefined
                : 'Add the learners you are teaching. A student can then be enrolled on a course and invoiced in their own name, without inventing a company for them.'
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((s) => (
            <Link
              key={s.id}
              to={`/crm/students/${s.id}`}
              className="card block p-4 transition-colors hover:border-ink-600"
            >
              <div className="flex items-start justify-between gap-2">
                <RecordCode code={s.recordCode} />
                <StatusChip status={STATUS_LABEL[s.status] ?? s.status} tone={STATUS_TONE[s.status] ?? 'neutral'} />
              </div>
              <p className="mt-1.5 text-sm font-medium text-ink-100">{s.fullName}</p>
              {s.registrationNumber && <p className="mono truncate text-2xs">{s.registrationNumber}</p>}

              <p className="mt-2 text-2xs text-ink-500">
                {[s.primaryPhone, s.primaryEmail].filter(Boolean).join(' · ') || 'No contact details on file'}
              </p>
              <p className="mt-1 text-2xs text-ink-500">
                {s.institution ? `From ${s.institution.name}` : 'Came to us directly'}
                {s.enrolmentCount > 0 &&
                  ` · ${s.enrolmentCount} course${s.enrolmentCount === 1 ? '' : 's'}`}
              </p>
            </Link>
          ))}
        </div>
      )}

      <NewStudent open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

export function StudentDetail() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['student', id],
    queryFn: () => api.get<StudentRow>(`/crm/students/${id}`),
    enabled: Boolean(id),
  });

  // Their courses, their attendance and their day-by-day record live on the
  // enrolment timeline, which is its own screen. This page is about who they
  // are; it links there rather than reproducing it badly.
  const enrolments = useQuery({
    queryKey: ['enrollments', 'person', data?.personId],
    queryFn: () =>
      api.get<Array<{ id: string; recordCode: string; cohortName: string; courseName: string; status: string; enrolledAt: string | null }>>(
        `/education/enrollments?personId=${data!.personId}`,
      ),
    enabled: Boolean(data?.personId),
    // An employee raises invoices and does not read the class register, so this
    // is a 403 for them rather than an outage. The panel says so instead of
    // showing an empty list, because "none" and "not for you" are different
    // answers.
    retry: false,
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  return (
    <div>
      <PageHeader title={data.fullName} subtitle={<span className="mono">{data.recordCode}</span>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="chip border-accent/40 text-accent-soft">Student</span>
        <StatusChip status={STATUS_LABEL[data.status] ?? data.status} tone={STATUS_TONE[data.status] ?? 'neutral'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card
            title="Courses"
            subtitle="Every place they have held on a course. The day-by-day record — attendance, progress, queries — is on the enrolment itself."
            bodyClassName="p-0"
          >
            {enrolments.error ? (
              <div className="p-4">
                <EmptyState
                  message="Their courses are not visible to you."
                  hint="Reading the class register needs a grant on education. Raising an invoice does not, which is why you can see the rest of this page."
                />
              </div>
            ) : !enrolments.data?.length ? (
              <div className="p-4">
                <EmptyState
                  message="Not enrolled on anything yet."
                  hint="Enrol them from Courses, then their attendance and progress appear against that place."
                />
              </div>
            ) : (
              <ul className="divide-y divide-ink-850">
                {enrolments.data.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div>
                      <Link to={`/education/enrollments/${e.id}`} className="text-xs text-ink-200 hover:text-accent-soft">
                        {e.courseName ?? e.cohortName}
                      </Link>
                      <p className="text-2xs text-ink-500">
                        <span className="mono">{e.recordCode}</span>
                        {e.enrolledAt && ` · joined ${date(e.enrolledAt)}`}
                      </p>
                    </div>
                    <StatusChip status={e.status} tone={e.status === 'completed' ? 'good' : 'neutral'} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="The student">
            <dl>
              <Field label="Registration number">{data.registrationNumber ?? '—'}</Field>
              <Field label="Phone">{data.primaryPhone ?? '—'}</Field>
              <Field label="Email">{data.primaryEmail ?? '—'}</Field>
              <Field label="Came from">
                {data.institution ? (
                  <Link to={`/crm/institutions/${data.institution.id}`} className="hover:text-accent-soft">
                    {data.institution.name}
                  </Link>
                ) : (
                  'Directly — no college'
                )}
              </Field>
              <Field label="On file since">{date(data.createdAt)}</Field>
            </dl>
          </Card>

          <Card
            title="How they are billed"
            subtitle="Entered once here rather than on every invoice: the state decides how the tax splits."
          >
            <dl>
              <Field label="State">{data.placeOfSupply ?? '—'}</Field>
              <Field label="Address">{data.address ?? '—'}</Field>
              <Field label="GSTIN">
                {data.gstin ?? <span className="text-ink-500">None — billed as an individual</span>}
              </Field>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
