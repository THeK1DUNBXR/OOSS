/**
 * Platform administration.
 *
 * These surfaces make the mechanisms inspectable: the pipeline vocabulary as
 * configuration data, the grant matrix as durable rows rather than a compiled
 * file, the hash-chained event log with per-link verification, the agent roster
 * with its own authority grants, and the audit trail including regulated-read
 * records that name fields but never values.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentView, EventView, PipelineView } from '@kaizen/shared';
import { api, date, dateTime, money, relative, titleCase } from '../lib/api.js';
import { grantSentence, words } from '../lib/words.js';
import {
  Card,
  ContributionBar,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Metric,
  Modal,
  PageHeader,
  RecordCode,
  SensitivityChip,
  StatusChip,
  Tabs,
} from '../components/ui.js';

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

export function PipelineAdmin() {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => api.get<any[]>('/pipelines'),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Pipeline Configuration"
        subtitle="The stages each kind of deal moves through, and how long each should take. Change any of it here — no developer, no release."
      />

      {isLoading ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          {data.map((p: any) => (
            <Card
              key={p.id}
              title={p.name}
              subtitle={
                <span>
                  <span className="mono">{p.pipelineCode}</span> · {titleCase(p.commercialMotion)} ·{' '}
                  {titleCase(p.defaultForecastMethod)} · requires {titleCase(p.requiresAwardArtefact)}
                </span>
              }
              actions={
                <>
                  {p.isDefault && <span className="chip border-accent/40 text-accent-soft">default</span>}
                  <StatusChip status={p.usable ? 'usable' : 'incomplete'} tone={p.usable ? 'good' : 'warn'} />
                </>
              }
            >
              {!p.usable && <p className="mb-3 text-2xs text-band-watch">{p.usableReason}</p>}

              <div className="mb-3 flex flex-wrap gap-2 text-2xs text-ink-500">
                <span>{p.leadCount} leads</span>
                <span>·</span>
                <span>{p.opportunityCount} opportunities</span>
                <span>·</span>
                <span>verticals: {p.appliesToVerticals.length ? p.appliesToVerticals.join(', ') : 'any (fallback)'}</span>
              </div>

              <table className="table">
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th className="text-right" title="The shared scale that lets different kinds of business be compared side by side.">Position</th>
                    <th className="text-right">Probability</th>
                    <th className="text-right">SLA budget</th>
                    <th>Required fields</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {p.stages.map((s: any) => (
                    <tr key={s.id}>
                      <td>
                        <p className="text-xs text-ink-100">{s.label}</p>
                        <p className="mono">{s.stageKey}</p>
                      </td>
                      <td className="text-right tabular-nums text-xs text-accent-soft">{s.pipelinePosition}</td>
                      <td className="text-right tabular-nums text-xs">{s.defaultProbability}%</td>
                      <td className="text-right tabular-nums text-2xs text-ink-400">
                        {s.stageAgeBudgetDays ? `${s.stageAgeBudgetDays}d` : <span className="text-ink-600">no clock</span>}
                      </td>
                      <td className="text-2xs text-ink-400">{s.requiredFields.length ? s.requiredFields.join(', ') : '—'}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {s.isTerminal && <span className="chip border-ink-700 text-ink-400">terminal</span>}
                          {s.postAward && (
                            <span className="chip border-band-watch/40 text-band-watch" title="No longer in use. Old records still show it, but nothing new can be moved here.">
                              post-award (retired)
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <details className="mt-3">
                <summary className="cursor-pointer text-2xs text-ink-500 hover:text-ink-300">
                  {p.transitions.length} permitted transitions
                </summary>
                <div className="mt-2 flex flex-wrap gap-1">
                  {p.transitions.map((t: any) => (
                    <span key={t.id} className="chip border-ink-800 text-ink-500">
                      {t.fromStageKey ?? '(create)'} → {t.toStageKey}
                    </span>
                  ))}
                </div>
              </details>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Territories & routing
// ---------------------------------------------------------------------------

export function TerritoryAdmin() {
  const { data: territories = [], isLoading } = useQuery({
    queryKey: ['territories'],
    queryFn: () => api.get<any[]>('/pipelines/territories/all'),
  });

  const { data: rules = [] } = useQuery({
    queryKey: ['routing-rules'],
    queryFn: () => api.get<any[]>('/pipelines/routing-rules/all'),
  });

  return (
    <div>
      <PageHeader
        title="Territories & Assignment"
        subtitle="How new enquiries get assigned. Region and specialism are absolute: someone outside them is never picked, however free they are. Everyone who passes both is then compared on workload, expertise and existing relationships."
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Territories" bodyClassName="p-0">
          {isLoading ? (
            <Loading />
          ) : territories.length === 0 ? (
            <EmptyState message="No territories have been set up yet." />
          ) : (
            <ul className="divide-y divide-ink-850">
              {territories.map((t) => (
                <li key={t.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-ink-100">{t.name}</p>
                    <span className="mono">{t.recordCode}</span>
                  </div>
                  <p className="mt-0.5 text-2xs text-ink-500">
                    {t.geoAreaRef.length ? t.geoAreaRef.join(', ') : 'state-wide'} ·{' '}
                    {t.appliesToVerticals.join(', ') || 'all verticals'} · {t.appliesToAccountKind}
                  </p>
                  <p className="mt-0.5 text-2xs text-ink-600">
                    capacity ceiling {t.capacityCeiling} · owner position{' '}
                    <span className="font-mono">{t.ownerPositionId ?? 'unset'}</span>
                    <span title="A job, not a person — so this still works when someone changes role or leaves."> ⓘ</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Routing rules" subtitle="Six things are weighed up, in this order. Taking turns is only used to break a tie.">
          {rules.map((r) => (
            <div key={r.id} className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-ink-100">{r.name}</p>
                <StatusChip status={r.active ? 'active' : 'inactive'} tone={r.active ? 'good' : 'neutral'} />
              </div>

              <div className="space-y-1.5">
                {[
                  { factor: 'Territory', type: 'hard filter', weight: null },
                  { factor: 'Vertical grant', type: 'hard filter', weight: null },
                  ...Object.entries(r.factorWeights as Record<string, number>).map(([k, v]) => ({
                    factor: titleCase(k),
                    type: k === 'round_robin' ? 'tie-break only' : 'soft',
                    weight: v,
                  })),
                ].map((f) => (
                  <div key={f.factor} className="flex items-center gap-2 text-2xs">
                    <span className="w-36 shrink-0 text-ink-300">{f.factor}</span>
                    <span className="w-24 shrink-0 text-ink-600">{f.type}</span>
                    {f.weight !== null ? (
                      <>
                        <div className="flex-1">
                          <ContributionBar value={f.weight} max={30} />
                        </div>
                        <span className="w-8 shrink-0 text-right tabular-nums text-ink-400">{f.weight}</span>
                      </>
                    ) : (
                      <span className="flex-1 text-ink-600">runs first; failures are never scored</span>
                    )}
                  </div>
                ))}
              </div>

              <p className="text-2xs text-ink-500">
                Tie-break margin {r.tieBreakMarginPoints} points. Relationship strength is weighted equal to capacity
                deliberately — in the institution motion, a warm existing contact beats an empty diary.
              </p>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Governance: roles, grants, policies
// ---------------------------------------------------------------------------

/**
 * Spells a matrix cell out as a sentence for its tooltip. `VCEA@own` is quick
 * to scan once you know it and impossible to check if you do not, so the screen
 * offers both readings rather than choosing one.
 */
const CELL_LETTERS: Record<string, string> = {
  V: 'view', C: 'create', E: 'edit', D: 'delete',
  A: 'assign', X: 'export', F: 'financial',
};

function explainCell(resource: string, cell: string): string {
  const [letters, scope] = cell.split('@');
  const verbs: string[] = [];
  for (const token of letters.split(',')) {
    const t = token.trim();
    if (t === 'approve' || t === 'merge') { verbs.push(t); continue; }
    for (const ch of t) if (CELL_LETTERS[ch]) verbs.push(CELL_LETTERS[ch]);
  }
  return `${resource} — ${grantSentence([...new Set(verbs)], scope ?? 'all')}`;
}

export function Governance() {
  const [tab, setTab] = useState<'matrix' | 'roles' | 'policies' | 'authority'>('matrix');

  const { data: matrix } = useQuery({
    queryKey: ['grant-matrix'],
    queryFn: () => api.get<{ roles: string[]; resources: string[]; matrix: Record<string, Record<string, string>> }>('/admin/grant-matrix'),
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<any[]>('/admin/roles'),
  });

  const { data: policies = [] } = useQuery({
    queryKey: ['policies'],
    queryFn: () => api.get<any[]>('/admin/policies'),
  });

  const { data: authority = [] } = useQuery({
    queryKey: ['authority-grants'],
    queryFn: () => api.get<any[]>('/admin/authority-grants'),
  });

  return (
    <div>
      <PageHeader
        title="Who Can Do What"
        subtitle="Every cell below is a rule stored in the database and checked on every single request — so removing someone's access takes effect immediately, not at their next sign-in. Hover any cell to read it as a sentence."
      />

      <Tabs
        tabs={[
          { key: 'matrix', label: 'Grant matrix' },
          { key: 'roles', label: 'Roles', count: roles.length },
          { key: 'policies', label: 'Policies', count: policies.length },
          { key: 'authority', label: 'Authority grants', count: authority.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'matrix' && matrix && (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="sticky left-0 z-20 bg-ink-900">Resource</th>
                {matrix.roles.map((r) => (
                  <th key={r} className="text-center">
                    <span className="block max-w-16 truncate" title={r}>{words(r)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.resources.map((res) => (
                <tr key={res}>
                  <td className="sticky left-0 z-10 bg-ink-900 text-2xs font-medium text-ink-200" title={res}>
                    {words(res)}
                  </td>
                  {matrix.roles.map((role) => {
                    const cell = matrix.matrix[res]?.[role];
                    return (
                      <td key={role} className="text-center">
                        {cell ? (
                          // The letters stay — this audience reads them fluently,
                          // and they are what the audit trail records — but
                          // hovering spells the cell out as a sentence, so nobody
                          // has to decode it to check that it is right.
                          <span className="mono text-ink-200" title={explainCell(res, cell)}>{cell}</span>
                        ) : (
                          <span
                            className="text-ink-700"
                            title={`This role has no access to ${res} at all — a deliberate blank, not a missing setting.`}
                          >
                            ·
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === 'roles' && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {roles.map((r) => (
            <Card
              key={r.id}
              title={r.name}
              subtitle={<span className="mono">{r.slug}</span>}
              actions={<span className="chip border-ink-700 text-ink-400">{r.archetype}</span>}
            >
              <p className="text-2xs text-ink-400">{r.description}</p>
              <dl className="mt-2">
                <Field label="Highest sensitivity they may see">
                  <SensitivityChip level={r.classificationCeiling} />
                </Field>
                <Field label="Active holders">{r.holders}</Field>
                <Field label="Grants">{r.grants.length}</Field>
              </dl>
              <details className="mt-2">
                <summary className="cursor-pointer text-2xs text-ink-500 hover:text-ink-300">Show grants</summary>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {r.grants.map((g: any) => (
                    <span key={g.id} className="chip border-ink-800 text-ink-400" title={g.scopeResolver ? `scope resolver: ${g.scopeResolver}` : undefined}>
                      {g.display}
                      {g.scopeResolver && ' ⓘ'}
                    </span>
                  ))}
                </div>
              </details>
            </Card>
          ))}
        </div>
      )}

      {tab === 'policies' && (
        <div className="space-y-3">
          {policies.map((p) => (
            <Card key={p.id} title={p.name} subtitle={<span className="mono">{p.policyCode}</span>}>
              <p className="text-2xs text-ink-400">{p.description}</p>
              {p.versions.map((v: any) => (
                <div key={v.id} className="mt-3 rounded border border-ink-800 bg-ink-950 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-2xs font-medium text-ink-200">Version {v.version}</span>
                    <span className="text-2xs text-ink-500">effective {date(v.effectiveFrom)}</span>
                  </div>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-2xs text-ink-400">
                    {JSON.stringify(v.content, null, 2)}
                  </pre>
                </div>
              ))}
              <p className="mt-2 text-2xs italic text-ink-500">
                Immutable once snapshotted, so a past decision stays re-explainable against the rule in force at
                decision time.
              </p>
            </Card>
          ))}
        </div>
      )}

      {tab === 'authority' && (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Principal</th>
                <th>Type</th>
                <th>Authority class</th>
                <th className="text-right">Value ceiling</th>
                <th className="text-right">Count ceiling</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {authority.map((g) => (
                <tr key={g.id}>
                  <td className="text-xs text-ink-100">{g.principalLabel ?? g.principalId}</td>
                  <td><span className="chip border-ink-700 text-ink-400">{g.principalType}</span></td>
                  <td className="text-2xs text-ink-300">{titleCase(g.authorityClass)}</td>
                  <td className="text-right tabular-nums text-xs">{money(g.ceilingValue, g.currency ?? 'INR')}</td>
                  <td className="text-right tabular-nums text-2xs text-ink-400">
                    {g.countCeiling ? `${g.countCeiling} / ${g.countWindow}` : '—'}
                  </td>
                  <td><StatusChip status={g.status} tone={g.status === 'active' ? 'good' : 'bad'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const TIER_TONE: Record<string, 'neutral' | 'good' | 'accent' | 'warn' | 'bad'> = {
  READ: 'neutral',
  RECOMMEND: 'accent',
  DRAFT: 'accent',
  EXECUTE_WITH_APPROVAL: 'warn',
  AUTONOMOUS_WITHIN_POLICY: 'good',
  PROHIBITED: 'bad',
};

export function Agents() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'roster' | 'actions' | 'touchpoints'>('roster');

  const { data: agents = [], isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<AgentView[]>('/admin/agents'),
  });

  const { data: actions = [] } = useQuery({
    queryKey: ['agent-actions'],
    queryFn: () => api.get<any[]>('/admin/agents/actions'),
  });

  const { data: platform } = useQuery({
    queryKey: ['platform'],
    queryFn: () => api.get<any>('/admin/platform'),
  });

  const pause = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) => api.post(`/admin/agents/${id}/pause`, { paused }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });

  const decide = useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) =>
      api.post(`/admin/agents/actions/${id}/decide`, { accept, note: 'Reviewed from the agent console.' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-actions'] }),
  });

  return (
    <div>
      <PageHeader
        title="AI Agents"
        subtitle="The AI assistants, what each is allowed to do, and how far it can go before a person must sign off. Each can only use the tools listed against it — there is no way for one to act outside that list."
      />

      <Tabs
        tabs={[
          { key: 'roster', label: 'Roster', count: agents.length },
          { key: 'actions', label: 'Actions', count: actions.length },
          { key: 'touchpoints', label: 'Touchpoint catalogue' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'roster' && (
        <>
          {isLoading ? (
            <Loading />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {agents.map((a) => (
                <Card
                  key={a.id}
                  title={a.name}
                  subtitle={<span className="mono">{a.agentKey}</span>}
                  actions={
                    <>
                      <StatusChip status={a.tier.replace(/_/g, ' ').toLowerCase()} tone={TIER_TONE[a.tier] ?? 'neutral'} />
                      <button
                        className="btn-ghost"
                        onClick={() => pause.mutate({ id: a.id, paused: a.status === 'active' })}
                      >
                        {a.status === 'active' ? 'Pause' : 'Resume'}
                      </button>
                    </>
                  }
                >
                  <p className="text-2xs leading-relaxed text-ink-400">{a.purpose}</p>

                  <div className="mt-3">
                    <p className="text-2xs uppercase tracking-wide text-ink-500">Declared tools</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {a.declaredTools.map((t) => (
                        <span key={t} className="chip border-ink-800 text-ink-400">{t}</span>
                      ))}
                    </div>
                  </div>

                  {a.authorityGrants.length > 0 && (
                    <div className="mt-3">
                      <p className="text-2xs uppercase tracking-wide text-ink-500">Authority</p>
                      {a.authorityGrants.map((g, i) => (
                        <p key={i} className="text-2xs text-ink-400">
                          {titleCase(g.authorityClass)}
                          {g.countCeiling && ` · ${g.countCeiling} per ${g.countWindow}`}
                          {g.ceilingValue && ` · ${money(g.ceilingValue, g.currency ?? 'INR')}`}
                          {g.riskClassCeiling && ` · risk ≤ ${g.riskClassCeiling}`}
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex gap-4 border-t border-ink-850 pt-2 text-2xs">
                    <span className="text-ink-400">{a.actionsLast30d} actions / 30d</span>
                    <span className={a.authorityShortfallsLast30d > 0 ? 'text-band-watch' : 'text-ink-500'}>
                      {a.authorityShortfallsLast30d} shortfalls
                    </span>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {platform?.hardProhibitions && (
            <Card className="mt-5 border-band-critical/30" title="Hard prohibitions" subtitle="Apply platform-wide, regardless of any authority grant a future policy might attempt to issue.">
              <ul className="space-y-2">
                {platform.hardProhibitions.map((p: any) => (
                  <li key={p.code}>
                    <p className="text-xs font-medium text-band-critical">{p.statement}</p>
                    <p className="mt-0.5 text-2xs text-ink-400">{p.rationale}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {tab === 'actions' && (
        <Card bodyClassName="p-0">
          {actions.length === 0 ? (
            <EmptyState message="The assistant has not done anything yet." />
          ) : (
            <ul className="divide-y divide-ink-850">
              {actions.map((a) => (
                <li key={a.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium text-ink-100">{a.agentName}</span>
                        <StatusChip status={a.tier.replace(/_/g, ' ').toLowerCase()} tone={TIER_TONE[a.tier] ?? 'neutral'} />
                        <StatusChip
                          status={a.state}
                          tone={a.state === 'executed' ? 'good' : a.state === 'blocked' ? 'bad' : 'neutral'}
                        />
                        <span className="mono">{a.tool}</span>
                      </div>
                      <p className="mt-1 text-2xs text-ink-400">{a.rationale}</p>
                      {a.blockedReason && <p className="mt-0.5 text-2xs text-band-critical">{a.blockedReason}</p>}
                      <p className="mt-0.5 text-2xs text-ink-600">
                        {a.action} on {a.subjectType} · {relative(a.proposedAt)}
                      </p>
                    </div>
                    {a.state === 'proposed' && (
                      <div className="flex shrink-0 gap-1">
                        <button className="btn-primary" onClick={() => decide.mutate({ id: a.id, accept: true })}>Accept</button>
                        <button className="btn-ghost" onClick={() => decide.mutate({ id: a.id, accept: false })}>Reject</button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'touchpoints' && platform?.aiTouchpoints && (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Surface</th>
                <th>Tier</th>
                <th>Tool</th>
                <th>Boundary</th>
              </tr>
            </thead>
            <tbody>
              {platform.aiTouchpoints.map((t: any) => (
                <tr key={t.code}>
                  <td className="mono">{t.code}</td>
                  <td>
                    <p className="text-xs text-ink-100">{t.surface}</p>
                    <p className="text-2xs text-ink-500">{t.description}</p>
                  </td>
                  <td><StatusChip status={t.tier.replace(/_/g, ' ').toLowerCase()} tone={TIER_TONE[t.tier] ?? 'neutral'} /></td>
                  <td className="mono">{t.tool}</td>
                  <td className="max-w-md text-2xs text-ink-400">{t.boundary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event fabric
// ---------------------------------------------------------------------------

export function Events() {
  const [filter, setFilter] = useState('');

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['events', filter],
    queryFn: () => api.get<EventView[]>(`/admin/events?limit=120${filter ? `&eventName=${filter}` : ''}`),
    refetchInterval: 30_000,
  });

  const { data: chain } = useQuery({
    queryKey: ['chain'],
    queryFn: () => api.get<{ valid: boolean; checked: number; brokenAt: string | null }>('/admin/events/verify-chain'),
  });

  const { data: deadLetters = [] } = useQuery({
    queryKey: ['dead-letters'],
    queryFn: () => api.get<any[]>('/admin/events/dead-letters'),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="System History"
        subtitle="Everything that has happened, in order, and tamper-evident: each entry is sealed against the one before it, so a changed or deleted record shows up. Looking at data is never recorded here — that goes to the audit trail instead."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric
          label="Chain integrity"
          value={chain?.valid ? 'Valid' : 'Broken'}
          tone={chain?.valid ? 'good' : 'bad'}
          sub={chain ? `${chain.checked} links verified${chain.brokenAt ? ` · broken at ${chain.brokenAt}` : ''}` : ''}
          drillTo="/admin/events"
        />
        <Metric label="Events shown" value={data.length} sub="Newest first" drillTo="/admin/events" />
        <Metric
          label="Dead letters"
          value={deadLetters.length}
          tone={deadLetters.length > 0 ? 'warn' : 'good'}
          sub="A handler's third failure writes here rather than only logging"
          drillTo="/admin/events"
        />
      </div>

      <div className="mb-3">
        <input
          className="input max-w-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by canonical event name, e.g. kz.crm.opportunity.won"
        />
      </div>

      {isLoading ? (
        <Loading />
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Subject</th>
                <th>Actor</th>
                <th>Recorded</th>
                <th>Confidentiality</th>
                <th title="prev_hash must match the predecessor's hash. A break is alerted on per tenant, never merely logged.">Chain</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id}>
                  <td>
                    <p className="mono text-ink-200">{e.eventName}</p>
                    {e.causationId && <p className="text-2xs text-ink-600">caused by {e.causationId.slice(0, 10)}…</p>}
                  </td>
                  <td>
                    <p className="text-2xs text-ink-300">{e.subjectType}</p>
                    {e.recordCode && <RecordCode code={e.recordCode} />}
                  </td>
                  <td className="text-2xs text-ink-400">
                    {e.actorLabel}
                    <p className="text-ink-600">{e.actorType}</p>
                  </td>
                  <td className="text-2xs text-ink-500">{dateTime(e.recordedAt)}</td>
                  <td><SensitivityChip level={e.confidentiality} /></td>
                  <td>
                    {e.chainValid ? (
                      <span className="text-band-strong" title={e.hash.slice(0, 16)}>✓</span>
                    ) : (
                      <span className="text-band-critical" title="prev_hash does not match the predecessor">✕</span>
                    )}
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

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export function Jobs() {
  const qc = useQueryClient();
  const [dryRun, setDryRun] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<any>('/admin/jobs'),
  });

  const { data: firingLog = [] } = useQuery({
    queryKey: ['firing-log'],
    queryFn: () => api.get<any[]>('/admin/jobs/firing-log?limit=40'),
  });

  const run = useMutation({
    mutationFn: (jobNames?: string[]) => api.post('/admin/jobs/run', { jobNames, dryRun }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['firing-log'] });
    },
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Automatic Checks"
        subtitle="The checks that run on their own — chasing expiring agreements, flagging untouched leads, recomputing the scores. Each one remembers exactly what it has already done, so running twice never acts twice."
        actions={
          <>
            <button className={dryRun ? 'btn-primary' : 'btn-ghost'} onClick={() => setDryRun((v) => !v)}>
              {dryRun ? 'Shadow mode on' : 'Shadow mode off'}
            </button>
            <button className="btn-primary" onClick={() => run.mutate(undefined)} disabled={run.isPending}>
              {run.isPending ? 'Running…' : 'Run all jobs'}
            </button>
          </>
        }
      />

      {isLoading ? (
        <Loading />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Registered jobs" subtitle="Each independently scheduled — the forced single hourly tick is gone." bodyClassName="p-0">
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Class</th>
                  <th>Cron</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.registered.map((j: any) => (
                  <tr key={j.name}>
                    <td>
                      <p className="text-xs text-ink-100">{j.label}</p>
                      <p className="mono">{j.name}</p>
                    </td>
                    <td className="text-2xs text-ink-400">{titleCase(j.automationClass)}</td>
                    <td className="mono">{j.cron}</td>
                    <td>
                      <button className="btn-ghost" onClick={() => run.mutate([j.name])} disabled={run.isPending}>
                        Run
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="space-y-5">
            <Card title="Recent runs" bodyClassName="p-0 max-h-80 overflow-y-auto">
              {(data?.runs ?? []).length === 0 ? (
                <EmptyState message="No runs recorded." />
              ) : (
                <ul className="divide-y divide-ink-850">
                  {data.runs.slice(0, 25).map((r: any) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-xs text-ink-100">{r.label}</p>
                        <p className="text-2xs text-ink-500">
                          {relative(r.startedAt)} · processed {r.processed} · notified {r.notified}
                          {r.dryRun && ' · shadow'}
                        </p>
                        {r.errors?.length > 0 && <p className="text-2xs text-band-critical">{r.errors[0]}</p>}
                      </div>
                      <StatusChip status={r.status} tone={r.status === 'completed' ? 'good' : r.status === 'failed' ? 'bad' : 'neutral'} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="Idempotency-key log"
              subtitle="Inspectable to answer: did this firing already happen?"
              bodyClassName="p-0 max-h-64 overflow-y-auto"
            >
              {firingLog.length === 0 ? (
                <EmptyState message="This has not run yet." />
              ) : (
                <ul className="divide-y divide-ink-850">
                  {firingLog.map((f) => (
                    <li key={f.id} className="px-4 py-2 text-2xs">
                      <p className="text-ink-300">
                        {f.triggerFingerprint} <span className="text-ink-600">rung {f.ladderRung}</span>
                      </p>
                      <p className="text-ink-600">
                        {f.subjectRef} · {relative(f.firedAt)} · {f.outcome}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function Audit() {
  const [action, setAction] = useState('');

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['audit', action],
    queryFn: () => api.get<any[]>(`/admin/audit?limit=150${action ? `&action=${action}` : ''}`),
  });

  const { data: platform } = useQuery({
    queryKey: ['platform'],
    queryFn: () => api.get<any>('/admin/platform'),
  });

  if (error) return <ErrorBox error={error} />;

  const reads = data.filter((r) => r.action === 'read').length;

  return (
    <div>
      <PageHeader
        title="Audit Trail"
        subtitle="Who changed what, and when. Nothing here can be edited or removed. Every change is recorded; so is every look at legally protected data — noting which fields were seen, never their contents."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Records shown" value={data.length} drillTo="/admin/audit" />
        <Metric
          label="Regulated reads"
          value={reads}
          sub="Only the regulated tier is read-audited, preserving the performance-driven design for the common case"
          drillTo="/admin/audit"
        />
        <Metric
          label="Governed entities"
          value={platform?.governedEntities?.length ?? 0}
          sub="A per-domain-extensible registry, not a flat CRM-only array"
          drillTo="/admin/platform"
        />
      </div>

      <div className="mb-3 flex flex-wrap gap-1">
        {['', 'create', 'update', 'merge', 'read', 'export', 'login', 'permission_change'].map((a) => (
          <button
            key={a || 'all'}
            onClick={() => setAction(a)}
            className={`btn ${action === a ? 'border-accent bg-accent text-white' : 'border-ink-700 bg-ink-850 text-ink-200'}`}
          >
            {a || 'All'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <Loading />
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Subject</th>
                <th>Actor</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td className="text-2xs text-ink-500">{dateTime(r.timestamp)}</td>
                  <td>
                    <StatusChip
                      status={r.action}
                      tone={r.action === 'merge' ? 'warn' : r.action === 'read' ? 'accent' : 'neutral'}
                    />
                  </td>
                  <td className="text-2xs text-ink-300">
                    {r.subjectType}
                    <p className="text-ink-600">{r.subjectId.slice(0, 12)}…</p>
                  </td>
                  <td className="text-2xs text-ink-400">
                    {r.actorLabel ?? r.actorType}
                    <p className="text-ink-600">{r.actorType}</p>
                  </td>
                  <td className="max-w-md">
                    {r.fieldsRead?.length > 0 ? (
                      <p className="text-2xs text-band-watch">
                        read: {r.fieldsRead.join(', ')} <span className="text-ink-600">(names only, never values)</span>
                      </p>
                    ) : (
                      <pre className="truncate text-2xs text-ink-500">{JSON.stringify(r.diff ?? r.meta ?? {})}</pre>
                    )}
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

// ---------------------------------------------------------------------------
// Platform model
// ---------------------------------------------------------------------------

export function PlatformModel() {
  const { data, isLoading } = useQuery({
    queryKey: ['platform'],
    queryFn: () => api.get<any>('/admin/platform'),
  });

  const { data: thresholds = [] } = useQuery({
    queryKey: ['thresholds'],
    queryFn: () => api.get<any[]>('/admin/thresholds'),
  });

  const { data: registrations = [] } = useQuery({
    queryKey: ['sensitivity-registrations'],
    queryFn: () => api.get<any[]>('/admin/sensitivity-registrations'),
  });

  if (isLoading || !data) return <Loading />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="How This Is Built"
        subtitle="How the system is put together, read live from the running system rather than from a document that quietly goes out of date."
      />

      <Card title="The ten planes" subtitle="Every capability is assigned to exactly one plane; nearly every requirement touches several.">
        <div className="grid gap-2 md:grid-cols-2">
          {data.planes.map((p: any) => (
            <div key={p.code} className="rounded border border-ink-800 bg-ink-950 p-3">
              <div className="flex items-baseline gap-2">
                <span className="mono text-accent-soft">{p.code}</span>
                <span className="text-xs font-medium text-ink-100">{p.name}</span>
              </div>
              <p className="mt-1 text-2xs text-ink-400">{p.question}</p>
              <p className="mt-0.5 text-2xs text-ink-600">owns: {p.owns}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Module register" subtitle="Each boundary is written as a prohibition, not just a diagram.">
        <div className="space-y-3">
          {data.moduleRegister.map((m: any) => (
            <div key={m.code} className="rounded border border-ink-800 bg-ink-950 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono text-accent-soft">{m.code}</span>
                <span className="text-xs font-medium text-ink-100">{m.name}</span>
                <span className="chip border-ink-700 text-ink-400">{m.boundedContext}</span>
                <span className="chip border-ink-700 text-ink-400">{m.plane}</span>
              </div>
              <p className="mt-1.5 text-2xs text-ink-400">Owns: {m.owns.join(', ')}</p>
              <div className="mt-2">
                <p className="text-2xs uppercase tracking-wide text-band-critical">Never does</p>
                <ul className="mt-0.5 space-y-0.5">
                  {m.neverDoes.map((n: string, i: number) => (
                    <li key={i} className="text-2xs text-ink-400">· {n}</li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Event crosswalk" subtitle="Every legacy name mapped one-to-one to its canonical form." bodyClassName="p-0 max-h-96 overflow-y-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Legacy</th>
                <th>Canonical</th>
              </tr>
            </thead>
            <tbody>
              {data.eventCrosswalk.map((c: any) => (
                <tr key={c.legacy}>
                  <td className="mono">{c.legacy}</td>
                  <td className="mono text-accent-soft">{c.canonical}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="space-y-5">
          <Card title="Thresholds" subtitle="Every constant the corpus flags as unvalidated ships as a tunable row from day one." bodyClassName="p-0 max-h-64 overflow-y-auto">
            <ul className="divide-y divide-ink-850">
              {thresholds.map((t) => (
                <li key={t.id} className="px-4 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="mono">{t.thresholdKey}</span>
                    <span className="text-xs tabular-nums text-ink-100">
                      {t.value.toLocaleString('en-IN')} <span className="text-2xs text-ink-500">{t.unit}</span>
                    </span>
                  </div>
                  <p className="mt-0.5 text-2xs text-ink-500">{t.description}</p>
                </li>
              ))}
            </ul>
          </Card>

          <Card
            title="Sensitivity registrations"
            subtitle="An entity type with no registration defaults to confidential, not internal — defaulting to internal means every new column ships readable."
            bodyClassName="p-0 max-h-64 overflow-y-auto"
          >
            <table className="table">
              <thead>
                <tr>
                  <th>Context</th>
                  <th>Entity type</th>
                  <th>Class</th>
                </tr>
              </thead>
              <tbody>
                {registrations.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.contextCode}</td>
                    <td className="text-2xs text-ink-300">{r.entityType}</td>
                    <td><SensitivityChip level={r.sensitivityClass} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </div>

      <Card title="The five axes" subtitle="All five must evaluate true. Evaluated at query time, never cached at login.">
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
          {data.axes.map((a: any) => (
            <div key={a.code} className="rounded border border-ink-800 bg-ink-950 p-3">
              <p className="mono text-accent-soft">{a.code}</p>
              <p className="mt-1 text-2xs text-ink-400">{a.question}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-2xs text-ink-500">
          Tenant scoping is not one of the five. It is the gate a request clears before any axis is evaluated, and it
          fails with a 404 rather than a 403 — a deliberately weaker information leak than confirming a record exists
          in another tenant.
        </p>
      </Card>
    </div>
  );
}
