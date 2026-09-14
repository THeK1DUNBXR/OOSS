/**
 * Directory (docs/hcm/workforce.md) — a searchable staff list: name, seat,
 * unit and current work location, each row linking to Employee 360.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui.js';
import { TextInput } from '../../components/forms.js';

interface DirectoryRow {
  employmentRelationshipId: string;
  recordCode: string;
  status: string;
  person: { id: string; fullName: string; primaryEmail: string | null; primaryPhone: string | null };
  title: string | null;
  orgUnit: string | null;
  location: { name: string; city: string | null } | null;
}

export function Directory() {
  const [q, setQ] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['hcm-workforce-directory', q],
    queryFn: () => api.get<DirectoryRow[]>(`/hcm/workforce/directory${q ? `?q=${encodeURIComponent(q)}` : ''}`),
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
        {error ? (
          <div className="p-4">
            <ErrorBox error={error} />
          </div>
        ) : isLoading || !data ? (
          <Loading />
        ) : data.length === 0 ? (
          <EmptyState message={q ? `Nobody matches "${q}".` : 'Nobody here yet.'} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Title</th>
                <th>Org unit</th>
                <th>Location</th>
                <th>Contact</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.employmentRelationshipId}>
                  <td>
                    <Link
                      to={`/people/employees/${row.employmentRelationshipId}/360`}
                      className="font-medium text-ink-100 hover:text-accent hover:underline"
                    >
                      {row.person.fullName}
                    </Link>
                  </td>
                  <td>{row.title ?? '—'}</td>
                  <td>{row.orgUnit ?? '—'}</td>
                  <td>{row.location ? `${row.location.name}${row.location.city ? `, ${row.location.city}` : ''}` : '—'}</td>
                  <td className="text-2xs text-ink-500">{row.person.primaryEmail ?? row.person.primaryPhone ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
