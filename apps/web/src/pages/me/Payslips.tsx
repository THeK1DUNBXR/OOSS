/**
 * My payslips (docs/hcm/payrollops.md, workstream WS8).
 *
 * Reads the same `/compliance/payroll/payslips` endpoint workforce.ts's
 * own-scope narrowing already serves an employee's own record from — this
 * page does not own that data, only the screen over it — plus this
 * workstream's own payroll-query thread for raising a question about one.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, dateTime, money } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, messageOf, NewButton, TextArea, TextInput } from '../../components/forms.js';

interface Payslip {
  id: string;
  employmentRelationshipId: string;
  payPeriod: string;
  number: string;
  snapshot: {
    gross?: number;
    earnings?: Record<string, number>;
    deductions?: Record<string, number> & { total?: number };
    net?: number;
    bankLast4?: string | null;
  };
  issuedAt: string;
}

interface PayrollQueryRow {
  id: string;
  payPeriod: string;
  subject: string;
  message: string;
  status: string;
  response: string | null;
}

const QUERY_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = { Open: 'warn', Responded: 'good', Closed: 'neutral' };

export function Payslips() {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [raiseFor, setRaiseFor] = useState<Payslip | null>(null);
  const [form, setForm] = useState({ subject: '', message: '' });

  const payslips = useQuery({ queryKey: ['me-payslips'], queryFn: () => api.get<Payslip[]>('/compliance/payroll/payslips') });
  const queries = useQuery({ queryKey: ['me-payroll-queries'], queryFn: () => api.get<PayrollQueryRow[]>('/hcm/payrollops/queries') });

  return (
    <>
      <PageHeader
        title="My payslips"
        subtitle="Every payslip issued to you, final once issued — a correction is a new payslip, never an edit to this one. Raise a question against any of them and HR responds here."
      />

      <Card title="Payslips">
        {payslips.isLoading && <Loading />}
        {payslips.error && <ErrorBox error={payslips.error} />}
        {payslips.data && payslips.data.length === 0 && (
          <EmptyState message="No payslip has been issued to you yet." hint="One appears here once a payroll run carrying your pay is approved." />
        )}
        {payslips.data && payslips.data.length > 0 && (
          <div className="flex flex-col gap-2">
            {payslips.data.map((p) => (
              <div key={p.id} className="rounded border border-ink-800 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-ink-100">{p.payPeriod}</p>
                    <p className="text-2xs text-ink-500">{p.number} · issued {date(p.issuedAt)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="tabular-nums text-sm text-ink-100">{money(p.snapshot?.net ?? null)}</p>
                    <button className="btn text-2xs" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                      {openId === p.id ? 'Hide' : 'View'}
                    </button>
                    <button className="btn text-2xs" onClick={() => { setRaiseFor(p); setForm({ subject: '', message: '' }); }}>
                      Raise a query
                    </button>
                  </div>
                </div>
                {openId === p.id && (
                  <div className="mt-3 grid grid-cols-1 gap-3 border-t border-ink-800 pt-3 sm:grid-cols-2">
                    <div>
                      <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-ink-500">Earnings</p>
                      {Object.entries(p.snapshot?.earnings ?? {}).map(([k, v]) => (
                        <div key={k} className="flex justify-between text-xs text-ink-300">
                          <span>{k}</span>
                          <span className="tabular-nums">{money(v)}</span>
                        </div>
                      ))}
                      <div className="mt-1 flex justify-between text-xs font-medium text-ink-100">
                        <span>Gross</span>
                        <span className="tabular-nums">{money(p.snapshot?.gross ?? null)}</span>
                      </div>
                    </div>
                    <div>
                      <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-ink-500">Deductions</p>
                      {Object.entries(p.snapshot?.deductions ?? {})
                        .filter(([k]) => k !== 'total')
                        .map(([k, v]) => (
                          <div key={k} className="flex justify-between text-xs text-ink-300">
                            <span>{k}</span>
                            <span className="tabular-nums">{v === null ? <StatusChip status="withheld" /> : money(v as number)}</span>
                          </div>
                        ))}
                      <div className="mt-1 flex justify-between text-xs font-medium text-ink-100">
                        <span>Net pay</span>
                        <span className="tabular-nums">{money(p.snapshot?.net ?? null)}</span>
                      </div>
                      {p.snapshot?.bankLast4 && <p className="mt-1 text-2xs text-ink-500">Paid to account ending {p.snapshot.bankLast4}</p>}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-4">
        <Card title="My queries" subtitle="Questions you have raised about a payslip, and HR's response.">
          {queries.isLoading && <Loading />}
          {queries.error && <ErrorBox error={queries.error} />}
          {queries.data && queries.data.length === 0 && <EmptyState message="You have not raised a payroll query." />}
          {queries.data && queries.data.length > 0 && (
            <div className="flex flex-col gap-2">
              {queries.data.map((q) => (
                <div key={q.id} className="rounded border border-ink-800 p-3">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink-100">{q.subject} <span className="ml-2 text-2xs text-ink-500">{q.payPeriod}</span></p>
                    <StatusChip status={q.status} tone={QUERY_TONE[q.status] ?? 'neutral'} />
                  </div>
                  <p className="text-xs text-ink-300">{q.message}</p>
                  {q.response && <p className="mt-2 rounded bg-ink-900 p-2 text-xs text-ink-300">HR: {q.response}</p>}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <CreateModal
        open={Boolean(raiseFor)}
        title={raiseFor ? `Raise a query on ${raiseFor.payPeriod}` : 'Raise a query'}
        onClose={() => setRaiseFor(null)}
        invalidate={[['me-payroll-queries']]}
        onSubmit={() =>
          raiseFor
            ? api.post('/hcm/payrollops/queries', {
                employmentRelationshipId: raiseFor.employmentRelationshipId,
                payslipId: raiseFor.id,
                payPeriod: raiseFor.payPeriod,
                subject: form.subject,
                message: form.message,
              })
            : Promise.reject(new Error('No payslip selected.'))
        }
      >
        <TextInput label="Subject" value={form.subject} onChange={(v) => setForm({ ...form, subject: v })} required placeholder="e.g. Lower than expected" />
        <TextArea label="Message" value={form.message} onChange={(v) => setForm({ ...form, message: v })} required rows={4} />
      </CreateModal>
    </>
  );
}
