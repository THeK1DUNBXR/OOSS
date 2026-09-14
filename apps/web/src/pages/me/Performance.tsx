import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Performance() {
  return (
    <div>
      <PageHeader title="My performance" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
