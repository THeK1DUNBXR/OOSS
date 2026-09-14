import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Assets() {
  return (
    <div>
      <PageHeader title="Assets & requests" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
