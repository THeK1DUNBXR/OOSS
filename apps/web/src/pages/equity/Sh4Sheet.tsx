/**
 * Form SH-4 — the pre-filled transfer instrument (s.56), as printed.
 *
 * Every figure comes from the transaction's own record, computed server
 * side — the same discipline `CertificateDocument.tsx` holds. The stamp duty
 * figure is either a computed one (demat, 0.015%) or explicitly absent with
 * the reason named; nothing here guesses a state rate.
 */
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Sh4Data } from '@kaizen/shared';
import { api, date } from '../../lib/api.js';
import { ErrorBox, Loading } from '../../components/ui.js';
import { Sheet, rupees } from '../documentSheet.js';

export function Sh4Sheet() {
  const { transactionId } = useParams<{ transactionId: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['equity-sh4', transactionId],
    queryFn: () => api.get<Sh4Data>(`/equity/filings/sh-4.pdf-data?transactionId=${transactionId}`),
    enabled: Boolean(transactionId),
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Loading label="Preparing form SH-4" />;

  return (
    <Sheet
      backTo="/equity/filings"
      backLabel="Filings"
      title={`Form SH-4 — ${data.transactionRecordCode}`}
      subtitle={data.effectiveOn ? `Effective ${date(data.effectiveOn)}` : 'Not yet effective'}
    >
      <header className="doc-head">
        <div>
          <h2 className="doc-supplier">{data.companyLegalName}</h2>
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
          <p className="doc-doctype">Securities Transfer Form (SH-4)</p>
          <table className="doc-meta">
            <tbody>
              <tr>
                <th>Reference</th>
                <td>{data.transactionRecordCode}</td>
              </tr>
              <tr>
                <th>Class</th>
                <td>{data.shareClassName}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </header>

      <section className="doc-parties">
        <div>
          <p className="doc-label">Transferor</p>
          <p className="doc-party-name">{data.transferor.name}</p>
          <p className="doc-muted">Folio {data.transferor.folioNumber}</p>
          <p className="doc-muted">{data.transferor.address || 'Address not on file'}</p>
        </div>
        <div>
          <p className="doc-label">Transferee</p>
          <p className="doc-party-name">{data.transferee.name}</p>
          <p className="doc-muted">Folio {data.transferee.folioNumber}</p>
          <p className="doc-muted">{data.transferee.address || 'Address not on file'}</p>
        </div>
      </section>

      <table className="doc-table">
        <thead>
          <tr>
            <th>Class</th>
            <th className="num">Distinctive numbers</th>
            <th className="num">Certificate numbers</th>
            <th className="num">Count</th>
            <th className="num">Price per share</th>
            <th className="num">Consideration</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{data.shareClassName}</td>
            <td className="num">
              {data.distinctiveFrom && data.distinctiveTo ? `${data.distinctiveFrom} to ${data.distinctiveTo}` : 'Not yet assigned'}
            </td>
            <td className="num">{data.certificateNumbers.length ? data.certificateNumbers.join(', ') : 'Not yet assigned'}</td>
            <td className="num">{data.count.toLocaleString('en-IN')}</td>
            <td className="num">{data.pricePerShare == null ? '—' : `₹${rupees(data.pricePerShare)}`}</td>
            <td className="num">{data.consideration == null ? '—' : `₹${rupees(data.consideration)}`}</td>
          </tr>
        </tbody>
      </table>

      <section className="doc-section">
        <p>
          <strong>Form of holding.</strong> {data.dematLeg ? 'Dematerialised.' : 'Physical.'}
        </p>
        <p>
          <strong>Stamp duty.</strong>{' '}
          {data.stampDuty != null
            ? `₹${rupees(data.stampDuty)} (0.015% of consideration, demat transfer).`
            : data.stampDutyNote ?? 'Not recorded.'}
        </p>
      </section>

      <footer className="doc-terms">
        <div className="grid grid-cols-2 gap-8">
          <div className="doc-signature" style={{ textAlign: 'left' }}>
            <p className="doc-sign-line">Transferor</p>
          </div>
          <div className="doc-signature" style={{ textAlign: 'left' }}>
            <p className="doc-sign-line">Transferee</p>
          </div>
        </div>
      </footer>
    </Sheet>
  );
}
