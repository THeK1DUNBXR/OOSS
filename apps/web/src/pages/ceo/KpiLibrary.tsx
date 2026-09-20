/**
 * Chairman's Office — KPI Library (docs/plan/ceo-office.md §6, Phase 0 stub).
 *
 * Replaced wholesale by the owning phase once it builds this screen.
 */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function KpiLibrary() {
  return (
    <div>
      <PageHeader title="KPI Library" subtitle="Every KPI definition, its formula lineage and its owner." />
      <Card>
        <EmptyState message="This screen is not built yet." />
      </Card>
    </div>
  );
}
