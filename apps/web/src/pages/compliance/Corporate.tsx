/**
 * Compliance — corporate, contracts and security hygiene
 * (docs/plan/compliance.md, H).
 *
 * Nine tabs, each stating its own boundary the way the GST returns screen
 * already does: this platform prepares and records, it does not file with
 * the MCA portal, sign a document itself, or act as a certifying authority.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, dateTime, money } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
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
import { CreateModal, TextArea, TextInput, messageOf } from '../../components/forms.js';

type Tab = 'security' | 'registrations' | 'registers' | 'board' | 'mca' | 'contracts' | 'fema' | 'refunds' | 'certificates';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'security', label: 'Security' },
  { key: 'registrations', label: 'Registrations' },
  { key: 'registers', label: 'Registers' },
  { key: 'board', label: 'Board' },
  { key: 'mca', label: 'MCA filings' },
  { key: 'contracts', label: 'Contracts' },
  { key: 'fema', label: 'FEMA' },
  { key: 'refunds', label: 'Refunds' },
  { key: 'certificates', label: 'Certificates' },
];

export function ComplianceCorporate() {
  const [tab, setTab] = useState<Tab>('security');
  return (
    <>
      <PageHeader
        title="Corporate"
        subtitle="Statutory registers, board minutes, MCA filings, contract stamp duty and e-signature, FEMA, refunds, certificates, and the platform's own security hygiene. It does not file with the MCA portal, sign a document itself, or act as an e-signature certifying authority — each of those is a named boundary below, not a silent gap."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'security' && <SecurityTab />}
      {tab === 'registrations' && <RegistrationsTab />}
      {tab === 'registers' && <RegistersTab />}
      {tab === 'board' && <BoardTab />}
      {tab === 'mca' && <McaTab />}
      {tab === 'contracts' && <ContractsTab />}
      {tab === 'fema' && <FemaTab />}
      {tab === 'refunds' && <RefundsTab />}
      {tab === 'certificates' && <CertificatesTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

interface SecurityPolicyView {
  mfaRequiredForRoleSlugs: string[];
  sessionHours: number;
  passwordMinLength: number;
}
interface BackupRunView {
  id: string;
  status: string;
  path: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
interface MfaEnrolResult {
  secret: string;
  otpauthUri: string;
}

function SecurityTab() {
  const { user } = useSession();
  const qc = useQueryClient();
  const policy = useQuery({ queryKey: ['cmp-corporate', 'security-policy'], queryFn: () => api.get<SecurityPolicyView>('/compliance/corporate/security/policy') });
  const backups = useQuery({ queryKey: ['cmp-corporate', 'backups'], queryFn: () => api.get<BackupRunView[]>('/compliance/corporate/security/backups') });

  const [enrolment, setEnrolment] = useState<MfaEnrolResult | null>(null);
  const [code, setCode] = useState('');

  const enrol = useMutation({
    mutationFn: () => api.post<MfaEnrolResult>('/auth/mfa/enrol'),
    onSuccess: setEnrolment,
  });
  const confirm = useMutation({
    mutationFn: () => api.post('/auth/mfa/confirm', { code }),
    onSuccess: () => {
      setEnrolment(null);
      setCode('');
    },
  });
  const runBackup = useMutation({
    mutationFn: () => api.post('/compliance/corporate/security/backups/run'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cmp-corporate', 'backups'] }),
  });

  const mfaRequired = policy.data?.mfaRequiredForRoleSlugs.includes(user?.roleSlug ?? '') ?? false;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Your second factor" subtitle="A TOTP code from an authenticator app (Google Authenticator, Authy, 1Password).">
        {mfaRequired && (
          <p className="mb-3 text-2xs text-band-warning">
            The {user?.roleSlug.replace('_', ' ')} role requires MFA to approve a refund, an MCA filing, or an e-signature request.
          </p>
        )}
        {!enrolment ? (
          <button className="btn-primary" onClick={() => enrol.mutate()} disabled={enrol.isPending}>
            {enrol.isPending ? 'Requesting…' : 'Enrol MFA'}
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-2xs text-ink-400">Scan this into an authenticator app, or enter the secret manually. Shown once.</p>
            <p className="break-all rounded bg-ink-950 p-2 font-mono text-2xs text-ink-200">{enrolment.secret}</p>
            <TextInput label="Code from the app" value={code} onChange={setCode} placeholder="123456" />
            <button className="btn-primary" onClick={() => confirm.mutate()} disabled={confirm.isPending || code.length !== 6}>
              {confirm.isPending ? 'Confirming…' : 'Confirm enrolment'}
            </button>
            {confirm.isError && <ErrorBox error={confirm.error} />}
          </div>
        )}
      </Card>

      <Card title="Policy" subtitle="Chairman-only to change.">
        {policy.isLoading ? <Loading /> : policy.data && (
          <dl>
            <Field label="MFA required for">{policy.data.mfaRequiredForRoleSlugs.join(', ') || 'nobody'}</Field>
            <Field label="Session length">{policy.data.sessionHours} hours</Field>
            <Field label="Password minimum length">{policy.data.passwordMinLength} characters</Field>
          </dl>
        )}
      </Card>

      <Card title="Backups" subtitle="A daily pg_dump when BACKUP_DIR is set. Unset is a quiet no-op, not a failure." className="lg:col-span-2">
        <button className="btn mb-3" onClick={() => runBackup.mutate()} disabled={runBackup.isPending}>
          {runBackup.isPending ? 'Running…' : 'Run now'}
        </button>
        {backups.isLoading ? (
          <Loading />
        ) : !backups.data?.length ? (
          <EmptyState message="No backup has run yet." />
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-2xs uppercase text-ink-500">
                <th className="py-1">Started</th>
                <th>Status</th>
                <th>Size</th>
                <th>SHA-256</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {backups.data.map((b) => (
                <tr key={b.id} className="border-t border-ink-800">
                  <td className="py-1">{dateTime(b.startedAt)}</td>
                  <td><StatusChip status={b.status} tone={b.status === 'completed' ? 'good' : b.status === 'failed' ? 'bad' : 'neutral'} /></td>
                  <td>{b.sizeBytes ? `${(b.sizeBytes / 1024).toFixed(0)} KB` : '—'}</td>
                  <td className="max-w-[10rem] truncate font-mono text-2xs">{b.sha256 ?? '—'}</td>
                  <td className="max-w-xs truncate text-band-critical">{b.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

interface CompanyProfileView {
  legalName: string;
  gstin: string | null;
  pan: string | null;
  cin: string | null;
  tan: string | null;
  udyamNumber: string | null;
}

function RegistrationsTab() {
  const profile = useQuery({ queryKey: ['company-profile'], queryFn: () => api.get<CompanyProfileView>('/books/company-profile') });
  if (profile.isLoading) return <Loading />;
  if (!profile.data) return <EmptyState message="No company profile yet." />;
  const p = profile.data;
  return (
    <Card title="Registrations" subtitle="Edited from Settings → Company details. Shown here as the facts the rest of this page relies on.">
      <dl>
        <Field label="Legal name">{p.legalName}</Field>
        <Field label="GSTIN">{p.gstin ?? '—'}</Field>
        <Field label="PAN">{p.pan ?? '—'}</Field>
        <Field label="TAN">{p.tan ?? '—'}</Field>
        <Field label="CIN">{p.cin ?? '—'}</Field>
        <Field label="Udyam registration">{p.udyamNumber ?? '—'}</Field>
      </dl>
      {p.pan && p.gstin && (
        <p className="mt-2 text-2xs text-band-good">The GSTIN's embedded PAN agrees with the company PAN — the platform checks this on every save.</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Registers
// ---------------------------------------------------------------------------

const REGISTER_KINDS = ['members', 'directors', 'charges', 'kmp', 'related_party'] as const;

function RegistersTab() {
  const [kind, setKind] = useState<(typeof REGISTER_KINDS)[number]>('directors');
  const [open, setOpen] = useState(false);
  const [subjectKey, setSubjectKey] = useState('');
  const [bodyText, setBodyText] = useState('{}');

  const entries = useQuery({
    queryKey: ['cmp-corporate', 'registers', kind],
    queryFn: () => api.get<Array<{ id: string; recordCode: string; subjectKey: string; body: Record<string, unknown>; createdAt: string; supersedesId: string | null }>>(`/compliance/corporate/registers/${kind}/current`),
  });

  return (
    <Card
      title="Statutory registers"
      subtitle="Append-only: a change is a new entry that supersedes the last one for that subject, never an edit."
      actions={
        <div className="flex gap-2">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {REGISTER_KINDS.map((k) => (
              <option key={k} value={k}>{k.replace('_', ' ')}</option>
            ))}
          </select>
          <button className="btn" onClick={() => api.download(`/compliance/corporate/registers/${kind}/export.csv`, `${kind}-register.csv`)}>
            Export CSV
          </button>
          <button className="btn-primary" onClick={() => setOpen(true)}>Add entry</button>
        </div>
      }
    >
      {entries.isLoading ? (
        <Loading />
      ) : !entries.data?.length ? (
        <EmptyState message={`No current ${kind.replace('_', ' ')} register entries.`} />
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-2xs uppercase text-ink-500">
              <th className="py-1">Code</th>
              <th>Subject</th>
              <th>Details</th>
              <th>As of</th>
            </tr>
          </thead>
          <tbody>
            {entries.data.map((e) => (
              <tr key={e.id} className="border-t border-ink-800">
                <td className="py-1"><RecordCode code={e.recordCode} /></td>
                <td>{e.subjectKey}</td>
                <td className="max-w-md truncate font-mono text-2xs">{JSON.stringify(e.body)}</td>
                <td>{date(e.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title={`Add a ${kind.replace('_', ' ')} entry`}
        submitLabel="Add"
        onClose={() => setOpen(false)}
        invalidate={[['cmp-corporate', 'registers', kind]]}
        onSubmit={() => api.post('/compliance/corporate/registers', { registerKind: kind, subjectKey, body: JSON.parse(bodyText || '{}') })}
      >
        <TextInput label="Subject key" value={subjectKey} onChange={setSubjectKey} placeholder="e.g. director:din-01234567" />
        <TextArea label="Details (JSON)" value={bodyText} onChange={setBodyText} rows={5} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

interface BoardResolutionView {
  id: string;
  recordCode: string;
  number: number;
  subject: string;
  kind: string;
  passedOn: string;
  correctsId: string | null;
}
interface BoardMeetingView {
  id: string;
  recordCode: string;
  kind: string;
  heldOn: string;
  status: string;
  minutes: string | null;
  resolutions: BoardResolutionView[];
}

function BoardTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [heldOn, setHeldOn] = useState('');
  const meetings = useQuery({ queryKey: ['cmp-corporate', 'board'], queryFn: () => api.get<BoardMeetingView[]>('/compliance/corporate/board/meetings') });

  const record = useMutation({
    mutationFn: (id: string) => api.post(`/compliance/corporate/board/meetings/${id}/record`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cmp-corporate', 'board'] }),
  });

  return (
    <Card
      title="Board minutes"
      subtitle="Distinct from a business Decision — a statutory record. A recorded meeting's resolutions are final; a correction is a new resolution."
      actions={<button className="btn-primary" onClick={() => setOpen(true)}>New meeting</button>}
    >
      {meetings.isLoading ? (
        <Loading />
      ) : !meetings.data?.length ? (
        <EmptyState message="No board meetings recorded yet." />
      ) : (
        <div className="space-y-3">
          {meetings.data.map((m) => (
            <div key={m.id} className="rounded border border-ink-800 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <RecordCode code={m.recordCode} /> <span className="ml-2 text-xs text-ink-300">{m.kind.toUpperCase()} — {date(m.heldOn)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusChip status={m.status} tone={m.status === 'recorded' ? 'good' : 'neutral'} />
                  {m.status === 'draft' && (
                    <button className="btn text-2xs" onClick={() => record.mutate(m.id)} disabled={record.isPending}>Record</button>
                  )}
                </div>
              </div>
              {m.resolutions.length > 0 && (
                <ul className="mt-2 space-y-1 text-2xs text-ink-400">
                  {m.resolutions.map((r) => (
                    <li key={r.id}>
                      #{r.number} — {r.subject} ({r.kind}){r.correctsId ? ' — corrects an earlier resolution' : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <CreateModal
        open={open}
        title="New board meeting"
        onClose={() => setOpen(false)}
        invalidate={[['cmp-corporate', 'board']]}
        onSubmit={() => api.post('/compliance/corporate/board/meetings', { kind: 'board', heldOn })}
      >
        <TextInput label="Held on" type="date" value={heldOn} onChange={setHeldOn} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// MCA filings
// ---------------------------------------------------------------------------

interface McaFilingTypeView { form: string; label: string; dueRule: string }
interface McaFilingView { id: string; form: string; fy: string; status: string; srn: string | null; filedOn: string | null }

function McaTab() {
  const types = useQuery({ queryKey: ['cmp-corporate', 'mca-types'], queryFn: () => api.get<McaFilingTypeView[]>('/compliance/corporate/mca/filings/types') });
  const filings = useQuery({ queryKey: ['cmp-corporate', 'mca'], queryFn: () => api.get<McaFilingView[]>('/compliance/corporate/mca/filings') });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="What the MCA expects" subtitle="AOC-4, MGT-7/7A, DIR-3 KYC, ADT-1, DPT-3, MSME-1. This platform does not file — it records the filing once it is done.">
        <ul className="space-y-1.5 text-xs">
          {types.data?.map((t) => (
            <li key={t.form}>
              <span className="font-medium text-ink-100">{t.form}</span> — {t.label}
              <p className="text-2xs text-ink-500">{t.dueRule}</p>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Filed">
        {filings.isLoading ? <Loading /> : !filings.data?.length ? (
          <EmptyState message="Nothing filed yet." />
        ) : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-2xs uppercase text-ink-500"><th>Form</th><th>FY</th><th>Status</th><th>SRN</th></tr></thead>
            <tbody>
              {filings.data.map((f) => (
                <tr key={f.id} className="border-t border-ink-800">
                  <td className="py-1">{f.form}</td><td>{f.fy}</td>
                  <td><StatusChip status={f.status} tone={f.status === 'filed' ? 'good' : 'neutral'} /></td>
                  <td>{f.srn ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contracts: stamp duty, e-signature, retention
// ---------------------------------------------------------------------------

interface StampDutyRuleView { id: string; agreementKind: string; percentOfValue: string | null; flatAmount: string | null; note: string | null }
interface RetentionRuleView { id: string; documentKind: string; anchor: string; years: number }

function ContractsTab() {
  const rules = useQuery({ queryKey: ['cmp-corporate', 'stamp-duty'], queryFn: () => api.get<StampDutyRuleView[]>('/compliance/corporate/contracts/stamp-duty-rules') });
  const retention = useQuery({ queryKey: ['cmp-corporate', 'retention'], queryFn: () => api.get<RetentionRuleView[]>('/compliance/corporate/contracts/retention-rules') });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Stamp duty" subtitle="Checked when an MoU/Contract/Partner agreement is marked signed. Placeholder figures — confirm against the current TN Stamp Act schedule.">
        {rules.data?.map((r) => (
          <Field key={r.id} label={r.agreementKind}>
            {r.percentOfValue ? `${r.percentOfValue}% of value` : r.flatAmount ? money(Number(r.flatAmount)) : '—'}
            <p className="text-2xs text-ink-500">{r.note}</p>
          </Field>
        ))}
      </Card>
      <Card title="E-signature" subtitle="No provider is configured — every request returns ESIGN_NOT_CONFIGURED until one is set up (Aadhaar eSign or DSC).">
        <EmptyState message="No e-signature provider configured for this tenant." />
      </Card>
      <Card title="Document retention" subtitle="Contracts: 8 years after expiry. Invoices: 8 financial years. HR files: 3 years after exit." className="lg:col-span-2">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-2xs uppercase text-ink-500"><th>Document kind</th><th>Anchor</th><th>Years</th></tr></thead>
          <tbody>
            {retention.data?.map((r) => (
              <tr key={r.id} className="border-t border-ink-800">
                <td className="py-1">{r.documentKind}</td><td>{r.anchor.replace(/_/g, ' ')}</td><td>{r.years}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FEMA
// ---------------------------------------------------------------------------

function FemaTab() {
  return (
    <Card title="Foreign receipts (FEMA/FIRC)" subtitle="A foreign receipt's currency, amount and FIRC are set from a payment's own record. A monthly sweep flags a foreign receipt still missing its FIRC after 30 days (CMP_FEMA_FIRC_MISSING).">
      <EmptyState message="Update foreign receipt details from a payment's own record." />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

interface RefundView {
  id: string;
  recordCode: string;
  invoiceId: string | null;
  receiptId: string | null;
  amount: string;
  reason: string;
  status: string;
  requestedAt: string;
}

function RefundsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [receiptId, setReceiptId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const refunds = useQuery({ queryKey: ['cmp-corporate', 'refunds'], queryFn: () => api.get<RefundView[]>('/compliance/corporate/refunds') });

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/compliance/corporate/refunds/${id}/approve`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cmp-corporate', 'refunds'] }),
  });

  return (
    <Card
      title="Refunds"
      subtitle="A refund is its own record: requesting and approving are decisions on this row; paying books a separate outward transaction. The original invoice or receipt is never edited."
      actions={<button className="btn-primary" onClick={() => setOpen(true)}>Request refund</button>}
    >
      {refunds.isLoading ? (
        <Loading />
      ) : !refunds.data?.length ? (
        <EmptyState message="No refunds requested." />
      ) : (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-2xs uppercase text-ink-500"><th>Code</th><th>Amount</th><th>Reason</th><th>Status</th><th /></tr></thead>
          <tbody>
            {refunds.data.map((r) => (
              <tr key={r.id} className="border-t border-ink-800">
                <td className="py-1"><RecordCode code={r.recordCode} /></td>
                <td>{money(Number(r.amount))}</td>
                <td className="max-w-xs truncate">{r.reason}</td>
                <td><StatusChip status={r.status} tone={r.status === 'paid' ? 'good' : 'neutral'} /></td>
                <td>
                  {r.status === 'requested' && (
                    <button className="btn text-2xs" onClick={() => approve.mutate(r.id)} disabled={approve.isPending}>Approve</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Request a refund"
        onClose={() => setOpen(false)}
        invalidate={[['cmp-corporate', 'refunds']]}
        onSubmit={() => api.post('/compliance/corporate/refunds', { receiptId, amount: Number(amount), reason })}
      >
        <TextInput label="Receipt ID" value={receiptId} onChange={setReceiptId} />
        <TextInput label="Amount" type="number" value={amount} onChange={setAmount} />
        <TextArea label="Reason" value={reason} onChange={setReason} rows={3} />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

interface CertificateView { id: string; number: string; enrollmentId: string; kind: string; issuedAt: string; verificationCode: string }

function CertificatesTab() {
  const [code, setCode] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const certs = useQuery({ queryKey: ['cmp-corporate', 'certificates'], queryFn: () => api.get<CertificateView[]>('/compliance/corporate/certificates') });

  const verify = useMutation({
    mutationFn: () => api.get(`/compliance/corporate/certificates/verify/${encodeURIComponent(code)}`),
    onSuccess: () => setResult('Valid — issued by this platform.'),
    onError: (e) => setResult(messageOf(e)),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Issued certificates" subtitle="Final once issued. A correction is a new certificate, never an edit.">
        {certs.isLoading ? <Loading /> : !certs.data?.length ? (
          <EmptyState message="No certificates issued yet." />
        ) : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-2xs uppercase text-ink-500"><th>Number</th><th>Kind</th><th>Issued</th></tr></thead>
            <tbody>
              {certs.data.map((c) => (
                <tr key={c.id} className="border-t border-ink-800">
                  <td className="py-1"><RecordCode code={c.number} /></td><td>{c.kind}</td><td>{date(c.issuedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Verify a certificate" subtitle="This check runs behind sign-in like every other screen here — it is not a public verification page.">
        <TextInput label="Verification code" value={code} onChange={setCode} />
        <button className="btn-primary mt-2" onClick={() => verify.mutate()} disabled={!code}>Verify</button>
        {result && <p className="mt-2 text-xs text-ink-300">{result}</p>}
      </Card>
    </div>
  );
}
