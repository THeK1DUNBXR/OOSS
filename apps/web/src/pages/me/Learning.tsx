/**
 * My learning — WS6 learning (docs/hcm/learning.md).
 *
 * My enrollments, my certifications, and my development plan. Self-nominating
 * for a session is offered; approving your own nomination is not — the
 * server refuses it, so there is no button here that would only fail.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, messageOf, NewButton, SelectInput } from '../../components/forms.js';

interface EmployeeRow {
  id: string;
}

interface Session {
  id: string;
  startsAt: string;
  status: string;
  program: { title: string; kind: string };
}

interface Enrollment {
  id: string;
  sessionId: string;
  status: string;
  score: number | null;
  feedback: string | null;
  session: { startsAt: string; program: { title: string; kind: string } };
}

interface Certification {
  id: string;
  recordCode: string;
  name: string;
  issuer: string | null;
  issuedOn: string;
  expiresOn: string | null;
  verified: boolean;
}

interface Idp {
  id: string;
  goals: { items?: string[] } | null;
  reviewDate: string | null;
  status: string;
}

export function Learning() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState('');

  const my = useQuery({ queryKey: ['me-learning-employment'], queryFn: () => api.get<EmployeeRow[]>('/hr/employees') });
  const employmentId = my.data?.[0]?.id;

  const sessions = useQuery({ queryKey: ['me-learning-sessions'], queryFn: () => api.get<Session[]>('/hcm/learning/sessions') });
  const enrollments = useQuery({
    queryKey: ['me-learning-enrollments', employmentId],
    queryFn: () => api.get<Enrollment[]>(`/hcm/learning/enrollments?employmentRelationshipId=${employmentId}`),
    enabled: Boolean(employmentId),
  });
  const certs = useQuery({
    queryKey: ['me-learning-certifications', employmentId],
    queryFn: () => api.get<Certification[]>(`/hcm/learning/certifications?employmentRelationshipId=${employmentId}`),
    enabled: Boolean(employmentId),
  });
  const idps = useQuery({
    queryKey: ['me-learning-idps', employmentId],
    queryFn: () => api.get<Idp[]>(`/hcm/learning/idps?employmentRelationshipId=${employmentId}`),
    enabled: Boolean(employmentId),
  });

  const upcomingSessions = (sessions.data ?? []).filter(
    (s) => s.status === 'scheduled' && !(enrollments.data ?? []).some((e) => e.sessionId === s.id),
  );

  const nominateSelf = useMutation({
    mutationFn: () => api.post('/hcm/learning/enrollments', { sessionId, employmentRelationshipId: employmentId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me-learning-enrollments'] }),
  });

  return (
    <>
      <PageHeader
        title="My learning"
        subtitle="Sessions you can nominate yourself for, where each nomination stands, your certifications, and your development plan."
      />

      {my.isLoading && <Loading />}
      {my.error && <ErrorBox error={my.error} />}

      {my.data && my.data.length === 0 && (
        <Card title="My learning">
          <EmptyState message="No employment record is linked to your account." hint="Ask HR to link your login to your employee record." />
        </Card>
      )}

      {employmentId && (
        <div className="space-y-4">
          <Card
            title="My enrollments"
            subtitle="Nominated → approved → attended → completed."
            actions={upcomingSessions.length > 0 ? <NewButton label="Nominate myself" onClick={() => setOpen(true)} /> : undefined}
          >
            {enrollments.isLoading && <Loading />}
            {enrollments.error && <ErrorBox error={enrollments.error} />}
            {enrollments.data && enrollments.data.length === 0 && (
              <EmptyState
                message="You have no training enrollments yet."
                hint={upcomingSessions.length > 0 ? 'Nominate yourself for an upcoming session above.' : 'No sessions are currently open to nominate into.'}
              />
            )}
            {enrollments.data && enrollments.data.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Program</th>
                    <th>Starts</th>
                    <th>Status</th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {enrollments.data.map((e) => (
                    <tr key={e.id}>
                      <td>{e.session.program.title}</td>
                      <td>{date(e.session.startsAt)}</td>
                      <td>
                        <StatusChip
                          status={e.status}
                          tone={e.status === 'completed' ? 'good' : e.status === 'rejected' || e.status === 'no_show' ? 'bad' : 'neutral'}
                        />
                      </td>
                      <td className="tabular-nums">{e.score ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="My certifications">
            {certs.isLoading && <Loading />}
            {certs.error && <ErrorBox error={certs.error} />}
            {certs.data && certs.data.length === 0 && <EmptyState message="No certifications on file yet." />}
            {certs.data && certs.data.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Issuer</th>
                    <th>Issued</th>
                    <th>Expires</th>
                    <th>Verified</th>
                  </tr>
                </thead>
                <tbody>
                  {certs.data.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{c.issuer ?? '—'}</td>
                      <td>{date(c.issuedOn)}</td>
                      <td>{c.expiresOn ? date(c.expiresOn) : 'Never'}</td>
                      <td><StatusChip status={c.verified ? 'verified' : 'unverified'} tone={c.verified ? 'good' : 'neutral'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="My development plan">
            {idps.isLoading && <Loading />}
            {idps.error && <ErrorBox error={idps.error} />}
            {idps.data && idps.data.length === 0 && (
              <EmptyState message="No development plan on file." hint="Ask your manager or HR to set one up with you." />
            )}
            {idps.data && idps.data.length > 0 && (
              <ul className="space-y-2 text-sm">
                {idps.data.map((i) => (
                  <li key={i.id} className="rounded border border-ink-800 p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <StatusChip status={i.status} tone={i.status === 'active' ? 'good' : 'neutral'} />
                      <span className="text-2xs text-ink-400">{i.reviewDate ? `Review ${date(i.reviewDate)}` : 'No review date set'}</span>
                    </div>
                    <ul className="list-inside list-disc text-ink-300">
                      {(i.goals?.items ?? []).map((g, idx) => (
                        <li key={idx}>{g}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      <CreateModal
        open={open}
        title="Nominate yourself for a session"
        submitLabel="Nominate"
        onClose={() => setOpen(false)}
        invalidate={[['me-learning-enrollments']]}
        onSubmit={() => nominateSelf.mutateAsync()}
      >
        <SelectInput
          label="Session"
          value={sessionId}
          onChange={setSessionId}
          placeholder="Choose an upcoming session"
          options={upcomingSessions.map((s) => ({ value: s.id, label: `${s.program.title} — ${date(s.startsAt)}` }))}
          required
        />
        {nominateSelf.error && <p className="text-2xs text-band-critical">{messageOf(nominateSelf.error)}</p>}
      </CreateModal>
    </>
  );
}
