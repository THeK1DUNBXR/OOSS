import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function LeavePolicies() {
  return (
    <div>
      <PageHeader title="Leave policies" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
