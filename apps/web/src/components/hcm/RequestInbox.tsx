/**
 * HCM — workflow (docs/hcm/workflow.md).
 *
 * A reusable "what is pending for me" inbox, backed by
 * `GET /hcm/workflow/inbox` and `POST /hcm/workflow/requests/:id/decide`. Any
 * page can drop this in — `/people/approvals` is the only one WS13 owns, but
 * the component itself takes no dependency on that page.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, RecordCode, StatusChip } from '../ui.js';
import { messageOf, TextArea } from '../forms.js';

export interface InboxItem {
  approvalId: string;
  level: number;
  requestId: string;
  recordCode: string;
  typeCode: string;
  typeName: string;
  subjectEmploymentId: string;
  payload: unknown;
  requestedById: string;
  submittedAt: string;
  slaHours: number;
}

const INBOX_QUERY_KEY = ['hcm-workflow-inbox'];

function payloadSummary(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '—';
  const entries = Object.entries(payload as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return '—';
  return entries.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ');
}

function slaTone(submittedAt: string, slaHours: number): 'neutral' | 'warn' | 'bad' {
  const dueAt = new Date(submittedAt).getTime() + slaHours * 3_600_000;
  const remainingHours = (dueAt - Date.now()) / 3_600_000;
  if (remainingHours < 0) return 'bad';
  if (remainingHours < 8) return 'warn';
  return 'neutral';
}

/** One inbox item, with its own inline decide form so a long list never needs a modal per row. */
function InboxRow({ item, onDecided }: { item: InboxItem; onDecided: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  const decideMutation = useMutation({
    mutationFn: (approve: boolean) => api.post(`/hcm/workflow/requests/${item.requestId}/decide`, { approve, note: note || undefined }),
    onSuccess: () => {
      setError(null);
      onDecided();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  const submit = (approve: boolean) => {
    setBusy(approve ? 'approve' : 'reject');
    decideMutation.mutate(approve, { onSettled: () => setBusy(null) });
  };

  const tone = slaTone(item.submittedAt, item.slaHours);

  return (
    <div className="flex flex-col gap-2 border-b border-ink-800 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <RecordCode code={item.recordCode} />
            <span className="text-sm font-medium text-ink-100">{item.typeName}</span>
            <StatusChip status={`level ${item.level}`} tone="accent" />
          </div>
          <p className="mt-1 text-2xs text-ink-400">{payloadSummary(item.payload)}</p>
        </div>
        <StatusChip
          status={tone === 'bad' ? 'SLA breached' : tone === 'warn' ? 'SLA due soon' : `submitted ${dateTime(item.submittedAt)}`}
          tone={tone === 'neutral' ? 'neutral' : tone}
        />
      </div>
      {error && (
        <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-2 py-1 text-2xs text-band-critical">{error}</p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1">
          <TextArea label="Note (optional)" value={note} onChange={setNote} rows={1} placeholder="Reason, condition, or context for the record" />
        </div>
        <button className="btn" disabled={decideMutation.isPending} onClick={() => submit(false)}>
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        <button className="btn-primary" disabled={decideMutation.isPending} onClick={() => submit(true)}>
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </div>
  );
}

/**
 * Everything pending for the signed-in party. `title`/`subtitle`/`emptyHint`
 * let an embedding page (a dashboard widget, a dedicated inbox) set its own
 * framing without forking the fetch-and-decide logic.
 */
export function RequestInbox({
  title = 'Approvals',
  subtitle,
  emptyHint = 'Nothing is waiting on you right now — the list fills as requests reach a level resolved to you.',
}: {
  title?: string;
  subtitle?: string;
  emptyHint?: string;
}) {
  const qc = useQueryClient();
  const inbox = useQuery({ queryKey: INBOX_QUERY_KEY, queryFn: () => api.get<InboxItem[]>('/hcm/workflow/inbox') });

  const refresh = () => qc.invalidateQueries({ queryKey: INBOX_QUERY_KEY });

  return (
    <Card title={title} subtitle={subtitle}>
      {inbox.isLoading && <Loading />}
      {inbox.error && <ErrorBox error={inbox.error} />}
      {inbox.data && inbox.data.length === 0 && <EmptyState message="Your approval inbox is empty." hint={emptyHint} />}
      {inbox.data && inbox.data.length > 0 && (
        <div>
          {inbox.data.map((item) => (
            <InboxRow key={item.approvalId} item={item} onDecided={refresh} />
          ))}
        </div>
      )}
    </Card>
  );
}
