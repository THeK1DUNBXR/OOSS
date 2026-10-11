/**
 * Quarterly marketing plans — list, create, approve and close.
 */

import { useState } from 'react';
import {
  DIVISIONS,
  DIVISION_LABELS,
  MARKETING_PLAN_STATUS_LABELS,
  MARKETING_PLAN_TRANSITIONS,
  type MarketingPlanStatus,
  type PlanView,
} from '@kaizen/shared';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';
import { titleCase } from '../../lib/api.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';
import { useApprovePlan, useClosePlan, useCreatePlan, usePlans } from '../../lib/marketingApi.js';

const STATUS_TONE: Record<MarketingPlanStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  draft: 'neutral',
  approved: 'accent',
  active: 'good',
  closed: 'neutral',
};

export function Plans() {
  const { can } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, error } = usePlans();
  const approve = useApprovePlan();
  const close = useClosePlan();

  const canWrite = can('marketing_settings:E');
  const canApprove = can('marketing_settings:approve');

  const planColumns: ReadonlyArray<DataTableColumn<PlanView>> = [
    { id: 'period', header: 'Period', sortValue: (p) => p.period, cellClassName: 'text-xs', cell: (p) => p.period },
    {
      id: 'division',
      header: 'Division',
      sortValue: (p) => p.division,
      cellClassName: 'text-xs',
      cell: (p) => titleCase(p.division),
    },
    {
      id: 'theme',
      header: 'Theme',
      sortValue: (p) => p.theme,
      cellClassName: 'text-xs font-medium text-ink-200',
      cell: (p) => p.theme,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (p) => p.status,
      cell: (p) => <StatusChip status={MARKETING_PLAN_STATUS_LABELS[p.status]} tone={STATUS_TONE[p.status]} />,
    },
    {
      id: 'campaigns',
      header: 'Campaigns',
      align: 'right',
      sortValue: (p) => p.campaignIds.length,
      cellClassName: 'tabular-nums text-xs',
      cell: (p) => p.campaignIds.length,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (p) => {
        const allowed = new Set(MARKETING_PLAN_TRANSITIONS[p.status]);
        return (
          <>
            {canApprove && allowed.has('approved') && (
              <button className="text-2xs text-accent-soft hover:underline" onClick={() => approve.mutate(p.id)}>
                Approve
              </button>
            )}
            {canWrite && allowed.has('closed') && (
              <button className="ml-2 text-2xs text-accent-soft hover:underline" onClick={() => close.mutate(p.id)}>
                Close
              </button>
            )}
          </>
        );
      },
    },
  ];

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader
        title="Plans"
        subtitle="Quarterly marketing plans — theme, goals and the campaigns under them."
        actions={canWrite && <NewButton label="New plan" onClick={() => setCreateOpen(true)} />}
      />

      {isLoading ? (
        <Loading />
      ) : !data || data.items.length === 0 ? (
        <Card>
          <EmptyState
            message="No plan has been created yet."
            hint="A plan groups a quarter's campaigns under one theme and set of goals."
          />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <DataTable
            caption="Marketing plans by period"
            columns={planColumns}
            rows={data.items}
            rowKey={(p) => p.id}
            emptyMessage="No plan has been created yet."
            emptyHint="A plan groups a quarter's campaigns under one theme and set of goals."
          />
        </Card>
      )}

      <CreatePlanModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreatePlanModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [period, setPeriod] = useState('');
  const [division, setDivision] = useState('');
  const [theme, setTheme] = useState('');
  const [goals, setGoals] = useState('');
  const createPlan = useCreatePlan();

  return (
    <CreateModal
      open={open}
      title="New quarterly plan"
      submitLabel="Create plan"
      onClose={onClose}
      onSubmit={() => createPlan.mutateAsync({ period, division, theme, goals: goals || undefined })}
    >
      <Row>
        <TextInput label="Period" required value={period} onChange={setPeriod} hint="e.g. 2026-Q4" />
        <SelectInput
          label="Division"
          required
          value={division}
          onChange={setDivision}
          placeholder="Choose a division"
          options={DIVISIONS.map((d) => ({ value: d, label: DIVISION_LABELS[d] }))}
        />
      </Row>
      <TextInput label="Theme" required value={theme} onChange={setTheme} />
      <TextArea label="Goals" value={goals} onChange={setGoals} hint="optional, free text" />
    </CreateModal>
  );
}
