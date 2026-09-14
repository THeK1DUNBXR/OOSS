/**
 * Documents shared with shareholders (and, for a director, the board too) —
 * the server narrows by audience, this screen only renders what comes back.
 */
import { useQuery } from '@tanstack/react-query';
import type { EntityDocumentView } from '@kaizen/shared';
import { api, date } from '../../lib/api.js';
import { words } from '../../lib/words.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui.js';

export function Documents() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['equity-documents', 'mine'],
    queryFn: () => api.get<{ items: EntityDocumentView[] }>('/equity/documents'),
  });

  if (error) return <ErrorBox error={error} />;
  const rows = data?.items ?? [];

  return (
    <div>
      <PageHeader title="Documents" />

      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState
          message="Nothing has been shared with shareholders yet."
          hint="A document appears here the day the company shares it with you."
        />
      ) : (
        <Card bodyClassName="p-0">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Kind</th>
                <th>Shared</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="text-ink-100">{d.title}</td>
                  <td>
                    <span className="chip border-ink-700 text-ink-400">{words(d.kind)}</span>
                  </td>
                  <td className="text-2xs text-ink-400">{date(d.createdAt)}</td>
                  <td className="text-2xs">
                    {/^https?:\/\//.test(d.fileRef) ? (
                      <a href={d.fileRef} target="_blank" rel="noreferrer" className="text-accent-soft hover:underline">
                        Open
                      </a>
                    ) : (
                      <span className="mono text-ink-500">{d.fileRef}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
