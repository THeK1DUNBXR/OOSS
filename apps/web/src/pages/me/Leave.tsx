import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Leave() {
  return (
    <div>
      <PageHeader title="My leave" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
