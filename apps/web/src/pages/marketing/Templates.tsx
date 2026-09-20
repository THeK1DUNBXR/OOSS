/**
 * Message templates — the copy a send or journey step actually sends.
 *
 * A template only ever moves along `TEMPLATE_TRANSITIONS` (MKT-MSG-001):
 * draft → pending review → approved → retired, with rejection sending it back
 * to draft. A WhatsApp template additionally needs its DLT template id and
 * WhatsApp template name before it can be approved (MKT-MSG-002) — the
 * fields are shown whenever the channel needs them, not hidden until later.
 */

import { useState } from 'react';
import {
  CHANNEL_KEYS,
  CHANNEL_KEY_LABELS,
  TEMPLATE_STATUSES,
  TEMPLATE_STATUS_LABELS,
  TEMPLATE_TRANSITIONS,
  type ChannelKey,
  type TemplateStatus,
  type TemplateView,
} from '@kaizen/shared';
import { dateTime } from '../../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  RecordCode,
  StatusChip,
} from '../../components/ui.js';
import { CreateModal, messageOf, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';
import {
  useApproveTemplate,
  useCreateTemplate,
  useMergeFields,
  usePreviewTemplate,
  useRejectTemplate,
  useRetireTemplate,
  useSubmitTemplate,
  useTemplate,
  useTemplates,
  useUpdateTemplate,
} from '../../lib/marketingApi.js';
import { useSession } from '../../lib/session.js';

const STATUS_TONE: Record<TemplateStatus, 'neutral' | 'good' | 'accent' | 'warn'> = {
  draft: 'neutral',
  pending_review: 'accent',
  approved: 'good',
  retired: 'warn',
};

/**
 * The View's fixed shape has no proposer field for a template (unlike
 * Sends, which carries `requestedById`). The self-dealing bar below reads
 * `createdById` defensively — the persisted model has it per the platform's
 * standard fields even though the current `@kaizen/shared` TemplateView does
 * not name it — so this degrades to "always show approve" if the field is
 * ever genuinely absent from a payload, rather than throwing.
 */
type TemplateRow = TemplateView & { createdById?: string | null };

export function Templates() {
  const { can } = useSession();
  const [channelKey, setChannelKey] = useState<ChannelKey | ''>('');
  const [status, setStatus] = useState<TemplateStatus | ''>('');
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, error } = useTemplates({ channelKey: channelKey || undefined, status: status || undefined });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Templates"
        subtitle="The copy sends and journey steps use. A template must be approved before anything can send it."
        actions={
          can('marketing_templates:C') && (
            <button className="btn-primary" onClick={() => setCreateOpen(true)}>
              New template
            </button>
          )
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <select className="input max-w-xs" value={channelKey} onChange={(e) => setChannelKey(e.target.value as ChannelKey | '')}>
          <option value="">Every channel</option>
          {CHANNEL_KEYS.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_KEY_LABELS[c]}
            </option>
          ))}
        </select>
        <select className="input max-w-xs" value={status} onChange={(e) => setStatus(e.target.value as TemplateStatus | '')}>
          <option value="">Every status</option>
          {TEMPLATE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TEMPLATE_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState message="No templates yet." hint="A send or journey step needs an approved template before it can go out." />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Channel</th>
                <th>Status</th>
                <th className="text-right">Version</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {(data.items as TemplateRow[]).map((t) => (
                <tr key={t.id} className="cursor-pointer" onClick={() => setOpenId(t.id)}>
                  <td>
                    <RecordCode code={t.recordCode} />
                  </td>
                  <td className="text-xs font-medium text-ink-100">{t.name}</td>
                  <td className="text-xs text-ink-300">{CHANNEL_KEY_LABELS[t.channelKey]}</td>
                  <td>
                    <StatusChip status={TEMPLATE_STATUS_LABELS[t.status]} tone={STATUS_TONE[t.status]} />
                  </td>
                  <td className="text-right tabular-nums text-xs">v{t.version}</td>
                  <td className="text-2xs text-ink-500">{dateTime(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <NewTemplate open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(id) => setOpenId(id)} />
      {openId && <TemplateDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function MergeFieldPalette({ onInsert }: { onInsert: (token: string) => void }) {
  const { data, isLoading } = useMergeFields();
  if (isLoading) return null;
  if (!data?.length) return <p className="text-2xs italic text-ink-500">No merge fields registered.</p>;
  return (
    <div className="flex flex-wrap gap-1">
      {data.map((f) => (
        <button
          key={f.key}
          type="button"
          className="chip border-accent/40 text-accent-soft hover:bg-accent/10"
          title={`e.g. ${f.example}`}
          onClick={() => onInsert(`{{${f.key}}}`)}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

function NewTemplate({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [channelKey, setChannelKey] = useState<ChannelKey | ''>('');
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [dltTemplateId, setDltTemplateId] = useState('');
  const [waTemplateName, setWaTemplateName] = useState('');
  const create = useCreateTemplate();

  const reset = () => {
    setChannelKey('');
    setName('');
    setSubject('');
    setBody('');
    setDltTemplateId('');
    setWaTemplateName('');
  };

  return (
    <CreateModal
      open={open}
      title="New template"
      submitLabel="Create draft"
      onClose={() => {
        reset();
        onClose();
      }}
      invalidate={[['mkt', 'templates']]}
      onCreated={(result) => {
        reset();
        const created = result as { id: string } | undefined;
        if (created?.id) onCreated(created.id);
      }}
      onSubmit={() =>
        create.mutateAsync({
          channelKey: channelKey as ChannelKey,
          name,
          subject: subject || undefined,
          body,
          dltTemplateId: dltTemplateId || undefined,
          waTemplateName: waTemplateName || undefined,
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
          options={CHANNEL_KEYS.map((c) => ({ value: c, label: CHANNEL_KEY_LABELS[c] }))}
        />
        <TextInput label="Name" required value={name} onChange={setName} />
      </Row>
      {channelKey === 'email' && <TextInput label="Subject" value={subject} onChange={setSubject} />}
      <div>
        <TextArea label="Body" required rows={6} value={body} onChange={setBody} placeholder="Use {{merge fields}} — pick from below" hint="{{merge}} syntax" />
        <div className="mt-1.5">
          <MergeFieldPalette onInsert={(tok) => setBody((b) => b + tok)} />
        </div>
      </div>
      {channelKey === 'sms' && <TextInput label="DLT template id" value={dltTemplateId} onChange={setDltTemplateId} hint="Required before approval" />}
      {channelKey === 'whatsapp' && (
        <Row>
          <TextInput label="DLT template id" value={dltTemplateId} onChange={setDltTemplateId} />
          <TextInput label="WhatsApp template name" value={waTemplateName} onChange={setWaTemplateName} hint="Required before approval" />
        </Row>
      )}
    </CreateModal>
  );
}

function TemplateDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { user, can } = useSession();
  const { data, isLoading, error } = useTemplate(id);
  const [banner, setBanner] = useState<string | null>(null);
  const [previewPersonId, setPreviewPersonId] = useState('');
  const [previewResult, setPreviewResult] = useState<{ subject: string | null; body: string; missing: string[] } | null>(null);
  const [editBody, setEditBody] = useState<string | null>(null);

  const update = useUpdateTemplate(id);
  const submit = useSubmitTemplate();
  const approve = useApproveTemplate();
  const reject = useRejectTemplate();
  const retire = useRetireTemplate();
  const preview = usePreviewTemplate();

  if (isLoading) {
    return (
      <Modal open title="Template" onClose={onClose}>
        <Loading />
      </Modal>
    );
  }
  const t = data as TemplateRow | undefined;
  if (error || !t) {
    return (
      <Modal open title="Template" onClose={onClose}>
        <ErrorBox error={error ?? new Error('Not found')} />
      </Modal>
    );
  }

  const nextStates = TEMPLATE_TRANSITIONS[t.status];
  const isOwnProposal = Boolean(user && t.createdById && t.createdById === user.personId);
  const canApprove = can('marketing_templates:approve');
  const bodyToShow = editBody ?? t.body;
  const dirty = editBody !== null && editBody !== t.body;

  return (
    <Modal open title={t.name} onClose={onClose} width="max-w-3xl">
      <div className="space-y-4">
        {banner && (
          <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{banner}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={TEMPLATE_STATUS_LABELS[t.status]} tone={STATUS_TONE[t.status]} />
          <span className="chip border-ink-700 text-ink-400">{CHANNEL_KEY_LABELS[t.channelKey]}</span>
          <span className="chip border-ink-700 text-ink-400">v{t.version}</span>
          {t.approvedByName && <span className="text-2xs text-ink-500">approved by {t.approvedByName}</span>}
        </div>

        {t.status === 'pending_review' && (
          isOwnProposal ? (
            <p className="rounded-md border border-band-watch/40 bg-band-watch/10 px-3 py-2 text-xs italic text-band-watch">
              Awaiting a second person's review — you proposed this template, so you cannot approve it.
            </p>
          ) : (
            !canApprove && <p className="text-2xs italic text-ink-500">Awaiting review from someone with approval rights.</p>
          )
        )}

        <dl>
          {t.subject !== null && <Field label="Subject">{t.subject}</Field>}
          {t.dltTemplateId && <Field label="DLT template id">{t.dltTemplateId}</Field>}
          {t.waTemplateName && <Field label="WhatsApp template name">{t.waTemplateName}</Field>}
        </dl>

        <div>
          <span className="label">Body</span>
          <textarea
            className="input"
            rows={6}
            value={bodyToShow}
            disabled={t.status !== 'draft' || !can('marketing_templates:E')}
            onChange={(e) => setEditBody(e.target.value)}
          />
          {t.status === 'draft' && can('marketing_templates:E') && (
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
              <MergeFieldPalette onInsert={(tok) => setEditBody((b) => (b ?? t.body) + tok)} />
              {dirty && (
                <button
                  className="btn-ghost text-2xs"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate(
                      { body: bodyToShow },
                      { onSuccess: () => setEditBody(null), onError: (e) => setBanner(messageOf(e)) },
                    )
                  }
                >
                  {update.isPending ? 'Saving…' : 'Save body'}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-ink-800 pt-3">
          {t.status === 'draft' && can('marketing_templates:E') && nextStates.includes('pending_review') && (
            <button className="btn-primary" disabled={submit.isPending} onClick={() => submit.mutate(t.id, { onError: (e) => setBanner(messageOf(e)) })}>
              Submit for review
            </button>
          )}
          {t.status === 'pending_review' && canApprove && !isOwnProposal && (
            <>
              <button className="btn-primary" disabled={approve.isPending} onClick={() => approve.mutate(t.id, { onError: (e) => setBanner(messageOf(e)) })}>
                Approve
              </button>
              <button
                className="btn-ghost text-band-critical"
                disabled={reject.isPending}
                onClick={() => {
                  const reason = prompt('Reason for rejecting this template?');
                  if (reason) reject.mutate({ id: t.id, reason }, { onError: (e) => setBanner(messageOf(e)) });
                }}
              >
                Reject (back to draft)
              </button>
            </>
          )}
          {t.status === 'approved' && can('marketing_templates:E') && nextStates.includes('retired') && (
            <button className="btn-ghost text-band-critical" disabled={retire.isPending} onClick={() => retire.mutate(t.id, { onError: (e) => setBanner(messageOf(e)) })}>
              Retire
            </button>
          )}
        </div>

        <Card title="Preview" subtitle="Renders the merge fields against a real person, and names any that are still missing.">
          <div className="flex flex-wrap items-end gap-2">
            <TextInput label="Person id (optional)" value={previewPersonId} onChange={setPreviewPersonId} placeholder="Leave blank for placeholders" />
            <button
              className="btn-ghost"
              disabled={preview.isPending}
              onClick={() =>
                preview.mutate(
                  { id: t.id, personId: previewPersonId || undefined },
                  { onSuccess: (r) => setPreviewResult(r), onError: (e) => setBanner(messageOf(e)) },
                )
              }
            >
              {preview.isPending ? 'Rendering…' : 'Preview'}
            </button>
          </div>
          {previewResult && (
            <div className="mt-3 space-y-2 rounded-md border border-ink-800 bg-ink-950 p-3">
              {previewResult.subject && <p className="text-xs font-medium text-ink-100">{previewResult.subject}</p>}
              <p className="whitespace-pre-wrap text-xs text-ink-300">{previewResult.body}</p>
              {previewResult.missing.length > 0 && (
                <p className="text-2xs text-band-watch">
                  Missing: {previewResult.missing.map((m) => `{{${m}}}`).join(', ')}
                </p>
              )}
            </div>
          )}
        </Card>
      </div>
    </Modal>
  );
}
