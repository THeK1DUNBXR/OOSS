/**
 * Companies and colleges.
 *
 * One row per real legal body, forever. Two independent facts may
 * coexist on the same row — a single institution can also be a fee-paying
 * corporate client, which the legacy exclusive category enum could not
 * represent without forking the record.
 *
 * The specialisation badge shows presence; its contents are gated separately.
 * The fact of a specialisation is not itself sensitive — only what is inside it.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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
import { MarkAsClient, MarkAsCollege, NewOrganization } from '../components/createForms.js';
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
        title="Companies & Colleges"
        subtitle="Every organisation we deal with, one record each. What an organisation is to us — a client we invoice, a college we recruit students from, or both at once — is recorded on that one record rather than by keeping two."
        actions={can('organizations:C') && <button className="btn-primary" onClick={() => setCreateOpen(true)}>Add a company or college</button>}
      />

      <div className="mb-3">
        <input className="input max-w-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or record code…" />
      </div>

      <Tabs
        tabs={[
          { key: 'all', label: 'All', count: data?.total },
          { key: 'account', label: 'Clients' },
          { key: 'institution', label: 'Colleges' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState
            message={q ? 'No organisations match what you searched for.' : 'No companies or colleges yet.'}
            hint={q ? undefined : 'Add the companies you invoice and the colleges you recruit students from — an organisation can be both.'}
          />
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
                  <span className="chip border-ink-800 text-ink-600">not a client or a college yet</span>
                )}
                {o.specialisations.map((s) => (
                  <span
                    key={s.kind}
                    className={`chip ${s.viewable ? 'border-accent/40 text-accent-soft' : 'border-ink-700 text-ink-500'}`}
                    title={s.viewable ? undefined : 'Present, but its contents are not viewable under your grants.'}
                  >
                    {s.kind === 'account' ? 'Client' : 'College'}
                    {!s.viewable && ' ·  ⛨'}
                  </span>
                ))}
              </div>

              {/* Joined from whatever is actually known. A missing student count
                  used to render as a bare "· students", and an absent payment
                  term as "· undefinedd terms" — both of which read as a bug
                  rather than as an unfilled field. */}
              {o.institutionProfile && (
                <p className="mt-2 text-2xs text-ink-500">
                  {[
                    titleCase(o.institutionProfile.institutionType),
                    o.institutionProfile.district,
                    o.institutionProfile.studentCount
                      ? `${o.institutionProfile.studentCount.toLocaleString('en-IN')} students`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'No detail recorded yet'}
                </p>
              )}
              {o.account && (
                <p className="mt-1 text-2xs text-ink-500">
                  {[
                    o.account.tier ? `Tier ${o.account.tier}` : null,
                    o.account.paymentTermsDays ? `${o.account.paymentTermsDays}d terms` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'No billing detail recorded yet'}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}

      <NewOrganization open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

export function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const [marking, setMarking] = useState<'client' | 'college' | null>(null);

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
              <button className="btn-ghost" onClick={() => setMarking('client')}>Mark as a client</button>
            )}
            {!data.institutionProfile && can('institutions:C') && (
              <button className="btn-ghost" onClick={() => setMarking('college')}>Mark as a college</button>
            )}
          </>
        }
      />

      <MarkAsClient
        open={marking === 'client'}
        organizationId={id!}
        name={org.name}
        onClose={() => setMarking(null)}
      />
      <MarkAsCollege
        open={marking === 'college'}
        organizationId={id!}
        name={org.name}
        onClose={() => setMarking(null)}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {data.specialisations.map((s: any) => (
          <span key={s.kind} className={`chip ${s.viewable ? 'border-accent/40 text-accent-soft' : 'border-ink-700 text-ink-500'}`}>
            {s.kind === 'account' ? 'Client' : 'College'}
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
            <Card title="As a college" subtitle="What we know about them as an institution. Read separately from the client side — someone who can see the billing terms does not automatically see this.">
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
              <Card title="As a college">
                <div className="flex items-center gap-2">
                  <Withheld reason="no_permission" />
                  <p className="text-2xs text-ink-500">
                    They are marked as a college. Seeing the detail needs a grant on institutions that you do not hold.
                  </p>
                </div>
              </Card>
            )
          )}

          {/* A college's page used to describe the college and say nothing about
              what the relationship has produced, which is the only reason to
              keep colleges apart from the companies we invoice. `students` is
              absent — not empty — when the viewer holds no grant on education,
              because "none" and "not for you" are different answers. */}
          {data.students && (
            <Card
              title="Students from here"
              subtitle="Everyone recorded as having come to us from this college."
              bodyClassName="p-0"
              actions={<span className="chip border-ink-700 text-ink-400">{data.students.length}</span>}
            >
              {data.students.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    message="No students from this college yet."
                    hint="Enrol one from Students and name this college as where they came from."
                  />
                </div>
              ) : (
                <ul className="divide-y divide-ink-850">
                  {data.students.map((st: any) => (
                    <li key={st.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div>
                        <p className="text-xs text-ink-200">{st.personName ?? '—'}</p>
                        <p className="text-2xs text-ink-500">
                          <span className="mono">{st.recordCode}</span> · {st.cohortName}
                        </p>
                      </div>
                      <StatusChip status={st.status} tone={st.status === 'completed' ? 'good' : 'neutral'} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
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
