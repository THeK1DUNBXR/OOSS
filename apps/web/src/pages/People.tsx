/**
 * People, the merge-candidate queue, and the interaction timeline.
 *
 * One PERSON row per real human, forever. A person's roles live entirely in
 * their affiliations — PERSON itself records neither role nor relationship.
 *
 * The merge queue is drained by human action, never auto-expired. A CRM role
 * sees "holds a non-CRM affiliation" as a badge, never the specialisation
 * detail behind it.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InteractionView, PersonView } from '@kaizen/shared';
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
  SensitivityChip,
  StatusChip,
  Tabs,
} from '../components/ui.js';
import { NewButton } from '../components/forms.js';
import { NewContact, NewInteraction } from '../components/createForms.js';
import { useSession } from '../lib/session.js';

/**
 * What a person is to us, as one word.
 *
 * Not a field on the person — their live affiliations, which is the whole
 * reason one human can be a student in 2024 and staff in 2026 without becoming
 * two records. Shown because a list where a student, an employee and somebody's
 * name off a business card render identically is a list you cannot act on.
 */
const ROLE_LABELS: Record<string, string> = {
  employee: 'Staff',
  student: 'Student',
  customer_contact: 'Client contact',
  institution_contact: 'College contact',
  partner_representative: 'Partner',
  parent_guardian: 'Guardian',
  alumnus: 'Alumnus',
  candidate: 'Candidate',
  vendor_contact: 'Supplier contact',
};

const ROLE_TONE: Record<string, string> = {
  student: 'border-accent/40 text-accent-soft',
  employee: 'border-band-good/40 text-band-good',
};

type PeopleGroup = 'all' | 'student' | 'employee' | 'contact' | 'none';

interface PeopleResponse {
  items: PersonView[];
  total: number;
  counts: Record<PeopleGroup, number>;
}

export function People() {
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<'people' | 'merge'>('people');
  const [group, setGroup] = useState<PeopleGroup>('all');
  const [q, setQ] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['people', q, group],
    queryFn: () =>
      api.get<PeopleResponse>(`/crm/people?q=${encodeURIComponent(q)}&affiliation=${group}`),
  });

  const { data: candidates = [] } = useQuery({
    queryKey: ['merge-candidates'],
    queryFn: () => api.get<any[]>('/crm/merge-candidates'),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <NewContact open={creating} onClose={() => setCreating(false)} />
      <PageHeader
        title="Contacts"
        subtitle="One record per person. Roles change; the person does not."
        actions={<NewButton label="Add a contact" onClick={() => setCreating(true)} />}
      />

      <Tabs
        tabs={[
          { key: 'people', label: 'People', count: data?.total },
          { key: 'merge', label: 'Merge candidates', count: candidates.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'people' && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input className="input max-w-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, record code or email…" />
            {/* Counted against the search but not against the selected group, so
                pressing a group never changes the numbers on the groups. */}
            {(
              [
                ['all', 'Everyone'],
                ['student', 'Students'],
                ['employee', 'Staff'],
                ['contact', 'Their people'],
                ['none', 'No stated role'],
              ] as Array<[PeopleGroup, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setGroup(key)}
                className={`chip transition-colors ${
                  group === key ? 'border-accent/60 text-accent-soft' : 'border-ink-800 text-ink-500 hover:border-ink-600'
                }`}
              >
                {label}
                {data?.counts?.[key] !== undefined && <span className="ml-1 tabular-nums text-ink-600">{data.counts[key]}</span>}
              </button>
            ))}
          </div>

          {isLoading ? (
            <Loading />
          ) : !data?.items.length ? (
            <Card>
              <EmptyState
                message={group === 'all' ? 'No people match.' : 'Nobody here yet.'}
                hint={
                  group === 'student'
                    ? 'Somebody becomes a student by being enrolled on a batch, not by being added here.'
                    : group === 'employee'
                      ? 'Somebody becomes staff by being put on the books under People, not by being added here.'
                      : undefined
                }
              />
            </Card>
          ) : (
            <Card bodyClassName="p-0 overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Reachable at</th>
                    <th>To us</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <RecordCode code={p.recordCode} to={`/crm/people/${p.id}`} />
                      </td>
                      <td>
                        <Link to={`/crm/people/${p.id}`} className="text-xs font-medium text-ink-100 hover:text-accent-soft">
                          {p.fullName}
                        </Link>
                      </td>
                      <td className="text-2xs text-ink-400">
                        {p.primaryPhone ?? '—'}
                        {p.primaryEmail && <span className="block">{p.primaryEmail}</span>}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {p.affiliations.length === 0 && (
                            <span className="text-2xs text-ink-600" title="On file, with no stated relationship to us yet.">
                              nothing stated
                            </span>
                          )}
                          {p.affiliations.map((a) => (
                            <span
                              key={a.id}
                              className={`chip ${ROLE_TONE[a.affiliationType] ?? 'border-ink-700 text-ink-400'}`}
                              title={a.counterpartyName ? `via ${a.counterpartyName}` : undefined}
                            >
                              {ROLE_LABELS[a.affiliationType] ?? titleCase(a.affiliationType)}
                              {a.counterpartyName && <span className="ml-1 text-ink-500">· {a.counterpartyName}</span>}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <StatusChip
                          status={p.dedupeStatus}
                          tone={p.dedupeStatus === 'active' ? 'good' : p.dedupeStatus === 'merged' ? 'neutral' : 'warn'}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}

      {tab === 'merge' && <MergeQueue candidates={candidates} />}
    </div>
  );
}

function MergeQueue({ candidates }: { candidates: any[] }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const [note, setNote] = useState<Record<string, string>>({});

  const resolve = useMutation({
    mutationFn: ({ id, disposition }: { id: string; disposition: string }) =>
      api.post(`/crm/merge-candidates/${id}/resolve`, { disposition, note: note[id] || 'Reviewed.' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merge-candidates'] }),
  });

  if (candidates.length === 0) {
    return (
      <Card>
        <EmptyState
          message="No open merge candidates."
          hint="Nothing waiting."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {candidates.map((c) => {
        const incoming = c.incomingPayload ?? {};
        return (
          <Card key={c.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="chip border-band-watch/40 text-band-watch">{titleCase(c.raisedReason)}</span>
                  <span className="chip border-ink-700 text-ink-400">confidence {(c.confidence * 100).toFixed(0)}%</span>
                  <span className="text-2xs text-ink-500">matched on {c.matchedOn.join(', ')}</span>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="rounded border border-ink-800 bg-ink-950 p-3">
                    <p className="text-2xs uppercase tracking-wide text-ink-500">Incoming</p>
                    <p className="mt-1 text-xs text-ink-100">{String(incoming.fullName ?? '—')}</p>
                    <p className="text-2xs text-ink-400">
                      {String(incoming.primaryPhone ?? '')} {String(incoming.primaryEmail ?? '')}
                    </p>
                  </div>
                  <div className="rounded border border-ink-800 bg-ink-950 p-3">
                    <p className="text-2xs uppercase tracking-wide text-ink-500">Existing candidate</p>
                    <p className="mt-1 text-xs text-ink-100">{c.candidate?.fullName ?? '—'}</p>
                    <p className="mono">{c.candidate?.recordCode}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {(c.candidate?.affiliationBadges ?? []).map((b: string, i: number) => (
                        <span key={i} className="chip border-ink-700 text-ink-500">
                          {titleCase(b)}
                        </span>
                      ))}
                    </div>
                    {c.candidate?.statutoryRetentionFloor && (
                      <p className="mt-1.5 text-2xs text-band-critical">
                        Never merged automatically, whatever the confidence.
                      </p>
                    )}
                  </div>
                </div>

                <input
                  className="input mt-3"
                  placeholder="Resolution note (required)"
                  value={note[c.id] ?? ''}
                  onChange={(e) => setNote({ ...note, [c.id]: e.target.value })}
                />
              </div>

              <div className="flex shrink-0 flex-col gap-1.5">
                <button
                  className="btn-primary"
                  disabled={!can('people:merge') || resolve.isPending}
                  onClick={() => resolve.mutate({ id: c.id, disposition: 'confirm' })}
                  title={can('people:merge') ? undefined : 'You are not allowed to merge people.'}
                >
                  Same person
                </button>
                <button className="btn-ghost" onClick={() => resolve.mutate({ id: c.id, disposition: 'reject' })}>
                  Different person
                </button>
                <button className="btn-ghost" onClick={() => resolve.mutate({ id: c.id, disposition: 'defer' })}>
                  Defer
                </button>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export function PersonDetail() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['person', id],
    queryFn: () => api.get<any>(`/crm/people/${id}`),
    enabled: Boolean(id),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const p = data.person;

  return (
    <div>
      <PageHeader title={p.fullName} subtitle={<span className="mono">{p.recordCode}</span>} />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Affiliations" subtitle="How they are connected to us today.">
            {p.affiliations.length === 0 ? (
              <EmptyState message="No roles recorded." />
            ) : (
              <div className="space-y-2">
                {p.affiliations.map((a: any) => (
                  <div key={a.id} className="flex items-center justify-between gap-3 rounded border border-ink-800 bg-ink-950 p-3">
                    <div>
                      <p className="text-xs font-medium text-ink-100">{titleCase(a.affiliationType)}</p>
                      <p className="text-2xs text-ink-500">
                        {a.counterpartyName ?? '—'}
                        {a.roleSlug && ` · ${titleCase(a.roleSlug)}`}
                      </p>
                      <p className="text-2xs text-ink-600">
                        {date(a.effectiveFrom)} → {a.effectiveTo ? date(a.effectiveTo) : 'ongoing'}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <StatusChip status={a.status} tone={a.status === 'active' ? 'good' : 'neutral'} />
                      {a.statutoryRetentionFloor && (
                        <span className="chip border-band-watch/40 text-band-watch" title="A dedup match against this person never auto-merges.">
                          retention floor
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Timeline" bodyClassName="p-0">
            {(data.timeline ?? []).length === 0 ? (
              <EmptyState message="Nothing logged." />
            ) : (
              <ul className="divide-y divide-ink-850">
                {data.timeline.map((t: InteractionView) => (
                  <li key={t.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="chip border-ink-700 text-ink-400">{t.interactionType}</span>
                      <SensitivityChip level={t.sensitivityClass} />
                      <span className="text-2xs text-ink-500">{relative(t.occurredAt)}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-200">{t.subject}</p>
                    {t.notes && <p className="mt-0.5 text-2xs text-ink-400">{t.notes}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Identity">
            <dl>
              <Field label="Phone">{p.primaryPhone ?? '—'}</Field>
              <Field label="Email">{p.primaryEmail ?? '—'}</Field>
              <Field label="Dedupe status">
                <StatusChip status={p.dedupeStatus} tone={p.dedupeStatus === 'active' ? 'good' : 'neutral'} />
              </Field>
              {p.mergedIntoId && (
                <Field label="Merged into">
                  <Link to={`/crm/people/${p.mergedIntoId}`} className="text-accent-soft hover:underline">
                    view surviving record
                  </Link>
                </Field>
              )}
              <Field label="Source">{titleCase(p.source)}</Field>
              <Field label="Created">{date(p.createdAt)}</Field>
            </dl>
          </Card>

          <Card title="Relationships" bodyClassName="p-0">
            {(data.relationships ?? []).length === 0 ? (
              <EmptyState message="No edges recorded." />
            ) : (
              <ul className="divide-y divide-ink-850">
                {data.relationships.map((r: any) => (
                  <li key={r.id} className="px-4 py-2.5">
                    <p className="text-xs text-ink-200">{titleCase(r.relationshipType)}</p>
                    <p className="text-2xs text-ink-500">
                      {r.role ?? '—'} · {r.strength} · {r.status}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

export function Interactions() {
  const [creating, setCreating] = useState(false);
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['interactions'],
    queryFn: () => api.get<InteractionView[]>('/crm/interactions?limit=80'),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <NewInteraction open={creating} onClose={() => setCreating(false)} />
      <PageHeader
        actions={<NewButton label="Log a call" onClick={() => setCreating(true)} />}
        title="Calls & meetings"
        subtitle="Calls, meetings and notes, on every record they touch."
      />

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState message="Nothing logged within what you may reach." />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <ul className="divide-y divide-ink-850">
            {data.map((t) => (
              <li key={t.id} className="px-4 py-3 hover:bg-ink-850/40">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono">{t.recordCode}</span>
                  <span className="chip border-ink-700 text-ink-400">{t.interactionType}</span>
                  <span className="chip border-ink-800 text-ink-500">{t.direction}</span>
                  <SensitivityChip level={t.sensitivityClass} />
                  <span className="ml-auto text-2xs text-ink-500">{relative(t.occurredAt)}</span>
                </div>
                <p className="mt-1 text-xs font-medium text-ink-100">{t.subject ?? '—'}</p>
                {t.notes ? (
                  <p className="mt-0.5 text-2xs text-ink-400">{t.notes}</p>
                ) : (
                  t.withheld.length > 0 && (
                    <p className="mt-0.5 text-2xs italic text-ink-600">
                      {t.withheld.map((w) => `${w.path} withheld · ${w.reason.replace(/_/g, ' ')}`).join(', ')}
                    </p>
                  )
                )}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {t.relatedReferences.map((r, i) => (
                    <span key={i} className="chip border-ink-800 text-ink-500">
                      {r.contextCode}.{r.entityType}
                      {r.displayLabel && ` · ${r.displayLabel}`}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
