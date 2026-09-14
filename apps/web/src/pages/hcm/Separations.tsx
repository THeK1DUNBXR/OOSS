import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Separations() {
  return (
    <div>
      <PageHeader title="Separations" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
