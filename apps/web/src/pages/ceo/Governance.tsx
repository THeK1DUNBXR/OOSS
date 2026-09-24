/**
 * Chairman's Office — Governance Overview.
 */
import { Card, Metric, PageHeader, StatusChip } from '../../components/ui.js';

const governance = [
  { domain: 'Board pack readiness', health: 'Good', owner: 'Company Secretary', status: 'On track' },
  { domain: 'Policy review cadence', health: 'Watch', owner: 'Legal', status: '2 due this month' },
  { domain: 'Approval gates', health: 'Good', owner: 'Finance Head', status: 'No overdue decisions' },
  { domain: 'Audit evidence', health: 'Watch', owner: 'Internal Audit', status: '6 items pending' },
];

export function Governance() {
  return (
    <div className="space-y-6">
      <PageHeader title="Governance Overview" subtitle="Open risks, overdue policy reviews, the DoA summary and board compliance." />

      <div className="grid gap-4 md:grid-cols-4">
        <Metric label="Open risk items" value="2" sub="1 critical" drillTo="/ceo/risks" tone="warn" />
        <Metric label="Policies due" value="3" sub="2 within 30 days" drillTo="/ceo/policies" tone="bad" />
        <Metric label="Approval queue" value="5" sub="Across budgets and hires" drillTo="/ceo/approvals" tone="neutral" />
        <Metric label="Evidence gap" value="6" sub="Items waiting for sign-off" noActionReason="Board pack readiness is a scheduled review, not an inline drill target" />
      </div>

      <Card title="Governance summary" subtitle="The current leadership control view.">
        <div className="grid gap-4 md:grid-cols-2">
          {governance.map((item) => (
            <div key={item.domain} className="rounded-lg border border-ink-800 bg-ink-900 p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-ink-100">{item.domain}</h3>
                <StatusChip status={item.health} tone={item.health === 'Good' ? 'good' : 'warn'} />
              </div>
              <div className="mt-3 text-xs text-ink-400">Owner: {item.owner}</div>
              <div className="mt-1 text-sm text-ink-200">{item.status}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
