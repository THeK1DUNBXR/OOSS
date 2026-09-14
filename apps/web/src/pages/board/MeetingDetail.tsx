/**
 * A single board meeting: agenda, attendance and quorum, the minutes
 * lifecycle, the board pack and the resolutions tabled at it.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { BoardMemberView, BoardPackView } from '@kaizen/shared';
import { BOARD_PACK_ITEM_KIND_LABELS, MEETING_MODE_LABELS, MEETING_STATUS_LABELS, RESOLUTION_OUTCOME_LABELS } from '@kaizen/shared';
import { api, date } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, RecordCode, StatusChip } from '../../components/ui.js';
import { Row, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';

export function MeetingDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const { can } = useSession();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const pack = useQuery({
    queryKey: ['board', 'meeting-pack', id],
    queryFn: () => api.get<BoardPackView>(`/board/meetings/${id}/pack`),
  });
  const members = useQuery({
    queryKey: ['board', 'members'],
    queryFn: () => api.get<{ items: BoardMemberView[] }>('/board/members'),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['board', 'meeting-pack', id] });
    qc.invalidateQueries({ queryKey: ['board', 'meetings'] });
  };

  const action = useMutation({
    mutationFn: (call: () => Promise<unknown>) => call(),
    onSuccess: () => {
      setError(null);
      invalidateAll();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  if (pack.error) return <ErrorBox error={pack.error} />;
  if (pack.isLoading || members.isLoading) return <Loading />;

  const m = pack.data!.meeting;
  const canEdit = can('board_meetings:E');

  return (
    <div>
      <PageHeader
        title={m.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-1.5">
            <RecordCode code={m.recordCode} />
            <StatusChip status={MEETING_STATUS_LABELS[m.status]} />
            <span>{date(m.scheduledFor)} · {MEETING_MODE_LABELS[m.mode]}</span>
          </span>
        }
        actions={
          canEdit && m.status === 'called' ? (
            <button className="btn" onClick={() => action.mutate(() => api.post(`/board/meetings/${id}/cancel`, {}))}>
              Cancel meeting
            </button>
          ) : undefined
        }
      />

      {error && (
        <div className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Agenda meetingId={id} agenda={m.agenda} canEdit={canEdit} onSaved={invalidateAll} />

          <Attendance
            meetingId={id}
            meeting={m}
            members={members.data!.items}
            canEdit={canEdit}
            onSaved={invalidateAll}
            runAction={(call) => action.mutate(call)}
          />

          <Card title="Minutes">
            <MinutesLifecycle meetingId={id} meeting={m} canEdit={canEdit} runAction={(call) => action.mutate(call)} />
          </Card>

          <Card title="Resolutions on this meeting">
            {pack.data!.resolutions.length === 0 ? (
              <EmptyState message="No resolution has been tabled for this meeting." />
            ) : (
              <div className="space-y-2">
                {pack.data!.resolutions.map((r) => (
                  <Link key={r.id} to={`/equity/resolutions/${r.id}`} className="block rounded-md border border-ink-800 bg-ink-900 p-3 hover:border-ink-700">
                    <div className="flex items-center gap-1.5">
                      <span className="mono">{r.recordCode}</span>
                      <StatusChip status={RESOLUTION_OUTCOME_LABELS[r.outcome]} />
                    </div>
                    <p className="mt-1 text-sm text-ink-100">{r.title}</p>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <BoardPack meetingId={id} items={pack.data!.items} canAdd={can('board_documents:C')} onAdded={invalidateAll} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Agenda({
  meetingId, agenda, canEdit, onSaved,
}: {
  meetingId: string;
  agenda: BoardPackView['meeting']['agenda'];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api.post(`/board/meetings/${meetingId}/agenda`, {
        agenda: [...agenda, { n: agenda.length + 1, title, notes: notes || undefined }],
      }),
    onSuccess: () => {
      setTitle('');
      setNotes('');
      setError(null);
      onSaved();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Card title="Agenda">
      {agenda.length === 0 ? (
        <EmptyState message="No agenda item yet." />
      ) : (
        <ol className="space-y-1.5">
          {agenda.map((a) => (
            <li key={a.n} className="text-sm text-ink-200">
              <span className="mono text-ink-500">{a.n}.</span> {a.title}
              {a.notes && <span className="block pl-4 text-2xs text-ink-500">{a.notes}</span>}
            </li>
          ))}
        </ol>
      )}
      {canEdit && (
        <form
          className="mt-3 flex flex-col gap-2 border-t border-ink-800 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          {error && <p className="text-2xs text-band-critical">{error}</p>}
          <Row>
            <TextInput label="Item" value={title} onChange={setTitle} placeholder="Approve the quarterly accounts" />
            <TextInput label="Notes" value={notes} onChange={setNotes} />
          </Row>
          <button className="btn self-start" type="submit" disabled={!title || add.isPending}>
            Add to agenda
          </button>
        </form>
      )}
    </Card>
  );
}

function Attendance({
  meetingId, meeting, members, canEdit, onSaved, runAction,
}: {
  meetingId: string;
  meeting: BoardPackView['meeting'];
  members: BoardMemberView[];
  canEdit: boolean;
  onSaved: () => void;
  runAction: (call: () => Promise<unknown>) => void;
}) {
  const active = members.filter((m) => m.status === 'active');
  const [present, setPresent] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const initial: Record<string, boolean> = {};
    for (const a of meeting.attendees) initial[a.boardMemberId] = a.present;
    setPresent(initial);
  }, [meeting.id]);

  const presentCount = Object.values(present).filter(Boolean).length;

  const save = useMutation({
    mutationFn: () =>
      api.post(
        `/board/meetings/${meetingId}/attendance`,
        { attendees: active.map((m) => ({ boardMemberId: m.id, present: Boolean(present[m.id]) })) },
      ),
    onSuccess: onSaved,
  });

  return (
    <Card title="Attendance">
      {active.length === 0 ? (
        <EmptyState message="No active board member to record attendance for." />
      ) : (
        <div className="space-y-1.5">
          {active.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-sm text-ink-200">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={Boolean(present[m.id])}
                onChange={(e) => setPresent((p) => ({ ...p, [m.id]: e.target.checked }))}
              />
              {m.personName}
            </label>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs font-medium text-ink-300">
        Quorum: {presentCount} of {meeting.quorumRequired} present — {meeting.quorumMet ? 'met' : 'not met'}
      </p>
      {canEdit && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn" onClick={() => save.mutate()} disabled={save.isPending}>
            Save attendance
          </button>
          {meeting.status === 'called' && (
            <button
              className="btn-primary"
              onClick={() => runAction(() => api.post(`/board/meetings/${meetingId}/held`, {}))}
            >
              Mark held
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function MinutesLifecycle({
  meetingId, meeting, canEdit, runAction,
}: {
  meetingId: string;
  meeting: BoardPackView['meeting'];
  canEdit: boolean;
  runAction: (call: () => Promise<unknown>) => void;
}) {
  const [text, setText] = useState(meeting.minutesText ?? '');
  const [late, setLate] = useState(false);
  const [reason, setReason] = useState('');

  if (!canEdit) {
    return meeting.minutesText ? <p className="whitespace-pre-wrap text-sm text-ink-200">{meeting.minutesText}</p> : <EmptyState message="No minutes recorded yet." />;
  }

  if (meeting.status === 'called' || meeting.status === 'cancelled') {
    return <EmptyState message="Minutes can be drafted once the meeting is marked held." />;
  }

  if (meeting.status === 'held') {
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          runAction(() => api.post(`/board/meetings/${meetingId}/minutes/draft`, { text }));
        }}
      >
        <TextArea label="Minutes" required rows={6} value={text} onChange={setText} />
        <button className="btn-primary self-start" type="submit">Save draft</button>
      </form>
    );
  }

  if (meeting.status === 'minutes_draft') {
    return (
      <div className="space-y-2">
        <p className="whitespace-pre-wrap text-sm text-ink-200">{meeting.minutesText}</p>
        <button className="btn-primary" onClick={() => runAction(() => api.post(`/board/meetings/${meetingId}/minutes/circulate`, {}))}>
          Circulate minutes
        </button>
      </div>
    );
  }

  if (meeting.status === 'minutes_circulated') {
    return (
      <div className="space-y-2">
        <p className="whitespace-pre-wrap text-sm text-ink-200">{meeting.minutesText}</p>
        <label className="flex items-center gap-2 text-xs text-ink-300">
          <input type="checkbox" checked={late} onChange={(e) => setLate(e.target.checked)} />
          Entering this late — record the reason (SS-1 allows 30 days)
        </label>
        {late && <TextInput label="Reason" required value={reason} onChange={setReason} />}
        <button
          className="btn-primary"
          onClick={() => runAction(() => api.post(`/board/meetings/${meetingId}/minutes/enter`, late ? { late: true, reason } : {}))}
        >
          Enter minutes
        </button>
      </div>
    );
  }

  if (meeting.status === 'minutes_entered') {
    return (
      <div className="space-y-2">
        <p className="whitespace-pre-wrap text-sm text-ink-200">{meeting.minutesText}</p>
        <button className="btn-primary" onClick={() => runAction(() => api.post(`/board/meetings/${meetingId}/minutes/sign`, {}))}>
          Sign minutes
        </button>
      </div>
    );
  }

  return <p className="whitespace-pre-wrap text-sm text-ink-200">{meeting.minutesText}</p>;
}

function BoardPack({
  meetingId, items, canAdd, onAdded,
}: {
  meetingId: string;
  items: BoardPackView['items'];
  canAdd: boolean;
  onAdded: () => void;
}) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<keyof typeof BOARD_PACK_ITEM_KIND_LABELS>('paper');
  const [fileRef, setFileRef] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => api.post(`/board/meetings/${meetingId}/pack`, { title, kind, fileRef }),
    onSuccess: () => {
      setTitle('');
      setFileRef('');
      setError(null);
      onAdded();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Card title="Board pack">
      {items.length === 0 ? (
        <EmptyState message="Nothing has been added to the pack yet." />
      ) : (
        <ul className="space-y-1.5">
          {items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-2 text-sm text-ink-200">
              <span className="truncate">{i.title}</span>
              <span className="chip border-ink-700 text-ink-400">{BOARD_PACK_ITEM_KIND_LABELS[i.kind]}</span>
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <form
          className="mt-3 flex flex-col gap-2 border-t border-ink-800 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          {error && <p className="text-2xs text-band-critical">{error}</p>}
          <TextInput label="Title" required value={title} onChange={setTitle} />
          <SelectInput
            label="Kind"
            required
            value={kind}
            onChange={(v) => setKind(v as typeof kind)}
            options={Object.entries(BOARD_PACK_ITEM_KIND_LABELS).map(([value, label]) => ({ value: value as typeof kind, label }))}
          />
          <TextInput label="File reference" required value={fileRef} onChange={setFileRef} hint="a document id or link" />
          <button className="btn self-start" type="submit" disabled={add.isPending}>
            Add to pack
          </button>
        </form>
      )}
    </Card>
  );
}
