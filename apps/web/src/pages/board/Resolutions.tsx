/**
 * Board and shareholder resolutions — passed at a meeting or by circulation,
 * with the s.179(3) meeting-only bar and the interested-director abstention.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type {
  BoardMeetingView, BoardMemberView, ResolutionKind, ResolutionSubject, ResolutionView,
} from '@kaizen/shared';
import {
  RESOLUTION_KIND_LABELS, RESOLUTION_OUTCOME_LABELS, RESOLUTION_SUBJECTS_REQUIRING_MEETING,
  RESOLUTION_SUBJECT_LABELS, VOTE_CHOICE_LABELS,
} from '@kaizen/shared';
import { api, date, dateTime } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, RecordCode, StatusChip } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';

const OUTCOME_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  draft: 'neutral',
  open: 'accent',
  passed: 'good',
  failed: 'bad',
  withdrawn: 'neutral',
  meeting_demanded: 'warn',
};

export function Resolutions() {
  const { can } = useSession();
  const [proposing, setProposing] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['board', 'resolutions'],
    queryFn: () => api.get<{ items: ResolutionView[] }>('/board/resolutions'),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <ProposeResolution open={proposing} onClose={() => setProposing(false)} />
      <PageHeader
        title="Resolutions"
        subtitle="Board and shareholder resolutions, passed at a meeting or by circulation."
        actions={can('resolutions:E') ? <NewButton label="Propose a resolution" onClick={() => setProposing(true)} /> : undefined}
      />

      {isLoading ? (
        <Loading />
      ) : data!.items.length === 0 ? (
        <Card><EmptyState message="No resolution has been proposed yet." /></Card>
      ) : (
        <div className="space-y-2">
          {data!.items.map((r) => (
            <Link key={r.id} to={`/equity/resolutions/${r.id}`} className="block rounded-md border border-ink-800 bg-ink-900 p-3 hover:border-ink-700">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mono">{r.recordCode}</span>
                    <StatusChip status={RESOLUTION_OUTCOME_LABELS[r.outcome]} tone={OUTCOME_TONE[r.outcome] ?? 'neutral'} />
                    <span className="chip border-ink-700 text-ink-400">{RESOLUTION_KIND_LABELS[r.kind]}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-ink-100">{r.title}</p>
                  <p className="mt-0.5 text-2xs text-ink-500">{RESOLUTION_SUBJECT_LABELS[r.subject]}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ProposeResolution({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<ResolutionKind>('board');
  const [subject, setSubject] = useState<ResolutionSubject | ''>('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [passedBy, setPassedBy] = useState<'meeting' | 'circulation'>('circulation');
  const [meetingId, setMeetingId] = useState('');
  const [subjectRef, setSubjectRef] = useState('');

  const meetings = useQuery({
    queryKey: ['board', 'meetings'],
    queryFn: () => api.get<{ items: BoardMeetingView[] }>('/board/meetings'),
    enabled: open,
  });

  const requiresMeeting = subject !== '' && (RESOLUTION_SUBJECTS_REQUIRING_MEETING as ResolutionSubject[]).includes(subject);

  return (
    <CreateModal
      open={open}
      title="Propose a resolution"
      submitLabel="Propose"
      onClose={onClose}
      invalidate={[['board', 'resolutions']]}
      onSubmit={() =>
        api.post('/board/resolutions', {
          kind,
          subject,
          title,
          text,
          passedBy: requiresMeeting ? 'meeting' : passedBy,
          meetingId: (requiresMeeting || passedBy === 'meeting') ? (meetingId || undefined) : undefined,
          subjectRef: subjectRef || undefined,
        })
      }
    >
      <Row>
        <SelectInput
          label="Kind"
          required
          value={kind}
          onChange={(v) => setKind(v as ResolutionKind)}
          options={Object.entries(RESOLUTION_KIND_LABELS).map(([value, label]) => ({ value: value as ResolutionKind, label }))}
        />
        <SelectInput
          label="Subject"
          required
          value={subject}
          onChange={(v) => setSubject(v as ResolutionSubject)}
          placeholder="Select…"
          options={Object.entries(RESOLUTION_SUBJECT_LABELS).map(([value, label]) => ({ value: value as ResolutionSubject, label }))}
        />
      </Row>
      <TextInput label="Title" required value={title} onChange={setTitle} />
      <TextArea label="Resolved text" required rows={3} value={text} onChange={setText} />
      <TextInput label="Subject reference" value={subjectRef} onChange={setSubjectRef} hint="what this acts on, e.g. an allotment or transfer" />

      {requiresMeeting ? (
        <p className="rounded border-l-2 border-band-watch bg-band-watch/10 px-3 py-2 text-2xs text-band-watch">
          This must be passed at a meeting, not by circulation (s.179(3)).
        </p>
      ) : (
        <SelectInput
          label="Passed by"
          required
          value={passedBy}
          onChange={(v) => setPassedBy(v as 'meeting' | 'circulation')}
          options={[{ value: 'circulation', label: 'Circulation' }, { value: 'meeting', label: 'Meeting' }]}
        />
      )}

      {(requiresMeeting || passedBy === 'meeting') && (
        <SelectInput
          label="Meeting"
          value={meetingId}
          onChange={setMeetingId}
          placeholder="Select a meeting…"
          options={(meetings.data?.items ?? []).map((m) => ({ value: m.id, label: `${m.recordCode} — ${m.title}` }))}
        />
      )}
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------

export function ResolutionDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const { can } = useSession();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data: r, isLoading, error: fetchError } = useQuery({
    queryKey: ['board', 'resolution', id],
    queryFn: () => api.get<ResolutionView>(`/board/resolutions/${id}`),
  });
  const members = useQuery({
    queryKey: ['board', 'members'],
    queryFn: () => api.get<{ items: BoardMemberView[] }>('/board/members'),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['board', 'resolution', id] });
    qc.invalidateQueries({ queryKey: ['board', 'resolutions'] });
  };

  const action = useMutation({
    mutationFn: (call: () => Promise<unknown>) => call(),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  if (fetchError) return <ErrorBox error={fetchError} />;
  if (isLoading || members.isLoading) return <Loading />;
  const resolution = r!;
  const nameById = new Map(members.data!.items.map((m) => [m.id, m.personName] as const));
  const canEdit = can('resolutions:E');
  const canVote = can('resolutions:approve');

  return (
    <div>
      <PageHeader
        title={resolution.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-1.5">
            <RecordCode code={resolution.recordCode} />
            <StatusChip status={RESOLUTION_OUTCOME_LABELS[resolution.outcome]} tone={OUTCOME_TONE[resolution.outcome] ?? 'neutral'} />
            <span>{RESOLUTION_SUBJECT_LABELS[resolution.subject]}</span>
          </span>
        }
      />

      {error && <div className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</div>}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Resolved">
            <p className="whitespace-pre-wrap text-sm text-ink-200">{resolution.text}</p>
          </Card>

          <Card title="Votes">
            {resolution.votes.length === 0 ? (
              <EmptyState message="No vote recorded yet." />
            ) : (
              <ul className="space-y-1.5">
                {resolution.votes.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-2 text-sm text-ink-200">
                    <span>{v.boardMemberId ? nameById.get(v.boardMemberId) ?? 'Unknown' : 'Shareholder'}</span>
                    <span className="flex items-center gap-1.5">
                      {v.abstainedAsInterested && <span className="chip border-ink-700 text-ink-400">interested</span>}
                      {v.demandsMeeting && <span className="chip border-band-watch/40 text-band-watch">demands meeting</span>}
                      <StatusChip status={VOTE_CHOICE_LABELS[v.choice]} />
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {canVote && resolution.outcome === 'open' && (
              <VoteForm resolutionId={resolution.id} members={members.data!.items} onCast={invalidate} />
            )}
          </Card>

          {canEdit && resolution.outcome === 'passed' && resolution.kind === 'shareholder_special' && (
            <Card title="MGT-14">
              {resolution.mgt14FiledOn ? (
                <p className="text-sm text-ink-200">Filed {date(resolution.mgt14FiledOn)} · SRN {resolution.mgt14Srn}</p>
              ) : (
                <Mgt14Form resolutionId={resolution.id} onFiled={invalidate} />
              )}
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card title="Status">
            <dl>
              <div className="py-1 text-2xs text-ink-500">Passed by</div>
              <div className="text-sm text-ink-200">{resolution.passedBy ?? '—'}</div>
              <div className="mt-2 py-1 text-2xs text-ink-500">Circulated</div>
              <div className="text-sm text-ink-200">{resolution.circulatedOn ? dateTime(resolution.circulatedOn) : '—'}</div>
              {resolution.votingClosesOn && (
                <>
                  <div className="mt-2 py-1 text-2xs text-ink-500">Voting closes</div>
                  <div className="text-sm text-ink-200">{date(resolution.votingClosesOn)}</div>
                </>
              )}
            </dl>
            {canEdit && (
              <div className="mt-3 flex flex-wrap gap-2">
                {resolution.outcome === 'draft' && resolution.passedBy === 'circulation' && (
                  <CirculateForm resolutionId={resolution.id} onOpened={invalidate} />
                )}
                {resolution.outcome === 'open' && resolution.passedBy === 'circulation' && (
                  <button className="btn-primary" onClick={() => action.mutate(() => api.post(`/board/resolutions/${resolution.id}/close`, {}))}>
                    Close circulation
                  </button>
                )}
                {['draft', 'open'].includes(resolution.outcome) && (
                  <button className="btn" onClick={() => action.mutate(() => api.post(`/board/resolutions/${resolution.id}/withdraw`, {}))}>
                    Withdraw
                  </button>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function VoteForm({ resolutionId, members, onCast }: { resolutionId: string; members: BoardMemberView[]; onCast: () => void }) {
  const [boardMemberId, setBoardMemberId] = useState('');
  const [choice, setChoice] = useState<'for' | 'against' | 'abstain'>('for');
  const [interested, setInterested] = useState(false);
  const [demandsMeeting, setDemandsMeeting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cast = useMutation({
    mutationFn: () => api.post(`/board/resolutions/${resolutionId}/vote`, { boardMemberId, choice, interested, demandsMeeting }),
    onSuccess: () => {
      setError(null);
      onCast();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <form
      className="mt-3 flex flex-col gap-2 border-t border-ink-800 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        cast.mutate();
      }}
    >
      {error && <p className="text-2xs text-band-critical">{error}</p>}
      <Row>
        <SelectInput
          label="Voting as"
          required
          value={boardMemberId}
          onChange={setBoardMemberId}
          placeholder="Select a board member…"
          options={members.filter((m) => m.status === 'active').map((m) => ({ value: m.id, label: m.personName }))}
        />
        <SelectInput
          label="Choice"
          required
          value={choice}
          onChange={(v) => setChoice(v as typeof choice)}
          options={[{ value: 'for', label: 'For' }, { value: 'against', label: 'Against' }, { value: 'abstain', label: 'Abstain' }]}
        />
      </Row>
      <label className="flex items-center gap-2 text-xs text-ink-300">
        <input type="checkbox" checked={interested} onChange={(e) => setInterested(e.target.checked)} />
        I am interested in this matter — forces abstention
      </label>
      <label className="flex items-center gap-2 text-xs text-ink-300">
        <input type="checkbox" checked={demandsMeeting} onChange={(e) => setDemandsMeeting(e.target.checked)} />
        Demand this go to a meeting instead
      </label>
      <button className="btn-primary self-start" type="submit" disabled={!boardMemberId || cast.isPending}>
        Cast vote
      </button>
    </form>
  );
}

function CirculateForm({ resolutionId, onOpened }: { resolutionId: string; onOpened: () => void }) {
  const [dispatchProofRef, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);

  const open = useMutation({
    mutationFn: () => api.post(`/board/resolutions/${resolutionId}/circulate`, { dispatchProofRef }),
    onSuccess: () => {
      setError(null);
      onOpened();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        open.mutate();
      }}
    >
      {error && <p className="text-2xs text-band-critical">{error}</p>}
      <TextInput label="Dispatch proof" required value={dispatchProofRef} onChange={setRef} hint="the email or courier record proving it was sent (s.175)" />
      <button className="btn-primary self-start" type="submit" disabled={!dispatchProofRef || open.isPending}>
        Open for circulation
      </button>
    </form>
  );
}

function Mgt14Form({ resolutionId, onFiled }: { resolutionId: string; onFiled: () => void }) {
  const [srn, setSrn] = useState('');
  const [filedOn, setFiledOn] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  const record = useMutation({
    mutationFn: () => api.post(`/board/resolutions/${resolutionId}/mgt14`, { srn, filedOn }),
    onSuccess: () => {
      setError(null);
      onFiled();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        record.mutate();
      }}
    >
      {error && <p className="text-2xs text-band-critical">{error}</p>}
      <Row>
        <TextInput label="SRN" required value={srn} onChange={setSrn} />
        <TextInput label="Filed on" type="date" required value={filedOn} onChange={setFiledOn} />
      </Row>
      <button className="btn-primary self-start" type="submit" disabled={!srn || record.isPending}>
        Record filing
      </button>
    </form>
  );
}
