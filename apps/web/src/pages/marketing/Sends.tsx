/**
 * Sends — one batch message to an audience, and the wizard that creates one.
 *
 * Creating a send only ever produces a draft; the count it reports already
 * excludes people without consent, marked do-not-contact, opted out or
 * suppressed (the contract's own words). The wizard shows that breakdown —
 * the dry run — before the send is ever requested, so nobody queues a send
 * blind. Requesting it is the step that can fail honestly: with no channel
 * adapter configured, the send raises EX-MKT-011 and the request fails —
 * `MarketingSend` has no column to persist a structured reason on the record
 * itself, so the server's 422 message is shown verbatim in the banner below,
 * never a silent no-op and never a UI field the server cannot fill in.
 */

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CHANNEL_KEY_LABELS,
  RECIPIENT_STATUSES,
  RECIPIENT_STATUS_LABELS,
  SEND_STATUS_LABELS,
  SEND_TRANSITIONS,
  type ChannelKey,
  type RecipientStatus,
  type SendStatus,
} from '@kaizen/shared';
import { dateTime } from '../../lib/api.js';
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
} from '../../components/ui.js';
import { CreateModal, messageOf, Row, SelectInput, TextInput } from '../../components/forms.js';
import {
  useApproveSend,
  useAudiences,
  useCancelSend,
  useCreateSend,
  useDispatchSend,
  useMarketingPolicy,
  useRequestSend,
  useSend,
  useSendDryRun,
  useSendRecipients,
  useSends,
  useSendTest,
  useTemplates,
} from '../../lib/marketingApi.js';
import { useSession } from '../../lib/session.js';

const STATUS_TONE: Record<SendStatus, 'neutral' | 'good' | 'accent' | 'warn' | 'bad'> = {
  draft: 'neutral',
  queued: 'accent',
  sending: 'accent',
  sent: 'good',
  failed: 'bad',
  cancelled: 'warn',
};

const SKIP_REASON_GROUPS: Array<{ key: string; label: string; match: (r: string) => boolean }> = [
  { key: 'no_consent', label: 'No consent', match: (r) => r.includes('consent') },
  { key: 'dnc', label: 'Do not contact', match: (r) => r.includes('do_not_contact') || r.includes('dnc') },
  { key: 'opted_out', label: 'Opted out', match: (r) => r.includes('opt') },
  { key: 'suppressed', label: 'Suppressed', match: (r) => r.includes('suppress') },
  { key: 'no_address', label: 'No address on file', match: (r) => r.includes('address') || r.includes('no_email') || r.includes('no_phone') },
];

function groupSkipped(skipped: Array<{ personId: string; reason: string }>) {
  const buckets = new Map<string, number>();
  for (const s of skipped) {
    const g = SKIP_REASON_GROUPS.find((g) => g.match(s.reason));
    const key = g?.label ?? 'Other';
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return Array.from(buckets.entries());
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function Sends() {
  const { can } = useSession();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading, error } = useSends();

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Sends"
        subtitle="Batch messages — each one dry-run before it can be requested, and requested before it can go out."
        actions={
          can('marketing_sends:C') && (
            <button className="btn-primary" onClick={() => setWizardOpen(true)}>
              New send
            </button>
          )
        }
      />

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState message="No sends yet." hint="A send needs an approved template and an audience." />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Template</th>
                <th>Channel</th>
                <th>Audience</th>
                <th>Status</th>
                <th className="text-right">Recipients</th>
                <th>Scheduled</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id} className="cursor-pointer" onClick={() => setOpenId(s.id)}>
                  <td>
                    <RecordCode code={s.recordCode} />
                  </td>
                  <td className="text-xs font-medium text-ink-100">{s.templateName}</td>
                  <td className="text-xs text-ink-300">{CHANNEL_KEY_LABELS[s.channelKey]}</td>
                  <td className="text-xs text-ink-300">{s.audienceName ?? '—'}</td>
                  <td>
                    <StatusChip status={SEND_STATUS_LABELS[s.status]} tone={STATUS_TONE[s.status]} />
                  </td>
                  <td className="text-right tabular-nums text-xs">{s.recipientCount}</td>
                  <td className="text-2xs text-ink-500">{s.scheduledAt ? dateTime(s.scheduledAt) : 'not scheduled'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <NewSendWizard open={wizardOpen} onClose={() => setWizardOpen(false)} onDone={(id) => setOpenId(id)} />
      {openId && <SendQuickView id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/** A lightweight peek from the list — the full detail lives at the route. */
function SendQuickView({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <Modal open title="Send" onClose={onClose} width="max-w-4xl">
      <SendDetailBody id={id} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

function NewSendWizard({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [templateId, setTemplateId] = useState('');
  const [audienceId, setAudienceId] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const templates = useTemplates({ status: 'approved' });
  const audiences = useAudiences();
  const create = useCreateSend();
  const requestSend = useRequestSend();
  const dryRun = useSendDryRun(draftId ?? undefined);
  const draft = useSend(draftId ?? undefined);

  const selectedTemplate = templates.data?.items.find((t) => t.id === templateId);

  const reset = () => {
    setStep('form');
    setTemplateId('');
    setAudienceId('');
    setScheduledAt('');
    setDraftId(null);
    setBanner(null);
  };

  return (
    <Modal
      open={open}
      title={step === 'form' ? 'New send' : 'Review before requesting'}
      onClose={() => {
        reset();
        onClose();
      }}
      width="max-w-2xl"
      footer={
        step === 'form' ? (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={!templateId || !audienceId || !selectedTemplate || create.isPending}
              onClick={() => {
                if (!selectedTemplate) return;
                create.mutate(
                  { templateId, channelKey: selectedTemplate.channelKey, audienceId, scheduledAt: scheduledAt || undefined },
                  {
                    onSuccess: (res) => {
                      setDraftId(res.id);
                      setStep('review');
                    },
                    onError: (e) => setBanner(messageOf(e)),
                  },
                );
              }}
            >
              {create.isPending ? 'Creating…' : 'Continue to dry run'}
            </button>
          </>
        ) : (
          <>
            <button
              className="btn-ghost"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Leave as draft
            </button>
            <button
              className="btn-primary"
              disabled={requestSend.isPending || !draftId}
              onClick={() => {
                if (!draftId) return;
                requestSend.mutate(draftId, {
                  onSuccess: () => {
                    onDone(draftId);
                    reset();
                    onClose();
                  },
                  onError: (e) => setBanner(messageOf(e)),
                });
              }}
            >
              {requestSend.isPending ? 'Requesting…' : 'Request send'}
            </button>
          </>
        )
      }
    >
      {banner && (
        <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{banner}</p>
      )}

      {step === 'form' ? (
        <div className="space-y-3">
          <SelectInput
            label="Template"
            required
            value={templateId}
            onChange={setTemplateId}
            placeholder={templates.data?.items.length ? 'Choose an approved template' : 'No approved templates yet'}
            options={(templates.data?.items ?? []).map((t) => ({ value: t.id, label: `${t.name} (${CHANNEL_KEY_LABELS[t.channelKey]})` }))}
          />
          {selectedTemplate && <p className="text-2xs text-ink-500">Channel is fixed to the template's own: {CHANNEL_KEY_LABELS[selectedTemplate.channelKey]}.</p>}
          <SelectInput
            label="Audience"
            required
            value={audienceId}
            onChange={setAudienceId}
            placeholder={audiences.data?.items.length ? 'Choose an audience' : 'No audiences yet'}
            options={(audiences.data?.items ?? []).map((a) => ({ value: a.id, label: a.name }))}
          />
          <TextInput label="Schedule for (optional)" type="date" value={scheduledAt} onChange={setScheduledAt} hint="Leave blank to request immediately" />
        </div>
      ) : (
        <div className="space-y-3">
          {dryRun.isLoading || draft.isLoading ? (
            <Loading label="Running the dry run" />
          ) : dryRun.error ? (
            <ErrorBox error={dryRun.error} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Eligible" value={dryRun.data?.eligible ?? draft.data?.recipientCount ?? 0} tone="good" noActionReason="Will receive this send once requested." />
                <Metric
                  label="Skipped"
                  value={dryRun.data?.skipped.length ?? 0}
                  tone={(dryRun.data?.skipped.length ?? 0) > 0 ? 'warn' : 'neutral'}
                  noActionReason="Excluded for a recorded, falsifiable reason."
                />
              </div>
              {dryRun.data && dryRun.data.skipped.length > 0 && (
                <div className="rounded-md border border-ink-800 bg-ink-950 p-3">
                  <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-500">Skipped, by reason</p>
                  <ul className="space-y-1 text-xs text-ink-300">
                    {groupSkipped(dryRun.data.skipped).map(([label, count]) => (
                      <li key={label} className="flex items-center justify-between">
                        <span>{label}</span>
                        <span className="tabular-nums text-ink-400">{count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-2xs text-ink-500">
                This send stays a draft until you request it — leaving now keeps it exactly as it is, to request or cancel later from Sends.
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Detail (route: /marketing/sends/:id)
// ---------------------------------------------------------------------------

export function SendDetail() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <ErrorBox error={new Error('No send id in the URL')} />;
  return (
    <div>
      <PageHeader title="Send" subtitle="Counts, recipients, and the actions this status allows." />
      <SendDetailBody id={id} />
    </div>
  );
}

function SendDetailBody({ id }: { id: string }) {
  const { user, can } = useSession();
  const { data, isLoading, error } = useSend(id);
  const [banner, setBanner] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | ''>('');
  const [testOpen, setTestOpen] = useState(false);
  const policy = useMarketingPolicy();

  const requestSend = useRequestSend();
  const approveSend = useApproveSend();
  const cancelSend = useCancelSend();
  const dispatchSend = useDispatchSend();
  const recipients = useSendRecipients(id, statusFilter || undefined);

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? new Error('Not found')} />;

  const send = data;
  const nextStates = SEND_TRANSITIONS[send.status];
  const isOwnProposal = Boolean(user && send.requestedById === user.personId);
  const overThreshold = Boolean(policy.data && send.recipientCount > policy.data.sendApprovalThreshold);
  const needsApproval = overThreshold && !send.approvedById;

  const rate = (n: number) => (send.recipientCount > 0 ? `${((n / send.recipientCount) * 100).toFixed(1)}%` : '—');

  return (
    <div className="space-y-4">
      {banner && (
        <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{banner}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={SEND_STATUS_LABELS[send.status]} tone={STATUS_TONE[send.status]} />
        <span className="chip border-ink-700 text-ink-400">{CHANNEL_KEY_LABELS[send.channelKey]}</span>
        <RecordCode code={send.recordCode} />
        {send.approvedByName && <span className="text-2xs text-ink-500">approved by {send.approvedByName}</span>}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 sm:grid-cols-3">
        <Field label="Template">{send.templateName}</Field>
        <Field label="Audience">{send.audienceName ?? '—'}</Field>
        <Field label="Requested by">{send.requestedByName}</Field>
        <Field label="Scheduled">{send.scheduledAt ? dateTime(send.scheduledAt) : 'not scheduled'}</Field>
        <Field label="Sent at">{send.sentAt ? dateTime(send.sentAt) : '—'}</Field>
      </dl>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Sent" value={send.recipientCount} noActionReason="Total recipients this send targets." />
        <Metric label="Delivered" value={send.deliveredCount} sub={rate(send.deliveredCount)} tone="good" noActionReason="Confirmed by the channel provider." />
        <Metric label="Opened" value={send.openedCount} sub={rate(send.openedCount)} noActionReason="Tracked opens, where the channel supports it." />
        <Metric label="Clicked" value={send.clickedCount} sub={rate(send.clickedCount)} noActionReason="Tracked link clicks." />
        <Metric
          label="Bounced"
          value={send.bouncedCount}
          sub={`${(send.bounceRate * 100).toFixed(1)}%`}
          tone={send.bounceRate > 0.05 ? 'bad' : 'neutral'}
          noActionReason="Above 5% raises an exception."
        />
        <Metric
          label="Unsubscribed"
          value={send.unsubscribedCount}
          sub={`${(send.unsubscribeRate * 100).toFixed(1)}%`}
          tone={send.unsubscribeRate > 0.02 ? 'bad' : 'neutral'}
          noActionReason="Above 2% raises an exception."
        />
      </div>

      {send.status === 'draft' && needsApproval && (
        isOwnProposal ? (
          <p className="rounded-md border border-band-watch/40 bg-band-watch/10 px-3 py-2 text-xs italic text-band-watch">
            Awaiting a second person's review — this send is over the approval threshold and you requested it, so you cannot approve it yourself.
          </p>
        ) : (
          !can('marketing_sends:approve') && (
            <p className="text-2xs italic text-ink-500">Over the approval threshold — needs approval before it can be requested.</p>
          )
        )
      )}

      <div className="flex flex-wrap gap-2 border-t border-ink-800 pt-3">
        {send.status === 'draft' && needsApproval && !isOwnProposal && can('marketing_sends:approve') && (
          <button className="btn-primary" disabled={approveSend.isPending} onClick={() => approveSend.mutate(send.id, { onError: (e) => setBanner(messageOf(e)) })}>
            Approve
          </button>
        )}
        {send.status === 'draft' && nextStates.includes('queued') && can('marketing_sends:E') && (!needsApproval || Boolean(send.approvedById)) && (
          <button className="btn-primary" disabled={requestSend.isPending} onClick={() => requestSend.mutate(send.id, { onError: (e) => setBanner(messageOf(e)) })}>
            {requestSend.isPending ? 'Requesting…' : 'Request send'}
          </button>
        )}
        {send.status === 'queued' && can('marketing_sends:E') && (
          <button className="btn-primary" disabled={dispatchSend.isPending} onClick={() => dispatchSend.mutate(send.id, { onError: (e) => setBanner(messageOf(e)) })}>
            {dispatchSend.isPending ? 'Dispatching…' : 'Dispatch now'}
          </button>
        )}
        {nextStates.includes('cancelled') && can('marketing_sends:E') && (
          <button className="btn-ghost text-band-critical" disabled={cancelSend.isPending} onClick={() => cancelSend.mutate(send.id, { onError: (e) => setBanner(messageOf(e)) })}>
            Cancel
          </button>
        )}
        {can('marketing_sends:C') && (
          <button className="btn-ghost" onClick={() => setTestOpen(true)}>
            Send test
          </button>
        )}
      </div>

      <Card
        title="Recipients"
        actions={
          <select className="input max-w-xs" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as RecipientStatus | '')}>
            <option value="">Every status</option>
            {RECIPIENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {RECIPIENT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        }
        bodyClassName="p-0"
      >
        {recipients.isLoading ? (
          <Loading />
        ) : !recipients.data?.length ? (
          <div className="p-4">
            <EmptyState message="No recipients match." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {recipients.data.map((r) => (
                  <tr key={r.id}>
                    <td className="text-xs text-ink-200">{r.personName}</td>
                    <td>
                      <StatusChip status={RECIPIENT_STATUS_LABELS[r.status as RecipientStatus] ?? r.status} />
                    </td>
                    <td className="text-2xs text-ink-500">{r.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <SendTestDialog
        open={testOpen}
        onClose={() => setTestOpen(false)}
        templateId={send.templateId}
        channelKey={send.channelKey}
      />
    </div>
  );
}

function SendTestDialog({
  open,
  onClose,
  templateId,
  channelKey,
}: {
  open: boolean;
  onClose: () => void;
  templateId: string;
  channelKey: ChannelKey;
}) {
  const [to, setTo] = useState('');
  const test = useSendTest();
  const [result, setResult] = useState<string | null>(null);

  return (
    <Modal open={open} title="Send a test" onClose={onClose}>
      <div className="space-y-3">
        <TextInput label="Send to" required value={to} onChange={setTo} placeholder="Email, phone, or WhatsApp number" />
        {result && <p className="text-xs text-ink-300">{result}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn-primary"
            disabled={!to || test.isPending}
            onClick={() =>
              test.mutate(
                { templateId, channelKey, to },
                {
                  onSuccess: (r) => setResult(r.ok ? 'Test sent.' : 'The adapter reported it could not send this test.'),
                  onError: (e) => setResult(messageOf(e)),
                },
              )
            }
          >
            {test.isPending ? 'Sending…' : 'Send test'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
