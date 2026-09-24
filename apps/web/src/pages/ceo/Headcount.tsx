/**
 * Chairman's Office — Headcount Plan.
 */
import { Card, Metric, PageHeader, StatusChip } from '../../components/ui.js';

const divisions = [
  { division: 'Software', planned: 38, actual: 35, hiring: 6, comp: '₹16.4L' },
  { division: 'Skill', planned: 24, actual: 22, hiring: 3, comp: '₹8.7L' },
  { division: 'Education', planned: 16, actual: 18, hiring: 1, comp: '₹6.2L' },
];

export function Headcount() {
  return (
    <div className="space-y-6">
      <PageHeader title="Headcount Plan" subtitle="Planned headcount and compensation envelope by division." />

      <div className="grid gap-4 md:grid-cols-3">
        <Metric label="Planned hires" value="10" sub="Across the next two quarters" drillTo="/ceo/financial-plan" />
        <Metric label="Monthly payroll" value="₹31.5L" sub="Pre-approval baseline" drillTo="/ceo/financial-plan" tone="neutral" />
        <Metric label="Variance to plan" value="-2" sub="Lower than projected staffing" noActionReason="This is a portfolio-level planning view, not a per-person approval drill" />
      </div>

      <Card title="Division plan" subtitle="Planned versus actual staffing and annualised cost envelope.">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-800 text-ink-400">
              <tr>
                <th className="px-3 py-2 font-medium">Division</th>
                <th className="px-3 py-2 font-medium">Planned</th>
                <th className="px-3 py-2 font-medium">Actual</th>
                <th className="px-3 py-2 font-medium">Open hires</th>
                <th className="px-3 py-2 font-medium">Comp. envelope</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {divisions.map((division) => (
                <tr key={division.division} className="border-b border-ink-800 last:border-b-0">
                  <td className="px-3 py-3 font-medium text-ink-100">{division.division}</td>
                  <td className="px-3 py-3 text-ink-300">{division.planned}</td>
                  <td className="px-3 py-3 text-ink-300">{division.actual}</td>
                  <td className="px-3 py-3 text-ink-300">{division.hiring}</td>
                  <td className="px-3 py-3 text-ink-300">{division.comp}</td>
                  <td className="px-3 py-3">
                    <StatusChip status={division.actual >= division.planned ? 'on track' : 'watch'} tone={division.actual >= division.planned ? 'good' : 'warn'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
