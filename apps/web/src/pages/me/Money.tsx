/**
 * My money — WS7 self-service (docs/hcm/compensation.md).
 *
 * My expenses, my loans and my benefits — everything an employee can do to
 * their own compensation record without anybody else's help: submit a claim,
 * request a loan, enrol in or cancel a benefit. Approval always needs a
 * second party, so nothing here offers to approve anything of your own.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, messageOf, MoneyInput, NewButton, Row, SelectInput, TextInput } from '../../components/forms.js';

interface Claim { id: string; recordCode: string; category: string; amount: number | null; status: string; moneyWithheldReason: string | null }
interface Loan { id: string; recordCode: string; principal: number | null; interestPct: string | number; tenureMonths: number; emi: number | null; outstandingPrincipal: number | null; status: string }
interface BenefitPlanRow { id: string; name: string; kind: string; employerContribution: string | number; employeeContribution: string | number }
interface Enrollment { id: string; planId: string; status: string }
interface EmiPreview { emi: number; totalInterest: number; totalPayable: number }

export function Money() {
  const my = useQuery({ queryKey: ['my-employment'], queryFn: () => api.get<{ employmentRelationshipId: string | null }>('/hcm/compensation/my-employment') });
  const employmentId = my.data?.employmentRelationshipId ?? null;

  return (
    <>
      <PageHeader title="My money" subtitle="Your expense claims, loans and benefit enrollments." />
      {my.isLoading && <Loading />}
      {!my.isLoading && !employmentId && (
        <Card>
          <EmptyState message="No employment record is linked to your account yet." hint="Once HR records your employment, your claims, loans and benefits appear here." />
        </Card>
      )}
      {employmentId && (
        <div className="space-y-4">
          <ExpensesCard employmentId={employmentId} />
          <LoansCard employmentId={employmentId} />
          <BenefitsCard employmentId={employmentId} />
        </div>
      )}
    </>
  );
}

function ExpensesCard({ employmentId }: { employmentId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ category: 'travel' as Claim['category'], amount: '', note: '' });
  const claims = useQuery({
    queryKey: ['my-expenses', employmentId],
    queryFn: () => api.get<Claim[]>(`/hcm/compensation/expense-claims?employmentRelationshipId=${employmentId}`),
  });

  return (
    <Card title="My expenses" actions={<NewButton label="Submit claim" onClick={() => setOpen(true)} />}>
      {claims.isLoading && <Loading />}
      {claims.error && <ErrorBox error={claims.error} />}
      {claims.data && claims.data.length === 0 && <EmptyState message="You have not submitted an expense claim yet." />}
      {claims.data && claims.data.length > 0 && (
        <table className="table">
          <thead><tr><th>Code</th><th>Category</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>
            {claims.data.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.recordCode}</td>
                <td><StatusChip status={c.category} /></td>
                <td>{c.amount !== null ? `₹${c.amount.toLocaleString('en-IN')}` : '—'}</td>
                <td><StatusChip status={c.status} tone={c.status === 'reimbursed' ? 'good' : c.status === 'rejected' ? 'bad' : 'neutral'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CreateModal
        open={open}
        title="Submit an expense claim"
        onClose={() => setOpen(false)}
        invalidate={[['my-expenses', employmentId]]}
        onSubmit={() => api.post('/hcm/compensation/expense-claims', { employmentRelationshipId: employmentId, category: form.category, amount: Number(form.amount), note: form.note || null })}
      >
        <Row>
          <SelectInput label="Category" value={form.category} onChange={(v) => setForm({ ...form, category: v })} options={['travel', 'food', 'phone', 'other'].map((k) => ({ value: k, label: k }))} required />
          <MoneyInput label="Amount" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} required />
        </Row>
        <TextInput label="Note" value={form.note} onChange={(v) => setForm({ ...form, note: v })} placeholder="What was this for?" />
      </CreateModal>
    </Card>
  );
}

function LoansCard({ employmentId }: { employmentId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ principal: '', interestPct: '0', tenureMonths: '12' });
  const [preview, setPreview] = useState<EmiPreview | null>(null);
  const loans = useQuery({
    queryKey: ['my-loans', employmentId],
    queryFn: () => api.get<Loan[]>(`/hcm/compensation/loans?employmentRelationshipId=${employmentId}`),
  });

  const previewSchedule = async () => {
    if (!form.principal || !form.tenureMonths) return;
    try {
      const result = await api.post<EmiPreview>('/hcm/compensation/loans/schedule', {
        principal: Number(form.principal),
        interestPct: Number(form.interestPct),
        tenureMonths: Number(form.tenureMonths),
      });
      setPreview(result);
    } catch {
      setPreview(null);
    }
  };

  return (
    <Card title="My loans" subtitle="EMI is a fixed reducing-balance instalment. Approval is by someone other than you." actions={<NewButton label="Request loan" onClick={() => setOpen(true)} />}>
      {loans.isLoading && <Loading />}
      {loans.error && <ErrorBox error={loans.error} />}
      {loans.data && loans.data.length === 0 && <EmptyState message="You have no loans on record." />}
      {loans.data && loans.data.length > 0 && (
        <table className="table">
          <thead><tr><th>Code</th><th>Principal</th><th>Rate</th><th>Tenure</th><th>EMI</th><th>Outstanding</th><th>Status</th></tr></thead>
          <tbody>
            {loans.data.map((l) => (
              <tr key={l.id}>
                <td className="mono">{l.recordCode}</td>
                <td>{l.principal !== null ? `₹${l.principal.toLocaleString('en-IN')}` : '—'}</td>
                <td>{Number(l.interestPct)}%</td>
                <td>{l.tenureMonths}mo</td>
                <td>{l.emi !== null ? `₹${l.emi.toLocaleString('en-IN')}` : '—'}</td>
                <td>{l.outstandingPrincipal !== null ? `₹${l.outstandingPrincipal.toLocaleString('en-IN')}` : '—'}</td>
                <td><StatusChip status={l.status} tone={l.status === 'closed' ? 'good' : l.status === 'rejected' ? 'bad' : 'neutral'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CreateModal
        open={open}
        title="Request a loan"
        onClose={() => { setOpen(false); setPreview(null); }}
        invalidate={[['my-loans', employmentId]]}
        onSubmit={() => api.post('/hcm/compensation/loans', { employmentRelationshipId: employmentId, principal: Number(form.principal), interestPct: Number(form.interestPct), tenureMonths: Number(form.tenureMonths) })}
      >
        <Row>
          <MoneyInput label="Principal" value={form.principal} onChange={(v) => { setForm({ ...form, principal: v }); }} required />
          <TextInput label="Interest % (annual)" type="number" value={form.interestPct} onChange={(v) => setForm({ ...form, interestPct: v })} required />
        </Row>
        <TextInput label="Tenure (months)" type="number" value={form.tenureMonths} onChange={(v) => setForm({ ...form, tenureMonths: v })} required />
        <button type="button" className="btn text-2xs" onClick={previewSchedule}>Preview EMI</button>
        {preview && (
          <p className="mt-2 text-2xs text-ink-400">
            EMI ₹{preview.emi.toLocaleString('en-IN')}/month · total interest ₹{preview.totalInterest.toLocaleString('en-IN')} · total payable ₹{preview.totalPayable.toLocaleString('en-IN')}
          </p>
        )}
      </CreateModal>
    </Card>
  );
}

function BenefitsCard({ employmentId }: { employmentId: string }) {
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ['benefit-plans-catalog'], queryFn: () => api.get<BenefitPlanRow[]>('/hcm/compensation/benefit-plans?activeOnly=true') });
  const mine = useQuery({
    queryKey: ['my-benefit-enrollments', employmentId],
    queryFn: () => api.get<Enrollment[]>(`/hcm/compensation/my-benefit-enrollments/${employmentId}`),
  });

  const enrol = useMutation({
    mutationFn: (planId: string) => api.post(`/hcm/compensation/benefit-plans/${planId}/enrol`, { employmentRelationshipId: employmentId, dependants: [] }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-benefit-enrollments', employmentId] }),
    onError: (e) => alert(messageOf(e)),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/compensation/benefit-enrollments/${id}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-benefit-enrollments', employmentId] }),
  });

  return (
    <Card title="My benefits" subtitle="Health, life, accident, meal, fuel and NPS plans open for enrolment.">
      {plans.isLoading && <Loading />}
      {plans.error && <ErrorBox error={plans.error} />}
      {plans.data && plans.data.length === 0 && <EmptyState message="No benefit plans are open for enrolment right now." />}
      {plans.data && plans.data.length > 0 && (
        <table className="table">
          <thead><tr><th>Plan</th><th>Kind</th><th>Employee contribution</th><th /></tr></thead>
          <tbody>
            {plans.data.map((p) => {
              const enrollment = mine.data?.find((e) => e.planId === p.id && e.status !== 'cancelled');
              return (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td><StatusChip status={p.kind} /></td>
                  <td>₹{Number(p.employeeContribution).toLocaleString('en-IN')}/mo</td>
                  <td className="text-right">
                    {enrollment ? (
                      <div className="flex items-center justify-end gap-2">
                        <StatusChip status={enrollment.status} tone={enrollment.status === 'enrolled' ? 'good' : 'warn'} />
                        <button className="btn text-2xs" onClick={() => cancel.mutate(enrollment.id)}>Cancel</button>
                      </div>
                    ) : (
                      <button className="btn text-2xs" onClick={() => enrol.mutate(p.id)}>Enrol</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
