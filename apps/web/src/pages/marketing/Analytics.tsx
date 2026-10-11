/**
 * Marketing Analytics — the drill surface behind the Overview's KPI row.
 *
 * A date range and division filter sit above six tabs: the funnel with its
 * stage-to-stage conversion, channel and campaign performance, the four
 * attribution models (with the explicit "Unattributed" bucket always shown,
 * never quietly dropped), month cohorts, and CSV export. Every figure the
 * API marks unmeasured renders "Not yet measured" — never a zero, which
 * would read as a fact about the business rather than about the data.
 */

import { useMemo, useState } from 'react';
import {
  ATTRIBUTION_MODELS,
  ATTRIBUTION_MODEL_LABELS,
  CHANNEL_KEY_LABELS,
  DIVISIONS,
  DIVISION_LABELS,
  type AttributionModel,
} from '@kaizen/shared';
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, RecordCode, StatusChip, Tabs } from '../../components/ui.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';
import { SelectInput, TextInput } from '../../components/forms.js';
import { messageOf } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';
import { money, titleCase } from '../../lib/api.js';
import { NOT_MEASURED } from '../../lib/words.js';
import {
  mk,
  useCampaignPerformance,
  useChannelPerformance,
  useCohorts,
  useMarketingFunnel,
  useAttributionAnalytics,
  type AttributionRow,
  type CampaignPerfRow,
  type ChannelPerfRow,
  type CohortRow,
} from '../../lib/marketingApi.js';
import { MarketingHealthCard } from './MarketingHealthCard.js';

// Recharts takes literal SVG color props, not Tailwind classes, so these
// mirror tailwind.config.js's `ink`/`div` steps by value rather than name —
// MUTED is `ink-500`, GRID is `ink-800` (the hairline), ACCENT and the first
// four channel hues are the four `div-*` steps, in the same fixed order
// Executive.tsx and CommandCenter.tsx assign them in.
const MUTED = '#6b6b74';
const GRID = '#e7e7eb';
const ACCENT = '#2a78d6';

const CHANNEL_COLOUR: Record<string, string> = {
  email: '#2a78d6',
  sms: '#c2670f',
  whatsapp: '#12805c',
  social_meta: '#8f3d90',
  social_linkedin: '#0a66c2',
  social_youtube: '#c4302b',
  google_ads: '#e4a11b',
  website: '#57575f',
  event: '#a8481a',
  referral: '#1a7a4c',
  partner: '#8a6a00',
  print: '#6b6b74',
  walk_in: '#3d8f68',
  phone: '#b5570c',
  other: '#a9a9b4',
};

function colourFor(key: string | null): string {
  return (key && CHANNEL_COLOUR[key]) || MUTED;
}

/** `n%`, or "Not yet measured" for a rate the API declined to compute. */
function pct(v: number | null): string {
  return v === null ? NOT_MEASURED : `${(v * 100).toFixed(1)}%`;
}

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? NOT_MEASURED : v.toLocaleString('en-IN');
}

type AnalyticsTab = 'funnel' | 'channels' | 'campaigns' | 'attribution' | 'cohorts' | 'export';

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: unknown[]; label?: unknown }) {
  if (!active || !payload?.length) return null;
  const rows = payload as Array<{ name?: string; value?: number; color?: string; dataKey?: string }>;
  return (
    <div className="rounded-md border border-ink-800 bg-ink-900 px-3 py-2 shadow-floating">
      {label !== undefined && <p className="mb-1 text-2xs font-semibold uppercase tracking-wide">{String(label)}</p>}
      {rows.map((r) => (
        <div key={r.dataKey ?? r.name} className="flex items-center gap-2 text-xs">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
          <span className="text-ink-400">{r.name}</span>
          <span className="ml-auto font-semibold tabular-nums">{(r.value ?? 0).toLocaleString('en-IN')}</span>
        </div>
      ))}
    </div>
  );
}

export function Analytics() {
  const { can } = useSession();
  const [tab, setTab] = useState<AnalyticsTab>('funnel');

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const ninetyDaysAgo = useMemo(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 90);
    return d.toISOString().slice(0, 10);
  }, []);
  const [from, setFrom] = useState(ninetyDaysAgo);
  const [to, setTo] = useState(today);
  const [division, setDivision] = useState('');

  const rangeParams = useMemo(() => ({ from: from || undefined, to: to || undefined }), [from, to]);

  return (
    <div>
      <PageHeader
        title="Marketing analytics"
        subtitle="The funnel, what each channel and campaign costs to run, who gets credit for a lead, and how each month's intake goes on to convert."
        actions={
          <>
            <TextInput label="From" value={from} onChange={setFrom} type="date" />
            <TextInput label="To" value={to} onChange={setTo} type="date" />
            <div className="w-44">
              <SelectInput
                label="Division"
                value={division}
                onChange={setDivision}
                placeholder="All divisions"
                options={DIVISIONS.map((d) => ({ value: d, label: DIVISION_LABELS[d] }))}
              />
            </div>
          </>
        }
      />

      <MarketingHealthCard />

      <Tabs
        tabs={[
          { key: 'funnel', label: 'Funnel' },
          { key: 'channels', label: 'Channels' },
          { key: 'campaigns', label: 'Campaigns' },
          { key: 'attribution', label: 'Attribution' },
          { key: 'cohorts', label: 'Cohorts' },
          { key: 'export', label: 'Export' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'funnel' && <FunnelTab from={from} to={to} division={division} />}
      {tab === 'channels' && <ChannelsTab from={from} to={to} division={division} />}
      {tab === 'campaigns' && <CampaignsTab from={from} to={to} division={division} />}
      {tab === 'attribution' && <AttributionTab from={from} to={to} />}
      {tab === 'cohorts' && <CohortsTab />}
      {tab === 'export' && <ExportTab rangeParams={rangeParams} canExport={can('marketing_analytics:X')} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

function FunnelTab({ from, to, division }: { from: string; to: string; division: string }) {
  const { data, isLoading, error } = useMarketingFunnel({
    from: from || undefined,
    to: to || undefined,
    division: division || undefined,
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading) return <Loading label="Loading the funnel" />;
  if (!data) return null;

  const maxCount = Math.max(1, ...data.stages.filter((s) => s.measured).map((s) => s.count));

  return (
    <Card
      title="Touchpoint to enrolment"
      subtitle="Each bar is sized against the widest stage; the rate below it is against the stage before."
    >
      {data.stages.length === 0 ? (
        <EmptyState message="No funnel stages to show for this range." />
      ) : (
        <div className="space-y-3">
          {data.stages.map((stage, i) => {
            const rate = data.conversionRates.find((r) => r.to === stage.key)?.rate ?? null;
            const pctWidth = stage.measured ? Math.max(4, (stage.count / maxCount) * 100) : 0;
            return (
              <div key={stage.key}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium text-ink-200">{stage.label}</span>
                  <span className="tabular-nums text-ink-400">
                    {stage.measured ? (
                      stage.count.toLocaleString('en-IN')
                    ) : (
                      <span className="italic text-ink-500">{NOT_MEASURED}</span>
                    )}
                    {i > 0 && (
                      <span className="ml-2 text-ink-600">
                        {rate === null ? `· ${NOT_MEASURED}` : `· ${pct(rate)} from previous`}
                      </span>
                    )}
                  </span>
                </div>
                <div className="h-6 w-full overflow-hidden rounded-md bg-ink-850">
                  {stage.measured && (
                    <div className="h-full rounded-md bg-accent transition-all" style={{ width: `${pctWidth}%` }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

const CHANNEL_COLUMNS: ReadonlyArray<DataTableColumn<ChannelPerfRow>> = [
  {
    id: 'channel',
    header: 'Channel',
    cell: (r) => (
      <span className="inline-flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colourFor(r.channelKey) }} />
        {CHANNEL_KEY_LABELS[r.channelKey] ?? r.label}
        {!r.measured && (
          <span
            className="chip border-ink-700 bg-ink-850 text-ink-500"
            title="Not enough activity on this channel yet to trust the derived figures."
          >
            {NOT_MEASURED}
          </span>
        )}
      </span>
    ),
    sortValue: (r) => CHANNEL_KEY_LABELS[r.channelKey] ?? r.label,
  },
  {
    id: 'touchpoints',
    header: 'Touchpoints',
    align: 'right',
    cell: (r) => r.touchpoints.toLocaleString('en-IN'),
    sortValue: (r) => r.touchpoints,
  },
  {
    id: 'leads',
    header: 'Leads',
    align: 'right',
    cell: (r) => r.leads.toLocaleString('en-IN'),
    sortValue: (r) => r.leads,
  },
  {
    id: 'opportunities',
    header: 'Opportunities',
    align: 'right',
    cell: (r) => r.opportunities.toLocaleString('en-IN'),
    sortValue: (r) => r.opportunities,
  },
  { id: 'won', header: 'Won', align: 'right', cell: (r) => r.won.toLocaleString('en-IN'), sortValue: (r) => r.won },
  { id: 'spend', header: 'Spend', align: 'right', cell: (r) => money(r.spend), sortValue: (r) => r.spend },
  {
    id: 'costPerLead',
    header: 'Cost per lead',
    align: 'right',
    // An unmeasured channel's cost is not a zero to sort as one: it goes last with the other missing values.
    cell: (r) =>
      r.measured && r.costPerLead !== null ? (
        money(r.costPerLead)
      ) : (
        <span className="italic text-ink-500">{NOT_MEASURED}</span>
      ),
    sortValue: (r) => (r.measured ? r.costPerLead : null),
  },
  {
    id: 'roi',
    header: 'ROI',
    align: 'right',
    cell: (r) =>
      r.measured && r.roi !== null ? (
        `${(r.roi * 100).toFixed(0)}%`
      ) : (
        <span className="italic text-ink-500">{NOT_MEASURED}</span>
      ),
    sortValue: (r) => (r.measured ? r.roi : null),
  },
];

function ChannelsTab({ from, to, division }: { from: string; to: string; division: string }) {
  const { data = [], isLoading, error } = useChannelPerformance({ from: from || undefined, to: to || undefined });

  if (error) return <ErrorBox error={error} />;

  // The endpoint has no division cut of its own — touchpoints are not
  // division-scoped the way a campaign is — so the filter above only
  // narrows the funnel and campaign tabs. That is stated here rather than
  // silently ignored.
  const rows = data as ChannelPerfRow[];

  const chartData = rows.map((r) => ({
    label: CHANNEL_KEY_LABELS[r.channelKey] ?? r.label,
    key: r.channelKey,
    leads: r.leads,
  }));

  return (
    <div className="space-y-4">
      {division && (
        <p className="text-2xs text-ink-500">
          Channel figures are not cut by division — touchpoints do not carry one. The division filter applies to the
          Funnel and Campaigns tabs.
        </p>
      )}
      <Card title="Leads by channel">
        {isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState message="No channel activity in this range." />
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
                <CartesianGrid stroke={GRID} horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: MUTED, fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: GRID }}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={140}
                  tick={{ fill: MUTED, fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="leads" name="Leads" radius={4} maxBarSize={22}>
                  {chartData.map((d) => (
                    <Cell key={d.key} fill={colourFor(d.key)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card title="Channel performance" bodyClassName="p-0 overflow-x-auto">
        <DataTable
          caption="Channel performance"
          columns={CHANNEL_COLUMNS}
          rows={rows}
          rowKey={(r) => r.channelKey}
          emptyMessage="Nothing to show yet."
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

const CAMPAIGN_COLUMNS: ReadonlyArray<DataTableColumn<CampaignPerfRow>> = [
  {
    id: 'name',
    header: 'Campaign',
    cell: (c) => (
      <>
        <RecordCode code={c.recordCode} to={`/marketing/campaigns/${c.campaignId}`} />
        <p className="mt-0.5 text-2xs text-ink-400">{c.name}</p>
      </>
    ),
    sortValue: (c) => c.name,
  },
  { id: 'status', header: 'Status', cell: (c) => <StatusChip status={c.status} /> },
  {
    id: 'division',
    header: 'Division',
    cell: (c) => DIVISION_LABELS[c.division as keyof typeof DIVISION_LABELS] ?? titleCase(c.division),
    cellClassName: 'text-2xs text-ink-400',
  },
  {
    id: 'leads',
    header: 'Leads',
    align: 'right',
    cell: (c) => c.leads.toLocaleString('en-IN'),
    sortValue: (c) => c.leads,
  },
  {
    id: 'opportunities',
    header: 'Opportunities',
    align: 'right',
    cell: (c) => c.opportunities.toLocaleString('en-IN'),
    sortValue: (c) => c.opportunities,
  },
  { id: 'won', header: 'Won', align: 'right', cell: (c) => c.won.toLocaleString('en-IN'), sortValue: (c) => c.won },
  {
    id: 'enrolments',
    header: 'Enrolments',
    align: 'right',
    cell: (c) => c.enrolments.toLocaleString('en-IN'),
    sortValue: (c) => c.enrolments,
  },
  {
    id: 'pipelineValue',
    header: 'Pipeline value',
    align: 'right',
    cell: (c) => money(c.pipelineValue),
    sortValue: (c) => c.pipelineValue,
  },
  {
    id: 'spend',
    header: 'Spend / budget',
    align: 'right',
    cell: (c) => (
      <>
        {money(c.spend)} <span className="text-ink-600">/ {money(c.budgetPlanned)}</span>
      </>
    ),
    sortValue: (c) => c.spend,
  },
  {
    id: 'costPerLead',
    header: 'Cost per lead',
    align: 'right',
    cell: (c) =>
      c.costPerLead !== null ? money(c.costPerLead) : <span className="italic text-ink-500">{NOT_MEASURED}</span>,
    sortValue: (c) => c.costPerLead,
  },
  {
    id: 'romi',
    header: 'ROMI',
    align: 'right',
    cell: (c) =>
      c.romi !== null ? `${(c.romi * 100).toFixed(0)}%` : <span className="italic text-ink-500">{NOT_MEASURED}</span>,
    sortValue: (c) => c.romi,
  },
];

function CampaignsTab({ from, to, division }: { from: string; to: string; division: string }) {
  const { data = [], isLoading, error } = useCampaignPerformance({ from: from || undefined, to: to || undefined });

  if (error) return <ErrorBox error={error} />;

  const rows = (data as CampaignPerfRow[]).filter((r) => (division ? r.division === division : true));

  return (
    <Card
      title="Campaign performance"
      subtitle="Targets are what the campaign was set up to hit; actuals are what has happened so far."
      bodyClassName="p-0 overflow-x-auto"
    >
      <DataTable
        caption="Campaign performance"
        columns={CAMPAIGN_COLUMNS}
        rows={rows}
        rowKey={(c) => c.campaignId}
        loading={isLoading}
        emptyMessage="No campaigns in this range."
        defaultSort={{ columnId: 'spend', direction: 'desc' }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

const ATTRIBUTION_COLUMNS: ReadonlyArray<DataTableColumn<AttributionRow>> = [
  {
    id: 'campaign',
    header: 'Campaign',
    cell: (r) =>
      r.campaignId ? (
        <RecordCode code={r.campaignName} to={`/marketing/campaigns/${r.campaignId}`} />
      ) : (
        <span className="italic text-ink-500">{r.campaignName}</span>
      ),
    sortValue: (r) => r.campaignName,
  },
  {
    id: 'channel',
    header: 'Channel',
    cell: (r) => (r.channelKey ? (CHANNEL_KEY_LABELS[r.channelKey] ?? r.channelKey) : '—'),
    cellClassName: 'text-2xs text-ink-400',
    sortValue: (r) => (r.channelKey ? (CHANNEL_KEY_LABELS[r.channelKey] ?? r.channelKey) : null),
  },
  {
    id: 'weightedLeads',
    header: 'Weighted leads',
    align: 'right',
    cell: (r) => num(r.weightedLeads),
    sortValue: (r) => r.weightedLeads,
  },
  {
    id: 'weightedWon',
    header: 'Weighted won',
    align: 'right',
    cell: (r) => num(r.weightedWon),
    sortValue: (r) => r.weightedWon,
  },
  {
    id: 'weightedValue',
    header: 'Weighted value',
    align: 'right',
    cell: (r) => money(r.weightedValue),
    sortValue: (r) => r.weightedValue,
  },
];

function AttributionTab({ from, to }: { from: string; to: string }) {
  const [model, setModel] = useState<AttributionModel>('last_touch');
  const { data, isLoading, error } = useAttributionAnalytics({ model, from: from || undefined, to: to || undefined });

  if (error) return <ErrorBox error={error} />;

  const rows: AttributionRow[] = data?.rows ?? [];

  // Grouped by campaign for the stacked bar, channel-coloured — the
  // "Unattributed" bucket groups the same way, it simply has no campaignId.
  const byCampaign = new Map<string, { label: string; segments: Record<string, number> }>();
  for (const r of rows) {
    const key = r.campaignId ?? '__unattributed';
    const entry = byCampaign.get(key) ?? { label: r.campaignName, segments: {} };
    const channel = r.channelKey ?? 'other';
    entry.segments[channel] = (entry.segments[channel] ?? 0) + r.weightedLeads;
    byCampaign.set(key, entry);
  }
  const channelsPresent = [...new Set(rows.map((r) => r.channelKey ?? 'other'))];
  const chartData = [...byCampaign.entries()].map(([key, v]) => ({ key, label: v.label, ...v.segments }));

  return (
    <div className="space-y-4">
      <Card bodyClassName="p-3">
        <div className="w-64">
          <SelectInput
            label="Attribution model"
            value={model}
            onChange={(v) => setModel(v as AttributionModel)}
            options={ATTRIBUTION_MODELS.map((m) => ({ value: m, label: ATTRIBUTION_MODEL_LABELS[m] }))}
          />
        </div>
      </Card>

      <Card title="Weighted leads by campaign" subtitle="Stacked by channel, under the selected model.">
        {isLoading ? (
          <Loading />
        ) : chartData.length === 0 ? (
          <EmptyState message="Nothing attributed in this range." />
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: MUTED, fontSize: 10 }}
                  tickLine={false}
                  axisLine={{ stroke: GRID }}
                  interval={0}
                  angle={-20}
                  textAnchor="end"
                  height={56}
                />
                <YAxis tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Legend
                  wrapperStyle={{ fontSize: 11 }}
                  formatter={(v) => CHANNEL_KEY_LABELS[v as keyof typeof CHANNEL_KEY_LABELS] ?? v}
                />
                {channelsPresent.map((ch) => (
                  <Bar
                    key={ch}
                    dataKey={ch}
                    name={CHANNEL_KEY_LABELS[ch as keyof typeof CHANNEL_KEY_LABELS] ?? ch}
                    stackId="a"
                    fill={colourFor(ch)}
                    radius={0}
                    maxBarSize={40}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card
        title="Attribution detail"
        subtitle="Every lead that could not be tied to a campaign lands in Unattributed — it is never dropped from the total."
        bodyClassName="p-0 overflow-x-auto"
      >
        <DataTable
          caption="Attribution detail"
          columns={ATTRIBUTION_COLUMNS}
          rows={rows}
          rowKey={(r) => `${r.campaignId ?? 'none'}:${r.channelKey ?? 'none'}`}
          emptyMessage="Nothing to show yet."
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

const COHORT_COLUMNS: ReadonlyArray<DataTableColumn<CohortRow>> = [
  { id: 'cohort', header: 'Cohort', cell: (c) => c.cohort, sortValue: (c) => c.cohort },
  {
    id: 'leads',
    header: 'Leads',
    align: 'right',
    cell: (c) => c.leads.toLocaleString('en-IN'),
    sortValue: (c) => c.leads,
  },
  {
    id: 'converted',
    header: 'Converted',
    align: 'right',
    cell: (c) => c.converted.toLocaleString('en-IN'),
    sortValue: (c) => c.converted,
  },
  {
    id: 'enrolled',
    header: 'Enrolled',
    align: 'right',
    cell: (c) => c.enrolled.toLocaleString('en-IN'),
    sortValue: (c) => c.enrolled,
  },
  {
    id: 'rate',
    header: 'Conversion rate',
    align: 'right',
    cell: (c) => (c.rate !== null ? pct(c.rate) : <span className="italic text-ink-500">{NOT_MEASURED}</span>),
    sortValue: (c) => c.rate,
  },
];

function CohortsTab() {
  const { data = [], isLoading, error } = useCohorts({ by: 'month' });

  if (error) return <ErrorBox error={error} />;

  return (
    <Card
      title="Month cohorts"
      subtitle="Everyone whose first touch fell in a given month, and how far they have gone since."
      bodyClassName="p-0 overflow-x-auto"
    >
      <DataTable
        caption="Month cohorts"
        columns={COHORT_COLUMNS}
        rows={data}
        rowKey={(c) => c.cohort}
        loading={isLoading}
        emptyMessage="No cohorts to show yet."
        emptyHint="A cohort appears once a month has at least one lead."
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const EXPORT_KINDS: Array<{ kind: 'campaigns' | 'channels' | 'leads'; label: string; hint: string }> = [
  { kind: 'campaigns', label: 'Campaigns', hint: 'One row per campaign, with spend, targets and actuals.' },
  { kind: 'channels', label: 'Channels', hint: 'One row per channel, with touchpoints, cost per lead and ROI.' },
  { kind: 'leads', label: 'Leads', hint: 'One row per lead attributed in this range, with its source.' },
];

function ExportTab({ rangeParams, canExport }: { rangeParams: { from?: string; to?: string }; canExport: boolean }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!canExport) {
    return (
      <Card>
        <EmptyState message="Exporting analytics is not part of your access." />
      </Card>
    );
  }

  const download = async (kind: 'campaigns' | 'channels' | 'leads') => {
    setPending(kind);
    setError(null);
    try {
      await mk.exportAnalytics(
        kind,
        `marketing-${kind}-${rangeParams.from ?? 'all'}-to-${rangeParams.to ?? 'now'}.csv`,
        rangeParams,
      );
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setPending(null);
    }
  };

  return (
    <Card title="Export to CSV" subtitle="Each export uses the date range set above.">
      {error && (
        <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
          {error}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        {EXPORT_KINDS.map((k) => (
          <div key={k.kind} className="rounded-md border border-ink-800 bg-ink-900 p-4">
            <p className="text-xs font-medium text-ink-100">{k.label}</p>
            <p className="mt-1 text-2xs text-ink-500">{k.hint}</p>
            <button className="btn mt-3 w-full" disabled={pending === k.kind} onClick={() => download(k.kind)}>
              {pending === k.kind ? 'Downloading…' : 'Download CSV'}
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}
