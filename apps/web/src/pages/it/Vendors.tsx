/**
 * Technology — vendors and contracts (docs/plan/cio.md, workstream C).
 *
 * Vendors list/detail (tabs by tier/status, assessment history, transitions)
 * and Contracts list/detail (tabs, approve on the Self-Dealing Bar shown the
 * way `Agreements` in `Commercial.tsx` shows it, renew, terminate).
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, money, relative, titleCase } from '../../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Metric,
  Modal,
  PageHeader,
  RecordCode,
  StatusChip,
  Tabs,
} from '../../components/ui.js';
import { NewButton, SelectInput, TextArea, TextInput, MoneyInput, Row, messageOf } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';

const TIERS = [1, 2, 3, 4] as const;
const RISKS = ['low', 'medium', 'high', 'critical'] as const;

function riskTone(risk: string): 'neutral' | 'good' | 'warn' | 'bad' {
  if (risk === 'critical') return 'bad';
  if (risk === 'high') return 'warn';
  if (risk === 'low') return 'good';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Vendors list
// ---------------------------------------------------------------------------

export function ItVendors() {
  const { can } = useSession();
  const [tab, setTab] = useState<'all' | 'tier1' | 'tier2' | 'suspended' | 'offboarded'>('all');
  const [creating, setCreating] = useState(false);

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['it-vendors'],
    queryFn: () => api.get<any[]>('/it/vendors'),
  });

  const { data: summary } = useQuery({
    queryKey: ['it-vendors-summary'],
    queryFn: () => api.get<any>('/it/vendors/summary'),
  });

  if (error) return <ErrorBox error={error} />;

  const filtered = data.filter((v) => {
    if (tab === 'tier1') return v.tier === 1;
    if (tab === 'tier2') return v.tier === 2;
    if (tab === 'suspended') return v.status === 'suspended';
    if (tab === 'offboarded') return v.status === 'offboarded';
    return true;
  });

  return (
    <div>
      <PageHeader
        title="Vendors"
        subtitle="Who we buy technology and services from, their risk tier and whether their security posture is current."
        actions={can('it_vendors:C') && <NewButton label="Add a vendor" onClick={() => setCreating(true)} />}
      />

      {summary && !summary.notYetMeasured && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="High/critical risk" value={summary.highRiskCount} sub={`${summary.highRiskWithDpa} with a DPA on file`} drillTo="/it/vendors" tone={summary.highRiskCount - summary.highRiskWithDpa > 0 ? 'warn' : 'neutral'} />
          <Metric label="Assessments overdue" value={summary.assessmentsOverdue} tone={summary.assessmentsOverdue > 0 ? 'bad' : 'good'} sub="Past next-due date" drillTo="/exceptions" />
          <Metric label="Tier 1 vendors" value={summary.byTier?.[1] ?? 0} sub="Business-stopping if they fail" drillTo="/it/vendors" />
          <Metric label="Total vendors" value={data.length} sub="Across every tier and status" drillTo="/it/vendors" />
        </div>
      )}
      {summary?.notYetMeasured && (
        <div className="mb-5">
          <Card><EmptyState message="Not yet measured — no vendors registered." /></Card>
        </div>
      )}

      <Tabs
        tabs={[
          { key: 'all', label: 'All' },
          { key: 'tier1', label: 'Tier 1' },
          { key: 'tier2', label: 'Tier 2' },
          { key: 'suspended', label: 'Suspended' },
          { key: 'offboarded', label: 'Offboarded' },
        ]}
        active={tab}
        onChange={setTab as (k: string) => void}
      />

      {isLoading ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <Card><EmptyState message="No vendors in this view." /></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((v) => (
            <Link key={v.id} to={`/it/vendors/${v.id}`} className="block">
              <Card
                title={v.name}
                subtitle={<RecordCode code={v.recordCode} />}
                actions={<StatusChip status={v.status} tone={v.status === 'active' ? 'good' : v.status === 'suspended' ? 'warn' : 'neutral'} />}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="chip border-ink-800 text-ink-400">Tier {v.tier}</span>
                  <StatusChip status={v.riskRating} tone={riskTone(v.riskRating)} />
                  <StatusChip status={v.assessmentStatus.replace('_', ' ')} tone={v.assessmentStatus === 'passed' ? 'good' : v.assessmentStatus === 'failed' || v.assessmentStatus === 'expired' ? 'bad' : 'neutral'} />
                  {!v.dpaSigned && (v.riskRating === 'high' || v.riskRating === 'critical') && (
                    <span className="chip border-band-critical/40 text-band-critical" title="A high or critical risk vendor with no DPA is a routing defect, not a normal state.">
                      no DPA
                    </span>
                  )}
                </div>
                <p className="mt-2 text-2xs text-ink-500">{v.category}</p>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <NewVendorModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function NewVendorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [tier, setTier] = useState('3');
  const [riskRating, setRiskRating] = useState('medium');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post('/it/vendors', {
        name,
        category,
        tier: Number(tier),
        riskRating,
        contactName: contactName || null,
        contactEmail: contactEmail || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-vendors'] });
      qc.invalidateQueries({ queryKey: ['it-vendors-summary'] });
      onClose();
      setName('');
      setCategory('');
    },
    onError: (err) => setError(messageOf(err)),
  });

  return (
    <Modal
      open={open}
      title="Add a vendor"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => create.mutate()} disabled={!name || !category || create.isPending}>
            Add vendor
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <TextInput label="Name" value={name} onChange={setName} />
        <TextInput label="Category" value={category} onChange={setCategory} placeholder="cloud, saas, staffing, hardware…" />
        <Row>
          <SelectInput label="Tier" value={tier} onChange={setTier} options={TIERS.map((t) => ({ value: String(t), label: `Tier ${t}` }))} />
          <SelectInput label="Risk rating" value={riskRating} onChange={setRiskRating} options={RISKS.map((r) => ({ value: r, label: titleCase(r) }))} />
        </Row>
        <Row>
          <TextInput label="Contact name" value={contactName} onChange={setContactName} />
          <TextInput label="Contact email" value={contactEmail} onChange={setContactEmail} />
        </Row>
        {error && <p className="text-2xs text-band-critical">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Vendor detail
// ---------------------------------------------------------------------------

export function ItVendorDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { can } = useSession();
  const [assessing, setAssessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: vendor, isLoading, error: loadError } = useQuery({
    queryKey: ['it-vendor', id],
    queryFn: () => api.get<any>(`/it/vendors/${id}`),
    enabled: Boolean(id),
  });

  const { data: contracts = [] } = useQuery({
    queryKey: ['it-vendor-contracts', id],
    queryFn: () => api.get<any[]>(`/it/contracts?vendorId=${id}`),
    enabled: Boolean(id),
  });

  const transition = useMutation({
    mutationFn: (event: string) => api.post(`/it/vendors/${id}/transition`, { event }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['it-vendor', id] });
      qc.invalidateQueries({ queryKey: ['it-vendors'] });
    },
    onError: (err) => setError(messageOf(err)),
  });

  if (loadError) return <ErrorBox error={loadError} />;
  if (isLoading || !vendor) return <Loading />;

  return (
    <div>
      <PageHeader
        title={vendor.name}
        subtitle={<RecordCode code={vendor.recordCode} />}
        actions={
          <div className="flex gap-1.5">
            {can('it_vendors:E') &&
              vendor.availableTransitions.map((t: string) => (
                <button key={t} className="btn-ghost" onClick={() => transition.mutate(t)} disabled={transition.isPending}>
                  {t === 'SUSPEND' ? 'Suspend' : t === 'REINSTATE' ? 'Reinstate' : 'Offboard'}
                </button>
              ))}
            {can('it_vendors:E') && <NewButton label="Record assessment" onClick={() => setAssessing(true)} />}
          </div>
        }
      />

      {error && (
        <div className="mb-3 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-2.5">
          <p className="text-xs text-band-critical">{error}</p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-1 space-y-3">
          <Card title="Vendor">
            <dl className="space-y-2">
              <Field label="Status"><StatusChip status={vendor.status} tone={vendor.status === 'active' ? 'good' : 'neutral'} /></Field>
              <Field label="Category">{vendor.category}</Field>
              <Field label="Tier">Tier {vendor.tier}</Field>
              <Field label="Risk rating">
                <StatusChip status={vendor.riskRating} tone={riskTone(vendor.riskRating)} />
                {vendor.riskRatedAt && <span className="ml-2 text-2xs text-ink-500">rated {date(vendor.riskRatedAt)}</span>}
              </Field>
              <Field label="Security assessment">
                <StatusChip status={vendor.assessmentStatus.replace('_', ' ')} tone={vendor.assessmentStatus === 'passed' ? 'good' : vendor.assessmentStatus === 'failed' || vendor.assessmentStatus === 'expired' ? 'bad' : 'neutral'} />
                {vendor.assessmentDueAt && <span className="ml-2 text-2xs text-ink-500">next due {date(vendor.assessmentDueAt)}</span>}
              </Field>
              <Field label="DPA">
                {vendor.dpaSigned ? (
                  <span className="text-band-good">Signed{vendor.dpaSignedAt ? ` ${date(vendor.dpaSignedAt)}` : ''}</span>
                ) : (
                  <span className={vendor.riskRating === 'high' || vendor.riskRating === 'critical' ? 'text-band-critical' : 'text-ink-500'}>Not signed</span>
                )}
              </Field>
              <Field label="Contact">{vendor.contactName ?? '—'}{vendor.contactEmail ? ` · ${vendor.contactEmail}` : ''}</Field>
              {vendor.organizationId && (
                <Field label="Also a party we deal with">
                  <Link to={`/organizations/${vendor.organizationId}`} className="text-accent-soft">View organization</Link>
                </Field>
              )}
            </dl>
          </Card>

          <Card title="Assessment history" bodyClassName="p-0">
            {vendor.riskAssessments.length === 0 ? (
              <EmptyState message="No assessments recorded yet." />
            ) : (
              <ul className="divide-y divide-ink-850">
                {vendor.riskAssessments.map((a: any) => (
                  <li key={a.id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <StatusChip status={a.outcome} tone={a.outcome === 'passed' ? 'good' : a.outcome === 'failed' ? 'bad' : 'neutral'} />
                      <span className="text-2xs text-ink-500">{date(a.assessedAt)}</span>
                    </div>
                    {a.score !== null && <p className="mt-1 text-2xs text-ink-400">Score {a.score}</p>}
                    {a.notes && <p className="mt-1 text-2xs text-ink-400">{a.notes}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card title="Contracts" subtitle="This vendor's priced instruments." bodyClassName="p-0">
            {contracts.length === 0 ? (
              <EmptyState message="No contracts with this vendor yet." />
            ) : (
              <ul className="divide-y divide-ink-850">
                {contracts.map((c: any) => (
                  <li key={c.id} className="px-4 py-3">
                    <Link to={`/it/contracts/${c.id}`} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <RecordCode code={c.recordCode} />
                          <StatusChip status={c.status} tone={['active', 'approved'].includes(c.status) ? 'good' : ['expiring'].includes(c.status) ? 'warn' : c.status === 'terminated' || c.status === 'expired' ? 'bad' : 'neutral'} />
                        </div>
                        <p className="mt-1 text-xs text-ink-100">{c.title}</p>
                      </div>
                      {can('it_vendor_contracts:F') && <span className="tabular-nums text-xs text-ink-200">{money(c.value, c.currency)}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <RecordAssessmentModal vendorId={id!} open={assessing} onClose={() => setAssessing(false)} />
    </div>
  );
}

function RecordAssessmentModal({ vendorId, open, onClose }: { vendorId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [assessor, setAssessor] = useState('');
  const [outcome, setOutcome] = useState('passed');
  const [score, setScore] = useState('');
  const [notes, setNotes] = useState('');
  const [riskRating, setRiskRating] = useState('');
  const [error, setError] = useState<string | null>(null);

  const record = useMutation({
    mutationFn: () =>
      api.post(`/it/vendors/${vendorId}/assess`, {
        assessor,
        outcome,
        score: score ? Number(score) : null,
        notes: notes || null,
        riskRating: riskRating || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-vendor', vendorId] });
      onClose();
      setAssessor('');
      setNotes('');
      setScore('');
    },
    onError: (err) => setError(messageOf(err)),
  });

  return (
    <Modal
      open={open}
      title="Record a security assessment"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => record.mutate()} disabled={!assessor || record.isPending}>
            Record
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-2xs text-ink-500">Sets the next assessment's due date from the tiered cadence and resets the overdue ladder.</p>
        <TextInput label="Assessor" value={assessor} onChange={setAssessor} placeholder="Who ran this assessment" />
        <Row>
          <SelectInput label="Outcome" value={outcome} onChange={setOutcome} options={['in_progress', 'passed', 'failed'].map((o) => ({ value: o, label: titleCase(o) }))} />
          <TextInput label="Score (optional)" value={score} onChange={setScore} />
        </Row>
        <SelectInput label="Update risk rating (optional)" value={riskRating} onChange={setRiskRating} options={[{ value: '', label: 'Leave unchanged' }, ...RISKS.map((r) => ({ value: r, label: titleCase(r) }))]} />
        <TextArea label="Notes" value={notes} onChange={setNotes} />
        {error && <p className="text-2xs text-band-critical">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Contracts list
// ---------------------------------------------------------------------------

export function ItVendorContracts() {
  const { can } = useSession();
  const [tab, setTab] = useState<'expiring' | 'awaiting_approval' | 'active' | 'all'>('all');
  const [creating, setCreating] = useState(false);

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['it-vendor-contracts-all'],
    queryFn: () => api.get<any[]>('/it/contracts'),
  });

  const { data: summary } = useQuery({
    queryKey: ['it-contracts-summary'],
    queryFn: () => api.get<any>('/it/contracts/summary'),
  });

  const { data: vendors = [] } = useQuery({
    queryKey: ['it-vendors-for-contracts'],
    queryFn: () => api.get<any[]>('/it/vendors'),
    enabled: creating,
  });

  if (error) return <ErrorBox error={error} />;

  const filtered = data.filter((c) => {
    if (tab === 'expiring') return c.status === 'expiring';
    if (tab === 'awaiting_approval') return c.status === 'proposed';
    if (tab === 'active') return c.status === 'active' || c.status === 'approved';
    return true;
  });

  const showValue = can('it_vendor_contracts:F');

  return (
    <div>
      <PageHeader
        title="Vendor Contracts"
        subtitle="The priced instruments that govern each vendor relationship."
        actions={can('it_vendor_contracts:C') && <NewButton label="New contract" onClick={() => setCreating(true)} />}
      />

      {summary && !summary.notYetMeasured && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {showValue && <Metric label="Value under management" value={money(summary.valueUnderManagement)} sub="Approved, active and expiring contracts" drillTo="/it/contracts" />}
          <Metric label="Expiring in 90 days" value={summary.expiringIn90Days} tone={summary.expiringIn90Days > 0 ? 'warn' : 'neutral'} drillTo="/it/contracts" />
          <Metric label="Awaiting approval" value={summary.awaitingApproval} tone={summary.awaitingApproval > 0 ? 'warn' : 'neutral'} drillTo="/it/contracts" />
          <Metric label="Active" value={summary.byStatus?.active ?? 0} sub="In force today" drillTo="/it/contracts" />
        </div>
      )}
      {summary?.notYetMeasured && (
        <div className="mb-5">
          <Card><EmptyState message="Not yet measured — no vendor contracts yet." /></Card>
        </div>
      )}

      <Tabs
        tabs={[
          { key: 'all', label: 'All' },
          { key: 'expiring', label: 'Expiring' },
          { key: 'awaiting_approval', label: 'Awaiting approval' },
          { key: 'active', label: 'Active' },
        ]}
        active={tab}
        onChange={setTab as (k: string) => void}
      />

      {isLoading ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <Card><EmptyState message="No contracts in this view." /></Card>
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Contract</th>
                <th>Vendor</th>
                {showValue && <th className="text-right">Value</th>}
                <th>End date</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td><RecordCode code={c.recordCode} to={`/it/contracts/${c.id}`} /></td>
                  <td className="text-xs text-ink-100">{c.title}</td>
                  <td className="text-2xs text-ink-400">{c.vendorName ?? '—'}</td>
                  {showValue && <td className="text-right tabular-nums text-xs">{money(c.value, c.currency)}</td>}
                  <td className="text-2xs text-ink-400">{c.endDate ? date(c.endDate) : '—'}</td>
                  <td><StatusChip status={c.status} tone={['active', 'approved'].includes(c.status) ? 'good' : c.status === 'expiring' ? 'warn' : c.status === 'terminated' || c.status === 'expired' ? 'bad' : 'neutral'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <NewContractModal vendors={vendors} open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function NewContractModal({ vendors, open, onClose }: { vendors: any[]; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [vendorId, setVendorId] = useState('');
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [endDate, setEndDate] = useState('');
  const [noticeDays, setNoticeDays] = useState('30');
  const [autoRenew, setAutoRenew] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post('/it/contracts', {
        vendorId,
        title,
        value: Number(value),
        endDate: endDate || null,
        noticeDays: Number(noticeDays),
        autoRenew,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-vendor-contracts-all'] });
      qc.invalidateQueries({ queryKey: ['it-contracts-summary'] });
      onClose();
      setTitle('');
      setValue('');
    },
    onError: (err) => setError(messageOf(err)),
  });

  return (
    <Modal
      open={open}
      title="New vendor contract"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => create.mutate()} disabled={!vendorId || !title || !value || create.isPending}>
            Create draft
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <SelectInput label="Vendor" value={vendorId} onChange={setVendorId} options={[{ value: '', label: 'Choose a vendor…' }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]} />
        <TextInput label="Title" value={title} onChange={setTitle} />
        <Row>
          <MoneyInput label="Value" value={value} onChange={setValue} />
          <TextInput label="Notice days" value={noticeDays} onChange={setNoticeDays} />
        </Row>
        <TextInput label="End date" value={endDate} onChange={setEndDate} placeholder="YYYY-MM-DD" />
        <label className="flex items-center gap-2 text-2xs text-ink-400">
          <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
          Auto-renews unless notice is given
        </label>
        {error && <p className="text-2xs text-band-critical">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Contract detail
// ---------------------------------------------------------------------------

export function ItVendorContractDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { can } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [gateResult, setGateResult] = useState<any>(null);
  const [terminating, setTerminating] = useState(false);
  const [renewing, setRenewing] = useState(false);

  const { data: contract, isLoading, error: loadError } = useQuery({
    queryKey: ['it-vendor-contract', id],
    queryFn: () => api.get<any>(`/it/contracts/${id}`),
    enabled: Boolean(id),
  });

  const transition = useMutation({
    mutationFn: (toStatus: string) => api.post<any>(`/it/contracts/${id}/transition`, { toStatus }),
    onSuccess: (res) => {
      setError(null);
      if (!res.applied) setGateResult(res);
      qc.invalidateQueries({ queryKey: ['it-vendor-contract', id] });
      qc.invalidateQueries({ queryKey: ['it-vendor-contracts-all'] });
    },
    onError: (err) => setError(messageOf(err)),
  });

  if (loadError) return <ErrorBox error={loadError} />;
  if (isLoading || !contract) return <Loading />;

  const showValue = can('it_vendor_contracts:F');

  return (
    <div>
      <PageHeader
        title={contract.title}
        subtitle={<RecordCode code={contract.recordCode} />}
        actions={
          <div className="flex flex-wrap gap-1.5">
            {contract.availableTransitions
              .filter((t: string) => t !== 'terminated')
              .map((t: string) => {
                const gated = contract.requiresApprovalFor.includes(t);
                if (gated && !can('it_vendor_contracts:approve')) return null;
                return (
                  <button
                    key={t}
                    className={gated ? 'btn-primary' : 'btn-ghost'}
                    onClick={() => transition.mutate(t)}
                    disabled={transition.isPending}
                    title={gated ? 'A privileged transition — runs the approval gate.' : undefined}
                  >
                    → {titleCase(t)}{gated && ' ⛨'}
                  </button>
                );
              })}
            {contract.availableTransitions.includes('terminated') && can('it_vendor_contracts:E') && (
              <button className="btn-danger" onClick={() => setTerminating(true)}>Terminate</button>
            )}
            {(contract.status === 'active' || contract.status === 'expiring' || contract.status === 'expired') && can('it_vendor_contracts:C') && (
              <button className="btn-ghost" onClick={() => setRenewing(true)}>Renew</button>
            )}
          </div>
        }
      />

      {error && (
        <div className="mb-3 rounded-lg border border-band-critical/40 bg-band-critical/5 px-4 py-2.5">
          <p className="text-xs text-band-critical">{error}</p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Contract" bodyClassName="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Field label="Status"><StatusChip status={contract.status} tone={['active', 'approved'].includes(contract.status) ? 'good' : contract.status === 'expiring' ? 'warn' : contract.status === 'terminated' || contract.status === 'expired' ? 'bad' : 'neutral'} /></Field>
            <Field label="Vendor">
              <Link to={`/it/vendors/${contract.vendorId}`} className="text-accent-soft">{contract.vendorName}</Link>
            </Field>
            {showValue && <Field label="Value">{money(contract.value, contract.currency)}</Field>}
            <Field label="Term">{contract.termMonths ? `${contract.termMonths} months` : '—'}</Field>
            <Field label="Start / End">{contract.startDate ? date(contract.startDate) : '—'} → {contract.endDate ? date(contract.endDate) : '—'}</Field>
            <Field label="Notice period">{contract.noticeDays} days{contract.daysToNotice !== null && ` · ${contract.daysToNotice}d to notice date`}</Field>
            <Field label="Auto-renew">{contract.autoRenew ? 'Yes — will renew unless notice is given' : 'No'}</Field>
            {contract.approvedAt && <Field label="Approved">{date(contract.approvedAt)}</Field>}
            {contract.renewedFromId && (
              <Field label="Renewed from"><Link to={`/it/contracts/${contract.renewedFromId}`} className="text-accent-soft">Predecessor contract</Link></Field>
            )}
            {contract.terminatedAt && (
              <Field label="Terminated">{date(contract.terminatedAt)} — {contract.terminationReason}</Field>
            )}
          </dl>
          {contract.slaText && (
            <div className="mt-3 border-t border-ink-800 pt-3">
              <p className="text-2xs text-ink-500">SLA</p>
              <p className="mt-1 text-xs text-ink-200">{contract.slaText}</p>
            </div>
          )}
        </Card>
      </div>

      <Modal open={Boolean(gateResult)} title="Approval required" onClose={() => setGateResult(null)}>
        {gateResult && (
          <div className="space-y-3">
            <p className="text-xs text-ink-200">{gateResult.reason}</p>
            <dl className="rounded border border-ink-800 bg-ink-950 p-3">
              <Field label="Who this goes to for approval">
                {titleCase(gateResult.resolvedApproverRole)} (tier {gateResult.resolutionTier + 1})
              </Field>
              {gateResult.selfDealingBarTripped && (
                <Field label="Self-Dealing Bar">
                  <span className="text-band-watch">
                    Tripped — the approver may never be the contract's own proposer. Resolution rerouted to the next
                    tier, and the attempt is audited as a watched pattern.
                  </span>
                </Field>
              )}
            </dl>
          </div>
        )}
      </Modal>

      <TerminateModal contractId={id!} open={terminating} onClose={() => setTerminating(false)} />
      <RenewModal contractId={id!} contract={contract} open={renewing} onClose={() => setRenewing(false)} />
    </div>
  );
}

function TerminateModal({ contractId, open, onClose }: { contractId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const terminate = useMutation({
    mutationFn: () => api.post(`/it/contracts/${contractId}/terminate`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['it-vendor-contract', contractId] });
      qc.invalidateQueries({ queryKey: ['it-vendor-contracts-all'] });
      onClose();
      setReason('');
    },
    onError: (err) => setError(messageOf(err)),
  });

  return (
    <Modal
      open={open}
      title="Terminate this contract"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-danger" onClick={() => terminate.mutate()} disabled={!reason.trim() || terminate.isPending}>
            Terminate
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-2xs text-ink-500">A reason is required. The approval history stays on the record either way.</p>
        <TextArea label="Reason" value={reason} onChange={setReason} />
        {error && <p className="text-2xs text-band-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function RenewModal({ contractId, contract, open, onClose }: { contractId: string; contract: any; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [endDate, setEndDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const renew = useMutation({
    mutationFn: () => api.post<any>(`/it/contracts/${contractId}/renew`, { endDate }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['it-vendor-contracts-all'] });
      onClose();
      setEndDate('');
      window.location.assign(`/it/contracts/${res.id}`);
    },
    onError: (err) => setError(messageOf(err)),
  });

  return (
    <Modal
      open={open}
      title="Renew this contract"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => renew.mutate()} disabled={!endDate || renew.isPending}>
            Create renewal
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-2xs text-ink-500">
          Creates a new draft contract chained to this one by "renewed from" — {contract?.title} is left exactly as it
          stands.
        </p>
        <TextInput label="New end date" value={endDate} onChange={setEndDate} placeholder="YYYY-MM-DD" />
        {error && <p className="text-2xs text-band-critical">{error}</p>}
      </div>
    </Modal>
  );
}
