/**
 * Social posts, laid out by week rather than as a flat list — a content
 * calendar is read as "what's going out this week", not as a table sorted by
 * id. Publishing is manual-mode only: no social adapter is wired up, so
 * "publish" here means recording that a post went out and where, honestly
 * labelled as such rather than pretending an integration exists.
 */

import { useMemo, useState } from 'react';
import {
  CHANNEL_KEYS,
  CHANNEL_KEY_LABELS,
  type ChannelKey,
  type SocialPostView,
} from '@kaizen/shared';
import { date, dateTime } from '../../lib/api.js';
import {
  useSocialPosts,
  useCreateSocialPost,
  usePublishSocialPost,
  useCancelSocialPost,
  useRecordSocialMetrics,
  useCampaigns,
  useAssets,
} from '../../lib/marketingApi.js';
import { Card, EmptyState, ErrorBox, Loading, Modal, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, Row, SelectInput, TextArea, TextInput, messageOf, NewButton } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay();
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}

function weekKey(iso: string): string {
  return startOfWeek(new Date(iso)).toISOString().slice(0, 10);
}

export function Social() {
  const { can } = useSession();
  const [composing, setComposing] = useState(false);
  const [publishing, setPublishing] = useState<SocialPostView | null>(null);
  const [metricsFor, setMetricsFor] = useState<SocialPostView | null>(null);
  const posts = useSocialPosts();
  const cancel = useCancelSocialPost();
  const [error, setError] = useState<string | null>(null);

  if (posts.isLoading) return <Loading />;
  if (posts.error) return <ErrorBox error={posts.error} />;
  const items = posts.data?.items ?? [];

  const weeks = useMemo(() => {
    const byWeek = new Map<string, SocialPostView[]>();
    for (const p of items) {
      const key = weekKey(p.scheduledAt);
      if (!byWeek.has(key)) byWeek.set(key, []);
      byWeek.get(key)!.push(p);
    }
    return [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [items]);

  return (
    <div>
      <PageHeader
        title="Social"
        subtitle="What's scheduled, by week. No social adapter is configured — publishing here records that a post went out and its URL, nothing is posted automatically."
        actions={can('marketing_assets:C') && <NewButton label="Compose" onClick={() => setComposing(true)} />}
      />

      {error && <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      {items.length === 0 ? (
        <Card><EmptyState message="Nothing scheduled." /></Card>
      ) : (
        <div className="space-y-5">
          {weeks.map(([wk, posts]) => (
            <Card key={wk} title={`Week of ${date(wk)}`} bodyClassName="p-0">
              <table className="table">
                <thead>
                  <tr><th>When</th><th>Channel</th><th>Body</th><th>Campaign</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {posts
                    .sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1))
                    .map((p) => (
                      <tr key={p.id}>
                        <td className="text-2xs text-ink-400">{dateTime(p.scheduledAt)}</td>
                        <td className="text-xs text-ink-300">{CHANNEL_KEY_LABELS[p.channelKey] ?? p.channelKey}</td>
                        <td className="max-w-sm truncate text-xs text-ink-200">{p.body}</td>
                        <td className="text-xs text-ink-300">{p.campaignName ?? '—'}</td>
                        <td><StatusChip status={p.status} tone={p.status === 'published' ? 'good' : p.status === 'failed' || p.status === 'cancelled' ? 'bad' : 'neutral'} /></td>
                        <td>
                          <div className="flex flex-wrap justify-end gap-1.5">
                            {can('marketing_assets:E') && (p.status === 'draft' || p.status === 'scheduled') && (
                              <>
                                <button className="btn-quiet btn-sm" onClick={() => setPublishing(p)}>Publish</button>
                                <button className="btn-quiet btn-sm" onClick={() => cancel.mutate(p.id, { onError: (e) => setError(messageOf(e)) })}>Cancel</button>
                              </>
                            )}
                            {can('marketing_assets:E') && p.status === 'published' && (
                              <button className="btn-quiet btn-sm" onClick={() => setMetricsFor(p)}>Metrics</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}

      <ComposeModal open={composing} onClose={() => setComposing(false)} />
      {publishing && <PublishModal post={publishing} onClose={() => setPublishing(null)} />}
      {metricsFor && <MetricsModal post={metricsFor} onClose={() => setMetricsFor(null)} />}
    </div>
  );
}

function ComposeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const campaigns = useCampaigns();
  const assets = useAssets({ status: 'approved' });
  const create = useCreateSocialPost();
  const [channelKey, setChannelKey] = useState<ChannelKey>('social_meta');
  const [campaignId, setCampaignId] = useState('');
  const [body, setBody] = useState('');
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState('');

  return (
    <CreateModal
      open={open}
      title="Compose a post"
      onClose={onClose}
      invalidate={[['mkt', 'social-posts']]}
      onSubmit={() =>
        create.mutateAsync({
          channelKey,
          campaignId: campaignId || undefined,
          body,
          assetIds: assetIds.length ? assetIds : undefined,
          scheduledAt: new Date(scheduledAt).toISOString(),
        })
      }
    >
      <Row>
        <SelectInput
          label="Channel"
          value={channelKey}
          onChange={(v) => setChannelKey(v as ChannelKey)}
          options={CHANNEL_KEYS.filter((c) => c.startsWith('social_')).map((c) => ({ value: c, label: CHANNEL_KEY_LABELS[c] }))}
        />
        <SelectInput label="Campaign" value={campaignId} onChange={setCampaignId} placeholder="No campaign" options={(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
      </Row>
      <TextArea label="Body" required value={body} onChange={setBody} rows={4} />
      <TextInput label="Scheduled for" type="date" required value={scheduledAt} onChange={setScheduledAt} />
      <div>
        <p className="label mb-1">Assets (approved only)</p>
        <div className="flex flex-wrap gap-1.5">
          {(assets.data?.items ?? []).length === 0 && <p className="text-2xs text-ink-500">No approved assets yet.</p>}
          {(assets.data?.items ?? []).map((a) => (
            <button
              type="button"
              key={a.id}
              onClick={() => setAssetIds((ids) => (ids.includes(a.id) ? ids.filter((i) => i !== a.id) : [...ids, a.id]))}
              className={`chip transition-colors ${assetIds.includes(a.id) ? 'border-accent/60 text-accent-soft' : 'border-ink-800 text-ink-500'}`}
            >
              {a.name}
            </button>
          ))}
        </div>
      </div>
    </CreateModal>
  );
}

function PublishModal({ post, onClose }: { post: SocialPostView; onClose: () => void }) {
  const publish = usePublishSocialPost();
  const [externalUrl, setExternalUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <CreateModal
      open
      title="Record this as published"
      submitLabel="Mark published"
      onClose={onClose}
      invalidate={[['mkt', 'social-posts']]}
      onSubmit={() => publish.mutateAsync({ id: post.id, externalUrl: externalUrl || undefined })}
    >
      {error && <p className="text-2xs text-band-critical">{error}</p>}
      <p className="text-2xs text-ink-500">
        No social adapter is configured for this channel — nothing is posted automatically. This records that the
        post went out, with a link to where it actually is.
      </p>
      <TextInput label="External URL" value={externalUrl} onChange={setExternalUrl} placeholder="https://…" hint="optional, but worth having" />
    </CreateModal>
  );
}

function MetricsModal({ post, onClose }: { post: SocialPostView; onClose: () => void }) {
  const record = useRecordSocialMetrics();
  const [likes, setLikes] = useState(String(post.metrics?.likes ?? ''));
  const [comments, setComments] = useState(String(post.metrics?.comments ?? ''));
  const [shares, setShares] = useState(String(post.metrics?.shares ?? ''));
  const [reach, setReach] = useState(String(post.metrics?.reach ?? ''));
  const [clicks, setClicks] = useState(String(post.metrics?.clicks ?? ''));

  return (
    <CreateModal
      open
      title="Record metrics"
      onClose={onClose}
      invalidate={[['mkt', 'social-posts']]}
      onSubmit={() =>
        record.mutateAsync({
          id: post.id,
          body: {
            likes: likes === '' ? undefined : Number(likes),
            comments: comments === '' ? undefined : Number(comments),
            shares: shares === '' ? undefined : Number(shares),
            reach: reach === '' ? undefined : Number(reach),
            clicks: clicks === '' ? undefined : Number(clicks),
          },
        })
      }
    >
      <Row>
        <TextInput label="Likes" type="number" value={likes} onChange={setLikes} />
        <TextInput label="Comments" type="number" value={comments} onChange={setComments} />
      </Row>
      <Row>
        <TextInput label="Shares" type="number" value={shares} onChange={setShares} />
        <TextInput label="Reach" type="number" value={reach} onChange={setReach} />
      </Row>
      <TextInput label="Clicks" type="number" value={clicks} onChange={setClicks} />
    </CreateModal>
  );
}
