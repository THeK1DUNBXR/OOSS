/**
 * Chairman's Office — Approvals Inbox (docs/plan/ceo-office.md §6, Phase 0 stub).
 *
 * Replaced wholesale by the owning phase once it builds this screen.
 */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Approvals() {
  return (
    <div>
      <PageHeader title="Approvals Inbox" subtitle="Everything waiting on the chairman's sign-off, in one place." />
      <Card>
        <EmptyState message="This screen is not built yet." />
      </Card>
    </div>
  );
}
