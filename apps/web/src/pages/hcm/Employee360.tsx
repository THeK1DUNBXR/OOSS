import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Employee360() {
  return (
    <div>
      <PageHeader title="Employee 360" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
