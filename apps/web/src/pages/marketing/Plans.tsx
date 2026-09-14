/**
 * Quarterly marketing plans — list, create, approve and close.
 */

import { useState } from 'react';
import { DIVISIONS, DIVISION_LABELS, PLAN_STATUS_LABELS, PLAN_TRANSITIONS, type PlanStatus } from '@kaizen/shared';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';
import { titleCase } from '../../lib/api.js';
import { useApprovePlan, useClosePlan, useCreatePlan, usePlans } from '../../lib/marketingApi.js';

const STATUS_TONE: Record<PlanStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
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
          <EmptyState message="No plan has been created yet." hint="A plan groups a quarter's campaigns under one theme and set of goals." />
        </Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Period</th>
                <th>Division</th>
                <th>Theme</th>
                <th>Status</th>
                <th className="text-right">Campaigns</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => {
                const allowed = new Set(PLAN_TRANSITIONS[p.status]);
                return (
                  <tr key={p.id}>
                    <td className="text-xs">{p.period}</td>
                    <td className="text-xs">{titleCase(p.division)}</td>
                    <td className="text-xs font-medium text-ink-200">{p.theme}</td>
                    <td>
                      <StatusChip status={PLAN_STATUS_LABELS[p.status]} tone={STATUS_TONE[p.status]} />
                    </td>
                    <td className="text-right tabular-nums text-xs">{p.campaignIds.length}</td>
                    <td className="text-right">
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
        <SelectInput label="Division" required value={division} onChange={setDivision} placeholder="Choose a division" options={DIVISIONS.map((d) => ({ value: d, label: DIVISION_LABELS[d] }))} />
      </Row>
      <TextInput label="Theme" required value={theme} onChange={setTheme} />
      <TextArea label="Goals" value={goals} onChange={setGoals} hint="optional, free text" />
    </CreateModal>
  );
}
