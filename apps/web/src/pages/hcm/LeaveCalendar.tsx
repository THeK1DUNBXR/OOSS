import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function LeaveCalendar() {
  return (
    <div>
      <PageHeader title="Leave calendar" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
