/**
 * Payroll statutory (docs/plan/compliance.md, workstream E).
 *
 * States its own boundary the way the GST returns screen does: PF, ESI,
 * professional tax and LWF are computed in-platform from dated rate tables;
 * salary TDS (Sec 192) is workstream C's and stays whatever it writes. The
 * platform files nothing with EPFO or ESIC — it exports the ECR/ESIC text
 * an authorised signatory uploads by hand.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, date, dateTime } from '../../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  PageHeader,
  StatusChip,
  Tabs,
} from '../../components/ui.js';
import { CreateModal, MoneyInput, Row, TextInput, messageOf } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';

type Tab = 'runs' | 'structures' | 'rates' | 'payslips' | 'exports' | 'settlements';

/** Payroll run statuses are recorded PascalCase ("UnderReview"); this only affects display. */
function splitState(state: string): string {
  return state.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function thisMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function CompliancePayroll() {
  const [tab, setTab] = useState<Tab>('runs');
  return (
    <>
      <PageHeader
        title="Payroll statutory"
        subtitle="PF, ESI, professional tax and LWF computed in-platform from dated rate tables. This screen does not file anything with EPFO or ESIC — it exports the text a signatory uploads by hand."
      />
      <Tabs
        tabs={[
          { key: 'runs', label: 'Runs' },
          { key: 'structures', label: 'Salary structures' },
          { key: 'rates', label: 'Rate tables' },
          { key: 'payslips', label: 'Payslips' },
          { key: 'exports', label: 'Exports' },
          { key: 'settlements', label: 'Settlements' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'runs' && <RunsTab />}
      {tab === 'structures' && <StructuresTab />}
      {tab === 'rates' && <RatesTab />}
      {tab === 'payslips' && <PayslipsTab />}
      {tab === 'exports' && <ExportsTab />}
      {tab === 'settlements' && <SettlementsTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function RunsTab() {
  const qc = useQueryClient();
  const { user } = useSession();
  const runs = useQuery({ queryKey: ['payroll-runs'], queryFn: () => api.get<any[]>('/hr/payroll/runs') });
  const [selected, setSelected] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['payroll-run', selected],
    queryFn: () => api.get<any>(`/hr/payroll/runs/${selected}`),
    enabled: !!selected,
  });

  const compute = useMutation({
    mutationFn: (id: string) => api.post(`/compliance/payroll/runs/${id}/compute`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payroll-runs'] });
      qc.invalidateQueries({ queryKey: ['payroll-run', selected] });
    },
  });

  if (runs.isLoading) return <Loading />;
  if (runs.error) return <ErrorBox error={runs.error} />;
  if (!runs.data || runs.data.length === 0) return <EmptyState message="No payroll runs yet." />;

  const run = detail.data;
  // A run cannot be approved by whoever prepared it — the screen hides the
  // button rather than let a click land on a refusal that was always coming.
  const preparedByViewer = run?.preparedById && user?.personId && run.preparedById === user.personId;

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Card title="Runs" bodyClassName="p-0">
        <ul className="divide-y divide-ink-800">
          {runs.data.map((r) => (
            <li key={r.id}>
              <button
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-ink-850 ${selected === r.id ? 'bg-ink-850' : ''}`}
                onClick={() => setSelected(r.id)}
              >
                <span>{r.payPeriod}</span>
                <StatusChip status={splitState(r.status)} />
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={run ? `${run.payPeriod} — ${splitState(run.status)}` : 'Select a run'}>
        {!run && <EmptyState message="Pick a run from the list." />}
        {run && (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
              <Field label="Headcount">{run.headcount}</Field>
              <Field label="Gross">{money(run.grossTotal)}</Field>
              <Field label="Net">{money(run.netTotal)}</Field>
              <Field label="Prepared by">{preparedByViewer ? 'You' : run.preparedById ?? '—'}</Field>
            </dl>
            {run.status === 'Draft' && (
              <button className="btn-primary w-fit" disabled={compute.isPending} onClick={() => compute.mutate(run.id)}>
                {compute.isPending ? 'Computing…' : 'Compute statutory lines'}
              </button>
            )}
            {compute.error && <ErrorBox error={compute.error} />}
            {preparedByViewer && ['Computed', 'UnderReview'].includes(run.status) && (
              <p className="text-xs text-ink-400">
                You prepared this run, so you cannot approve it — the Self-Dealing Bar applies to payroll the same way it applies
                to a pay rise. Someone else with the payroll approval grant needs to sign it off.
              </p>
            )}
            <table className="w-full text-sm">
              <thead className="text-left text-2xs uppercase text-ink-500">
                <tr>
                  <th className="py-1">Employee</th>
                  <th className="py-1 text-right">Gross</th>
                  <th className="py-1 text-right">PF</th>
                  <th className="py-1 text-right">ESI</th>
                  <th className="py-1 text-right">PT</th>
                  <th className="py-1 text-right">Net</th>
                  <th className="py-1">Computed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-850">
                {(run.instructions ?? []).map((i: any) => (
                  <tr key={i.id}>
                    <td className="py-1">{i.employmentRelationship?.person?.fullName ?? i.employmentRelationshipId}</td>
                    <td className="py-1 text-right tabular-nums">{money(i.grossAmount)}</td>
                    <td className="py-1 text-right tabular-nums">{money(i.pfEmployee)}</td>
                    <td className="py-1 text-right tabular-nums">{money(i.esiEmployee)}</td>
                    <td className="py-1 text-right tabular-nums">{money(i.professionalTax)}</td>
                    <td className="py-1 text-right tabular-nums">{money(i.netAmount)}</td>
                    <td className="py-1">{i.computedFrom ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Salary structures
// ---------------------------------------------------------------------------

function StructuresTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const structures = useQuery({ queryKey: ['salary-structures'], queryFn: () => api.get<any[]>('/compliance/payroll/salary-structures') });

  const [employmentRelationshipId, setEmploymentRelationshipId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [ctcAnnual, setCtcAnnual] = useState('');
  const [basic, setBasic] = useState('');
  const [hra, setHra] = useState('');

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/compliance/payroll/salary-structures/${id}/approve`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['salary-structures'] }),
  });

  return (
    <Card
      title="Salary structures"
      actions={
        <button className="btn-primary" onClick={() => setOpen(true)}>
          Propose
        </button>
      }
    >
      {structures.isLoading && <Loading />}
      {structures.error && <ErrorBox error={structures.error} />}
      {structures.data && structures.data.length === 0 && <EmptyState message="No salary structures proposed yet." />}
      {structures.data && structures.data.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-2xs uppercase text-ink-500">
            <tr>
              <th className="py-1">Employment</th>
              <th className="py-1">Effective from</th>
              <th className="py-1 text-right">CTC / yr</th>
              <th className="py-1 text-right">Basic</th>
              <th className="py-1 text-right">HRA</th>
              <th className="py-1">Status</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-850">
            {structures.data.map((s: any) => (
              <tr key={s.id}>
                <td className="py-1">{s.employmentRelationshipId}</td>
                <td className="py-1">{date(s.effectiveFrom)}</td>
                <td className="py-1 text-right tabular-nums">{money(s.ctcAnnual)}</td>
                <td className="py-1 text-right tabular-nums">{money(s.basic)}</td>
                <td className="py-1 text-right tabular-nums">{money(s.hra)}</td>
                <td className="py-1">
                  <StatusChip status={s.status} tone={s.status === 'Approved' ? 'good' : 'neutral'} />
                </td>
                <td className="py-1">
                  {s.status === 'Proposed' && (
                    <button className="btn" disabled={approve.isPending} onClick={() => approve.mutate(s.id)}>
                      Approve
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
        title="Propose a salary structure"
        submitLabel="Propose"
        onClose={() => setOpen(false)}
        invalidate={[['salary-structures']]}
        onSubmit={() =>
          api.post('/compliance/payroll/salary-structures', {
            employmentRelationshipId,
            effectiveFrom,
            ctcAnnual: Number(ctcAnnual),
            basic: Number(basic),
            hra: Number(hra),
          })
        }
      >
        <TextInput label="Employment relationship id" value={employmentRelationshipId} onChange={setEmploymentRelationshipId} required />
        <TextInput label="Effective from" type="date" value={effectiveFrom} onChange={setEffectiveFrom} required />
        <Row>
          <MoneyInput label="CTC (annual)" value={ctcAnnual} onChange={setCtcAnnual} required />
          <MoneyInput label="Basic (monthly)" value={basic} onChange={setBasic} required />
        </Row>
        <MoneyInput label="HRA (monthly)" value={hra} onChange={setHra} required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Rate tables
// ---------------------------------------------------------------------------

function RatesTab() {
  const pf = useQuery({ queryKey: ['rt-pf'], queryFn: () => api.get<any[]>('/compliance/payroll/rate-tables/pf') });
  const esi = useQuery({ queryKey: ['rt-esi'], queryFn: () => api.get<any[]>('/compliance/payroll/rate-tables/esi') });
  const pt = useQuery({ queryKey: ['rt-pt'], queryFn: () => api.get<any[]>('/compliance/payroll/rate-tables/pt') });
  const lwf = useQuery({ queryKey: ['rt-lwf'], queryFn: () => api.get<any[]>('/compliance/payroll/rate-tables/lwf') });
  const mw = useQuery({ queryKey: ['rt-mw'], queryFn: () => api.get<any[]>('/compliance/payroll/rate-tables/minimum-wage') });

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="PF (EPF & MP Act 1952)">
        {(pf.data ?? []).map((r: any) => (
          <dl key={r.id} className="grid grid-cols-2 gap-x-4 text-sm">
            <Field label="Effective">{date(r.effectiveFrom)}</Field>
            <Field label="Wage ceiling">{money(r.wageCeiling)}</Field>
            <Field label="Employee">{(Number(r.employeeRate) * 100).toFixed(2)}%</Field>
            <Field label="Employer">{(Number(r.employerRate) * 100).toFixed(2)}%</Field>
            <Field label="EPS">{(Number(r.epsRate) * 100).toFixed(2)}%</Field>
          </dl>
        ))}
        {pf.data?.length === 0 && <EmptyState message="No PF rate table on file." />}
      </Card>
      <Card title="ESI (ESI Act 1948)">
        {(esi.data ?? []).map((r: any) => (
          <dl key={r.id} className="grid grid-cols-2 gap-x-4 text-sm">
            <Field label="Effective">{date(r.effectiveFrom)}</Field>
            <Field label="Wage ceiling">{money(r.wageCeiling)}</Field>
            <Field label="Employee">{(Number(r.employeeRate) * 100).toFixed(2)}%</Field>
            <Field label="Employer">{(Number(r.employerRate) * 100).toFixed(2)}%</Field>
          </dl>
        ))}
        {esi.data?.length === 0 && <EmptyState message="No ESI rate table on file." />}
      </Card>
      <Card title="Professional Tax (Tamil Nadu)">
        {(pt.data ?? []).map((r: any) => (
          <div key={r.id} className="text-sm">
            <p className="text-2xs text-ink-500">Effective {date(r.effectiveFrom)}</p>
            {r.confirmNote && <p className="mt-1 text-2xs text-band-warn">{r.confirmNote}</p>}
            <table className="mt-2 w-full text-2xs">
              <tbody>
                {(r.slabs ?? []).map((s: any, idx: number) => (
                  <tr key={idx}>
                    <td>
                      {money(s.minGross)}–{s.maxGross ? money(s.maxGross) : '+'}
                    </td>
                    <td className="text-right">{money(s.halfYearlyAmount)} / half-year</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {pt.data?.length === 0 && <EmptyState message="No Professional Tax slab table on file." />}
      </Card>
      <Card title="Labour Welfare Fund (Tamil Nadu)">
        {(lwf.data ?? []).map((r: any) => (
          <div key={r.id} className="text-sm">
            <p className="text-2xs text-ink-500">Effective {date(r.effectiveFrom)}, due month {r.dueMonth}</p>
            {r.confirmNote && <p className="mt-1 text-2xs text-band-warn">{r.confirmNote}</p>}
            <dl className="mt-1 grid grid-cols-2 gap-x-4">
              <Field label="Employee">{money(r.employeeAmount)}</Field>
              <Field label="Employer">{money(r.employerAmount)}</Field>
            </dl>
          </div>
        ))}
        {lwf.data?.length === 0 && <EmptyState message="No LWF rate table on file." />}
      </Card>
      <Card title="Minimum wage">
        {(mw.data ?? []).length === 0 && <EmptyState message="No minimum wage table on file." />}
        {(mw.data ?? []).map((r: any) => (
          <p key={r.id} className="text-sm">
            {r.state} · {r.category}: {money(r.monthlyAmount)}/month
          </p>
        ))}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------

function PayslipsTab() {
  const payslips = useQuery({ queryKey: ['payslips'], queryFn: () => api.get<any[]>('/compliance/payroll/payslips') });
  const [open, setOpen] = useState<any | null>(null);
  const doc = useQuery({
    queryKey: ['payslip-doc', open?.id],
    queryFn: () => api.get<any>(`/compliance/payroll/payslips/${open.id}/document`),
    enabled: !!open,
  });

  if (payslips.isLoading) return <Loading />;
  if (payslips.error) return <ErrorBox error={payslips.error} />;
  if (!payslips.data || payslips.data.length === 0) return <EmptyState message="No payslips issued yet. A payslip is issued when its run is approved." />;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <Card title="Payslips" bodyClassName="p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-2xs uppercase text-ink-500">
            <tr>
              <th className="px-3 py-1">Number</th>
              <th className="px-3 py-1">Period</th>
              <th className="px-3 py-1">Issued</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-850">
            {payslips.data.map((p: any) => (
              <tr key={p.id} className="cursor-pointer hover:bg-ink-850" onClick={() => setOpen(p)}>
                <td className="px-3 py-1">{p.number}</td>
                <td className="px-3 py-1">{p.payPeriod}</td>
                <td className="px-3 py-1">{dateTime(p.issuedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title={open ? `Payslip ${open.number}` : 'Select a payslip'}>
        {!open && <EmptyState message="Pick a payslip to see the printable document." />}
        {open && doc.data && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">{doc.data.snapshot.employer.name}</p>
            <p className="text-2xs text-ink-500">{doc.data.snapshot.employer.address}</p>
            <p className="mt-2">{doc.data.snapshot.employee.name} — {doc.data.snapshot.employee.designation ?? 'no title on file'}</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4">
              <Field label="Basic">{money(doc.data.snapshot.earnings.basic)}</Field>
              <Field label="HRA">{money(doc.data.snapshot.earnings.hra)}</Field>
              <Field label="Gross">{money(doc.data.snapshot.earnings.gross)}</Field>
              <Field label="PF">{money(doc.data.snapshot.deductions.pf)}</Field>
              <Field label="ESI">{money(doc.data.snapshot.deductions.esi)}</Field>
              <Field label="PT">{money(doc.data.snapshot.deductions.professionalTax)}</Field>
              <Field label="Net pay">{money(doc.data.snapshot.net)}</Field>
              <Field label="Bank">{doc.data.snapshot.bankLast4 ? `••••${doc.data.snapshot.bankLast4}` : 'not on file'}</Field>
            </dl>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function ExportsTab() {
  const [runId, setRunId] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');

  const run = async (kind: 'ecr' | 'esic') => {
    setError(null);
    try {
      const result = await api.get<{ text: string }>(`/compliance/payroll/runs/${runId}/${kind}`);
      setText(result.text);
      setLabel(kind.toUpperCase());
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <Card title="Exports" subtitle="Prepares the text an authorised signatory uploads on the EPFO/ESIC portal directly. Nothing here transmits anything.">
      <div className="flex flex-col gap-3">
        <TextInput label="Payroll run id" value={runId} onChange={setRunId} placeholder="cl..." />
        <div className="flex gap-2">
          <button className="btn" disabled={!runId} onClick={() => run('ecr')}>
            Export ECR
          </button>
          <button className="btn" disabled={!runId} onClick={() => run('esic')}>
            Export ESIC CSV
          </button>
        </div>
        {error && <p className="text-sm text-band-critical">{error}</p>}
        {text !== null && (
          <div>
            <p className="mb-1 text-2xs uppercase text-ink-500">{label}</p>
            <textarea className="input h-64 font-mono text-2xs" readOnly value={text} />
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

function SettlementsTab() {
  const [offboardingId, setOffboardingId] = useState('');
  const [result, setResult] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const settle = async () => {
    setError(null);
    setPending(true);
    try {
      const r = await api.post(`/compliance/payroll/offboarding/${offboardingId}/settle`, {});
      setResult(r);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card title="Full-and-final settlement" subtitle="Gratuity, leave encashment, pro-rata bonus and notice recovery, computed from years of service and the approved salary structure.">
      <div className="flex flex-col gap-3">
        <TextInput label="Offboarding id" value={offboardingId} onChange={setOffboardingId} />
        <button className="btn-primary w-fit" disabled={!offboardingId || pending} onClick={settle}>
          {pending ? 'Computing…' : 'Compute settlement'}
        </button>
        {error && <p className="text-sm text-band-critical">{error}</p>}
        {result && (
          <dl className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
            <Field label="Gratuity">{money(result.gratuityAmount)}</Field>
            <Field label="Leave encashment">{money(result.leaveEncashmentAmount)}</Field>
            <Field label="Bonus">{money(result.bonusAmount)}</Field>
            <Field label="Notice recovery">{money(result.noticeRecoveryAmount)}</Field>
            <Field label="Total settlement">{money(result.settlementAmount)}</Field>
          </dl>
        )}
      </div>
    </Card>
  );
}
