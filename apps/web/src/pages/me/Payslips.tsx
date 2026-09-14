import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function Payslips() {
  return (
    <div>
      <PageHeader title="My payslips" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
