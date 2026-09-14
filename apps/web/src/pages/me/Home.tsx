import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Home() {
  return (
    <div>
      <PageHeader title="My home" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
