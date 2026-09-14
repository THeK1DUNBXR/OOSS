/**
 * The two kinds of body the company deals with, on two screens.
 *
 * They used to be one screen called "Companies & Colleges", on the reasoning
 * that a body might be both and keeping two records of one legal entity is how
 * a CRM starts lying to you. The reasoning held about billing and failed about
 * identity: the list answered neither "which colleges do we work with" nor "who
 * are our corporate clients", and a polytechnic sat between two manufacturers.
 *
 * So `Institutions` lists schools and colleges, `Organizations` lists trusts,
 * foundations and businesses, and neither contains the other. Billing detail
 * belongs to both, because being invoiced is not an identity. The third party
 * type, the student, is a person and has its own screen.
 *
 * `BodyDetail` serves both: one record, shown according to what it is.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  INSTITUTION_ENGAGEMENT_LABELS,
  ORGANIZATION_ROLE_LABELS,
  ORGANIZATION_ROLES,
  type InstitutionEngagement,
  type OrganizationRole,
} from '@kaizen/shared';
import { api, date, relative, titleCase } from '../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  PageHeader,
  RecordCode,
  StatusChip,
  Tabs,
  Withheld,
} from '../components/ui.js';
import { AddBillingDetails, AddSchoolDetails, NewInstitution, NewOrganization } from '../components/createForms.js';
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

interface BodyRow {
  id: string;
  recordCode: string;
  kind: string;
  roles: string[];
  name: string;
  website: string | null;
  billed: boolean;
  account: { tier: string | null; paymentTermsDays: number | null } | null;
  institutionProfile: {
    institutionType: string | null;
    district: string | null;
    studentCount: number | null;
    engagements: string[];
    accreditation: string | null;
  } | null;
  computedRelationshipStatus: string;
}

/**
 * One list, told what it is listing.
 *
 * The kind is not a filter this component chooses — it comes from the route and
 * from the endpoint, so there is no view of the screen in which the two are
 * mixed back together.
 */
function BodyList({
  kind,
  title,
  subtitle,
  addLabel,
  permission,
  emptyMessage,
  emptyHint,
  renderForm,
}: {
  kind: 'institution' | 'organization';
  title: string;
  subtitle: string;
  addLabel: string;
  permission: string;
  emptyMessage: string;
  emptyHint: string;
  renderForm: (open: boolean, onClose: () => void) => React.ReactNode;
}) {
  const { can } = useSession();
  const [tab, setTab] = useState<'all' | 'billed' | 'unbilled'>('all');
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  // `?new=1` opens the form on arrival, so a button elsewhere that says "Add a
  // student" adds one rather than landing somebody on a list. The parameter is
  // cleared as the form opens: a reload should not reopen it, and Back should
  // return to the list.
  const [search, setSearch] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(() => search.get('new') === '1');
  useEffect(() => {
    if (search.get('new') !== '1') return;
    setCreateOpen(true);
    const rest = new URLSearchParams(search);
    rest.delete('new');
    setSearch(rest, { replace: true });
  }, [search, setSearch]);

  const endpoint = kind === 'institution' ? 'institutions' : 'organizations';
  const params = new URLSearchParams();
  if (tab === 'billed') params.set('billing', 'yes');
  if (tab === 'unbilled') params.set('billing', 'no');
  if (role) params.set('role', role);
  if (q) params.set('q', q);

  const { data, isLoading, error } = useQuery({
    queryKey: [endpoint, tab, role, q],
    queryFn: () => api.get<{ items: BodyRow[]; total: number }>(`/crm/${endpoint}?${params}`),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          can(permission) && (
            <button className="btn-primary" onClick={() => setCreateOpen(true)}>
              {addLabel}
            </button>
          )
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="input max-w-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or record code…"
        />
        {/* "Which of these sponsor cohorts", "which of them hire our learners" —
            asked of what a body does, which is not what it is. */}
        {kind === 'organization' && (
          <select className="input max-w-xs" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Whatever they are to us</option>
            {ORGANIZATION_ROLES.map((r) => (
              <option key={r} value={r}>
                {ORGANIZATION_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Not a kind filter — the kind is the screen. This asks a question about
          money: which of these do we actually invoice. */}
      <Tabs
        tabs={[
          { key: 'all', label: 'All', count: data?.total },
          { key: 'billed', label: 'We invoice them' },
          { key: 'unbilled', label: 'We do not' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState
            message={q ? 'Nothing matches what you searched for.' : emptyMessage}
            hint={q ? undefined : emptyHint}
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((o) => (
            <Link
              key={o.id}
              to={`/crm/${endpoint}/${o.id}`}
              className="card block p-4 transition-colors hover:border-ink-600"
            >
              <div className="flex items-start justify-between gap-2">
                <RecordCode code={o.recordCode} />
                <StatusChip
                  status={o.computedRelationshipStatus}
                  tone={STATUS_TONE[o.computedRelationshipStatus] ?? 'neutral'}
                />
              </div>
              <p className="mt-1.5 text-sm font-medium text-ink-100">{o.name}</p>
              {o.website && <p className="truncate text-2xs text-ink-500">{o.website.replace('https://', '')}</p>}

              <div className="mt-3 flex flex-wrap gap-1">
                {kind === 'institution'
                  ? (o.institutionProfile?.engagements ?? []).map((e) => (
                      <span key={e} className="chip border-accent/40 text-accent-soft">
                        {INSTITUTION_ENGAGEMENT_LABELS[e as InstitutionEngagement] ?? e}
                      </span>
                    ))
                  : (o.roles ?? []).map((r) => (
                      <span key={r} className="chip border-accent/40 text-accent-soft">
                        {ORGANIZATION_ROLE_LABELS[r as OrganizationRole] ?? r}
                      </span>
                    ))}
                {(kind === 'institution'
                  ? (o.institutionProfile?.engagements ?? []).length === 0
                  : (o.roles ?? []).length === 0) && (
                  <span className="chip border-ink-800 text-ink-600">
                    {kind === 'institution' ? 'no engagement recorded yet' : 'nothing recorded yet'}
                  </span>
                )}
                {o.billed && <span className="chip border-ink-700 text-ink-400">We invoice them</span>}
              </div>

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

      {renderForm(createOpen, () => setCreateOpen(false))}
    </div>
  );
}

export function Institutions() {
  return (
    <BodyList
      kind="institution"
      title="Institutions"
      subtitle="The schools and colleges our learners come from."
      addLabel="Add a school or college"
      permission="institutions:C"
      emptyMessage="No schools or colleges yet."
      emptyHint="A customer's record names the college they came from."
      renderForm={(open, onClose) => <NewInstitution open={open} onClose={onClose} />}
    />
  );
}

export function Organizations() {
  return (
    <BodyList
      kind="organization"
      title="Organisations"
      subtitle="Businesses, trusts and foundations we deal with."
      addLabel="Add an organisation"
      permission="organizations:C"
      emptyMessage="No organisations yet."
      emptyHint="Schools and colleges live under Institutions."
      renderForm={(open, onClose) => <NewOrganization open={open} onClose={onClose} />}
    />
  );
}

/**
 * One body, shown according to what it is.
 *
 * Served from both routes because it is one record either way; what changes is
 * which panels are on it and what the buttons offer. A school's page leads with
 * the learners it has sent; an organisation's leads with how it is billed.
 */
export function BodyDetail({ kind }: { kind: 'institution' | 'organization' }) {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const [adding, setAdding] = useState<'billing' | 'school' | null>(null);
  const [editingBase, setEditingBase] = useState(false);
  const endpoint = kind === 'institution' ? 'institutions' : 'organizations';

  const { data, isLoading, error } = useQuery({
    queryKey: ['organization', id],
    queryFn: () => api.get<any>(`/crm/${endpoint}/${id}`),
    enabled: Boolean(id),
  });

  const { data: relationships = [] } = useQuery({
    queryKey: ['relationships', 'organization', id],
    queryFn: () => api.get<any[]>(`/crm/relationships?entityType=organization&entityId=${id}&fullHistory=true`),
    enabled: Boolean(id),
  });

  const org = data?.organization;

  // A fresh object every render would reset whatever somebody is mid-typing
  // in the edit form each time this page re-renders for an unrelated reason,
  // so this is only rebuilt when the record itself actually changes.
  const institutionForEdit = useMemo(
    () =>
      org
        ? { id: org.id, name: org.name, website: org.website, institutionProfile: data?.institutionProfile ?? null }
        : null,
    [org, data?.institutionProfile],
  );

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  return (
    <div>
      <PageHeader
        title={org.name}
        subtitle={<span className="mono">{org.recordCode}</span>}
        actions={
          <>
            {can(`${endpoint}:E`) && (
              <button className="btn-ghost" onClick={() => setEditingBase(true)}>Edit</button>
            )}
            {!data.account && can(`${endpoint}:C`) && (
              <button className="btn-ghost" onClick={() => setAdding('billing')}>How we bill them</button>
            )}
            {data.account && can(`${endpoint}:E`) && (
              <button className="btn-ghost" onClick={() => setAdding('billing')}>Edit billing</button>
            )}
            {kind === 'institution' && !data.institutionProfile && can('institutions:C') && (
              <button className="btn-ghost" onClick={() => setAdding('school')}>What kind of place it is</button>
            )}
            {kind === 'institution' && data.institutionProfile && can('institutions:E') && (
              <button className="btn-ghost" onClick={() => setAdding('school')}>Edit school details</button>
            )}
          </>
        }
      />

      {kind === 'institution' ? (
        <NewInstitution open={editingBase} onClose={() => setEditingBase(false)} institution={institutionForEdit} />
      ) : (
        <NewOrganization open={editingBase} onClose={() => setEditingBase(false)} organization={org} />
      )}

      <AddBillingDetails
        open={adding === 'billing'}
        organizationId={id!}
        name={org.name}
        queryKey={endpoint}
        existing={data.account}
        onClose={() => setAdding(null)}
      />
      <AddSchoolDetails
        open={adding === 'school'}
        organizationId={id!}
        name={org.name}
        existing={data.institutionProfile}
        onClose={() => setAdding(null)}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="chip border-accent/40 text-accent-soft">
          {org.kind === 'institution' ? 'School or college' : 'Organisation'}
        </span>
        {org.kind === 'institution'
          ? (data.institutionProfile?.engagements ?? []).map((e: string) => (
              <span key={e} className="chip border-accent/40 text-accent-soft">
                {INSTITUTION_ENGAGEMENT_LABELS[e as InstitutionEngagement] ?? e}
              </span>
            ))
          : (org.roles ?? []).map((r: string) => (
              <span key={r} className="chip border-accent/40 text-accent-soft">
                {ORGANIZATION_ROLE_LABELS[r as OrganizationRole] ?? r}
              </span>
            ))}
        {data.account && <span className="chip border-ink-700 text-ink-400">We invoice them</span>}
        <StatusChip status={data.computedRelationshipStatus} tone={STATUS_TONE[data.computedRelationshipStatus] ?? 'neutral'} />
        <span className="text-2xs text-ink-500" title="Worked out when you ask for it, never stored.">
          computed at query time
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {data.account && (
            <Card title="How we bill them" subtitle="Terms, where the invoice goes, and the GSTIN.">
              <dl className="grid grid-cols-2 gap-x-6">
                <Field label="Tier">{titleCase(data.account.tier)}</Field>
                <Field label="Payment terms">{data.account.paymentTermsDays} days</Field>
                <Field label="Billing email">{data.account.billingEmail ?? '—'}</Field>
                <Field label="Revenue band">{data.account.annualRevenueBand ?? '—'}</Field>
              </dl>
            </Card>
          )}

          {data.institutionProfile ? (
            <Card title="What kind of place it is" subtitle="Type, management, district and accreditation.">
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
                <Field label="Accreditation">{data.institutionProfile.accreditation ?? '—'}</Field>
              </dl>
            </Card>
          ) : (
            data.withheld?.some((w: any) => w.path === 'institutionProfile') && (
              <Card title="What kind of place it is">
                <div className="flex items-center gap-2">
                  <Withheld reason="no_permission" />
                  <p className="text-2xs text-ink-500">
                    Seeing this detail needs a grant on institutions that you do not hold.
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
                    hint="Add one under Students and name this college as where they came from."
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

          <Card title="Relationship history" subtitle="Past connections are kept, not written over." bodyClassName="p-0">
            {relationships.length === 0 ? (
              <EmptyState message="No relationships recorded." hint="Connections appear when something happens — a meeting, a contract, an enrolment." />
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
          <Card title={org.kind === 'institution' ? 'The institution' : 'The organisation'}>
            <dl>
              <Field label="Website">{org.website ?? '—'}</Field>
              <Field label="Created">{date(org.createdAt)}</Field>
              {org.legacyCategory && (
                <Field label="Legacy category">
                  <span className="text-ink-500" title="Kept for older reports only. Nothing depends on it.">
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
