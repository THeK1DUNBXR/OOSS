import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Directory() {
  return (
    <div>
      <PageHeader title="Directory" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
