/**
 * Marketing events — seminars, webinars, open days, drives. List, create, and
 * a detail page that carries the state machine, the registration desk, and
 * the cost-per-attendee tile the module promises to be honest about (a null
 * value, never an invented number, until an actual cost is recorded).
 */

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MARKETING_EVENT_KINDS,
  MARKETING_EVENT_KIND_LABELS,
  MARKETING_EVENT_STATUS_LABELS,
  MARKETING_EVENT_TRANSITIONS,
  REGISTRATION_STATUS_LABELS,
  type MarketingEventKind,
  type MarketingEventStatus,
} from '@kaizen/shared';
import { api, date, dateTime, money, titleCase } from '../../lib/api.js';
import {
  useMarketingEvents,
  useMarketingEvent,
  useCreateMarketingEvent,
  useOpenEvent,
  useCloseEvent,
  useStartEvent,
  useCompleteEvent,
  useCancelEvent,
  useEventRegistrations,
  useRegisterForEvent,
  useConfirmRegistration,
  useCheckInRegistration,
  useNoShowRegistration,
  useCancelRegistration,
  useFollowUpRegistration,
  useConvertAttendees,
  useCampaigns,
} from '../../lib/marketingApi.js';
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
} from '../../components/ui.js';
import { CreateModal, Row, SelectInput, TextInput, messageOf, NewButton } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';

const DIVISIONS = [
  { value: 'software', label: 'Software' },
  { value: 'skill', label: 'Skill Development' },
  { value: 'education', label: 'Education' },
  { value: 'shared', label: 'Shared' },
];

export function MarketingEvents() {
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const events = useMarketingEvents();

  if (events.isLoading) return <Loading />;
  if (events.error) return <ErrorBox error={events.error} />;
  const items = events.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Events"
        subtitle="Seminars, webinars, open days and drives — with who registered and who showed up."
        actions={can('marketing_events:C') && <NewButton label="New event" onClick={() => setCreating(true)} />}
      />

      {items.length === 0 ? (
        <Card><EmptyState message="No events yet." hint="An event's registrations feed straight into leads on completion." /></Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Kind</th>
                <th>Division</th>
                <th>When</th>
                <th className="text-right">Registered / attended</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/marketing/events/${e.id}`} className="text-xs font-medium text-ink-100 hover:text-accent-soft">
                      {e.name}
                    </Link>
                    <p className="text-2xs text-ink-500"><RecordCode code={e.recordCode} /></p>
                  </td>
                  <td className="text-xs text-ink-300">{MARKETING_EVENT_KIND_LABELS[e.kind] ?? titleCase(e.kind)}</td>
                  <td><span className={`chip border-div-${e.division}/40 text-div-${e.division}`}>{titleCase(e.division)}</span></td>
                  <td className="text-2xs text-ink-400">{date(e.startAt)}</td>
                  <td className="text-right tabular-nums text-xs">
                    {e.registeredCount}{e.capacity ? ` / ${e.capacity}` : ''} · {e.attendedCount} attended
                  </td>
                  <td><StatusChip status={e.status} tone={e.status === 'completed' ? 'good' : e.status === 'cancelled' ? 'bad' : 'neutral'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <CreateEventModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function CreateEventModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const campaigns = useCampaigns();
  const create = useCreateMarketingEvent();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<MarketingEventKind>('webinar');
  const [division, setDivision] = useState('education');
  const [campaignId, setCampaignId] = useState('');
  const [venue, setVenue] = useState('');
  const [isOnline, setIsOnline] = useState(true);
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [capacity, setCapacity] = useState('');
  const [costPlanned, setCostPlanned] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <CreateModal
      open={open}
      title="New event"
      onClose={onClose}
      invalidate={[['mkt', 'events']]}
      onSubmit={() =>
        create.mutateAsync({
          name,
          kind,
          division,
          campaignId: campaignId || undefined,
          venue: venue || undefined,
          isOnline,
          startAt: new Date(startAt).toISOString(),
          endAt: new Date(endAt).toISOString(),
          capacity: capacity ? Number(capacity) : undefined,
          costPlanned: costPlanned ? Number(costPlanned) : undefined,
        })
      }
    >
      {error && <p className="text-2xs text-band-critical">{error}</p>}
      <TextInput label="Name" required value={name} onChange={setName} placeholder="Full Stack open day — September" />
      <Row>
        <SelectInput label="Kind" value={kind} onChange={(v) => setKind(v as MarketingEventKind)} options={MARKETING_EVENT_KINDS.map((k) => ({ value: k, label: MARKETING_EVENT_KIND_LABELS[k] }))} />
        <SelectInput label="Division" value={division} onChange={setDivision} options={DIVISIONS} />
      </Row>
      <Row>
        <TextInput label="Starts" type="date" required value={startAt} onChange={setStartAt} />
        <TextInput label="Ends" type="date" required value={endAt} onChange={setEndAt} />
      </Row>
      <Row>
        <TextInput label="Venue" value={venue} onChange={setVenue} placeholder="Online, or a physical address" />
        <SelectInput label="Campaign" value={campaignId} onChange={setCampaignId} placeholder="No campaign" options={(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
      </Row>
      <Row>
        <TextInput label="Capacity" type="number" value={capacity} onChange={setCapacity} hint="leave blank for unlimited" />
        <TextInput label="Planned cost" type="number" value={costPlanned} onChange={setCostPlanned} />
      </Row>
      <label className="flex items-center gap-2 text-sm text-ink-200">
        <input type="checkbox" checked={isOnline} onChange={(e) => setIsOnline(e.target.checked)} />
        Online
      </label>
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const TRANSITION_ACTIONS: Record<MarketingEventStatus, { label: string; hook: 'open' | 'close' | 'start' | 'complete' }[]> = {
  planned: [{ label: 'Open for registration', hook: 'open' }],
  open: [{ label: 'Close registration', hook: 'close' }],
  closed: [{ label: 'Go live', hook: 'start' }],
  live: [{ label: 'Complete', hook: 'complete' }],
  completed: [],
  cancelled: [],
};

export function MarketingEventDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const event = useMarketingEvent(id);
  const registrations = useEventRegistrations(id);
  const open = useOpenEvent();
  const close = useCloseEvent();
  const start = useStartEvent();
  const complete = useCompleteEvent();
  const cancel = useCancelEvent();
  const convertAttendees = useConvertAttendees(id ?? '');

  const confirm = useConfirmRegistration(id ?? '');
  const checkIn = useCheckInRegistration(id ?? '');
  const noShow = useNoShowRegistration(id ?? '');
  const cancelReg = useCancelRegistration(id ?? '');
  const followUp = useFollowUpRegistration(id ?? '');

  if (event.isLoading) return <Loading />;
  if (event.error) return <ErrorBox error={event.error} />;
  if (!event.data) return null;
  const e = event.data;

  const actions = TRANSITION_ACTIONS[e.status] ?? [];
  const hookFor = { open, close, start, complete } as const;
  const canCancel = (MARKETING_EVENT_TRANSITIONS[e.status] ?? []).includes('cancelled');
  const items = registrations.data?.items ?? [];
  const pct = e.capacity ? Math.min(100, Math.round((e.registeredCount / e.capacity) * 100)) : null;

  return (
    <div>
      <PageHeader
        title={e.name}
        subtitle={<span className="mono">{e.recordCode} · {MARKETING_EVENT_KIND_LABELS[e.kind]}</span>}
        actions={
          can('marketing_events:E') && (
            <>
              {actions.map((a) => (
                <button
                  key={a.hook}
                  className="btn"
                  disabled={hookFor[a.hook].isPending}
                  onClick={() => hookFor[a.hook].mutate(id!, { onError: (err) => setError(messageOf(err)) })}
                >
                  {a.label}
                </button>
              ))}
              {e.status === 'completed' && (
                <button
                  className="btn"
                  disabled={convertAttendees.isPending}
                  onClick={() => convertAttendees.mutate(undefined, { onError: (err) => setError(messageOf(err)) })}
                >
                  Convert attendees to leads
                </button>
              )}
              <button
                className="btn-quiet"
                onClick={() => api.download(`/marketing/events/${id}/export`, `${e.recordCode}-registrations.csv`).catch((err) => setError(messageOf(err)))}
              >
                Export CSV
              </button>
              {canCancel && (
                <button
                  className="btn-danger"
                  onClick={() => {
                    const reason = prompt('Reason for cancelling this event?');
                    if (reason) cancel.mutate({ id: id!, reason }, { onError: (err) => setError(messageOf(err)) });
                  }}
                >
                  Cancel
                </button>
              )}
            </>
          )
        }
      />

      {error && <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <Metric label="Status" value={<StatusChip status={e.status} tone={e.status === 'completed' ? 'good' : 'neutral'} />} noActionReason="the state machine drives this" />
        <Metric label="Registered" value={e.registeredCount} sub={e.capacity ? `of ${e.capacity} seats` : 'no capacity limit'} noActionReason="see the table below" />
        <Metric label="Attended" value={e.attendedCount} noActionReason="see the table below" />
        <Metric
          label="Cost per attendee"
          value={e.costPerAttendee === null ? '—' : money(e.costPerAttendee)}
          tone={e.costPerAttendee === null ? 'neutral' : 'neutral'}
          noActionReason={e.costPerAttendee === null ? 'not yet measured — no actual cost recorded' : `${money(e.costActual)} actual ÷ ${e.attendedCount} attended`}
        />
      </div>

      {pct !== null && (
        <div className="mb-5">
          <div className="mb-1 flex justify-between text-2xs text-ink-400">
            <span>Capacity</span>
            <span>{e.registeredCount} / {e.capacity}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-ink-800">
            <div className={`h-full rounded-full ${pct >= 100 ? 'bg-band-critical' : pct >= 80 ? 'bg-band-watch' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card
            title="Registrations"
            bodyClassName="p-0"
            actions={can('marketing_events:C') && <button className="btn btn-sm" onClick={() => setRegistering(true)}>Register somebody</button>}
          >
            {items.length === 0 ? (
              <EmptyState message="Nobody has registered yet." />
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Person</th><th>Status</th><th>Follow-up</th><th /></tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td className="text-xs text-ink-100">
                        {r.personName}
                        {r.leadRecordCode && <span className="ml-1.5 mono text-2xs text-ink-500">{r.leadRecordCode}</span>}
                      </td>
                      <td><StatusChip status={r.status} tone={r.status === 'attended' ? 'good' : r.status === 'no_show' || r.status === 'cancelled' ? 'bad' : 'neutral'} /></td>
                      <td>
                        <label className="flex items-center gap-1.5 text-2xs text-ink-400">
                          <input
                            type="checkbox"
                            checked={r.followUpDone}
                            onChange={(ev) => {
                              const note = ev.target.checked ? prompt('Follow-up note (optional)') ?? undefined : undefined;
                              followUp.mutate({ id: r.id, done: ev.target.checked, note }, { onError: (err) => setError(messageOf(err)) });
                            }}
                          />
                          done
                        </label>
                      </td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {r.status === 'registered' && <button className="btn-quiet btn-sm" onClick={() => confirm.mutate(r.id, { onError: (err) => setError(messageOf(err)) })}>Confirm</button>}
                          {(r.status === 'registered' || r.status === 'confirmed') && (
                            <>
                              <button className="btn-quiet btn-sm" onClick={() => checkIn.mutate(r.id, { onError: (err) => setError(messageOf(err)) })}>Check in</button>
                              <button className="btn-quiet btn-sm" onClick={() => noShow.mutate(r.id, { onError: (err) => setError(messageOf(err)) })}>No-show</button>
                              <button className="btn-quiet btn-sm" onClick={() => cancelReg.mutate(r.id, { onError: (err) => setError(messageOf(err)) })}>Cancel</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div>
          <Card title="Detail">
            <dl>
              <Field label="Venue">{e.venue || (e.isOnline ? 'Online' : '—')}</Field>
              <Field label="Starts">{dateTime(e.startAt)}</Field>
              <Field label="Ends">{dateTime(e.endAt)}</Field>
              <Field label="Division">{titleCase(e.division)}</Field>
              <Field label="Campaign">{e.campaignName ?? '—'}</Field>
              <Field label="Planned cost">{money(e.costPlanned)}</Field>
              <Field label="Actual cost">{money(e.costActual)}</Field>
            </dl>
          </Card>
        </div>
      </div>

      <RegisterModal eventId={id!} open={registering} onClose={() => setRegistering(false)} />
    </div>
  );
}

function RegisterModal({ eventId, open, onClose }: { eventId: string; open: boolean; onClose: () => void }) {
  const register = useRegisterForEvent(eventId);
  const [who, setWho] = useState<'existing' | 'new'>('new');
  const [personId, setPersonId] = useState('');
  const [fullName, setFullName] = useState('');
  const [primaryPhone, setPhone] = useState('');
  const [primaryEmail, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <CreateModal
      open={open}
      title="Register somebody"
      onClose={onClose}
      invalidate={[]}
      onSubmit={() =>
        register.mutateAsync(
          who === 'existing'
            ? { personId, source: 'manual' }
            : { person: { fullName, primaryPhone: primaryPhone || undefined, primaryEmail: primaryEmail || undefined }, source: 'manual' },
        )
      }
    >
      {error && <p className="text-2xs text-band-critical">{error}</p>}
      <div className="flex gap-2">
        {(['existing', 'new'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setWho(v)}
            className={`chip transition-colors ${who === v ? 'border-accent/60 text-accent-soft' : 'border-ink-800 text-ink-500 hover:border-ink-600'}`}
          >
            {v === 'existing' ? 'Somebody already on file' : 'Somebody new'}
          </button>
        ))}
      </div>
      {who === 'existing' ? (
        <TextInput label="Person ID" required value={personId} onChange={setPersonId} hint="pasted from their record" />
      ) : (
        <>
          <TextInput label="Name" required value={fullName} onChange={setFullName} />
          <Row>
            <TextInput label="Phone" type="tel" value={primaryPhone} onChange={setPhone} />
            <TextInput label="Email" type="email" value={primaryEmail} onChange={setEmail} />
          </Row>
        </>
      )}
    </CreateModal>
  );
}
