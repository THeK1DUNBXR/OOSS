/**
 * Journeys — an ordered drip sequence a person is enrolled into and
 * advances through on `delayDays` and an optional condition per step
 * (MKT-MSG-008). A run overdue on `nextAt` by two days raises EX-MKT-015 —
 * this screen shows `nextAt` on every row precisely so that is visible
 * before the exception fires, not only after.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AUDIENCE_RULE_OPS,
  CHANNEL_KEYS,
  CHANNEL_KEY_LABELS,
  JOURNEY_RUN_STATUSES,
  JOURNEY_RUN_STATUS_LABELS,
  JOURNEY_STATUS_LABELS,
  JOURNEY_TRANSITIONS,
  JOURNEY_TRIGGER_KIND_LABELS,
  JOURNEY_TRIGGER_KINDS,
  type AudienceRuleOp,
  type ChannelKey,
  type JourneyRunStatus,
  type JourneyStatus,
  type JourneyStep,
  type JourneyTriggerKind,
} from '@kaizen/shared';
import { api, dateTime } from '../../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  RecordCode,
  StatusChip,
} from '../../components/ui.js';
import { CreateModal, messageOf, Row, SelectInput, TextInput } from '../../components/forms.js';
import {
  useActivateJourney,
  useAudiences,
  useCreateJourney,
  useEnrolInJourney,
  useExitJourneyRun,
  useJourney,
  useJourneyRuns,
  useJourneys,
  usePauseJourney,
  useRetireJourney,
  useTemplates,
} from '../../lib/marketingApi.js';
import { useSession } from '../../lib/session.js';

const STATUS_TONE: Record<JourneyStatus, 'neutral' | 'good' | 'accent' | 'warn'> = {
  draft: 'neutral',
  active: 'good',
  paused: 'warn',
  retired: 'neutral',
};

const RUN_TONE: Record<JourneyRunStatus, 'neutral' | 'good' | 'accent'> = {
  active: 'accent',
  completed: 'good',
  exited: 'neutral',
};

export function Journeys() {
  const { can } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading, error } = useJourneys();

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Journeys"
        subtitle="Ordered drip sequences — a person enrols once, then advances step by step on its own schedule."
        actions={
          can('marketing_journeys:C') && (
            <button className="btn-primary" onClick={() => setCreateOpen(true)}>
              New journey
            </button>
          )
        }
      />

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState message="No journeys yet." hint="A journey enrols on a trigger and sends its steps in order." />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Trigger</th>
                <th className="text-right">Steps</th>
                <th>Status</th>
                <th className="text-right">Active runs</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((j) => (
                <tr key={j.id} className="cursor-pointer" onClick={() => setOpenId(j.id)}>
                  <td>
                    <RecordCode code={j.recordCode} />
                  </td>
                  <td className="text-xs font-medium text-ink-100">{j.name}</td>
                  <td className="text-xs text-ink-300">{JOURNEY_TRIGGER_KIND_LABELS[j.triggerKind]}</td>
                  <td className="text-right tabular-nums text-xs">{j.steps.length}</td>
                  <td>
                    <StatusChip status={JOURNEY_STATUS_LABELS[j.status]} tone={STATUS_TONE[j.status]} />
                  </td>
                  <td className="text-right tabular-nums text-xs">{j.activeRunCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <NewJourney open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(id) => setOpenId(id)} />
      {openId && <JourneyDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function emptyStep(templateId: string, channelKey: ChannelKey): JourneyStep {
  return { delayDays: 1, templateId, channelKey, condition: null };
}

function StepEditor({
  steps,
  onChange,
  disabled,
}: {
  steps: JourneyStep[];
  onChange: (s: JourneyStep[]) => void;
  disabled: boolean;
}) {
  const templates = useTemplates({ status: 'approved' });

  return (
    <div className="space-y-2">
      {steps.map((step, i) => (
        <div key={i} className="rounded-md border border-ink-800 bg-ink-950 p-3">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-2xs font-semibold uppercase tracking-wide text-ink-500">Step {i + 1}</p>
            {!disabled && (
              <button className="text-2xs text-band-critical" onClick={() => onChange(steps.filter((_, idx) => idx !== i))}>
                Remove
              </button>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="block">
              <span className="label">Delay (days)</span>
              <input
                className="input"
                type="number"
                min={0}
                disabled={disabled}
                value={step.delayDays}
                onChange={(e) => {
                  const copy = steps.slice();
                  copy[i] = { ...step, delayDays: Number(e.target.value) };
                  onChange(copy);
                }}
              />
            </label>
            <label className="block">
              <span className="label">Channel</span>
              <select
                className="input"
                disabled={disabled}
                value={step.channelKey}
                onChange={(e) => {
                  const copy = steps.slice();
                  copy[i] = { ...step, channelKey: e.target.value as ChannelKey };
                  onChange(copy);
                }}
              >
                {CHANNEL_KEYS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_KEY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Template</span>
              <select
                className="input"
                disabled={disabled}
                value={step.templateId}
                onChange={(e) => {
                  const copy = steps.slice();
                  copy[i] = { ...step, templateId: e.target.value };
                  onChange(copy);
                }}
              >
                <option value="">Choose a template</option>
                {(templates.data?.items ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <StepConditionEditor
            condition={step.condition ?? null}
            disabled={disabled}
            onChange={(condition) => {
              const copy = steps.slice();
              copy[i] = { ...step, condition };
              onChange(copy);
            }}
          />
        </div>
      ))}
      {!disabled && (
        <button
          className="btn-ghost text-2xs"
          onClick={() => onChange([...steps, emptyStep(templates.data?.items[0]?.id ?? '', 'email')])}
        >
          + Add step
        </button>
      )}
    </div>
  );
}

/** One optional condition per step — a single `field op value`, the smallest
 *  slice of the same `AudienceRule` shape the audience rule builder edits. */
function StepConditionEditor({
  condition,
  onChange,
  disabled,
}: {
  condition: JourneyStep['condition'];
  onChange: (c: JourneyStep['condition']) => void;
  disabled: boolean;
}) {
  const has = Boolean(condition?.all?.length);
  const first = condition?.all?.[0];

  if (!has) {
    return disabled ? null : (
      <button
        className="mt-2 text-2xs text-accent-soft"
        onClick={() => onChange({ all: [{ field: '', op: 'eq', value: '' }] })}
      >
        + Add a condition on this step
      </button>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-2xs text-ink-500">Only if</span>
      <input
        className="input w-32"
        placeholder="field"
        disabled={disabled}
        value={first?.field ?? ''}
        onChange={(e) => onChange({ all: [{ field: e.target.value, op: first?.op ?? 'eq', value: first?.value }] })}
      />
      <select
        className="input w-28"
        disabled={disabled}
        value={first?.op ?? 'eq'}
        onChange={(e) => onChange({ all: [{ field: first?.field ?? '', op: e.target.value as AudienceRuleOp, value: first?.value }] })}
      >
        {AUDIENCE_RULE_OPS.map((op) => (
          <option key={op} value={op}>
            {op.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
      <input
        className="input w-32"
        placeholder="value"
        disabled={disabled}
        value={String(first?.value ?? '')}
        onChange={(e) => onChange({ all: [{ field: first?.field ?? '', op: first?.op ?? 'eq', value: e.target.value }] })}
      />
      {!disabled && (
        <button className="text-2xs text-band-critical" onClick={() => onChange(null)}>
          Remove condition
        </button>
      )}
    </div>
  );
}

function NewJourney({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [triggerKind, setTriggerKind] = useState<JourneyTriggerKind | ''>('');
  const [audienceId, setAudienceId] = useState('');
  const [steps, setSteps] = useState<JourneyStep[]>([]);
  const audiences = useAudiences();
  const create = useCreateJourney();

  const reset = () => {
    setName('');
    setTriggerKind('');
    setAudienceId('');
    setSteps([]);
  };

  return (
    <CreateModal
      open={open}
      title="New journey"
      submitLabel="Create draft"
      width="max-w-2xl"
      onClose={() => {
        reset();
        onClose();
      }}
      invalidate={[['mkt', 'journeys']]}
      onCreated={(result) => {
        reset();
        const created = result as { id: string } | undefined;
        if (created?.id) onCreated(created.id);
      }}
      onSubmit={() =>
        create.mutateAsync({
          name,
          triggerKind: triggerKind as JourneyTriggerKind,
          steps,
          audienceId: audienceId || undefined,
        })
      }
    >
      <Row>
        <TextInput label="Name" required value={name} onChange={setName} />
        <SelectInput
          label="Trigger"
          required
          value={triggerKind}
          onChange={(v) => setTriggerKind(v as JourneyTriggerKind)}
          placeholder="What starts it"
          options={JOURNEY_TRIGGER_KINDS.map((k) => ({ value: k, label: JOURNEY_TRIGGER_KIND_LABELS[k] }))}
        />
      </Row>
      {triggerKind === 'audience_join' && (
        <SelectInput
          label="Audience"
          required
          value={audienceId}
          onChange={setAudienceId}
          placeholder="Which audience"
          options={(audiences.data?.items ?? []).map((a) => ({ value: a.id, label: a.name }))}
        />
      )}
      <div>
        <span className="label">Steps</span>
        <StepEditor steps={steps} onChange={setSteps} disabled={false} />
      </div>
    </CreateModal>
  );
}

function JourneyDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useSession();
  const { data: journey, isLoading, error } = useJourney(id);
  const [banner, setBanner] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<JourneyRunStatus | ''>('');
  const [enrolQuery, setEnrolQuery] = useState('');

  const activate = useActivateJourney();
  const pause = usePauseJourney();
  const retire = useRetireJourney();
  const runs = useJourneyRuns(id, runStatus || undefined);
  const enrol = useEnrolInJourney(id);
  const exitRun = useExitJourneyRun();

  const { data: personSearch, isFetching: searchingPeople } = useQuery({
    queryKey: ['mkt', 'journey-enrol-search', enrolQuery],
    queryFn: () => api.get<{ items: Array<{ id: string; recordCode: string; fullName: string }> }>(`/crm/people?q=${encodeURIComponent(enrolQuery)}&pageSize=10`),
    enabled: enrolQuery.length >= 2,
  });

  if (isLoading) {
    return (
      <Modal open title="Journey" onClose={onClose}>
        <Loading />
      </Modal>
    );
  }
  if (error || !journey) {
    return (
      <Modal open title="Journey" onClose={onClose}>
        <ErrorBox error={error ?? new Error('Not found')} />
      </Modal>
    );
  }

  const nextStates = JOURNEY_TRANSITIONS[journey.status];
  const canEdit = can('marketing_journeys:E');

  return (
    <Modal open title={journey.name} onClose={onClose} width="max-w-3xl">
      <div className="space-y-4">
        {banner && (
          <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{banner}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={JOURNEY_STATUS_LABELS[journey.status]} tone={STATUS_TONE[journey.status]} />
          <span className="chip border-ink-700 text-ink-400">{JOURNEY_TRIGGER_KIND_LABELS[journey.triggerKind]}</span>
        </div>

        <dl className="grid grid-cols-3 gap-x-6">
          <Field label="Active runs">{journey.activeRunCount}</Field>
          <Field label="Completed runs">{journey.completedRunCount}</Field>
          <Field label="Exited runs">{journey.exitedRunCount}</Field>
        </dl>

        <Card title="Steps">
          <StepEditor steps={journey.steps} onChange={() => undefined} disabled />
        </Card>

        <div className="flex flex-wrap gap-2 border-t border-ink-800 pt-3">
          {journey.status === 'draft' && nextStates.includes('active') && canEdit && (
            <button className="btn-primary" disabled={activate.isPending} onClick={() => activate.mutate(journey.id, { onError: (e) => setBanner(messageOf(e)) })}>
              Activate
            </button>
          )}
          {journey.status === 'active' && nextStates.includes('paused') && canEdit && (
            <button className="btn-ghost" disabled={pause.isPending} onClick={() => pause.mutate(journey.id, { onError: (e) => setBanner(messageOf(e)) })}>
              Pause
            </button>
          )}
          {journey.status === 'paused' && nextStates.includes('active') && canEdit && (
            <button className="btn-primary" disabled={activate.isPending} onClick={() => activate.mutate(journey.id, { onError: (e) => setBanner(messageOf(e)) })}>
              Resume
            </button>
          )}
          {nextStates.includes('retired') && canEdit && (
            <button className="btn-ghost text-band-critical" disabled={retire.isPending} onClick={() => retire.mutate(journey.id, { onError: (e) => setBanner(messageOf(e)) })}>
              Retire
            </button>
          )}
        </div>

        {canEdit && journey.status !== 'retired' && (
          <Card title="Enrol a person" subtitle="Manually enrols one person, regardless of the trigger.">
            <TextInput label="Search people" value={enrolQuery} onChange={setEnrolQuery} placeholder="Name or record code…" />
            {enrolQuery.length >= 2 && (
              <div className="mt-2 space-y-1">
                {searchingPeople ? (
                  <Loading label="Searching" />
                ) : !personSearch?.items.length ? (
                  <p className="text-2xs italic text-ink-500">Nobody matches.</p>
                ) : (
                  personSearch.items.map((p) => (
                    <div key={p.id} className="flex items-center justify-between rounded border border-ink-800 px-2.5 py-1.5">
                      <div>
                        <p className="text-xs text-ink-100">{p.fullName}</p>
                        <p className="text-2xs text-ink-500 mono">{p.recordCode}</p>
                      </div>
                      <button
                        className="btn-ghost text-2xs"
                        disabled={enrol.isPending}
                        onClick={() => enrol.mutate(p.id, { onError: (e) => setBanner(messageOf(e)) })}
                      >
                        Enrol
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </Card>
        )}

        <Card
          title="Runs"
          actions={
            <select className="input max-w-xs" value={runStatus} onChange={(e) => setRunStatus(e.target.value as JourneyRunStatus | '')}>
              <option value="">Every status</option>
              {JOURNEY_RUN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {JOURNEY_RUN_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          }
          bodyClassName="p-0"
        >
          {runs.isLoading ? (
            <Loading />
          ) : !runs.data?.items.length ? (
            <div className="p-4">
              <EmptyState message="No runs match." hint="A run starts when the trigger fires, or when someone is enrolled manually." />
            </div>
          ) : (
            <ul className="divide-y divide-ink-850">
              {runs.data.items.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div>
                    <p className="text-xs text-ink-200">{r.personName}</p>
                    <p className="text-2xs text-ink-500">
                      Step {r.currentStep + 1} · next {r.nextAt ? dateTime(r.nextAt) : '—'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusChip status={JOURNEY_RUN_STATUS_LABELS[r.status as JourneyRunStatus] ?? r.status} tone={RUN_TONE[r.status as JourneyRunStatus]} />
                    {r.status === 'active' && canEdit && (
                      <button
                        className="btn-ghost text-2xs text-band-critical"
                        disabled={exitRun.isPending}
                        onClick={() => {
                          const reason = prompt('Reason for exiting this run?');
                          if (reason) exitRun.mutate({ runId: r.id, reason }, { onError: (e) => setBanner(messageOf(e)) });
                        }}
                      >
                        Exit
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Modal>
  );
}
