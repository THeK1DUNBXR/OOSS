/**
 * Chairman's Office — Board Pack (docs/plan/ceo-office.md §6, Phase 0 stub).
 *
 * Replaced wholesale by the owning phase once it builds this screen.
 */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function BoardPack() {
  return (
    <div>
      <PageHeader title="Board Pack" subtitle="The board pack the secretary compiles and the chairman issues." />
      <Card>
        <EmptyState message="This screen is not built yet." />
      </Card>
    </div>
  );
}
