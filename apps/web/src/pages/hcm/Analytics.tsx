import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Analytics() {
  return (
    <div>
      <PageHeader title="Analytics" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
