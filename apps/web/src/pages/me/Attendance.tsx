import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Attendance() {
  return (
    <div>
      <PageHeader title="My attendance" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
