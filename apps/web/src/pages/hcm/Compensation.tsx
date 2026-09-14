/**
 * Compensation — WS7 (docs/hcm/compensation.md).
 *
 * Six tabs: pay grades, salary revision cycles (propose lines, approve each
 * one, approve the cycle, apply it into effective pay), variable pay,
 * benefits, employee loans and expense claims. Every approve action here
 * enforces the Self-Dealing Bar server-side — the proposer/requester and the
 * employee a line is about can never also be its approver — so this screen
 * never offers an approve button to someone the server would refuse; it
 * relies on the server's own refusal message when a person tries anyway from
 * a role that could reach the button.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, messageOf, MoneyInput, NewButton, Row, SelectInput, TextInput } from '../../components/forms.js';

type Tab = 'grades' | 'cycles' | 'variable' | 'benefits' | 'loans' | 'expenses';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'grades', label: 'Grades' },
  { key: 'cycles', label: 'Revision cycles' },
  { key: 'variable', label: 'Variable pay' },
  { key: 'benefits', label: 'Benefits' },
  { key: 'loans', label: 'Loans' },
  { key: 'expenses', label: 'Expenses' },
];

export function Compensation() {
  const [tab, setTab] = useState<Tab>('grades');
  return (
    <>
      <PageHeader
        title="Compensation"
        subtitle="Pay grades, salary revision cycles, variable pay, benefits, employee loans and expense claims. A pay change never lands in effect until a second party who is neither the proposer nor the employee it is about signs it."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'grades' && <GradesTab />}
      {tab === 'cycles' && <CyclesTab />}
      {tab === 'variable' && <VariableTab />}
      {tab === 'benefits' && <BenefitsTab />}
      {tab === 'loans' && <LoansTab />}
      {tab === 'expenses' && <ExpensesTab />}
    </>
  );
}

function withheldOrMoney(value: number | null, reason: string | null | undefined) {
  if (value !== null) return `₹${value.toLocaleString('en-IN')}`;
  return reason ? <span className="italic text-ink-500" title={reason}>withheld</span> : '—';
}

// ---------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------

interface PayGrade {
  id: string;
  code: string;
  level: number;
  minPay: string | number;
  midPay: string | number;
  maxPay: string | number;
  currency: string;
}

function GradesTab() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', level: '1', minPay: '', midPay: '', maxPay: '' });
  const grades = useQuery({ queryKey: ['comp-grades'], queryFn: () => api.get<PayGrade[]>('/hcm/compensation/pay-grades') });

  return (
    <Card title="Pay grades" subtitle="The money side of a band — WS1's Grade is the level/code; this is the CTC range." actions={<NewButton label="Add grade" onClick={() => setOpen(true)} />}>
      {grades.isLoading && <Loading />}
      {grades.error && <ErrorBox error={grades.error} />}
      {grades.data && grades.data.length === 0 && <EmptyState message="No pay grades defined yet." hint="A grade sets the min/mid/max CTC an offer or a revision is checked against." />}
      {grades.data && grades.data.length > 0 && (
        <table className="table">
          <thead><tr><th>Code</th><th>Level</th><th>Min</th><th>Mid</th><th>Max</th><th>Currency</th></tr></thead>
          <tbody>
            {grades.data.map((g) => (
              <tr key={g.id}>
                <td className="mono">{g.code}</td>
                <td>{g.level}</td>
                <td>₹{Number(g.minPay).toLocaleString('en-IN')}</td>
                <td>₹{Number(g.midPay).toLocaleString('en-IN')}</td>
                <td>₹{Number(g.maxPay).toLocaleString('en-IN')}</td>
                <td>{g.currency}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CreateModal
        open={open}
        title="Add a pay grade"
        onClose={() => setOpen(false)}
        invalidate={[['comp-grades']]}
        onSubmit={() =>
          api.post('/hcm/compensation/pay-grades', {
            code: form.code,
            level: Number(form.level),
            minPay: Number(form.minPay),
            midPay: Number(form.midPay),
            maxPay: Number(form.maxPay),
          })
        }
      >
        <Row>
          <TextInput label="Code" value={form.code} onChange={(v) => setForm({ ...form, code: v })} required />
          <TextInput label="Level" type="number" value={form.level} onChange={(v) => setForm({ ...form, level: v })} required />
        </Row>
        <Row>
          <MoneyInput label="Min pay (annual)" value={form.minPay} onChange={(v) => setForm({ ...form, minPay: v })} required />
          <MoneyInput label="Mid pay (annual)" value={form.midPay} onChange={(v) => setForm({ ...form, midPay: v })} required />
        </Row>
        <MoneyInput label="Max pay (annual)" value={form.maxPay} onChange={(v) => setForm({ ...form, maxPay: v })} required />
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Revision cycles
// ---------------------------------------------------------------------------

interface Cycle {
  id: string;
  recordCode: string;
  name: string;
  effectiveDate: string;
  budgetPct: string | number;
  status: string;
}

interface RevisionLine {
  id: string;
  employmentRelationshipId: string;
  currentCtc: number | null;
  proposedPct: string | number;
  proposedCtc: number | null;
  approvedCtc: number | null;
  status: string;
  moneyWithheldReason: string | null;
}

function CyclesTab() {
  const qc = useQueryClient();
  const [openCycle, setOpenCycle] = useState(false);
  const [cycleForm, setCycleForm] = useState({ name: '', effectiveDate: '', budgetPct: '5' });
  const [selected, setSelected] = useState<string | null>(null);
  const [openLine, setOpenLine] = useState(false);
  const [lineForm, setLineForm] = useState({ employmentRelationshipId: '', currentCtc: '', proposedPct: '' });

  const cycles = useQuery({ queryKey: ['comp-cycles'], queryFn: () => api.get<Cycle[]>('/hcm/compensation/revision-cycles') });
  const lines = useQuery({
    queryKey: ['comp-cycle-lines', selected],
    queryFn: () => api.get<RevisionLine[]>(`/hcm/compensation/revision-cycles/${selected}/lines`),
    enabled: !!selected,
  });

  const propose = useMutation({ mutationFn: (id: string) => api.post(`/hcm/compensation/revision-cycles/${id}/propose`), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-cycles'] }) });
  const approveCycleM = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/compensation/revision-cycles/${id}/approve`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-cycles'] }),
    onError: (e) => alert(messageOf(e)),
  });
  const applyCycleM = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/compensation/revision-cycles/${id}/apply`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-cycles'] }),
    onError: (e) => alert(messageOf(e)),
  });
  const approveLine = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/compensation/revision-lines/${id}/approve`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-cycle-lines', selected] }),
    onError: (e) => alert(messageOf(e)),
  });
  const rejectLine = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/compensation/revision-lines/${id}/reject`, { note: 'Rejected from the cycle screen.' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-cycle-lines', selected] }),
    onError: (e) => alert(messageOf(e)),
  });

  return (
    <div className="space-y-4">
      <Card title="Salary revision cycles" actions={<NewButton label="New cycle" onClick={() => setOpenCycle(true)} />}>
        {cycles.isLoading && <Loading />}
        {cycles.error && <ErrorBox error={cycles.error} />}
        {cycles.data && cycles.data.length === 0 && <EmptyState message="No revision cycles yet." hint="A cycle carries a budget percentage; every approved line's aggregate increase is checked against it before the cycle can be approved." />}
        {cycles.data && cycles.data.length > 0 && (
          <table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>Effective</th><th>Budget</th><th>Status</th><th /></tr></thead>
            <tbody>
              {cycles.data.map((c) => (
                <tr key={c.id} className={selected === c.id ? 'bg-ink-850/60' : ''}>
                  <td className="mono">{c.recordCode}</td>
                  <td><button className="text-accent-soft hover:underline" onClick={() => setSelected(c.id)}>{c.name}</button></td>
                  <td>{date(c.effectiveDate)}</td>
                  <td>{Number(c.budgetPct)}%</td>
                  <td><StatusChip status={c.status} tone={c.status === 'applied' ? 'good' : c.status === 'draft' ? 'neutral' : 'accent'} /></td>
                  <td className="flex justify-end gap-1 text-right">
                    {c.status === 'draft' && <button className="btn text-2xs" onClick={() => propose.mutate(c.id)}>Propose</button>}
                    {c.status === 'proposed' && <button className="btn text-2xs" onClick={() => approveCycleM.mutate(c.id)}>Approve cycle</button>}
                    {c.status === 'approved' && <button className="btn text-2xs" onClick={() => applyCycleM.mutate(c.id)}>Apply</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <CreateModal
          open={openCycle}
          title="New revision cycle"
          onClose={() => setOpenCycle(false)}
          invalidate={[['comp-cycles']]}
          onSubmit={() => api.post('/hcm/compensation/revision-cycles', { name: cycleForm.name, effectiveDate: cycleForm.effectiveDate, budgetPct: Number(cycleForm.budgetPct) })}
        >
          <TextInput label="Name" value={cycleForm.name} onChange={(v) => setCycleForm({ ...cycleForm, name: v })} required />
          <Row>
            <TextInput label="Effective from" type="date" value={cycleForm.effectiveDate} onChange={(v) => setCycleForm({ ...cycleForm, effectiveDate: v })} required />
            <TextInput label="Budget %" type="number" value={cycleForm.budgetPct} onChange={(v) => setCycleForm({ ...cycleForm, budgetPct: v })} required hint="Ceiling on the cycle's aggregate CTC increase." />
          </Row>
        </CreateModal>
      </Card>

      {selected && (
        <Card
          title="Lines"
          subtitle="One row per employment. Approving a line requires a party who is neither the proposer nor the employee it is about."
          actions={<NewButton label="Add line" onClick={() => setOpenLine(true)} />}
        >
          {lines.isLoading && <Loading />}
          {lines.error && <ErrorBox error={lines.error} />}
          {lines.data && lines.data.length === 0 && <EmptyState message="No lines in this cycle yet." />}
          {lines.data && lines.data.length > 0 && (
            <table className="table">
              <thead><tr><th>Employment</th><th>Current</th><th>Proposed %</th><th>Proposed</th><th>Approved</th><th>Status</th><th /></tr></thead>
              <tbody>
                {lines.data.map((l) => (
                  <tr key={l.id}>
                    <td className="mono">{l.employmentRelationshipId.slice(0, 10)}…</td>
                    <td>{withheldOrMoney(l.currentCtc, l.moneyWithheldReason)}</td>
                    <td>{Number(l.proposedPct)}%</td>
                    <td>{withheldOrMoney(l.proposedCtc, l.moneyWithheldReason)}</td>
                    <td>{withheldOrMoney(l.approvedCtc, l.moneyWithheldReason)}</td>
                    <td><StatusChip status={l.status} tone={l.status === 'applied' ? 'good' : l.status === 'rejected' ? 'bad' : 'neutral'} /></td>
                    <td className="flex justify-end gap-1 text-right">
                      {l.status === 'proposed' && (
                        <>
                          <button className="btn text-2xs" onClick={() => approveLine.mutate(l.id)}>Approve</button>
                          <button className="btn text-2xs" onClick={() => rejectLine.mutate(l.id)}>Reject</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <CreateModal
            open={openLine}
            title="Add a revision line"
            onClose={() => setOpenLine(false)}
            invalidate={[['comp-cycle-lines', selected]]}
            onSubmit={() =>
              api.post(`/hcm/compensation/revision-cycles/${selected}/lines`, {
                employmentRelationshipId: lineForm.employmentRelationshipId,
                currentCtc: Number(lineForm.currentCtc),
                proposedPct: Number(lineForm.proposedPct),
              })
            }
          >
            <TextInput label="Employment relationship id" value={lineForm.employmentRelationshipId} onChange={(v) => setLineForm({ ...lineForm, employmentRelationshipId: v })} required />
            <Row>
              <MoneyInput label="Current CTC (annual)" value={lineForm.currentCtc} onChange={(v) => setLineForm({ ...lineForm, currentCtc: v })} required />
              <TextInput label="Proposed increase %" type="number" value={lineForm.proposedPct} onChange={(v) => setLineForm({ ...lineForm, proposedPct: v })} required />
            </Row>
          </CreateModal>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variable pay
// ---------------------------------------------------------------------------

interface VPPlan { id: string; name: string; kind: string; period: string; formula: { type: string; pct?: number; amount?: number } }
interface VPPayout { id: string; planId: string; employmentRelationshipId: string; period: string; computedAmount: number | null; approvedAmount: number | null; status: string; moneyWithheldReason: string | null }

function VariableTab() {
  const qc = useQueryClient();
  const [openPlan, setOpenPlan] = useState(false);
  const [planForm, setPlanForm] = useState({ name: '', kind: 'bonus' as 'bonus' | 'commission' | 'incentive', period: 'annual' as 'monthly' | 'quarterly' | 'annual', pct: '10' });
  const [openCompute, setOpenCompute] = useState(false);
  const [computeForm, setComputeForm] = useState({ planId: '', employmentRelationshipId: '', period: '', base: '' });

  const plans = useQuery({ queryKey: ['comp-vp-plans'], queryFn: () => api.get<VPPlan[]>('/hcm/compensation/variable-pay-plans') });
  const payouts = useQuery({ queryKey: ['comp-vp-payouts'], queryFn: () => api.get<VPPayout[]>('/hcm/compensation/variable-payouts') });

  const approve = useMutation({ mutationFn: (id: string) => api.post(`/hcm/compensation/variable-payouts/${id}/approve`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-vp-payouts'] }), onError: (e) => alert(messageOf(e)) });
  const pay = useMutation({ mutationFn: (id: string) => api.post(`/hcm/compensation/variable-payouts/${id}/pay`), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-vp-payouts'] }) });

  return (
    <div className="space-y-4">
      <Card title="Plans" actions={<NewButton label="New plan" onClick={() => setOpenPlan(true)} />}>
        {plans.isLoading && <Loading />}
        {plans.data && plans.data.length === 0 && <EmptyState message="No variable pay plans yet." />}
        {plans.data && plans.data.length > 0 && (
          <table className="table">
            <thead><tr><th>Name</th><th>Kind</th><th>Period</th><th>Formula</th></tr></thead>
            <tbody>
              {plans.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td><StatusChip status={p.kind} /></td>
                  <td>{p.period}</td>
                  <td className="text-2xs text-ink-400">{p.formula.type === 'percentage_of_base' ? `${p.formula.pct}% of base` : p.formula.type === 'fixed' ? `₹${p.formula.amount}` : 'tiered'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <CreateModal
          open={openPlan}
          title="New variable pay plan"
          onClose={() => setOpenPlan(false)}
          invalidate={[['comp-vp-plans']]}
          onSubmit={() => api.post('/hcm/compensation/variable-pay-plans', { name: planForm.name, kind: planForm.kind, period: planForm.period, formula: { type: 'percentage_of_base', pct: Number(planForm.pct) } })}
        >
          <TextInput label="Name" value={planForm.name} onChange={(v) => setPlanForm({ ...planForm, name: v })} required />
          <Row>
            <SelectInput label="Kind" value={planForm.kind} onChange={(v) => setPlanForm({ ...planForm, kind: v })} options={[{ value: 'bonus', label: 'Bonus' }, { value: 'commission', label: 'Commission' }, { value: 'incentive', label: 'Incentive' }]} required />
            <SelectInput label="Period" value={planForm.period} onChange={(v) => setPlanForm({ ...planForm, period: v })} options={[{ value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'annual', label: 'Annual' }]} required />
          </Row>
          <TextInput label="Percentage of base" type="number" value={planForm.pct} onChange={(v) => setPlanForm({ ...planForm, pct: v })} required hint="This plan pays this % of whatever base figure is supplied when a payout is computed." />
        </CreateModal>
      </Card>

      <Card title="Payouts" actions={<NewButton label="Compute payout" onClick={() => setOpenCompute(true)} />}>
        {payouts.isLoading && <Loading />}
        {payouts.data && payouts.data.length === 0 && <EmptyState message="No payouts computed yet." />}
        {payouts.data && payouts.data.length > 0 && (
          <table className="table">
            <thead><tr><th>Employment</th><th>Period</th><th>Computed</th><th>Approved</th><th>Status</th><th /></tr></thead>
            <tbody>
              {payouts.data.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.employmentRelationshipId.slice(0, 10)}…</td>
                  <td>{p.period}</td>
                  <td>{withheldOrMoney(p.computedAmount, p.moneyWithheldReason)}</td>
                  <td>{withheldOrMoney(p.approvedAmount, p.moneyWithheldReason)}</td>
                  <td><StatusChip status={p.status} tone={p.status === 'paid' ? 'good' : 'neutral'} /></td>
                  <td className="flex justify-end gap-1 text-right">
                    {p.status === 'computed' && <button className="btn text-2xs" onClick={() => approve.mutate(p.id)}>Approve</button>}
                    {p.status === 'approved' && <button className="btn text-2xs" onClick={() => pay.mutate(p.id)}>Mark paid</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <CreateModal
          open={openCompute}
          title="Compute a payout"
          onClose={() => setOpenCompute(false)}
          invalidate={[['comp-vp-payouts']]}
          onSubmit={() => api.post('/hcm/compensation/variable-payouts/compute', { planId: computeForm.planId, employmentRelationshipId: computeForm.employmentRelationshipId, period: computeForm.period, base: Number(computeForm.base) })}
        >
          <SelectInput label="Plan" value={computeForm.planId} onChange={(v) => setComputeForm({ ...computeForm, planId: v })} options={(plans.data ?? []).map((p) => ({ value: p.id, label: p.name }))} placeholder="Choose a plan" required />
          <TextInput label="Employment relationship id" value={computeForm.employmentRelationshipId} onChange={(v) => setComputeForm({ ...computeForm, employmentRelationshipId: v })} required />
          <Row>
            <TextInput label="Period" placeholder="2026-Q2" value={computeForm.period} onChange={(v) => setComputeForm({ ...computeForm, period: v })} required />
            <MoneyInput label="Base figure" value={computeForm.base} onChange={(v) => setComputeForm({ ...computeForm, base: v })} required />
          </Row>
        </CreateModal>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Benefits
// ---------------------------------------------------------------------------

interface Plan { id: string; name: string; kind: string; provider: string | null; employerContribution: string | number; employeeContribution: string | number; active: boolean }
interface Enrollment { id: string; planId: string; employmentRelationshipId: string; status: string }

function BenefitsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', kind: 'health' as Plan['kind'], provider: '', employerContribution: '', employeeContribution: '' });
  const plans = useQuery({ queryKey: ['comp-benefit-plans'], queryFn: () => api.get<Plan[]>('/hcm/compensation/benefit-plans') });
  const enrollments = useQuery({ queryKey: ['comp-benefit-enrollments'], queryFn: () => api.get<Enrollment[]>('/hcm/compensation/benefit-enrollments') });

  return (
    <div className="space-y-4">
      <Card title="Benefit plans" actions={<NewButton label="New plan" onClick={() => setOpen(true)} />}>
        {plans.isLoading && <Loading />}
        {plans.data && plans.data.length === 0 && <EmptyState message="No benefit plans yet." />}
        {plans.data && plans.data.length > 0 && (
          <table className="table">
            <thead><tr><th>Name</th><th>Kind</th><th>Provider</th><th>Employer</th><th>Employee</th></tr></thead>
            <tbody>
              {plans.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td><StatusChip status={p.kind} /></td>
                  <td>{p.provider ?? '—'}</td>
                  <td>₹{Number(p.employerContribution).toLocaleString('en-IN')}</td>
                  <td>₹{Number(p.employeeContribution).toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <CreateModal
          open={open}
          title="New benefit plan"
          onClose={() => setOpen(false)}
          invalidate={[['comp-benefit-plans']]}
          onSubmit={() =>
            api.post('/hcm/compensation/benefit-plans', {
              name: form.name,
              kind: form.kind,
              provider: form.provider || null,
              employerContribution: Number(form.employerContribution),
              employeeContribution: Number(form.employeeContribution),
            })
          }
        >
          <TextInput label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
          <Row>
            <SelectInput
              label="Kind"
              value={form.kind}
              onChange={(v) => setForm({ ...form, kind: v })}
              options={['health', 'life', 'accident', 'meal', 'fuel', 'nps', 'other'].map((k) => ({ value: k, label: k }))}
              required
            />
            <TextInput label="Provider" value={form.provider} onChange={(v) => setForm({ ...form, provider: v })} />
          </Row>
          <Row>
            <MoneyInput label="Employer contribution (monthly)" value={form.employerContribution} onChange={(v) => setForm({ ...form, employerContribution: v })} required />
            <MoneyInput label="Employee contribution (monthly)" value={form.employeeContribution} onChange={(v) => setForm({ ...form, employeeContribution: v })} required />
          </Row>
        </CreateModal>
      </Card>

      <Card title="Enrollments">
        {enrollments.isLoading && <Loading />}
        {enrollments.data && enrollments.data.length === 0 && <EmptyState message="Nobody is enrolled in a benefit plan yet." hint="Employees enrol themselves from My money." />}
        {enrollments.data && enrollments.data.length > 0 && (
          <table className="table">
            <thead><tr><th>Employment</th><th>Plan</th><th>Status</th></tr></thead>
            <tbody>
              {enrollments.data.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.employmentRelationshipId.slice(0, 10)}…</td>
                  <td>{plans.data?.find((p) => p.id === e.planId)?.name ?? e.planId.slice(0, 8)}</td>
                  <td><StatusChip status={e.status} tone={e.status === 'enrolled' ? 'good' : e.status === 'cancelled' ? 'bad' : 'warn'} /></td>
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
// Loans
// ---------------------------------------------------------------------------

interface Loan {
  id: string;
  recordCode: string;
  employmentRelationshipId: string;
  principal: number | null;
  interestPct: string | number;
  tenureMonths: number;
  emi: number | null;
  outstandingPrincipal: number | null;
  status: string;
  moneyWithheldReason: string | null;
}

function LoansTab() {
  const qc = useQueryClient();
  const loans = useQuery({ queryKey: ['comp-loans'], queryFn: () => api.get<Loan[]>('/hcm/compensation/loans') });
  const [repayFor, setRepayFor] = useState<string | null>(null);
  const [repayAmount, setRepayAmount] = useState('');

  const approve = useMutation({ mutationFn: (id: string) => api.post(`/hcm/compensation/loans/${id}/approve`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-loans'] }), onError: (e) => alert(messageOf(e)) });
  const reject = useMutation({ mutationFn: (id: string) => api.post(`/hcm/compensation/loans/${id}/reject`, { note: 'Declined.' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-loans'] }) });
  const disburse = useMutation({ mutationFn: (id: string) => api.post(`/hcm/compensation/loans/${id}/disburse`, { startDate: new Date().toISOString() }), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-loans'] }) });
  const repay = useMutation({
    mutationFn: () => api.post(`/hcm/compensation/loans/${repayFor}/repay`, { amount: Number(repayAmount) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['comp-loans'] }); setRepayFor(null); setRepayAmount(''); },
    onError: (e) => alert(messageOf(e)),
  });

  return (
    <Card title="Employee loans" subtitle="Requested from My money; approved here by someone who is neither the requester nor the employee it is for.">
      {loans.isLoading && <Loading />}
      {loans.error && <ErrorBox error={loans.error} />}
      {loans.data && loans.data.length === 0 && <EmptyState message="No loans requested yet." />}
      {loans.data && loans.data.length > 0 && (
        <table className="table">
          <thead><tr><th>Code</th><th>Employment</th><th>Principal</th><th>Rate</th><th>Tenure</th><th>EMI</th><th>Outstanding</th><th>Status</th><th /></tr></thead>
          <tbody>
            {loans.data.map((l) => (
              <tr key={l.id}>
                <td className="mono">{l.recordCode}</td>
                <td className="mono">{l.employmentRelationshipId.slice(0, 10)}…</td>
                <td>{withheldOrMoney(l.principal, l.moneyWithheldReason)}</td>
                <td>{Number(l.interestPct)}%</td>
                <td>{l.tenureMonths}mo</td>
                <td>{withheldOrMoney(l.emi, l.moneyWithheldReason)}</td>
                <td>{withheldOrMoney(l.outstandingPrincipal, l.moneyWithheldReason)}</td>
                <td><StatusChip status={l.status} tone={l.status === 'closed' ? 'good' : l.status === 'rejected' ? 'bad' : 'neutral'} /></td>
                <td className="flex justify-end gap-1 text-right">
                  {l.status === 'requested' && (
                    <>
                      <button className="btn text-2xs" onClick={() => approve.mutate(l.id)}>Approve</button>
                      <button className="btn text-2xs" onClick={() => reject.mutate(l.id)}>Reject</button>
                    </>
                  )}
                  {l.status === 'approved' && <button className="btn text-2xs" onClick={() => disburse.mutate(l.id)}>Disburse</button>}
                  {l.status === 'disbursed' && <button className="btn text-2xs" onClick={() => setRepayFor(l.id)}>Record repayment</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {repayFor && (
        <div className="mt-3 flex items-end gap-2">
          <MoneyInput label="Repayment amount" value={repayAmount} onChange={setRepayAmount} />
          <button className="btn-primary text-2xs" onClick={() => repay.mutate()}>Record</button>
          <button className="btn text-2xs" onClick={() => setRepayFor(null)}>Cancel</button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

interface Claim {
  id: string;
  recordCode: string;
  employmentRelationshipId: string;
  category: string;
  amount: number | null;
  status: string;
  moneyWithheldReason: string | null;
}

function ExpensesTab() {
  const qc = useQueryClient();
  const claims = useQuery({ queryKey: ['comp-expenses'], queryFn: () => api.get<Claim[]>('/hcm/compensation/expense-claims') });

  const approve = useMutation({ mutationFn: (id: string) => api.post(`/hcm/compensation/expense-claims/${id}/approve`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-expenses'] }), onError: (e) => alert(messageOf(e)) });
  const reject = useMutation({ mutationFn: (id: string) => api.post(`/hcm/compensation/expense-claims/${id}/reject`, { note: 'Declined.' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-expenses'] }) });
  const reimburse = useMutation({ mutationFn: (id: string) => api.post(`/hcm/compensation/expense-claims/${id}/reimburse`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['comp-expenses'] }) });

  return (
    <Card title="Expense claims" subtitle="Submitted from My money; reimbursement here records the claim as paid — the actual transfer is payroll's ad-hoc line.">
      {claims.isLoading && <Loading />}
      {claims.error && <ErrorBox error={claims.error} />}
      {claims.data && claims.data.length === 0 && <EmptyState message="No expense claims yet." />}
      {claims.data && claims.data.length > 0 && (
        <table className="table">
          <thead><tr><th>Code</th><th>Employment</th><th>Category</th><th>Amount</th><th>Status</th><th /></tr></thead>
          <tbody>
            {claims.data.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.recordCode}</td>
                <td className="mono">{c.employmentRelationshipId.slice(0, 10)}…</td>
                <td><StatusChip status={c.category} /></td>
                <td>{withheldOrMoney(c.amount, c.moneyWithheldReason)}</td>
                <td><StatusChip status={c.status} tone={c.status === 'reimbursed' ? 'good' : c.status === 'rejected' ? 'bad' : 'neutral'} /></td>
                <td className="flex justify-end gap-1 text-right">
                  {c.status === 'submitted' && (
                    <>
                      <button className="btn text-2xs" onClick={() => approve.mutate(c.id)}>Approve</button>
                      <button className="btn text-2xs" onClick={() => reject.mutate(c.id)}>Reject</button>
                    </>
                  )}
                  {c.status === 'approved' && <button className="btn text-2xs" onClick={() => reimburse.mutate(c.id)}>Mark reimbursed</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
