/**
 * Chairman's Office — Risk Register.
 */
import { Card, Metric, PageHeader, StatusChip } from '../../components/ui.js';

const risks = [
  {
    title: 'Signal latency in the payroll orchestration',
    category: 'Operations',
    owner: 'Ritu Sharma',
    likelihood: 'Likely',
    impact: 'High',
    status: 'mitigating',
    mitigation: 'Add a payroll preflight queue and 2-step sign-off before files are released.',
    reviewDate: '2026-10-12',
  },
  {
    title: 'Vendor concentration in KYC document review',
    category: 'Third party',
    owner: 'Amit Nair',
    likelihood: 'Possible',
    impact: 'High',
    status: 'open',
    mitigation: 'Dual-source review for high-value transactions and keep an escalation path for anomalies.',
    reviewDate: '2026-10-03',
  },
  {
    title: 'Data residency gap for a new customer region',
    category: 'Compliance',
    owner: 'Sana Khan',
    likelihood: 'Possible',
    impact: 'Critical',
    status: 'closed',
    mitigation: 'Confirm backup and restore targets remain in India before tenant activation.',
    reviewDate: '2026-09-28',
  },
];

export function Risk() {
  return (
    <div className="space-y-6">
      <PageHeader title="Risk Register" subtitle="Named risks, their mitigation and their owners." />

      <div className="grid gap-4 md:grid-cols-3">
        <Metric label="Open risks" value="2" sub="1 critical / 1 high" drillTo="/ceo/governance" tone="warn" />
        <Metric label="Mitigating" value="1" sub="Action plan currently tracked" drillTo="/ceo/governance" tone="neutral" />
        <Metric label="Review due" value="3" sub="Within the next 30 days" drillTo="/ceo/policies" tone="bad" />
      </div>

      <Card title="Current register" subtitle="Updated weekly by the board secretariat.">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-800 text-ink-400">
              <tr>
                <th className="px-3 py-2 font-medium">Risk</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Impact</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Review</th>
              </tr>
            </thead>
            <tbody>
              {risks.map((risk) => (
                <tr key={risk.title} className="border-b border-ink-800 last:border-b-0">
                  <td className="px-3 py-3 align-top">
                    <div className="font-medium text-ink-100">{risk.title}</div>
                    <div className="mt-1 text-xs text-ink-400">{risk.mitigation}</div>
                  </td>
                  <td className="px-3 py-3 align-top text-ink-300">{risk.category}</td>
                  <td className="px-3 py-3 align-top text-ink-300">{risk.owner}</td>
                  <td className="px-3 py-3 align-top">
                    <span className={`chip ${risk.impact === 'Critical' ? 'border-band-critical/40 bg-band-critical/10 text-band-critical' : 'border-band-watch/40 bg-band-watch/10 text-band-watch'}`}>
                      {risk.impact}
                    </span>
                  </td>
                  <td className="px-3 py-3 align-top text-ink-300">
                    <StatusChip status={risk.status} tone={risk.status === 'closed' ? 'good' : risk.status === 'open' ? 'bad' : 'warn'} />
                  </td>
                  <td className="px-3 py-3 align-top text-ink-300">{risk.reviewDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
