import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Approvals() {
  return (
    <div>
      <PageHeader title="Approvals" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
