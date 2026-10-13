/**
 * The public certificate check, at `/verify/certificate/:code`. It is outside the
 * sign-in gate (main.tsx), so it fetches with no session and sends no token. It
 * shows the four fields the API returns and nothing else.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

interface PublicStatus {
  holderName: string | null;
  courseName: string | null;
  issuedAt: string;
  status: 'valid' | 'revoked' | 'invalid';
}

const STATUS_LINE: Record<PublicStatus['status'], string> = {
  valid: 'Valid. This certificate was issued by Kaizen Infinities and the completion it records stands.',
  revoked: 'Revoked. This certificate has been withdrawn and should not be relied on.',
  invalid: 'Not valid. The completion this certificate records has since been reversed.',
};

export function CertificateVerify() {
  const { code = '' } = useParams();
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'missing' } | { kind: 'error' } | { kind: 'ok'; data: PublicStatus }
  >({
    kind: 'loading',
  });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetch(`/api/compliance/public/certificates/${encodeURIComponent(code)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) return setState({ kind: 'missing' });
        if (!res.ok) return setState({ kind: 'error' });
        setState({ kind: 'ok', data: (await res.json()) as PublicStatus });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <main className="mx-auto max-w-xl px-4 py-10 text-ink-100">
      <h1 className="text-lg font-semibold">Certificate check</h1>
      {state.kind === 'loading' && <p className="mt-4 text-sm text-ink-400">Checking the certificate.</p>}
      {state.kind === 'missing' && (
        <p className="mt-4 text-sm">No certificate matches this code. Check the code and try again.</p>
      )}
      {state.kind === 'error' && <p className="mt-4 text-sm">The check could not be completed. Try again shortly.</p>}
      {state.kind === 'ok' && (
        <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-ink-400">Holder</dt>
          <dd>{state.data.holderName ?? 'Not recorded'}</dd>
          <dt className="text-ink-400">Course</dt>
          <dd>{state.data.courseName ?? 'Not recorded'}</dd>
          <dt className="text-ink-400">Issued</dt>
          <dd>{new Date(state.data.issuedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</dd>
          <dt className="text-ink-400">Status</dt>
          <dd className="col-span-1">{STATUS_LINE[state.data.status]}</dd>
        </dl>
      )}
    </main>
  );
}
