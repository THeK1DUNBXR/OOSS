/**
 * Education and Delivery.
 *
 * Trainer scoping is a grant with a `batch_member` scope resolver, evaluated by
 * the same five-axis evaluator every other check goes through — not six
 * hard-coded role-slug comparisons in service code. The surface says so when
 * the narrowing is applied, so a trainer knows why their list is short.
 *
 * Guardian contact on a minor is regulated: it is structurally excluded from
 * the response shape for any viewer whose ceiling does not clear it, and a
 * permitted read produces an audit record naming the fields, never their values.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { date } from '../lib/api.js';
import { edu, type EnrollmentRow, type ProjectRow } from '../lib/educationApi.js';
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
import { DataTable, type DataTableColumn } from '../components/DataTable.js';
import { NewButton } from '../components/forms.js';
import { NewCohort, NewCourse, NewEnrollment } from '../components/createForms.js';
import { humanize } from '../lib/words.js';

export function Cohorts() {
  const [adding, setAdding] = useState<'cohort' | 'course' | null>(null);
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['cohorts'],
    queryFn: () => edu.cohorts(),
  });

  if (error) return <ErrorBox error={error} />;

  const scoped = data.some((c) => c.scopedToOwnBatches);

  return (
    <div>
      <NewCohort open={adding === 'cohort'} onClose={() => setAdding(null)} />
      <NewCourse open={adding === 'course'} onClose={() => setAdding(null)} />
      <PageHeader
        title="Training batches"
        subtitle="Each run of a course: dates, trainer, place, and how full it is."
        actions={
          <>
            <button className="btn" onClick={() => setAdding('course')}>
              + Course
            </button>
            <NewButton label="Start a batch" onClick={() => setAdding('cohort')} />
          </>
        }
      />

      {scoped && (
        <div className="mb-4 rounded-lg border border-accent/40 bg-accent/5 px-4 py-2.5">
          <p
            className="text-xs text-accent-soft"
            title="Narrowed by a batch_member scope resolver on your education grant, not a role check."
          >
            You're only seeing the batches you teach.
          </p>
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState message="No training batches you can see." />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.map((c) => (
            <Card
              key={c.id}
              title={c.name}
              subtitle={
                <span>
                  <span className="mono">{c.recordCode}</span> · {c.courseName}
                </span>
              }
              actions={<StatusChip status={humanize(c.status)} tone={c.status === 'active' ? 'good' : 'neutral'} />}
            >
              <dl className="grid grid-cols-2 gap-x-4">
                <Field label="Starts">{date(c.startDate)}</Field>
                <Field label="Ends">{date(c.endDate)}</Field>
                <Field label="Enrolled">
                  {c.enrolledCount} / {c.capacity}
                </Field>
                <Field label="At risk">
                  <span className={c.atRiskCount > 0 ? 'text-band-watch' : 'text-ink-300'}>{c.atRiskCount}</span>
                </Field>
              </dl>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function Enrollments() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'all' | 'at_risk'>('all');
  const [enrolling, setEnrolling] = useState(false);

  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['enrollments', tab],
    queryFn: () => edu.enrollments({ atRisk: tab === 'at_risk' }),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => edu.setEnrollmentStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['enrollments'] }),
  });

  if (error) return <ErrorBox error={error} />;

  const atRisk = data.filter((e) => e.atRisk).length;
  // One person on two batches is two enrolments and one student. Counting rows
  // and calling the answer "students" overstates the number of humans, which is
  // the figure anybody reading this page is actually after.
  const studentCount = new Set(data.map((e) => e.personId)).size;
  // Present only when the viewer's ceiling clears `regulated`; structurally
  // absent from the payload otherwise.
  const seesRegulated = data.some((e) => 'guardianPhone' in e);

  const columns: ReadonlyArray<DataTableColumn<EnrollmentRow>> = [
    { id: 'code', header: 'Code', sortValue: (e) => e.recordCode, cell: (e) => <RecordCode code={e.recordCode} /> },
    {
      id: 'student',
      header: 'Student',
      sortValue: (e) => e.personName,
      cell: (e) => (
        <>
          <Link to={`/education/enrollments/${e.id}`} className="text-xs text-ink-100 hover:text-accent-soft">
            {e.personName ?? '—'}
          </Link>
          {e.isMinor && (
            <span
              className="chip border-band-critical/40 text-band-critical"
              title="Guardian contact is DPDP-covered and read-audited."
            >
              minor
            </span>
          )}
        </>
      ),
    },
    {
      id: 'from',
      header: 'From',
      sortValue: (e) => e.institutionName,
      cellClassName: 'text-2xs',
      cell: (e) =>
        e.institutionName ? (
          <Link to={`/crm/institutions/${e.institutionId}`} className="text-ink-300 hover:text-accent-soft">
            {e.institutionName}
          </Link>
        ) : (
          <span className="text-ink-600" title="Not recruited through a college — a direct enrolment.">
            direct
          </span>
        ),
    },
    {
      id: 'batch',
      header: 'Batch',
      sortValue: (e) => e.cohortName,
      cellClassName: 'text-2xs text-ink-400',
      cell: (e) => (
        <>
          {e.cohortName}
          <p className="text-ink-600">{e.courseName}</p>
        </>
      ),
    },
    {
      id: 'progress',
      header: 'Progress',
      align: 'right',
      sortValue: (e) => e.progressPct,
      cellClassName: 'tabular-nums text-xs',
      cell: (e) => `${e.progressPct}%`,
    },
    {
      id: 'attendance',
      header: 'Attendance',
      align: 'right',
      sortValue: (e) => e.attendancePct,
      cellClassName: 'tabular-nums text-xs',
      cell: (e) => <span className={e.atRisk ? 'text-band-watch' : undefined}>{e.attendancePct}%</span>,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (e) => e.status,
      cell: (e) => (
        <>
          <StatusChip
            status={humanize(e.status)}
            tone={e.status === 'completed' ? 'good' : e.status === 'withdrawn' ? 'bad' : 'neutral'}
          />
          {e.atRisk && <p className="mt-0.5 text-2xs text-band-watch">at risk</p>}
        </>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      cellClassName: 'whitespace-nowrap',
      cell: (e) => (
        <>
          <Link className="btn-ghost" to={`/education/enrollments/${e.id}`}>
            Timeline
          </Link>
          {e.status === 'reserved' && (
            <button className="btn-ghost" onClick={() => setStatus.mutate({ id: e.id, status: 'confirmed' })}>
              Confirm
            </button>
          )}
          {e.status === 'active' && (
            <button className="btn-ghost" onClick={() => setStatus.mutate({ id: e.id, status: 'completed' })}>
              Complete
            </button>
          )}
        </>
      ),
    },
  ];

  return (
    <div>
      <NewEnrollment open={enrolling} onClose={() => setEnrolling(false)} />
      <PageHeader
        title="Enrolments"
        subtitle="Who is on which batch. Open one for that learner's day-by-day record."
        actions={<NewButton label="Enrol a student" onClick={() => setEnrolling(true)} />}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric
          label="Learners"
          value={studentCount}
          sub={data.length === studentCount ? undefined : `on ${data.length} enrolments`}
          drillTo="/education/enrollments"
        />
        <Metric
          label="At risk"
          value={atRisk}
          tone={atRisk > 0 ? 'warn' : 'good'}
          sub="Attendance below the threshold"
          drillTo="/exceptions"
        />
        <Metric
          label="Mean attendance"
          value={data.length ? `${Math.round(data.reduce((s, e) => s + e.attendancePct, 0) / data.length)}%` : '—'}
          drillTo="/education/cohorts"
        />
      </div>

      <Tabs
        tabs={[
          { key: 'all', label: 'All enrolments', count: data.length },
          { key: 'at_risk', label: 'At risk', count: atRisk },
        ]}
        active={tab}
        onChange={setTab}
      />

      {seesRegulated && (
        <div className="mb-3 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-2.5">
          <p className="text-xs text-band-critical">
            This view includes regulated guardian-contact fields. Each read produces an audit record naming the fields
            read — never their values.
          </p>
        </div>
      )}

      <Card bodyClassName="p-0">
        <DataTable
          caption="Enrolments: who is on which batch"
          columns={columns}
          rows={data}
          rowKey={(e) => e.id}
          loading={isLoading}
          emptyMessage="No students yet."
          emptyHint="A student joins a batch, and usually comes from a college."
        />
      </Card>
    </div>
  );
}

export function Projects() {
  const qc = useQueryClient();
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['projects'],
    queryFn: () => edu.projects(),
  });

  const accept = useMutation({
    mutationFn: (id: string) => edu.acceptProjectHandoff(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });

  if (error) return <ErrorBox error={error} />;

  const pending = data.filter((p) => p.handoffPending).length;

  const projectColumns: ReadonlyArray<DataTableColumn<ProjectRow>> = [
    { id: 'code', header: 'Code', sortValue: (p) => p.recordCode, cell: (p) => <RecordCode code={p.recordCode} /> },
    {
      id: 'project',
      header: 'Project',
      sortValue: (p) => p.name,
      cellClassName: 'text-xs text-ink-100',
      cell: (p) => p.name,
    },
    {
      id: 'account',
      header: 'Account',
      sortValue: (p) => p.organizationName,
      cellClassName: 'text-2xs text-ink-400',
      cell: (p) => p.organizationName ?? '—',
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (p) => p.status,
      cell: (p) => (
        <StatusChip
          status={humanize(p.status)}
          tone={p.status === 'delivered' ? 'good' : p.status === 'on_hold' ? 'warn' : 'neutral'}
        />
      ),
    },
    {
      id: 'variance',
      header: 'Schedule variance',
      align: 'right',
      sortValue: (p) => p.scheduleVariancePct,
      cellClassName: 'tabular-nums text-xs',
      cell: (p) => (
        <span className={Math.abs(p.scheduleVariancePct) > 10 ? 'text-band-watch' : undefined}>
          {p.scheduleVariancePct}%
        </span>
      ),
    },
    {
      id: 'health',
      header: 'Health',
      sortValue: (p) => p.healthBand,
      cell: (p) => <StatusChip status={humanize(p.healthBand)} tone={p.healthBand === 'stable' ? 'good' : 'warn'} />,
    },
    {
      id: 'handoff',
      header: <span className="sr-only">Handoff</span>,
      cell: (p) =>
        p.handoffPending && (
          <button className="btn-primary" onClick={() => accept.mutate(p.id)} disabled={accept.isPending}>
            Accept handoff
          </button>
        ),
    },
  ];

  return (
    <div>
      <PageHeader title="Projects" subtitle="Work that has been won, and is being delivered." />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Projects" value={data.length} drillTo="/delivery/projects" />
        <Metric
          label="Handoff pending"
          value={pending}
          tone={pending > 0 ? 'warn' : 'good'}
          sub="Deals that were won but which delivery has not picked up yet are flagged automatically"
          drillTo="/exceptions"
        />
        <Metric label="Active" value={data.filter((p) => p.status === 'active').length} drillTo="/delivery/projects" />
      </div>

      <Card bodyClassName="p-0">
        <DataTable
          caption="Projects delivered after award"
          columns={projectColumns}
          rows={data}
          rowKey={(p) => p.id}
          loading={isLoading}
          emptyMessage="No projects."
          emptyHint="Work that has been won and handed to delivery appears here."
        />
      </Card>
    </div>
  );
}
