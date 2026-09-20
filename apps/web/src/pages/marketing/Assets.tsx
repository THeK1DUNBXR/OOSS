/**
 * The content library — brochures, creatives, decks, copy — and the claims
 * register beside it, because a claim (an ASCI/brand-compliance statement)
 * governs what an asset is allowed to say and the two are reviewed together.
 *
 * The self-dealing bar on approval is enforced server-side; the View shapes
 * this screen reads carry no proposer id to check client-side, so the
 * approve button is shown to anyone holding the grant and a self-approval
 * attempt surfaces as the server's own refusal message rather than being
 * silently hidden here.
 */

import { useState } from 'react';
import {
  ASSET_KINDS,
  ASSET_KIND_LABELS,
  ASSET_TRANSITIONS,
  type AssetKind,
  type AssetView,
} from '@kaizen/shared';
import { date, titleCase } from '../../lib/api.js';
import {
  useAssets,
  useCreateAsset,
  useUpdateAsset,
  useSubmitAsset,
  useApproveAsset,
  useRejectAsset,
  useRetireAsset,
  useClaims,
  useCreateClaim,
  useApproveClaim,
  useRejectClaim,
  useRetireClaim,
  useCampaigns,
} from '../../lib/marketingApi.js';
import { Card, EmptyState, ErrorBox, Field, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, Row, SelectInput, TextArea, TextInput, messageOf, NewButton } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';

type AssetsTab = 'assets' | 'claims';

export function Assets() {
  const { can } = useSession();
  const [tab, setTab] = useState<AssetsTab>('assets');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AssetView | null>(null);

  return (
    <div>
      <PageHeader
        title="Assets"
        subtitle="The content library, and the claims register that governs what it's allowed to say."
        actions={
          can('marketing_assets:C') &&
          (tab === 'assets' ? (
            <NewButton label="New asset" onClick={() => setCreating(true)} />
          ) : null)
        }
      />

      <Tabs tabs={[{ key: 'assets', label: 'Assets' }, { key: 'claims', label: 'Claims register' }]} active={tab} onChange={setTab} />

      {tab === 'assets' ? <AssetsList onEdit={setEditing} /> : <ClaimsRegister />}

      <AssetModal open={creating} onClose={() => setCreating(false)} />
      <AssetModal open={Boolean(editing)} asset={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function AssetsList({ onEdit }: { onEdit: (a: AssetView) => void }) {
  const { can } = useSession();
  const [kindFilter, setKindFilter] = useState<AssetKind | ''>('');
  const [statusFilter, setStatusFilter] = useState('');
  const assets = useAssets({ kind: kindFilter || undefined, status: statusFilter || undefined });
  const submit = useSubmitAsset();
  const approve = useApproveAsset();
  const reject = useRejectAsset();
  const retire = useRetireAsset();
  const [error, setError] = useState<string | null>(null);

  if (assets.isLoading) return <Loading />;
  if (assets.error) return <ErrorBox error={assets.error} />;
  const items = assets.data?.items ?? [];

  return (
    <div>
      <Row>
        <SelectInput label="Kind" value={kindFilter} onChange={(v) => setKindFilter(v as AssetKind)} placeholder="All kinds" options={ASSET_KINDS.map((k) => ({ value: k, label: ASSET_KIND_LABELS[k] }))} />
        <SelectInput label="Status" value={statusFilter} onChange={setStatusFilter} placeholder="All statuses" options={['draft', 'in_review', 'approved', 'retired'].map((s) => ({ value: s, label: titleCase(s) }))} />
      </Row>

      {error && <p className="my-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      {items.length === 0 ? (
        <Card className="mt-4"><EmptyState message="No assets match." hint="Only approved assets may be used in a send or social post." /></Card>
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((a) => {
            const next = ASSET_TRANSITIONS[a.status] ?? [];
            const expiringSoon = a.expiresAt && !a.expired && new Date(a.expiresAt).getTime() - Date.now() < 1000 * 60 * 60 * 24 * 30;
            return (
              <Card
                key={a.id}
                title={a.name}
                subtitle={<span className="mono">{a.recordCode} · v{a.version}</span>}
                actions={<StatusChip status={a.status} tone={a.status === 'approved' ? 'good' : a.status === 'retired' ? 'neutral' : 'neutral'} />}
              >
                <dl className="grid grid-cols-2 gap-x-4">
                  <Field label="Kind">{ASSET_KIND_LABELS[a.kind]}</Field>
                  <Field label="Campaign">{a.campaignName ?? '—'}</Field>
                  <Field label="Usage rights">{a.usageRights ?? '—'}</Field>
                  <Field label="Expires">
                    {a.expired ? (
                      <span className="text-band-critical">expired {date(a.expiresAt)}</span>
                    ) : expiringSoon ? (
                      <span className="text-band-watch">{date(a.expiresAt)} — soon</span>
                    ) : (
                      date(a.expiresAt)
                    )}
                  </Field>
                </dl>
                {a.url && (
                  <a href={a.url} target="_blank" rel="noreferrer" className="mt-2 block truncate text-2xs text-accent-soft hover:underline">
                    {a.url}
                  </a>
                )}
                {a.expired && a.status === 'approved' && (
                  <p className="mt-2 rounded bg-band-critical/10 px-2 py-1 text-2xs text-band-critical">
                    Usage rights have expired — using this asset now is a compliance risk.
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-ink-800 pt-3">
                  {can('marketing_assets:E') && (a.status === 'draft' || a.status === 'in_review') && (
                    <button className="btn-quiet btn-sm" onClick={() => onEdit(a)}>Edit</button>
                  )}
                  {can('marketing_assets:E') && next.includes('in_review') && (
                    <button className="btn-quiet btn-sm" onClick={() => submit.mutate(a.id, { onError: (e) => setError(messageOf(e)) })}>Submit for review</button>
                  )}
                  {can('marketing_assets:approve') && next.includes('approved') && (
                    <button className="btn-quiet btn-sm" onClick={() => approve.mutate(a.id, { onError: (e) => setError(messageOf(e)) })}>Approve</button>
                  )}
                  {can('marketing_assets:approve') && a.status === 'in_review' && (
                    <button
                      className="btn-quiet btn-sm"
                      onClick={() => {
                        const reason = prompt('Reason for rejecting this asset?');
                        if (reason) reject.mutate({ id: a.id, reason }, { onError: (e) => setError(messageOf(e)) });
                      }}
                    >
                      Reject
                    </button>
                  )}
                  {can('marketing_assets:E') && next.includes('retired') && (
                    <button className="btn-quiet btn-sm" onClick={() => retire.mutate(a.id, { onError: (e) => setError(messageOf(e)) })}>Retire</button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssetModal({ open, asset, onClose }: { open: boolean; asset?: AssetView | null; onClose: () => void }) {
  const editing = Boolean(asset);
  const campaigns = useCampaigns();
  const create = useCreateAsset();
  const update = useUpdateAsset(asset?.id ?? '');
  const [name, setName] = useState(asset?.name ?? '');
  const [kind, setKind] = useState<AssetKind>(asset?.kind ?? 'brochure');
  const [url, setUrl] = useState(asset?.url ?? '');
  const [campaignId, setCampaignId] = useState(asset?.campaignId ?? '');
  const [usageRights, setUsageRights] = useState(asset?.usageRights ?? '');
  const [expiresAt, setExpiresAt] = useState(asset?.expiresAt?.slice(0, 10) ?? '');
  const [tags, setTags] = useState((asset?.tags ?? []).join(', '));

  if (!open) return null;

  const body = () => ({
    name,
    kind,
    url: url || undefined,
    campaignId: campaignId || undefined,
    usageRights: usageRights || undefined,
    expiresAt: expiresAt || undefined,
    tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
  });

  return (
    <CreateModal
      open={open}
      title={editing ? `Edit ${asset!.name}` : 'New asset'}
      submitLabel={editing ? 'Save' : 'Create'}
      onClose={onClose}
      invalidate={[['mkt', 'assets']]}
      onSubmit={() => (editing ? update.mutateAsync(body()) : create.mutateAsync(body()))}
    >
      <TextInput label="Name" required value={name} onChange={setName} />
      <Row>
        <SelectInput label="Kind" value={kind} onChange={(v) => setKind(v as AssetKind)} options={ASSET_KINDS.map((k) => ({ value: k, label: ASSET_KIND_LABELS[k] }))} />
        <SelectInput label="Campaign" value={campaignId} onChange={setCampaignId} placeholder="No campaign" options={(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
      </Row>
      <TextInput label="URL" value={url} onChange={setUrl} placeholder="https://…" />
      <Row>
        <TextInput label="Usage rights" value={usageRights} onChange={setUsageRights} placeholder="Web and print, India, 12 months" />
        <TextInput label="Expires" type="date" value={expiresAt} onChange={setExpiresAt} />
      </Row>
      <TextInput label="Tags" value={tags} onChange={setTags} placeholder="brochure, festival-offer" />
    </CreateModal>
  );
}

function ClaimsRegister() {
  const { can } = useSession();
  const claims = useClaims();
  const create = useCreateClaim();
  const approve = useApproveClaim();
  const reject = useRejectClaim();
  const retire = useRetireClaim();
  const [creating, setCreating] = useState(false);
  const [text, setText] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (claims.isLoading) return <Loading />;
  if (claims.error) return <ErrorBox error={claims.error} />;
  const items = claims.data?.items ?? [];

  return (
    <div>
      <div className="mb-4 flex justify-end">
        {can('marketing_assets:C') && <NewButton label="Propose a claim" onClick={() => setCreating(true)} />}
      </div>
      {error && <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
      {items.length === 0 ? (
        <Card><EmptyState message="No claims proposed yet." hint="Only approved claims may be printed or published." /></Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead><tr><th>Claim</th><th>Evidence</th><th>Status</th><th /></tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td className="max-w-md text-xs text-ink-100">{c.text}</td>
                  <td className="text-2xs text-ink-400">{c.evidenceRef || '—'}</td>
                  <td><StatusChip status={c.status} tone={c.status === 'approved' ? 'good' : c.status === 'rejected' ? 'bad' : 'neutral'} /></td>
                  <td>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {can('marketing_assets:approve') && c.status === 'proposed' && (
                        <>
                          <button className="btn-quiet btn-sm" onClick={() => approve.mutate(c.id, { onError: (e) => setError(messageOf(e)) })}>Approve</button>
                          <button
                            className="btn-quiet btn-sm"
                            onClick={() => {
                              const reason = prompt('Reason for rejecting this claim?');
                              if (reason) reject.mutate({ id: c.id, reason }, { onError: (e) => setError(messageOf(e)) });
                            }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {can('marketing_assets:E') && c.status === 'approved' && (
                        <button className="btn-quiet btn-sm" onClick={() => retire.mutate(c.id, { onError: (e) => setError(messageOf(e)) })}>Retire</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <CreateModal
        open={creating}
        title="Propose a claim"
        onClose={() => setCreating(false)}
        invalidate={[]}
        onSubmit={() => create.mutateAsync({ text, evidenceRef: evidenceRef || undefined })}
      >
        <TextArea label="Claim text" required value={text} onChange={setText} rows={3} placeholder="'India's #1 full stack bootcamp'" />
        <TextInput label="Evidence reference" value={evidenceRef} onChange={setEvidenceRef} placeholder="a report, survey, or ranking" />
      </CreateModal>
    </div>
  );
}
