/**
 * Chairman's Office — Risk Register (docs/plan/ceo-office.md §6, Phase 0 stub).
 *
 * Replaced wholesale by the owning phase once it builds this screen.
 */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Risk() {
  return (
    <div>
      <PageHeader title="Risk Register" subtitle="Named risks, their mitigation and their owners." />
      <Card>
        <EmptyState message="This screen is not built yet." />
      </Card>
    </div>
  );
}
