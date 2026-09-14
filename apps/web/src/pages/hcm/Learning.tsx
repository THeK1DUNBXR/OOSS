import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Learning() {
  return (
    <div>
      <PageHeader title="Learning" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
