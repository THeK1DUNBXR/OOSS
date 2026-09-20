/**
 * Audiences — segments a send, a journey or a suppression list reads.
 *
 * A dynamic audience's membership is materialised by evaluation, never
 * computed at send time (MKT-AUD-001/005): the rule builder here edits the
 * rule tree, but nothing about membership changes until "Evaluate now" runs.
 * A static audience takes only manual add/remove. A suppression audience
 * excludes its members from every send regardless of anything else.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AUDIENCE_ENTITY_TYPES,
  AUDIENCE_KINDS,
  AUDIENCE_KIND_LABELS,
  AUDIENCE_RULE_OPS,
  type AudienceCondition,
  type AudienceEntityType,
  type AudienceKind,
  type AudienceRule,
  type AudienceRuleOp,
} from '@kaizen/shared';
import { api, date, dateTime, titleCase } from '../../lib/api.js';
import {
  AudienceField,
  useAddAudienceMembers,
  useAudience,
  useAudienceFields,
  useAudiences,
  useCreateAudience,
  useDeleteAudience,
  useEvaluateAudience,
  usePreviewAudience,
  useRemoveAudienceMember,
  useSuppressAudienceMember,
  useUpdateAudience,
} from '../../lib/marketingApi.js';
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
import { Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';
import { CreateModal, messageOf } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';

const KIND_TONE: Record<AudienceKind, 'neutral' | 'good' | 'accent' | 'warn'> = {
  dynamic: 'accent',
  static: 'neutral',
  suppression: 'warn',
};

function emptyRule(): AudienceRule {
  return { all: [], any: [] };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function Audiences() {
  const { can } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading, error } = useAudiences();

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Audiences"
        subtitle="Who a send, journey or suppression list reaches. A dynamic audience's members are only as current as its last evaluation."
        actions={
          can('audiences:C') && (
            <button className="btn-primary" onClick={() => setCreateOpen(true)}>
              New audience
            </button>
          )
        }
      />

      {isLoading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState
            message="No audiences yet."
            hint="An audience is a rule tree (dynamic), a manual list (static), or a suppression list every send checks."
          />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Kind</th>
                <th>Entity</th>
                <th className="text-right">Members</th>
                <th>Last evaluated</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id} className="cursor-pointer" onClick={() => setOpenId(a.id)}>
                  <td>
                    <RecordCode code={a.recordCode} />
                  </td>
                  <td>
                    <p className="text-xs font-medium text-ink-100">{a.name}</p>
                    {a.description && <p className="text-2xs text-ink-500">{a.description}</p>}
                  </td>
                  <td>
                    <StatusChip status={AUDIENCE_KIND_LABELS[a.kind]} tone={KIND_TONE[a.kind]} />
                    {a.kind === 'suppression' && (
                      <p className="mt-0.5 text-2xs italic text-band-watch">excluded from every send</p>
                    )}
                  </td>
                  <td className="text-xs text-ink-300">{titleCase(a.entityType)}</td>
                  <td className="text-right tabular-nums text-xs">{a.memberCount ?? '—'}</td>
                  <td className="text-2xs text-ink-500">
                    {a.kind === 'static' ? 'not evaluated — manual list' : a.lastEvaluatedAt ? dateTime(a.lastEvaluatedAt) : 'never evaluated'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <NewAudience open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(id) => setOpenId(id)} />
      {openId && <AudienceDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function NewAudience({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AudienceKind | ''>('');
  const [entityType, setEntityType] = useState<AudienceEntityType | ''>('');
  const [description, setDescription] = useState('');

  const reset = () => {
    setName('');
    setKind('');
    setEntityType('');
    setDescription('');
  };

  return (
    <CreateModal
      open={open}
      title="New audience"
      submitLabel="Create"
      onClose={() => {
        reset();
        onClose();
      }}
      invalidate={[['mkt', 'audiences']]}
      onCreated={(result) => {
        reset();
        const created = result as { id: string } | undefined;
        if (created?.id) onCreated(created.id);
      }}
      onSubmit={() =>
        api.post(`/marketing/audiences`, {
          name,
          kind,
          entityType,
          description: description || undefined,
          rules: kind === 'dynamic' ? emptyRule() : undefined,
        })
      }
    >
      <TextInput label="Name" required value={name} onChange={setName} placeholder="e.g. Warm leads — last 30 days" />
      <Row>
        <SelectInput
          label="Kind"
          required
          value={kind}
          onChange={(v) => setKind(v as AudienceKind)}
          placeholder="Choose a kind"
          options={AUDIENCE_KINDS.map((k) => ({ value: k, label: AUDIENCE_KIND_LABELS[k] }))}
        />
        <SelectInput
          label="Entity"
          required
          value={entityType}
          onChange={(v) => setEntityType(v as AudienceEntityType)}
          placeholder="What it lists"
          options={AUDIENCE_ENTITY_TYPES.map((e) => ({ value: e, label: titleCase(e) }))}
        />
      </Row>
      <TextArea label="Description" value={description} onChange={setDescription} placeholder="What this audience is for" />
      {kind === 'dynamic' && (
        <p className="text-2xs text-ink-500">The rule builder opens once this is created — it starts empty.</p>
      )}
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function AudienceDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useSession();
  const { data: audience, isLoading, error } = useAudience(id);
  const [rules, setRules] = useState<AudienceRule | null>(null);
  const [previewResult, setPreviewResult] = useState<{ count: number; sample: Array<{ entityId: string; label: string }> } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const preview = usePreviewAudience();
  const evaluate = useEvaluateAudience(id);
  const update = useUpdateAudience(id);
  const del = useDeleteAudience();
  const removeMember = useRemoveAudienceMember(id);
  const suppress = useSuppressAudienceMember(id);

  const activeRules = rules ?? audience?.rules ?? emptyRule();
  const fields = useAudienceFields(audience?.entityType);

  if (isLoading) {
    return (
      <Modal open title="Audience" onClose={onClose}>
        <Loading />
      </Modal>
    );
  }
  if (error || !audience) {
    return (
      <Modal open title="Audience" onClose={onClose}>
        <ErrorBox error={error ?? new Error('Not found')} />
      </Modal>
    );
  }

  const canEdit = can('audiences:E');
  const dirty = rules !== null && JSON.stringify(rules) !== JSON.stringify(audience.rules);

  return (
    <Modal
      open
      title={audience.name}
      onClose={onClose}
      width="max-w-3xl"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          {audience.kind !== 'static' && canEdit && dirty && (
            <button
              className="btn-primary"
              disabled={update.isPending}
              onClick={() => {
                update.mutate(
                  { rules: activeRules },
                  {
                    onSuccess: () => setRules(null),
                    onError: (e) => setBanner(messageOf(e)),
                  },
                );
              }}
            >
              {update.isPending ? 'Saving…' : 'Save rules'}
            </button>
          )}
          {can('audiences:D') && (
            <button
              className="btn-ghost text-band-critical"
              onClick={() => {
                if (confirm('Delete this audience?')) del.mutate(id, { onSuccess: onClose });
              }}
            >
              Delete
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {banner && (
          <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{banner}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={AUDIENCE_KIND_LABELS[audience.kind]} tone={KIND_TONE[audience.kind]} />
          <span className="chip border-ink-700 text-ink-400">{titleCase(audience.entityType)}</span>
          {audience.kind === 'suppression' && (
            <span className="chip border-band-watch/40 bg-band-watch/10 text-band-watch">excluded from every send</span>
          )}
          <span className="text-2xs text-ink-500">
            {audience.memberCount ?? 0} member{audience.memberCount === 1 ? '' : 's'}
            {audience.lastEvaluatedAt && ` · evaluated ${dateTime(audience.lastEvaluatedAt)}`}
          </span>
        </div>

        {audience.kind === 'dynamic' && (
          <Card
            title="Rule builder"
            subtitle="Two groups: everyone must match every condition in “must match all”, and at least one condition in “must match any” (when either group is used)."
            actions={
              canEdit && (
                <div className="flex gap-2">
                  <button
                    className="btn-ghost"
                    disabled={preview.isPending}
                    onClick={() => {
                      preview.mutate(
                        { entityType: audience.entityType, rules: activeRules },
                        { onSuccess: (r) => setPreviewResult(r), onError: (e) => setBanner(messageOf(e)) },
                      );
                    }}
                  >
                    {preview.isPending ? 'Counting…' : 'Preview count'}
                  </button>
                  <button
                    className="btn-ghost"
                    disabled={evaluate.isPending}
                    onClick={() => {
                      evaluate.mutate(undefined, { onError: (e) => setBanner(messageOf(e)) });
                    }}
                  >
                    {evaluate.isPending ? 'Evaluating…' : 'Evaluate now'}
                  </button>
                </div>
              )
            }
          >
            <RuleBuilder
              rule={activeRules}
              onChange={(r) => setRules(r)}
              fields={fields.data ?? []}
              fieldsLoading={fields.isLoading}
              disabled={!canEdit}
            />
            {previewResult && (
              <div className="mt-3 rounded-md border border-ink-800 bg-ink-850 p-3">
                <p className="text-xs font-medium text-ink-100">
                  {previewResult.count} would match right now
                </p>
                {previewResult.sample.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-2xs text-ink-400">
                    {previewResult.sample.slice(0, 8).map((s) => (
                      <li key={s.entityId}>{s.label}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {evaluate.data && (
              <p className="mt-2 text-2xs text-ink-500">
                Last evaluation: {evaluate.data.memberCount} members ({evaluate.data.addedCount} added, {evaluate.data.removedCount} removed),
                at {dateTime(evaluate.data.evaluatedAt)}.
              </p>
            )}
          </Card>
        )}

        {audience.kind === 'static' && (
          <StaticMemberAdd audienceId={id} entityType={audience.entityType} onError={setBanner} />
        )}

        <Card title="Members" subtitle="First 50, most recently added." bodyClassName="p-0">
          {audience.members.length === 0 ? (
            <div className="p-4">
              <EmptyState
                message="No members yet."
                hint={audience.kind === 'dynamic' ? 'Run "Evaluate now" once the rules match what you want.' : 'Search below and add people to this list.'}
              />
            </div>
          ) : (
            <ul className="divide-y divide-ink-850">
              {audience.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <div>
                    <p className="text-xs text-ink-200">{m.entityId}</p>
                    <p className="text-2xs text-ink-500">
                      {titleCase(m.entityType)} · added {date(m.addedAt)} via {titleCase(m.source)}
                      {m.suppressed && <span className="ml-1 text-band-watch">· suppressed</span>}
                    </p>
                  </div>
                  {canEdit && !m.suppressed && (
                    <div className="flex shrink-0 gap-1">
                      <button
                        className="btn-ghost text-2xs"
                        onClick={() => {
                          const reason = prompt('Reason for suppressing this member?');
                          if (reason) suppress.mutate({ memberId: m.id, reason }, { onError: (e) => setBanner(messageOf(e)) });
                        }}
                      >
                        Suppress
                      </button>
                      {audience.kind === 'static' && (
                        <button
                          className="btn-ghost text-2xs text-band-critical"
                          onClick={() => removeMember.mutate(m.id, { onError: (e) => setBanner(messageOf(e)) })}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Rule builder
// ---------------------------------------------------------------------------

function RuleBuilder({
  rule,
  onChange,
  fields,
  fieldsLoading,
  disabled,
}: {
  rule: AudienceRule;
  onChange: (r: AudienceRule) => void;
  fields: AudienceField[];
  fieldsLoading: boolean;
  disabled: boolean;
}) {
  if (fieldsLoading) return <Loading label="Loading fields" />;
  return (
    <div className="space-y-4">
      <ConditionGroup
        title="Must match all of"
        hint="AND — every condition here has to be true."
        conditions={rule.all ?? []}
        onChange={(conds) => onChange({ ...rule, all: conds })}
        fields={fields}
        disabled={disabled}
      />
      <ConditionGroup
        title="Must match any of"
        hint="OR — at least one condition here has to be true."
        conditions={rule.any ?? []}
        onChange={(conds) => onChange({ ...rule, any: conds })}
        fields={fields}
        disabled={disabled}
      />
    </div>
  );
}

function ConditionGroup({
  title,
  hint,
  conditions,
  onChange,
  fields,
  disabled,
}: {
  title: string;
  hint: string;
  conditions: AudienceCondition[];
  onChange: (c: AudienceCondition[]) => void;
  fields: AudienceField[];
  disabled: boolean;
}) {
  return (
    <div className="rounded-md border border-ink-800 bg-ink-950 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-xs font-semibold text-ink-200">{title}</p>
        <p className="text-2xs text-ink-500">{hint}</p>
      </div>
      <div className="space-y-2">
        {conditions.map((c, i) => (
          <ConditionRow
            key={i}
            condition={c}
            fields={fields}
            disabled={disabled}
            onChange={(next) => {
              const copy = conditions.slice();
              copy[i] = next;
              onChange(copy);
            }}
            onRemove={() => onChange(conditions.filter((_, idx) => idx !== i))}
          />
        ))}
        {conditions.length === 0 && <p className="text-2xs italic text-ink-500">No conditions in this group.</p>}
      </div>
      {!disabled && (
        <button
          className="btn-ghost mt-2 text-2xs"
          onClick={() => {
            const first = fields[0];
            if (!first) return;
            onChange([...conditions, { field: first.field, op: first.ops[0] as AudienceRuleOp, value: '' }]);
          }}
          disabled={fields.length === 0}
        >
          + Add condition
        </button>
      )}
    </div>
  );
}

const NO_VALUE_OPS: AudienceRuleOp[] = ['is_null', 'not_null'];

function ConditionRow({
  condition,
  fields,
  onChange,
  onRemove,
  disabled,
}: {
  condition: AudienceCondition;
  fields: AudienceField[];
  onChange: (c: AudienceCondition) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const fieldDef = fields.find((f) => f.field === condition.field);
  const ops = fieldDef?.ops ?? AUDIENCE_RULE_OPS;
  const needsValue = !NO_VALUE_OPS.includes(condition.op);
  const inputType = fieldDef?.type === 'date' ? 'date' : fieldDef?.type === 'number' ? 'number' : 'text';

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        className="input w-40"
        value={condition.field}
        disabled={disabled}
        onChange={(e) => {
          const f = fields.find((x) => x.field === e.target.value);
          onChange({ field: e.target.value, op: (f?.ops[0] as AudienceRuleOp) ?? condition.op, value: condition.value });
        }}
      >
        {fields.map((f) => (
          <option key={f.field} value={f.field}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        className="input w-32"
        value={condition.op}
        disabled={disabled}
        onChange={(e) => onChange({ ...condition, op: e.target.value as AudienceRuleOp })}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {op.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
      {needsValue && condition.op === 'between' ? (
        <>
          <input
            className="input w-28"
            type={inputType}
            disabled={disabled}
            value={Array.isArray(condition.value) ? String(condition.value[0] ?? '') : ''}
            onChange={(e) => {
              const hi = Array.isArray(condition.value) ? condition.value[1] : undefined;
              onChange({ ...condition, value: [e.target.value, hi] });
            }}
          />
          <span className="text-2xs text-ink-500">and</span>
          <input
            className="input w-28"
            type={inputType}
            disabled={disabled}
            value={Array.isArray(condition.value) ? String(condition.value[1] ?? '') : ''}
            onChange={(e) => {
              const lo = Array.isArray(condition.value) ? condition.value[0] : undefined;
              onChange({ ...condition, value: [lo, e.target.value] });
            }}
          />
        </>
      ) : needsValue && condition.op === 'in' ? (
        <input
          className="input w-40"
          placeholder="comma-separated"
          disabled={disabled}
          value={Array.isArray(condition.value) ? condition.value.join(',') : String(condition.value ?? '')}
          onChange={(e) => onChange({ ...condition, value: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })}
        />
      ) : needsValue ? (
        <input
          className="input w-40"
          type={inputType}
          disabled={disabled}
          value={String(condition.value ?? '')}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
        />
      ) : (
        <span className="text-2xs italic text-ink-500">no value needed</span>
      )}
      {!disabled && (
        <button className="text-2xs text-band-critical" onClick={onRemove} aria-label="Remove condition">
          Remove
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Static-list member search & add
// ---------------------------------------------------------------------------

interface SearchResult {
  id: string;
  recordCode: string;
  label: string;
}

const ENTITY_SEARCH_PATH: Record<AudienceEntityType, string> = {
  person: '/crm/people',
  student: '/crm/people',
  organization: '/crm/organizations',
  institution: '/crm/institutions',
  lead: '/crm/leads',
};

function StaticMemberAdd({
  audienceId,
  entityType,
  onError,
}: {
  audienceId: string;
  entityType: AudienceEntityType;
  onError: (m: string) => void;
}) {
  const [q, setQ] = useState('');
  const addMembers = useAddAudienceMembers(audienceId);
  const path = ENTITY_SEARCH_PATH[entityType];

  const { data, isFetching } = useQuery({
    queryKey: ['mkt', 'audience-member-search', entityType, q],
    queryFn: () => api.get<{ items: any[] }>(`${path}?q=${encodeURIComponent(q)}&pageSize=10`),
    enabled: q.length >= 2,
  });

  const results: SearchResult[] = useMemo(
    () =>
      (data?.items ?? []).map((it: any) => ({
        id: it.id,
        recordCode: it.recordCode,
        label: it.fullName ?? it.name ?? it.title ?? it.recordCode,
      })),
    [data],
  );

  return (
    <Card title="Add members" subtitle="This is a manual list — search and add one person (or record) at a time.">
      <TextInput label={`Search ${titleCase(entityType)}`} value={q} onChange={setQ} placeholder="Name or record code…" />
      {q.length >= 2 && (
        <div className="mt-2 space-y-1">
          {isFetching ? (
            <Loading label="Searching" />
          ) : results.length === 0 ? (
            <p className="text-2xs italic text-ink-500">Nothing matches.</p>
          ) : (
            results.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 rounded border border-ink-800 px-2.5 py-1.5">
                <div>
                  <p className="text-xs text-ink-100">{r.label}</p>
                  <p className="text-2xs text-ink-500 mono">{r.recordCode}</p>
                </div>
                <button
                  className="btn-ghost text-2xs"
                  disabled={addMembers.isPending}
                  onClick={() =>
                    addMembers.mutate([{ entityType, entityId: r.id }], {
                      onError: (e) => onError(messageOf(e)),
                    })
                  }
                >
                  Add
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </Card>
  );
}
