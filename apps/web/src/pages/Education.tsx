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
import { api, date, relative, titleCase } from '../lib/api.js';
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
import { NewButton } from '../components/forms.js';
import { NewCohort, NewCourse, NewEnrollment } from '../components/createForms.js';

export function Cohorts() {
  const [adding, setAdding] = useState<'cohort' | 'course' | null>(null);
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['cohorts'],
    queryFn: () => api.get<any[]>('/education/cohorts'),
  });

  if (error) return <ErrorBox error={error} />;

  const scoped = data.some((c) => c.scopedToOwnBatches);

  return (
    <div>
      <NewCohort open={adding === 'cohort'} onClose={() => setAdding(null)} />
      <NewCourse open={adding === 'course'} onClose={() => setAdding(null)} />
      <PageHeader
        title="Training batches"
        subtitle="Each run of a course: when it goes, who teaches it, where it happens and how full it is. Trainers see the batches they teach and no others."
        actions={
          <>
            <button className="btn" onClick={() => setAdding('course')}>+ Course</button>
            <NewButton label="Start a batch" onClick={() => setAdding('cohort')} />
          </>
        }
      />

      {scoped && (
        <div className="mb-4 rounded-lg border border-accent/40 bg-accent/5 px-4 py-2.5">
          <p className="text-xs text-accent-soft">
            Your view is narrowed to your own batches by a <span className="font-mono">batch_member</span> scope
            resolver on your education grant — not by a role check in service code.
          </p>
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card><EmptyState message="No training batches you can see." /></Card>
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
              actions={<StatusChip status={c.status} tone={c.status === 'active' ? 'good' : 'neutral'} />}
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

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['enrollments', tab],
    queryFn: () => api.get<any[]>(`/education/enrollments${tab === 'at_risk' ? '?atRisk=true' : ''}`),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.post(`/education/enrollments/${id}/status`, { status }),
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

  return (
    <div>
      <NewEnrollment open={enrolling} onClose={() => setEnrolling(false)} />
      <PageHeader
        title="Students"
        subtitle="Who is on which batch, and which college they came from. Open a student for their day-by-day record: attendance, weekly scores, the questions they asked, the feedback they gave and anything that went wrong."
        actions={<NewButton label="Enrol a student" onClick={() => setEnrolling(true)} />}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric
          label="Students"
          value={studentCount}
          sub={data.length === studentCount ? undefined : `on ${data.length} enrolments`}
          drillTo="/education/enrollments"
        />
        <Metric label="At risk" value={atRisk} tone={atRisk > 0 ? 'warn' : 'good'} sub="Attendance below the threshold" drillTo="/exceptions" />
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

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState
            message="No students yet."
            hint="A student joins a batch, and usually comes from a college — which is what makes the college relationship measurable."
          />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Student</th>
                <th>From</th>
                <th>Batch</th>
                <th className="text-right">Progress</th>
                <th className="text-right">Attendance</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id}>
                  <td><RecordCode code={e.recordCode} /></td>
                  <td>
                    <Link to={`/education/enrollments/${e.id}`} className="text-xs text-ink-100 hover:text-accent-soft">
                      {e.personName ?? '—'}
                    </Link>
                    {e.isMinor && (
                      <span className="chip border-band-critical/40 text-band-critical" title="Guardian contact is DPDP-covered and read-audited.">
                        minor
                      </span>
                    )}
                  </td>
                  <td className="text-2xs">
                    {e.institutionName ? (
                      <Link to={`/crm/accounts/${e.institutionId}`} className="text-ink-300 hover:text-accent-soft">
                        {e.institutionName}
                      </Link>
                    ) : (
                      <span className="text-ink-600" title="Not recruited through a college — a direct enrolment.">
                        direct
                      </span>
                    )}
                  </td>
                  <td className="text-2xs text-ink-400">
                    {e.cohortName}
                    <p className="text-ink-600">{e.courseName}</p>
                  </td>
                  <td className="text-right tabular-nums text-xs">{e.progressPct}%</td>
                  <td className={`text-right tabular-nums text-xs ${e.atRisk ? 'text-band-watch' : ''}`}>{e.attendancePct}%</td>
                  <td>
                    <StatusChip
                      status={e.status}
                      tone={e.status === 'completed' ? 'good' : e.status === 'withdrawn' ? 'bad' : 'neutral'}
                    />
                    {e.atRisk && <p className="mt-0.5 text-2xs text-band-watch">at risk</p>}
                  </td>
                  <td className="whitespace-nowrap">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

export function Projects() {
  const qc = useQueryClient();
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<any[]>('/education/projects'),
  });

  const accept = useMutation({
    mutationFn: (id: string) => api.post(`/education/projects/${id}/accept-handoff`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });

  if (error) return <ErrorBox error={error} />;

  const pending = data.filter((p) => p.handoffPending).length;

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Post-award delivery state lives here, not in a repurposed opportunity stage. This is the record a project manager actually needs."
      />

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

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card><EmptyState message="No projects." /></Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Project</th>
                <th>Account</th>
                <th>Status</th>
                <th className="text-right">Schedule variance</th>
                <th>Health</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td><RecordCode code={p.recordCode} /></td>
                  <td className="text-xs text-ink-100">{p.name}</td>
                  <td className="text-2xs text-ink-400">{p.organizationName ?? '—'}</td>
                  <td><StatusChip status={p.status} tone={p.status === 'delivered' ? 'good' : p.status === 'on_hold' ? 'warn' : 'neutral'} /></td>
                  <td className={`text-right tabular-nums text-xs ${Math.abs(p.scheduleVariancePct) > 10 ? 'text-band-watch' : ''}`}>
                    {p.scheduleVariancePct}%
                  </td>
                  <td><StatusChip status={p.healthBand} tone={p.healthBand === 'stable' ? 'good' : 'warn'} /></td>
                  <td>
                    {p.handoffPending && (
                      <button className="btn-primary" onClick={() => accept.mutate(p.id)} disabled={accept.isPending}>
                        Accept handoff
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
