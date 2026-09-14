import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Money() {
  return (
    <div>
      <PageHeader title="My money" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
