/**
 * Campaign list — filters, a KPI header (live / pending approval / spend vs
 * budget), and a create dialog covering every field the contract's
 * `POST /campaigns` accepts.
 */

import { useMemo, useState } from 'react';
import {
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_OBJECTIVE_LABELS,
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUSES,
  CHANNEL_KEY_LABELS,
  CHANNEL_KEYS,
  DIVISIONS,
  DIVISION_LABELS,
  type CampaignObjective,
  type CampaignStatus,
  type ChannelKey,
} from '@kaizen/shared';
import { Card, EmptyState, ErrorBox, Loading, Metric, PageHeader, RecordCode, StatusChip } from '../../components/ui.js';
import { CreateModal, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';
import { NewButton } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';
import { money, titleCase } from '../../lib/api.js';
import { mk, useCampaigns } from '../../lib/marketingApi.js';
import { Link } from 'react-router-dom';

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  draft: 'neutral',
  pending_approval: 'warn',
  scheduled: 'accent',
  live: 'good',
  paused: 'warn',
  completed: 'neutral',
  archived: 'neutral',
  cancelled: 'bad',
};

export function Campaigns() {
  const { can } = useSession();
  const [status, setStatus] = useState<CampaignStatus | ''>('');
  const [division, setDivision] = useState('');
  const [objective, setObjective] = useState<CampaignObjective | ''>('');
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const params = useMemo(
    () => ({ status: status || undefined, division: division || undefined, q: q || undefined }),
    [status, division, q],
  );

  const { data, isLoading, error } = useCampaigns(params);
  const items = (data?.items ?? []).filter((c) => (objective ? c.objective === objective : true));

  const live = items.filter((c) => c.status === 'live').length;
  const pending = items.filter((c) => c.status === 'pending_approval').length;
  const spend = items.reduce((s, c) => s + c.budgetActual, 0);
  const planned = items.reduce((s, c) => s + c.budgetPlanned, 0);

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Campaigns"
        subtitle="Every marketing campaign, from draft to archived."
        actions={can('campaigns:C') && <NewButton label="New campaign" onClick={() => setCreateOpen(true)} />}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Metric label="Live" value={live} noActionReason="Filter the list below by status." />
        <Metric label="Pending approval" value={pending} noActionReason="Filter the list below by status." />
        <Metric label="Spend vs budget" value={`${money(spend)} / ${money(planned)}`} noActionReason="Open Budget for the breakdown." />
      </div>

      <Card className="mb-4" bodyClassName="p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[180px] flex-1">
            <TextInput label="Search" value={q} onChange={setQ} placeholder="Name or code" />
          </div>
          <div className="w-44">
            <SelectInput
              label="Status"
              value={status}
              onChange={(v) => setStatus(v as CampaignStatus)}
              placeholder="All statuses"
              options={CAMPAIGN_STATUSES.map((s) => ({ value: s, label: CAMPAIGN_STATUS_LABELS[s] }))}
            />
          </div>
          <div className="w-40">
            <SelectInput
              label="Division"
              value={division}
              onChange={setDivision}
              placeholder="All divisions"
              options={DIVISIONS.map((d) => ({ value: d, label: DIVISION_LABELS[d] }))}
            />
          </div>
          <div className="w-48">
            <SelectInput
              label="Objective"
              value={objective}
              onChange={(v) => setObjective(v as CampaignObjective)}
              placeholder="All objectives"
              options={CAMPAIGN_OBJECTIVES.map((o) => ({ value: o, label: CAMPAIGN_OBJECTIVE_LABELS[o] }))}
            />
          </div>
        </div>
      </Card>

      {isLoading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState message="No campaigns yet." hint="A campaign starts in draft and moves through approval, scheduling and launch." />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Campaign</th>
                <th>Division</th>
                <th>Objective</th>
                <th>Status</th>
                <th className="text-right">Budget</th>
                <th>Window</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <RecordCode code={c.recordCode} to={`/marketing/campaigns/${c.id}`} />
                  </td>
                  <td>
                    <Link to={`/marketing/campaigns/${c.id}`} className="text-xs font-medium text-ink-100 hover:text-accent-soft">
                      {c.name}
                    </Link>
                    <p className="text-2xs text-ink-500">{c.channelMix.map((k) => CHANNEL_KEY_LABELS[k]).join(', ')}</p>
                  </td>
                  <td className="text-xs text-ink-300">{titleCase(c.division)}</td>
                  <td className="text-xs text-ink-300">{CAMPAIGN_OBJECTIVE_LABELS[c.objective]}</td>
                  <td>
                    <StatusChip status={CAMPAIGN_STATUS_LABELS[c.status]} tone={STATUS_TONE[c.status] ?? 'neutral'} />
                  </td>
                  <td className="text-right tabular-nums text-xs">
                    {money(c.budgetActual, c.currency)} / {money(c.budgetPlanned, c.currency)}
                  </td>
                  <td className="text-xs text-ink-400">
                    {c.startAt.slice(0, 10)} – {c.endAt.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <CreateCampaignModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function ChannelMixPicker({ value, onChange }: { value: ChannelKey[]; onChange: (v: ChannelKey[]) => void }) {
  const toggle = (key: ChannelKey) => {
    onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  };
  return (
    <div className="block">
      <span className="label">Channel mix</span>
      <div className="flex flex-wrap gap-1.5">
        {CHANNEL_KEYS.map((k) => (
          <button
            type="button"
            key={k}
            onClick={() => toggle(k)}
            className={`chip cursor-pointer transition-colors ${
              value.includes(k) ? 'border-accent/50 bg-accent/10 text-accent-soft' : 'border-ink-700 bg-ink-850 text-ink-400 hover:text-ink-200'
            }`}
          >
            {CHANNEL_KEY_LABELS[k]}
          </button>
        ))}
      </div>
    </div>
  );
}

function CreateCampaignModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [objective, setObjective] = useState<CampaignObjective | ''>('');
  const [division, setDivision] = useState('');
  const [vertical, setVertical] = useState('');
  const [channelMix, setChannelMix] = useState<ChannelKey[]>([]);
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [budgetPlanned, setBudgetPlanned] = useState('');
  const [contentBrief, setContentBrief] = useState('');
  const [targetLeads, setTargetLeads] = useState('');
  const [targetEnrolments, setTargetEnrolments] = useState('');
  const [targetPipelineValue, setTargetPipelineValue] = useState('');

  const reset = () => {
    setName('');
    setObjective('');
    setDivision('');
    setVertical('');
    setChannelMix([]);
    setStartAt('');
    setEndAt('');
    setBudgetPlanned('');
    setContentBrief('');
    setTargetLeads('');
    setTargetEnrolments('');
    setTargetPipelineValue('');
  };

  return (
    <CreateModal
      open={open}
      title="New campaign"
      submitLabel="Create campaign"
      onClose={() => {
        reset();
        onClose();
      }}
      invalidate={[['mkt', 'campaigns']]}
      onCreated={() => reset()}
      onSubmit={() =>
        mk.createCampaign({
          name,
          objective: objective as CampaignObjective,
          division,
          vertical: vertical || undefined,
          channelMix,
          startAt,
          endAt,
          budgetPlanned: Number(budgetPlanned || 0),
          contentBrief: contentBrief || undefined,
          targetLeads: targetLeads ? Number(targetLeads) : undefined,
          targetEnrolments: targetEnrolments ? Number(targetEnrolments) : undefined,
          targetPipelineValue: targetPipelineValue ? Number(targetPipelineValue) : undefined,
        })
      }
    >
      <TextInput label="Name" required value={name} onChange={setName} />
      <Row>
        <SelectInput
          label="Objective"
          required
          value={objective}
          onChange={(v) => setObjective(v as CampaignObjective)}
          placeholder="Choose an objective"
          options={CAMPAIGN_OBJECTIVES.map((o) => ({ value: o, label: CAMPAIGN_OBJECTIVE_LABELS[o] }))}
        />
        <SelectInput
          label="Division"
          required
          value={division}
          onChange={setDivision}
          placeholder="Choose a division"
          options={DIVISIONS.map((d) => ({ value: d, label: DIVISION_LABELS[d] }))}
        />
      </Row>
      <Row>
        <TextInput label="Start" type="date" required value={startAt} onChange={setStartAt} />
        <TextInput label="End" type="date" required value={endAt} onChange={setEndAt} />
      </Row>
      <Row>
        <TextInput label="Budget planned" type="number" required value={budgetPlanned} onChange={setBudgetPlanned} />
        <TextInput label="Vertical" value={vertical} onChange={setVertical} hint="optional" />
      </Row>
      <ChannelMixPicker value={channelMix} onChange={setChannelMix} />
      <Row>
        <TextInput label="Target leads" type="number" value={targetLeads} onChange={setTargetLeads} hint="optional" />
        <TextInput label="Target enrolments" type="number" value={targetEnrolments} onChange={setTargetEnrolments} hint="optional" />
      </Row>
      <TextInput label="Target pipeline value" type="number" value={targetPipelineValue} onChange={setTargetPipelineValue} hint="optional" />
      <TextArea label="Content brief" value={contentBrief} onChange={setContentBrief} hint="optional" />
    </CreateModal>
  );
}
