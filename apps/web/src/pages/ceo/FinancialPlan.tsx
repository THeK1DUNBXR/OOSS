/**
 * Chairman's Office — Financial Plan.
 */
import { Card, Metric, PageHeader, StatusChip } from '../../components/ui.js';

const scenarios = [
  { name: 'Base case', runwayMonths: 18.4, hiringPace: 'Stable', cash: '₹8.2Cr', status: 'approved' },
  { name: 'Upside', runwayMonths: 13.2, hiringPace: 'Accelerated', cash: '₹7.4Cr', status: 'review' },
  { name: 'Downside', runwayMonths: 9.8, hiringPace: 'Deferred', cash: '₹6.1Cr', status: 'sensitivity' },
];

const lines = [
  { division: 'Software', planned: '₹4.8Cr', actual: '₹4.5Cr', variance: '+₹0.3Cr' },
  { division: 'Skill', planned: '₹2.7Cr', actual: '₹2.9Cr', variance: '-₹0.2Cr' },
  { division: 'Education', planned: '₹1.6Cr', actual: '₹1.4Cr', variance: '+₹0.2Cr' },
];

export function FinancialPlan() {
  return (
    <div className="space-y-6">
      <PageHeader title="Financial Plan" subtitle="Driver-based scenarios, runway and the 13-week cash flow." />

      <div className="grid gap-4 md:grid-cols-4">
        <Metric label="Cash position" value="₹8.2Cr" sub="Available working capital" drillTo="/ceo/financial-plan" tone="good" />
        <Metric label="Runway" value="18.4 mo" sub="At current run-rate" drillTo="/ceo/headcount-plan" tone="good" />
        <Metric label="Headcount cost" value="₹31.5L" sub="Annualised plan" drillTo="/ceo/headcount-plan" tone="neutral" />
        <Metric label="Budget ceiling" value="₹42.0L" sub="Allocated above plan" noActionReason="This is a management snapshot rather than a transaction drill" />
      </div>

      <Card title="Scenario comparison" subtitle="Base, upside and downside planning cases.">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-800 text-ink-400">
              <tr>
                <th className="px-3 py-2 font-medium">Scenario</th>
                <th className="px-3 py-2 font-medium">Runway</th>
                <th className="px-3 py-2 font-medium">Hiring pace</th>
                <th className="px-3 py-2 font-medium">Cash</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map((scenario) => (
                <tr key={scenario.name} className="border-b border-ink-800 last:border-b-0">
                  <td className="px-3 py-3 font-medium text-ink-100">{scenario.name}</td>
                  <td className="px-3 py-3 text-ink-300">{scenario.runwayMonths} months</td>
                  <td className="px-3 py-3 text-ink-300">{scenario.hiringPace}</td>
                  <td className="px-3 py-3 text-ink-300">{scenario.cash}</td>
                  <td className="px-3 py-3">
                    <StatusChip status={scenario.status} tone={scenario.status === 'approved' ? 'good' : scenario.status === 'review' ? 'warn' : 'neutral'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Budget by division" subtitle="Approved plan versus actual spend.">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-800 text-ink-400">
              <tr>
                <th className="px-3 py-2 font-medium">Division</th>
                <th className="px-3 py-2 font-medium">Planned</th>
                <th className="px-3 py-2 font-medium">Actual</th>
                <th className="px-3 py-2 font-medium">Variance</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.division} className="border-b border-ink-800 last:border-b-0">
                  <td className="px-3 py-3 font-medium text-ink-100">{line.division}</td>
                  <td className="px-3 py-3 text-ink-300">{line.planned}</td>
                  <td className="px-3 py-3 text-ink-300">{line.actual}</td>
                  <td className="px-3 py-3 text-ink-300">{line.variance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
