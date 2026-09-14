import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Time() {
  return (
    <div>
      <PageHeader title="Time" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
