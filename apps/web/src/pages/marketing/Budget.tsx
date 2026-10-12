/**
 * Marketing budget — periods and divisions, the propose/approve split made
 * visible (hr_ops_manager proposes with `marketing_budgets:C`, finance_head
 * approves with `marketing_budgets:approve`), variance against actual spend,
 * and the vendor register.
 */

import { useMemo, useState } from 'react';
import {
  DIVISIONS,
  DIVISION_LABELS,
  CHANNEL_KEY_LABELS,
  CHANNEL_KEYS,
  type BudgetView,
  type ChannelKey,
  type SpendView,
  type VendorView,
} from '@kaizen/shared';
import { Card, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';
import { CreateModal, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';
import { NewButton } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';
import { date, money, titleCase } from '../../lib/api.js';
import { NOT_MEASURED } from '../../lib/words.js';
import {
  useApproveBudget,
  useBudgetVariance,
  useBudgets,
  useCreateBudget,
  useCreateSpend,
  useCreateVendor,
  useReconcileSpend,
  useSpends,
  useVendors,
  type BudgetVarianceRow,
} from '../../lib/marketingApi.js';

type BudgetTab = 'budgets' | 'spend' | 'vendors';

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function Budget() {
  const { can } = useSession();
  const [tab, setTab] = useState<BudgetTab>('budgets');
  const [period, setPeriod] = useState(currentPeriod());
  const [division, setDivision] = useState('');
  const [createBudgetOpen, setCreateBudgetOpen] = useState(false);
  const [recordSpendOpen, setRecordSpendOpen] = useState(false);
  const [vendorOpen, setVendorOpen] = useState(false);

  const canPropose = can('marketing_budgets:C');
  const canApprove = can('marketing_budgets:approve');

  return (
    <div>
      <PageHeader
        title="Budget"
        subtitle="Planned, committed and actual marketing spend, by period and division."
        actions={
          tab === 'budgets' && canPropose ? (
            <NewButton label="Propose budget" onClick={() => setCreateBudgetOpen(true)} />
          ) : tab === 'spend' ? (
            <NewButton label="Record spend" onClick={() => setRecordSpendOpen(true)} />
          ) : tab === 'vendors' && can('marketing_budgets:C') ? (
            <NewButton label="Add vendor" onClick={() => setVendorOpen(true)} />
          ) : undefined
        }
      />

      <Tabs
        tabs={[
          { key: 'budgets', label: 'Budgets & variance' },
          { key: 'spend', label: 'Spend' },
          { key: 'vendors', label: 'Vendors' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <Card className="mb-4" bodyClassName="p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <TextInput label="Period" value={period} onChange={setPeriod} hint="YYYY-MM or YYYY-Qn" />
          </div>
          <div className="w-44">
            <SelectInput
              label="Division"
              value={division}
              onChange={setDivision}
              placeholder="All divisions"
              options={DIVISIONS.map((d) => ({ value: d, label: DIVISION_LABELS[d] }))}
            />
          </div>
        </div>
      </Card>

      {tab === 'budgets' && <BudgetsTab period={period} division={division} canApprove={canApprove} />}
      {tab === 'spend' && <SpendTab period={period} />}
      {tab === 'vendors' && <VendorsTab />}

      <CreateBudgetModal open={createBudgetOpen} onClose={() => setCreateBudgetOpen(false)} defaultPeriod={period} />
      <RecordSpendModal open={recordSpendOpen} onClose={() => setRecordSpendOpen(false)} />
      <AddVendorModal open={vendorOpen} onClose={() => setVendorOpen(false)} />
    </div>
  );
}

const VARIANCE_COLUMNS: ReadonlyArray<DataTableColumn<BudgetVarianceRow>> = [
  {
    id: 'division',
    header: 'Division',
    cell: (v) => titleCase(v.division),
    cellClassName: 'text-xs',
    sortValue: (v) => titleCase(v.division),
  },
  {
    id: 'channel',
    header: 'Channel',
    cell: (v) => (v.channelKey ? CHANNEL_KEY_LABELS[v.channelKey] : 'All'),
    cellClassName: 'text-xs text-ink-400',
    sortValue: (v) => (v.channelKey ? CHANNEL_KEY_LABELS[v.channelKey] : 'All'),
  },
  {
    id: 'planned',
    header: 'Planned',
    align: 'right',
    cell: (v) => money(v.planned),
    cellClassName: 'text-xs',
    sortValue: (v) => v.planned,
  },
  {
    id: 'committed',
    header: 'Committed',
    align: 'right',
    cell: (v) => money(v.committed),
    cellClassName: 'text-xs',
    sortValue: (v) => v.committed,
  },
  {
    id: 'actual',
    header: 'Actual',
    align: 'right',
    cell: (v) => (v.measured ? money(v.actual) : NOT_MEASURED),
    cellClassName: 'text-xs',
    sortValue: (v) => (v.measured ? v.actual : null),
  },
  {
    id: 'variance',
    header: 'Variance',
    align: 'right',
    cell: (v) => (
      <span className={`text-xs ${v.variance < 0 ? 'text-band-critical' : 'text-band-strong'}`}>
        {v.measured ? money(v.variance) : NOT_MEASURED}
      </span>
    ),
    sortValue: (v) => (v.measured ? v.variance : null),
  },
];

function BudgetsTab({ period, division, canApprove }: { period: string; division: string; canApprove: boolean }) {
  const {
    data: budgets,
    isLoading: loadingBudgets,
    error: budgetsError,
  } = useBudgets({ period: period || undefined, division: division || undefined });
  const {
    data: variance,
    isLoading: loadingVariance,
    error: varianceError,
  } = useBudgetVariance({ period, division: division || undefined });
  const approve = useApproveBudget();

  // The Approve action closes over the mutation and the viewer's permission, so these columns live here.
  const budgetColumns: ReadonlyArray<DataTableColumn<BudgetView>> = [
    { id: 'period', header: 'Period', cell: (b) => b.period, cellClassName: 'text-xs', sortValue: (b) => b.period },
    {
      id: 'division',
      header: 'Division',
      cell: (b) => titleCase(b.division),
      cellClassName: 'text-xs',
      sortValue: (b) => titleCase(b.division),
    },
    {
      id: 'target',
      header: 'Channel / Campaign',
      cell: (b) => (b.channelKey ? CHANNEL_KEY_LABELS[b.channelKey] : (b.campaignName ?? 'All')),
      cellClassName: 'text-xs text-ink-400',
    },
    {
      id: 'planned',
      header: 'Planned',
      align: 'right',
      cell: (b) => money(b.planned),
      cellClassName: 'text-xs',
      sortValue: (b) => b.planned,
    },
    {
      id: 'committed',
      header: 'Committed',
      align: 'right',
      cell: (b) => money(b.committed),
      cellClassName: 'text-xs',
      sortValue: (b) => b.committed,
    },
    {
      id: 'spent',
      header: 'Spent',
      align: 'right',
      cell: (b) => money(b.spent),
      cellClassName: 'text-xs',
      sortValue: (b) => b.spent,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (b) => (
        <>
          <span className="text-2xs text-ink-500">
            {b.remaining >= 0 ? `${money(b.remaining)} left` : `${money(-b.remaining)} over`}
          </span>
          {canApprove && (
            <button
              className="ml-2 text-2xs text-accent-soft hover:underline"
              onClick={() => approve.mutate(b.id)}
              disabled={approve.isPending}
            >
              Approve
            </button>
          )}
        </>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Card title="Budgets" subtitle="Proposed by operations, approved by finance.">
        <DataTable
          caption="Budgets"
          columns={budgetColumns}
          rows={budgets?.items ?? []}
          rowKey={(b) => b.id}
          loading={loadingBudgets}
          error={budgetsError}
          emptyMessage="No budget has been proposed for this period yet."
          emptyHint="A budget is proposed against a division, and optionally a channel or a single campaign."
        />
      </Card>

      <Card title="Variance" subtitle="Planned vs committed vs actual, per line.">
        <DataTable
          caption="Budget variance"
          columns={VARIANCE_COLUMNS}
          rows={variance ?? []}
          rowKey={(_, index) => String(index)}
          loading={loadingVariance}
          error={varianceError}
          emptyMessage="Nothing to measure yet."
          emptyHint="Variance appears once a budget is approved for this period."
        />
      </Card>
    </div>
  );
}

function SpendTab({ period }: { period: string }) {
  const { data, isLoading, error } = useSpends({});
  const reconcile = useReconcileSpend();

  const items = useMemo(
    () => (data?.items ?? []).filter((s) => s.spendDate.slice(0, 7) === period.slice(0, 7)),
    [data, period],
  );

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const spendColumns: ReadonlyArray<DataTableColumn<SpendView>> = [
    {
      id: 'date',
      header: 'Date',
      cell: (s) => date(s.spendDate),
      cellClassName: 'text-xs',
      sortValue: (s) => s.spendDate,
    },
    {
      id: 'campaign',
      header: 'Campaign',
      cell: (s) => s.campaignName ?? '—',
      cellClassName: 'text-xs',
      sortValue: (s) => s.campaignName,
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
      cell: (s) => money(s.amount),
      cellClassName: 'text-xs',
      sortValue: (s) => s.amount,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (s) => (
        <>
          <StatusChip status={s.status} tone={s.status === 'reconciled' ? 'good' : 'neutral'} />
          {s.status === 'recorded' && (
            <button
              className="ml-2 text-2xs text-accent-soft hover:underline"
              onClick={() => reconcile.mutate({ id: s.id, body: {} })}
            >
              Reconcile
            </button>
          )}
        </>
      ),
    },
  ];

  return (
    <Card bodyClassName="p-0">
      <DataTable
        caption="Spend"
        columns={spendColumns}
        rows={items}
        rowKey={(s) => s.id}
        emptyMessage="No spend recorded this period."
      />
    </Card>
  );
}

const VENDOR_COLUMNS: ReadonlyArray<DataTableColumn<VendorView>> = [
  {
    id: 'organization',
    header: 'Organization',
    cell: (v) => v.organizationName,
    cellClassName: 'text-xs font-medium text-ink-200',
    sortValue: (v) => v.organizationName,
  },
  {
    id: 'services',
    header: 'Services',
    cell: (v) => v.services.join(', '),
    cellClassName: 'text-xs text-ink-400',
    sortValue: (v) => v.services.join(', '),
  },
  {
    id: 'contract',
    header: 'Contract',
    cell: (v) => v.contractRef ?? '—',
    cellClassName: 'text-xs text-ink-400',
    sortValue: (v) => v.contractRef,
  },
  {
    id: 'active',
    header: 'Active',
    cell: (v) => <StatusChip status={v.active ? 'active' : 'inactive'} tone={v.active ? 'good' : 'neutral'} />,
    sortValue: (v) => v.active,
  },
];

function VendorsTab() {
  const { data, isLoading, error } = useVendors();
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const items = data?.items ?? [];
  return (
    <Card bodyClassName="p-0">
      <DataTable
        caption="Vendors"
        columns={VENDOR_COLUMNS}
        rows={items}
        rowKey={(v) => v.id}
        emptyMessage="No vendors on file yet."
        emptyHint="A vendor is an existing organization tagged with the services it supplies."
      />
    </Card>
  );
}

function CreateBudgetModal({
  open,
  onClose,
  defaultPeriod,
}: {
  open: boolean;
  onClose: () => void;
  defaultPeriod: string;
}) {
  const [period, setPeriod] = useState(defaultPeriod);
  const [division, setDivision] = useState('');
  const [channelKey, setChannelKey] = useState<ChannelKey | ''>('');
  const [planned, setPlanned] = useState('');
  const [note, setNote] = useState('');
  const createBudget = useCreateBudget();

  return (
    <CreateModal
      open={open}
      title="Propose a budget"
      submitLabel="Propose"
      onClose={onClose}
      onSubmit={() =>
        createBudget.mutateAsync({
          period,
          division,
          channelKey: channelKey || undefined,
          planned: Number(planned || 0),
          note: note || undefined,
        })
      }
    >
      <Row>
        <TextInput label="Period" required value={period} onChange={setPeriod} hint="YYYY-MM or YYYY-Qn" />
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
        <SelectInput
          label="Channel"
          value={channelKey}
          onChange={(v) => setChannelKey(v as ChannelKey)}
          placeholder="All channels"
          options={CHANNEL_KEYS.map((k) => ({ value: k, label: CHANNEL_KEY_LABELS[k] }))}
        />
        <TextInput label="Planned amount" type="number" required value={planned} onChange={setPlanned} />
      </Row>
      <TextArea label="Note" value={note} onChange={setNote} hint="optional" />
    </CreateModal>
  );
}

function RecordSpendModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      onSubmit={() =>
        createSpend.mutateAsync({
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
        <SelectInput
          label="Division"
          required
          value={division}
          onChange={setDivision}
          placeholder="Choose a division"
          options={DIVISIONS.map((d) => ({ value: d, label: DIVISION_LABELS[d] }))}
        />
      </Row>
      <TextArea label="Description" required value={description} onChange={setDescription} />
    </CreateModal>
  );
}

function AddVendorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [organizationId, setOrganizationId] = useState('');
  const [services, setServices] = useState('');
  const [contractRef, setContractRef] = useState('');
  const createVendor = useCreateVendor();

  return (
    <CreateModal
      open={open}
      title="Add a vendor"
      submitLabel="Add vendor"
      onClose={onClose}
      onSubmit={() =>
        createVendor.mutateAsync({
          organizationId,
          services: services
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          contractRef: contractRef || undefined,
        })
      }
    >
      <TextInput
        label="Organization ID"
        required
        value={organizationId}
        onChange={setOrganizationId}
        hint="from the Organizations screen"
      />
      <TextInput label="Services" required value={services} onChange={setServices} hint="comma-separated" />
      <TextInput label="Contract reference" value={contractRef} onChange={setContractRef} hint="optional" />
    </CreateModal>
  );
}
