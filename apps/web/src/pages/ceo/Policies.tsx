/**
 * Chairman's Office — Policy Register.
 */
import { Card, Metric, PageHeader, StatusChip } from '../../components/ui.js';

const policies = [
  {
    title: 'Expense Approvals',
    owner: 'Finance Office',
    version: 'v4.2',
    status: 'active',
    reviewDue: '2026-10-19',
    acknowledgements: '124',
  },
  {
    title: 'Vendor Risk Assessment',
    owner: 'Procurement',
    version: 'v3.1',
    status: 'active',
    reviewDue: '2026-09-30',
    acknowledgements: '87',
  },
  {
    title: 'Data Retention / Erasure',
    owner: 'Legal & Privacy',
    version: 'v2.8',
    status: 'draft',
    reviewDue: '2026-11-08',
    acknowledgements: '0',
  },
];

export function Policies() {
  return (
    <div className="space-y-6">
      <PageHeader title="Policy Register" subtitle="Versioned policies and acknowledgement status for the company." />

      <div className="grid gap-4 md:grid-cols-3">
        <Metric label="Active policies" value="14" sub="Across six governance domains" drillTo="/ceo/governance" />
        <Metric label="Due this month" value="3" sub="One overdue and two due soon" drillTo="/ceo/risks" tone="warn" />
        <Metric label="Acknowledge rate" value="96%" sub="All named policy owners have signed" noActionReason="Snapshot of current acknowledgement status" />
      </div>

      <Card title="Policy register" subtitle="Review cadence and owner accountability.">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-800 text-ink-400">
              <tr>
                <th className="px-3 py-2 font-medium">Policy</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium">Review due</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Acknowledged</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.title} className="border-b border-ink-800 last:border-b-0">
                  <td className="px-3 py-3 font-medium text-ink-100">{policy.title}</td>
                  <td className="px-3 py-3 text-ink-300">{policy.owner}</td>
                  <td className="px-3 py-3 text-ink-300">{policy.version}</td>
                  <td className="px-3 py-3 text-ink-300">{policy.reviewDue}</td>
                  <td className="px-3 py-3">
                    <StatusChip status={policy.status} tone={policy.status === 'draft' ? 'warn' : 'good'} />
                  </td>
                  <td className="px-3 py-3 text-ink-300">{policy.acknowledgements}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
