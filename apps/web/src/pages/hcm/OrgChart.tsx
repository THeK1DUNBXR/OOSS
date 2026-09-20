/**
 * Org chart (docs/hcm/workforce.md) — the current primary reporting-line tree,
 * built server-side from `ReportingLine` rows. Anyone with no manager, or
 * whose manager fact does not resolve, renders as a root rather than being
 * silently dropped.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui.js';

interface OrgChartNode {
  employmentRelationshipId: string;
  fullName: string;
  title: string | null;
  orgUnitName: string | null;
  directReportCount: number;
  reports: OrgChartNode[];
}

function Node({ node, depth }: { node: OrgChartNode; depth: number }) {
  return (
    <div className={depth > 0 ? 'ml-5 border-l border-ink-800 pl-4' : ''}>
      <div className="my-1.5 flex items-center gap-2 rounded border border-ink-800 bg-ink-900 px-3 py-2">
        <Link
          to={`/people/employees/${node.employmentRelationshipId}/360`}
          className="text-xs font-medium text-ink-100 hover:text-accent hover:underline"
        >
          {node.fullName}
        </Link>
        <span className="text-2xs text-ink-500">{node.title ?? 'no title on record'}</span>
        {node.orgUnitName && <span className="text-2xs text-ink-600">· {node.orgUnitName}</span>}
        {node.directReportCount > 0 && (
          <span className="chip border-ink-700 text-ink-400">{node.directReportCount} reports</span>
        )}
      </div>
      {node.reports.map((r) => (
        <Node key={r.employmentRelationshipId} node={r} depth={depth + 1} />
      ))}
    </div>
  );
}

export function OrgChart() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['hcm-workforce-org-chart'],
    queryFn: () => api.get<OrgChartNode[]>('/hcm/workforce/org-chart'),
  });

  return (
    <div>
      <PageHeader
        title="Org chart"
        subtitle="The current primary reporting line for every active employment. Set from Employee 360 → Reporting."
      />
      <Card bodyClassName="p-3">
        {error ? (
          <ErrorBox error={error} />
        ) : isLoading || !data ? (
          <Loading />
        ) : data.length === 0 ? (
          <EmptyState
            message="No reporting lines are recorded yet."
            hint="A tree appears once at least one employment has a manager set."
          />
        ) : (
          data.map((root) => <Node key={root.employmentRelationshipId} node={root} depth={0} />)
        )}
      </Card>
    </div>
  );
}
