/** Technology — portfolio (docs/plan/cio.md). Placeholder until the workstream lands. */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

function Pending({ title }: { title: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <Card><EmptyState message="Not built yet." /></Card>
    </div>
  );
}

export function ItPortfolio() {
  return <Pending title="Portfolio" />;
}

export function ItInitiativeDetail() {
  return <Pending title="InitiativeDetail" />;
}

export function ItRoadmap() {
  return <Pending title="Roadmap" />;
}

export function ItBudget() {
  return <Pending title="Budget" />;
}

export function ItTechDebt() {
  return <Pending title="TechDebt" />;
}
