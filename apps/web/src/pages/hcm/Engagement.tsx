import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Engagement() {
  return (
    <div>
      <PageHeader title="Engagement" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
