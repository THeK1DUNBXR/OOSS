/**
 * Marketing settings — the channel registry, the six policy thresholds,
 * adapter status, the inbound webhook log, and the AI touchpoint roster with
 * a draft panel over `/ai/draft`.
 *
 * Every AI draft is unambiguously a draft: it carries the action id and tier
 * the server registered, and the copy says outright that nothing is sent or
 * changed. Nothing here that the viewer's grants would deny is rendered —
 * never a visible control that a click would only bounce off the server.
 */

import { useState } from 'react';
import {
  AI_TIER_BY_CODE,
  CHANNEL_KEYS,
  CHANNEL_KEY_LABELS,
  CHANNEL_KIND_LABELS,
  type ChannelKey,
  type ChannelKind,
} from '@kaizen/shared';
import { Card, EmptyState, ErrorBox, Field, Loading, Modal, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { Row, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';
import { dateTime, titleCase } from '../../lib/api.js';
import {
  useAdapterStatus,
  useAiTouchpoints,
  useChannels,
  useMarketingPolicy,
  useRequestAiDraft,
  useUpdateChannel,
  useUpdateMarketingPolicy,
  useWebhookLog,
  type AdapterStatusRow,
  type AiDraftResponse,
  type MarketingPolicy,
  type MarketingWebhookInboundView,
} from '../../lib/marketingApi.js';
import type { ChannelView } from '@kaizen/shared';

// The adapter registry (apps/api/src/domains/marketing/adapters/registry.ts)
// only implements email/sms/whatsapp; every other channel key resolves to
// the not-configured adapter under this same `MARKETING_<KIND>_ADAPTER`
// naming, so the env var name shown here is the exact one the API would
// name back in an EX-MKT-011 message.
const CHANNEL_ADAPTER_KIND: Record<ChannelKey, string> = {
  email: 'email',
  sms: 'sms',
  whatsapp: 'whatsapp',
  social_meta: 'social',
  social_linkedin: 'social',
  social_youtube: 'social',
  google_ads: 'ads',
  website: 'social',
  event: 'social',
  referral: 'social',
  partner: 'social',
  print: 'social',
  walk_in: 'social',
  phone: 'social',
  other: 'social',
};

function envVarFor(channelKey: ChannelKey): string {
  return `MARKETING_${CHANNEL_ADAPTER_KIND[channelKey].toUpperCase()}_ADAPTER`;
}

type SettingsTab = 'channels' | 'policy' | 'adapters' | 'webhooks' | 'ai';

export function MarketingSettings() {
  const { can } = useSession();
  const [tab, setTab] = useState<SettingsTab>('channels');
  const canEdit = can('marketing_settings:E');

  return (
    <div>
      <PageHeader title="Marketing settings" subtitle="Channels, policy thresholds, adapter status, inbound webhooks and the AI touchpoints working in this module." />

      <Tabs
        tabs={[
          { key: 'channels', label: 'Channels' },
          { key: 'policy', label: 'Policy' },
          { key: 'adapters', label: 'Adapters' },
          { key: 'webhooks', label: 'Webhooks' },
          { key: 'ai', label: 'AI' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'channels' && <ChannelsTab canEdit={canEdit} />}
      {tab === 'policy' && <PolicyTab canEdit={canEdit} />}
      {tab === 'adapters' && <AdaptersTab />}
      {tab === 'webhooks' && <WebhooksTab />}
      {tab === 'ai' && <AiTab canDraft={can('marketing_settings:V')} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

function ChannelsTab({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading, error } = useChannels();
  const [editing, setEditing] = useState<ChannelView | null>(null);

  if (error) return <ErrorBox error={error} />;

  const items = data?.items ?? [];

  return (
    <>
      <Card bodyClassName="p-0 overflow-x-auto">
        {isLoading ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyState message="No channels registered yet." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Kind</th>
                <th>Provider</th>
                <th>Active</th>
                <th>Sender IDs</th>
                <th>DLT entity</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <p className="text-xs font-medium text-ink-100">{c.label}</p>
                    <p className="mono">{c.key}</p>
                  </td>
                  <td className="text-2xs text-ink-400">{CHANNEL_KIND_LABELS[c.kind as ChannelKind] ?? titleCase(c.kind)}</td>
                  <td>
                    {c.configured ? (
                      <StatusChip status={c.providerAdapter ?? 'configured'} tone="good" />
                    ) : (
                      <span title={`Set ${envVarFor(c.key)} to configure this channel.`}>
                        <StatusChip status="Not configured" tone="warn" />
                      </span>
                    )}
                  </td>
                  <td>
                    <StatusChip status={c.active ? 'active' : 'inactive'} tone={c.active ? 'good' : 'neutral'} />
                  </td>
                  <td className="mono text-2xs">{c.senderIds.length ? c.senderIds.join(', ') : '—'}</td>
                  <td className="mono text-2xs">{c.dltEntityId ?? '—'}</td>
                  {canEdit && (
                    <td>
                      <button className="btn-ghost btn-sm" onClick={() => setEditing(c)}>
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing && <EditChannelModal channel={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function EditChannelModal({ channel, onClose }: { channel: ChannelView; onClose: () => void }) {
  const [label, setLabel] = useState(channel.label);
  const [active, setActive] = useState(channel.active);
  const [senderIds, setSenderIds] = useState(channel.senderIds.join(', '));
  const [dltEntityId, setDltEntityId] = useState(channel.dltEntityId ?? '');
  const [error, setError] = useState<string | null>(null);

  const update = useUpdateChannel(channel.id);

  const submit = () => {
    setError(null);
    update.mutate(
      {
        label,
        active,
        senderIds: senderIds.split(',').map((s) => s.trim()).filter(Boolean),
        dltEntityId: dltEntityId.trim() || null,
      },
      { onSuccess: onClose, onError: (e) => setError(messageOf(e)) },
    );
  };

  return (
    <Modal
      open
      title={`Edit ${channel.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <TextInput label="Label" value={label} onChange={setLabel} required />
        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 rounded border-ink-700 bg-ink-900" />
          Active
        </label>
        <TextInput label="Sender IDs" value={senderIds} onChange={setSenderIds} hint="Comma-separated" placeholder="e.g. KAIZEN, KZERP" />
        <TextInput label="DLT entity ID" value={dltEntityId} onChange={setDltEntityId} hint="For SMS/WhatsApp registered senders in India" />
        {!channel.configured && (
          <p className="text-2xs text-ink-500">
            This channel has no adapter configured — sends on it will stay in draft until{' '}
            <span className="mono">{envVarFor(channel.key)}</span> is set.
          </p>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

const POLICY_FIELDS: Array<{ key: keyof MarketingPolicy; label: string; hint: string; kind: 'money' | 'rate' | 'days' | 'hours' }> = [
  { key: 'campaignApprovalThreshold', label: 'Campaign approval threshold', hint: 'A campaign budgeted above this needs approval before it can be scheduled.', kind: 'money' },
  { key: 'sendApprovalThreshold', label: 'Send approval threshold', hint: 'A send to more recipients than this needs approval before it can go out.', kind: 'days' },
  { key: 'bounceAlertRate', label: 'Bounce alert rate', hint: 'A send bouncing above this rate raises EX-MKT-005. Enter as a fraction, e.g. 0.05 for 5%.', kind: 'rate' },
  { key: 'unsubscribeAlertRate', label: 'Unsubscribe alert rate', hint: 'A send with unsubscribes above this rate raises EX-MKT-006. Enter as a fraction, e.g. 0.02 for 2%.', kind: 'rate' },
  { key: 'staleCampaignDays', label: 'Stale campaign days', hint: 'A live campaign with no touchpoints for this many days raises EX-MKT-004.', kind: 'days' },
  { key: 'formConvertSlaHours', label: 'Form conversion SLA (hours)', hint: 'A form submission left unconverted past this many hours raises EX-MKT-007.', kind: 'hours' },
];

function PolicyTab({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading, error } = useMarketingPolicy();
  const [draft, setDraft] = useState<MarketingPolicy | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const update = useUpdateMarketingPolicy();

  const policy = draft ?? data ?? null;

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !policy) return <Loading />;

  const setField = (key: keyof MarketingPolicy, value: number) => setDraft({ ...policy, [key]: value });

  const submit = () => {
    if (!draft) return;
    setSaveError(null);
    update.mutate(draft, { onSuccess: () => setDraft(null), onError: (e) => setSaveError(messageOf(e)) });
  };

  return (
    <Card title="Policy thresholds" subtitle="Six numbers that decide when a campaign or send needs a human, and when an exception fires.">
      {saveError && <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{saveError}</p>}
      <Row>
        {POLICY_FIELDS.slice(0, 2).map((f) => (
          <TextInput
            key={f.key}
            label={f.label}
            type="number"
            value={String(policy[f.key])}
            onChange={(v) => setField(f.key, Number(v))}
            hint={f.hint}
          />
        ))}
      </Row>
      <Row>
        {POLICY_FIELDS.slice(2, 4).map((f) => (
          <TextInput
            key={f.key}
            label={f.label}
            type="number"
            value={String(policy[f.key])}
            onChange={(v) => setField(f.key, Number(v))}
            hint={f.hint}
          />
        ))}
      </Row>
      <Row>
        {POLICY_FIELDS.slice(4).map((f) => (
          <TextInput
            key={f.key}
            label={f.label}
            type="number"
            value={String(policy[f.key])}
            onChange={(v) => setField(f.key, Number(v))}
            hint={f.hint}
          />
        ))}
      </Row>

      {canEdit && (
        <div className="mt-4 flex justify-end gap-2">
          {draft && (
            <button className="btn" onClick={() => setDraft(null)}>
              Discard changes
            </button>
          )}
          <button className="btn-primary" onClick={submit} disabled={!draft || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save policy'}
          </button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function AdaptersTab() {
  const { data = [], isLoading, error } = useAdapterStatus();

  if (error) return <ErrorBox error={error} />;

  const rows = data as AdapterStatusRow[];

  return (
    <Card title="Adapter status" subtitle="Which provider is wired up behind each channel, right now." bodyClassName="p-0 overflow-x-auto">
      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState message="No adapters reported." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Provider</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.channelKey}>
                <td>{CHANNEL_KEY_LABELS[r.channelKey] ?? r.channelKey}</td>
                <td className="text-2xs text-ink-400">{r.provider ?? '—'}</td>
                <td>
                  {r.configured ? (
                    <StatusChip status="Configured" tone="good" />
                  ) : (
                    <span title={`Set ${envVarFor(r.channelKey)} to configure this channel.`}>
                      <StatusChip status="Not configured" tone="warn" />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function WebhooksTab() {
  const { data = [], isLoading, error } = useWebhookLog();
  const [viewing, setViewing] = useState<MarketingWebhookInboundView | null>(null);

  if (error) return <ErrorBox error={error} />;

  const rows = data as MarketingWebhookInboundView[];

  return (
    <>
      <Card title="Recent inbound webhooks" bodyClassName="p-0 overflow-x-auto">
        {isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState message="No inbound webhooks recorded yet." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Event</th>
                <th>Received</th>
                <th>Processed</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id}>
                  <td className="text-2xs text-ink-200">{titleCase(w.provider)}</td>
                  <td className="mono text-2xs">{w.eventKind}</td>
                  <td className="text-2xs text-ink-400">{dateTime(w.receivedAt)}</td>
                  <td className="text-2xs text-ink-400">{w.processedAt ? dateTime(w.processedAt) : '—'}</td>
                  <td>
                    <StatusChip status={w.status} tone={w.status === 'failed' || w.error ? 'bad' : w.status === 'processed' ? 'good' : 'neutral'} />
                  </td>
                  <td>
                    <button className="btn-ghost btn-sm" onClick={() => setViewing(w)}>
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={Boolean(viewing)} title="Webhook detail" onClose={() => setViewing(null)}>
        {viewing && (
          <div className="space-y-2">
            {viewing.error && <p className="text-sm text-band-critical">{viewing.error}</p>}
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-950 p-3 text-2xs text-ink-300">
              {JSON.stringify(viewing, null, 2)}
            </pre>
          </div>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

const DRAFT_KINDS: Array<{ value: 'campaign_brief' | 'copy' | 'subject_lines' | 'segment' | 'next_best_action'; label: string }> = [
  { value: 'campaign_brief', label: 'Campaign brief' },
  { value: 'copy', label: 'Message copy' },
  { value: 'subject_lines', label: 'Subject lines' },
  { value: 'segment', label: 'Segment definition' },
  { value: 'next_best_action', label: 'Next best action for a lead' },
];

function AiTab({ canDraft }: { canDraft: boolean }) {
  const { data = [], isLoading, error } = useAiTouchpoints();

  return (
    <div className="space-y-4">
      <Card title="AI touchpoints in Marketing" subtitle="Every place AI touches this module, and how much it is trusted to do on its own." bodyClassName="p-0 overflow-x-auto">
        {error ? (
          <ErrorBox error={error} />
        ) : isLoading ? (
          <Loading />
        ) : data.length === 0 ? (
          <EmptyState message="No AI touchpoints reported." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Touchpoint</th>
                <th>Tier</th>
              </tr>
            </thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.code}>
                  <td title={t.code} className="text-xs text-ink-200">
                    {t.label}
                  </td>
                  <td>
                    <span
                      className="chip border-ink-700 bg-ink-850 text-ink-300"
                      title={t.code}
                    >
                      {AI_TIER_BY_CODE[t.tier as keyof typeof AI_TIER_BY_CODE]?.label ?? titleCase(t.tier)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <p className="text-2xs text-ink-500">
        Lead score rules are configured under <a href="/marketing/forms" className="text-accent-soft hover:underline">Forms →</a>
      </p>

      {canDraft && <AiDraftPanel />}
    </div>
  );
}

function AiDraftPanel() {
  const [kind, setKind] = useState<(typeof DRAFT_KINDS)[number]['value']>('campaign_brief');
  const [division, setDivision] = useState('');
  const [channelKey, setChannelKey] = useState<ChannelKey | ''>('');
  const [notes, setNotes] = useState('');
  const [result, setResult] = useState<AiDraftResponse | null>(null);
  const draft = useRequestAiDraft();

  const submit = () => {
    setResult(null);
    const context: Record<string, unknown> = { notes: notes || undefined, division: division || undefined, channelKey: channelKey || undefined };
    draft.mutate(
      { kind, context },
      { onSuccess: (res) => setResult(res) },
    );
  };

  return (
    <Card title="AI draft" subtitle="Ask for a draft. Nothing is sent, changed, or scheduled — a human decides what happens to it next.">
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectInput label="Kind" value={kind} onChange={(v) => setKind(v as typeof kind)} options={DRAFT_KINDS} />
        <TextInput label="Division" value={division} onChange={setDivision} placeholder="e.g. education" hint="Optional" />
        <SelectInput
          label="Channel"
          value={channelKey}
          onChange={(v) => setChannelKey(v as ChannelKey)}
          placeholder="No particular channel"
          options={CHANNEL_KEYS.map((k) => ({ value: k, label: CHANNEL_KEY_LABELS[k] }))}
        />
      </div>
      <div className="mt-3">
        <TextArea label="Context" value={notes} onChange={setNotes} rows={3} placeholder="Objective, target audience, key points to include…" hint="Optional — a template heuristic fills in the rest" />
      </div>

      {draft.isError && <p className="mt-2 text-sm text-band-critical">{messageOf(draft.error)}</p>}

      <div className="mt-3 flex justify-end">
        <button className="btn-primary" onClick={submit} disabled={draft.isPending}>
          {draft.isPending ? 'Drafting…' : 'Request draft'}
        </button>
      </div>

      {result && (
        <div className="mt-4 rounded-md border border-accent/40 bg-accent/5 p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-accent-soft">Draft — nothing is sent or changed</p>
            <span className="chip border-ink-700 bg-ink-850 text-ink-400" title={`Action ${result.actionId}`}>
              {AI_TIER_BY_CODE[result.tier as keyof typeof AI_TIER_BY_CODE]?.label ?? titleCase(result.tier)}
            </span>
          </div>
          <p className="mb-2 text-2xs text-ink-500">
            Action <span className="mono">{result.actionId}</span>
          </p>
          {Array.isArray(result.draft) ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-200">
              {result.draft.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="whitespace-pre-wrap text-sm text-ink-200">{result.draft}</p>
          )}
        </div>
      )}
    </Card>
  );
}
