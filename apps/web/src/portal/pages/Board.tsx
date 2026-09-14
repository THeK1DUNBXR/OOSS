/**
 * The portal's view of the board (equity-portal plan §6, phase 3) — upcoming
 * meetings and their packs, and the resolutions a director votes on. The ERP
 * side of the same data is `pages/board/*`.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardMeetingView, BoardMemberView, BoardPackView, ResolutionView } from '@kaizen/shared';
import { MEETING_MODE_LABELS, RESOLUTION_OUTCOME_LABELS } from '@kaizen/shared';
import { api, date } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { Row, SelectInput, messageOf } from '../../components/forms.js';

export function Board() {
  const { user, can } = useSession();

  const meetings = useQuery({
    queryKey: ['board', 'meetings'],
    queryFn: () => api.get<{ items: BoardMeetingView[] }>('/board/meetings'),
  });
  const resolutions = useQuery({
    queryKey: ['board', 'resolutions'],
    queryFn: () => api.get<{ items: ResolutionView[] }>('/board/resolutions'),
  });
  const members = useQuery({
    queryKey: ['board', 'members'],
    queryFn: () => api.get<{ items: BoardMemberView[] }>('/board/members'),
    enabled: can('resolutions:approve'),
  });

  if (meetings.error) return <ErrorBox error={meetings.error} />;
  if (resolutions.error) return <ErrorBox error={resolutions.error} />;

  const upcoming = (meetings.data?.items ?? []).filter((m) => m.status !== 'cancelled' && !m.heldOn);
  const open = (resolutions.data?.items ?? []).filter((r) => r.outcome === 'open');
  const past = (resolutions.data?.items ?? []).filter((r) => ['passed', 'failed', 'withdrawn', 'meeting_demanded'].includes(r.outcome));
  const me = members.data?.items.find((m) => m.personId === user?.personId);

  const nothing = upcoming.length === 0 && open.length === 0 && past.length === 0;

  return (
    <div>
      <PageHeader title="Board" />

      {meetings.isLoading || resolutions.isLoading ? (
        <Loading />
      ) : nothing ? (
        <EmptyState
          message="No meeting has been called yet."
          hint="Notices, agendas and minutes appear here once meetings begin being recorded."
        />
      ) : (
        <div className="space-y-5">
          <Card title="Upcoming meetings">
            {upcoming.length === 0 ? (
              <EmptyState message="Nothing scheduled." />
            ) : (
              <div className="space-y-3">
                {upcoming.map((m) => (
                  <UpcomingMeeting key={m.id} meeting={m} />
                ))}
              </div>
            )}
          </Card>

          <Card title="Resolutions open for a vote">
            {open.length === 0 ? (
              <EmptyState message="Nothing is open for circulation right now." />
            ) : (
              <div className="space-y-3">
                {open.map((r) => (
                  <OpenResolution key={r.id} resolution={r} myBoardMemberId={me?.id} canVote={can('resolutions:approve')} />
                ))}
              </div>
            )}
          </Card>

          <Card title="Past resolutions">
            {past.length === 0 ? (
              <EmptyState message="Nothing decided yet." />
            ) : (
              <ul className="space-y-2">
                {past.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 rounded-md border border-ink-800 bg-ink-900 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink-100">{r.title}</p>
                      <p className="text-2xs text-ink-500">{r.recordCode}</p>
                    </div>
                    <StatusChip status={RESOLUTION_OUTCOME_LABELS[r.outcome]} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function UpcomingMeeting({ meeting }: { meeting: BoardMeetingView }) {
  const pack = useQuery({
    queryKey: ['board', 'meeting-pack', meeting.id],
    queryFn: () => api.get<BoardPackView>(`/board/meetings/${meeting.id}/pack`),
  });

  return (
    <div className="rounded-md border border-ink-800 bg-ink-900 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink-100">{meeting.title}</p>
        <span className="text-2xs text-ink-500">
          {date(meeting.scheduledFor)} · {MEETING_MODE_LABELS[meeting.mode]}
        </span>
      </div>
      {meeting.agenda.length > 0 && (
        <ul className="mt-2 list-disc pl-4 text-2xs text-ink-400">
          {meeting.agenda.map((a) => (
            <li key={a.n}>{a.title}</li>
          ))}
        </ul>
      )}
      {pack.data && pack.data.items.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {pack.data.items.map((i) => (
            <a key={i.id} href={i.fileRef} className="chip border-ink-700 text-accent-soft hover:underline">
              {i.title}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function OpenResolution({
  resolution, myBoardMemberId, canVote,
}: {
  resolution: ResolutionView;
  myBoardMemberId: string | undefined;
  canVote: boolean;
}) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<'for' | 'against' | 'abstain'>('for');
  const [interested, setInterested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const myVote = resolution.votes.find((v) => v.boardMemberId === myBoardMemberId);

  const cast = useMutation({
    mutationFn: (demandsMeeting: boolean) =>
      api.post(`/board/resolutions/${resolution.id}/vote`, { boardMemberId: myBoardMemberId, choice, interested, demandsMeeting }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['board', 'resolutions'] });
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <div className="rounded-md border border-ink-800 bg-ink-900 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink-100">{resolution.title}</p>
        <span className="mono text-2xs text-ink-500">{resolution.recordCode}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-2xs text-ink-400">{resolution.text}</p>

      {canVote && myBoardMemberId && (
        <div className="mt-3 border-t border-ink-800 pt-3">
          {myVote ? (
            <p className="text-2xs text-ink-400">
              You voted <span className="font-medium text-ink-200">{myVote.choice}</span>
              {myVote.abstainedAsInterested && ' (as an interested party)'}.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {error && <p className="text-2xs text-band-critical">{error}</p>}
              <Row>
                <SelectInput
                  label="Your vote"
                  value={choice}
                  onChange={(v) => setChoice(v as typeof choice)}
                  options={[{ value: 'for', label: 'For' }, { value: 'against', label: 'Against' }, { value: 'abstain', label: 'Abstain' }]}
                />
              </Row>
              <label className="flex items-center gap-2 text-2xs text-ink-300">
                <input type="checkbox" checked={interested} onChange={(e) => setInterested(e.target.checked)} />
                I am interested in this matter
              </label>
              <div className="flex gap-2">
                <button className="btn-primary" onClick={() => cast.mutate(false)} disabled={cast.isPending}>
                  Vote
                </button>
                <button className="btn" onClick={() => cast.mutate(true)} disabled={cast.isPending}>
                  Demand a meeting
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
