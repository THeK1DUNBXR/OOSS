import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Recruiting() {
  return (
    <div>
      <PageHeader title="Recruiting" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
