/**
 * The board (equity-portal plan §6, phase 3): members and meetings.
 *
 * `Board`, `MeetingDetail`, `Resolutions`, `ResolutionDetail` and `Compliance`
 * together are the ERP side of the board — `portal/pages/Board.tsx` is the
 * same data, seen as a director or shareholder through the portal instead.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { BoardMemberView, BoardMeetingView, MeetingKind, MeetingMode } from '@kaizen/shared';
import { BOARD_MEMBER_ROLE_LABELS, MEETING_KIND_LABELS, MEETING_MODE_LABELS, MEETING_STATUS_LABELS } from '@kaizen/shared';
import { api, date, relative } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

const MEETING_STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  called: 'accent',
  minutes_draft: 'neutral',
  minutes_circulated: 'neutral',
  held: 'good',
  minutes_entered: 'good',
  minutes_signed: 'good',
  cancelled: 'bad',
};

export function Board() {
  const { can } = useSession();
  const [addingMember, setAddingMember] = useState(false);
  const [callingMeeting, setCallingMeeting] = useState(false);

  const members = useQuery({
    queryKey: ['board', 'members'],
    queryFn: () => api.get<{ items: BoardMemberView[] }>('/board/members'),
  });
  const meetings = useQuery({
    queryKey: ['board', 'meetings'],
    queryFn: () => api.get<{ items: BoardMeetingView[] }>('/board/meetings'),
  });

  if (members.error) return <ErrorBox error={members.error} />;
  if (meetings.error) return <ErrorBox error={meetings.error} />;

  return (
    <div>
      <AddBoardMember open={addingMember} onClose={() => setAddingMember(false)} />
      <CallMeeting open={callingMeeting} onClose={() => setCallingMeeting(false)} />
      <PageHeader
        title="Board"
        subtitle="Directors, meetings and the minutes lifecycle — SS-1 timelines throughout."
        actions={
          can('board_meetings:E') ? (
            <>
              <NewButton label="Add member" onClick={() => setAddingMember(true)} />
              <NewButton label="Call meeting" onClick={() => setCallingMeeting(true)} />
            </>
          ) : undefined
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-3">
          <Card title="Meetings">
            {meetings.isLoading ? (
              <Loading />
            ) : meetings.data!.items.length === 0 ? (
              <EmptyState message="No meeting has been called yet." hint="Notices, agendas and minutes appear here once meetings begin being recorded." />
            ) : (
              <div className="space-y-2">
                {meetings.data!.items.map((m) => (
                  <Link
                    key={m.id}
                    to={`/equity/board/meetings/${m.id}`}
                    className="block rounded-md border border-ink-800 bg-ink-900 p-3 transition-colors hover:border-ink-700"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="mono">{m.recordCode}</span>
                          <StatusChip status={MEETING_STATUS_LABELS[m.status]} tone={MEETING_STATUS_TONE[m.status] ?? 'neutral'} />
                          <span className="chip border-ink-700 text-ink-400">{MEETING_KIND_LABELS[m.kind]}</span>
                        </div>
                        <p className="mt-1 text-sm font-medium text-ink-100">{m.title}</p>
                        <p className="mt-0.5 text-2xs text-ink-500">
                          {date(m.scheduledFor)} · {MEETING_MODE_LABELS[m.mode]}
                          {m.heldOn && ` · held ${relative(m.heldOn)}`}
                        </p>
                      </div>
                      <p className="shrink-0 text-2xs text-ink-500">
                        {m.presentCount}/{m.quorumRequired} present
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-3">
          <Card title="Directors" subtitle="MBP-1: declared once each financial year.">
            {members.isLoading ? (
              <Loading />
            ) : members.data!.items.length === 0 ? (
              <EmptyState message="No board member has been added yet." />
            ) : (
              <div className="space-y-2">
                {members.data!.items.map((m) => (
                  <MemberRow key={m.id} member={m} />
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function MemberRow({ member }: { member: BoardMemberView }) {
  const { can } = useSession();
  const [declaring, setDeclaring] = useState(false);
  return (
    <div className="rounded-md border border-ink-800 bg-ink-900 p-3">
      <DeclareInterests open={declaring} onClose={() => setDeclaring(false)} member={member} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink-100">{member.personName}</p>
          <p className="text-2xs text-ink-500">{BOARD_MEMBER_ROLE_LABELS[member.role]}</p>
        </div>
        {member.status === 'ceased' && <span className="chip border-ink-700 text-ink-500">Ceased</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {member.interestsDeclaredThisYear ? (
          <span className="chip border-band-strong/40 bg-band-strong/10 text-band-strong">
            Interests declared {date(member.interestsDeclaredOn)}
          </span>
        ) : (
          <span className="chip border-band-watch/40 bg-band-watch/10 text-band-watch">Not declared this year</span>
        )}
        {can('board_meetings:E') && member.status === 'active' && (
          <button className="text-2xs text-accent-soft hover:underline" onClick={() => setDeclaring(true)}>
            Declare interests
          </button>
        )}
      </div>
    </div>
  );
}

function AddBoardMember({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [personId, setPersonId] = useState('');
  const [role, setRole] = useState<BoardMemberView['role'] | ''>('');
  const [din, setDin] = useState('');
  const [appointedOn, setAppointedOn] = useState(new Date().toISOString().slice(0, 10));

  const people = useQuery({
    queryKey: ['people-picker'],
    queryFn: () => api.get<{ items: Array<{ id: string; fullName: string; recordCode: string }> }>('/crm/people?pageSize=200'),
    enabled: open,
  });

  return (
    <CreateModal
      open={open}
      title="Add a board member"
      submitLabel="Add"
      onClose={onClose}
      invalidate={[['board', 'members']]}
      onSubmit={() => api.post('/board/members', { personId, role, din: din || undefined, appointedOn })}
    >
      <SelectInput
        label="Person"
        required
        value={personId}
        onChange={setPersonId}
        placeholder="Select a person…"
        options={(people.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.fullName} (${p.recordCode})` }))}
      />
      <Row>
        <SelectInput
          label="Role"
          required
          value={role}
          onChange={(v) => setRole(v as BoardMemberView['role'])}
          placeholder="Select…"
          options={Object.entries(BOARD_MEMBER_ROLE_LABELS).map(([value, label]) => ({ value: value as BoardMemberView['role'], label }))}
        />
        <TextInput label="DIN" value={din} onChange={setDin} hint="if a director" />
      </Row>
      <TextInput label="Appointed on" type="date" required value={appointedOn} onChange={setAppointedOn} />
    </CreateModal>
  );
}

function DeclareInterests({ open, onClose, member }: { open: boolean; onClose: () => void; member: BoardMemberView }) {
  const [entity, setEntity] = useState('');
  const [nature, setNature] = useState('');

  return (
    <CreateModal
      open={open}
      title={`Declare interests — ${member.personName}`}
      submitLabel="Record for this year"
      onClose={onClose}
      invalidate={[['board', 'members']]}
      onSubmit={() =>
        api.post(`/board/members/${member.id}/interests`, {
          interests: entity ? [{ entity, nature: nature || 'Interest' }] : [],
        })
      }
    >
      <p className="text-2xs text-ink-500">MBP-1: recorded once for this financial year, even if there is nothing to declare.</p>
      <TextInput label="Entity" value={entity} onChange={setEntity} hint="leave blank for a nil declaration" placeholder="Acme Supplies Pvt Ltd" />
      <TextInput label="Nature of interest" value={nature} onChange={setNature} placeholder="Director" />
    </CreateModal>
  );
}

function CallMeeting({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<MeetingKind>('board');
  const [title, setTitle] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [mode, setMode] = useState<MeetingMode>('vc');
  const [venue, setVenue] = useState('');
  const [shortNotice, setShortNotice] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <CreateModal
      open={open}
      title="Call a board meeting"
      submitLabel="Call meeting"
      onClose={onClose}
      invalidate={[['board', 'meetings']]}
      onSubmit={() =>
        api.post('/board/meetings', {
          kind,
          title,
          scheduledFor,
          mode,
          venue: venue || undefined,
          shortNoticeConsent: shortNotice ? { reason } : undefined,
        })
      }
    >
      <p className="text-2xs text-ink-500">Notice must be sent at least 7 days before the meeting (SS-1).</p>
      <Row>
        <SelectInput
          label="Kind"
          required
          value={kind}
          onChange={(v) => setKind(v as MeetingKind)}
          options={Object.entries(MEETING_KIND_LABELS).map(([value, label]) => ({ value: value as MeetingKind, label }))}
        />
        <SelectInput
          label="Mode"
          required
          value={mode}
          onChange={(v) => setMode(v as MeetingMode)}
          options={Object.entries(MEETING_MODE_LABELS).map(([value, label]) => ({ value: value as MeetingMode, label }))}
        />
      </Row>
      <TextInput label="Title" required value={title} onChange={setTitle} placeholder="Q3 board meeting" />
      <Row>
        <TextInput label="Scheduled for" type="date" required value={scheduledFor} onChange={setScheduledFor} />
        <TextInput label="Venue" value={venue} onChange={setVenue} placeholder="Registered office, or a link" />
      </Row>
      <label className="flex items-center gap-2 text-xs text-ink-300">
        <input type="checkbox" checked={shortNotice} onChange={(e) => setShortNotice(e.target.checked)} />
        This is short notice — record director consent
      </label>
      {shortNotice && (
        <TextArea label="Reason" required value={reason} onChange={setReason} rows={2} placeholder="Why the full notice period could not be given" />
      )}
    </CreateModal>
  );
}
