/**
 * Forms — capture forms, their submissions, the touchpoint log, lead-score
 * rules, and short links. Five tabs, one screen, because they are read
 * together: a form's conversion rate is only meaningful next to its
 * submissions, and a score rule is only meaningful next to the touchpoints
 * it fires on.
 *
 * No QR-code renderer here — a hand-rolled encoder was more code than this
 * screen's share of the module justifies. The public URL is shown large,
 * monospace, and one click from the clipboard instead, which is what anyone
 * printing a poster actually needs.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AUDIENCE_RULE_OPS,
  FORM_SUBMISSION_STATUSES,
  FORM_SUBMISSION_STATUS_LABELS,
  TOUCH_KINDS,
  TOUCH_KIND_LABELS,
  VERTICALS,
  VERTICAL_LABELS,
  CHANNEL_KEYS,
  CHANNEL_KEY_LABELS,
  type AudienceRuleOp,
  type ChannelKey,
  type FormSubmissionStatus,
  type FormView,
} from '@kaizen/shared';
import { date, dateTime, titleCase } from '../../lib/api.js';
import {
  useForms,
  useForm,
  useCreateForm,
  useUpdateForm,
  usePublishForm,
  useUnpublishForm,
  useRotateFormToken,
  useFormEmbed,
  useFormSubmissions,
  useConvertSubmission,
  useRejectSubmission,
  useMarkSubmissionSpam,
  useTouchpoints,
  useScoreRules,
  useCreateScoreRule,
  useUpdateScoreRule,
  useDeleteScoreRule,
  usePreviewScoreRules,
  useApplyScoreRules,
  useLinks,
  useCreateLink,
  useCampaigns,
  mk,
} from '../../lib/marketingApi.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Metric,
  Modal,
  PageHeader,
  StatusChip,
  Tabs,
} from '../../components/ui.js';
import { CreateModal, MoneyInput as _MoneyInput, Row, SelectInput, TextArea, TextInput, messageOf, NewButton } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';

type FormTab = 'forms' | 'submissions' | 'touchpoints' | 'scoreRules' | 'links';

type FieldSpec = { key: string; label: string; type: string; required: boolean; options: string };

function copyToClipboard(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {
    /* clipboard denied — the field can still be selected and copied by hand */
  });
}

export function Forms() {
  const { can } = useSession();
  const [tab, setTab] = useState<FormTab>('forms');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FormView | null>(null);
  const [embedFor, setEmbedFor] = useState<FormView | null>(null);

  const forms = useForms();

  return (
    <div>
      <PageHeader
        title="Forms"
        subtitle="Capture forms, what they've collected, and the rules that score it."
        actions={can('marketing_forms:C') && tab === 'forms' && <NewButton label="New form" onClick={() => setCreating(true)} />}
      />

      <Tabs
        tabs={[
          { key: 'forms', label: 'Forms', count: forms.data?.total },
          { key: 'submissions', label: 'Submissions' },
          { key: 'touchpoints', label: 'Touchpoints' },
          { key: 'scoreRules', label: 'Score rules' },
          { key: 'links', label: 'Short links' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'forms' && (
        <FormsTab
          onEdit={setEditing}
          onEmbed={setEmbedFor}
        />
      )}
      {tab === 'submissions' && <SubmissionsTab />}
      {tab === 'touchpoints' && <TouchpointsTab />}
      {tab === 'scoreRules' && <ScoreRulesTab />}
      {tab === 'links' && <LinksTab />}

      <FormBuilderModal open={creating} onClose={() => setCreating(false)} />
      <FormBuilderModal open={Boolean(editing)} form={editing} onClose={() => setEditing(null)} />
      {embedFor && <EmbedModal form={embedFor} onClose={() => setEmbedFor(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms list
// ---------------------------------------------------------------------------

function FormsTab({ onEdit, onEmbed }: { onEdit: (f: FormView) => void; onEmbed: (f: FormView) => void }) {
  const { can } = useSession();
  const forms = useForms();
  const publish = usePublishForm();
  const unpublish = useUnpublishForm();
  const rotate = useRotateFormToken();
  const [error, setError] = useState<string | null>(null);

  if (forms.isLoading) return <Loading />;
  if (forms.error) return <ErrorBox error={forms.error} />;
  const items = forms.data?.items ?? [];

  return (
    <Card bodyClassName={items.length ? 'p-0 overflow-x-auto' : 'p-4'}>
      {error && (
        <p className="m-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>
      )}
      {items.length === 0 ? (
        <EmptyState message="No forms yet." hint="A form captures a submission, which becomes a lead once converted." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Vertical</th>
              <th className="text-right">Submissions</th>
              <th className="text-right">Conversion</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((f) => (
              <tr key={f.id}>
                <td className="text-xs font-medium text-ink-100">{f.name}</td>
                <td className="mono text-2xs text-ink-400">{f.slug}</td>
                <td className="text-xs text-ink-300">{titleCase(f.vertical)}</td>
                <td className="text-right tabular-nums text-xs">{f.submissionCount}</td>
                <td className="text-right tabular-nums text-xs">—</td>
                <td>
                  <StatusChip status={f.active ? 'published' : 'unpublished'} tone={f.active ? 'good' : 'neutral'} />
                </td>
                <td>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {can('marketing_forms:E') && (
                      <button className="btn-quiet btn-sm" onClick={() => onEdit(f)}>
                        Edit
                      </button>
                    )}
                    <button className="btn-quiet btn-sm" onClick={() => onEmbed(f)}>
                      Embed
                    </button>
                    {can('marketing_forms:E') &&
                      (f.active ? (
                        <button
                          className="btn-quiet btn-sm"
                          onClick={() => unpublish.mutate(f.id, { onError: (e) => setError(messageOf(e)) })}
                          disabled={unpublish.isPending}
                        >
                          Unpublish
                        </button>
                      ) : (
                        <button
                          className="btn-quiet btn-sm"
                          onClick={() => publish.mutate(f.id, { onError: (e) => setError(messageOf(e)) })}
                          disabled={publish.isPending}
                        >
                          Publish
                        </button>
                      ))}
                    {can('marketing_forms:E') && (
                      <button
                        className="btn-quiet btn-sm"
                        onClick={() => {
                          if (confirm('Rotate this form\'s public token? The old embed URL stops working immediately.')) {
                            rotate.mutate(f.id, { onError: (e) => setError(messageOf(e)) });
                          }
                        }}
                        disabled={rotate.isPending}
                      >
                        Rotate token
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function EmbedModal({ form, onClose }: { form: FormView; onClose: () => void }) {
  const embed = useFormEmbed(form.id);
  return (
    <Modal open title={`Embed — ${form.name}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {embed.isLoading ? (
        <Loading />
      ) : embed.error ? (
        <ErrorBox error={embed.error} />
      ) : (
        <div className="space-y-4">
          <div>
            <p className="label mb-1">Public URL</p>
            <div className="flex items-center gap-2">
              <input className="input mono" readOnly value={embed.data?.publicUrl ?? ''} onFocus={(e) => e.target.select()} />
              <button className="btn-quiet btn-sm shrink-0" onClick={() => copyToClipboard(embed.data?.publicUrl ?? '')}>
                Copy
              </button>
            </div>
          </div>
          <div>
            <p className="label mb-1">Embed snippet</p>
            <div className="flex items-start gap-2">
              <textarea className="input mono" rows={4} readOnly value={embed.data?.embedSnippet ?? ''} />
              <button className="btn-quiet btn-sm shrink-0" onClick={() => copyToClipboard(embed.data?.embedSnippet ?? '')}>
                Copy
              </button>
            </div>
          </div>
          <p className="text-2xs text-ink-500">
            No QR code is rendered here — a scannable code for this URL can be generated with any QR tool. The link
            above is what it would encode.
          </p>
        </div>
      )}
    </Modal>
  );
}

function FormBuilderModal({ open, form, onClose }: { open: boolean; form?: FormView | null; onClose: () => void }) {
  const editing = Boolean(form);
  const [name, setName] = useState(form?.name ?? '');
  const [slug, setSlug] = useState(form?.slug ?? '');
  const [vertical, setVertical] = useState(form?.vertical ?? 'sap_enterprise');
  const [defaultCampaignId, setDefaultCampaignId] = useState(form?.defaultCampaignId ?? '');
  const [thankYouMessage, setThankYouMessage] = useState(form?.thankYouMessage ?? 'Thanks — we will be in touch.');
  const [fields, setFields] = useState<FieldSpec[]>(
    Array.isArray(form?.fields)
      ? (form!.fields as any[]).map((f) => ({
          key: f.key ?? '',
          label: f.label ?? '',
          type: f.type ?? 'text',
          required: Boolean(f.required),
          options: Array.isArray(f.options) ? f.options.join(', ') : '',
        }))
      : [{ key: 'fullName', label: 'Full name', type: 'text', required: true, options: '' }],
  );

  const campaigns = useCampaigns();
  const create = useCreateForm();
  const update = useUpdateForm(form?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const body = () => ({
    name,
    slug: slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
    vertical,
    defaultCampaignId: defaultCampaignId || undefined,
    thankYouMessage,
    fields: fields
      .filter((f) => f.key.trim() && f.label.trim())
      .map((f) => ({
        key: f.key.trim(),
        label: f.label.trim(),
        type: f.type,
        required: f.required,
        options: f.options.trim() ? f.options.split(',').map((o) => o.trim()).filter(Boolean) : undefined,
      })),
  });

  const submit = () => {
    setError(null);
    const mutation = editing ? update.mutate(body(), { onSuccess: onClose, onError: (e) => setError(messageOf(e)) }) : undefined;
    if (!editing) create.mutate(body(), { onSuccess: onClose, onError: (e) => setError(messageOf(e)) });
    void mutation;
  };

  const pending = create.isPending || update.isPending;

  return (
    <Modal
      open={open}
      title={editing ? `Edit ${form!.name}` : 'New form'}
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!name || pending} onClick={submit}>
            {pending ? 'Saving…' : editing ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
        <Row>
          <TextInput label="Name" required value={name} onChange={setName} placeholder="Enquire — full stack batch" />
          <TextInput label="Slug" hint="made from the name if blank" value={slug} onChange={setSlug} placeholder="enquire-full-stack" />
        </Row>
        <Row>
          <SelectInput
            label="Vertical"
            value={vertical as any}
            onChange={setVertical}
            options={VERTICALS.map((v) => ({ value: v, label: VERTICAL_LABELS[v] }))}
          />
          <SelectInput
            label="Default campaign"
            value={defaultCampaignId}
            onChange={setDefaultCampaignId}
            placeholder="No default"
            options={(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.recordCode} — ${c.name}` }))}
          />
        </Row>
        <TextArea label="Thank-you message" value={thankYouMessage} onChange={setThankYouMessage} rows={2} />

        <div className="border-t border-ink-800 pt-3">
          <p className="label mb-2">Fields</p>
          {fields.map((f, i) => (
            <div key={i} className="mb-2 grid grid-cols-12 gap-1.5">
              <input
                className="input col-span-3"
                placeholder="key"
                value={f.key}
                onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
              />
              <input
                className="input col-span-3"
                placeholder="label"
                value={f.label}
                onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              />
              <select
                className="input col-span-2"
                value={f.type}
                onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
              >
                {['text', 'email', 'tel', 'select', 'textarea', 'checkbox'].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <input
                className="input col-span-3"
                placeholder="options, comma separated"
                value={f.options}
                onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, options: e.target.value } : x)))}
                disabled={f.type !== 'select'}
              />
              <label className="col-span-0.5 flex items-center justify-center">
                <input
                  type="checkbox"
                  checked={f.required}
                  title="required"
                  onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))}
                />
              </label>
              <button
                type="button"
                className="btn-quiet btn-sm col-span-1"
                onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setFields((fs) => [...fs, { key: '', label: '', type: 'text', required: false, options: '' }])}
          >
            + Add a field
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

function SubmissionsTab() {
  const { can } = useSession();
  const forms = useForms();
  const [formId, setFormId] = useState<string>('');
  const [status, setStatus] = useState<FormSubmissionStatus | ''>('');
  const [viewing, setViewing] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submissions = useFormSubmissions(formId || undefined, status || undefined);
  const convert = useConvertSubmission();
  const reject = useRejectSubmission();
  const spam = useMarkSubmissionSpam();

  const items = submissions.data?.items ?? [];
  const converted = items.filter((s) => s.status === 'converted').length;
  const conversionRate = items.length ? Math.round((converted / items.length) * 100) : null;

  return (
    <div>
      <Row>
        <SelectInput
          label="Form"
          value={formId}
          onChange={setFormId}
          placeholder="Choose a form"
          options={(forms.data?.items ?? []).map((f) => ({ value: f.id, label: f.name }))}
        />
        <SelectInput
          label="Status"
          value={status}
          onChange={(v) => setStatus(v as FormSubmissionStatus)}
          placeholder="All statuses"
          options={FORM_SUBMISSION_STATUSES.map((s) => ({ value: s, label: FORM_SUBMISSION_STATUS_LABELS[s] }))}
        />
      </Row>

      {formId && (
        <div className="my-4 grid gap-3 sm:grid-cols-3">
          <Metric label="Submissions" value={items.length} noActionReason="counted from the list below" />
          <Metric label="Converted" value={converted} noActionReason="counted from the list below" />
          <Metric
            label="Conversion rate"
            value={conversionRate === null ? '—' : `${conversionRate}%`}
            noActionReason={conversionRate === null ? 'no submissions yet' : 'converted ÷ total, this filter'}
          />
        </div>
      )}

      {!formId ? (
        <Card><EmptyState message="Choose a form to see its submissions." /></Card>
      ) : submissions.isLoading ? (
        <Loading />
      ) : submissions.error ? (
        <ErrorBox error={submissions.error} />
      ) : items.length === 0 ? (
        <Card><EmptyState message="No submissions match." /></Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          {error && <p className="m-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
          <table className="table">
            <thead>
              <tr>
                <th>Received</th>
                <th>Person</th>
                <th>Status</th>
                <th>Lead</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td className="text-2xs text-ink-400">{dateTime(s.receivedAt)}</td>
                  <td className="text-xs text-ink-200">{s.personName ?? '—'}</td>
                  <td><StatusChip status={s.status} tone={s.status === 'converted' ? 'good' : s.status === 'spam' || s.status === 'rejected' ? 'bad' : 'neutral'} /></td>
                  <td className="mono text-2xs text-ink-400">{s.leadRecordCode ?? '—'}</td>
                  <td>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <button className="btn-quiet btn-sm" onClick={() => setViewing(s.payload as Record<string, unknown>)}>
                        Payload
                      </button>
                      {can('marketing_forms:E') && s.status === 'received' && (
                        <>
                          <button
                            className="btn-quiet btn-sm"
                            onClick={() => convert.mutate(s.id, { onError: (e) => setError(messageOf(e)) })}
                            disabled={convert.isPending}
                          >
                            Convert
                          </button>
                          <button
                            className="btn-quiet btn-sm"
                            onClick={() => {
                              const reason = prompt('Reason for rejecting this submission?');
                              if (reason) reject.mutate({ id: s.id, reason }, { onError: (e) => setError(messageOf(e)) });
                            }}
                          >
                            Reject
                          </button>
                          <button
                            className="btn-quiet btn-sm"
                            onClick={() => spam.mutate(s.id, { onError: (e) => setError(messageOf(e)) })}
                          >
                            Spam
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Modal open={Boolean(viewing)} title="Submission payload" onClose={() => setViewing(null)} footer={<button className="btn" onClick={() => setViewing(null)}>Close</button>}>
        <pre className="max-h-96 overflow-auto rounded bg-ink-950 p-3 text-2xs text-ink-300">{JSON.stringify(viewing, null, 2)}</pre>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Touchpoints
// ---------------------------------------------------------------------------

function TouchpointsTab() {
  const [personId, setPersonId] = useState('');
  const [leadId, setLeadId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const touchpoints = useTouchpoints({
    personId: personId || undefined,
    leadId: leadId || undefined,
    campaignId: campaignId || undefined,
    from: from || undefined,
    to: to || undefined,
  });

  const items = touchpoints.data?.items ?? [];

  return (
    <div>
      <Card className="mb-4" bodyClassName="p-3">
        <div className="grid gap-2 sm:grid-cols-5">
          <input className="input" placeholder="Person ID" value={personId} onChange={(e) => setPersonId(e.target.value)} />
          <input className="input" placeholder="Lead ID" value={leadId} onChange={(e) => setLeadId(e.target.value)} />
          <input className="input" placeholder="Campaign ID" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} />
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </Card>

      {touchpoints.isLoading ? (
        <Loading />
      ) : touchpoints.error ? (
        <ErrorBox error={touchpoints.error} />
      ) : items.length === 0 ? (
        <Card><EmptyState message="No touchpoints match these filters." hint="Every click, form, call and walk-in is logged here, immutably." /></Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Campaign</th>
                <th>Channel</th>
                <th>Kind</th>
                <th className="text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td className="text-2xs text-ink-400">{dateTime(t.occurredAt)}</td>
                  <td className="text-xs text-ink-200">{t.personName ?? t.organizationName ?? t.leadRecordCode ?? '—'}</td>
                  <td className="text-xs text-ink-300">{t.campaignName ?? '—'}</td>
                  <td className="text-2xs text-ink-400">{CHANNEL_KEY_LABELS[t.channelKey] ?? t.channelKey}</td>
                  <td><span className="chip border-ink-700 text-ink-400">{TOUCH_KIND_LABELS[t.touchKind] ?? t.touchKind}</span></td>
                  <td className="text-right tabular-nums text-xs">{t.cost ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score rules
// ---------------------------------------------------------------------------

function ScoreRulesTab() {
  const { can } = useSession();
  const rules = useScoreRules();
  const create = useCreateScoreRule();
  const del = useDeleteScoreRule();
  const qcToggle = useQueryClient();
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => mk.updateScoreRule(id, { active }),
    onSuccess: () => qcToggle.invalidateQueries({ queryKey: ['mkt', 'score-rules'] }),
  });
  const preview = usePreviewScoreRules();
  const apply = useApplyScoreRules();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [field, setField] = useState('touchKind');
  const [op, setOp] = useState<AudienceRuleOp>('eq');
  const [value, setValue] = useState('');
  const [points, setPoints] = useState('10');
  const [error, setError] = useState<string | null>(null);
  const [previewLeadId, setPreviewLeadId] = useState('');

  if (rules.isLoading) return <Loading />;
  if (rules.error) return <ErrorBox error={rules.error} />;
  const items = rules.data ?? [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-end gap-2">
          <TextInput label="Preview against lead ID" value={previewLeadId} onChange={setPreviewLeadId} placeholder="lead id" />
          <button
            className="btn"
            disabled={!previewLeadId || preview.isPending}
            onClick={() => preview.mutate(previewLeadId, { onError: (e) => setError(messageOf(e)) })}
          >
            Preview
          </button>
        </div>
        {can('marketing_forms:C') && (
          <div className="flex gap-2">
            <button className="btn" onClick={() => apply.mutate(undefined, { onError: (e) => setError(messageOf(e)) })} disabled={apply.isPending}>
              Apply now
            </button>
            <NewButton label="New rule" onClick={() => setCreating(true)} />
          </div>
        )}
      </div>

      {error && <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
      {apply.data && <p className="mb-3 text-2xs text-ink-400">{apply.data.updated} open lead{apply.data.updated === 1 ? '' : 's'} rescored.</p>}
      {preview.data && (
        <Card className="mb-4" title="Preview" subtitle={`Score: ${preview.data.score}`}>
          <ul className="space-y-0.5">
            {preview.data.reasons.map((r, i) => <li key={i} className="text-2xs text-ink-400">{r}</li>)}
          </ul>
        </Card>
      )}

      {items.length === 0 ? (
        <Card><EmptyState message="No score rules yet." hint="The default set (form submitted, event attended, referral, and so on) seeds on first use." /></Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr><th>Order</th><th>Name</th><th>Condition</th><th className="text-right">Points</th><th>Active</th><th /></tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td className="tabular-nums text-xs">{r.order}</td>
                  <td className="text-xs text-ink-100">{r.name}</td>
                  <td className="mono text-2xs text-ink-400">{JSON.stringify(r.condition)}</td>
                  <td className="text-right tabular-nums text-xs">{r.points}</td>
                  <td><StatusChip status={r.active ? 'active' : 'inactive'} tone={r.active ? 'good' : 'neutral'} /></td>
                  <td>
                    {can('marketing_forms:D') && (
                      <div className="flex justify-end gap-1.5">
                        <button
                          className="btn-quiet btn-sm"
                          onClick={() => toggle.mutate({ id: r.id, active: !r.active }, { onError: (e) => setError(messageOf(e)) })}
                        >
                          {r.active ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          className="btn-quiet btn-sm"
                          onClick={() => { if (confirm(`Delete rule "${r.name}"?`)) del.mutate(r.id, { onError: (e) => setError(messageOf(e)) }); }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <CreateModal
        open={creating}
        title="New score rule"
        onClose={() => setCreating(false)}
        onSubmit={() => create.mutateAsync({ name, condition: { field, op, value }, points: Number(points), order: items.length + 1 })}
        invalidate={[['mkt', 'score-rules']]}
      >
        <TextInput label="Name" required value={name} onChange={setName} placeholder="Attended an event" />
        <Row>
          <TextInput label="Field" required value={field} onChange={setField} hint="e.g. touchKind" />
          <SelectInput label="Operator" value={op} onChange={(v) => setOp(v as AudienceRuleOp)} options={AUDIENCE_RULE_OPS.map((o) => ({ value: o, label: o }))} />
        </Row>
        <Row>
          <TextInput label="Value" required value={value} onChange={setValue} placeholder="event_attend" />
          <TextInput label="Points" type="number" required value={points} onChange={setPoints} />
        </Row>
      </CreateModal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Short links
// ---------------------------------------------------------------------------

function LinksTab() {
  const { can } = useSession();
  const links = useLinks();
  const campaigns = useCampaigns();
  const create = useCreateLink();
  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [channelKey, setChannelKey] = useState<ChannelKey | ''>('');
  const [error, setError] = useState<string | null>(null);

  if (links.isLoading) return <Loading />;
  if (links.error) return <ErrorBox error={links.error} />;
  const items = links.data?.items ?? [];

  return (
    <div>
      <div className="mb-4 flex justify-end">
        {can('marketing_forms:C') && <NewButton label="New short link" onClick={() => setCreating(true)} />}
      </div>
      {items.length === 0 ? (
        <Card><EmptyState message="No short links yet." /></Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr><th>Slug</th><th>Target</th><th>Campaign</th><th>Channel</th><th className="text-right">Clicks</th><th /></tr>
            </thead>
            <tbody>
              {items.map((l) => (
                <tr key={l.id}>
                  <td className="mono text-xs text-ink-100">/l/{l.slug}</td>
                  <td className="max-w-xs truncate text-2xs text-ink-400">{l.targetUrl}</td>
                  <td className="text-xs text-ink-300">{l.campaignName ?? '—'}</td>
                  <td className="text-2xs text-ink-400">{l.channelKey ? CHANNEL_KEY_LABELS[l.channelKey] : '—'}</td>
                  <td className="text-right tabular-nums text-xs">{l.clickCount}</td>
                  <td>
                    <button className="btn-quiet btn-sm" onClick={() => copyToClipboard(`${location.origin}/api/marketing/public/l/${l.slug}`)}>
                      Copy
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <CreateModal
        open={creating}
        title="New short link"
        onClose={() => setCreating(false)}
        onSubmit={() => create.mutateAsync({ slug: slug || undefined, targetUrl, campaignId: campaignId || undefined, channelKey: channelKey || undefined })}
        invalidate={[]}
      >
        {error && <p className="text-2xs text-band-critical">{error}</p>}
        <TextInput label="Target URL" required value={targetUrl} onChange={setTargetUrl} placeholder="https://…" />
        <TextInput label="Slug" hint="generated if blank" value={slug} onChange={setSlug} />
        <Row>
          <SelectInput label="Campaign" value={campaignId} onChange={setCampaignId} placeholder="No campaign" options={(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          <SelectInput label="Channel" value={channelKey} onChange={(v) => setChannelKey(v as ChannelKey)} placeholder="No channel" options={CHANNEL_KEYS.map((c) => ({ value: c, label: CHANNEL_KEY_LABELS[c] }))} />
        </Row>
      </CreateModal>
    </div>
  );
}
