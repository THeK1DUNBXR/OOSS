/**
 * A shareholder's own certificates, printable from here.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { CertificateView } from '@kaizen/shared';
import { api, date } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';

export function Certificates() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['equity-certificates', 'mine'],
    queryFn: () => api.get<{ items: CertificateView[] }>('/equity/certificates'),
  });

  if (error) return <ErrorBox error={error} />;
  const rows = data?.items ?? [];

  return (
    <div>
      <PageHeader title="Certificates" />

      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState
          message="No certificate has been issued to you yet."
          hint="A certificate appears here the day it is issued, and can be printed from this screen."
        />
      ) : (
        <Card bodyClassName="p-0">
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Status</th>
                <th>Issued</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="mono text-2xs">{c.certificateNumber}</td>
                  <td>
                    <StatusChip status={c.status} tone={c.status === 'issued' ? 'good' : 'neutral'} />
                  </td>
                  <td className="text-2xs text-ink-400">{date(c.issuedOn)}</td>
                  <td>
                    <Link to={`/equity/certificates/${c.id}/document`} className="btn-ghost">
                      View and print
                    </Link>
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
