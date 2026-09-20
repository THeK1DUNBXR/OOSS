/**
 * Chairman's Office — Headcount Plan (docs/plan/ceo-office.md §6, Phase 0 stub).
 *
 * Replaced wholesale by the owning phase once it builds this screen.
 */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Headcount() {
  return (
    <div>
      <PageHeader title="Headcount Plan" subtitle="Planned headcount and compensation envelope by division." />
      <Card>
        <EmptyState message="This screen is not built yet." />
      </Card>
    </div>
  );
}
