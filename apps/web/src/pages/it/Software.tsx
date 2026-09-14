/**
 * Technology — applications, licences and subscriptions (docs/plan/cio.md,
 * workstream B).
 *
 * Two screens sharing one API surface: Applications (the catalogue — every
 * application the company runs on, whether or not it has a licence) and
 * Licences (what was actually bought against an application — seats, cost,
 * term, renewal).
 *
 * What this screen does and does not do, stated because the platform says so
 * on screen (Principle 7): seats in use are typed in by whoever manages the
 * licence — the platform does not meter SaaS logins. Renewal is a two-party
 * act: whoever proposes a renewal can never decide it, and the screen omits
 * the Approve button for them entirely rather than disabling it.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date } from '../../lib/api.js';
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
} from '../../components/ui.js';
import { MoneyInput, NewButton, Row, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ApplicationStatus = 'evaluating' | 'active' | 'sunsetting' | 'retired';
type ApplicationEvent = 'ACTIVATE' | 'SUNSET' | 'RETIRE' | 'REJECT';
type Hosting = 'saas' | 'on_prem' | 'cloud';
type Classification = 'internal' | 'confidential' | 'restricted' | 'regulated';
type LicenceKind = 'per_seat' | 'site' | 'perpetual' | 'usage';
type BillingCycle = 'monthly' | 'quarterly' | 'annual' | 'one_off';
type LicenceStatus = 'active' | 'expiring' | 'expired' | 'cancelled';

interface ItApplication {
  id: string;
  recordCode: string | null;
  name: string;
  vendorName: string | null;
  vendorId: string | null;
  category: string;
  tier: number;
  hosting: Hosting;
  ownerPartyId: string | null;
  dataClassificationHandled: Classification;
  sso: boolean;
  status: ApplicationStatus;
  url: string | null;
  notes: string | null;
  unownedNotifiedAt: string | null;
}

interface ApplicationDetail extends ItApplication {
  availableTransitions: ApplicationEvent[];
  licences: ItLicence[];
}

interface ItLicence {
  id: string;
  recordCode: string | null;
  applicationId: string;
  kind: LicenceKind;
  seatsPurchased: number;
  seatsInUse: number;
  /** `null` — present, withheld server-side — for a caller without `it_licences:financial`. */
  costPerPeriod: string | number | null;
  currency: string;
  billingCycle: BillingCycle;
  termStart: string | null;
  termEnd: string | null;
  renewalDate: string | null;
  noticeDays: number;
  autoRenew: boolean;
  vendorContractId: string | null;
  lastVendorBillId: string | null;
  status: LicenceStatus;
  pendingRenewalProposedById: string | null;
  pendingRenewalApprovalStepId: string | null;
  pendingRenewalTermEnd: string | null;
  pendingRenewalCostPerPeriod: string | number | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  application?: { id: string; name: string; recordCode: string | null; tier: number };
}

interface LicenceDetailView extends ItLicence {
  annualisedCost: number | null;
  seatUtilisation: { percent: number | null; overAllocated: boolean };
  events: LicenceEvent[];
}

interface LicenceEvent {
  id: string;
  kind: string;
  actorPartyId: string | null;
  note: string | null;
  detail: unknown;
  createdAt: string;
}

interface ApplicationsSummary {
  notYetMeasured: boolean;
  byTier: Record<string, number>;
  byHosting: Record<Hosting, number>;
  byStatus: Record<ApplicationStatus, number>;
  unowned: number;
}

interface LicencesSummary {
  notYetMeasured: boolean;
  annualisedSpend: number | null;
  annualisedSpendByApplication: Array<{ applicationId: string; applicationName: string; annualisedCost: number | null }>;
  renewingIn90Days: number;
  overAllocated: number;
  underUsed: number;
  seatsPurchased: number;
  seatsInUse: number;
}

interface PersonOption {
  id: string;
  fullName: string;
  recordCode: string;
  primaryPhone?: string | null;
}

const STATUS_TONE: Record<ApplicationStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  evaluating: 'accent',
  active: 'good',
  sunsetting: 'warn',
  retired: 'neutral',
};

const LICENCE_STATUS_TONE: Record<LicenceStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  active: 'good',
  expiring: 'warn',
  expired: 'bad',
  cancelled: 'neutral',
};

const money = (v: string | number | null | undefined, currency = 'INR') => {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0);
  return `${currency} ${Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '0'}`;
};

/** The owner picker, copied inline from the person-search pattern in
 * `apps/web/src/components/createForms.tsx` (`useList` + a `SelectInput`
 * over `/crm/people`) — that file is not this workstream's to edit. */
function usePeoplePicker(enabled: boolean) {
  const query = useQuery({
    queryKey: ['it-software-people-picker'],
    queryFn: () => api.get<unknown>('/crm/people?pageSize=200'),
    enabled,
  });
  const rows = useMemo(() => {
    const data = query.data as { items?: PersonOption[] } | PersonOption[] | undefined;
    return Array.isArray(data) ? data : (data?.items ?? []);
  }, [query.data]);
  return { ...query, rows };
}

// ---------------------------------------------------------------------------
// Applications list
// ---------------------------------------------------------------------------

export function ItApplications() {
  const { can } = useSession();
  const [tab, setTab] = useState<ApplicationStatus | 'all'>('all');
  const [newOpen, setNewOpen] = useState(false);

  const summary = useQuery({
    queryKey: ['it-applications-summary'],
    queryFn: () => api.get<ApplicationsSummary>('/it/applications/summary'),
  });
  const apps = useQuery({
    queryKey: ['it-applications', tab],
    queryFn: () => api.get<ItApplication[]>(`/it/applications${tab === 'all' ? '' : `?status=${tab}`}`),
  });

  if (apps.error) return <ErrorBox error={apps.error} />;
  const s = summary.data;
  const rows = [...(apps.data ?? [])].sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));

  return (
    <div>
      <PageHeader
        title="Applications"
        subtitle="Every application the company runs on, whether or not it has a licence attached. Tier 1 is business-stopping; tier 4 is low."
        actions={can('it_applications:C') && <NewButton label="New application" onClick={() => setNewOpen(true)} />}
      />

      {s?.notYetMeasured ? (
        <Card>
          <EmptyState message="Nothing in the catalogue yet." hint="Add the first application to start tracking it." />
        </Card>
      ) : (
        s && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Applications" value={Object.values(s.byStatus).reduce((a, b) => a + b, 0)} noActionReason="The whole catalogue." />
            <Metric label="Tier 1" value={s.byTier['1'] ?? 0} noActionReason="Business-stopping if it goes down." />
            <Metric
              label="No owner"
              value={s.unowned}
              tone={s.unowned > 0 ? 'bad' : 'good'}
              drillTo={s.unowned > 0 ? '/it/applications?status=active' : undefined}
              noActionReason={s.unowned === 0 ? 'Every application has an accountable owner.' : undefined}
            />
            <Metric label="Retired" value={s.byStatus.retired} noActionReason="Kept for the record." />
          </div>
        )
      )}

      <Tabs
        tabs={[
          { key: 'all', label: 'All' },
          { key: 'evaluating', label: 'Evaluating', count: s?.byStatus.evaluating },
          { key: 'active', label: 'Active', count: s?.byStatus.active },
          { key: 'sunsetting', label: 'Sunsetting', count: s?.byStatus.sunsetting },
          { key: 'retired', label: 'Retired', count: s?.byStatus.retired },
        ]}
        active={tab}
        onChange={setTab}
      />

      <Card>
        {apps.isLoading ? (
          <Loading label="Loading applications" />
        ) : rows.length === 0 ? (
          <EmptyState message="Nothing here." hint="Add an application, or widen the tab." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="py-2 pr-3">Application</th>
                  <th className="py-2 pr-3">Tier</th>
                  <th className="py-2 pr-3">Hosting</th>
                  <th className="py-2 pr-3">Category</th>
                  <th className="py-2 pr-3">Owner</th>
                  <th className="py-2 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-b border-ink-850/60">
                    <td className="py-2 pr-3">
                      <Link to={`/it/applications/${a.id}`} className="text-ink-100 hover:underline">
                        {a.name}
                      </Link>
                      <div className="text-2xs text-ink-500">
                        <RecordCode code={a.recordCode} /> {a.sso && '· SSO'}
                      </div>
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-ink-300">T{a.tier}</td>
                    <td className="py-2 pr-3 text-ink-300">{a.hosting}</td>
                    <td className="py-2 pr-3 text-ink-300">{a.category}</td>
                    <td className="py-2 pr-3 text-ink-300">{a.ownerPartyId ? a.ownerPartyId : <span className="text-band-critical">unowned</span>}</td>
                    <td className="py-2 pr-3">
                      <StatusChip status={a.status} tone={STATUS_TONE[a.status]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {newOpen && <NewApplicationModal onClose={() => setNewOpen(false)} />}
    </div>
  );
}

function NewApplicationModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const people = usePeoplePicker(true);
  const [name, setName] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [category, setCategory] = useState('');
  const [tier, setTier] = useState<'1' | '2' | '3' | '4'>('3');
  const [hosting, setHosting] = useState<Hosting | ''>('saas');
  const [ownerPartyId, setOwnerPartyId] = useState('');
  const [dataClassification, setDataClassification] = useState<Classification>('internal');
  const [sso, setSso] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/it/applications', {
        name,
        vendorName: vendorName || null,
        category,
        tier: Number(tier),
        hosting,
        ownerPartyId: ownerPartyId || null,
        dataClassificationHandled: dataClassification,
        sso,
        url: url || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-applications'] });
      qc.invalidateQueries({ queryKey: ['it-applications-summary'] });
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="New application"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="new-application-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Add application'}
          </button>
        </>
      }
    >
      <form
        id="new-application-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate(); }}
      >
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <TextInput label="Name" required autoFocus value={name} onChange={setName} />
        <Row>
          <TextInput label="Vendor" value={vendorName} onChange={setVendorName} placeholder="Optional" />
          <TextInput label="Category" required value={category} onChange={setCategory} placeholder="e.g. productivity, crm, finance" />
        </Row>
        <Row>
          <SelectInput label="Tier" required value={tier} onChange={setTier} options={[
            { value: '1', label: '1 — business-stopping' },
            { value: '2', label: '2' },
            { value: '3', label: '3' },
            { value: '4', label: '4 — low' },
          ]} />
          <SelectInput label="Hosting" required value={hosting} onChange={setHosting} options={[
            { value: 'saas', label: 'SaaS' },
            { value: 'on_prem', label: 'On-premises' },
            { value: 'cloud', label: 'Cloud (self-managed)' },
          ]} />
        </Row>
        <SelectInput
          label="Owner"
          value={ownerPartyId}
          onChange={setOwnerPartyId}
          placeholder={people.rows.length ? 'Nobody yet — leave unowned' : 'Nobody on file yet'}
          options={people.rows.map((p) => ({ value: p.id, label: p.primaryPhone ? `${p.fullName} — ${p.primaryPhone}` : p.fullName }))}
          hint="An application with nobody accountable for it is flagged, not silently allowed."
        />
        <SelectInput
          label="Data classification handled"
          required
          value={dataClassification}
          onChange={setDataClassification}
          options={[
            { value: 'internal', label: 'Internal' },
            { value: 'confidential', label: 'Confidential' },
            { value: 'restricted', label: 'Restricted' },
            { value: 'regulated', label: 'Regulated' },
          ]}
        />
        <TextInput label="URL" value={url} onChange={setUrl} placeholder="Optional" />
        <label className="flex items-center gap-2 text-xs text-ink-300">
          <input type="checkbox" checked={sso} onChange={(e) => setSso(e.target.checked)} />
          Single sign-on
        </label>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Application detail
// ---------------------------------------------------------------------------

const TRANSITION_LABEL: Record<ApplicationEvent, string> = {
  ACTIVATE: 'Activate',
  SUNSET: 'Sunset',
  RETIRE: 'Retire',
  REJECT: 'Reject',
};

export function ItApplicationDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useSession();
  const people = usePeoplePicker(true);
  const [ownerPartyId, setOwnerPartyId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['it-application', id],
    queryFn: () => api.get<ApplicationDetail>(`/it/applications/${id}`),
    enabled: Boolean(id),
  });

  const transition = useMutation({
    mutationFn: (event: ApplicationEvent) => api.post(`/it/applications/${id}/transition`, { event }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-application', id] });
      qc.invalidateQueries({ queryKey: ['it-applications'] });
      qc.invalidateQueries({ queryKey: ['it-applications-summary'] });
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  const setOwner = useMutation({
    mutationFn: () => api.patch(`/it/applications/${id}`, { ownerPartyId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-application', id] });
      qc.invalidateQueries({ queryKey: ['it-applications-summary'] });
      setOwnerPartyId('');
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  if (detail.error) return <ErrorBox error={detail.error} />;
  if (detail.isLoading || !detail.data) return <Loading label="Loading application" />;
  const app = detail.data;

  return (
    <div>
      <PageHeader
        title={app.name}
        subtitle={<><RecordCode code={app.recordCode} /> · {app.category} · {app.hosting} · tier {app.tier}</>}
        actions={
          <div className="flex flex-wrap gap-2">
            {can('it_applications:E') &&
              app.availableTransitions.map((ev) => (
                <button key={ev} className="btn" disabled={transition.isPending} onClick={() => { setError(null); transition.mutate(ev); }}>
                  {TRANSITION_LABEL[ev]}
                </button>
              ))}
          </div>
        }
      />

      {error && <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <dl className="divide-y divide-ink-850">
            <Field label="Status"><StatusChip status={app.status} tone={STATUS_TONE[app.status]} /></Field>
            <Field label="Vendor">{app.vendorName ?? '—'}</Field>
            <Field label="Data classification handled">{app.dataClassificationHandled}</Field>
            <Field label="Single sign-on">{app.sso ? 'Yes' : 'No'}</Field>
            <Field label="URL">{app.url ? <a href={app.url} target="_blank" rel="noreferrer" className="text-accent-soft hover:underline">{app.url}</a> : '—'}</Field>
            <Field label="Notes">{app.notes ?? '—'}</Field>
            <Field label="Owner">
              {app.ownerPartyId ? (
                app.ownerPartyId
              ) : (
                <span className="text-band-critical">
                  Unowned{app.unownedNotifiedAt ? ' — flagged as an exception' : ''}
                </span>
              )}
            </Field>
          </dl>
          {can('it_applications:E') && (
            <div className="mt-3 flex items-end gap-2 border-t border-ink-850 pt-3">
              <div className="flex-1">
                <SelectInput
                  label="Assign owner"
                  value={ownerPartyId}
                  onChange={setOwnerPartyId}
                  placeholder="Choose a person"
                  options={people.rows.map((p) => ({ value: p.id, label: p.primaryPhone ? `${p.fullName} — ${p.primaryPhone}` : p.fullName }))}
                />
              </div>
              <button className="btn" disabled={!ownerPartyId || setOwner.isPending} onClick={() => { setError(null); setOwner.mutate(); }}>
                {setOwner.isPending ? 'Saving…' : 'Set owner'}
              </button>
            </div>
          )}
        </Card>

        <Card>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Elsewhere</h3>
          <p className="text-xs text-ink-400">
            Continuity plan, incidents and change history for this application live on their own screens, linked by
            application id — not duplicated here.
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            <li><Link to="/it/continuity" className="text-accent-soft hover:underline">Continuity plans →</Link></li>
            <li><Link to="/it/incidents" className="text-accent-soft hover:underline">Incidents →</Link></li>
            <li><Link to="/it/changes" className="text-accent-soft hover:underline">Changes →</Link></li>
          </ul>
        </Card>
      </div>

      <Card className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">Licences</h3>
          {can('it_licences:C') && <Link to={`/it/licences?new=${app.id}`} className="btn-sm">Add a licence</Link>}
        </div>
        {app.licences.length === 0 ? (
          <EmptyState message="No licences recorded for this application." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="py-2 pr-3">Licence</th>
                  <th className="py-2 pr-3">Kind</th>
                  <th className="py-2 pr-3">Seats</th>
                  <th className="py-2 pr-3">Cost</th>
                  <th className="py-2 pr-3">Renews</th>
                  <th className="py-2 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {app.licences.map((l) => (
                  <tr key={l.id} className="border-b border-ink-850/60">
                    <td className="py-2 pr-3">
                      <Link to={`/it/licences/${l.id}`} className="text-ink-100 hover:underline"><RecordCode code={l.recordCode} /></Link>
                    </td>
                    <td className="py-2 pr-3 text-ink-300">{l.kind}</td>
                    <td className="py-2 pr-3 tabular-nums text-ink-300">{l.seatsInUse}/{l.seatsPurchased}</td>
                    <td className="py-2 pr-3 tabular-nums text-ink-300">{can('it_licences:F') ? money(l.costPerPeriod, l.currency) : <Withheld reason="no_permission" />}</td>
                    <td className="py-2 pr-3 text-ink-300">{l.renewalDate ? date(l.renewalDate) : '—'}</td>
                    <td className="py-2 pr-3"><StatusChip status={l.status} tone={LICENCE_STATUS_TONE[l.status]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Licences list
// ---------------------------------------------------------------------------

export function ItLicences() {
  const { can } = useSession();
  const navigate = useNavigate();
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const preselectedApp = params.get('new');
  const [tab, setTab] = useState<'renewing' | 'over_allocated' | 'all'>('all');
  const [newOpen, setNewOpen] = useState(Boolean(preselectedApp));

  const summary = useQuery({
    queryKey: ['it-licences-summary'],
    queryFn: () => api.get<LicencesSummary>('/it/licences/summary'),
  });
  const licences = useQuery({
    queryKey: ['it-licences', tab],
    queryFn: () => api.get<ItLicence[]>(`/it/licences?view=${tab}`),
  });

  if (licences.error) return <ErrorBox error={licences.error} />;
  const s = summary.data;
  const rows = licences.data ?? [];

  return (
    <div>
      <PageHeader
        title="Licences"
        subtitle="What was actually bought against an application — seats, cost, term and renewal. Seats in use are typed in; the platform does not meter logins."
        actions={can('it_licences:C') && <NewButton label="New licence" onClick={() => setNewOpen(true)} />}
      />

      {s?.notYetMeasured ? (
        <Card><EmptyState message="No licences recorded yet." /></Card>
      ) : (
        s && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Annualised spend" value={can('it_licences:F') ? money(s.annualisedSpend) : <Withheld reason="no_permission" />} noActionReason="Normalised across billing cycles." />
            <Metric label="Renewing in 90 days" value={s.renewingIn90Days} tone={s.renewingIn90Days > 0 ? 'warn' : 'good'} drillTo="/it/licences" />
            <Metric label="Over-allocated" value={s.overAllocated} tone={s.overAllocated > 0 ? 'bad' : 'good'} drillTo="/it/licences" />
            <Metric label="Seats purchased vs in use" value={`${s.seatsInUse}/${s.seatsPurchased}`} noActionReason="Across every un-cancelled licence." />
          </div>
        )
      )}

      <Tabs
        tabs={[
          { key: 'all', label: 'All' },
          { key: 'renewing', label: 'Renewing soon' },
          { key: 'over_allocated', label: 'Over-allocated' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <Card>
        {licences.isLoading ? (
          <Loading label="Loading licences" />
        ) : rows.length === 0 ? (
          <EmptyState message="Nothing here." hint="Add a licence, or widen the tab." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="py-2 pr-3">Licence</th>
                  <th className="py-2 pr-3">Application</th>
                  <th className="py-2 pr-3">Seats</th>
                  <th className="py-2 pr-3">Cost / period</th>
                  <th className="py-2 pr-3">Renews</th>
                  <th className="py-2 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const over = l.seatsInUse > l.seatsPurchased;
                  return (
                    <tr key={l.id} className="border-b border-ink-850/60">
                      <td className="py-2 pr-3">
                        <Link to={`/it/licences/${l.id}`} className="text-ink-100 hover:underline"><RecordCode code={l.recordCode} /></Link>
                      </td>
                      <td className="py-2 pr-3 text-ink-300">{l.application?.name ?? l.applicationId}</td>
                      <td className={`py-2 pr-3 tabular-nums ${over ? 'text-band-critical' : 'text-ink-300'}`}>{l.seatsInUse}/{l.seatsPurchased}</td>
                      <td className="py-2 pr-3 tabular-nums text-ink-300">{can('it_licences:F') ? `${money(l.costPerPeriod, l.currency)}/${l.billingCycle}` : <Withheld reason="no_permission" />}</td>
                      <td className="py-2 pr-3 text-ink-300">{l.renewalDate ? date(l.renewalDate) : '—'}</td>
                      <td className="py-2 pr-3"><StatusChip status={l.status} tone={LICENCE_STATUS_TONE[l.status]} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {newOpen && (
        <NewLicenceModal
          defaultApplicationId={preselectedApp ?? undefined}
          onClose={() => {
            setNewOpen(false);
            if (preselectedApp) navigate('/it/licences', { replace: true });
          }}
        />
      )}
    </div>
  );
}

function NewLicenceModal({ onClose, defaultApplicationId }: { onClose: () => void; defaultApplicationId?: string }) {
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: ['it-applications-picker'], queryFn: () => api.get<ItApplication[]>('/it/applications') });
  const [applicationId, setApplicationId] = useState(defaultApplicationId ?? '');
  const [kind, setKind] = useState<LicenceKind>('per_seat');
  const [seatsPurchased, setSeatsPurchased] = useState('0');
  const [seatsInUse, setSeatsInUse] = useState('0');
  const [costPerPeriod, setCostPerPeriod] = useState('0');
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('monthly');
  const [renewalDate, setRenewalDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/it/licences', {
        applicationId,
        kind,
        seatsPurchased: Number(seatsPurchased) || 0,
        seatsInUse: Number(seatsInUse) || 0,
        costPerPeriod: Number(costPerPeriod) || 0,
        billingCycle,
        renewalDate: renewalDate || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-licences'] });
      qc.invalidateQueries({ queryKey: ['it-licences-summary'] });
      qc.invalidateQueries({ queryKey: ['it-application', applicationId] });
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="New licence"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="new-licence-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Add licence'}
          </button>
        </>
      }
    >
      <form id="new-licence-form" className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate(); }}>
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <SelectInput
          label="Application"
          required
          value={applicationId}
          onChange={setApplicationId}
          placeholder="Choose an application"
          options={(apps.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
        />
        <SelectInput label="Kind" required value={kind} onChange={setKind} options={[
          { value: 'per_seat', label: 'Per seat' },
          { value: 'site', label: 'Site' },
          { value: 'perpetual', label: 'Perpetual' },
          { value: 'usage', label: 'Usage' },
        ]} />
        <Row>
          <TextInput label="Seats purchased" type="number" value={seatsPurchased} onChange={setSeatsPurchased} />
          <TextInput label="Seats in use" type="number" value={seatsInUse} onChange={setSeatsInUse} hint="Typed in, not metered." />
        </Row>
        <Row>
          <MoneyInput label="Cost per period" value={costPerPeriod} onChange={setCostPerPeriod} required />
          <SelectInput label="Billing cycle" required value={billingCycle} onChange={setBillingCycle} options={[
            { value: 'monthly', label: 'Monthly' },
            { value: 'quarterly', label: 'Quarterly' },
            { value: 'annual', label: 'Annual' },
            { value: 'one_off', label: 'One-off' },
          ]} />
        </Row>
        <TextInput label="Renewal date" type="date" value={renewalDate} onChange={setRenewalDate} hint="Optional — leave blank for a perpetual licence." />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Licence detail
// ---------------------------------------------------------------------------

export function ItLicenceDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useSession();
  const [seats, setSeats] = useState('');
  const [renewOpen, setRenewOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [decisionNote, setDecisionNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['it-licence', id],
    queryFn: () => api.get<LicenceDetailView>(`/it/licences/${id}`),
    enabled: Boolean(id),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['it-licence', id] });
    qc.invalidateQueries({ queryKey: ['it-licences'] });
    qc.invalidateQueries({ queryKey: ['it-licences-summary'] });
  };

  const seatsMutation = useMutation({
    mutationFn: () => api.post(`/it/licences/${id}/seats`, { seatsInUse: Number(seats) }),
    onSuccess: () => { invalidateAll(); setSeats(''); },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  const decideMutation = useMutation({
    mutationFn: (approve: boolean) => api.post(`/it/licences/${id}/approve-renewal`, { approve, note: decisionNote }),
    onSuccess: () => { invalidateAll(); setDecisionNote(''); },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  if (detail.error) return <ErrorBox error={detail.error} />;
  if (detail.isLoading || !detail.data) return <Loading label="Loading licence" />;
  const l = detail.data;

  return (
    <div>
      <PageHeader
        title={l.application?.name ?? l.applicationId}
        subtitle={<><RecordCode code={l.recordCode} /> · {l.kind} · {l.billingCycle}</>}
        actions={
          <div className="flex flex-wrap gap-2">
            {can('it_licences:E') && l.status !== 'cancelled' && !l.pendingRenewalApprovalStepId && (
              <button className="btn" onClick={() => setRenewOpen(true)}>Propose renewal</button>
            )}
            {can('it_licences:E') && l.status !== 'cancelled' && (
              <button className="btn" onClick={() => setCancelOpen(true)}>Cancel</button>
            )}
          </div>
        }
      />

      {error && <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <dl className="divide-y divide-ink-850">
            <Field label="Status"><StatusChip status={l.status} tone={LICENCE_STATUS_TONE[l.status]} /></Field>
            <Field label="Seats">
              {l.seatsInUse} in use of {l.seatsPurchased} purchased
              {l.seatUtilisation.percent !== null ? ` (${l.seatUtilisation.percent}%)` : ' (not yet measured — nothing purchased)'}
              {l.seatUtilisation.overAllocated && <span className="ml-2 text-band-critical">over-allocated</span>}
              <p className="mt-0.5 text-2xs italic text-ink-500">Typed in — the platform does not meter logins.</p>
            </Field>
            <Field label="Cost">{can('it_licences:F') ? `${money(l.costPerPeriod, l.currency)} / ${l.billingCycle}` : <Withheld reason="no_permission" />}</Field>
            <Field label="Annualised cost">{can('it_licences:F') ? money(l.annualisedCost, l.currency) : <Withheld reason="no_permission" />}</Field>
            <Field label="Term">{l.termStart ? date(l.termStart) : '—'} to {l.termEnd ? date(l.termEnd) : '—'}</Field>
            <Field label="Renewal date">{l.renewalDate ? date(l.renewalDate) : '—'}</Field>
            <Field label="Auto-renew">{l.autoRenew ? 'Yes' : 'No'}</Field>
            {l.cancelledReason && <Field label="Cancelled">{l.cancelledReason}</Field>}
          </dl>

          {can('it_licences:E') && l.status !== 'cancelled' && (
            <div className="mt-3 flex items-end gap-2 border-t border-ink-850 pt-3">
              <div className="flex-1">
                <TextInput label="Update seats in use" type="number" value={seats} onChange={setSeats} placeholder={String(l.seatsInUse)} />
              </div>
              <button className="btn" disabled={!seats || seatsMutation.isPending} onClick={() => { setError(null); seatsMutation.mutate(); }}>
                {seatsMutation.isPending ? 'Saving…' : 'Update'}
              </button>
            </div>
          )}

          {l.pendingRenewalApprovalStepId && (
            <div className="mt-3 rounded border border-band-watch/40 bg-band-watch/10 p-3 text-xs text-ink-200">
              <p className="mb-2 font-medium">
                A renewal to {l.pendingRenewalTermEnd ? date(l.pendingRenewalTermEnd) : '—'} is awaiting a decision. The person who proposed
                it cannot decide it — the Self-Dealing Bar is unconditional.
              </p>
              {can('it_licences:approve') && (
                <div className="flex flex-col gap-2">
                  <TextArea label="Decision note" value={decisionNote} onChange={setDecisionNote} rows={2} />
                  <div className="flex gap-2">
                    <button className="btn-primary" disabled={decideMutation.isPending} onClick={() => decideMutation.mutate(true)}>
                      Approve renewal
                    </button>
                    <button className="btn" disabled={decideMutation.isPending} onClick={() => decideMutation.mutate(false)}>
                      Decline
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>

        <Card>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">History</h3>
          {l.events.length === 0 ? (
            <EmptyState message="No events recorded yet." />
          ) : (
            <ul className="flex flex-col gap-2 text-xs">
              {l.events.map((ev) => (
                <li key={ev.id} className="border-b border-ink-850/60 pb-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-ink-100">{ev.kind.replace(/_/g, ' ')}</span>
                    <span className="text-2xs text-ink-500">{date(ev.createdAt)}</span>
                  </div>
                  {ev.note && <p className="mt-0.5 text-ink-400">{ev.note}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {renewOpen && (
        <RenewModal
          licenceId={id}
          currentCost={l.costPerPeriod}
          currentCycle={l.billingCycle}
          onClose={() => setRenewOpen(false)}
          onDone={invalidateAll}
        />
      )}
      {cancelOpen && <CancelModal licenceId={id} onClose={() => setCancelOpen(false)} onDone={invalidateAll} />}
    </div>
  );
}

function RenewModal({
  licenceId,
  currentCost,
  currentCycle,
  onClose,
  onDone,
}: {
  licenceId: string;
  currentCost: string | number | null;
  currentCycle: BillingCycle;
  onClose: () => void;
  onDone: () => void;
}) {
  const [newTermEnd, setNewTermEnd] = useState('');
  const [newCostPerPeriod, setNewCostPerPeriod] = useState(currentCost === null ? '' : String(currentCost));
  const [newBillingCycle, setNewBillingCycle] = useState<BillingCycle>(currentCycle);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/it/licences/${licenceId}/renew`, {
        newTermEnd,
        newCostPerPeriod: Number(newCostPerPeriod) || undefined,
        newBillingCycle,
        note: note || undefined,
      }),
    onSuccess: () => { onDone(); onClose(); },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="Propose a renewal"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="renew-licence-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Proposing…' : 'Propose renewal'}
          </button>
        </>
      }
    >
      <form id="renew-licence-form" className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate(); }}>
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <p className="text-2xs text-ink-500">A renewal you propose is never one you can approve — it always goes to Finance.</p>
        <TextInput label="New term end" type="date" required value={newTermEnd} onChange={setNewTermEnd} />
        <Row>
          <MoneyInput
            label="New cost per period"
            value={newCostPerPeriod}
            onChange={setNewCostPerPeriod}
            hint={currentCost === null ? 'You cannot see the current cost — leave blank to keep it unchanged.' : undefined}
          />
          <SelectInput label="Billing cycle" required value={newBillingCycle} onChange={setNewBillingCycle} options={[
            { value: 'monthly', label: 'Monthly' },
            { value: 'quarterly', label: 'Quarterly' },
            { value: 'annual', label: 'Annual' },
            { value: 'one_off', label: 'One-off' },
          ]} />
        </Row>
        <TextArea label="Note" value={note} onChange={setNote} rows={2} />
      </form>
    </Modal>
  );
}

function CancelModal({ licenceId, onClose, onDone }: { licenceId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/it/licences/${licenceId}/cancel`, { reason }),
    onSuccess: () => { onDone(); onClose(); },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="Cancel licence"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Back</button>
          <button type="submit" form="cancel-licence-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Cancelling…' : 'Cancel licence'}
          </button>
        </>
      }
    >
      <form id="cancel-licence-form" className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate(); }}>
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <TextArea label="Reason" value={reason} onChange={setReason} rows={3} required hint="A deliberate decision, not a status you forget to come back to." />
      </form>
    </Modal>
  );
}
