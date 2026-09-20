/**
 * Chairman's Office — Time Audit (docs/plan/ceo-office.md §6, Phase 0 stub).
 *
 * Replaced wholesale by the owning phase once it builds this screen.
 */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function TimeAudit() {
  return (
    <div>
      <PageHeader title="Time Audit" subtitle="Where the chairman's time actually goes, self-logged." />
      <Card>
        <EmptyState message="This screen is not built yet." />
      </Card>
    </div>
  );
}
