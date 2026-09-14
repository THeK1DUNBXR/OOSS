/**
 * Privacy — DPDP (docs/plan/compliance.md §G).
 *
 * Seven tabs, one per thing this workstream actually does: the notice
 * everybody is processed under, the consent rows that are the WHY axis's real
 * data, the data-principal-request workflow (access/correction/erasure), the
 * breach register with its 72-hour clock, the weekly access review, the
 * retention report (reports, never deletes), and where field-level encryption
 * stands.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, dateTime } from '../../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  PageHeader,
  RecordCode,
  StatusChip,
  Tabs,
} from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

type Tab = 'notice' | 'consents' | 'requests' | 'breaches' | 'access' | 'retention' | 'encryption';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'notice', label: 'Notice' },
  { key: 'consents', label: 'Consents' },
  { key: 'requests', label: 'Requests' },
  { key: 'breaches', label: 'Breaches' },
  { key: 'access', label: 'Access review' },
  { key: 'retention', label: 'Retention' },
  { key: 'encryption', label: 'Encryption' },
];

const statusTone = (status: string): 'neutral' | 'good' | 'warn' | 'bad' | 'accent' => {
  if (['granted', 'fulfilled', 'closed', 'current'].includes(status)) return 'good';
  if (['withdrawn', 'refused', 'superseded'].includes(status)) return 'neutral';
  if (['open', 'received'].includes(status)) return 'warn';
  return 'accent';
};

export function CompliancePrivacy() {
  const [tab, setTab] = useState<Tab>('notice');
  return (
    <>
      <PageHeader
        title="Privacy"
        subtitle="Data protection under the DPDP Act: the notice, consent, data-principal requests, the breach register, access review, retention and field encryption. This platform does not transmit filings or notices to the regulator — it prepares and records them."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'notice' && <NoticeTab />}
      {tab === 'consents' && <ConsentsTab />}
      {tab === 'requests' && <RequestsTab />}
      {tab === 'breaches' && <BreachesTab />}
      {tab === 'access' && <AccessReviewTab />}
      {tab === 'retention' && <RetentionTab />}
      {tab === 'encryption' && <EncryptionTab />}
    </>
  );
}

// ---------------------------------------------------------------------------

function NoticeTab() {
  const qc = useQueryClient();
  const notice = useQuery({ queryKey: ['privacy-notice'], queryFn: () => api.get<any>('/compliance/privacy/notice/current') });
  const ack = useMutation({
    mutationFn: () => api.post('/compliance/privacy/notice/acknowledge', { channel: 'in_app' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['privacy-notice'] }),
  });

  if (notice.isLoading) return <Loading />;
  if (notice.error) return <ErrorBox error={notice.error} />;
  const n = notice.data;
  if (!n) return <EmptyState message="No privacy notice has been published yet." />;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-50">Version {n.version}</h2>
        <button className="btn-primary" onClick={() => ack.mutate()} disabled={ack.isPending}>
          {ack.isPending ? 'Recording…' : 'Acknowledge'}
        </button>
      </div>
      <p className="mb-4 text-2xs text-ink-500">Effective from {date(n.effectiveFrom)}</p>
      <pre className="mb-4 whitespace-pre-wrap text-xs leading-relaxed text-ink-200">{n.body}</pre>
      <h3 className="mb-2 text-2xs uppercase tracking-wide text-ink-500">Purposes</h3>
      <div className="flex flex-col gap-2">
        {(n.purposes ?? []).map((p: any) => (
          <div key={p.code} className="rounded border border-ink-800 p-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium text-ink-100">{p.label}</span>
              <StatusChip status={p.lawfulBasis} />
            </div>
            <p className="mt-1 text-ink-400">{p.dataCategories?.join(', ')} — retained {p.retention}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ConsentsTab() {
  const [personId, setPersonId] = useState('');
  const [open, setOpen] = useState(false);
  const [purposeCode, setPurposeCode] = useState('');
  const [channel, setChannel] = useState('in_app');
  const qc = useQueryClient();

  const consents = useQuery({
    queryKey: ['consents', personId],
    queryFn: () => api.get<any[]>(`/compliance/privacy/consents${personId ? `?personId=${personId}` : ''}`),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => api.post(`/compliance/privacy/consents/${id}/withdraw`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consents'] }),
  });

  return (
    <>
      <Row>
        <TextInput label="Person id" value={personId} onChange={setPersonId} placeholder="Leave blank for your own" />
        <div className="flex items-end">
          <NewButton label="Grant consent" onClick={() => setOpen(true)} />
        </div>
      </Row>
      {consents.isLoading && <Loading />}
      {consents.error && <ErrorBox error={consents.error} />}
      {consents.data && consents.data.length === 0 && <EmptyState message="No consent recorded here yet." />}
      <div className="flex flex-col gap-2">
        {consents.data?.map((c) => (
          <Card key={c.id}>
            <div className="flex items-center justify-between text-xs">
              <div>
                <span className="font-medium text-ink-100">{c.purposeCode}</span>
                {c.guardianOfPersonId && <span className="ml-2 text-2xs text-ink-500">guardian consent</span>}
              </div>
              <StatusChip status={c.status} tone={statusTone(c.status)} />
            </div>
            <p className="mt-1 text-2xs text-ink-500">
              {c.grantedAt ? `Granted ${dateTime(c.grantedAt)}` : ''} {c.withdrawnAt ? `· withdrawn ${dateTime(c.withdrawnAt)}` : ''}
            </p>
            {c.status === 'granted' && (
              <button className="btn mt-2" onClick={() => withdraw.mutate(c.id)} disabled={withdraw.isPending}>
                Withdraw
              </button>
            )}
          </Card>
        ))}
      </div>
      <CreateModal
        open={open}
        title="Grant consent"
        onClose={() => setOpen(false)}
        invalidate={[['consents']]}
        onSubmit={() =>
          api.post('/compliance/privacy/consents', { personId, purposeCode, channel })
        }
      >
        <TextInput label="Person id" value={personId} onChange={setPersonId} required />
        <TextInput label="Purpose code" value={purposeCode} onChange={setPurposeCode} required hint="from the current notice" />
        <TextInput label="Channel" value={channel} onChange={setChannel} required />
      </CreateModal>
    </>
  );
}

// ---------------------------------------------------------------------------

function RequestsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [personId, setPersonId] = useState('');
  const [kind, setKind] = useState<'access' | 'correction' | 'erasure' | 'nomination'>('access');
  const [note, setNote] = useState('');

  const requests = useQuery({ queryKey: ['data-requests'], queryFn: () => api.get<any[]>('/compliance/privacy/requests') });
  const fulfil = useMutation({
    mutationFn: (id: string) => api.post(`/compliance/privacy/requests/${id}/fulfil`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['data-requests'] }),
  });

  return (
    <>
      <div className="mb-3 flex justify-end">
        <NewButton label="Raise request" onClick={() => setOpen(true)} />
      </div>
      {requests.isLoading && <Loading />}
      {requests.error && <ErrorBox error={requests.error} />}
      {requests.data && requests.data.length === 0 && <EmptyState message="No data-principal requests on file." />}
      <div className="flex flex-col gap-2">
        {requests.data?.map((r) => (
          <Card key={r.id}>
            <div className="flex items-center justify-between text-xs">
              <RecordCode code={r.recordCode} />
              <StatusChip status={r.status} tone={statusTone(r.status)} />
            </div>
            <Field label="Kind">{r.kind}</Field>
            <Field label="Due">{date(r.dueAt)}</Field>
            {r.refusalReason && <Field label="Refused because">{r.refusalReason}</Field>}
            {['received', 'verifying'].includes(r.status) && (
              <button className="btn mt-2" onClick={() => fulfil.mutate(r.id)} disabled={fulfil.isPending}>
                Fulfil
              </button>
            )}
          </Card>
        ))}
      </div>
      <CreateModal
        open={open}
        title="Raise a data-principal request"
        onClose={() => setOpen(false)}
        invalidate={[['data-requests']]}
        onSubmit={() => api.post('/compliance/privacy/requests', { personId: personId || undefined, kind, note: note || undefined })}
      >
        <TextInput label="Person id" value={personId} onChange={setPersonId} placeholder="Leave blank to raise your own" />
        <SelectInput label="Kind" value={kind} onChange={(v) => setKind(v as any)} options={['access', 'correction', 'erasure', 'nomination'].map((k) => ({ value: k, label: k }))} />
        <TextArea label="Note" value={note} onChange={setNote} />
      </CreateModal>
    </>
  );
}

// ---------------------------------------------------------------------------

function BreachesTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [detectedAt, setDetectedAt] = useState('');
  const [principalsAffected, setPrincipalsAffected] = useState('0');

  const breaches = useQuery({ queryKey: ['breaches'], queryFn: () => api.get<any[]>('/compliance/privacy/breaches') });
  const transition = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.post(`/compliance/privacy/breaches/${id}/transition`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['breaches'] }),
  });

  const nextStatus: Record<string, string> = {
    open: 'contained',
    contained: 'notified_board',
    notified_board: 'notified_principals',
    notified_principals: 'closed',
  };

  return (
    <>
      <div className="mb-3 flex justify-end">
        <NewButton label="Register breach" onClick={() => setOpen(true)} />
      </div>
      {breaches.isLoading && <Loading />}
      {breaches.error && <ErrorBox error={breaches.error} />}
      {breaches.data && breaches.data.length === 0 && <EmptyState message="No breach has been registered. That is the state to be in, not a screen that has never been looked at." />}
      <div className="flex flex-col gap-2">
        {breaches.data?.map((b) => {
          const hoursSince = (Date.now() - new Date(b.detectedAt).getTime()) / 3_600_000;
          return (
            <Card key={b.id}>
              <div className="flex items-center justify-between text-xs">
                <RecordCode code={b.recordCode} />
                <StatusChip status={b.status} tone={statusTone(b.status)} />
              </div>
              <Field label="Detected">{dateTime(b.detectedAt)}</Field>
              <Field label="Description">{b.description}</Field>
              <Field label="Principals affected">{b.principalsAffected}</Field>
              {!b.boardNotifiedAt && (
                <p className="text-2xs text-band-critical">
                  {Math.floor(hoursSince)}h since detection — the board must be notified within 72h.
                </p>
              )}
              {nextStatus[b.status] && (
                <button className="btn mt-2" onClick={() => transition.mutate({ id: b.id, status: nextStatus[b.status] })} disabled={transition.isPending}>
                  Mark {nextStatus[b.status].replace('_', ' ')}
                </button>
              )}
            </Card>
          );
        })}
      </div>
      <CreateModal
        open={open}
        title="Register a breach"
        onClose={() => setOpen(false)}
        invalidate={[['breaches']]}
        onSubmit={() =>
          api.post('/compliance/privacy/breaches', {
            description,
            detectedAt: detectedAt || new Date().toISOString(),
            principalsAffected: Number(principalsAffected) || 0,
          })
        }
      >
        <TextArea label="What happened" value={description} onChange={setDescription} required />
        <TextInput label="Detected at" value={detectedAt} onChange={setDetectedAt} placeholder="ISO timestamp, blank for now" />
        <TextInput label="Principals affected" value={principalsAffected} onChange={setPrincipalsAffected} type="number" />
      </CreateModal>
    </>
  );
}

// ---------------------------------------------------------------------------

function AccessReviewTab() {
  const qc = useQueryClient();
  const review = useQuery({ queryKey: ['access-review'], queryFn: () => api.get<any>('/compliance/privacy/access-review') });
  const run = useMutation({
    mutationFn: () => api.post('/compliance/privacy/access-review/run', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access-review'] }),
  });

  if (review.isLoading) return <Loading />;
  if (review.error) return <ErrorBox error={review.error} />;

  const findings: any[] = review.data?.findings ?? [];

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-2xs text-ink-500">{review.data ? `Last run ${dateTime(review.data.generatedAt)}` : 'Never run'}</p>
        <button className="btn-primary" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? 'Running…' : 'Run now'}
        </button>
      </div>
      {findings.length === 0 ? (
        <EmptyState message="No active affiliation without matching active employment." />
      ) : (
        <div className="flex flex-col gap-2">
          {findings.map((f) => (
            <Card key={f.affiliationId}>
              <Field label="Person">{f.fullName}</Field>
              <Field label="Employment status">{f.employmentStatus ?? 'no employment record'}</Field>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function RetentionTab() {
  const retention = useQuery({ queryKey: ['retention'], queryFn: () => api.get<any>('/compliance/privacy/retention') });
  if (retention.isLoading) return <Loading />;
  if (retention.error) return <ErrorBox error={retention.error} />;

  const snapshot: any[] = retention.data?.latest?.snapshot ?? [];
  const schedule: any[] = retention.data?.schedule ?? [];

  return (
    <>
      <Card>
        <h2 className="mb-2 text-sm font-semibold text-ink-50">Retention schedule</h2>
        <div className="flex flex-col gap-1 text-xs">
          {schedule.map((s) => (
            <div key={`${s.retentionClass}-${s.effectiveFrom}`} className="flex justify-between">
              <span>{s.retentionClass}</span>
              <span className="text-ink-400">{s.years} years, from {date(s.effectiveFrom)}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <h2 className="mb-2 text-sm font-semibold text-ink-50">
          {retention.data?.latest ? `Report — ${dateTime(retention.data.latest.generatedAt)}` : 'No report generated yet'}
        </h2>
        <p className="mb-2 text-2xs text-ink-500">Counts past window are reported, never purged automatically.</p>
        {snapshot.length === 0 ? (
          <EmptyState message="Nothing to report yet." />
        ) : (
          <div className="flex flex-col gap-1 text-xs">
            {snapshot.map((row: any) => (
              <div key={row.retentionClass} className="flex justify-between">
                <span>{row.retentionClass}</span>
                <span className={row.pastWindowCount > 0 ? 'text-band-critical' : 'text-ink-400'}>
                  {row.pastWindowCount} / {row.totalCount} past {row.years}y window
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------

function EncryptionTab() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['encryption-status'], queryFn: () => api.get<any>('/compliance/privacy/encrypt-at-rest/status') });
  const backfill = useMutation({
    mutationFn: () => api.post('/compliance/privacy/encrypt-at-rest/backfill', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['encryption-status'] }),
  });

  if (status.isLoading) return <Loading />;
  if (status.error) return <ErrorBox error={status.error} />;
  const s = status.data;

  return (
    <Card>
      <h2 className="mb-2 text-sm font-semibold text-ink-50">Field-level encryption at rest</h2>
      <p className="mb-3 text-2xs text-ink-500">
        PAN, Aadhaar and bank values on employment records. Structural exclusion from responses is not the same
        thing as encryption at rest — this is what closes that gap for what is already stored.
      </p>
      {!s?.keyConfigured && (
        <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-xs text-band-critical">
          Real encryption is not set up on this server yet — values are protected with a placeholder key. Have
          whoever manages the deployment fix this before it holds real staff data.
        </p>
      )}
      <div className="mb-3 flex gap-6 text-xs">
        <span>Encrypted: <strong className="text-ink-100">{s?.encrypted ?? 0}</strong></span>
        <span>Plaintext: <strong className="text-band-critical">{s?.plaintext ?? 0}</strong></span>
      </div>
      <button className="btn-primary" onClick={() => backfill.mutate()} disabled={backfill.isPending}>
        {backfill.isPending ? 'Encrypting…' : 'Encrypt existing values'}
      </button>
      {s?.lastRun && (
        <p className="mt-3 text-2xs text-ink-500">
          Last run {dateTime(s.lastRun.ranAt)} — {s.lastRun.valuesEncrypted} encrypted, {s.lastRun.alreadyEncrypted} already were.
        </p>
      )}
    </Card>
  );
}
