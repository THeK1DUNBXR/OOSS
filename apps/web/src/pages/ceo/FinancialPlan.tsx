/**
 * Chairman's Office — Financial Plan (docs/plan/ceo-office.md §6, Phase 0 stub).
 *
 * Replaced wholesale by the owning phase once it builds this screen.
 */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function FinancialPlan() {
  return (
    <div>
      <PageHeader title="Financial Plan" subtitle="Driver-based scenarios, runway and the 13-week cash flow." />
      <Card>
        <EmptyState message="This screen is not built yet." />
      </Card>
    </div>
  );
}
