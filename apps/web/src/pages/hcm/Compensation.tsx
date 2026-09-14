import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Compensation() {
  return (
    <div>
      <PageHeader title="Compensation" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
