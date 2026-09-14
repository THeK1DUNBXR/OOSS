import { Card, EmptyState, PageHeader } from '../../components/ui.js';

export function PayrollOps() {
  return (
    <div>
      <PageHeader title="Payroll ops" />
      <Card>
        <EmptyState message="Nothing here yet." hint="This part of People is being built." />
      </Card>
    </div>
  );
}
