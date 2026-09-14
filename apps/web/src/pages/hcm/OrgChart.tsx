import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function OrgChart() {
  return (
    <div>
      <PageHeader title="Org chart" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
