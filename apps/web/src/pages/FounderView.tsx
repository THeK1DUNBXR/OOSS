/**
 * The founder's exception view (OP:120).
 *
 * One number per source, and the oldest rows underneath. A number says what it
 * counts and where it leads, or why it leads nowhere; a source that could not be
 * measured says so and is never shown as zero, and a source the role may not
 * read is withheld, not counted.
 */

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  FOUNDER_SOURCE_LABELS,
  type FounderRow,
  type FounderSourceKind,
  type FounderSourceStatus,
  type FounderTimestampKind,
  type FounderViewResponse,
} from '@kaizen/shared';
import { api, relative, titleCase } from '../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, Metric, PageHeader, RecordCode } from '../components/ui.js';

/** Where each source's number leads. Only routes main serves; the rest say why they do not. */
const SOURCE_DRILL: Partial<Record<FounderSourceKind, string>> = {
  exception: '/exceptions',
  decision: '/command/decisions',
  approval_step: '/commercial/approvals',
};

const SOURCE_NO_DRILL: Partial<Record<FounderSourceKind, string>> = {
  commitment:
    'There is no commitments screen yet. Each row below opens system history, which does not filter to one record.',
  case: 'There is no cases screen yet. Each row below opens system history, which does not filter to one record.',
};

const TIMESTAMP_WORDS: Record<FounderTimestampKind, string> = {
  raised_at: 'Raised',
  due_at: 'Due',
  requested_at: 'Requested',
  response_due_at: 'Response due',
};

export function FounderView() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['founder-view'],
    queryFn: () => api.get<FounderViewResponse>('/command/founder-view'),
    refetchInterval: 120_000,
  });

  if (isLoading) return <Loading label="Gathering what needs a person" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const kinds = Object.keys(data.sources) as FounderSourceKind[];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Founder view"
        subtitle="Everything open that needs a person, from one list. A source that cannot be measured says so; it is never counted as zero."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {kinds.map((kind) => (
          <SourceMetric key={kind} kind={kind} status={data.sources[kind]} />
        ))}
      </div>

      <Card title="Oldest first" subtitle="Up to fifty of each source. The number above is the whole count.">
        {data.rows.length === 0 ? (
          <EmptyState message="Nothing open in the sources that could be measured." />
        ) : (
          <RowsTable rows={data.rows} />
        )}
      </Card>
    </div>
  );
}

function SourceMetric({ kind, status }: { kind: FounderSourceKind; status: FounderSourceStatus }) {
  const label = FOUNDER_SOURCE_LABELS[kind];
  const action = SOURCE_DRILL[kind]
    ? { drillTo: SOURCE_DRILL[kind]! }
    : { noActionReason: SOURCE_NO_DRILL[kind] ?? 'This source has no screen yet.' };

  if (status.status === 'measured') {
    const more = status.count > status.shown;
    return (
      <Metric
        label={label}
        value={status.count}
        tone={status.count === 0 ? 'good' : 'warn'}
        sub={more ? `Showing the oldest ${status.shown}` : status.count === 0 ? 'Nothing open' : undefined}
        {...action}
      />
    );
  }

  if (status.status === 'not_measured') {
    return <Metric label={label} value="Not measured" tone="bad" sub={status.reason} {...action} />;
  }

  return <Metric label={label} value="Withheld" sub={status.reason} {...action} />;
}

function RowsTable({ rows }: { rows: FounderRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>What</th>
            <th>Record</th>
            <th>Owner</th>
            <th>State</th>
            <th>When</th>
            <th>Rung</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.sourceKind}:${r.sourceId}`}>
              <td>
                <p className="text-2xs text-ink-400">{FOUNDER_SOURCE_LABELS[r.sourceKind]}</p>
                <p className="text-ink-100">{r.title}</p>
              </td>
              <td>
                <RecordCode code={r.recordCode} />
              </td>
              <td>
                {r.ownerName ?? (
                  // An owner id that did not resolve is not the same fact as no owner at all.
                  <span className="text-ink-500">
                    {r.ownerPartyId === null ? 'Nobody named' : 'Not found in this tenant'}
                  </span>
                )}
              </td>
              <td>{titleCase(r.state)}</td>
              <td title={r.timestamp}>
                {TIMESTAMP_WORDS[r.timestampKind]} {relative(r.timestamp)}
              </td>
              <td className="tabular-nums">{r.escalationRung ?? '—'}</td>
              <td>
                <Link to={r.drillTo} className="text-accent-soft hover:text-accent hover:underline">
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
