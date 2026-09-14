/**
 * People.
 *
 * Six surfaces over Canon §14: the establishment, leave, attendance, payroll,
 * hiring and capability.
 *
 * None of them contains a copy of a lifecycle. Every record arrives carrying
 * `availableTransitions` computed by the same machine the API enforces
 * against, so the buttons on a row are exactly the transitions that exist from
 * where it stands. A surface that decided for itself which actions to show
 * would go stale the moment a diagram changed, and would be wrong in the
 * direction that matters — offering an action that will be refused.
 *
 * Money is withheld, never zeroed. A viewer without the pay grant gets null
 * from the server and sees a lock, because a zero beside somebody's name reads
 * as a fact about their salary rather than about the reader's permissions.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, money, relative, titleCase } from '../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Metric,
  Modal,
  PageHeader,
  RecordCode,
  StatusChip,
  Tabs,
  Withheld,
} from '../components/ui.js';
import { NewButton } from '../components/forms.js';
import { EditEmployeeProfile, NewLeaveRequest, NewRequisition, NewSkill, ProposeCompensation } from '../components/createForms.js';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** `ROUTE_FOR_APPROVAL` is not a thing to put on a button. */
function actionLabel(event: string): string {
  return titleCase(event.toLowerCase().replace(/_/g, ' '));
}

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  Active: 'good',
  Approved: 'good',
  Completed: 'good',
  Effective: 'good',
  Achieved: 'good',
  Joined: 'good',
  Filled: 'good',
  Disbursed: 'good',
  Confirmed: 'good',
  OnLeave: 'warn',
  PendingApproval: 'warn',
  UnderReview: 'warn',
  AtRisk: 'warn',
  Disputed: 'warn',
  OnHold: 'warn',
  BlockedEscalated: 'warn',
  BlockedDisputed: 'warn',
  Suspended: 'bad',
  Absconded: 'bad',
  Terminated: 'bad',
  Rejected: 'bad',
  NoShow: 'bad',
  OfferRescinded: 'bad',
  Missed: 'bad',
};

function tone(status: string) {
  return STATUS_TONE[status] ?? 'neutral';
}

/**
 * The actions available on a record, from the record itself.
 *
 * A denial still comes from the server — this only decides what is worth
 * offering, not what is allowed. The two are different questions and the
 * client is only permitted to answer the first.
 */
function Transitions({
  collection,
  id,
  events,
  invalidate,
  needsNote = [],
}: {
  collection: string;
  id: string;
  events: string[];
  invalidate: string[];
  /** Events the server will refuse without a reason. */
  needsNote?: string[];
}) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: (body: { event: string; note?: string }) =>
      api.post(`/hr/${collection}/${id}/transition`, body),
    onSuccess: () => {
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: [key] });
      setPending(null);
      setNote('');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'That did not go through'),
  });

  if (events.length === 0) {
    return <span className="text-2xs text-ink-500">Nothing further — this is where it ends.</span>;
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {events.map((event) => (
          <button
            key={event}
            className="btn-ghost btn-sm"
            disabled={run.isPending}
            onClick={() => {
              if (needsNote.includes(event)) setPending(event);
              else run.mutate({ event });
            }}
          >
            {actionLabel(event)}
          </button>
        ))}
      </div>

      {error && <p className="mt-1.5 text-2xs font-semibold text-band-critical">{error}</p>}

      <Modal
        open={pending !== null}
        title={pending ? actionLabel(pending) : ''}
        onClose={() => setPending(null)}
        footer={
          <>
            <button className="btn-ghost btn-sm" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button
              className="btn-primary btn-sm"
              disabled={!note.trim() || run.isPending}
              onClick={() => run.mutate({ event: pending!, note })}
            >
              Record it
            </button>
          </>
        }
      >
        <label className="label">Why</label>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        <p className="mt-1.5 text-2xs text-ink-500">
          Kept with the record.
        </p>
      </Modal>
    </>
  );
}

/** A money cell that says "withheld" rather than showing a misleading zero. */
function Money({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <Withheld reason="no_permission" />;
  return <span className="num">{money(value)}</span>;
}

const DIVISION_STYLE: Record<string, string> = {
  software: 'bg-div-software',
  skill: 'bg-div-skill',
  education: 'bg-div-education',
  shared: 'bg-div-shared',
};

function Division({ division }: { division: string | null }) {
  if (!division) return <span className="text-ink-500">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
      <span className={`h-2 w-2 rounded-full ${DIVISION_STYLE[division] ?? 'bg-div-shared'}`} />
      {titleCase(division)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

interface EmployeeRow {
  id: string;
  recordCode: string;
  personId: string;
  fullName: string;
  primaryEmail: string | null;
  status: string;
  confirmationState: string;
  hireEffectiveDate: string;
  legalEntity: string;
  jobTitle: string | null;
  orgUnit: string | null;
  division: string | null;
  availableTransitions: string[];
}

interface DivisionHeadcount {
  division: string;
  headcount: number;
  monthlyCost: number | null;
}

export function Employees() {
  const [status, setStatus] = useState<string>('all');

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['hr-employees'],
    queryFn: () => api.get<EmployeeRow[]>('/hr/employees'),
  });

  const { data: byDivision = [] } = useQuery({
    queryKey: ['hr-headcount'],
    queryFn: () => api.get<DivisionHeadcount[]>('/hr/headcount-by-division'),
  });

  if (error) return <ErrorBox error={error} />;

  const onBooks = data.filter((e) => ['Active', 'OnLeave', 'Suspended', 'NoticePeriod'].includes(e.status));
  const probation = onBooks.filter((e) => e.confirmationState === 'in_probation');
  const leaving = data.filter((e) => e.status === 'NoticePeriod');
  const costKnown = byDivision.some((d) => d.monthlyCost !== null);
  const monthlyCost = byDivision.reduce((s, d) => s + (d.monthlyCost ?? 0), 0);

  const shown = status === 'all' ? data : data.filter((e) => e.status === status);

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle="Everyone the company employs, and where each stands."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="On the books" value={onBooks.length} sub="Active, on leave, suspended or serving notice" />
        <Metric
          label="In probation"
          value={probation.length}
          tone={probation.length > 0 ? 'warn' : 'good'}
          sub="A confirmation nobody closes is an exposure for them, not just paperwork"
          drillTo="/exceptions"
        />
        <Metric label="Serving notice" value={leaving.length} tone={leaving.length > 0 ? 'warn' : 'neutral'} />
        <Metric
          label="Monthly pay cost"
          value={costKnown ? money(monthlyCost) : <Withheld reason="no_permission" />}
          sub={costKnown ? 'Compensation in force today' : 'You can see the headcount without the cost'}
        />
      </div>

      {byDivision.length > 0 && (
        <Card title="By division" className="mb-5">
          <table className="table">
            <thead>
              <tr>
                <th>Division</th>
                <th className="num">Headcount</th>
                <th className="num">Monthly cost</th>
                <th className="num">Share of cost</th>
              </tr>
            </thead>
            <tbody>
              {byDivision.map((d) => (
                <tr key={d.division}>
                  <td>
                    <Division division={d.division} />
                  </td>
                  <td className="num">{d.headcount}</td>
                  <td className="num">
                    <Money value={d.monthlyCost} />
                  </td>
                  <td className="num">
                    {costKnown && monthlyCost > 0 ? `${Math.round(((d.monthlyCost ?? 0) / monthlyCost) * 100)}%` : '—'}
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td className="num">{byDivision.reduce((s, d) => s + d.headcount, 0)}</td>
                <td className="num">{costKnown ? money(monthlyCost) : '—'}</td>
                <td className="num">{costKnown ? '100%' : '—'}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}

      <Tabs
        tabs={[
          { key: 'all', label: 'Everyone', count: data.length },
          { key: 'Active', label: 'Active', count: data.filter((e) => e.status === 'Active').length },
          { key: 'OnLeave', label: 'On leave', count: data.filter((e) => e.status === 'OnLeave').length },
          { key: 'NoticePeriod', label: 'Notice', count: leaving.length },
          { key: 'Terminated', label: 'Left', count: data.filter((e) => e.status === 'Terminated').length },
        ]}
        active={status}
        onChange={setStatus}
      />

      {isLoading ? (
        <Loading />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState message="Nobody here." />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Division</th>
                  <th>Since</th>
                  <th>Status</th>
                  <th>Confirmation</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <RecordCode code={e.recordCode} to={`/people/employees/${e.id}`} />
                    </td>
                    <td>
                      <Link to={`/people/employees/${e.id}`} className="font-semibold hover:underline">
                        {e.fullName}
                      </Link>
                      {e.primaryEmail && <div className="text-2xs text-ink-500">{e.primaryEmail}</div>}
                    </td>
                    <td>
                      {e.jobTitle ?? '—'}
                      {e.orgUnit && <div className="text-2xs text-ink-500">{e.orgUnit}</div>}
                    </td>
                    <td>
                      <Division division={e.division} />
                    </td>
                    <td className="num">{date(e.hireEffectiveDate)}</td>
                    <td>
                      <StatusChip status={e.status} tone={tone(e.status)} />
                    </td>
                    <td>
                      <StatusChip
                        status={titleCase(e.confirmationState.replace(/_/g, ' '))}
                        tone={e.confirmationState === 'confirmed' ? 'good' : e.confirmationState === 'in_probation' ? 'warn' : 'neutral'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One employee
// ---------------------------------------------------------------------------

interface EmployeeDetailView {
  id: string;
  recordCode: string;
  personId: string;
  status: string;
  confirmationState: string;
  hireEffectiveDate: string;
  legalEntity: string;
  noticePeriodDays: number;
  engagementType: string;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  separationType: string | null;
  person: {
    fullName: string;
    primaryEmail: string | null;
    primaryPhone: string | null;
    dateOfBirth: string | null;
    hasBloodGroup: boolean;
  };
  hasPan: boolean;
  panLast4?: string | null;
  hasUan: boolean;
  hasEsicNumber: boolean;
  hasBankDetails: boolean;
  bankLast4?: string | null;
  /** Set only for HR — `employees:edit@all` — never for self-service. */
  canEditEmploymentDetails: boolean;
  assignments: Array<{
    id: string;
    rowStatus: string;
    reasonCode: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    position: { recordCode: string; job: { title: string }; orgUnit: { name: string; division: string | null } };
  }>;
  leaveBalances: Array<{ id: string; balanceDays: string; heldDays: string; leaveType: { name: string; code: string } }>;
  onboarding: { id: string; status: string } | null;
  offboarding: { id: string; status: string } | null;
  goals: Array<{ id: string; description: string; status: string; periodLabel: string | null }>;
  currentCompensation: { amount: number | null; currency: string; effectiveFrom: string } | null;
  /** Whether pay is reachable at all, as opposed to there being none. */
  payVisible: boolean;
  availableTransitions: string[];
  onboardingTransitions: string[];
  offboardingTransitions: string[];
}

interface CompensationRow {
  id: string;
  revisionReason: string;
  status: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  linkedAssignmentId: string | null;
  amount: number | null;
  basicPay: number | null;
  availableTransitions: string[];
  proposedByPartyId: string | null;
  proposedByName: string | null;
  canApprove: boolean;
  approveWithheldReason: 'not_holder' | 'self' | 'self_proposed' | null;
}

interface CapabilityRow {
  id: string;
  skillName: string | null;
  tier: string;
  state: string;
  lastEvidencedAt: string;
  confidenceScore?: number;
  decayedConfidence?: number;
}

const TIER_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  verified: 'good',
  demonstrated: 'good',
  assessed: 'neutral',
  claimed: 'warn',
  inferred: 'warn',
};

export function EmployeeDetail() {
  const { id = '' } = useParams();
  const [editOpen, setEditOpen] = useState(false);
  const [proposeCompOpen, setProposeCompOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['hr-employee', id],
    queryFn: () => api.get<EmployeeDetailView>(`/hr/employees/${id}`),
    enabled: Boolean(id),
  });

  const { data: compensation = [] } = useQuery({
    queryKey: ['hr-compensation', id],
    queryFn: () => api.get<CompensationRow[]>(`/hr/employees/${id}/compensation`),
    enabled: Boolean(id),
    retry: false,
  });

  const { data: capabilities = [] } = useQuery({
    queryKey: ['hr-capabilities', data?.personId],
    queryFn: () => api.get<CapabilityRow[]>(`/hr/people/${data!.personId}/capabilities`),
    enabled: Boolean(data?.personId),
    retry: false,
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Loading />;

  const current = data.assignments.find((a) => a.rowStatus === 'Effective');

  return (
    <div>
      <PageHeader
        title={data.person.fullName}
        subtitle={
          <>
            <RecordCode code={data.recordCode} /> · {current?.position.job.title ?? 'no seat'} ·{' '}
            {data.legalEntity}
          </>
        }
        actions={
          <>
            {data.payVisible && (
              <button className="btn-ghost" onClick={() => setProposeCompOpen(true)}>
                Change salary
              </button>
            )}
            <button className="btn-ghost" onClick={() => setEditOpen(true)}>
              Edit
            </button>
            <StatusChip status={data.status} tone={tone(data.status)} />
          </>
        }
      />
      <EditEmployeeProfile
        open={editOpen}
        onClose={() => setEditOpen(false)}
        employmentId={data.id}
        person={data.person}
        employment={data}
        canEditEmploymentDetails={data.canEditEmploymentDetails}
      />
      <ProposeCompensation open={proposeCompOpen} onClose={() => setProposeCompOpen(false)} employmentRelationshipId={data.id} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Where they sit" subtitle="Dated, so last March stays answerable.">
            <table className="table">
              <thead>
                <tr>
                  <th>Seat</th>
                  <th>Unit</th>
                  <th>Reason</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Row</th>
                </tr>
              </thead>
              <tbody>
                {data.assignments.map((a) => (
                  <tr key={a.id}>
                    <td>{a.position.job.title}</td>
                    <td>
                      {a.position.orgUnit.name}
                      <div className="mt-0.5">
                        <Division division={a.position.orgUnit.division} />
                      </div>
                    </td>
                    <td>{a.reasonCode}</td>
                    <td className="num">{date(a.effectiveFrom)}</td>
                    <td className="num">{a.effectiveTo ? date(a.effectiveTo) : '—'}</td>
                    <td>
                      <StatusChip status={a.rowStatus} tone={a.rowStatus === 'Effective' ? 'good' : 'neutral'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card
            title="Pay"
            subtitle="Every pay revision, and what it was for."
          >
            {compensation.length === 0 ? (
              data.payVisible ? (
                <EmptyState
                  message="No pay has ever been recorded for this person."
                  hint="Nobody should be on the books with no pay in force."
                />
              ) : (
                <EmptyState
                  message="Pay is not yours to see."
                  hint="Seeing somebody's record does not include their pay."
                />
              )
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Reason</th>
                    <th className="num">Amount</th>
                    <th>From</th>
                    <th>Status</th>
                    <th>Proposed by</th>
                    <th>Linked move</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {compensation.map((c) => {
                    // APPROVE/REJECT are legal from this state per the machine,
                    // but this viewer may still be barred from signing it —
                    // never the subject, never the proposer — so those two are
                    // dropped from what gets offered rather than shown and then
                    // refused.
                    const events = c.canApprove
                      ? c.availableTransitions
                      : c.availableTransitions.filter((e) => e !== 'APPROVE' && e !== 'REJECT');
                    const pendingSignoff = (c.status === 'Proposed' || c.status === 'PendingApproval') && !c.canApprove;
                    return (
                      <tr key={c.id}>
                        <td>{titleCase(c.revisionReason.replace(/_/g, ' '))}</td>
                        <td className="num">
                          <Money value={c.amount} />
                        </td>
                        <td className="num">{date(c.effectiveFrom)}</td>
                        <td>
                          <StatusChip status={c.status} tone={tone(c.status)} />
                        </td>
                        <td>
                          {c.proposedByName ?? '—'}
                          {pendingSignoff && (
                            <p className="text-2xs text-ink-500">
                              {c.approveWithheldReason === 'self_proposed'
                                ? 'awaiting somebody else to sign'
                                : c.approveWithheldReason === 'self'
                                  ? 'about you — somebody else signs it'
                                  : 'awaiting approval'}
                            </p>
                          )}
                        </td>
                        <td>{c.linkedAssignmentId ? <span className="chip-gold">linked</span> : '—'}</td>
                        <td>
                          <Transitions
                            collection="compensation"
                            id={c.id}
                            events={events}
                            invalidate={['hr-compensation', 'hr-employee']}
                            needsNote={['REJECT', 'WITHDRAW']}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Goals">
            {data.goals.length === 0 ? (
              <EmptyState message="No goals recorded." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Goal</th>
                    <th>Period</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.goals.map((g) => (
                    <tr key={g.id}>
                      <td>{g.description}</td>
                      <td>{g.periodLabel ?? '—'}</td>
                      <td>
                        <StatusChip status={g.status} tone={tone(g.status)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Employment">
            <dl>
              <Field label="Joined">{date(data.hireEffectiveDate)}</Field>
              <Field label="Confirmation">{titleCase(data.confirmationState.replace(/_/g, ' '))}</Field>
              <Field label="Notice period">{data.noticePeriodDays} days</Field>
              {data.separationType && <Field label="Separation">{titleCase(data.separationType)}</Field>}
              <Field label="Pay in force">
                {!data.payVisible ? (
                  <Withheld reason="no_permission" />
                ) : data.currentCompensation ? (
                  <span className="num">{money(data.currentCompensation.amount)}</span>
                ) : (
                  // Not withheld — genuinely absent, which is a problem rather
                  // than a permission boundary.
                  <span className="text-band-critical">None in force</span>
                )}
              </Field>
            </dl>
            {data.canEditEmploymentDetails && (
              <p className="mt-2">
                <Link className="text-2xs text-accent-soft hover:underline" to="/compliance/payroll">
                  Set up salary structure →
                </Link>
              </p>
            )}
            <div className="divider" />
            <p className="mb-2 section-title">What can happen next</p>
            <Transitions
              collection="employees"
              id={data.id}
              events={data.availableTransitions}
              invalidate={['hr-employee', 'hr-employees', 'hr-headcount']}
              needsNote={['SUSPEND', 'TERMINATE_POST_DISCIPLINARY', 'ABSENCE_BREACH', 'ABANDONMENT_CONFIRMED', 'RESCIND_OFFER']}
            />
          </Card>

          <Card title="Leave" subtitle="Held days are approved and not yet taken.">
            {data.leaveBalances.length === 0 ? (
              <EmptyState message="No balances." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th className="num">Balance</th>
                    <th className="num">Held</th>
                  </tr>
                </thead>
                <tbody>
                  {data.leaveBalances.map((b) => (
                    <tr key={b.id}>
                      <td>{b.leaveType.name}</td>
                      <td className={`num ${Number(b.balanceDays) < 0 ? 'text-band-critical' : ''}`}>{b.balanceDays}</td>
                      <td className="num">{b.heldDays}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card
            title="Skills"
            subtitle="The badge is the standing. The score is not shown to colleagues."
          >
            {capabilities.length === 0 ? (
              <EmptyState message="No claims recorded." />
            ) : (
              <div className="space-y-2">
                {capabilities.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm">{c.skillName ?? '—'}</p>
                      <p className="text-2xs text-ink-500">
                        last evidenced {relative(c.lastEvidencedAt)}
                        {c.decayedConfidence !== undefined && ` · confidence now ${c.decayedConfidence.toFixed(2)}`}
                      </p>
                    </div>
                    <StatusChip status={c.tier} tone={c.state === 'active' ? (TIER_TONE[c.tier] ?? 'neutral') : 'bad'} />
                  </div>
                ))}
              </div>
            )}
          </Card>

          {data.onboarding && (
            <Card title="Onboarding" actions={<StatusChip status={data.onboarding.status} tone={tone(data.onboarding.status)} />}>
              <Transitions
                collection="onboardings"
                id={data.onboarding.id}
                events={data.onboardingTransitions}
                invalidate={['hr-employee']}
                needsNote={['ESCALATE', 'ABANDON']}
              />
            </Card>
          )}

          {data.offboarding && (
            <Card title="Offboarding" actions={<StatusChip status={data.offboarding.status} tone={tone(data.offboarding.status)} />}>
              <Transitions
                collection="offboardings"
                id={data.offboarding.id}
                events={data.offboardingTransitions}
                invalidate={['hr-employee']}
                needsNote={['DISPUTE']}
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

interface LeaveRow {
  id: string;
  recordCode: string;
  employmentRelationshipId: string;
  fullName: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  days: number | null;
  reason: string | null;
  status: string;
  availableTransitions: string[];
}

export function Leave() {
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('open');

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['hr-leave'],
    queryFn: () => api.get<LeaveRow[]>('/hr/leave-requests'),
  });

  if (error) return <ErrorBox error={error} />;

  const OPEN = ['Draft', 'Submitted', 'PendingApproval', 'Approved', 'InProgress', 'Extended'];
  const awaiting = data.filter((r) => r.status === 'PendingApproval');
  const shown =
    filter === 'open' ? data.filter((r) => OPEN.includes(r.status))
    : filter === 'awaiting' ? awaiting
    : data;

  return (
    <div>
      <NewLeaveRequest open={creating} onClose={() => setCreating(false)} />
      <PageHeader
        actions={<NewButton label="Request leave" onClick={() => setCreating(true)} />}
        title="Leave"
        subtitle="Balances follow from holds, settlements and reversals."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Awaiting a decision" value={awaiting.length} tone={awaiting.length > 0 ? 'warn' : 'good'} />
        <Metric label="Open requests" value={data.filter((r) => OPEN.includes(r.status)).length} />
        <Metric label="Days requested" value={data.filter((r) => OPEN.includes(r.status)).reduce((s, r) => s + (r.days ?? 0), 0)} />
      </div>

      <Tabs
        tabs={[
          { key: 'open', label: 'Open', count: data.filter((r) => OPEN.includes(r.status)).length },
          { key: 'awaiting', label: 'Awaiting me', count: awaiting.length },
          { key: 'all', label: 'Everything', count: data.length },
        ]}
        active={filter}
        onChange={setFilter}
      />

      {isLoading ? (
        <Loading />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState message="Nothing here." />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Who</th>
                  <th>Type</th>
                  <th>From</th>
                  <th>To</th>
                  <th className="num">Days</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <RecordCode code={r.recordCode} />
                    </td>
                    <td>
                      <Link to={`/people/employees/${r.employmentRelationshipId}`} className="font-semibold hover:underline">
                        {r.fullName}
                      </Link>
                    </td>
                    <td>{r.leaveTypeName}</td>
                    <td className="num">{date(r.startDate)}</td>
                    <td className="num">{date(r.endDate)}</td>
                    <td className="num">{r.days}</td>
                    <td className="max-w-[16rem] truncate">{r.reason ?? '—'}</td>
                    <td>
                      <StatusChip status={r.status} tone={tone(r.status)} />
                    </td>
                    <td>
                      <Transitions
                        collection="leave-requests"
                        id={r.id}
                        events={r.availableTransitions}
                        invalidate={['hr-leave', 'hr-employee']}
                        needsNote={['REJECT', 'CANCEL', 'WITHDRAW']}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

interface AttendanceRow {
  id: string;
  workDate: string;
  workedMinutes: number;
  overtimeMinutes: number;
  status: string;
  missingPunch: boolean;
  note: string | null;
  availableTransitions: string[];
}

function hours(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function Attendance() {
  const [employmentId, setEmploymentId] = useState('');
  const [payPeriod, setPayPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const qc = useQueryClient();

  const { data: employees = [] } = useQuery({
    queryKey: ['hr-employees'],
    queryFn: () => api.get<EmployeeRow[]>('/hr/employees'),
  });

  const active = employees.filter((e) => ['Active', 'OnLeave', 'NoticePeriod'].includes(e.status));
  const selected = employmentId || active[0]?.id || '';

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['hr-attendance', selected, payPeriod],
    queryFn: () => api.get<AttendanceRow[]>(`/hr/employees/${selected}/attendance?payPeriod=${payPeriod}`),
    enabled: Boolean(selected),
  });

  const lock = useMutation({
    mutationFn: () => api.post<{ locked: number; unresolved: number }>('/hr/attendance/lock', { payPeriod }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['hr-attendance'] }),
  });

  if (error) return <ErrorBox error={error} />;

  const worked = data.reduce((s, r) => s + r.workedMinutes, 0);
  const overtime = data.reduce((s, r) => s + r.overtimeMinutes, 0);
  const disputed = data.filter((r) => r.status === 'Disputed').length;

  return (
    <div>
      <PageHeader
        title="Attendance"
        subtitle="Disputed days are left out of the lock and raised instead."
        actions={
          <>
            <input
              type="month"
              className="input w-40"
              value={payPeriod}
              onChange={(e) => setPayPeriod(e.target.value)}
            />
            <button className="btn-primary btn-sm" disabled={lock.isPending} onClick={() => lock.mutate()}>
              Lock this period
            </button>
          </>
        }
      />

      {lock.data && (
        <div className="mb-4 rounded-md border border-gold/30 bg-gold-soft px-4 py-3 text-xs shadow-raised">
          Locked {lock.data.locked} {lock.data.locked === 1 ? 'day' : 'days'}.
          {lock.data.unresolved > 0 && (
            <>
              {' '}
              <strong>{lock.data.unresolved}</strong> still disputed and left out — they have been raised as an
              exception rather than swept in.
            </>
          )}
        </div>
      )}
      {lock.error && <div className="mb-4"><ErrorBox error={lock.error} /></div>}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <Metric label="Days recorded" value={data.length} />
        <Metric label="Worked" value={hours(worked)} />
        <Metric label="Overtime" value={hours(overtime)} tone={overtime > 0 ? 'warn' : 'neutral'} />
        <Metric label="Disputed" value={disputed} tone={disputed > 0 ? 'bad' : 'good'} />
      </div>

      <Card title="Whose attendance" className="mb-4">
        <select className="input max-w-md" value={selected} onChange={(e) => setEmploymentId(e.target.value)}>
          {active.map((e) => (
            <option key={e.id} value={e.id}>
              {e.fullName} — {e.jobTitle ?? 'no seat'}
            </option>
          ))}
        </select>
      </Card>

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState message="Nothing recorded for this period." />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="num">Worked</th>
                  <th className="num">Overtime</th>
                  <th>Status</th>
                  <th>Note</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id}>
                    <td className="num">{r.workDate}</td>
                    <td className="num">{hours(r.workedMinutes)}</td>
                    <td className="num">{r.overtimeMinutes > 0 ? hours(r.overtimeMinutes) : '—'}</td>
                    <td>
                      <StatusChip status={r.status} tone={tone(r.status)} />
                      {r.missingPunch && <span className="ml-1 chip-neutral">missing punch</span>}
                    </td>
                    <td className="max-w-[20rem] truncate">{r.note ?? '—'}</td>
                    <td>
                      <Transitions
                        collection="attendance"
                        id={r.id}
                        events={r.availableTransitions}
                        invalidate={['hr-attendance']}
                        needsNote={['DISPUTE', 'REGULARISE']}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

interface PayrollRunRow {
  id: string;
  recordCode: string;
  payPeriod: string;
  status: string;
  headcount: number;
  grossTotal: number | null;
  netTotal: number | null;
  approvedAt: string | null;
  disbursedAt: string | null;
  availableTransitions: string[];
}

interface PayrollRunDetail extends PayrollRunRow {
  instructions: Array<{
    id: string;
    employmentRelationshipId: string;
    fullName: string;
    division: string | null;
    status: string;
    grossAmount: number | null;
    deductions: number | null;
    netAmount: number | null;
  }>;
}

export function Payroll() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [newPeriod, setNewPeriod] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 7);
  });
  const qc = useQueryClient();

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['hr-payroll'],
    queryFn: () => api.get<PayrollRunRow[]>('/hr/payroll/runs'),
  });

  const { data: detail } = useQuery({
    queryKey: ['hr-payroll-run', openId],
    queryFn: () => api.get<PayrollRunDetail>(`/hr/payroll/runs/${openId}`),
    enabled: Boolean(openId),
  });

  const open = useMutation({
    mutationFn: () => api.post('/hr/payroll/runs', { payPeriod: newPeriod }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['hr-payroll'] }),
  });

  if (error) return <ErrorBox error={error} />;

  const latest = data[0];

  return (
    <div>
      <PageHeader
        title="Payroll"
        subtitle="What each person is to be paid, and the run that settles it."
        actions={
          <>
            <input type="month" className="input w-40" value={newPeriod} onChange={(e) => setNewPeriod(e.target.value)} />
            <button className="btn-primary btn-sm" disabled={open.isPending} onClick={() => open.mutate()}>
              Open a run
            </button>
          </>
        }
      />

      {open.error && <div className="mb-4"><ErrorBox error={open.error} /></div>}

      {latest && (
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          <Metric label="Latest period" value={latest.payPeriod} sub={latest.status} />
          <Metric label="Headcount" value={latest.headcount} />
          <Metric label="Gross" value={latest.grossTotal === null ? <Withheld reason="no_permission" /> : money(latest.grossTotal)} />
          <Metric label="Net" value={latest.netTotal === null ? <Withheld reason="no_permission" /> : money(latest.netTotal)} />
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState message="No payroll runs yet." hint="Opening a run drafts an instruction for everyone on the books." />
        </Card>
      ) : (
        <Card bodyClassName="p-0" className="mb-4">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Period</th>
                  <th className="num">Headcount</th>
                  <th className="num">Gross</th>
                  <th className="num">Net</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button className="mono hover:underline" onClick={() => setOpenId(r.id === openId ? null : r.id)}>
                        {r.recordCode}
                      </button>
                    </td>
                    <td className="num">{r.payPeriod}</td>
                    <td className="num">{r.headcount}</td>
                    <td className="num">
                      <Money value={r.grossTotal} />
                    </td>
                    <td className="num">
                      <Money value={r.netTotal} />
                    </td>
                    <td>
                      <StatusChip status={r.status} tone={tone(r.status)} />
                    </td>
                    <td>
                      <Transitions
                        collection="payroll/runs"
                        id={r.id}
                        events={r.availableTransitions}
                        invalidate={['hr-payroll', 'hr-payroll-run']}
                        needsNote={['REJECT']}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {detail && (
        <Card
          title={`${detail.recordCode} — ${detail.payPeriod}`}
          subtitle="One instruction per person. Nobody is dropped from the list."
        >
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Division</th>
                  <th className="num">Gross</th>
                  <th className="num">Deductions</th>
                  <th className="num">Net</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.instructions.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link to={`/people/employees/${i.employmentRelationshipId}`} className="font-semibold hover:underline">
                        {i.fullName}
                      </Link>
                    </td>
                    <td>
                      <Division division={i.division} />
                    </td>
                    <td className={`num ${i.grossAmount === 0 ? 'text-band-critical' : ''}`}>
                      <Money value={i.grossAmount} />
                    </td>
                    <td className="num">
                      <Money value={i.deductions} />
                    </td>
                    <td className="num">
                      <Money value={i.netAmount} />
                    </td>
                    <td>
                      <StatusChip status={i.status} tone={tone(i.status)} />
                    </td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td colSpan={2}>Total</td>
                  <td className="num">
                    <Money value={detail.grossTotal} />
                  </td>
                  <td className="num">—</td>
                  <td className="num">
                    <Money value={detail.netTotal} />
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hiring
// ---------------------------------------------------------------------------

interface RequisitionRow {
  id: string;
  recordCode: string;
  status: string;
  targetStartDate: string | null;
  openApplications: number;
  position: { recordCode: string; job: { title: string }; orgUnit: { name: string; division: string | null } };
  availableTransitions: string[];
}

interface ApplicationRow {
  id: string;
  recordCode: string;
  status: string;
  funnelBucket: string;
  rejectionReason: string | null;
  candidate: { id: string; fullName: string; primaryEmail: string | null };
  requisition: { recordCode: string; position: { job: { title: string } } };
  availableTransitions: string[];
}

export function Hiring() {
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const [joining, setJoining] = useState<ApplicationRow | null>(null);
  const [joinDate, setJoinDate] = useState(() => new Date().toISOString().slice(0, 10));

  const { data: requisitions = [], error: reqError } = useQuery({
    queryKey: ['hr-requisitions'],
    queryFn: () => api.get<RequisitionRow[]>('/hr/requisitions'),
  });

  const { data: applications = [], isLoading } = useQuery({
    queryKey: ['hr-applications'],
    queryFn: () => api.get<ApplicationRow[]>('/hr/applications'),
  });

  const { data: funnel } = useQuery({
    queryKey: ['hr-funnel'],
    queryFn: () => api.get<{ buckets: Record<string, number> }>('/hr/hiring/funnel'),
  });

  const join = useMutation({
    mutationFn: (v: { id: string; hireEffectiveDate: string }) =>
      api.post(`/hr/applications/${v.id}/join`, { hireEffectiveDate: v.hireEffectiveDate }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hr-applications'] });
      void qc.invalidateQueries({ queryKey: ['hr-requisitions'] });
      void qc.invalidateQueries({ queryKey: ['hr-employees'] });
      setJoining(null);
    },
  });

  if (reqError) return <ErrorBox error={reqError} />;

  return (
    <div>
      <NewRequisition open={creating} onClose={() => setCreating(false)} />
      <PageHeader
        actions={<NewButton label="Post a vacancy" onClick={() => setCreating(true)} />}
        title="Hiring"
        subtitle="Offers accepted, and who has actually started."
      />

      {funnel && (
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          <Metric label="In process" value={funnel.buckets.open ?? 0} />
          <Metric label="At offer" value={funnel.buckets.offer ?? 0} tone="warn" />
          <Metric label="Joined" value={funnel.buckets.hired ?? 0} tone="good" />
          <Metric label="Closed" value={funnel.buckets.closed ?? 0} />
        </div>
      )}

      <Card title="Requisitions" className="mb-4" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Seat</th>
                <th>Unit</th>
                <th>Target start</th>
                <th className="num">Live applications</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {requisitions.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState message="No requisitions." />
                  </td>
                </tr>
              ) : (
                requisitions.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <RecordCode code={r.recordCode} />
                    </td>
                    <td>{r.position.job.title}</td>
                    <td>
                      {r.position.orgUnit.name}
                      <div className="mt-0.5">
                        <Division division={r.position.orgUnit.division} />
                      </div>
                    </td>
                    <td className="num">{r.targetStartDate ? date(r.targetStartDate) : '—'}</td>
                    <td className="num">{r.openApplications}</td>
                    <td>
                      <StatusChip status={r.status} tone={tone(r.status)} />
                    </td>
                    <td>
                      <Transitions
                        collection="requisitions"
                        id={r.id}
                        events={r.availableTransitions}
                        invalidate={['hr-requisitions']}
                        needsNote={['REJECT', 'CANCEL', 'HOLD', 'CLOSE']}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Candidates" bodyClassName="p-0">
        {isLoading ? (
          <Loading />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Candidate</th>
                  <th>For</th>
                  <th>Stage</th>
                  <th>Funnel</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {applications.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <EmptyState message="No applications." />
                    </td>
                  </tr>
                ) : (
                  applications.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <RecordCode code={a.recordCode} />
                      </td>
                      <td>
                        <span className="font-semibold">{a.candidate.fullName}</span>
                        {a.candidate.primaryEmail && (
                          <div className="text-2xs text-ink-500">{a.candidate.primaryEmail}</div>
                        )}
                      </td>
                      <td>{a.requisition.position.job.title}</td>
                      <td>
                        <StatusChip status={a.status} tone={tone(a.status)} />
                        {a.rejectionReason && <div className="mt-0.5 text-2xs text-ink-500">{a.rejectionReason}</div>}
                      </td>
                      <td>
                        <StatusChip status={a.funnelBucket} tone={a.funnelBucket === 'hired' ? 'good' : 'neutral'} />
                      </td>
                      <td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {a.status === 'OfferAccepted' && (
                            <button className="btn-gold btn-sm" onClick={() => setJoining(a)}>
                              Record joining
                            </button>
                          )}
                          <Transitions
                            collection="applications"
                            id={a.id}
                            events={a.availableTransitions.filter((e) => e !== 'JOIN')}
                            invalidate={['hr-applications', 'hr-funnel']}
                            needsNote={['REJECT', 'WITHDRAW', 'RESCIND_OFFER', 'NO_SHOW', 'DECLINE_OFFER']}
                          />
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={joining !== null}
        title={joining ? `Record ${joining.candidate.fullName} as joined` : ''}
        onClose={() => setJoining(null)}
        footer={
          <>
            <button className="btn-ghost btn-sm" onClick={() => setJoining(null)}>
              Cancel
            </button>
            <button
              className="btn-primary btn-sm"
              disabled={join.isPending}
              onClick={() => join.mutate({ id: joining!.id, hireEffectiveDate: joinDate })}
            >
              Open the employment
            </button>
          </>
        }
      >
        <label className="label">First day</label>
        <input type="date" className="input" value={joinDate} onChange={(e) => setJoinDate(e.target.value)} />
        <p className="mt-2 text-2xs leading-relaxed text-ink-500">
          This opens their employment record and their onboarding.
        </p>
        {join.error && <div className="mt-3"><ErrorBox error={join.error} /></div>}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

interface SkillRow {
  id: string;
  name: string;
  halfLifeMonths: number;
}

interface CapablePerson {
  partyId: string;
  fullName: string;
  skillName: string | null;
  tier: string;
  lastEvidencedAt: string;
}

export function Skills() {
  const [creating, setCreating] = useState(false);
  const [skillId, setSkillId] = useState('');
  const [minTier, setMinTier] = useState('assessed');

  const { data: skills = [], error } = useQuery({
    queryKey: ['hr-skills'],
    queryFn: () => api.get<SkillRow[]>('/hr/skills'),
  });

  const selected = skillId || skills[0]?.id || '';

  const { data: capable = [], isLoading } = useQuery({
    queryKey: ['hr-capable', selected, minTier],
    queryFn: () => api.get<CapablePerson[]>(`/hr/skills/${selected}/capable?minTier=${minTier}`),
    enabled: Boolean(selected),
  });

  if (error) return <ErrorBox error={error} />;

  const skill = skills.find((s) => s.id === selected);

  return (
    <div>
      <NewSkill open={creating} onClose={() => setCreating(false)} />
      <PageHeader
        actions={<NewButton label="Add a skill" onClick={() => setCreating(true)} />}
        title="Skills"
        subtitle="What people can do, and how well established it is."
      />

      <Card title="Who can do this" className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <label className="label">Skill</label>
            <select className="input" value={selected} onChange={(e) => setSkillId(e.target.value)}>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">At least</label>
            <select className="input w-44" value={minTier} onChange={(e) => setMinTier(e.target.value)}>
              <option value="inferred">Inferred</option>
              <option value="claimed">Claimed</option>
              <option value="assessed">Assessed</option>
              <option value="demonstrated">Demonstrated</option>
              <option value="verified">Verified</option>
            </select>
          </div>
        </div>
        {skill && (
          <p className="mt-3 text-2xs text-ink-500">
            Confidence in {skill.name} halves every {skill.halfLifeMonths} months without fresh evidence. The decay is
            worked out when the claim is read, never stored — otherwise it would be stale between nightly runs.
          </p>
        )}
      </Card>

      {isLoading ? (
        <Loading />
      ) : capable.length === 0 ? (
        <Card>
          <EmptyState
            message="Nobody at that standing."
            hint="Try a lower tier: training is a claim, not a demonstration."
          />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <table className="table">
            <thead>
              <tr>
                <th>Who</th>
                <th>Standing</th>
                <th>Last evidenced</th>
              </tr>
            </thead>
            <tbody>
              {capable.map((c) => (
                <tr key={`${c.partyId}-${c.skillName}`}>
                  <td className="font-semibold">{c.fullName}</td>
                  <td>
                    <StatusChip status={c.tier} tone={TIER_TONE[c.tier] ?? 'neutral'} />
                  </td>
                  <td>{relative(c.lastEvidencedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
