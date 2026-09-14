import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Requests() {
  return (
    <div>
      <PageHeader title="My requests" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
