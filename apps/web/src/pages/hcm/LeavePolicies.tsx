/**
 * Leave policies — WS3 leavepolicy (docs/hcm/leavepolicy.md).
 *
 * Three tabs: the policies themselves (applicability plus each leave type's
 * rule), the accrual runs a rule has fired, and the multi-level approval
 * chains a leave request's chain is resolved from.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { date } from '../../lib/api.js';
import { hcmApi, type AccrualRunRow, type ApprovalChainLevel, type LeavePolicyRule } from '../../lib/hcmApi.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

type Tab = 'policies' | 'accruals' | 'chains';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'policies', label: 'Policies' },
  { key: 'accruals', label: 'Accrual runs' },
  { key: 'chains', label: 'Approval chains' },
];

export function LeavePolicies() {
  const [tab, setTab] = useState<Tab>('policies');
  return (
    <div>
      <PageHeader
        title="Leave policies"
        subtitle="Who a policy applies to, how each leave type it governs accrues, and the guard rails a request against it is checked against."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'policies' && <PoliciesTab />}
      {tab === 'accruals' && <AccrualsTab />}
      {tab === 'chains' && <ChainsTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policies + rules
// ---------------------------------------------------------------------------

const ENGAGEMENT_TYPES = ['employee', 'contractor', 'consultant', 'intern', 'apprentice'];
const FREQUENCIES = ['monthly', 'quarterly', 'yearly', 'none'];

function PoliciesTab() {
  const [creating, setCreating] = useState(false);
  const [addingRuleTo, setAddingRuleTo] = useState<string | null>(null);
  const [runningRule, setRunningRule] = useState<LeavePolicyRule | null>(null);
  const [form, setForm] = useState({ name: '', description: '', engagementTypes: [] as string[], effectiveFrom: '' });
  const [ruleForm, setRuleForm] = useState({
    leaveTypeId: '',
    accrualFrequency: 'monthly',
    accrualDays: '1.25',
    prorateOnJoin: true,
    maxBalanceDays: '',
    carryForwardCapDays: '',
    negativeAllowed: false,
    minNoticeDays: '0',
    maxConsecutiveDays: '',
    sandwichRule: false,
    requiresDocumentAfterDays: '',
    applicableGender: '',
  });
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));

  const policies = useQuery({
    queryKey: ['leavepolicy-policies'],
    queryFn: () => hcmApi.leavePolicy.policies.list(),
  });
  const { data: leaveTypes = [] } = useQuery({
    queryKey: ['leave-types'],
    queryFn: () => hcmApi.hr.leaveTypes(),
  });

  const nameForType = (id: string) => leaveTypes.find((t) => t.id === id)?.name ?? id;

  const toggleEngagement = (v: string) =>
    setForm((f) => ({
      ...f,
      engagementTypes: f.engagementTypes.includes(v)
        ? f.engagementTypes.filter((e) => e !== v)
        : [...f.engagementTypes, v],
    }));

  const ruleColumns: ReadonlyArray<DataTableColumn<LeavePolicyRule>> = [
    {
      id: 'leaveType',
      header: 'Leave type',
      sortValue: (r) => nameForType(r.leaveTypeId),
      cell: (r) => nameForType(r.leaveTypeId),
    },
    {
      id: 'accrual',
      header: 'Accrual',
      cell: (r) =>
        r.accrualFrequency === 'none'
          ? 'No accrual'
          : `${r.accrualDays} days / ${r.accrualFrequency.replace('ly', '')}`,
    },
    { id: 'maxBalance', header: 'Max balance', cell: (r) => r.maxBalanceDays ?? '—' },
    {
      id: 'minNotice',
      header: 'Min notice',
      sortValue: (r) => r.minNoticeDays,
      cell: (r) => `${r.minNoticeDays} days`,
    },
    { id: 'maxConsecutive', header: 'Max consecutive', cell: (r) => r.maxConsecutiveDays ?? '—' },
    { id: 'sandwich', header: 'Sandwich', cell: (r) => (r.sandwichRule ? 'Yes' : 'No') },
    { id: 'negative', header: 'Negative allowed', cell: (r) => (r.negativeAllowed ? 'Yes' : 'No') },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) =>
        r.accrualFrequency !== 'none' && (
          <button className="btn text-2xs" onClick={() => setRunningRule(r)}>
            Run accrual
          </button>
        ),
    },
  ];

  return (
    <Card
      title="Policies"
      subtitle="Empty applicability means everybody. A more specific policy (an engagement type or org unit given) wins over the wider default."
      actions={<NewButton label="Add policy" onClick={() => setCreating(true)} />}
    >
      {policies.isLoading && <Loading />}
      {policies.error && <ErrorBox error={policies.error} />}
      {policies.data && policies.data.length === 0 && (
        <EmptyState
          message="No leave policies yet."
          hint="Add one — a policy with no applicability lists is the company-wide default."
        />
      )}
      {policies.data && policies.data.length > 0 && (
        <div className="space-y-4">
          {policies.data.map((p) => (
            <div key={p.id} className="rounded-lg border border-ink-800/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold">{p.name}</div>
                  <div className="text-2xs text-ink-300">
                    Effective {date(p.effectiveFrom)}
                    {p.effectiveTo ? ` – ${date(p.effectiveTo)}` : ' onward'}
                    {p.engagementTypes.length > 0 && ` · ${p.engagementTypes.join(', ')}`}
                    {p.engagementTypes.length === 0 && ' · everybody'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusChip status={p.status} tone={p.status === 'active' ? 'good' : 'neutral'} />
                  <button className="btn text-2xs" onClick={() => setAddingRuleTo(p.id)}>
                    Add rule
                  </button>
                </div>
              </div>

              {p.rules.length === 0 ? (
                <p className="mt-2 text-2xs text-ink-400">No leave type has a rule under this policy yet.</p>
              ) : (
                <DataTable
                  caption={`Leave rules under ${p.name}`}
                  columns={ruleColumns}
                  rows={p.rules}
                  rowKey={(r) => r.id}
                  emptyMessage="No leave type has a rule under this policy yet."
                />
              )}
            </div>
          ))}
        </div>
      )}

      <CreateModal
        open={creating}
        title="Add a leave policy"
        onClose={() => setCreating(false)}
        invalidate={[['leavepolicy-policies']]}
        onSubmit={() =>
          hcmApi.leavePolicy.policies.create({
            name: form.name,
            description: form.description || null,
            engagementTypes: form.engagementTypes,
            effectiveFrom: form.effectiveFrom,
          })
        }
        onCreated={() => setForm({ name: '', description: '', engagementTypes: [], effectiveFrom: '' })}
      >
        <TextInput label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <TextArea label="Description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} />
        <TextInput
          label="Effective from"
          type="date"
          value={form.effectiveFrom}
          onChange={(v) => setForm({ ...form, effectiveFrom: v })}
          required
        />
        <div>
          <p className="label mb-1">Applies to (leave empty for everybody)</p>
          <div className="flex flex-wrap gap-2">
            {ENGAGEMENT_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-1 text-2xs text-ink-300">
                <input
                  type="checkbox"
                  checked={form.engagementTypes.includes(t)}
                  onChange={() => toggleEngagement(t)}
                />
                {t}
              </label>
            ))}
          </div>
        </div>
      </CreateModal>

      <CreateModal
        open={Boolean(addingRuleTo)}
        title="Add a leave-type rule"
        onClose={() => setAddingRuleTo(null)}
        invalidate={[['leavepolicy-policies']]}
        onSubmit={() =>
          hcmApi.leavePolicy.policies.createRule(addingRuleTo!, {
            leaveTypeId: ruleForm.leaveTypeId,
            accrualFrequency: ruleForm.accrualFrequency,
            accrualDays: Number(ruleForm.accrualDays) || 0,
            prorateOnJoin: ruleForm.prorateOnJoin,
            maxBalanceDays: ruleForm.maxBalanceDays ? Number(ruleForm.maxBalanceDays) : null,
            carryForwardCapDays: ruleForm.carryForwardCapDays ? Number(ruleForm.carryForwardCapDays) : null,
            negativeAllowed: ruleForm.negativeAllowed,
            minNoticeDays: Number(ruleForm.minNoticeDays) || 0,
            maxConsecutiveDays: ruleForm.maxConsecutiveDays ? Number(ruleForm.maxConsecutiveDays) : null,
            sandwichRule: ruleForm.sandwichRule,
            requiresDocumentAfterDays: ruleForm.requiresDocumentAfterDays
              ? Number(ruleForm.requiresDocumentAfterDays)
              : null,
            applicableGender: ruleForm.applicableGender || null,
          })
        }
      >
        <SelectInput
          label="Leave type"
          value={ruleForm.leaveTypeId}
          onChange={(v) => setRuleForm({ ...ruleForm, leaveTypeId: v })}
          required
          placeholder="Select…"
          options={leaveTypes.map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }))}
        />
        <Row>
          <SelectInput
            label="Accrual frequency"
            value={ruleForm.accrualFrequency}
            onChange={(v) => setRuleForm({ ...ruleForm, accrualFrequency: v })}
            options={FREQUENCIES.map((f) => ({ value: f, label: f }))}
          />
          <TextInput
            label="Days per accrual"
            type="number"
            value={ruleForm.accrualDays}
            onChange={(v) => setRuleForm({ ...ruleForm, accrualDays: v })}
            hint="0 if it does not accrue"
          />
        </Row>
        <Row>
          <TextInput
            label="Max balance"
            type="number"
            value={ruleForm.maxBalanceDays}
            onChange={(v) => setRuleForm({ ...ruleForm, maxBalanceDays: v })}
            hint="Optional"
          />
          <TextInput
            label="Carry-forward cap"
            type="number"
            value={ruleForm.carryForwardCapDays}
            onChange={(v) => setRuleForm({ ...ruleForm, carryForwardCapDays: v })}
            hint="Optional"
          />
        </Row>
        <Row>
          <TextInput
            label="Min notice (days)"
            type="number"
            value={ruleForm.minNoticeDays}
            onChange={(v) => setRuleForm({ ...ruleForm, minNoticeDays: v })}
          />
          <TextInput
            label="Max consecutive days"
            type="number"
            value={ruleForm.maxConsecutiveDays}
            onChange={(v) => setRuleForm({ ...ruleForm, maxConsecutiveDays: v })}
            hint="Optional"
          />
        </Row>
        <TextInput
          label="Document required after (days)"
          type="number"
          value={ruleForm.requiresDocumentAfterDays}
          onChange={(v) => setRuleForm({ ...ruleForm, requiresDocumentAfterDays: v })}
          hint="Optional"
        />
        <SelectInput
          label="Applies to gender"
          value={ruleForm.applicableGender}
          onChange={(v) => setRuleForm({ ...ruleForm, applicableGender: v })}
          placeholder="Everybody"
          options={[
            { value: 'male', label: 'Male' },
            { value: 'female', label: 'Female' },
          ]}
        />
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-ink-300">
            <input
              type="checkbox"
              checked={ruleForm.prorateOnJoin}
              onChange={(e) => setRuleForm({ ...ruleForm, prorateOnJoin: e.target.checked })}
            />
            Pro-rate on join
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-300">
            <input
              type="checkbox"
              checked={ruleForm.negativeAllowed}
              onChange={(e) => setRuleForm({ ...ruleForm, negativeAllowed: e.target.checked })}
            />
            Negative balance allowed
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-300">
            <input
              type="checkbox"
              checked={ruleForm.sandwichRule}
              onChange={(e) => setRuleForm({ ...ruleForm, sandwichRule: e.target.checked })}
            />
            Sandwich rule
          </label>
        </div>
      </CreateModal>

      <CreateModal
        open={Boolean(runningRule)}
        title={`Run accrual for ${runningRule ? nameForType(runningRule.leaveTypeId) : ''}`}
        submitLabel="Run"
        onClose={() => setRunningRule(null)}
        invalidate={[['leavepolicy-accrual-runs']]}
        onSubmit={() => hcmApi.leavePolicy.accrualRuns.run({ leavePolicyRuleId: runningRule?.id, period })}
      >
        <TextInput
          label="Period"
          value={period}
          onChange={setPeriod}
          hint={
            runningRule?.accrualFrequency === 'yearly'
              ? 'YYYY'
              : runningRule?.accrualFrequency === 'quarterly'
                ? 'YYYY-Q1..4'
                : 'YYYY-MM'
          }
          required
        />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Accrual runs
// ---------------------------------------------------------------------------

function AccrualsTab() {
  const runs = useQuery({
    queryKey: ['leavepolicy-accrual-runs'],
    queryFn: () => hcmApi.leavePolicy.accrualRuns.list(),
  });
  const { data: leaveTypes = [] } = useQuery({
    queryKey: ['leave-types'],
    queryFn: () => hcmApi.hr.leaveTypes(),
  });
  const nameForType = (id: string) => leaveTypes.find((t) => t.id === id)?.name ?? id;

  const columns: ReadonlyArray<DataTableColumn<AccrualRunRow>> = [
    {
      id: 'leaveType',
      header: 'Leave type',
      sortValue: (r) => nameForType(r.leaveTypeId),
      cell: (r) => nameForType(r.leaveTypeId),
    },
    {
      id: 'period',
      header: 'Period',
      sortValue: (r) => r.period,
      cell: (r) => <span className="mono">{r.period}</span>,
    },
    {
      id: 'employees',
      header: 'Employees',
      align: 'right',
      sortValue: (r) => r.employeesProcessed,
      cell: (r) => r.employeesProcessed,
    },
    {
      id: 'days',
      header: 'Days credited',
      align: 'right',
      sortValue: (r) => Number(r.totalDaysAccrued),
      cell: (r) => Number(r.totalDaysAccrued).toFixed(2),
    },
    { id: 'ran', header: 'Ran', sortValue: (r) => r.runAt, cell: (r) => date(r.runAt) },
  ];

  return (
    <Card
      title="Accrual runs"
      subtitle="Every firing is idempotent per rule and period — running one twice credits the ledger once."
    >
      <DataTable
        caption="Accrual runs"
        columns={columns}
        rows={runs.data ?? []}
        rowKey={(r) => r.id}
        loading={runs.isLoading}
        error={runs.error}
        emptyMessage="No accrual has run yet."
        emptyHint="Run one from a policy's rule on the Policies tab."
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Approval chains
// ---------------------------------------------------------------------------

function ChainsTab() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{ name: string; isDefault: boolean; levels: ApprovalChainLevel[] }>({
    name: '',
    isDefault: false,
    levels: [{ level: 1, kind: 'manager', approverPartyId: '' }],
  });

  const chains = useQuery({
    queryKey: ['leavepolicy-chains'],
    queryFn: () => hcmApi.leavePolicy.approvalChains.list(),
  });

  const del = useMutation({
    mutationFn: (id: string) => hcmApi.leavePolicy.approvalChains.remove(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['leavepolicy-chains'] }),
  });

  const addLevel = () =>
    setForm((f) => ({ ...f, levels: [...f.levels, { level: f.levels.length + 1, kind: 'hr', approverPartyId: '' }] }));
  const updateLevel = (idx: number, patch: Partial<ApprovalChainLevel>) =>
    setForm((f) => ({ ...f, levels: f.levels.map((l, i) => (i === idx ? { ...l, ...patch } : l)) }));
  const removeLevel = (idx: number) => setForm((f) => ({ ...f, levels: f.levels.filter((_, i) => i !== idx) }));

  return (
    <Card
      title="Approval chains"
      subtitle="An ordered list of levels resolved to a real approver the moment a leave request is created. A manager level resolves through the requester's current assignment; an hr level resolves to whoever holds the HR ops role."
      actions={<NewButton label="Add chain" onClick={() => setCreating(true)} />}
    >
      {chains.isLoading && <Loading />}
      {chains.error && <ErrorBox error={chains.error} />}
      {chains.data && chains.data.length === 0 && (
        <EmptyState
          message="No approval chain configured yet."
          hint="A request created with no chain simply has none opened for it."
        />
      )}
      {chains.data && chains.data.length > 0 && (
        <div className="space-y-3">
          {chains.data.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-lg border border-ink-800/10 p-3">
              <div>
                <div className="font-semibold">
                  {c.name} {c.isDefault && <StatusChip status="default" tone="accent" />}
                </div>
                <div className="text-2xs text-ink-300">
                  {c.levels.map((l) => `${l.level}. ${l.kind.replace('_', ' ')}`).join(' → ')}
                </div>
              </div>
              <button className="btn-danger text-2xs" onClick={() => del.mutate(c.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      {del.error && <ErrorBox error={del.error} />}

      <CreateModal
        open={creating}
        title="Add an approval chain"
        onClose={() => setCreating(false)}
        invalidate={[['leavepolicy-chains']]}
        onSubmit={() =>
          hcmApi.leavePolicy.approvalChains.create({
            name: form.name,
            isDefault: form.isDefault,
            levels: form.levels.map((l) => ({
              level: l.level,
              kind: l.kind,
              approverPartyId: l.kind === 'custom_grant' ? l.approverPartyId : undefined,
            })),
          })
        }
        onCreated={() =>
          setForm({ name: '', isDefault: false, levels: [{ level: 1, kind: 'manager', approverPartyId: '' }] })
        }
      >
        <TextInput label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
          />
          Default chain (used when a policy has none of its own)
        </label>
        <div className="space-y-2">
          {form.levels.map((l, idx) => (
            <Row key={idx}>
              <SelectInput
                label={`Level ${l.level}`}
                value={l.kind}
                onChange={(v) => updateLevel(idx, { kind: v as ApprovalChainLevel['kind'] })}
                options={[
                  { value: 'manager', label: 'Manager' },
                  { value: 'hr', label: 'HR' },
                  { value: 'custom_grant', label: 'Specific person' },
                ]}
              />
              {l.kind === 'custom_grant' ? (
                <TextInput
                  label="Party id"
                  value={l.approverPartyId ?? ''}
                  onChange={(v) => updateLevel(idx, { approverPartyId: v })}
                  required
                />
              ) : (
                <div className="flex items-end pb-2">
                  {form.levels.length > 1 && (
                    <button type="button" className="btn text-2xs" onClick={() => removeLevel(idx)}>
                      Remove level
                    </button>
                  )}
                </div>
              )}
            </Row>
          ))}
        </div>
        <button type="button" className="btn text-2xs" onClick={addLevel}>
          Add level
        </button>
      </CreateModal>
    </Card>
  );
}
