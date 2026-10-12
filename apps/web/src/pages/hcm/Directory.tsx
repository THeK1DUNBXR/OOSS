/**
 * Directory (docs/hcm/workforce.md) — a searchable staff list: name, seat,
 * unit and current work location, each row linking to Employee 360.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { hcmApi, type DirectoryRow } from '../../lib/hcmApi.js';
import { Card, PageHeader } from '../../components/ui.js';
import { TextInput } from '../../components/forms.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';

const COLUMNS: ReadonlyArray<DataTableColumn<DirectoryRow>> = [
  {
    id: 'name',
    header: 'Name',
    sortValue: (row) => row.person.fullName,
    cell: (row) => (
      <Link
        to={`/people/employees/${row.employmentRelationshipId}/360`}
        className="font-medium text-ink-100 hover:text-accent hover:underline"
      >
        {row.person.fullName}
      </Link>
    ),
  },
  { id: 'title', header: 'Title', sortValue: (row) => row.title, cell: (row) => row.title ?? '—' },
  { id: 'orgUnit', header: 'Org unit', sortValue: (row) => row.orgUnit, cell: (row) => row.orgUnit ?? '—' },
  {
    id: 'location',
    header: 'Location',
    sortValue: (row) => row.location?.name,
    cell: (row) => (row.location ? `${row.location.name}${row.location.city ? `, ${row.location.city}` : ''}` : '—'),
  },
  {
    id: 'contact',
    header: 'Contact',
    cellClassName: 'text-2xs text-ink-500',
    cell: (row) => row.person.primaryEmail ?? row.person.primaryPhone ?? '—',
  },
];

export function Directory() {
  const [q, setQ] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['hcm-workforce-directory', q],
    queryFn: () => hcmApi.workforce.directory(q),
  });

  return (
    <div>
      <PageHeader title="Directory" subtitle="Everyone on the books today, searchable by name." />
      <Card
        bodyClassName="p-0"
        title="Staff"
        actions={
          <div className="w-64">
            <TextInput label="" value={q} onChange={setQ} placeholder="Search by name…" />
          </div>
        }
      >
        <DataTable
          caption="Staff on the books today"
          columns={COLUMNS}
          rows={data ?? []}
          rowKey={(row) => row.employmentRelationshipId}
          loading={isLoading || !data}
          error={error}
          defaultSort={{ columnId: 'name', direction: 'asc' }}
          emptyMessage={q ? `Nobody matches "${q}".` : 'Nobody here yet.'}
          emptyHint={q ? 'Search matches names only.' : 'Staff appear here once an employment is recorded.'}
        />
      </Card>
    </div>
  );
}
