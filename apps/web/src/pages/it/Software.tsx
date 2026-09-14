/** Technology — software (docs/plan/cio.md). Placeholder until the workstream lands. */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

function Pending({ title }: { title: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <Card><EmptyState message="Not built yet." /></Card>
    </div>
  );
}

export function ItApplications() {
  return <Pending title="Applications" />;
}

export function ItApplicationDetail() {
  return <Pending title="ApplicationDetail" />;
}

export function ItLicences() {
  return <Pending title="Licences" />;
}

export function ItLicenceDetail() {
  return <Pending title="LicenceDetail" />;
}
