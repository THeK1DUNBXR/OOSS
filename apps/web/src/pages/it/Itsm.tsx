/** Technology — itsm (docs/plan/cio.md). Placeholder until the workstream lands. */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

function Pending({ title }: { title: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <Card><EmptyState message="Not built yet." /></Card>
    </div>
  );
}

export function ItIncidents() {
  return <Pending title="Incidents" />;
}

export function ItIncidentDetail() {
  return <Pending title="IncidentDetail" />;
}

export function ItProblems() {
  return <Pending title="Problems" />;
}

export function ItProblemDetail() {
  return <Pending title="ProblemDetail" />;
}

export function ItChanges() {
  return <Pending title="Changes" />;
}

export function ItChangeDetail() {
  return <Pending title="ChangeDetail" />;
}
