/**
 * Separations — WS10 (docs/hcm/separations.md).
 *
 * Five tabs: resignations (accept/reject), exit clearance (open it, clear or
 * block each department), no-dues (issue once every department has
 * cleared), alumni (the record written once separation reaches Terminated),
 * and notice policy (what `noticeDays` should come from).
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, dateTime, titleCase } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Field, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

type Tab = 'resignations' | 'clearances' | 'no-dues' | 'alumni' | 'notice-policies';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'resignations', label: 'Resignations' },
  { key: 'clearances', label: 'Exit clearance' },
  { key: 'no-dues', label: 'No-dues' },
  { key: 'alumni', label: 'Alumni' },
  { key: 'notice-policies', label: 'Notice policies' },
];

export function Separations() {
  const [tab, setTab] = useState<Tab>('resignations');

  return (
    <>
      <PageHeader
        title="Separations"
        subtitle="Resignations and their acceptance, exit clearance across five departments, the no-dues certificate that closes it out, the alumni record that survives the employment, and the notice-period policy table."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'resignations' && <ResignationsTab />}
      {tab === 'clearances' && <ClearancesTab />}
      {tab === 'no-dues' && <NoDuesTab />}
      {tab === 'alumni' && <AlumniTab />}
      {tab === 'notice-policies' && <NoticePoliciesTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Resignations
// ---------------------------------------------------------------------------

interface ResignationRow {
  id: string;
  recordCode: string;
  employmentRelationshipId: string;
  employment: { personId: string; person: { fullName: string; recordCode: string } };
  submittedOn: string;
  requestedLastDay: string;
  agreedLastDay: string | null;
  noticeDays: number;
  reasonCategory: string;
  reasonNote: string | null;
  status: 'submitted' | 'accepted' | 'withdrawn' | 'rejected';
  rejectedReason: string | null;
  offboardingId: string | null;
}

const RESIGNATION_TONE: Record<ResignationRow['status'], 'neutral' | 'good' | 'warn' | 'bad'> = {
  submitted: 'warn',
  accepted: 'good',
  withdrawn: 'neutral',
  rejected: 'bad',
};

function ResignationsTab() {
  const qc = useQueryClient();
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');

  const resignations = useQuery({
    queryKey: ['sep-resignations', statusFilter],
    queryFn: () => api.get<ResignationRow[]>(`/hcm/separations/resignations${statusFilter ? `?status=${statusFilter}` : ''}`),
  });

  const accept = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/separations/resignations/${id}/accept`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sep-resignations'] }),
  });
  const reject = useMutation({
    mutationFn: () => api.post(`/hcm/separations/resignations/${rejectId}/reject`, { reason: rejectReason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sep-resignations'] });
      setRejectId(null);
      setRejectReason('');
    },
  });

  return (
    <Card
      title="Resignations"
      subtitle="Accepting one starts the notice period and opens exit clearance; nobody accepts or rejects their own."
      actions={
        <SelectInput
          label="Status"
          value={statusFilter}
          onChange={setStatusFilter}
          placeholder="All statuses"
          options={[
            { value: 'submitted', label: 'Submitted' },
            { value: 'accepted', label: 'Accepted' },
            { value: 'withdrawn', label: 'Withdrawn' },
            { value: 'rejected', label: 'Rejected' },
          ]}
        />
      }
    >
      {resignations.isLoading && <Loading />}
      {resignations.error && <ErrorBox error={resignations.error} />}
      {resignations.data && resignations.data.length === 0 && <EmptyState message="No resignations recorded." />}
      {resignations.data && resignations.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Record</th>
              <th>Submitted</th>
              <th>Last day</th>
              <th>Notice</th>
              <th>Reason</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {resignations.data.map((r) => (
              <tr key={r.id}>
                <td>{r.employment.person.fullName}</td>
                <td className="mono">{r.recordCode}</td>
                <td>{date(r.submittedOn)}</td>
                <td>{date(r.agreedLastDay ?? r.requestedLastDay)}</td>
                <td>{r.noticeDays}d</td>
                <td>{titleCase(r.reasonCategory)}</td>
                <td><StatusChip status={r.status} tone={RESIGNATION_TONE[r.status]} /></td>
                <td className="text-right">
                  {r.status === 'submitted' && (
                    <div className="flex justify-end gap-2">
                      <button className="btn text-2xs" disabled={accept.isPending} onClick={() => accept.mutate(r.id)}>
                        Accept
                      </button>
                      <button className="btn text-2xs" onClick={() => setRejectId(r.id)}>
                        Reject
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {accept.isError && <ErrorBox error={accept.error} />}

      <CreateModal
        open={Boolean(rejectId)}
        title="Reject resignation"
        submitLabel="Reject"
        onClose={() => setRejectId(null)}
        onSubmit={() => reject.mutateAsync()}
      >
        <TextArea label="Reason" value={rejectReason} onChange={setRejectReason} required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Exit clearance
// ---------------------------------------------------------------------------

interface ClearanceRow {
  id: string;
  offboardingId: string;
  department: string;
  status: 'pending' | 'cleared' | 'blocked';
  note: string | null;
  clearedAt: string | null;
}

const CLEARANCE_TONE: Record<ClearanceRow['status'], 'neutral' | 'good' | 'warn' | 'bad'> = {
  pending: 'neutral',
  cleared: 'good',
  blocked: 'bad',
};

function ClearancesTab() {
  const qc = useQueryClient();
  const [offboardingId, setOffboardingId] = useState('');
  const [activeOffboardingId, setActiveOffboardingId] = useState('');
  const [blockId, setBlockId] = useState<string | null>(null);
  const [blockNote, setBlockNote] = useState('');

  const acceptedResignations = useQuery({
    queryKey: ['sep-resignations', 'accepted'],
    queryFn: () => api.get<ResignationRow[]>('/hcm/separations/resignations?status=accepted'),
  });

  const clearances = useQuery({
    queryKey: ['sep-clearances', activeOffboardingId],
    queryFn: () => api.get<ClearanceRow[]>(`/hcm/separations/offboarding/${activeOffboardingId}/clearances`),
    enabled: Boolean(activeOffboardingId),
  });

  const initiate = useMutation({
    mutationFn: (id: string) => api.post<ClearanceRow[]>(`/hcm/separations/offboarding/${id}/clearances/initiate`),
    onSuccess: (_data, id) => {
      setActiveOffboardingId(id);
      qc.invalidateQueries({ queryKey: ['sep-clearances', id] });
    },
  });

  const clear = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/separations/clearances/${id}/clear`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sep-clearances', activeOffboardingId] }),
  });
  const block = useMutation({
    mutationFn: () => api.post(`/hcm/separations/clearances/${blockId}/block`, { note: blockNote }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sep-clearances', activeOffboardingId] });
      setBlockId(null);
      setBlockNote('');
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Accepted resignations"
        subtitle="Open clearance once the last working day is settled — this moves the offboarding forward through last-day and into clearance."
      >
        {acceptedResignations.isLoading && <Loading />}
        {acceptedResignations.error && <ErrorBox error={acceptedResignations.error} />}
        {acceptedResignations.data && acceptedResignations.data.length === 0 && (
          <EmptyState message="No accepted resignations yet." />
        )}
        {acceptedResignations.data && acceptedResignations.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Last day</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {acceptedResignations.data.map((r) => (
                <tr key={r.id}>
                  <td>{r.employment.person.fullName}</td>
                  <td>{date(r.agreedLastDay ?? r.requestedLastDay)}</td>
                  <td className="text-right">
                    {r.offboardingId && (
                      <div className="flex justify-end gap-2">
                        <button className="btn text-2xs" onClick={() => setActiveOffboardingId(r.offboardingId!)}>
                          View clearance
                        </button>
                        <button
                          className="btn text-2xs"
                          disabled={initiate.isPending}
                          onClick={() => initiate.mutate(r.offboardingId!)}
                        >
                          Open / refresh clearance
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {initiate.isError && <ErrorBox error={initiate.error} />}
      </Card>

      <Card
        title="Clearance detail"
        subtitle="Paste an offboarding id, or use “view clearance” above."
        actions={
          <div className="flex gap-2">
            <TextInput label="Offboarding id" placeholder="Paste an id" value={offboardingId} onChange={setOffboardingId} />
            <button className="btn text-2xs" onClick={() => setActiveOffboardingId(offboardingId)}>
              Load
            </button>
          </div>
        }
      >
        {!activeOffboardingId && <EmptyState message="No offboarding selected." />}
        {activeOffboardingId && clearances.isLoading && <Loading />}
        {activeOffboardingId && clearances.error && <ErrorBox error={clearances.error} />}
        {activeOffboardingId && clearances.data && clearances.data.length === 0 && (
          <EmptyState message="Clearance has not been opened yet." hint="Use “Open / refresh clearance” above." />
        )}
        {activeOffboardingId && clearances.data && clearances.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Department</th>
                <th>Status</th>
                <th>Note</th>
                <th>Cleared</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {clearances.data.map((c) => (
                <tr key={c.id}>
                  <td>{titleCase(c.department)}</td>
                  <td><StatusChip status={c.status} tone={CLEARANCE_TONE[c.status]} /></td>
                  <td className="text-ink-400">{c.note ?? '—'}</td>
                  <td>{c.clearedAt ? dateTime(c.clearedAt) : '—'}</td>
                  <td className="text-right">
                    {c.status !== 'cleared' && (
                      <div className="flex justify-end gap-2">
                        <button className="btn text-2xs" disabled={clear.isPending} onClick={() => clear.mutate(c.id)}>
                          Clear
                        </button>
                        <button className="btn text-2xs" onClick={() => setBlockId(c.id)}>
                          Block
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {clear.isError && <ErrorBox error={clear.error} />}
      </Card>

      <CreateModal
        open={Boolean(blockId)}
        title="Block this department"
        submitLabel="Block"
        onClose={() => setBlockId(null)}
        onSubmit={() => block.mutateAsync()}
      >
        <TextArea label="Reason" value={blockNote} onChange={setBlockNote} required />
      </CreateModal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// No-dues
// ---------------------------------------------------------------------------

function NoDuesTab() {
  const qc = useQueryClient();
  const [offboardingId, setOffboardingId] = useState('');
  const [activeOffboardingId, setActiveOffboardingId] = useState('');

  const clearances = useQuery({
    queryKey: ['sep-clearances', activeOffboardingId],
    queryFn: () => api.get<ClearanceRow[]>(`/hcm/separations/offboarding/${activeOffboardingId}/clearances`),
    enabled: Boolean(activeOffboardingId),
  });
  const noDues = useQuery({
    queryKey: ['sep-no-dues', activeOffboardingId],
    queryFn: () => api.get<{ id: string; issuedOn: string } | null>(`/hcm/separations/offboarding/${activeOffboardingId}/no-dues`),
    enabled: Boolean(activeOffboardingId),
  });

  const issue = useMutation({
    mutationFn: () => api.post(`/hcm/separations/offboarding/${activeOffboardingId}/no-dues`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sep-no-dues', activeOffboardingId] }),
  });

  const allCleared = clearances.data && clearances.data.length > 0 && clearances.data.every((c) => c.status === 'cleared');

  return (
    <Card
      title="No-dues certificate"
      subtitle="Issued only once every department has cleared — the button stays off otherwise."
      actions={
        <div className="flex gap-2">
          <TextInput label="Offboarding id" placeholder="Paste an id" value={offboardingId} onChange={setOffboardingId} />
          <button className="btn text-2xs" onClick={() => setActiveOffboardingId(offboardingId)}>
            Load
          </button>
        </div>
      }
    >
      {!activeOffboardingId && <EmptyState message="No offboarding selected." hint="Paste an offboarding id from the Exit clearance tab." />}
      {activeOffboardingId && (clearances.isLoading || noDues.isLoading) && <Loading />}
      {activeOffboardingId && (clearances.error || noDues.error) && <ErrorBox error={clearances.error ?? noDues.error} />}
      {activeOffboardingId && clearances.data && noDues.data !== undefined && (
        <div className="flex flex-col gap-3">
          {noDues.data ? (
            <p className="text-sm text-band-strong">Issued {dateTime(noDues.data.issuedOn)}.</p>
          ) : allCleared ? (
            <button className="btn-primary w-fit" disabled={issue.isPending} onClick={() => issue.mutate()}>
              {issue.isPending ? 'Issuing…' : 'Issue no-dues certificate'}
            </button>
          ) : (
            <EmptyState
              message="Clearance is not complete."
              hint={`${clearances.data.filter((c) => c.status === 'cleared').length} of ${clearances.data.length || 5} departments cleared so far.`}
            />
          )}
          {issue.isError && <ErrorBox error={issue.error} />}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Alumni
// ---------------------------------------------------------------------------

interface AlumniRow {
  id: string;
  personId: string;
  employmentRelationshipId: string;
  lastDesignation: string;
  exitDate: string;
  separationType: string;
  rehireEligible: boolean | null;
  rehireNote: string | null;
  contactConsent: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
}

function AlumniTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    employmentRelationshipId: '',
    rehireEligible: 'unknown' as 'unknown' | 'yes' | 'no',
    rehireNote: '',
    contactConsent: false,
    contactEmail: '',
    contactPhone: '',
  });

  const alumni = useQuery({ queryKey: ['sep-alumni'], queryFn: () => api.get<AlumniRow[]>('/hcm/separations/alumni') });

  return (
    <Card
      title="Alumni"
      subtitle="Written once, deliberately, when separation reaches Terminated — rehire eligibility and contact consent are not defaults."
      actions={<NewButton label="Record alumni" onClick={() => setOpen(true)} />}
    >
      {alumni.isLoading && <Loading />}
      {alumni.error && <ErrorBox error={alumni.error} />}
      {alumni.data && alumni.data.length === 0 && <EmptyState message="No alumni recorded yet." />}
      {alumni.data && alumni.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Last designation</th>
              <th>Exit date</th>
              <th>Separation</th>
              <th>Rehire eligible</th>
              <th>Contact consent</th>
            </tr>
          </thead>
          <tbody>
            {alumni.data.map((a) => (
              <tr key={a.id}>
                <td>{a.lastDesignation}</td>
                <td>{date(a.exitDate)}</td>
                <td><StatusChip status={a.separationType} /></td>
                <td>{a.rehireEligible === null ? 'Not assessed' : a.rehireEligible ? 'Yes' : 'No'}</td>
                <td>{a.contactConsent ? (a.contactEmail ?? a.contactPhone ?? 'Given') : 'Not given'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Record an alumni entry"
        onClose={() => setOpen(false)}
        invalidate={[['sep-alumni']]}
        onSubmit={() =>
          api.post('/hcm/separations/alumni', {
            employmentRelationshipId: form.employmentRelationshipId,
            rehireEligible: form.rehireEligible === 'unknown' ? null : form.rehireEligible === 'yes',
            rehireNote: form.rehireNote || undefined,
            contactConsent: form.contactConsent,
            contactEmail: form.contactEmail || undefined,
            contactPhone: form.contactPhone || undefined,
          })
        }
      >
        <TextInput
          label="Employment id"
          value={form.employmentRelationshipId}
          onChange={(v) => setForm({ ...form, employmentRelationshipId: v })}
          required
          hint="Must already be Terminated"
        />
        <SelectInput
          label="Rehire eligible"
          value={form.rehireEligible}
          onChange={(v) => setForm({ ...form, rehireEligible: v })}
          options={[
            { value: 'unknown', label: 'Not assessed' },
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
        />
        <TextArea label="Note" value={form.rehireNote} onChange={(v) => setForm({ ...form, rehireNote: v })} />
        <Row>
          <TextInput label="Contact email" type="email" value={form.contactEmail} onChange={(v) => setForm({ ...form, contactEmail: v })} />
          <TextInput label="Contact phone" type="tel" value={form.contactPhone} onChange={(v) => setForm({ ...form, contactPhone: v })} />
        </Row>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input
            type="checkbox"
            checked={form.contactConsent}
            onChange={(e) => setForm({ ...form, contactConsent: e.target.checked })}
          />
          Consented to being contacted about future opportunities
        </label>
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Notice policies
// ---------------------------------------------------------------------------

interface NoticePolicyRow {
  id: string;
  name: string;
  grade: string | null;
  engagementType: string | null;
  noticeDays: number;
  buyoutAllowed: boolean;
  active: boolean;
}

function NoticePoliciesTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', grade: '', engagementType: '', noticeDays: '30', buyoutAllowed: true });

  const policies = useQuery({ queryKey: ['sep-notice-policies'], queryFn: () => api.get<NoticePolicyRow[]>('/hcm/separations/notice-policies') });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch(`/hcm/separations/notice-policies/${id}/active`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sep-notice-policies'] }),
  });

  return (
    <Card
      title="Notice policies"
      subtitle="What noticeDays comes from, by grade and engagement type. An employment with no matching row falls back to its own flat default."
      actions={<NewButton label="Add policy" onClick={() => setOpen(true)} />}
    >
      {policies.isLoading && <Loading />}
      {policies.error && <ErrorBox error={policies.error} />}
      {policies.data && policies.data.length === 0 && <EmptyState message="No notice policies defined." hint="Every employment falls back to its own flat notice period." />}
      {policies.data && policies.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Grade</th>
              <th>Engagement type</th>
              <th>Notice days</th>
              <th>Buyout</th>
              <th>Active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {policies.data.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.grade ?? 'Any'}</td>
                <td>{p.engagementType ? titleCase(p.engagementType) : 'Any'}</td>
                <td>{p.noticeDays}</td>
                <td>{p.buyoutAllowed ? 'Allowed' : 'Not allowed'}</td>
                <td><StatusChip status={p.active ? 'active' : 'inactive'} tone={p.active ? 'good' : 'neutral'} /></td>
                <td className="text-right">
                  <button className="btn text-2xs" onClick={() => toggle.mutate({ id: p.id, active: !p.active })}>
                    {p.active ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Add a notice policy"
        onClose={() => setOpen(false)}
        invalidate={[['sep-notice-policies']]}
        onSubmit={() =>
          api.post('/hcm/separations/notice-policies', {
            name: form.name,
            grade: form.grade || undefined,
            engagementType: form.engagementType || undefined,
            noticeDays: Number(form.noticeDays),
            buyoutAllowed: form.buyoutAllowed,
          })
        }
      >
        <TextInput label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <Row>
          <TextInput label="Grade (optional)" value={form.grade} onChange={(v) => setForm({ ...form, grade: v })} />
          <TextInput label="Engagement type (optional)" value={form.engagementType} onChange={(v) => setForm({ ...form, engagementType: v })} placeholder="employee / contractor / …" />
        </Row>
        <TextInput label="Notice days" type="number" value={form.noticeDays} onChange={(v) => setForm({ ...form, noticeDays: v })} required />
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input
            type="checkbox"
            checked={form.buyoutAllowed}
            onChange={(e) => setForm({ ...form, buyoutAllowed: e.target.checked })}
          />
          Buyout of unserved notice allowed
        </label>
      </CreateModal>
    </Card>
  );
}
