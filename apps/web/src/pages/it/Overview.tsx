/** Technology — overview (docs/plan/cio.md). Placeholder until the workstream lands. */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

function Pending({ title }: { title: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <Card><EmptyState message="Not built yet." /></Card>
    </div>
  );
}

export function ItOverview() {
  return <Pending title="Overview" />;
}
