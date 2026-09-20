/**
 * Chairman's Office — OKRs (docs/plan/ceo-office.md §6, Phase 0 stub).
 *
 * Replaced wholesale by the owning phase once it builds this screen.
 */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Okrs() {
  return (
    <div>
      <PageHeader title="OKRs" subtitle="Company objectives and key results, aligned top to bottom." />
      <Card>
        <EmptyState message="This screen is not built yet." />
      </Card>
    </div>
  );
}
