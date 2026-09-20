/**
 * Chairman's Office — Policy Register (docs/plan/ceo-office.md §6, Phase 0 stub).
 *
 * Replaced wholesale by the owning phase once it builds this screen.
 */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Policies() {
  return (
    <div>
      <PageHeader title="Policy Register" subtitle="The company's own operating policies, versioned." />
      <Card>
        <EmptyState message="This screen is not built yet." />
      </Card>
    </div>
  );
}
