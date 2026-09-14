/**
 * Technology — service desk (docs/plan/cio.md, workstream D).
 *
 * `ExceptionRecord` is what the system raises against itself; a ticket here
 * is what a person raises. Priority and status are shown as chips rather
 * than prose (the codes stay legible for whoever files a ticket, and the
 * tooltip on hover carries the plain word); the SLA policy table the desk is
 * held to is seeded as a starting point, not a target the company has
 * committed to, and the screen says so.
 */

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
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
import { CreateModal, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';

// ---------------------------------------------------------------------------
// Types (mirrors apps/api/src/domains/it/servicedesk.ts)
// ---------------------------------------------------------------------------

type Category = 'incident' | 'request' | 'access' | 'question';
type Priority = 'P1' | 'P2' | 'P3' | 'P4';
type Status = 'new' | 'triaged' | 'in_progress' | 'waiting' | 'resolved' | 'closed';
type TicketEvent = 'START' | 'WAIT' | 'RESUME' | 'RESOLVE' | 'CLOSE' | 'REOPEN';
type Tab = 'mine' | 'unassigned' | 'open' | 'breached' | 'all';
type KnowledgeStatus = 'draft' | 'published' | 'retired';

interface Ticket {
  id: string;
  recordCode: string | null;
  requesterPartyId: string;
  assigneePartyId: string | null;
  requesterName?: string;
  assigneeName?: string | null;
  category: Category;
  priority: Priority | null;
  status: Status;
  subject: string;
  description: string;
  assetId: string | null;
  applicationId: string | null;
  respondDueAt: string | null;
  resolveDueAt: string | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  satisfaction: number | null;
  slaBreachNotified: string[];
  waitingSince: string | null;
  createdAt: string;
  availableTransitions: TicketEvent[];
}

interface TicketDetail extends Ticket {
  comments: Comment[];
  canRate: boolean;
}

interface Comment {
  id: string;
  body: string;
  internal: boolean;
  authorPartyId: string;
  authorName?: string;
  createdAt: string;
}

interface KnowledgeArticle {
  id: string;
  recordCode: string | null;
  title: string;
  body: string;
  applicationId: string | null;
  status: KnowledgeStatus;
  helpfulCount: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Summary {
  notYetMeasured: boolean;
  openByPriority: Record<Priority | 'none', number>;
  unassigned: number;
  breached: number;
  slaAttainment: { response: number | null; resolution: number | null };
  medianResolveMinutes: number | null;
  backlogAge: { d0_1: number; d2_7: number; d8_30: number; d30plus: number };
  satisfactionAverage: number | null;
  knowledgePublished: number;
}

interface MyItResponse {
  tickets: Ticket[];
  policiesAwaiting: unknown[];
  assets: unknown[];
  note: string;
}

interface Employee {
  id: string;
  personId: string;
  fullName: string;
  jobTitle: string | null;
}

const CATEGORY_LABEL: Record<Category, string> = { incident: 'Incident', request: 'Request', access: 'Access', question: 'Question' };
const PRIORITY_TONE: Record<Priority, 'bad' | 'warn' | 'accent' | 'neutral'> = { P1: 'bad', P2: 'warn', P3: 'accent', P4: 'neutral' };
const STATUS_TONE: Record<Status, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  new: 'neutral',
  triaged: 'accent',
  in_progress: 'accent',
  waiting: 'warn',
  resolved: 'good',
  closed: 'neutral',
};
const EVENT_LABEL: Record<TicketEvent, string> = {
  START: 'Start work',
  WAIT: 'Mark waiting',
  RESUME: 'Resume',
  RESOLVE: 'Resolve',
  CLOSE: 'Close',
  REOPEN: 'Reopen',
};

function PriorityChip({ priority }: { priority: Priority | null }) {
  if (!priority) return <span className="chip border-ink-700 bg-ink-850 text-ink-500">Untriaged</span>;
  return <StatusChip status={priority} tone={PRIORITY_TONE[priority]} />;
}

/** True on a 404 — the endpoint genuinely does not exist yet, belonging to a
 * workstream not built. Distinct from any other failure, which still shows
 * as an error. */
function isNotFound(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404;
}

// ---------------------------------------------------------------------------
// Tickets — list
// ---------------------------------------------------------------------------

export function ItTickets() {
  const navigate = useNavigate();
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('open');
  const [newOpen, setNewOpen] = useState(false);

  const summary = useQuery({ queryKey: ['it-tickets-summary'], queryFn: () => api.get<Summary>('/it/tickets/summary') });
  const tickets = useQuery({
    queryKey: ['it-tickets', tab],
    queryFn: () => api.get<Ticket[]>(`/it/tickets?tab=${tab}`),
  });

  const s = summary.data;
  const openTotal = s ? s.openByPriority.P1 + s.openByPriority.P2 + s.openByPriority.P3 + s.openByPriority.P4 + s.openByPriority.none : undefined;

  if (tickets.error) return <ErrorBox error={tickets.error} />;

  return (
    <div>
      <PageHeader
        title="Service Desk"
        subtitle="Tickets a person raised — incidents, requests, access and questions. SLA clocks are stamped at triage from the policy table in force that day, a starting point the company has not yet committed to as a target."
        actions={can('it_tickets:C') && <button className="btn-primary" onClick={() => setNewOpen(true)}>+ New ticket</button>}
      />

      {s?.notYetMeasured ? (
        <Card>
          <EmptyState message="No tickets have been raised yet." hint="SLA attainment, backlog age and satisfaction all read from tickets that exist — there is nothing to measure until one is raised." />
        </Card>
      ) : (
        s && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Open" value={openTotal} drillTo="/it/tickets" />
            <Metric label="Unassigned" value={s.unassigned} tone={s.unassigned > 0 ? 'warn' : 'good'} drillTo="/it/tickets" />
            <Metric label="Breached" value={s.breached} tone={s.breached > 0 ? 'bad' : 'good'} drillTo="/it/tickets" />
            <Metric
              label="Response SLA"
              value={s.slaAttainment.response === null ? 'Not yet measured' : `${s.slaAttainment.response}%`}
              noActionReason="This month's closed tickets."
            />
            <Metric
              label="Resolution SLA"
              value={s.slaAttainment.resolution === null ? 'Not yet measured' : `${s.slaAttainment.resolution}%`}
              noActionReason="This month's closed tickets."
            />
            <Metric
              label="Median resolve"
              value={s.medianResolveMinutes === null ? 'Not yet measured' : `${Math.round(s.medianResolveMinutes / 60)}h`}
              noActionReason="Tickets resolved in the last 30 days."
            />
          </div>
        )
      )}

      <Tabs
        tabs={[
          { key: 'mine', label: 'Mine' },
          { key: 'unassigned', label: 'Unassigned' },
          { key: 'open', label: 'Open' },
          { key: 'breached', label: 'Breached' },
          { key: 'all', label: 'All' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <Card>
        {tickets.isLoading ? (
          <Loading label="Loading tickets" />
        ) : (tickets.data ?? []).length === 0 ? (
          <EmptyState message="Nothing in this view." hint="Try another tab, or raise a ticket." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="py-2 pr-3">Priority</th>
                  <th className="py-2 pr-3">Ticket</th>
                  <th className="py-2 pr-3">Requester</th>
                  <th className="py-2 pr-3">Assignee</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Raised</th>
                </tr>
              </thead>
              <tbody>
                {(tickets.data ?? []).map((t) => (
                  <tr
                    key={t.id}
                    className="cursor-pointer border-b border-ink-850/60 hover:bg-ink-900/60"
                    onClick={() => navigate(`/it/tickets/${t.id}`)}
                  >
                    <td className="py-2 pr-3"><PriorityChip priority={t.priority} /></td>
                    <td className="py-2 pr-3">
                      <div className="text-ink-100">{t.subject}</div>
                      <div className="text-2xs text-ink-500">
                        <RecordCode code={t.recordCode} /> · {CATEGORY_LABEL[t.category]}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-ink-300">{t.requesterName ?? t.requesterPartyId}</td>
                    <td className="py-2 pr-3 text-ink-300">{t.assigneeName ?? '—'}</td>
                    <td className="py-2 pr-3"><StatusChip status={t.status} tone={STATUS_TONE[t.status]} /></td>
                    <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-ink-400">{dateTime(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <NewTicketModal open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

function NewTicketModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [category, setCategory] = useState<Category | ''>('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');

  return (
    <CreateModal
      open={open}
      title="Raise a ticket"
      submitLabel="Raise it"
      onClose={onClose}
      invalidate={[['it-tickets'], ['it-tickets-summary'], ['it-my']]}
      onSubmit={() => api.post('/it/tickets', { category, subject, description })}
    >
      <SelectInput
        label="Category"
        required
        value={category}
        onChange={(v) => setCategory(v)}
        placeholder="Choose one"
        options={Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value: value as Category, label }))}
      />
      <TextInput label="Subject" value={subject} onChange={setSubject} required placeholder="One line — what is wrong or needed" />
      <TextArea label="Description" value={description} onChange={setDescription} rows={4} required placeholder="What happened, what you expected, and anything the desk should know." />
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// Ticket detail
// ---------------------------------------------------------------------------

export function ItTicketDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { can } = useSession();
  const [triageOpen, setTriageOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [commentInternal, setCommentInternal] = useState(false);
  const [rating, setRating] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const ticket = useQuery({
    queryKey: ['it-ticket', id],
    queryFn: () => api.get<TicketDetail>(`/it/tickets/${id}`),
    enabled: Boolean(id),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['it-ticket', id] });
    qc.invalidateQueries({ queryKey: ['it-tickets'] });
    qc.invalidateQueries({ queryKey: ['it-tickets-summary'] });
  };

  const transitionMut = useMutation({
    mutationFn: (event: TicketEvent) => api.post(`/it/tickets/${id}/transition`, { event }),
    onSuccess: invalidate,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  const commentMut = useMutation({
    mutationFn: () => api.post(`/it/tickets/${id}/comments`, { body: commentBody, internal: commentInternal }),
    onSuccess: () => {
      setCommentBody('');
      setCommentInternal(false);
      invalidate();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  const rateMut = useMutation({
    mutationFn: (satisfaction: number) => api.post(`/it/tickets/${id}/rate`, { satisfaction }),
    onSuccess: invalidate,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  if (ticket.isLoading) return <Loading label="Loading ticket" />;
  if (ticket.error) return <ErrorBox error={ticket.error} />;
  const t = ticket.data;
  if (!t) return null;

  const canManage = can('it_tickets:E');
  const nonTriageTransitions = t.availableTransitions;

  return (
    <div>
      <PageHeader
        title={t.subject}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <RecordCode code={t.recordCode} /> <PriorityChip priority={t.priority} /> <StatusChip status={t.status} tone={STATUS_TONE[t.status]} /> {CATEGORY_LABEL[t.category]}
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {canManage && t.status === 'new' && (
              <button className="btn" onClick={() => setTriageOpen(true)}>Triage</button>
            )}
            {canManage && (
              <button className="btn" onClick={() => setAssignOpen(true)}>{t.assigneeName ? 'Reassign' : 'Assign'}</button>
            )}
            {canManage &&
              nonTriageTransitions.map((event) => (
                <button key={event} className="btn" disabled={transitionMut.isPending} onClick={() => transitionMut.mutate(event)}>
                  {EVENT_LABEL[event]}
                </button>
              ))}
          </div>
        }
      />

      {error && <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="Description">
            <p className="whitespace-pre-wrap text-sm text-ink-200">{t.description}</p>
          </Card>

          <Card title="Timeline" className="mt-4">
            <div className="flex flex-col gap-3">
              {t.comments.length === 0 ? (
                <EmptyState message="No comments yet." />
              ) : (
                t.comments.map((c) => (
                  <div key={c.id} className={`rounded border px-3 py-2 text-sm ${c.internal ? 'border-band-watch/30 bg-band-watch/5' : 'border-ink-800 bg-ink-900'}`}>
                    <div className="mb-1 flex items-center justify-between text-2xs text-ink-500">
                      <span>{c.authorName ?? c.authorPartyId}{c.internal && <span className="ml-1.5 text-band-watch">· internal</span>}</span>
                      <span>{dateTime(c.createdAt)}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-ink-200">{c.body}</p>
                  </div>
                ))
              )}
            </div>

            <form
              className="mt-4 flex flex-col gap-2 border-t border-ink-800 pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                commentMut.mutate();
              }}
            >
              <TextArea label="Add a comment" value={commentBody} onChange={setCommentBody} rows={2} required />
              <div className="flex items-center justify-between">
                {canManage ? (
                  <label className="flex items-center gap-1.5 text-2xs text-ink-400">
                    <input type="checkbox" checked={commentInternal} onChange={(e) => setCommentInternal(e.target.checked)} />
                    Internal note (hidden from the requester)
                  </label>
                ) : (
                  <span />
                )}
                <button type="submit" className="btn-primary" disabled={commentMut.isPending || !commentBody.trim()}>
                  {commentMut.isPending ? 'Posting…' : 'Post'}
                </button>
              </div>
            </form>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card title="Details">
            <dl>
              <Field label="Requester">{t.requesterName ?? t.requesterPartyId}</Field>
              <Field label="Assignee">{t.assigneeName ?? 'Unassigned'}</Field>
              <Field label="Respond by">{t.respondDueAt ? dateTime(t.respondDueAt) : 'Set at triage'}</Field>
              <Field label="Resolve by">{t.resolveDueAt ? dateTime(t.resolveDueAt) : 'Set at triage'}</Field>
              <Field label="First response">{t.firstRespondedAt ? dateTime(t.firstRespondedAt) : '—'}</Field>
              <Field label="Resolved">{t.resolvedAt ? dateTime(t.resolvedAt) : '—'}</Field>
              {t.slaBreachNotified.length > 0 && (
                <Field label="SLA">
                  <span className="text-band-critical">Breached: {t.slaBreachNotified.join(', ')}</span>
                </Field>
              )}
            </dl>
          </Card>

          {t.canRate && (
            <Card title="Rate this ticket">
              <p className="mb-2 text-2xs text-ink-500">How well was this resolved? Set once — this cannot be changed afterwards.</p>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    className={`h-8 w-8 rounded border text-sm ${rating >= n ? 'border-accent bg-accent/20 text-accent-soft' : 'border-ink-700 text-ink-400'}`}
                    onClick={() => setRating(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <button className="btn-primary mt-3" disabled={rating === 0 || rateMut.isPending} onClick={() => rateMut.mutate(rating)}>
                {rateMut.isPending ? 'Saving…' : 'Submit rating'}
              </button>
            </Card>
          )}

          {t.satisfaction !== null && (
            <Card title="Satisfaction">
              <p className="text-2xl font-semibold text-ink-100">{t.satisfaction} / 5</p>
            </Card>
          )}
        </div>
      </div>

      {triageOpen && <TriageModal ticket={t} onClose={() => setTriageOpen(false)} onDone={invalidate} />}
      {assignOpen && <AssignModal ticket={t} onClose={() => setAssignOpen(false)} onDone={invalidate} />}
    </div>
  );
}

function TriageModal({ ticket, onClose, onDone }: { ticket: TicketDetail; onClose: () => void; onDone: () => void }) {
  const [priority, setPriority] = useState<Priority | ''>('');
  const [category, setCategory] = useState<Category>(ticket.category);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/it/tickets/${ticket.id}/triage`, { priority, category }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="Triage"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" form="triage-form" type="submit" disabled={!priority || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Triage'}
          </button>
        </>
      }
    >
      <form
        id="triage-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <SelectInput
          label="Priority"
          required
          value={priority}
          onChange={(v) => setPriority(v)}
          placeholder="Choose a priority"
          options={(['P1', 'P2', 'P3', 'P4'] as Priority[]).map((p) => ({ value: p, label: p }))}
          hint="Stamps the SLA clocks from the policy in force today, against this ticket's own raised date."
        />
        <SelectInput
          label="Category"
          required
          value={category}
          onChange={(v) => setCategory(v)}
          options={Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value: value as Category, label }))}
        />
      </form>
    </Modal>
  );
}

/**
 * Assignee search — the person-picker pattern copied inline from
 * `createForms.tsx`'s `NewEnrollment` (a `SelectInput` fed by a list query),
 * per the brief: that file is not to be edited, only its pattern reused.
 */
function AssignModal({ ticket, onClose, onDone }: { ticket: TicketDetail; onClose: () => void; onDone: () => void }) {
  const [assigneePartyId, setAssigneePartyId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const employees = useQuery({
    queryKey: ['it-assign-employees'],
    queryFn: () => api.get<Employee[] | { items: Employee[] }>('/hr/employees'),
  });
  const rows = Array.isArray(employees.data) ? employees.data : employees.data?.items ?? [];

  const mutation = useMutation({
    mutationFn: () => api.post(`/it/tickets/${ticket.id}/assign`, { assigneePartyId }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title="Assign"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" form="assign-form" type="submit" disabled={!assigneePartyId || mutation.isPending}>
            {mutation.isPending ? 'Assigning…' : 'Assign'}
          </button>
        </>
      }
    >
      <form
        id="assign-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <SelectInput
          label="Assign to"
          required
          value={assigneePartyId}
          onChange={setAssigneePartyId}
          placeholder={rows.length ? 'Search employees' : 'No employees on file'}
          options={rows.map((e) => ({ value: e.personId, label: e.jobTitle ? `${e.fullName} — ${e.jobTitle}` : e.fullName }))}
        />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export function ItKnowledge() {
  const { can } = useSession();
  const navigate = useNavigate();
  const [newOpen, setNewOpen] = useState(false);

  const articles = useQuery({ queryKey: ['it-knowledge'], queryFn: () => api.get<KnowledgeArticle[]>('/it/knowledge') });

  if (articles.error) return <ErrorBox error={articles.error} />;

  return (
    <div>
      <PageHeader
        title="Knowledge base"
        subtitle="Articles the desk points a requester to instead of a ticket. Helpful counts are a plain counter — one click each, not one vote per person."
        actions={can('it_knowledge:C') && <button className="btn-primary" onClick={() => setNewOpen(true)}>+ New article</button>}
      />
      <Card>
        {articles.isLoading ? (
          <Loading label="Loading articles" />
        ) : (articles.data ?? []).length === 0 ? (
          <EmptyState message="Nothing published yet." hint="Articles the desk has not published are only visible to desk staff." />
        ) : (
          <div className="flex flex-col divide-y divide-ink-850">
            {(articles.data ?? []).map((a) => (
              <button
                key={a.id}
                className="flex items-center justify-between gap-3 py-3 text-left hover:bg-ink-900/50"
                onClick={() => navigate(`/it/knowledge/${a.id}`)}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-ink-100">{a.title}</div>
                  <div className="text-2xs text-ink-500"><RecordCode code={a.recordCode} /></div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusChip status={a.status} tone={a.status === 'published' ? 'good' : a.status === 'retired' ? 'neutral' : 'warn'} />
                  <span className="text-2xs text-ink-500">{a.helpfulCount} helpful</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>
      <NewArticleModal open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

function NewArticleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  return (
    <CreateModal
      open={open}
      title="New article"
      submitLabel="Save as draft"
      onClose={onClose}
      invalidate={[['it-knowledge']]}
      onSubmit={() => api.post('/it/knowledge', { title, body })}
    >
      <TextInput label="Title" value={title} onChange={setTitle} required />
      <TextArea label="Body" value={body} onChange={setBody} rows={6} required hint="Saved as a draft — publish it from the article once it is ready." />
    </CreateModal>
  );
}

export function ItKnowledgeDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { can } = useSession();
  const [error, setError] = useState<string | null>(null);

  const article = useQuery({
    queryKey: ['it-knowledge-article', id],
    queryFn: () => api.get<KnowledgeArticle>(`/it/knowledge/${id}`),
    enabled: Boolean(id),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['it-knowledge-article', id] });
    qc.invalidateQueries({ queryKey: ['it-knowledge'] });
  };

  const publishMut = useMutation({
    mutationFn: () => api.post(`/it/knowledge/${id}/publish`),
    onSuccess: invalidate,
    onError: (e: unknown) => setError(messageOf(e)),
  });
  const helpfulMut = useMutation({
    mutationFn: () => api.post(`/it/knowledge/${id}/helpful`),
    onSuccess: invalidate,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  if (article.isLoading) return <Loading label="Loading article" />;
  if (article.error) return <ErrorBox error={article.error} />;
  const a = article.data;
  if (!a) return null;

  return (
    <div>
      <PageHeader
        title={a.title}
        subtitle={
          <span className="flex items-center gap-2">
            <RecordCode code={a.recordCode} /> <StatusChip status={a.status} tone={a.status === 'published' ? 'good' : a.status === 'retired' ? 'neutral' : 'warn'} />
          </span>
        }
        actions={
          <div className="flex gap-2">
            {can('it_knowledge:E') && a.status === 'draft' && (
              <button className="btn-primary" disabled={publishMut.isPending} onClick={() => publishMut.mutate()}>
                {publishMut.isPending ? 'Publishing…' : 'Publish'}
              </button>
            )}
            {a.status === 'published' && (
              <button className="btn" disabled={helpfulMut.isPending} onClick={() => helpfulMut.mutate()}>
                👍 Helpful ({a.helpfulCount})
              </button>
            )}
          </div>
        }
      />
      {error && <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
      <Card>
        <p className="whitespace-pre-wrap text-sm text-ink-200">{a.body}</p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My IT
// ---------------------------------------------------------------------------

export function MyIt() {
  const { can } = useSession();
  const navigate = useNavigate();
  const [newOpen, setNewOpen] = useState(false);

  const mine = useQuery({ queryKey: ['it-my'], queryFn: () => api.get<MyItResponse>('/it/my') });
  const assets = useQuery({
    queryKey: ['it-assets-mine'],
    queryFn: () => api.get<unknown[] | { items: unknown[] }>('/it/assets/mine'),
    retry: false,
  });
  const policies = useQuery({
    queryKey: ['it-policies-awaiting'],
    queryFn: () => api.get<unknown[] | { items: unknown[] }>('/it/policies/awaiting'),
    retry: false,
  });

  if (mine.error) return <ErrorBox error={mine.error} />;
  const m = mine.data;

  const assetRows = Array.isArray(assets.data) ? assets.data : assets.data?.items ?? [];
  const policyRows = Array.isArray(policies.data) ? policies.data : policies.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="My IT"
        subtitle="Your tickets, your assigned equipment, and any policy waiting on your acknowledgement — in one place."
        actions={can('it_tickets:C') && <button className="btn-primary" onClick={() => setNewOpen(true)}>+ Raise a ticket</button>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="My tickets" className="lg:col-span-2">
          {mine.isLoading ? (
            <Loading label="Loading" />
          ) : (m?.tickets.length ?? 0) === 0 ? (
            <EmptyState message="You have not raised a ticket." hint="Raise one when something is broken or you need access to something." />
          ) : (
            <div className="flex flex-col divide-y divide-ink-850">
              {(m?.tickets ?? []).map((t) => (
                <button
                  key={t.id}
                  className="flex items-center justify-between gap-3 py-2.5 text-left hover:bg-ink-900/50"
                  onClick={() => navigate(`/it/tickets/${t.id}`)}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-ink-100">{t.subject}</div>
                    <div className="text-2xs text-ink-500"><RecordCode code={t.recordCode} /></div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <PriorityChip priority={t.priority} />
                    <StatusChip status={t.status} tone={STATUS_TONE[t.status]} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="My assets">
            {assets.isLoading ? (
              <Loading label="Loading" />
            ) : isNotFound(assets.error) || assetRows.length === 0 ? (
              <EmptyState message="Nothing here yet." hint={isNotFound(assets.error) ? 'The assets workstream has not landed yet.' : 'No equipment is currently assigned to you.'} />
            ) : (
              <pre className="overflow-x-auto text-2xs text-ink-300">{JSON.stringify(assetRows, null, 2)}</pre>
            )}
          </Card>

          <Card title="Policies to acknowledge">
            {policies.isLoading ? (
              <Loading label="Loading" />
            ) : isNotFound(policies.error) || policyRows.length === 0 ? (
              <EmptyState message="Nothing here yet." hint={isNotFound(policies.error) ? 'The governance workstream has not landed yet.' : 'Nothing is currently awaiting your acknowledgement.'} />
            ) : (
              <pre className="overflow-x-auto text-2xs text-ink-300">{JSON.stringify(policyRows, null, 2)}</pre>
            )}
          </Card>
        </div>
      </div>

      <NewTicketModal open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}
