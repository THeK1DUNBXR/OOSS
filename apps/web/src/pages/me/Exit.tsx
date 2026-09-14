import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Exit() {
  return (
    <div>
      <PageHeader title="My exit" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
