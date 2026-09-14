/**
 * Technology — continuity and operations (docs/plan/cio.md, workstream H).
 *
 * Three screens sharing one API surface: Continuity (a plan per application —
 * RTO/RPO, backup method, test history), Availability (a monthly uptime
 * reading per application, worst first), Maintenance (upcoming and past
 * windows).
 *
 * What this module does and does not do, stated here because the platform
 * says so on screen (Principle 7): it does not discover applications, meter
 * uptime, or page anyone. Every RTO, RPO, uptime minute and window is typed
 * in by a person; uptime % is the one number this screen computes, over the
 * minutes in the month.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, dateTime } from '../../lib/api.js';
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
} from '../../components/ui.js';
import { NewButton, Row, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PlanStatus = 'draft' | 'active' | 'retired';
type TestKind = 'restore' | 'failover' | 'tabletop';
type TestOutcome = 'pass' | 'fail' | 'partial';
type WindowStatus = 'planned' | 'in_progress' | 'done' | 'cancelled';

interface Plan {
  id: string;
  recordCode: string;
  applicationId: string;
  applicationName: string;
  applicationTier: number;
  rtoMinutes: number;
  rpoMinutes: number;
  backupMethod: string;
  backupFrequency: string;
  restoreProcedureDocumentId: string | null;
  ownerPartyId: string | null;
  lastTestedAt: string | null;
  testCadenceDays: number;
  status: PlanStatus;
  note: string | null;
}

interface PlanDetail extends Plan {
  tests: ContinuityTest[];
  availableTransitions: PlanStatus[];
}

interface ContinuityTest {
  id: string;
  recordCode: string;
  planId: string;
  testedAt: string;
  kind: TestKind;
  outcome: TestOutcome;
  actualRecoveryMinutes: number | null;
  actualDataLossMinutes: number | null;
  notes: string | null;
  evidenceDocumentId: string | null;
}

interface ContinuitySummary {
  notYetMeasured: boolean;
  plansByTier: Record<string, number>;
  plansByStatus: Record<PlanStatus, number>;
  tier1Tested: { count: number; total: number; fraction: number | null };
  testsOverdue: number;
  availabilityLastMonth: {
    notYetMeasured: boolean;
    period: string | null;
    meanUptimePercent: number | null;
    worstApplication: { applicationId: string; applicationName: string; uptimePercent: number } | null;
  };
  nextMaintenanceWindows: number;
}

interface AvailabilityReading {
  id: string;
  applicationId: string;
  applicationName: string;
  period: string;
  minutesDown: number;
  incidentCount: number;
  source: 'typed' | 'incidents';
  note: string | null;
  uptimePercent: number;
}

interface MaintenanceWindow {
  id: string;
  recordCode: string;
  applicationId: string;
  applicationName: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  changeId: string | null;
  notifiedAt: string | null;
  status: WindowStatus;
  cancelReason: string | null;
}

const STATUS_TONE: Record<PlanStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  draft: 'neutral',
  active: 'good',
  retired: 'warn',
};

const WINDOW_TONE: Record<WindowStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  planned: 'accent',
  in_progress: 'warn',
  done: 'good',
  cancelled: 'neutral',
};

function tierLabel(tier: number): string {
  return tier === 1 ? 'Tier 1 — critical' : tier === 2 ? 'Tier 2' : tier === 3 ? 'Tier 3' : 'Tier 4 — low';
}

// ---------------------------------------------------------------------------
// Continuity
// ---------------------------------------------------------------------------

export function ItContinuity() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [tier, setTier] = useState<'all' | '1' | '2' | '3' | '4'>('all');
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const summary = useQuery({ queryKey: ['it-continuity-summary'], queryFn: () => api.get<ContinuitySummary>('/it/continuity/summary') });
  const plans = useQuery({
    queryKey: ['it-continuity-plans', tier],
    queryFn: () => api.get<Plan[]>(`/it/continuity/plans${tier === 'all' ? '' : `?tier=${tier}`}`),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['it-continuity-plans'] });
    qc.invalidateQueries({ queryKey: ['it-continuity-summary'] });
  };

  const grouped = useMemo(() => {
    const rows = plans.data ?? [];
    const byTier = new Map<number, Plan[]>();
    for (const p of rows) {
      const list = byTier.get(p.applicationTier) ?? [];
      list.push(p);
      byTier.set(p.applicationTier, list);
    }
    return [...byTier.entries()].sort(([a], [b]) => a - b);
  }, [plans.data]);

  if (plans.error) return <ErrorBox error={plans.error} />;

  const s = summary.data;

  return (
    <div>
      <PageHeader
        title="Continuity"
        subtitle="One plan per application: how fast it must come back (RTO), how much data it may lose (RPO), how it is backed up, and whether the last drill actually hit those numbers. RTO/RPO, backup method and test outcomes are typed in — nothing here is metered."
        actions={can('it_continuity:C') && <NewButton label="New plan" onClick={() => setNewOpen(true)} />}
      />

      {s?.notYetMeasured ? (
        <Card>
          <EmptyState message="No continuity plans yet." hint="Nothing has been measured — this is not the same as everything being fine." />
        </Card>
      ) : (
        s && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric
              label="Tier-1 tested on cadence"
              value={s.tier1Tested.total === 0 ? '—' : `${s.tier1Tested.count}/${s.tier1Tested.total}`}
              sub={s.tier1Tested.fraction === null ? 'No tier-1 active plans' : `${Math.round(s.tier1Tested.fraction * 100)}%`}
              tone={s.tier1Tested.fraction === null ? 'neutral' : s.tier1Tested.fraction >= 1 ? 'good' : 'warn'}
              noActionReason="Active tier-1 plans within their own test cadence."
            />
            <Metric
              label="Tests overdue"
              value={s.testsOverdue}
              tone={s.testsOverdue > 0 ? 'bad' : 'good'}
              noActionReason="Active plans past their cadence, at any rung."
            />
            <Metric
              label="Availability last month"
              value={s.availabilityLastMonth.notYetMeasured ? 'Not yet measured' : `${s.availabilityLastMonth.meanUptimePercent}%`}
              sub={s.availabilityLastMonth.worstApplication ? `Worst: ${s.availabilityLastMonth.worstApplication.applicationName} (${s.availabilityLastMonth.worstApplication.uptimePercent}%)` : undefined}
              tone={s.availabilityLastMonth.notYetMeasured ? 'neutral' : 'neutral'}
              noActionReason="Mean uptime across applications with a reading."
            />
            <Metric
              label="Maintenance ahead"
              value={s.nextMaintenanceWindows}
              noActionReason="Planned or in-progress windows still to come."
            />
          </div>
        )
      )}

      <Tabs
        tabs={[
          { key: 'all', label: 'All' },
          { key: '1', label: 'Tier 1', count: s?.plansByTier?.['1'] },
          { key: '2', label: 'Tier 2', count: s?.plansByTier?.['2'] },
          { key: '3', label: 'Tier 3', count: s?.plansByTier?.['3'] },
          { key: '4', label: 'Tier 4', count: s?.plansByTier?.['4'] },
        ]}
        active={tier}
        onChange={setTier}
      />

      {plans.isLoading ? (
        <Loading label="Loading continuity plans" />
      ) : (plans.data ?? []).length === 0 ? (
        <Card>
          <EmptyState message="No plans in this tier." hint="Add a plan for an application to start tracking its RTO/RPO." />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {grouped.map(([t, rows]) => (
            <div key={t}>
              <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-400">{tierLabel(t)}</h3>
              <Card>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                        <th className="py-2 pr-3">Application</th>
                        <th className="py-2 pr-3">RTO / RPO</th>
                        <th className="py-2 pr-3">Backup</th>
                        <th className="py-2 pr-3">Last tested</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => (
                        <tr key={p.id} className="cursor-pointer border-b border-ink-850/60 hover:bg-ink-850/40" onClick={() => setDetailId(p.id)}>
                          <td className="py-2 pr-3">
                            <div className="text-ink-100">{p.applicationName}</div>
                            <div className="text-2xs text-ink-500">
                              <RecordCode code={p.recordCode} />
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-ink-300">{p.rtoMinutes}m / {p.rpoMinutes}m</td>
                          <td className="py-2 pr-3 text-ink-300">{p.backupMethod} · {p.backupFrequency}</td>
                          <td className="py-2 pr-3 text-ink-300">{p.lastTestedAt ? date(p.lastTestedAt) : 'Never'}</td>
                          <td className="py-2 pr-3"><StatusChip status={p.status} tone={STATUS_TONE[p.status]} /></td>
                          <td className="py-2 pr-3 text-right text-2xs text-ink-500">Cadence {p.testCadenceDays}d</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          ))}
        </div>
      )}

      {newOpen && (
        <NewPlanModal
          onClose={() => setNewOpen(false)}
          onCreated={() => {
            invalidate();
            setNewOpen(false);
          }}
        />
      )}
      {detailId && <PlanDetailModal id={detailId} onClose={() => setDetailId(null)} onChanged={invalidate} />}
    </div>
  );
}

function NewPlanModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [applicationId, setApplicationId] = useState('');
  const [applicationName, setApplicationName] = useState('');
  const [applicationTier, setApplicationTier] = useState<'1' | '2' | '3' | '4'>('3');
  const [rtoMinutes, setRtoMinutes] = useState('');
  const [rpoMinutes, setRpoMinutes] = useState('');
  const [backupMethod, setBackupMethod] = useState('');
  const [backupFrequency, setBackupFrequency] = useState('');
  const [testCadenceDays, setTestCadenceDays] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/it/continuity/plans', {
        applicationId,
        applicationName,
        applicationTier: Number(applicationTier),
        rtoMinutes: Number(rtoMinutes),
        rpoMinutes: Number(rpoMinutes),
        backupMethod,
        backupFrequency,
        testCadenceDays: testCadenceDays ? Number(testCadenceDays) : undefined,
      }),
    onSuccess: onCreated,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="New continuity plan"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="new-plan-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Create plan'}
          </button>
        </>
      }
    >
      <form
        id="new-plan-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <Row>
          <TextInput label="Application ID" value={applicationId} onChange={setApplicationId} required hint="From the application catalogue, once it exists" />
          <TextInput label="Application name" value={applicationName} onChange={setApplicationName} required />
        </Row>
        <SelectInput
          label="Tier"
          value={applicationTier}
          onChange={setApplicationTier}
          required
          options={[
            { value: '1', label: 'Tier 1 — critical' },
            { value: '2', label: 'Tier 2' },
            { value: '3', label: 'Tier 3' },
            { value: '4', label: 'Tier 4 — low' },
          ]}
        />
        <Row>
          <TextInput label="RTO (minutes)" value={rtoMinutes} onChange={setRtoMinutes} type="number" required />
          <TextInput label="RPO (minutes)" value={rpoMinutes} onChange={setRpoMinutes} type="number" required />
        </Row>
        <Row>
          <TextInput label="Backup method" value={backupMethod} onChange={setBackupMethod} required hint="e.g. nightly snapshot, continuous replication" />
          <TextInput label="Backup frequency" value={backupFrequency} onChange={setBackupFrequency} required hint="e.g. daily, hourly" />
        </Row>
        <TextInput
          label="Test cadence (days)"
          value={testCadenceDays}
          onChange={setTestCadenceDays}
          type="number"
          hint="Defaults to 180 for tier 1, 365 otherwise"
        />
      </form>
    </Modal>
  );
}

function PlanDetailModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const [testOpen, setTestOpen] = useState(false);

  const detail = useQuery({ queryKey: ['it-continuity-plan', id], queryFn: () => api.get<PlanDetail>(`/it/continuity/plans/${id}`) });

  const transition = useMutation({
    mutationFn: (status: PlanStatus) => api.patch(`/it/continuity/plans/${id}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-continuity-plan', id] });
      onChanged();
    },
  });

  const p = detail.data;

  return (
    <Modal open title={p ? p.applicationName : 'Continuity plan'} onClose={onClose} width="max-w-2xl">
      {detail.isLoading || !p ? (
        <Loading label="Loading plan" />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Record"><RecordCode code={p.recordCode} /></Field>
            <Field label="Tier">{tierLabel(p.applicationTier)}</Field>
            <Field label="Status"><StatusChip status={p.status} tone={STATUS_TONE[p.status]} /></Field>
            <Field label="RTO">{p.rtoMinutes} minutes</Field>
            <Field label="RPO">{p.rpoMinutes} minutes</Field>
            <Field label="Cadence">{p.testCadenceDays} days</Field>
            <Field label="Backup method">{p.backupMethod}</Field>
            <Field label="Backup frequency">{p.backupFrequency}</Field>
            <Field label="Last tested">{p.lastTestedAt ? dateTime(p.lastTestedAt) : 'Never'}</Field>
          </div>
          {p.note && <Field label="Note">{p.note}</Field>}

          {can('it_continuity:E') && (
            <div className="flex flex-wrap gap-2">
              {p.availableTransitions.includes('active') && (
                <button className="btn-sm" disabled={transition.isPending} onClick={() => transition.mutate('active')}>Activate</button>
              )}
              {p.availableTransitions.includes('retired') && (
                <button className="btn-sm" disabled={transition.isPending} onClick={() => transition.mutate('retired')}>Retire</button>
              )}
              {can('it_continuity:C') && p.status !== 'retired' && (
                <button className="btn-sm" onClick={() => setTestOpen(true)}>Record test</button>
              )}
            </div>
          )}

          <div>
            <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-400">Test history</h3>
            {p.tests.length === 0 ? (
              <EmptyState message="No tests recorded yet." hint="A restore, failover or tabletop test proves the plan — or doesn't." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                      <th className="py-2 pr-3">Tested</th>
                      <th className="py-2 pr-3">Kind</th>
                      <th className="py-2 pr-3">Outcome</th>
                      <th className="py-2 pr-3">Recovery / data loss</th>
                      <th className="py-2 pr-3">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.tests.map((t) => (
                      <tr key={t.id} className="border-b border-ink-850/60">
                        <td className="py-2 pr-3 text-ink-300">{dateTime(t.testedAt)}</td>
                        <td className="py-2 pr-3 text-ink-300">{t.kind}</td>
                        <td className="py-2 pr-3">
                          <StatusChip status={t.outcome} tone={t.outcome === 'pass' ? 'good' : t.outcome === 'fail' ? 'bad' : 'warn'} />
                        </td>
                        <td className="py-2 pr-3 text-ink-300">
                          {t.actualRecoveryMinutes ?? '—'}m / {t.actualDataLossMinutes ?? '—'}m
                          {t.actualRecoveryMinutes != null && t.actualRecoveryMinutes > p.rtoMinutes && (
                            <span className="ml-2 chip border-band-critical/40 bg-band-critical/10 text-band-critical">RTO exceeded</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-ink-500">{t.notes ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {testOpen && p && (
        <RecordTestModal
          plan={p}
          onClose={() => setTestOpen(false)}
          onRecorded={() => {
            qc.invalidateQueries({ queryKey: ['it-continuity-plan', id] });
            onChanged();
            setTestOpen(false);
          }}
        />
      )}
    </Modal>
  );
}

function RecordTestModal({ plan, onClose, onRecorded }: { plan: PlanDetail; onClose: () => void; onRecorded: () => void }) {
  const [kind, setKind] = useState<TestKind>('restore');
  const [outcome, setOutcome] = useState<TestOutcome>('pass');
  const [actualRecoveryMinutes, setActualRecoveryMinutes] = useState('');
  const [actualDataLossMinutes, setActualDataLossMinutes] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/it/continuity/plans/${plan.id}/tests`, {
        kind,
        outcome,
        actualRecoveryMinutes: actualRecoveryMinutes ? Number(actualRecoveryMinutes) : undefined,
        actualDataLossMinutes: actualDataLossMinutes ? Number(actualDataLossMinutes) : undefined,
        notes: notes || undefined,
      }),
    onSuccess: onRecorded,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title={`Record a test — ${plan.applicationName}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="record-test-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Recording…' : 'Record test'}
          </button>
        </>
      }
    >
      <form
        id="record-test-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <Field label="RTO / RPO promised">{plan.rtoMinutes}m / {plan.rpoMinutes}m</Field>
        <Row>
          <SelectInput
            label="Kind"
            value={kind}
            onChange={setKind}
            required
            options={[
              { value: 'restore', label: 'Restore' },
              { value: 'failover', label: 'Failover' },
              { value: 'tabletop', label: 'Tabletop' },
            ]}
          />
          <SelectInput
            label="Outcome"
            value={outcome}
            onChange={setOutcome}
            required
            options={[
              { value: 'pass', label: 'Pass' },
              { value: 'fail', label: 'Fail' },
              { value: 'partial', label: 'Partial' },
            ]}
          />
        </Row>
        <Row>
          <TextInput label="Actual recovery (minutes)" value={actualRecoveryMinutes} onChange={setActualRecoveryMinutes} type="number" />
          <TextInput label="Actual data loss (minutes)" value={actualDataLossMinutes} onChange={setActualDataLossMinutes} type="number" />
        </Row>
        <TextArea label="Notes" value={notes} onChange={setNotes} rows={3} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function ItAvailability() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [period, setPeriod] = useState(currentPeriod());
  const [newOpen, setNewOpen] = useState(false);

  const readings = useQuery({
    queryKey: ['it-availability', period],
    queryFn: () => api.get<AvailabilityReading[]>(`/it/availability/readings?period=${period}`),
  });

  const rows = useMemo(() => [...(readings.data ?? [])].sort((a, b) => a.uptimePercent - b.uptimePercent), [readings.data]);

  if (readings.error) return <ErrorBox error={readings.error} />;

  return (
    <div>
      <PageHeader
        title="Availability"
        subtitle="One reading per application per month — minutes down and incidents, typed in or rolled up from incidents once that link exists. Uptime % is computed from the minutes in the month, never stored."
        actions={
          <div className="flex items-center gap-2">
            <input
              type="month"
              className="input w-auto"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              aria-label="Month"
            />
            {can('it_continuity:C') && <NewButton label="Record reading" onClick={() => setNewOpen(true)} />}
          </div>
        }
      />

      <Card>
        {readings.isLoading ? (
          <Loading label="Loading availability" />
        ) : rows.length === 0 ? (
          <EmptyState
            message={`Not yet measured for ${monthLabel(period)}.`}
            hint="No reading has been recorded for any application this month — this is unmeasured, not 100% uptime."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="py-2 pr-3">Application</th>
                  <th className="py-2 pr-3">Uptime</th>
                  <th className="py-2 pr-3">Minutes down</th>
                  <th className="py-2 pr-3">Incidents</th>
                  <th className="py-2 pr-3">Source</th>
                  <th className="py-2 pr-3">Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-ink-850/60">
                    <td className="py-2 pr-3 text-ink-100">{r.applicationName}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      <span className={r.uptimePercent < 99 ? 'text-band-critical' : r.uptimePercent < 99.9 ? 'text-band-watch' : 'text-band-strong'}>
                        {r.uptimePercent}%
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-ink-300">{r.minutesDown}</td>
                    <td className="py-2 pr-3 text-ink-300">{r.incidentCount}</td>
                    <td className="py-2 pr-3 text-ink-500">{r.source}</td>
                    <td className="py-2 pr-3 text-ink-500">{r.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {newOpen && (
        <RecordReadingModal
          period={period}
          onClose={() => setNewOpen(false)}
          onRecorded={() => {
            qc.invalidateQueries({ queryKey: ['it-availability'] });
            setNewOpen(false);
          }}
        />
      )}
    </div>
  );
}

function RecordReadingModal({ period, onClose, onRecorded }: { period: string; onClose: () => void; onRecorded: () => void }) {
  const [applicationId, setApplicationId] = useState('');
  const [applicationName, setApplicationName] = useState('');
  const [readingPeriod, setReadingPeriod] = useState(period);
  const [minutesDown, setMinutesDown] = useState('0');
  const [incidentCount, setIncidentCount] = useState('0');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/it/availability/readings', {
        applicationId,
        applicationName,
        period: readingPeriod,
        minutesDown: Number(minutesDown),
        incidentCount: Number(incidentCount),
        note: note || undefined,
      }),
    onSuccess: onRecorded,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="Record an availability reading"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="record-reading-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Record'}
          </button>
        </>
      }
    >
      <form
        id="record-reading-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <Row>
          <TextInput label="Application ID" value={applicationId} onChange={setApplicationId} required />
          <TextInput label="Application name" value={applicationName} onChange={setApplicationName} required />
        </Row>
        <TextInput label="Month" value={readingPeriod} onChange={setReadingPeriod} placeholder="2026-09" required hint="YYYY-MM" />
        <Row>
          <TextInput label="Minutes down" value={minutesDown} onChange={setMinutesDown} type="number" required />
          <TextInput label="Incidents" value={incidentCount} onChange={setIncidentCount} type="number" />
        </Row>
        <TextArea label="Note" value={note} onChange={setNote} rows={2} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export function ItMaintenance() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [tab, setTab] = useState<'upcoming' | 'past' | 'all'>('upcoming');
  const [newOpen, setNewOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<MaintenanceWindow | null>(null);

  const windows = useQuery({
    queryKey: ['it-maintenance', tab],
    queryFn: () => api.get<MaintenanceWindow[]>(`/it/maintenance?when=${tab}`),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['it-maintenance'] });

  if (windows.error) return <ErrorBox error={windows.error} />;
  const rows = windows.data ?? [];

  return (
    <div>
      <PageHeader
        title="Maintenance"
        subtitle="Planned outage windows by application. The daily job notifies the Operations Head once a planned window is within 24 hours, and stamps when it did."
        actions={can('it_continuity:C') && <NewButton label="New window" onClick={() => setNewOpen(true)} />}
      />

      <Tabs
        tabs={[
          { key: 'upcoming', label: 'Upcoming' },
          { key: 'past', label: 'Past' },
          { key: 'all', label: 'All' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <Card>
        {windows.isLoading ? (
          <Loading label="Loading maintenance windows" />
        ) : rows.length === 0 ? (
          <EmptyState message={tab === 'upcoming' ? 'Nothing scheduled.' : 'No windows here.'} hint="A window is a planned, declared outage — not a detected one." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="py-2 pr-3">Application</th>
                  <th className="py-2 pr-3">Window</th>
                  <th className="py-2 pr-3">Reason</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Notified</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.id} className="border-b border-ink-850/60">
                    <td className="py-2 pr-3">
                      <div className="text-ink-100">{w.applicationName}</div>
                      <div className="text-2xs text-ink-500"><RecordCode code={w.recordCode} /></div>
                    </td>
                    <td className="py-2 pr-3 text-ink-300">{dateTime(w.startsAt)} → {dateTime(w.endsAt)}</td>
                    <td className="py-2 pr-3 text-ink-300">{w.reason}</td>
                    <td className="py-2 pr-3"><StatusChip status={w.status} tone={WINDOW_TONE[w.status]} /></td>
                    <td className="py-2 pr-3 text-ink-500">{w.notifiedAt ? dateTime(w.notifiedAt) : '—'}</td>
                    <td className="py-2 pr-3 text-right">
                      {can('it_continuity:E') && (w.status === 'planned' || w.status === 'in_progress') && (
                        <button className="btn-sm" onClick={() => setCancelTarget(w)}>Cancel</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {newOpen && (
        <NewWindowModal
          onClose={() => setNewOpen(false)}
          onCreated={() => {
            invalidate();
            setNewOpen(false);
          }}
        />
      )}
      {cancelTarget && (
        <CancelWindowModal
          window={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onCancelled={() => {
            invalidate();
            setCancelTarget(null);
          }}
        />
      )}
    </div>
  );
}

function NewWindowModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [applicationId, setApplicationId] = useState('');
  const [applicationName, setApplicationName] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/it/maintenance', {
        applicationId,
        applicationName,
        startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
        reason,
      }),
    onSuccess: onCreated,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="New maintenance window"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="new-window-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Schedule'}
          </button>
        </>
      }
    >
      <form
        id="new-window-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <Row>
          <TextInput label="Application ID" value={applicationId} onChange={setApplicationId} required />
          <TextInput label="Application name" value={applicationName} onChange={setApplicationName} required />
        </Row>
        <Row>
          <label className="block">
            <span className="label mb-1 block">Starts at</span>
            <input className="input" type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </label>
          <label className="block">
            <span className="label mb-1 block">Ends at</span>
            <input className="input" type="datetime-local" required value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </label>
        </Row>
        <TextArea label="Reason" value={reason} onChange={setReason} rows={2} required />
      </form>
    </Modal>
  );
}

function CancelWindowModal({ window, onClose, onCancelled }: { window: MaintenanceWindow; onClose: () => void; onCancelled: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/it/maintenance/${window.id}/cancel`, { reason }),
    onSuccess: onCancelled,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title={`Cancel ${window.applicationName} window`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Back</button>
          <button type="submit" form="cancel-window-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Cancelling…' : 'Cancel window'}
          </button>
        </>
      }
    >
      <form
        id="cancel-window-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <TextArea label="Reason" value={reason} onChange={setReason} rows={3} required hint="A deliberate decision not to run this window." />
      </form>
    </Modal>
  );
}
