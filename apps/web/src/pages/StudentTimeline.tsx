/**
 * One student, day by day.
 *
 * "What has gone on with this student" had an obvious answer and no screen.
 * Attendance was on its own page, daily progress existed in the schema with
 * nothing reading or writing it, and everything else — the question asked after
 * class, the complaint about the lab, the praise worth repeating to the next
 * cohort — had nowhere to live, so it stayed in somebody's head and left with
 * them.
 *
 * Three decisions about this page.
 *
 * **Open items are above the timeline.** A query nobody answered and a complaint
 * nobody closed are work, and work that is not visible does not get done. The
 * history is below them, because history is reference and work is now.
 *
 * **The merge happens on the server.** This page renders `days` as it is given
 * them. If the client merged attendance, scores and log entries itself, two
 * clients would merge differently and the answer to "what happened on the 14th"
 * would depend on which screen you asked.
 *
 * **Money is on the same page.** Whether they are turning up and whether they
 * have paid are asked together and used to live on screens that did not know
 * about each other.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LEARNER_LOG_KINDS,
  LEARNER_LOG_LABELS,
  LEARNER_LOG_SEVERITIES,
  PAYMENT_TYPE_LABELS,
  type LearnerLogKind,
  type LearnerTimelineView,
  type PaymentType,
  type TimelineEntryView,
} from '@kaizen/shared';
import { api, date, money, titleCase } from '../lib/api.js';
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
} from '../components/ui.js';
import { CreateModal, Row, SelectInput, TextArea, TextInput, messageOf } from '../components/forms.js';
import { InvoiceEditor } from '../components/invoiceEditor.js';

/** What each kind looks like in the margin. Glyphs, because the sidebar already uses them. */
const KIND_MARK: Record<string, string> = {
  attendance: '◷',
  progress: '↗',
  query: '?',
  feedback: '✦',
  issue: '⚠',
  note: '≡',
};

const KIND_TONE: Record<string, string> = {
  attendance: 'text-ink-400',
  progress: 'text-accent-soft',
  query: 'text-band-watch',
  feedback: 'text-band-strong',
  issue: 'text-band-critical',
  note: 'text-ink-400',
};

export function StudentTimeline() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [logging, setLogging] = useState<LearnerLogKind | null>(null);
  const [scoring, setScoring] = useState(false);
  const [billing, setBilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['learner-timeline', id],
    queryFn: () => api.get<LearnerTimelineView>(`/education/enrollments/${id}/timeline`),
    enabled: Boolean(id),
  });

  const resolve = useMutation({
    mutationFn: (logId: string) => api.post(`/education/learner-log/${logId}/resolve`, { status: 'resolved' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learner-timeline'] }),
    onError: (e) => setError(messageOf(e)),
  });

  const mark = useMutation({
    mutationFn: (status: string) =>
      api.post(`/education/enrollments/${id}/attendance`, {
        sessionDate: new Date().toISOString().slice(0, 10),
        status,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learner-timeline'] }),
    onError: (e) => setError(messageOf(e)),
  });

  if (loadError) return <ErrorBox error={loadError} />;
  if (isLoading || !data) return <Loading label="Loading the record" />;

  const e = data.enrollment;
  const owed = data.invoices.reduce((s, i) => s + Math.max(i.payable - i.allocated, 0), 0);

  return (
    <div>
      <PageHeader
        title={data.student?.name ?? e.recordCode}
        subtitle={`${e.courseName} (${e.courseCode}) · ${e.cohortName} · enrolment ${e.recordCode}${
          data.student?.phone ? ` · ${data.student.phone}` : ''
        }`}
        actions={
          <>
            <button className="btn" onClick={() => setScoring(true)}>
              Record progress
            </button>
            <button className="btn-primary" onClick={() => setLogging('note')}>
              + Timeline entry
            </button>
          </>
        }
      />

      <p className="mb-4 text-2xs text-ink-500">
        <Link to="/education/enrollments" className="hover:text-accent-soft">
          ← All students
        </Link>
      </p>

      {error && (
        <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
          {error}
        </p>
      )}

      {e.isMinor && (
        <div className="mb-4 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-2.5">
          <p className="text-xs text-band-critical">
            This student is a minor. Their timeline is classified restricted rather than internal — things written about a
            child are not ordinary operational notes, and reaching this page at all requires a clearance that covers it.
          </p>
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {/* A percentage with no sessions behind it is a number that reads as a
            measurement and is not one — the same reason a health score reads
            "not yet measured" rather than zero. */}
        <Metric
          label="Attendance"
          value={data.counts.sessions === 0 ? '—' : `${e.attendancePct}%`}
          tone={data.counts.sessions === 0 ? undefined : e.atRisk ? 'bad' : 'good'}
          sub={
            data.counts.sessions === 0
              ? 'no sessions recorded yet'
              : `${data.counts.present} of ${data.counts.sessions} sessions`
          }
        />
        <Metric
          label="Progress"
          value={data.days.some((d) => d.entries.some((x) => x.kind === 'progress')) ? `${e.progressPct}%` : '—'}
          sub="mean of the scores recorded"
        />
        <Metric
          label="Open queries"
          value={data.counts.openQueries}
          tone={data.counts.openQueries > 0 ? 'warn' : 'good'}
        />
        <Metric label="Open issues" value={data.counts.openIssues} tone={data.counts.openIssues > 0 ? 'bad' : 'good'} />
        <Metric
          label="Owed"
          value={money(owed)}
          tone={owed > 0 ? 'warn' : 'good'}
          sub={data.counts.meanRating !== null ? `feedback averages ${data.counts.meanRating}/5` : undefined}
        />
      </div>

      {/* ---- Mark today, and the four things that can be recorded ---------- */}
      <Card
        title="Record something"
        subtitle="Attendance for today, or anything that is not attendance. A query and an issue open and stay open; feedback and a note are complete as written."
      >
        <div className="flex flex-wrap gap-2">
          {['present', 'late', 'absent', 'excused'].map((status) => (
            <button key={status} className="btn" onClick={() => mark.mutate(status)} disabled={mark.isPending}>
              {titleCase(status)} today
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2 border-t border-ink-800 pt-3">
          {LEARNER_LOG_KINDS.map((kind) => (
            <button key={kind} className="btn" onClick={() => setLogging(kind)}>
              <span aria-hidden className={`mr-1 ${KIND_TONE[kind]}`}>
                {KIND_MARK[kind]}
              </span>
              {LEARNER_LOG_LABELS[kind]}
            </button>
          ))}
        </div>
      </Card>

      {/* ---- Everything still open ----------------------------------------- */}
      {data.open.length > 0 && (
        <Card
          className="mt-4"
          title={`Still open — ${data.open.length}`}
          subtitle="The part of this record that is work rather than history."
          bodyClassName="p-0 overflow-x-auto"
        >
          <table className="table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>What</th>
                <th>Severity</th>
                <th>Raised</th>
                <th className="text-right">Age</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.open.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className={`chip ${row.kind === 'issue' ? 'border-band-critical/40 text-band-critical' : 'border-band-watch/40 text-band-watch'}`}>
                      {LEARNER_LOG_LABELS[row.kind as LearnerLogKind] ?? row.kind}
                    </span>
                  </td>
                  <td className="text-xs text-ink-100">{row.title}</td>
                  <td className="text-2xs text-ink-400">{row.severity ?? '—'}</td>
                  <td className="text-2xs text-ink-400">{date(row.raisedOn)}</td>
                  <td className={`text-right tabular-nums text-2xs ${row.ageDays > 7 ? 'text-band-watch' : 'text-ink-500'}`}>
                    {row.ageDays}d
                  </td>
                  <td>
                    <button className="btn-ghost" onClick={() => resolve.mutate(row.id)} disabled={resolve.isPending}>
                      Resolve
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* ---- The fees ------------------------------------------------------ */}
      <Card
        className="mt-4"
        title="Fees"
        subtitle="Whether they are turning up and whether they have paid are asked together, so they are on one page."
        actions={
          <button className="btn-primary" onClick={() => setBilling(true)}>
            Raise a fee invoice
          </button>
        }
      >
        {data.invoices.length === 0 ? (
          <EmptyState message="Nothing invoiced yet." hint="A course fee can be billed in full or taken as instalments — the invoice says which." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Issued</th>
                <th className="text-right">Payable</th>
                <th className="text-right">Paid</th>
                <th className="text-right">Outstanding</th>
                <th>Document says</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((inv) => (
                <tr key={inv.id}>
                  <td>
                    <RecordCode code={inv.recordCode} />
                  </td>
                  <td className="text-2xs text-ink-400">{date(inv.issuedDate)}</td>
                  <td className="text-right tabular-nums text-xs">{money(inv.payable)}</td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">{money(inv.allocated)}</td>
                  <td
                    className={`text-right tabular-nums text-xs ${
                      inv.payable - inv.allocated > 0 ? 'text-band-watch' : 'text-band-strong'
                    }`}
                  >
                    {money(Math.max(inv.payable - inv.allocated, 0))}
                  </td>
                  <td className="text-2xs text-ink-300">
                    {PAYMENT_TYPE_LABELS[inv.paymentType as PaymentType] ?? inv.paymentType}
                    {inv.paymentMode ? <span className="text-ink-500"> · {titleCase(inv.paymentMode)}</span> : null}
                  </td>
                  <td>
                    <Link className="btn-ghost" to={`/finance/invoices/${inv.id}/document`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* ---- The timeline -------------------------------------------------- */}
      <h2 className="mb-3 mt-8 font-display text-sm uppercase tracking-wider text-ink-300">
        Day by day — {data.counts.entries} entries
      </h2>

      {data.days.length === 0 ? (
        <Card>
          <EmptyState
            message="Nothing recorded yet."
            hint="Mark attendance, record a score, or write down what they asked. All three land here in order."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {data.days.map((day) => (
            <Card key={day.day} title={date(day.day)} subtitle={`${day.entries.length} entr${day.entries.length === 1 ? 'y' : 'ies'}`}>
              <ul className="space-y-2">
                {day.entries.map((entry) => (
                  <TimelineRow key={entry.id} entry={entry} onResolve={(logId) => resolve.mutate(logId)} />
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}

      {logging && <LogEntry enrollmentId={id!} kind={logging} onClose={() => setLogging(null)} />}
      {scoring && <RecordProgress enrollmentId={id!} onClose={() => setScoring(false)} />}
      {/* The enrolment travels with it, so the fee is tied to this student's place
          on this course rather than to a description that happens to name it. */}
      <InvoiceEditor
        open={billing}
        personId={data.student?.id ?? null}
        enrollmentId={e.id}
        onClose={() => setBilling(false)}
      />
    </div>
  );
}

function TimelineRow({ entry, onResolve }: { entry: TimelineEntryView; onResolve: (logId: string) => void }) {
  const logId = entry.id.startsWith('log:') ? entry.id.slice(4) : null;
  return (
    <li className="flex gap-3 border-l-2 border-ink-800 pl-3">
      <span aria-hidden className={`mt-0.5 text-sm ${KIND_TONE[entry.kind] ?? 'text-ink-400'}`}>
        {KIND_MARK[entry.kind] ?? '·'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-xs text-ink-100">{entry.title}</span>
          <span className="chip border-ink-800 text-ink-500">{titleCase(entry.kind)}</span>
          {entry.rating !== null && <span className="text-2xs text-band-strong">{entry.rating}/5</span>}
          {entry.severity && entry.kind !== 'attendance' && (
            <span className={`text-2xs ${entry.severity === 'high' ? 'text-band-critical' : 'text-ink-500'}`}>
              {entry.severity}
            </span>
          )}
          {entry.status && entry.status !== 'resolved' && ['query', 'issue'].includes(entry.kind) && (
            <StatusChip status={entry.status} tone="warn" />
          )}
        </div>
        {entry.detail && <p className="mt-0.5 text-2xs text-ink-400">{entry.detail}</p>}
        {entry.resolutionNote && (
          <p className="mt-0.5 text-2xs text-band-strong">Resolved: {entry.resolutionNote}</p>
        )}
        <p className="mt-0.5 text-2xs text-ink-600">
          {entry.recordedBy ? `recorded by ${entry.recordedBy}` : 'recorded'}
          {entry.resolvedAt ? ` · closed ${date(entry.resolvedAt)}` : ''}
        </p>
      </div>
      {logId && entry.status && entry.status !== 'resolved' && (
        <button className="btn-ghost self-start" onClick={() => onResolve(logId)}>
          Resolve
        </button>
      )}
    </li>
  );
}

function LogEntry({
  enrollmentId,
  kind,
  onClose,
}: {
  enrollmentId: string;
  kind: LearnerLogKind;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [severity, setSeverity] = useState('medium');
  const [rating, setRating] = useState('5');

  const needsClosure = kind === 'query' || kind === 'issue';

  return (
    <CreateModal
      open
      title={`Record ${LEARNER_LOG_LABELS[kind].toLowerCase()}`}
      submitLabel="Record it"
      onClose={onClose}
      invalidate={[['learner-timeline'], ['learner-open']]}
      onSubmit={() =>
        api.post(`/education/enrollments/${enrollmentId}/log`, {
          kind,
          title,
          detail: detail.trim() || null,
          entryDate: new Date(entryDate).toISOString(),
          severity: needsClosure ? severity : null,
          rating: kind === 'feedback' ? Number(rating) : null,
        })
      }
    >
      <TextInput
        label="In one line"
        required
        autoFocus
        value={title}
        onChange={setTitle}
        placeholder={
          kind === 'query'
            ? 'Asked whether the certificate names the college'
            : kind === 'issue'
              ? 'Cannot access the lab environment from home'
              : kind === 'feedback'
                ? 'Found the first module well paced'
                : 'Working evenings, may miss Friday sessions'
        }
        hint="so the timeline reads without opening every row"
      />
      <TextArea label="What happened" value={detail} onChange={setDetail} rows={3} />
      <Row>
        <TextInput label="On which day" type="date" required value={entryDate} onChange={setEntryDate} />
        {needsClosure ? (
          <SelectInput
            label="How much it matters"
            value={severity}
            onChange={setSeverity}
            options={LEARNER_LOG_SEVERITIES.map((sv) => ({ value: sv, label: titleCase(sv) }))}
          />
        ) : kind === 'feedback' ? (
          <SelectInput
            label="Rating"
            value={rating}
            onChange={setRating}
            options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} / 5` }))}
          />
        ) : (
          <div />
        )}
      </Row>
      <p className="text-2xs text-ink-500">
        {needsClosure
          ? 'This opens and stays open until somebody closes it. A high-severity issue is also raised into the attention queue, so it is not left on a page somebody has to think to open.'
          : 'Complete as recorded — there is nothing to do about it, so it does not open.'}
      </p>
    </CreateModal>
  );
}

function RecordProgress({ enrollmentId, onClose }: { enrollmentId: string; onClose: () => void }) {
  const [progressDate, setProgressDate] = useState(new Date().toISOString().slice(0, 10));
  const [score, setScore] = useState('');
  const [note, setNote] = useState('');

  return (
    <CreateModal
      open
      title="Record a day's progress"
      submitLabel="Record it"
      onClose={onClose}
      invalidate={[['learner-timeline'], ['enrollments']]}
      onSubmit={() =>
        api.post(`/education/enrollments/${enrollmentId}/progress`, {
          progressDate: new Date(progressDate).toISOString(),
          score: score === '' ? null : Number(score),
          note: note.trim() || null,
        })
      }
    >
      <Row>
        <TextInput label="Which day" type="date" required value={progressDate} onChange={setProgressDate} />
        <TextInput label="Score out of 100" type="number" value={score} onChange={setScore} />
      </Row>
      <TextArea label="Note" value={note} onChange={setNote} rows={2} />
      <p className="text-2xs text-ink-500">
        One row per student per day, so correcting a score is a correction rather than a second row disagreeing with the
        first. The enrolment's headline progress is the mean of the scores recorded — never a field anybody keeps up to
        date by hand.
      </p>
    </CreateModal>
  );
}

/**
 * Every open query and complaint across every student the viewer can see.
 *
 * The per-student timeline answers "what happened to them". This answers "what is
 * outstanding", which is the question that gets work done — an unanswered query is
 * only work if it can be found without already knowing which student to look at.
 */
export function LearnerQueue() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data = [], isLoading, error: loadError } = useQuery({
    queryKey: ['learner-open'],
    queryFn: () => api.get<any[]>('/education/learner-log/open'),
  });

  const resolve = useMutation({
    mutationFn: (logId: string) => api.post(`/education/learner-log/${logId}/resolve`, { status: 'resolved' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learner-open'] }),
    onError: (e) => setError(messageOf(e)),
  });

  if (loadError) return <ErrorBox error={loadError} />;

  const issues = data.filter((r) => r.kind === 'issue');
  const stale = data.filter((r) => r.ageDays > 7);

  return (
    <div>
      <PageHeader
        title="Student queries and issues"
        subtitle="What students have asked and what has gone wrong for them, still open. A complaint nobody closed is work, and work that is not countable does not get done."
      />

      {error && (
        <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
          {error}
        </p>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Open" value={data.length} tone={data.length > 0 ? 'warn' : 'good'} />
        <Metric label="Issues" value={issues.length} tone={issues.length > 0 ? 'bad' : 'good'} />
        <Metric label="Older than a week" value={stale.length} tone={stale.length > 0 ? 'bad' : 'good'} />
      </div>

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState message="Nothing open." hint="Every question a student asked has an answer and every problem has been closed." />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Student</th>
                <th>Course</th>
                <th>What</th>
                <th>Severity</th>
                <th className="text-right">Age</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span
                      className={`chip ${
                        row.kind === 'issue' ? 'border-band-critical/40 text-band-critical' : 'border-band-watch/40 text-band-watch'
                      }`}
                    >
                      {LEARNER_LOG_LABELS[row.kind as LearnerLogKind] ?? row.kind}
                    </span>
                  </td>
                  <td className="text-xs text-ink-100">
                    <Link to={`/education/enrollments/${row.enrollmentId}`} className="hover:text-accent-soft">
                      {row.studentName ?? row.enrollmentCode}
                    </Link>
                  </td>
                  <td className="text-2xs text-ink-400">
                    {row.courseName}
                    <p className="text-ink-600">{row.cohortName}</p>
                  </td>
                  <td className="text-xs text-ink-200">
                    {row.title}
                    {row.detail && <p className="text-2xs text-ink-500">{row.detail}</p>}
                  </td>
                  <td className={`text-2xs ${row.severity === 'high' ? 'text-band-critical' : 'text-ink-400'}`}>
                    {row.severity ?? '—'}
                  </td>
                  <td className={`text-right tabular-nums text-2xs ${row.ageDays > 7 ? 'text-band-watch' : 'text-ink-500'}`}>
                    {row.ageDays}d
                  </td>
                  <td>
                    <button className="btn-ghost" onClick={() => resolve.mutate(row.id)} disabled={resolve.isPending}>
                      Resolve
                    </button>
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
