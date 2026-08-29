/**
 * Accounts and Institutions.
 *
 * One row per real legal body, forever. Two independent specialisations may
 * coexist on the same row — a single institution can also be a fee-paying
 * corporate client, which the legacy exclusive category enum could not
 * represent without forking the record.
 *
 * The specialisation badge shows presence; its contents are gated separately.
 * The fact of a specialisation is not itself sensitive — only what is inside it.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrganizationView } from '@kaizen/shared';
import { api, date, relative, titleCase } from '../lib/api.js';
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
  Tabs,
  Withheld,
} from '../components/ui.js';
import { useSession } from '../lib/session.js';

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'accent' | 'warn'> = {
  mou: 'good',
  active_relationship: 'good',
  active_opportunity: 'accent',
  contacted: 'neutral',
  prospect: 'neutral',
  inactive: 'warn',
  none: 'neutral',
};

export function Accounts() {
  const { can } = useSession();
  const [tab, setTab] = useState<'all' | 'account' | 'institution'>('all');
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const params = new URLSearchParams();
  if (tab !== 'all') params.set('specialisation', tab);
  if (q) params.set('q', q);

  const { data, isLoading, error } = useQuery({
    queryKey: ['organizations', tab, q],
    queryFn: () => api.get<{ items: OrganizationView[]; total: number }>(`/crm/organizations?${params}`),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Accounts & Institutions"
        subtitle="Companies and colleges we work with. One record per real organisation. A college can also be a paying client — both sides are kept on the same record rather than duplicated."
        actions={can('organizations:C') && <button className="btn-primary" onClick={() => setCreateOpen(true)}>New organisation</button>}
      />

      <div className="mb-3">
        <input className="input max-w-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or record code…" />
      </div>

      <Tabs
        tabs={[
          { key: 'all', label: 'All', count: data?.total },
          { key: 'account', label: 'With Account' },
          { key: 'institution', label: 'With Institution Profile' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState message="No organisations match what you searched for." />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((o) => (
            <Link key={o.id} to={`/crm/accounts/${o.id}`} className="card block p-4 transition-colors hover:border-ink-600">
              <div className="flex items-start justify-between gap-2">
                <RecordCode code={o.recordCode} />
                <StatusChip status={o.computedRelationshipStatus} tone={STATUS_TONE[o.computedRelationshipStatus] ?? 'neutral'} />
              </div>
              <p className="mt-1.5 text-sm font-medium text-ink-100">{o.name}</p>
              {o.website && <p className="truncate text-2xs text-ink-500">{o.website.replace('https://', '')}</p>}

              <div className="mt-3 flex flex-wrap gap-1">
                {o.specialisations.length === 0 && (
                  <span className="chip border-ink-800 text-ink-600">no specialisation attached</span>
                )}
                {o.specialisations.map((s) => (
                  <span
                    key={s.kind}
                    className={`chip ${s.viewable ? 'border-accent/40 text-accent-soft' : 'border-ink-700 text-ink-500'}`}
                    title={s.viewable ? undefined : 'Present, but its contents are not viewable under your grants.'}
                  >
                    {s.kind === 'account' ? 'Account' : 'Institution'}
                    {!s.viewable && ' ·  ⛨'}
                  </span>
                ))}
              </div>

              {o.institutionProfile && (
                <p className="mt-2 text-2xs text-ink-500">
                  {titleCase(o.institutionProfile.institutionType)} · {o.institutionProfile.district} ·{' '}
                  {o.institutionProfile.studentCount?.toLocaleString('en-IN')} students
                </p>
              )}
              {o.account && <p className="mt-1 text-2xs text-ink-500">Tier {o.account.tier} · {o.account.paymentTermsDays}d terms</p>}
            </Link>
          ))}
        </div>
      )}

      <CreateOrgModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateOrgModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post('/crm/organizations', { name, website: website || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['organizations'] });
      onClose();
      setName('');
      setWebsite('');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Creation failed'),
  });

  return (
    <Modal
      open={open}
      title="New organisation"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => create.mutate()} disabled={!name || create.isPending}>Create</button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Website</label>
          <input className="input" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" />
        </div>
        <p className="rounded border border-ink-800 bg-ink-950 px-3 py-2 text-2xs text-ink-500">
          Creating an organisation requires only a name. There is no category dropdown — attaching a specialisation is
          an explicit, separate action, never an implicit side effect.
        </p>
        {error && <p className="text-2xs text-band-critical">{error}</p>}
      </div>
    </Modal>
  );
}

export function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { can } = useSession();
  const [attach, setAttach] = useState<'account' | 'institution' | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['organization', id],
    queryFn: () => api.get<any>(`/crm/organizations/${id}`),
    enabled: Boolean(id),
  });

  const { data: relationships = [] } = useQuery({
    queryKey: ['relationships', 'organization', id],
    queryFn: () => api.get<any[]>(`/crm/relationships?entityType=organization&entityId=${id}&fullHistory=true`),
    enabled: Boolean(id),
  });

  const attachAccount = useMutation({
    mutationFn: () => api.post(`/crm/organizations/${id}/account`, { tier: 'standard', paymentTermsDays: 30 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['organization', id] });
      setAttach(null);
    },
  });

  const attachInstitution = useMutation({
    mutationFn: () =>
      api.post(`/crm/organizations/${id}/institution-profile`, { institutionType: 'engineering_college', state: 'Tamil Nadu' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['organization', id] });
      setAttach(null);
    },
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const org = data.organization;

  return (
    <div>
      <PageHeader
        title={org.name}
        subtitle={<span className="mono">{org.recordCode}</span>}
        actions={
          <>
            {!data.account && can('organizations:C') && (
              <button className="btn-ghost" onClick={() => attachAccount.mutate()} disabled={attachAccount.isPending}>
                Attach Account
              </button>
            )}
            {!data.institutionProfile && can('institutions:C') && (
              <button className="btn-ghost" onClick={() => attachInstitution.mutate()} disabled={attachInstitution.isPending}>
                Attach Institution Profile
              </button>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {data.specialisations.map((s: any) => (
          <span key={s.kind} className={`chip ${s.viewable ? 'border-accent/40 text-accent-soft' : 'border-ink-700 text-ink-500'}`}>
            {s.kind === 'account' ? 'Account' : 'Institution Profile'}
          </span>
        ))}
        <StatusChip status={data.computedRelationshipStatus} tone={STATUS_TONE[data.computedRelationshipStatus] ?? 'neutral'} />
        <span className="text-2xs text-ink-500" title="Computed at query time from live aggregations — never stored, because a stored value drifts from its evidence.">
          computed at query time
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {data.account && (
            <Card title="Account" subtitle="The CRM commercial-relationship specialisation, governed by organizations:*">
              <dl className="grid grid-cols-2 gap-x-6">
                <Field label="Tier">{titleCase(data.account.tier)}</Field>
                <Field label="Payment terms">{data.account.paymentTermsDays} days</Field>
                <Field label="Billing email">{data.account.billingEmail ?? '—'}</Field>
                <Field label="Revenue band">{data.account.annualRevenueBand ?? '—'}</Field>
              </dl>
            </Card>
          )}

          {data.institutionProfile ? (
            <Card title="Institution Profile" subtitle="The education/partnership specialisation, governed independently by institutions:*">
              <dl className="grid grid-cols-2 gap-x-6">
                <Field label="Type">{titleCase(data.institutionProfile.institutionType)}</Field>
                <Field label="Management">{titleCase(data.institutionProfile.managementType)}</Field>
                <Field label="District">{data.institutionProfile.district ?? '—'}</Field>
                <Field label="State">{data.institutionProfile.state ?? '—'}</Field>
                <Field label="Students">{data.institutionProfile.studentCount?.toLocaleString('en-IN') ?? '—'}</Field>
                <Field label="Established">{data.institutionProfile.establishedYear ?? '—'}</Field>
                <Field label="Registry identifier">
                  {data.institutionProfile.externalIdentifier ?? (
                    <span className="text-ink-500" title="Left blank when unknown. A missing answer is safe; a made-up one is not.">
                      not recorded
                    </span>
                  )}
                </Field>
                <Field label="Strategic priority">{titleCase(data.institutionProfile.strategicPriority)}</Field>
              </dl>
            </Card>
          ) : (
            data.withheld?.some((w: any) => w.path === 'institutionProfile') && (
              <Card title="Institution Profile">
                <div className="flex items-center gap-2">
                  <Withheld reason="no_permission" />
                  <p className="text-2xs text-ink-500">
                    The specialisation is present. Its contents require an institutions grant you do not hold.
                  </p>
                </div>
              </Card>
            )
          )}

          <Card title="Relationship history" subtitle="Changing the nature of a connection does not erase the old one — it is dated and a new one starts." bodyClassName="p-0">
            {relationships.length === 0 ? (
              <EmptyState message="No relationships recorded." hint="Connections appear here when something real happens — a meeting, a contract, an enrolment. Nothing is guessed." />
            ) : (
              <ul className="divide-y divide-ink-850">
                {relationships.map((r: any) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div>
                      <p className="text-xs text-ink-200">
                        {titleCase(r.relationshipType)}
                        {r.role && <span className="text-ink-500"> · {r.role}</span>}
                      </p>
                      <p className="text-2xs text-ink-500">
                        {date(r.startDate)} → {r.endDate ? date(r.endDate) : 'ongoing'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="chip border-ink-700 text-ink-400">{r.strength}</span>
                      <StatusChip status={r.status} tone={r.status === 'active' ? 'good' : 'neutral'} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Organisation">
            <dl>
              <Field label="Website">{org.website ?? '—'}</Field>
              <Field label="Created">{date(org.createdAt)}</Field>
              {org.legacyCategory && (
                <Field label="Legacy category">
                  <span className="text-ink-500" title="Retained transitionally for backward-compatible reporting only. Services test specialisation existence, never this field.">
                    {org.legacyCategory}
                  </span>
                </Field>
              )}
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
