/**
 * The share certificate — form SH-1 (s.46), as printed.
 *
 * Every figure comes from the certificate's own snapshot, computed server
 * side and unchanged by anything that happens to other shares afterwards —
 * the same discipline `InvoiceDocument.tsx` holds. The API supplies no
 * `countInWords` field for this view, so the figures in words are omitted
 * here rather than computed on the client (equity-portal plan §7: no
 * arithmetic — and no client-side number-to-words either — on a printed
 * figure).
 */
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { CertificateDocumentView, CertificateView } from '@kaizen/shared';
import { api, date } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, ErrorBox, Loading } from '../../components/ui.js';
import { Sheet, rupees } from '../documentSheet.js';

export function CertificateDocument() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const inPortal = user?.archetype === 'portal';

  const { data, isLoading, error } = useQuery({
    queryKey: ['equity-certificate-document', id],
    queryFn: () => api.get<CertificateDocumentView>(`/equity/certificates/${id}/document`),
    enabled: Boolean(id),
  });
  const { data: cert } = useQuery({
    queryKey: ['equity-certificate', id],
    queryFn: () => api.get<CertificateView>(`/equity/certificates/${id}`),
    enabled: Boolean(id),
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Loading label="Preparing the certificate" />;

  const watermark = cert && cert.status !== 'issued' ? (cert.status === 'surrendered' ? 'SURRENDERED' : 'CANCELLED') : null;

  return (
    <Sheet
      backTo={inPortal ? '/portal/certificates' : '/equity/register'}
      backLabel={inPortal ? 'Certificates' : 'Register'}
      title={`Share certificate ${data.certificateNumber}`}
      subtitle={`Issued ${date(data.issuedOn)}`}
      watermark={watermark}
      aside={
        cert && (
          <Card title="Status" subtitle="Not on the certificate itself — it stays fixed once issued.">
            <p className="text-xs text-ink-300">
              {cert.status === 'issued' && 'Issued and current.'}
              {cert.status === 'surrendered' && 'Surrendered — superseded by a later certificate.'}
              {cert.status === 'cancelled' && 'Cancelled.'}
            </p>
            {cert.supersededById && (
              <p className="mt-1 text-2xs text-ink-500">
                See{' '}
                <a href={`/equity/certificates/${cert.supersededById}/document`} className="text-accent-soft hover:underline">
                  the certificate that replaced it
                </a>
                .
              </p>
            )}
          </Card>
        )
      }
    >
      <header className="doc-head">
        <div>
          <h2 className="doc-supplier">{data.companyLegalName}</h2>
          <p className="doc-muted">{data.registeredAddress || 'Registered office not on file'}</p>
          <p className="doc-ids">
            {data.companyCin ? (
              <>
                <strong>CIN</strong> {data.companyCin}
              </>
            ) : (
              <span className="doc-flag">No CIN on file.</span>
            )}
          </p>
        </div>
        <div className="doc-title">
          <p className="doc-doctype">Share Certificate</p>
          <table className="doc-meta">
            <tbody>
              <tr>
                <th>Certificate no.</th>
                <td>{data.certificateNumber}</td>
              </tr>
              <tr>
                <th>Issued on</th>
                <td>{date(data.issuedOn)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </header>

      <section className="doc-parties">
        <div>
          <p className="doc-label">This is to certify that</p>
          <p className="doc-party-name">{data.holderNameSnapshot}</p>
          <p className="doc-muted">Folio {data.folioNumber}</p>
        </div>
        <div>
          <p className="doc-label">Is the registered holder of</p>
          <p className="doc-party-name">
            {data.count.toLocaleString('en-IN')} {data.shareClassName}
          </p>
          <p className="doc-muted">Face value ₹{rupees(data.faceValue)} each</p>
        </div>
      </section>

      <table className="doc-table">
        <thead>
          <tr>
            <th>Class</th>
            <th className="num">Distinctive numbers</th>
            <th className="num">Count</th>
            <th className="num">Face value</th>
            <th className="num">Paid up</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{data.shareClassName}</td>
            <td className="num">
              {data.distinctiveFrom} to {data.distinctiveTo}
            </td>
            <td className="num">{data.count.toLocaleString('en-IN')}</td>
            <td className="num">₹{rupees(data.faceValue)}</td>
            <td className="num">₹{rupees(data.paidUpAmount)}</td>
          </tr>
        </tbody>
      </table>

      <section className="doc-section">
        <p>
          Given under the common seal of the company.
        </p>
        <div className="mt-3 flex justify-end">
          <div className="flex h-20 w-20 items-center justify-center rounded-full border border-dashed border-ink-700 text-center text-2xs text-ink-500">
            Common seal
          </div>
        </div>
      </section>

      <footer className="doc-terms">
        <div className="grid grid-cols-2 gap-8">
          {data.signatories.map((s) => (
            <div key={s.name} className="doc-signature" style={{ textAlign: 'left' }}>
              <p className="doc-sign-line">{s.name}</p>
              <p className="doc-muted">{s.designation}</p>
            </div>
          ))}
        </div>
      </footer>
    </Sheet>
  );
}
