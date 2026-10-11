/**
 * Campaign detail — status + the CAMPAIGN_TRANSITIONS-allowed lifecycle
 * actions, gated by grant; approve/reject additionally bar the proposer
 * (the platform's self-dealing rule, MKT-CMP-003) from approving their own
 * campaign — shown as a plain sentence, never a disabled button pretending
 * the option exists.
 */

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CAMPAIGN_OBJECTIVE_LABELS,
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_TRANSITIONS,
  CHANNEL_KEY_LABELS,
  CHANNEL_KEYS,
  type CampaignStatus,
  type ChannelKey,
  type MarketingEventView,
  type SendView,
  type SpendView,
} from '@kaizen/shared';
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
} from '../../components/ui.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';
import { CreateModal, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';
import { date, dateTime, money, titleCase } from '../../lib/api.js';
import {
  mk,
  useApproveCampaign,
  useArchiveCampaign,
  useCampaign,
  useCampaignTimeline,
  useCampaignUtm,
  useCancelCampaign,
  useCompleteCampaign,
  useCreateSpend,
  useLaunchCampaign,
  useMarketingEvents,
  usePauseCampaign,
  useRejectCampaign,
  useReconcileSpend,
  useResumeCampaign,
  useSends,
  useSpends,
  useSubmitCampaign,
  type CampaignApprovalView,
} from '../../lib/marketingApi.js';

type DetailTab = 'summary' | 'timeline' | 'spend' | 'leads' | 'events' | 'sends' | 'approvals';

const STATUS_TONE: Record<CampaignStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  draft: 'neutral',
  pending_approval: 'warn',
  scheduled: 'accent',
  live: 'good',
  paused: 'warn',
  completed: 'neutral',
  archived: 'neutral',
  cancelled: 'bad',
};

export function CampaignDetail() {
  const { id = '' } = useParams();
  const { user, can } = useSession();
  const [tab, setTab] = useState<DetailTab>('summary');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const { data: campaign, isLoading, error } = useCampaign(id);

  const submit = useSubmitCampaign();
  const launch = useLaunchCampaign();
  const pause = usePauseCampaign();
  const resume = useResumeCampaign();
  const complete = useCompleteCampaign();
  const archive = useArchiveCampaign();
  const approve = useApproveCampaign(id);
  const reject = useRejectCampaign(id);
  const cancel = useCancelCampaign(id);

  if (isLoading) return <Loading label="Loading campaign" />;
  if (error) return <ErrorBox error={error} />;
  if (!campaign) return null;

  const allowed = new Set(CAMPAIGN_TRANSITIONS[campaign.status]);
  const canEdit = can('campaigns:E');
  const canApprove = can('campaigns:approve');
  const isProposer = user?.personId === campaign.ownerPartyId;

  return (
    <div>
      <PageHeader
        title={campaign.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <RecordCode code={campaign.recordCode} />
            <span>{titleCase(campaign.division)}</span>
            <span>·</span>
            <span>{CAMPAIGN_OBJECTIVE_LABELS[campaign.objective]}</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={CAMPAIGN_STATUS_LABELS[campaign.status]} tone={STATUS_TONE[campaign.status]} />
            {canEdit && campaign.status === 'draft' && allowed.has('pending_approval') && (
              <button className="btn-primary" disabled={submit.isPending} onClick={() => submit.mutate(campaign.id)}>
                Submit
              </button>
            )}
            {canEdit && campaign.status === 'scheduled' && allowed.has('live') && (
              <button className="btn-primary" disabled={launch.isPending} onClick={() => launch.mutate(campaign.id)}>
                Launch
              </button>
            )}
            {canEdit && allowed.has('paused') && (
              <button className="btn-ghost" disabled={pause.isPending} onClick={() => pause.mutate(campaign.id)}>
                Pause
              </button>
            )}
            {canEdit && campaign.status === 'paused' && allowed.has('live') && (
              <button className="btn-ghost" disabled={resume.isPending} onClick={() => resume.mutate(campaign.id)}>
                Resume
              </button>
            )}
            {canEdit && allowed.has('completed') && (
              <button className="btn-ghost" disabled={complete.isPending} onClick={() => complete.mutate(campaign.id)}>
                Complete
              </button>
            )}
            {canEdit && allowed.has('archived') && (
              <button className="btn-ghost" disabled={archive.isPending} onClick={() => archive.mutate(campaign.id)}>
                Archive
              </button>
            )}
            {canEdit && allowed.has('cancelled') && (
              <button className="btn" onClick={() => setCancelOpen(true)}>
                Cancel
              </button>
            )}
            {campaign.status === 'pending_approval' &&
              (canApprove && !isProposer ? (
                <>
                  <button
                    className="btn-primary"
                    disabled={approve.isPending}
                    onClick={() => approve.mutate(undefined)}
                  >
                    Approve
                  </button>
                  <button className="btn" onClick={() => setRejectOpen(true)}>
                    Reject
                  </button>
                </>
              ) : canApprove && isProposer ? (
                <span className="text-2xs italic text-ink-500">Awaiting a second person&rsquo;s approval</span>
              ) : null)}
          </div>
        }
      />

      <Tabs
        tabs={[
          { key: 'summary', label: 'Summary' },
          { key: 'timeline', label: 'Timeline' },
          { key: 'spend', label: 'Spend' },
          { key: 'leads', label: 'Leads', count: campaign.leadCount },
          { key: 'events', label: 'Events' },
          { key: 'sends', label: 'Sends' },
          { key: 'approvals', label: 'Approvals', count: campaign.approvals.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'summary' && <SummaryTab campaignId={campaign.id} campaign={campaign} />}
      {tab === 'timeline' && <TimelineTab campaignId={campaign.id} />}
      {tab === 'spend' && <SpendTab campaignId={campaign.id} currency={campaign.currency} canEdit={canEdit} />}
      {tab === 'leads' && (
        <Card>
          {campaign.leadCount === 0 ? (
            <EmptyState
              message="No leads attributed to this campaign yet."
              hint="A lead is attributed when it is created with this campaign's UTM or touchpoints."
            />
          ) : (
            <p className="text-sm text-ink-200">
              <span className="text-2xl font-semibold tabular-nums">{campaign.leadCount}</span> leads attributed to this
              campaign.
            </p>
          )}
        </Card>
      )}
      {tab === 'events' && <EventsTab campaignId={campaign.id} />}
      {tab === 'sends' && <SendsTab campaignId={campaign.id} />}
      {tab === 'approvals' && <ApprovalsTab approvals={campaign.approvals} />}

      <RejectModal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onSubmit={(reason) => reject.mutateAsync(reason)}
      />
      <CancelModal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onSubmit={(reason) => cancel.mutateAsync(reason)}
      />
    </div>
  );
}

function SummaryTab({
  campaignId,
  campaign,
}: {
  campaignId: string;
  campaign: import('../../lib/marketingApi.js').CampaignDetailView;
}) {
  const { data: utm } = useCampaignUtm(campaignId);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Objective & targets">
        <dl>
          <Field label="Objective">{CAMPAIGN_OBJECTIVE_LABELS[campaign.objective]}</Field>
          <Field label="Channel mix">{campaign.channelMix.map((k) => CHANNEL_KEY_LABELS[k]).join(', ') || '—'}</Field>
          <Field label="Window">
            {date(campaign.startAt)} – {date(campaign.endAt)}
          </Field>
          <Field label="Target leads">{campaign.targetLeads ?? '—'}</Field>
          <Field label="Target enrolments">{campaign.targetEnrolments ?? '—'}</Field>
          <Field label="Target pipeline value">
            {campaign.targetPipelineValue !== null ? money(campaign.targetPipelineValue, campaign.currency) : '—'}
          </Field>
          <Field label="Actual leads">{campaign.leadCount}</Field>
          <Field label="Touchpoints">{campaign.touchpointCount}</Field>
        </dl>
      </Card>
      <Card title="Budget">
        <dl>
          <Field label="Planned">{money(campaign.budgetPlanned, campaign.currency)}</Field>
          <Field label="Committed">{money(campaign.budgetCommitted, campaign.currency)}</Field>
          <Field label="Actual">{money(campaign.budgetActual, campaign.currency)}</Field>
          <Field label="Approval">{campaign.approvalRequired ? 'Required' : 'Not required'}</Field>
          <Field label="Owner">{campaign.ownerName}</Field>
          <Field label="Approved by">{campaign.approvedByName ?? '—'}</Field>
        </dl>
      </Card>
      <Card title="UTM & links" className="lg:col-span-2">
        {!utm ? (
          <Loading label="Loading UTM links" />
        ) : (
          <div className="space-y-2">
            <dl>
              <Field label="utm_campaign">{utm.utmCampaign}</Field>
              <Field label="utm_source">{utm.utmSource}</Field>
              <Field label="utm_medium">{utm.utmMedium}</Field>
            </dl>
            {utm.links.length === 0 ? (
              <EmptyState message="No per-channel links generated yet." />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {utm.links.map((l) => (
                  <li key={l.channelKey} className="flex items-center gap-2 text-xs">
                    <span className="chip border-ink-700 bg-ink-850 text-ink-400">
                      {CHANNEL_KEY_LABELS[l.channelKey]}
                    </span>
                    <CopyableUrl url={l.url} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
      {campaign.contentBrief && (
        <Card title="Content brief" className="lg:col-span-2">
          <p className="whitespace-pre-wrap text-sm text-ink-200">{campaign.contentBrief}</p>
        </Card>
      )}
    </div>
  );
}

function CopyableUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="mono truncate text-left text-accent-soft hover:underline"
      title="Copy link"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? 'Copied' : url}
    </button>
  );
}

function TimelineTab({ campaignId }: { campaignId: string }) {
  const { data, isLoading, error } = useCampaignTimeline(campaignId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data || data.length === 0) {
    return (
      <Card>
        <EmptyState
          message="Nothing has happened on this campaign yet."
          hint="Touchpoints, sends and status changes appear here as they occur."
        />
      </Card>
    );
  }
  return (
    <Card bodyClassName="p-0">
      <ul className="divide-y divide-ink-800">
        {data.map((item, i) => (
          <li key={i} className="flex items-start justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-xs font-medium text-ink-200">{item.label}</p>
              <p className="text-2xs text-ink-500">{item.kind}</p>
            </div>
            <span className="whitespace-nowrap text-2xs text-ink-400">{dateTime(item.at)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SpendTab({ campaignId, currency, canEdit }: { campaignId: string; currency: string; canEdit: boolean }) {
  const { data, isLoading, error } = useSpends({ campaignId });
  const [recordOpen, setRecordOpen] = useState(false);
  const reconcile = useReconcileSpend();

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const items = data?.items ?? [];

  const spendColumns: ReadonlyArray<DataTableColumn<SpendView>> = [
    {
      id: 'date',
      header: 'Date',
      cell: (s) => date(s.spendDate),
      cellClassName: 'text-xs',
      sortValue: (s) => s.spendDate,
    },
    {
      id: 'channel',
      header: 'Channel',
      cell: (s) => CHANNEL_KEY_LABELS[s.channelKey],
      cellClassName: 'text-xs',
      sortValue: (s) => CHANNEL_KEY_LABELS[s.channelKey],
    },
    {
      id: 'vendor',
      header: 'Vendor',
      cell: (s) => s.vendorName ?? '—',
      cellClassName: 'text-xs',
      sortValue: (s) => s.vendorName,
    },
    {
      id: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (s) => money(s.amount, currency),
      cellClassName: 'text-xs',
      sortValue: (s) => s.amount,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (s) => (
        <>
          <StatusChip status={s.status} tone={s.status === 'reconciled' ? 'good' : 'neutral'} />
          {s.status === 'recorded' && canEdit && (
            <button
              className="ml-2 text-2xs text-accent-soft hover:underline"
              onClick={() => reconcile.mutate({ id: s.id, body: { transactionId: s.transactionId ?? undefined } })}
            >
              Reconcile
            </button>
          )}
        </>
      ),
    },
    {
      id: 'description',
      header: 'Description',
      cell: (s) => <span title={s.description}>{s.description}</span>,
      cellClassName: 'max-w-xs truncate text-xs text-ink-400',
    },
  ];

  return (
    <div>
      {canEdit && (
        <div className="mb-3 flex justify-end">
          <button className="btn-primary" onClick={() => setRecordOpen(true)}>
            Record spend
          </button>
        </div>
      )}
      <Card bodyClassName="p-0">
        <DataTable
          caption="Campaign spend"
          columns={spendColumns}
          rows={items}
          rowKey={(s) => s.id}
          emptyMessage="No spend recorded against this campaign yet."
        />
      </Card>
      <RecordSpendModal open={recordOpen} onClose={() => setRecordOpen(false)} campaignId={campaignId} />
    </div>
  );
}

function RecordSpendModal({ open, onClose, campaignId }: { open: boolean; onClose: () => void; campaignId: string }) {
  const [channelKey, setChannelKey] = useState<ChannelKey | ''>('');
  const [division, setDivision] = useState('');
  const [amount, setAmount] = useState('');
  const [spendDate, setSpendDate] = useState('');
  const [description, setDescription] = useState('');
  const createSpend = useCreateSpend();

  return (
    <CreateModal
      open={open}
      title="Record spend"
      submitLabel="Record it"
      onClose={onClose}
      invalidate={[
        ['mkt', 'spends'],
        ['mkt', 'campaign', campaignId],
      ]}
      onSubmit={() =>
        createSpend.mutateAsync({
          campaignId,
          channelKey: channelKey as ChannelKey,
          division,
          amount: Number(amount || 0),
          spendDate,
          description,
        })
      }
    >
      <Row>
        <SelectInput
          label="Channel"
          required
          value={channelKey}
          onChange={(v) => setChannelKey(v as ChannelKey)}
          placeholder="Choose a channel"
          options={CHANNEL_KEYS.map((k) => ({ value: k, label: CHANNEL_KEY_LABELS[k] }))}
        />
        <TextInput label="Date" type="date" required value={spendDate} onChange={setSpendDate} />
      </Row>
      <Row>
        <TextInput label="Amount" type="number" required value={amount} onChange={setAmount} />
        <TextInput label="Division" required value={division} onChange={setDivision} />
      </Row>
      <TextArea label="Description" required value={description} onChange={setDescription} />
    </CreateModal>
  );
}

const EVENT_COLUMNS: ReadonlyArray<DataTableColumn<MarketingEventView>> = [
  {
    id: 'name',
    header: 'Event',
    cell: (e) => e.name,
    cellClassName: 'text-xs font-medium text-ink-200',
    sortValue: (e) => e.name,
  },
  { id: 'status', header: 'Status', cell: (e) => <StatusChip status={e.status} />, sortValue: (e) => e.status },
  {
    id: 'when',
    header: 'When',
    cell: (e) => dateTime(e.startAt),
    cellClassName: 'text-xs text-ink-400',
    sortValue: (e) => e.startAt,
  },
  {
    id: 'registered',
    header: 'Registered',
    align: 'right',
    cell: (e) => e.registeredCount,
    cellClassName: 'text-xs',
    sortValue: (e) => e.registeredCount,
  },
];

function EventsTab({ campaignId }: { campaignId: string }) {
  const { data, isLoading, error } = useMarketingEvents({ campaignId });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const items = data?.items ?? [];
  return (
    <Card bodyClassName="p-0">
      <DataTable
        caption="Campaign events"
        columns={EVENT_COLUMNS}
        rows={items}
        rowKey={(e) => e.id}
        emptyMessage="No events are linked to this campaign."
      />
    </Card>
  );
}

const SEND_COLUMNS: ReadonlyArray<DataTableColumn<SendView>> = [
  {
    id: 'channel',
    header: 'Channel',
    cell: (s) => CHANNEL_KEY_LABELS[s.channelKey],
    cellClassName: 'text-xs',
    sortValue: (s) => CHANNEL_KEY_LABELS[s.channelKey],
  },
  { id: 'status', header: 'Status', cell: (s) => <StatusChip status={s.status} />, sortValue: (s) => s.status },
  {
    id: 'recipients',
    header: 'Recipients',
    align: 'right',
    cell: (s) => s.recipientCount,
    cellClassName: 'text-xs',
    sortValue: (s) => s.recipientCount,
  },
  {
    id: 'bounce',
    header: 'Bounce rate',
    align: 'right',
    cell: (s) => `${(s.bounceRate * 100).toFixed(1)}%`,
    cellClassName: 'text-xs',
    sortValue: (s) => s.bounceRate,
  },
  {
    id: 'sent',
    header: 'Sent',
    cell: (s) => (s.sentAt ? dateTime(s.sentAt) : '—'),
    cellClassName: 'text-xs text-ink-400',
    sortValue: (s) => s.sentAt,
  },
];

function SendsTab({ campaignId }: { campaignId: string }) {
  const { data, isLoading, error } = useSends({ campaignId });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const items = data?.items ?? [];
  return (
    <Card bodyClassName="p-0">
      <DataTable
        caption="Campaign sends"
        columns={SEND_COLUMNS}
        rows={items}
        rowKey={(s) => s.id}
        emptyMessage="No sends have gone out from this campaign."
      />
    </Card>
  );
}

const APPROVAL_COLUMNS: ReadonlyArray<DataTableColumn<CampaignApprovalView>> = [
  {
    id: 'requestedBy',
    header: 'Requested by',
    cell: (a) => a.requestedByName,
    cellClassName: 'text-xs',
    sortValue: (a) => a.requestedByName,
  },
  {
    id: 'decision',
    header: 'Decision',
    cell: (a) => (
      <StatusChip
        status={a.decision}
        tone={a.decision === 'approved' ? 'good' : a.decision === 'rejected' ? 'bad' : 'warn'}
      />
    ),
    sortValue: (a) => a.decision,
  },
  {
    id: 'decidedBy',
    header: 'Decided by',
    cell: (a) => a.decidedByName ?? '—',
    cellClassName: 'text-xs',
    sortValue: (a) => a.decidedByName,
  },
  {
    id: 'threshold',
    header: 'Threshold',
    align: 'right',
    cell: (a) => money(a.thresholdAmount),
    cellClassName: 'text-xs',
    sortValue: (a) => a.thresholdAmount,
  },
  {
    id: 'reason',
    header: 'Reason',
    cell: (a) => <span title={a.reason ?? ''}>{a.reason ?? '—'}</span>,
    cellClassName: 'max-w-xs truncate text-xs text-ink-400',
    sortValue: (a) => a.reason,
  },
  {
    id: 'when',
    header: 'When',
    cell: (a) => dateTime(a.createdAt),
    cellClassName: 'text-xs text-ink-400',
    sortValue: (a) => a.createdAt,
  },
];

function ApprovalsTab({ approvals }: { approvals: import('../../lib/marketingApi.js').CampaignApprovalView[] }) {
  return (
    <Card bodyClassName="p-0">
      <DataTable
        caption="Campaign approvals"
        columns={APPROVAL_COLUMNS}
        rows={approvals}
        rowKey={(a) => a.id}
        emptyMessage="No approval has been requested for this campaign."
      />
    </Card>
  );
}

function RejectModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  return (
    <CreateModal
      open={open}
      title="Reject campaign"
      submitLabel="Reject"
      onClose={onClose}
      onSubmit={() => onSubmit(reason)}
      onCreated={() => setReason('')}
    >
      <TextArea label="Reason" required value={reason} onChange={setReason} />
    </CreateModal>
  );
}

function CancelModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  return (
    <CreateModal
      open={open}
      title="Cancel campaign"
      submitLabel="Cancel campaign"
      onClose={onClose}
      onSubmit={() => onSubmit(reason)}
      onCreated={() => setReason('')}
    >
      <TextArea label="Reason" required value={reason} onChange={setReason} />
    </CreateModal>
  );
}
