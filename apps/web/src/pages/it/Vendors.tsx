/** Technology — vendors (docs/plan/cio.md). Placeholder until the workstream lands. */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

function Pending({ title }: { title: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <Card><EmptyState message="Not built yet." /></Card>
    </div>
  );
}

export function ItVendors() {
  return <Pending title="Vendors" />;
}

export function ItVendorDetail() {
  return <Pending title="VendorDetail" />;
}

export function ItVendorContracts() {
  return <Pending title="VendorContracts" />;
}

export function ItVendorContractDetail() {
  return <Pending title="VendorContractDetail" />;
}
