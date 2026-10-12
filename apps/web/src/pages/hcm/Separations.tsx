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
import { date, dateTime, titleCase } from '../../lib/api.js';
import {
  hcmApi,
  type AlumniRow,
  type ClearanceRow,
  type NoticePolicyRow,
  type ResignationRow,
} from '../../lib/hcmApi.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';
import { DataTable, type DataTableColumn } from '../../components/DataTable.js';

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

const RESIGNATION_TONE: Record<ResignationRow['status'], 'neutral' | 'good' | 'warn' | 'bad'> = {
  submitted: 'warn',
  accepted: 'good',
  withdrawn: 'neutral',
  rejected: 'bad',
};

const RESIGNATION_COLUMNS: ReadonlyArray<DataTableColumn<ResignationRow>> = [
  {
    id: 'employee',
    header: 'Employee',
    sortValue: (r) => r.employment.person.fullName,
    cell: (r) => r.employment.person.fullName,
  },
  {
    id: 'record',
    header: 'Record',
    sortValue: (r) => r.recordCode,
    cell: (r) => <span className="mono">{r.recordCode}</span>,
  },
  {
    id: 'submitted',
    header: 'Submitted',
    sortValue: (r) => r.submittedOn,
    cell: (r) => date(r.submittedOn),
  },
  {
    id: 'lastDay',
    header: 'Last day',
    sortValue: (r) => r.agreedLastDay ?? r.requestedLastDay,
    cell: (r) => date(r.agreedLastDay ?? r.requestedLastDay),
  },
  {
    id: 'notice',
    header: 'Notice',
    sortValue: (r) => r.noticeDays,
    cell: (r) => `${r.noticeDays}d`,
  },
  {
    id: 'reason',
    header: 'Reason',
    sortValue: (r) => r.reasonCategory,
    cell: (r) => titleCase(r.reasonCategory),
  },
  {
    id: 'status',
    header: 'Status',
    sortValue: (r) => r.status,
    cell: (r) => <StatusChip status={r.status} tone={RESIGNATION_TONE[r.status]} />,
  },
];

function ResignationsTab() {
  const qc = useQueryClient();
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');

  const resignations = useQuery({
    queryKey: ['sep-resignations', statusFilter],
    queryFn: () => hcmApi.separations.resignations.list(statusFilter),
  });

  const accept = useMutation({
    mutationFn: (id: string) => hcmApi.separations.resignations.accept(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sep-resignations'] }),
  });
  const reject = useMutation({
    mutationFn: () => hcmApi.separations.resignations.reject(rejectId!, rejectReason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sep-resignations'] });
      setRejectId(null);
      setRejectReason('');
    },
  });

  const columns: ReadonlyArray<DataTableColumn<ResignationRow>> = [
    ...RESIGNATION_COLUMNS,
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) =>
        r.status === 'submitted' && (
          <div className="flex justify-end gap-2">
            <button className="btn text-2xs" disabled={accept.isPending} onClick={() => accept.mutate(r.id)}>
              Accept
            </button>
            <button className="btn text-2xs" onClick={() => setRejectId(r.id)}>
              Reject
            </button>
          </div>
        ),
    },
  ];

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
      <DataTable
        caption="Resignations"
        columns={columns}
        rows={resignations.data ?? []}
        rowKey={(r) => r.id}
        loading={resignations.isLoading}
        error={resignations.error}
        emptyMessage="No resignations recorded."
        emptyHint={statusFilter ? 'Clear the status filter to see every resignation.' : undefined}
      />
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
    queryFn: () => hcmApi.separations.resignations.list('accepted'),
  });

  const clearances = useQuery({
    queryKey: ['sep-clearances', activeOffboardingId],
    queryFn: () => hcmApi.separations.clearances.list(activeOffboardingId),
    enabled: Boolean(activeOffboardingId),
  });

  const initiate = useMutation({
    mutationFn: (id: string) => hcmApi.separations.clearances.initiate(id),
    onSuccess: (_data, id) => {
      setActiveOffboardingId(id);
      qc.invalidateQueries({ queryKey: ['sep-clearances', id] });
    },
  });

  const clear = useMutation({
    mutationFn: (id: string) => hcmApi.separations.clearances.clear(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sep-clearances', activeOffboardingId] }),
  });
  const block = useMutation({
    mutationFn: () => hcmApi.separations.clearances.block(blockId!, blockNote),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sep-clearances', activeOffboardingId] });
      setBlockId(null);
      setBlockNote('');
    },
  });

  const acceptedColumns: ReadonlyArray<DataTableColumn<ResignationRow>> = [
    {
      id: 'employee',
      header: 'Employee',
      sortValue: (r) => r.employment.person.fullName,
      cell: (r) => r.employment.person.fullName,
    },
    {
      id: 'lastDay',
      header: 'Last day',
      sortValue: (r) => r.agreedLastDay ?? r.requestedLastDay,
      cell: (r) => date(r.agreedLastDay ?? r.requestedLastDay),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) =>
        r.offboardingId && (
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
        ),
    },
  ];

  const clearanceColumns: ReadonlyArray<DataTableColumn<ClearanceRow>> = [
    {
      id: 'department',
      header: 'Department',
      sortValue: (c) => c.department,
      cell: (c) => titleCase(c.department),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (c) => c.status,
      cell: (c) => <StatusChip status={c.status} tone={CLEARANCE_TONE[c.status]} />,
    },
    {
      id: 'note',
      header: 'Note',
      cell: (c) => <span className="text-ink-400">{c.note ?? '—'}</span>,
    },
    {
      id: 'cleared',
      header: 'Cleared',
      sortValue: (c) => c.clearedAt,
      cell: (c) => (c.clearedAt ? dateTime(c.clearedAt) : '—'),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (c) =>
        c.status !== 'cleared' && (
          <div className="flex justify-end gap-2">
            <button className="btn text-2xs" disabled={clear.isPending} onClick={() => clear.mutate(c.id)}>
              Clear
            </button>
            <button className="btn text-2xs" onClick={() => setBlockId(c.id)}>
              Block
            </button>
          </div>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Accepted resignations"
        subtitle="Open clearance once the last working day is settled — this moves the offboarding forward through last-day and into clearance."
      >
        <DataTable
          caption="Accepted resignations awaiting clearance"
          columns={acceptedColumns}
          rows={acceptedResignations.data ?? []}
          rowKey={(r) => r.id}
          loading={acceptedResignations.isLoading}
          error={acceptedResignations.error}
          emptyMessage="No accepted resignations yet."
        />
        {initiate.isError && <ErrorBox error={initiate.error} />}
      </Card>

      <Card
        title="Clearance detail"
        subtitle="Paste an offboarding id, or use “view clearance” above."
        actions={
          <div className="flex gap-2">
            <TextInput
              label="Offboarding id"
              placeholder="Paste an id"
              value={offboardingId}
              onChange={setOffboardingId}
            />
            <button className="btn text-2xs" onClick={() => setActiveOffboardingId(offboardingId)}>
              Load
            </button>
          </div>
        }
      >
        {!activeOffboardingId && <EmptyState message="No offboarding selected." />}
        {activeOffboardingId && (
          <DataTable
            caption="Exit clearance by department"
            columns={clearanceColumns}
            rows={clearances.data ?? []}
            rowKey={(c) => c.id}
            loading={clearances.isLoading}
            error={clearances.error}
            emptyMessage="Clearance has not been opened yet."
            emptyHint="Use “Open / refresh clearance” above."
          />
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
    queryFn: () => hcmApi.separations.clearances.list(activeOffboardingId),
    enabled: Boolean(activeOffboardingId),
  });
  const noDues = useQuery({
    queryKey: ['sep-no-dues', activeOffboardingId],
    queryFn: () => hcmApi.separations.noDues.get(activeOffboardingId),
    enabled: Boolean(activeOffboardingId),
  });

  const issue = useMutation({
    mutationFn: () => hcmApi.separations.noDues.issue(activeOffboardingId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sep-no-dues', activeOffboardingId] }),
  });

  const allCleared =
    clearances.data && clearances.data.length > 0 && clearances.data.every((c) => c.status === 'cleared');

  return (
    <Card
      title="No-dues certificate"
      subtitle="Issued only once every department has cleared — the button stays off otherwise."
      actions={
        <div className="flex gap-2">
          <TextInput
            label="Offboarding id"
            placeholder="Paste an id"
            value={offboardingId}
            onChange={setOffboardingId}
          />
          <button className="btn text-2xs" onClick={() => setActiveOffboardingId(offboardingId)}>
            Load
          </button>
        </div>
      }
    >
      {!activeOffboardingId && (
        <EmptyState message="No offboarding selected." hint="Paste an offboarding id from the Exit clearance tab." />
      )}
      {activeOffboardingId && (clearances.isLoading || noDues.isLoading) && <Loading />}
      {activeOffboardingId && (clearances.error || noDues.error) && (
        <ErrorBox error={clearances.error ?? noDues.error} />
      )}
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

const ALUMNI_COLUMNS: ReadonlyArray<DataTableColumn<AlumniRow>> = [
  {
    id: 'designation',
    header: 'Last designation',
    sortValue: (a) => a.lastDesignation,
    cell: (a) => a.lastDesignation,
  },
  {
    id: 'exitDate',
    header: 'Exit date',
    sortValue: (a) => a.exitDate,
    cell: (a) => date(a.exitDate),
  },
  {
    id: 'separation',
    header: 'Separation',
    sortValue: (a) => a.separationType,
    cell: (a) => <StatusChip status={a.separationType} />,
  },
  {
    id: 'rehire',
    header: 'Rehire eligible',
    sortValue: (a) => a.rehireEligible,
    cell: (a) => (a.rehireEligible === null ? 'Not assessed' : a.rehireEligible ? 'Yes' : 'No'),
  },
  {
    id: 'contact',
    header: 'Contact consent',
    cell: (a) => (a.contactConsent ? (a.contactEmail ?? a.contactPhone ?? 'Given') : 'Not given'),
  },
];

function AlumniTab() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    employmentRelationshipId: '',
    rehireEligible: 'unknown' as 'unknown' | 'yes' | 'no',
    rehireNote: '',
    contactConsent: false,
    contactEmail: '',
    contactPhone: '',
  });

  const alumni = useQuery({ queryKey: ['sep-alumni'], queryFn: () => hcmApi.separations.alumni.list() });

  return (
    <Card
      title="Alumni"
      subtitle="Written once, deliberately, when separation reaches Terminated — rehire eligibility and contact consent are not defaults."
      actions={<NewButton label="Record alumni" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Alumni records"
        columns={ALUMNI_COLUMNS}
        rows={alumni.data ?? []}
        rowKey={(a) => a.id}
        loading={alumni.isLoading}
        error={alumni.error}
        emptyMessage="No alumni recorded yet."
      />

      <CreateModal
        open={open}
        title="Record an alumni entry"
        onClose={() => setOpen(false)}
        invalidate={[['sep-alumni']]}
        onSubmit={() =>
          hcmApi.separations.alumni.record({
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
          <TextInput
            label="Contact email"
            type="email"
            value={form.contactEmail}
            onChange={(v) => setForm({ ...form, contactEmail: v })}
          />
          <TextInput
            label="Contact phone"
            type="tel"
            value={form.contactPhone}
            onChange={(v) => setForm({ ...form, contactPhone: v })}
          />
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

const NOTICE_POLICY_COLUMNS: ReadonlyArray<DataTableColumn<NoticePolicyRow>> = [
  { id: 'name', header: 'Name', sortValue: (p) => p.name, cell: (p) => p.name },
  { id: 'grade', header: 'Grade', cell: (p) => p.grade ?? 'Any' },
  {
    id: 'engagement',
    header: 'Engagement type',
    cell: (p) => (p.engagementType ? titleCase(p.engagementType) : 'Any'),
  },
  { id: 'noticeDays', header: 'Notice days', sortValue: (p) => p.noticeDays, cell: (p) => p.noticeDays },
  {
    id: 'buyout',
    header: 'Buyout',
    cell: (p) => (p.buyoutAllowed ? 'Allowed' : 'Not allowed'),
  },
  {
    id: 'active',
    header: 'Active',
    sortValue: (p) => p.active,
    cell: (p) => <StatusChip status={p.active ? 'active' : 'inactive'} tone={p.active ? 'good' : 'neutral'} />,
  },
];

function NoticePoliciesTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', grade: '', engagementType: '', noticeDays: '30', buyoutAllowed: true });

  const policies = useQuery({
    queryKey: ['sep-notice-policies'],
    queryFn: () => hcmApi.separations.noticePolicies.list(),
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      hcmApi.separations.noticePolicies.setActive(id, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sep-notice-policies'] }),
  });

  const columns: ReadonlyArray<DataTableColumn<NoticePolicyRow>> = [
    ...NOTICE_POLICY_COLUMNS,
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (p) => (
        <button className="btn text-2xs" onClick={() => toggle.mutate({ id: p.id, active: !p.active })}>
          {p.active ? 'Deactivate' : 'Activate'}
        </button>
      ),
    },
  ];

  return (
    <Card
      title="Notice policies"
      subtitle="What noticeDays comes from, by grade and engagement type. An employment with no matching row falls back to its own flat default."
      actions={<NewButton label="Add policy" onClick={() => setOpen(true)} />}
    >
      <DataTable
        caption="Notice policies"
        columns={columns}
        rows={policies.data ?? []}
        rowKey={(p) => p.id}
        loading={policies.isLoading}
        error={policies.error}
        emptyMessage="No notice policies defined."
        emptyHint="Every employment falls back to its own flat notice period."
      />

      <CreateModal
        open={open}
        title="Add a notice policy"
        onClose={() => setOpen(false)}
        invalidate={[['sep-notice-policies']]}
        onSubmit={() =>
          hcmApi.separations.noticePolicies.create({
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
          <TextInput
            label="Engagement type (optional)"
            value={form.engagementType}
            onChange={(v) => setForm({ ...form, engagementType: v })}
            placeholder="employee / contractor / …"
          />
        </Row>
        <TextInput
          label="Notice days"
          type="number"
          value={form.noticeDays}
          onChange={(v) => setForm({ ...form, noticeDays: v })}
          required
        />
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
