/**
 * Chairman's Office — Cockpit (docs/plan/ceo-office.md §6, Phase 0 stub).
 *
 * Replaced wholesale by the owning phase once it builds this screen.
 */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Cockpit() {
  return (
    <div>
      <PageHeader title="Cockpit" subtitle="North-star metrics, health, decisions and attention in one view." />
      <Card>
        <EmptyState message="This screen is not built yet." />
      </Card>
    </div>
  );
}
