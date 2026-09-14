/**
 * Employee 360 (docs/hcm/workforce.md) — the aggregate view of one
 * employment: the personal record, documents, reporting lines and the
 * transfer/promotion/demotion/redesignation history, alongside the seat and
 * pay Employee Detail already shows.
 *
 * Nothing here re-derives a lifecycle: a status change's decide/apply
 * buttons are shown only where the server would not refuse them (the
 * Self-Dealing Bar hides "decide" from whoever proposed the change).
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, titleCase } from '../../lib/api.js';
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
import { CreateModal, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface Profile {
  gender: string | null;
  maritalStatus: string | null;
  nationality: string | null;
  passportNumber: string | null;
  passportExpiry: string | null;
  emergencyContacts: Array<{ name: string; relationship: string; phone: string }>;
  currentAddress: Record<string, string> | null;
  permanentAddress: Record<string, string> | null;
  educationHistory: Array<Record<string, string>>;
  previousEmployment: Array<Record<string, string>>;
  dependants: Array<Record<string, string>>;
}

interface DocumentRow {
  id: string;
  kind: string;
  filename: string;
  mimeType: string;
  verified: boolean;
  verifiedAt: string | null;
  expiresOn: string | null;
  createdAt: string;
}

interface ReportingLineRow {
  id: string;
  employmentRelationshipId: string;
  managerEmploymentRelationshipId: string;
  kind: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

interface StatusChangeRow {
  id: string;
  kind: string;
  changes: Record<string, string>;
  reason: string;
  effectiveDate: string;
  status: string;
  proposedById: string;
  decidedById: string | null;
  decisionNote: string | null;
  appliedAt: string | null;
  createdAt: string;
}

interface Employee360View {
  employment: {
    id: string;
    recordCode: string;
    status: string;
    confirmationState: string;
    hireEffectiveDate: string;
    engagementType: string;
    legalEntity: string;
  };
  person: { id: string; fullName: string; primaryEmail: string | null; primaryPhone: string | null; recordCode: string };
  currentAssignment: { position: { job: { title: string }; orgUnit: { name: string } } } | null;
  profile: Profile | null;
  documents: DocumentRow[];
  org: {
    managers: Array<{ line: ReportingLineRow; managerName: string | null }>;
    directReports: Array<{ line: ReportingLineRow; name: string | null }>;
    grade: { code: string; name: string; level: number } | null;
    costCentre: { code: string; name: string } | null;
    location: { name: string; city: string | null; state: string | null } | null;
  };
  statusChanges: StatusChangeRow[];
}

interface DirectoryRow {
  employmentRelationshipId: string;
  person: { fullName: string };
}

type Tab = 'overview' | 'documents' | 'reporting' | 'history';

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  pending_approval: 'warn',
  approved: 'good',
  rejected: 'bad',
  applied: 'good',
};

function key(id: string) {
  return ['hcm-workforce-360', id];
}

export function Employee360() {
  const { id = '' } = useParams();
  const { user } = useSession();
  const [tab, setTab] = useState<Tab>('overview');

  const { data, isLoading, error } = useQuery({
    queryKey: key(id),
    queryFn: () => api.get<Employee360View>(`/hcm/workforce/employees/${id}/360`),
    enabled: Boolean(id),
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Loading />;

  return (
    <div>
      <PageHeader
        title={data.person.fullName}
        subtitle={
          <>
            <RecordCode code={data.employment.recordCode} to={`/people/employees/${data.employment.id}`} /> ·{' '}
            {data.currentAssignment?.position.job.title ?? 'no seat'} ·{' '}
            {data.currentAssignment?.position.orgUnit.name ?? 'no unit'}
          </>
        }
        actions={
          <>
            <Link className="btn-ghost" to={`/people/employees/${data.employment.id}`}>
              Seat &amp; pay
            </Link>
            <StatusChip status={data.employment.status} tone={data.employment.status === 'Active' ? 'good' : 'neutral'} />
          </>
        }
      />

      <Tabs
        tabs={[
          { key: 'overview', label: 'Profile' },
          { key: 'documents', label: 'Documents', count: data.documents.length },
          { key: 'reporting', label: 'Reporting' },
          { key: 'history', label: 'History', count: data.statusChanges.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && <OverviewTab id={id} data={data} />}
      {tab === 'documents' && <DocumentsTab id={id} data={data} />}
      {tab === 'reporting' && <ReportingTab id={id} data={data} />}
      {tab === 'history' && (
        <HistoryTab id={id} data={data} userPartyId={user?.personId ?? null} subjectPersonId={data.person.id} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview / profile
// ---------------------------------------------------------------------------

function OverviewTab({ id, data }: { id: string; data: Employee360View }) {
  const [editOpen, setEditOpen] = useState(false);
  const p = data.profile;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card
          title="Personal record"
          subtitle="Held against the employment, not the seat — it survives a transfer."
          actions={
            <button className="btn-ghost" onClick={() => setEditOpen(true)}>
              Edit
            </button>
          }
        >
          <dl className="grid gap-x-4 sm:grid-cols-2">
            <Field label="Gender">{p?.gender ?? '—'}</Field>
            <Field label="Marital status">{p?.maritalStatus ?? '—'}</Field>
            <Field label="Nationality">{p?.nationality ?? '—'}</Field>
            <Field label="Passport">
              {p?.passportNumber ?? '—'}
              {p?.passportExpiry && <span className="ml-1 text-2xs text-ink-500">exp {date(p.passportExpiry)}</span>}
            </Field>
            <Field label="Current address">{formatAddress(p?.currentAddress)}</Field>
            <Field label="Permanent address">{formatAddress(p?.permanentAddress)}</Field>
          </dl>
        </Card>

        <Card title="Emergency contacts" subtitle="Who to call.">
          <JsonList
            rows={p?.emergencyContacts ?? []}
            columns={['name', 'relationship', 'phone']}
            addFields={[
              { key: 'name', label: 'Name' },
              { key: 'relationship', label: 'Relationship' },
              { key: 'phone', label: 'Phone' },
            ]}
            arrayField="emergencyContacts"
            employmentId={id}
            emptyMessage="No emergency contact on file."
          />
        </Card>

        <Card title="Education" subtitle="Self-declared; not independently verified here — see Documents.">
          <JsonList
            rows={p?.educationHistory ?? []}
            columns={['institution', 'degree', 'field', 'year']}
            addFields={[
              { key: 'institution', label: 'Institution' },
              { key: 'degree', label: 'Degree' },
              { key: 'field', label: 'Field' },
              { key: 'year', label: 'Year' },
            ]}
            arrayField="educationHistory"
            employmentId={id}
            emptyMessage="No education history recorded."
          />
        </Card>

        <Card title="Previous employment" subtitle="Self-declared.">
          <JsonList
            rows={p?.previousEmployment ?? []}
            columns={['employer', 'designation', 'from', 'to']}
            addFields={[
              { key: 'employer', label: 'Employer' },
              { key: 'designation', label: 'Designation' },
              { key: 'from', label: 'From' },
              { key: 'to', label: 'To' },
            ]}
            arrayField="previousEmployment"
            employmentId={id}
            emptyMessage="No previous employment recorded."
          />
        </Card>

        <Card title="Dependants" subtitle="For benefits and nomination purposes.">
          <JsonList
            rows={p?.dependants ?? []}
            columns={['name', 'relationship', 'dob']}
            addFields={[
              { key: 'name', label: 'Name' },
              { key: 'relationship', label: 'Relationship' },
              { key: 'dob', label: 'Date of birth', type: 'date' },
            ]}
            arrayField="dependants"
            employmentId={id}
            emptyMessage="No dependant recorded."
          />
        </Card>
      </div>

      <div className="space-y-4">
        <Card title="Org design">
          <dl>
            <Field label="Grade">{data.org.grade ? `${data.org.grade.code} — ${data.org.grade.name}` : 'Not assigned.'}</Field>
            <Field label="Cost centre">{data.org.costCentre ? `${data.org.costCentre.code} — ${data.org.costCentre.name}` : 'Not assigned.'}</Field>
            <Field label="Location">{data.org.location ? `${data.org.location.name}${data.org.location.city ? `, ${data.org.location.city}` : ''}` : 'Not assigned.'}</Field>
          </dl>
        </Card>
        <Card title="Contact">
          <dl>
            <Field label="Email">{data.person.primaryEmail ?? '—'}</Field>
            <Field label="Phone">{data.person.primaryPhone ?? '—'}</Field>
            <Field label="Person record">
              <RecordCode code={data.person.recordCode} to={`/crm/people/${data.person.id}`} />
            </Field>
          </dl>
        </Card>
      </div>

      <EditProfileModal open={editOpen} onClose={() => setEditOpen(false)} id={id} profile={p} />
    </div>
  );
}

function formatAddress(a: Record<string, string> | null | undefined) {
  if (!a) return '—';
  return [a.line1, a.line2, a.city, a.state, a.pincode, a.country].filter(Boolean).join(', ') || '—';
}

function EditProfileModal({
  open,
  onClose,
  id,
  profile,
}: {
  open: boolean;
  onClose: () => void;
  id: string;
  profile: Profile | null;
}) {
  const [gender, setGender] = useState(profile?.gender ?? '');
  const [maritalStatus, setMaritalStatus] = useState(profile?.maritalStatus ?? '');
  const [nationality, setNationality] = useState(profile?.nationality ?? '');
  const [passportNumber, setPassportNumber] = useState(profile?.passportNumber ?? '');
  const [line1, setLine1] = useState(profile?.currentAddress?.line1 ?? '');
  const [city, setCity] = useState(profile?.currentAddress?.city ?? '');
  const [state, setState] = useState(profile?.currentAddress?.state ?? '');
  const [pincode, setPincode] = useState(profile?.currentAddress?.pincode ?? '');

  return (
    <CreateModal
      open={open}
      title="Edit personal record"
      submitLabel="Save"
      onClose={onClose}
      invalidate={[key(id)]}
      onSubmit={() =>
        api.patch(`/hcm/workforce/employees/${id}/profile`, {
          gender: gender || null,
          maritalStatus: maritalStatus || null,
          nationality: nationality || null,
          passportNumber: passportNumber || null,
          currentAddress: line1 || city || state || pincode ? { line1, city, state, pincode } : null,
        })
      }
    >
      <Row>
        <TextInput label="Gender" value={gender} onChange={setGender} />
        <TextInput label="Marital status" value={maritalStatus} onChange={setMaritalStatus} />
      </Row>
      <Row>
        <TextInput label="Nationality" value={nationality} onChange={setNationality} />
        <TextInput label="Passport number" value={passportNumber} onChange={setPassportNumber} />
      </Row>
      <p className="section-title">Current address</p>
      <Row>
        <TextInput label="Line 1" value={line1} onChange={setLine1} />
        <TextInput label="City" value={city} onChange={setCity} />
      </Row>
      <Row>
        <TextInput label="State" value={state} onChange={setState} />
        <TextInput label="Pincode" value={pincode} onChange={setPincode} />
      </Row>
    </CreateModal>
  );
}

/** A read-only list of a JSON-array field, with a small "add row" form. */
function JsonList({
  rows,
  columns,
  addFields,
  arrayField,
  employmentId,
  emptyMessage,
}: {
  rows: Array<Record<string, string>>;
  columns: string[];
  addFields: Array<{ key: string; label: string; type?: 'text' | 'date' }>;
  arrayField: string;
  employmentId: string;
  emptyMessage: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: () => api.patch(`/hcm/workforce/employees/${employmentId}/profile`, { [arrayField]: [...rows, draft] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(employmentId) });
      setOpen(false);
      setDraft({});
    },
  });

  return (
    <div>
      {rows.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{titleCase(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c}>{row[c] ?? '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button className="btn-ghost btn-sm mt-2" onClick={() => setOpen(true)}>
        + Add
      </button>
      <CreateModal
        open={open}
        title="Add row"
        onClose={() => setOpen(false)}
        onSubmit={() => mutation.mutateAsync()}
      >
        {addFields.map((f) => (
          <TextInput
            key={f.key}
            label={f.label}
            type={f.type ?? 'text'}
            value={draft[f.key] ?? ''}
            onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
          />
        ))}
      </CreateModal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const DOCUMENT_KINDS = ['id_proof', 'address_proof', 'education', 'offer', 'contract', 'other'] as const;

function DocumentsTab({ id, data }: { id: string; data: Employee360View }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<(typeof DOCUMENT_KINDS)[number] | ''>('');
  const [file, setFile] = useState<File | null>(null);

  const verify = useMutation({
    mutationFn: (docId: string) => api.post(`/hcm/workforce/documents/${docId}/verify`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(id) }),
  });

  async function upload() {
    if (!file || !kind) throw new Error('Choose a kind and a file first.');
    const content = await fileToBase64(file);
    await api.post(`/hcm/workforce/employees/${id}/documents`, {
      kind,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      content,
    });
  }

  return (
    <Card
      title="Documents"
      subtitle="Proof of identity, address, education, offer and contract paperwork held against this employment."
      bodyClassName="p-0"
      actions={<NewButton label="Upload" onClick={() => setOpen(true)} />}
    >
      {data.documents.length === 0 ? (
        <div className="p-4">
          <EmptyState message="No document has been uploaded for this employment." />
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>File</th>
              <th>Uploaded</th>
              <th>Expires</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.documents.map((d) => (
              <tr key={d.id}>
                <td>{titleCase(d.kind)}</td>
                <td>{d.filename}</td>
                <td className="num">{date(d.createdAt)}</td>
                <td className="num">{d.expiresOn ? date(d.expiresOn) : '—'}</td>
                <td>
                  <StatusChip status={d.verified ? 'verified' : 'unverified'} tone={d.verified ? 'good' : 'warn'} />
                </td>
                <td>
                  {!d.verified && (
                    <button className="btn-ghost btn-sm" onClick={() => verify.mutate(d.id)} disabled={verify.isPending}>
                      Verify
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Upload a document"
        onClose={() => setOpen(false)}
        invalidate={[key(id)]}
        onSubmit={upload}
      >
        <SelectInput
          label="Kind"
          value={kind}
          onChange={(v) => setKind(v as (typeof DOCUMENT_KINDS)[number])}
          required
          placeholder="Choose a kind…"
          options={DOCUMENT_KINDS.map((k) => ({ value: k, label: titleCase(k) }))}
        />
        <label className="block">
          <span className="label">File</span>
          <input
            className="input"
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
      </CreateModal>
    </Card>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function ReportingTab({ id, data }: { id: string; data: Employee360View }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [managerId, setManagerId] = useState('');
  const [lineKind, setLineKind] = useState<'primary' | 'dotted'>('primary');

  const { data: directory = [] } = useQuery({
    queryKey: ['hcm-workforce-directory-picker'],
    queryFn: () => api.get<DirectoryRow[]>('/hcm/workforce/directory'),
    enabled: open,
  });

  const currentPrimary = data.org.managers.find((m) => m.line.kind === 'primary' && m.line.effectiveTo === null);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card
        title="Reports to"
        subtitle="The current primary line, plus any dotted lines."
        actions={<NewButton label="Set manager" onClick={() => setOpen(true)} />}
      >
        {data.org.managers.filter((m) => m.line.effectiveTo === null).length === 0 ? (
          <EmptyState message="No manager is recorded for this employment." />
        ) : (
          <ul className="space-y-2">
            {data.org.managers
              .filter((m) => m.line.effectiveTo === null)
              .map((m) => (
                <li key={m.line.id} className="flex items-center justify-between rounded border border-ink-800 bg-ink-950 p-2.5">
                  <div>
                    <Link
                      to={`/people/employees/${m.line.managerEmploymentRelationshipId}/360`}
                      className="text-xs font-medium text-ink-100 hover:text-accent hover:underline"
                    >
                      {m.managerName ?? m.line.managerEmploymentRelationshipId}
                    </Link>
                    <p className="text-2xs text-ink-500">Since {date(m.line.effectiveFrom)}</p>
                  </div>
                  <StatusChip status={m.line.kind} tone={m.line.kind === 'primary' ? 'accent' : 'neutral'} />
                </li>
              ))}
          </ul>
        )}
      </Card>

      <Card title="Direct reports" subtitle="Who reports to this employment right now.">
        {data.org.directReports.length === 0 ? (
          <EmptyState message="Nobody reports to this employment." />
        ) : (
          <ul className="space-y-2">
            {data.org.directReports.map((r) => (
              <li key={r.line.id} className="flex items-center justify-between rounded border border-ink-800 bg-ink-950 p-2.5">
                <Link
                  to={`/people/employees/${r.line.employmentRelationshipId}/360`}
                  className="text-xs font-medium text-ink-100 hover:text-accent hover:underline"
                >
                  {r.name ?? r.line.employmentRelationshipId}
                </Link>
                <StatusChip status={r.line.kind} tone={r.line.kind === 'primary' ? 'accent' : 'neutral'} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CreateModal
        open={open}
        title="Set a manager"
        onClose={() => setOpen(false)}
        invalidate={[key(id)]}
        onSubmit={() =>
          api.post('/hcm/workforce/reporting-lines', {
            employmentRelationshipId: id,
            managerEmploymentRelationshipId: managerId,
            kind: lineKind,
          })
        }
      >
        <SelectInput
          label="Manager"
          required
          value={managerId}
          onChange={setManagerId}
          placeholder="Choose an employee…"
          options={directory
            .filter((d) => d.employmentRelationshipId !== id)
            .map((d) => ({ value: d.employmentRelationshipId, label: d.person.fullName }))}
        />
        <SelectInput
          label="Kind"
          required
          value={lineKind}
          onChange={(v) => setLineKind(v as 'primary' | 'dotted')}
          options={[
            { value: 'primary', label: 'Primary' },
            { value: 'dotted', label: 'Dotted' },
          ]}
        />
        {currentPrimary && lineKind === 'primary' && (
          <p className="text-2xs text-ink-500">
            This replaces the current primary line to {currentPrimary.managerName ?? 'the current manager'}, effective today.
          </p>
        )}
      </CreateModal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History — status changes
// ---------------------------------------------------------------------------

const KIND_OPTIONS = [
  { value: 'transfer', label: 'Transfer' },
  { value: 'promotion', label: 'Promotion' },
  { value: 'demotion', label: 'Demotion' },
  { value: 'redesignation', label: 'Redesignation' },
];

function HistoryTab({
  id,
  data,
  userPartyId,
  subjectPersonId,
}: {
  id: string;
  data: Employee360View;
  userPartyId: string | null;
  subjectPersonId: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'transfer' | 'promotion' | 'demotion' | 'redesignation' | ''>('');
  const [reason, setReason] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [designation, setDesignation] = useState('');
  const [gradeId, setGradeId] = useState('');
  const [costCentreId, setCostCentreId] = useState('');
  const [locationId, setLocationId] = useState('');

  const { data: grades = [] } = useQuery({ queryKey: ['hcm-workforce-grades'], queryFn: () => api.get<Array<{ id: string; code: string; name: string }>>('/hcm/workforce/grades') });
  const { data: costCentres = [] } = useQuery({ queryKey: ['hcm-workforce-cost-centres'], queryFn: () => api.get<Array<{ id: string; code: string; name: string }>>('/hcm/workforce/cost-centres') });
  const { data: locations = [] } = useQuery({ queryKey: ['hcm-workforce-locations'], queryFn: () => api.get<Array<{ id: string; name: string }>>('/hcm/workforce/locations') });

  const decide = useMutation({
    mutationFn: ({ changeId, approve }: { changeId: string; approve: boolean }) =>
      api.post(`/hcm/workforce/status-changes/${changeId}/decide`, { approve }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(id) }),
  });
  const apply = useMutation({
    mutationFn: (changeId: string) => api.post(`/hcm/workforce/status-changes/${changeId}/apply`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(id) }),
  });

  return (
    <Card
      title="Transfers, promotions & redesignations"
      subtitle="Proposed, then decided by someone other than the proposer, then applied."
      bodyClassName="p-0"
      actions={<NewButton label="Propose a change" onClick={() => setOpen(true)} />}
    >
      {data.statusChanges.length === 0 ? (
        <div className="p-4">
          <EmptyState message="No transfer, promotion, demotion or redesignation has been proposed for this employment." />
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Reason</th>
              <th>Effective</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.statusChanges.map((c) => {
              const isSelfDealing = c.proposedById === userPartyId || subjectPersonId === userPartyId;
              return (
                <tr key={c.id}>
                  <td>{titleCase(c.kind)}</td>
                  <td className="max-w-xs truncate" title={c.reason}>
                    {c.reason}
                  </td>
                  <td className="num">{date(c.effectiveDate)}</td>
                  <td>
                    <StatusChip status={c.status.replace(/_/g, ' ')} tone={STATUS_TONE[c.status] ?? 'neutral'} />
                  </td>
                  <td className="whitespace-nowrap">
                    {c.status === 'pending_approval' &&
                      (isSelfDealing ? (
                        <span className="text-2xs italic text-ink-500" title="The Self-Dealing Bar: neither the proposer nor the subject of a change may decide it.">
                          Awaiting another decider
                        </span>
                      ) : (
                        <div className="flex gap-1.5">
                          <button
                            className="btn-ghost btn-sm"
                            onClick={() => decide.mutate({ changeId: c.id, approve: true })}
                            disabled={decide.isPending}
                          >
                            Approve
                          </button>
                          <button
                            className="btn-ghost btn-sm"
                            onClick={() => decide.mutate({ changeId: c.id, approve: false })}
                            disabled={decide.isPending}
                          >
                            Reject
                          </button>
                        </div>
                      ))}
                    {c.status === 'approved' && (
                      <button className="btn-ghost btn-sm" onClick={() => apply.mutate(c.id)} disabled={apply.isPending}>
                        Apply
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Propose a status change"
        onClose={() => setOpen(false)}
        invalidate={[key(id)]}
        onSubmit={() =>
          api.post('/hcm/workforce/status-changes', {
            employmentRelationshipId: id,
            kind,
            reason,
            effectiveDate,
            changes: {
              ...(designation ? { designation } : {}),
              ...(gradeId ? { gradeId } : {}),
              ...(costCentreId ? { costCentreId } : {}),
              ...(locationId ? { locationId } : {}),
            },
          })
        }
      >
        <SelectInput label="Kind" required value={kind} onChange={(v) => setKind(v as typeof kind)} placeholder="Choose a kind…" options={KIND_OPTIONS} />
        <TextArea label="Reason" required value={reason} onChange={setReason} />
        <TextInput label="Effective date" type="date" required value={effectiveDate} onChange={setEffectiveDate} />
        <p className="section-title">What moves (leave blank what does not change)</p>
        <TextInput label="New designation" value={designation} onChange={setDesignation} />
        <Row>
          <SelectInput label="New grade" value={gradeId} onChange={setGradeId} placeholder="Unchanged" options={grades.map((g) => ({ value: g.id, label: `${g.code} — ${g.name}` }))} />
          <SelectInput label="New cost centre" value={costCentreId} onChange={setCostCentreId} placeholder="Unchanged" options={costCentres.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))} />
        </Row>
        <SelectInput label="New location" value={locationId} onChange={setLocationId} placeholder="Unchanged" options={locations.map((l) => ({ value: l.id, label: l.name }))} />
      </CreateModal>
    </Card>
  );
}
