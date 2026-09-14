/** Technology — servicedesk (docs/plan/cio.md). Placeholder until the workstream lands. */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

function Pending({ title }: { title: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <Card><EmptyState message="Not built yet." /></Card>
    </div>
  );
}

export function ItTickets() {
  return <Pending title="Tickets" />;
}

export function ItTicketDetail() {
  return <Pending title="TicketDetail" />;
}

export function ItKnowledge() {
  return <Pending title="Knowledge" />;
}

export function ItKnowledgeDetail() {
  return <Pending title="KnowledgeDetail" />;
}

export function MyIt() {
  return <Pending title="MyIt" />;
}
