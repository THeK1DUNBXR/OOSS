/**
 * Marketing budget — periods and divisions, the propose/approve split made
 * visible (hr_ops_manager proposes with `marketing_budgets:C`, finance_head
 * approves with `marketing_budgets:approve`), variance against actual spend,
 * and the vendor register.
 */

import { useMemo, useState } from 'react';
import { DIVISIONS, DIVISION_LABELS, CHANNEL_KEY_LABELS, CHANNEL_KEYS, type ChannelKey } from '@kaizen/shared';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
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
            <SelectInput label="Division" value={division} onChange={setDivision} placeholder="All divisions" options={DIVISIONS.map((d) => ({ value: d, label: DIVISION_LABELS[d] }))} />
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

function BudgetsTab({ period, division, canApprove }: { period: string; division: string; canApprove: boolean }) {
  const { data: budgets, isLoading: loadingBudgets, error: budgetsError } = useBudgets({ period: period || undefined, division: division || undefined });
  const { data: variance, isLoading: loadingVariance, error: varianceError } = useBudgetVariance({ period, division: division || undefined });
  const approve = useApproveBudget();

  return (
    <div className="space-y-4">
      <Card title="Budgets" subtitle="Proposed by operations, approved by finance.">
        {loadingBudgets ? (
          <Loading />
        ) : budgetsError ? (
          <ErrorBox error={budgetsError} />
        ) : !budgets || budgets.items.length === 0 ? (
          <EmptyState message="No budget has been proposed for this period yet." hint="A budget is proposed against a division, and optionally a channel or a single campaign." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Division</th>
                  <th>Channel / Campaign</th>
                  <th className="text-right">Planned</th>
                  <th className="text-right">Committed</th>
                  <th className="text-right">Spent</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {budgets.items.map((b) => (
                  <tr key={b.id}>
                    <td className="text-xs">{b.period}</td>
                    <td className="text-xs">{titleCase(b.division)}</td>
                    <td className="text-xs text-ink-400">{b.channelKey ? CHANNEL_KEY_LABELS[b.channelKey] : b.campaignName ?? 'All'}</td>
                    <td className="text-right tabular-nums text-xs">{money(b.planned)}</td>
                    <td className="text-right tabular-nums text-xs">{money(b.committed)}</td>
                    <td className="text-right tabular-nums text-xs">{money(b.spent)}</td>
                    <td>
                      <span className="text-2xs text-ink-500">{b.remaining >= 0 ? `${money(b.remaining)} left` : `${money(-b.remaining)} over`}</span>
                      {canApprove && (
                        <button className="ml-2 text-2xs text-accent-soft hover:underline" onClick={() => approve.mutate(b.id)} disabled={approve.isPending}>
                          Approve
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Variance" subtitle="Planned vs committed vs actual, per line.">
        {loadingVariance ? (
          <Loading />
        ) : varianceError ? (
          <ErrorBox error={varianceError} />
        ) : !variance || variance.length === 0 ? (
          <EmptyState message="Nothing to measure yet." hint="Variance appears once a budget is approved for this period." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Division</th>
                  <th>Channel</th>
                  <th className="text-right">Planned</th>
                  <th className="text-right">Committed</th>
                  <th className="text-right">Actual</th>
                  <th className="text-right">Variance</th>
                </tr>
              </thead>
              <tbody>
                {variance.map((v, i) => (
                  <tr key={i}>
                    <td className="text-xs">{titleCase(v.division)}</td>
                    <td className="text-xs text-ink-400">{v.channelKey ? CHANNEL_KEY_LABELS[v.channelKey] : 'All'}</td>
                    <td className="text-right tabular-nums text-xs">{money(v.planned)}</td>
                    <td className="text-right tabular-nums text-xs">{money(v.committed)}</td>
                    <td className="text-right tabular-nums text-xs">{v.measured ? money(v.actual) : NOT_MEASURED}</td>
                    <td className={`text-right tabular-nums text-xs ${v.variance < 0 ? 'text-band-critical' : 'text-band-strong'}`}>
                      {v.measured ? money(v.variance) : NOT_MEASURED}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function SpendTab({ period }: { period: string }) {
  const { data, isLoading, error } = useSpends({});
  const reconcile = useReconcileSpend();

  const items = useMemo(() => (data?.items ?? []).filter((s) => s.spendDate.slice(0, 7) === period.slice(0, 7)), [data, period]);

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  return items.length === 0 ? (
    <Card>
      <EmptyState message="No spend recorded this period." />
    </Card>
  ) : (
    <Card bodyClassName="p-0 overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Campaign</th>
            <th>Channel</th>
            <th>Vendor</th>
            <th className="text-right">Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id}>
              <td className="text-xs">{date(s.spendDate)}</td>
              <td className="text-xs">{s.campaignName ?? '—'}</td>
              <td className="text-xs">{CHANNEL_KEY_LABELS[s.channelKey]}</td>
              <td className="text-xs">{s.vendorName ?? '—'}</td>
              <td className="text-right tabular-nums text-xs">{money(s.amount)}</td>
              <td>
                <StatusChip status={s.status} tone={s.status === 'reconciled' ? 'good' : 'neutral'} />
                {s.status === 'recorded' && (
                  <button className="ml-2 text-2xs text-accent-soft hover:underline" onClick={() => reconcile.mutate({ id: s.id, body: {} })}>
                    Reconcile
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function VendorsTab() {
  const { data, isLoading, error } = useVendors();
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const items = data?.items ?? [];
  return items.length === 0 ? (
    <Card>
      <EmptyState message="No vendors on file yet." hint="A vendor is an existing organization tagged with the services it supplies." />
    </Card>
  ) : (
    <Card bodyClassName="p-0 overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Organization</th>
            <th>Services</th>
            <th>Contract</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {items.map((v) => (
            <tr key={v.id}>
              <td className="text-xs font-medium text-ink-200">{v.organizationName}</td>
              <td className="text-xs text-ink-400">{v.services.join(', ')}</td>
              <td className="text-xs text-ink-400">{v.contractRef ?? '—'}</td>
              <td>
                <StatusChip status={v.active ? 'active' : 'inactive'} tone={v.active ? 'good' : 'neutral'} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function CreateBudgetModal({ open, onClose, defaultPeriod }: { open: boolean; onClose: () => void; defaultPeriod: string }) {
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
        createBudget.mutateAsync({ period, division, channelKey: channelKey || undefined, planned: Number(planned || 0), note: note || undefined })
      }
    >
      <Row>
        <TextInput label="Period" required value={period} onChange={setPeriod} hint="YYYY-MM or YYYY-Qn" />
        <SelectInput label="Division" required value={division} onChange={setDivision} placeholder="Choose a division" options={DIVISIONS.map((d) => ({ value: d, label: DIVISION_LABELS[d] }))} />
      </Row>
      <Row>
        <SelectInput label="Channel" value={channelKey} onChange={(v) => setChannelKey(v as ChannelKey)} placeholder="All channels" options={CHANNEL_KEYS.map((k) => ({ value: k, label: CHANNEL_KEY_LABELS[k] }))} />
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
        createSpend.mutateAsync({ channelKey: channelKey as ChannelKey, division, amount: Number(amount || 0), spendDate, description })
      }
    >
      <Row>
        <SelectInput label="Channel" required value={channelKey} onChange={(v) => setChannelKey(v as ChannelKey)} placeholder="Choose a channel" options={CHANNEL_KEYS.map((k) => ({ value: k, label: CHANNEL_KEY_LABELS[k] }))} />
        <TextInput label="Date" type="date" required value={spendDate} onChange={setSpendDate} />
      </Row>
      <Row>
        <TextInput label="Amount" type="number" required value={amount} onChange={setAmount} />
        <SelectInput label="Division" required value={division} onChange={setDivision} placeholder="Choose a division" options={DIVISIONS.map((d) => ({ value: d, label: DIVISION_LABELS[d] }))} />
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
          services: services.split(',').map((s) => s.trim()).filter(Boolean),
          contractRef: contractRef || undefined,
        })
      }
    >
      <TextInput label="Organization ID" required value={organizationId} onChange={setOrganizationId} hint="from the Organizations screen" />
      <TextInput label="Services" required value={services} onChange={setServices} hint="comma-separated" />
      <TextInput label="Contract reference" value={contractRef} onChange={setContractRef} hint="optional" />
    </CreateModal>
  );
}
