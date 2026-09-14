/** Technology — governance (docs/plan/cio.md). Placeholder until the workstream lands. */
import { Card, EmptyState, PageHeader } from '../../components/ui.js';

function Pending({ title }: { title: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <Card><EmptyState message="Not built yet." /></Card>
    </div>
  );
}

export function ItRisks() {
  return <Pending title="Risks" />;
}

export function ItRiskDetail() {
  return <Pending title="RiskDetail" />;
}

export function ItPolicies() {
  return <Pending title="Policies" />;
}

export function ItPolicyDetail() {
  return <Pending title="PolicyDetail" />;
}

export function ItControls() {
  return <Pending title="Controls" />;
}

export function ItAccessReviews() {
  return <Pending title="AccessReviews" />;
}

export function ItAccessReviewDetail() {
  return <Pending title="AccessReviewDetail" />;
}

export function ItFindings() {
  return <Pending title="Findings" />;
}
