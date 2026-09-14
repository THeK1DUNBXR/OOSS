/**
 * Income tax and TDS (docs/plan/compliance.md, workstream C).
 *
 * Seven tabs, one screen: TDS on vendor bills (and the MSME 45-day term that
 * rides on the same bill), challans, salary TDS, returns, certificates and
 * advance tax. Nothing here transmits anything — every return is prepared
 * for upload, and every certificate is a document this platform can print,
 * not send.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, date } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, Modal, PageHeader, RecordCode, StatusChip, Tabs } from '../../components/ui.js';
import { TextInput, SelectInput, Row, messageOf } from '../../components/forms.js';

const TDS_SECTIONS = ['194C_IND', '194C_COMP', '194J_PROF', '194J_TECH', '194H', '194I_LAND', '194I_PLANT', '194Q'] as const;

type Tab = 'bills' | 'challans' | 'salary' | 'returns' | 'certificates' | 'advance' | 'msme';

export function ComplianceTax() {
  const [tab, setTab] = useState<Tab>('bills');
  return (
    <div>
      <PageHeader title="Tax" subtitle="TDS on vendor bills and salary, challans, returns and certificates. Prepares, does not transmit." />
      <Tabs
        tabs={[
          { key: 'bills', label: 'TDS on bills' },
          { key: 'challans', label: 'Challans' },
          { key: 'salary', label: 'Salary TDS' },
          { key: 'returns', label: 'Returns' },
          { key: 'certificates', label: 'Certificates' },
          { key: 'advance', label: 'Advance tax' },
          { key: 'msme', label: 'MSME' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'bills' && <BillsTab />}
      {tab === 'challans' && <ChallansTab />}
      {tab === 'salary' && <SalaryTab />}
      {tab === 'returns' && <ReturnsTab />}
      {tab === 'certificates' && <CertificatesTab />}
      {tab === 'advance' && <AdvanceTaxTab />}
      {tab === 'msme' && <MsmeTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TDS on bills
// ---------------------------------------------------------------------------

interface VendorBillRow {
  id: string;
  recordCode: string;
  vendorName: string;
  billDate: string;
  subtotal: number;
  status: string;
  tdsSection: string | null;
  tdsRate: number | null;
  tdsAmount: number;
}

function BillsTab() {
  const qc = useQueryClient();
  const [target, setTarget] = useState<VendorBillRow | null>(null);
  const bills = useQuery({ queryKey: ['tds-bills'], queryFn: () => api.get<VendorBillRow[]>('/compliance/tax/vendor-bills') });

  if (bills.error) return <ErrorBox error={bills.error} />;
  if (bills.isLoading) return <Loading />;
  const rows = bills.data ?? [];
  if (rows.length === 0) return <EmptyState message="No vendor bills yet." />;

  return (
    <>
      <Card bodyClassName="p-0 overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Vendor</th>
              <th>Date</th>
              <th className="text-right">Amount</th>
              <th>Section</th>
              <th className="text-right">TDS</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td>
                  <RecordCode code={b.recordCode} />
                </td>
                <td className="text-xs text-ink-100">{b.vendorName}</td>
                <td className="text-2xs text-ink-400">{date(b.billDate)}</td>
                <td className="text-right tabular-nums text-xs">{money(b.subtotal)}</td>
                <td className="text-2xs text-ink-400">{b.tdsSection ?? '—'}</td>
                <td className="text-right tabular-nums text-xs">{b.tdsAmount ? money(b.tdsAmount) : '—'}</td>
                <td>
                  <StatusChip status={b.status} tone={b.status === 'paid' ? 'good' : 'neutral'} />
                </td>
                <td className="whitespace-nowrap">
                  <button className="btn-ghost" onClick={() => setTarget(b)}>
                    Set section
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <SetSectionModal
        bill={target}
        onClose={() => setTarget(null)}
        onDone={() => {
          setTarget(null);
          qc.invalidateQueries({ queryKey: ['tds-bills'] });
        }}
      />
    </>
  );
}

function SetSectionModal({ bill, onClose, onDone }: { bill: VendorBillRow | null; onClose: () => void; onDone: () => void }) {
  const [section, setSection] = useState<string>('194C_IND');
  const [certificateRef, setCertificateRef] = useState('');
  const [certificateRate, setCertificateRate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const compute = useMutation({
    mutationFn: () =>
      api.post(`/compliance/tax/vendor-bills/${bill!.id}/tds`, {
        section,
        certificateRef: certificateRef || null,
        certificateRate: certificateRate === '' ? null : Number(certificateRate),
      }),
    onSuccess: onDone,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal open={Boolean(bill)} title={bill ? `TDS on ${bill.recordCode}` : ''} onClose={onClose}>
      {error && <p className="mb-3 text-xs text-band-critical">{error}</p>}
      <Row>
        <SelectInput label="Section" value={section} onChange={setSection} options={TDS_SECTIONS.map((s) => ({ value: s, label: s }))} />
      </Row>
      <Row>
        <TextInput label="Sec 197 certificate reference (optional)" value={certificateRef} onChange={setCertificateRef} />
        <TextInput label="Certificate rate % (optional, overrides the table)" value={certificateRate} onChange={setCertificateRate} />
      </Row>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" disabled={compute.isPending} onClick={() => compute.mutate()}>
          {compute.isPending ? 'Computing…' : 'Compute TDS'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Challans
// ---------------------------------------------------------------------------

interface Challan {
  id: string;
  recordCode: string;
  month: string;
  sectionGroup: string;
  amount: number;
  status: string;
  bsrCode: string | null;
  challanNo: string | null;
  paidOn: string | null;
}

function ChallansTab() {
  const qc = useQueryClient();
  const challans = useQuery({ queryKey: ['tds-challans'], queryFn: () => api.get<Challan[]>('/compliance/tax/challans') });
  const [paying, setPaying] = useState<Challan | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [sectionGroup, setSectionGroup] = useState('194C_IND');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post('/compliance/tax/challans', { month, sectionGroup }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tds-challans'] }),
    onError: (e: unknown) => setError(messageOf(e)),
  });

  if (challans.error) return <ErrorBox error={challans.error} />;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <TextInput label="Month (YYYY-MM)" value={month} onChange={setMonth} />
        <SelectInput label="Section group" value={sectionGroup} onChange={setSectionGroup} options={[...TDS_SECTIONS, '192'].map((s) => ({ value: s, label: s }))} />
        <button className="btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
          Prepare challan
        </button>
      </div>
      {error && <p className="mb-3 text-xs text-band-critical">{error}</p>}

      {challans.isLoading ? (
        <Loading />
      ) : (challans.data ?? []).length === 0 ? (
        <EmptyState message="No challans prepared yet." />
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Month</th>
                <th>Section</th>
                <th className="text-right">Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(challans.data ?? []).map((c) => (
                <tr key={c.id}>
                  <td>
                    <RecordCode code={c.recordCode} />
                  </td>
                  <td className="text-2xs text-ink-400">{c.month}</td>
                  <td className="text-2xs text-ink-400">{c.sectionGroup}</td>
                  <td className="text-right tabular-nums text-xs">{money(c.amount)}</td>
                  <td>
                    <StatusChip status={c.status} tone={c.status === 'paid' ? 'good' : 'warn'} />
                  </td>
                  <td>
                    {c.status === 'pending' && (
                      <button className="btn-ghost" onClick={() => setPaying(c)}>
                        Mark paid
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <MarkChallanPaidModal
        challan={paying}
        onClose={() => setPaying(null)}
        onDone={() => {
          setPaying(null);
          qc.invalidateQueries({ queryKey: ['tds-challans'] });
        }}
      />
    </>
  );
}

function MarkChallanPaidModal({ challan, onClose, onDone }: { challan: Challan | null; onClose: () => void; onDone: () => void }) {
  const [bsrCode, setBsrCode] = useState('');
  const [challanNo, setChallanNo] = useState('');
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  const pay = useMutation({
    mutationFn: () => api.post(`/compliance/tax/challans/${challan!.id}/paid`, { bsrCode, challanNo, paidOn }),
    onSuccess: onDone,
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal open={Boolean(challan)} title={challan ? `Mark ${challan.recordCode} paid` : ''} onClose={onClose}>
      {error && <p className="mb-3 text-xs text-band-critical">{error}</p>}
      <Row>
        <TextInput label="BSR code" value={bsrCode} onChange={setBsrCode} />
        <TextInput label="Challan number" value={challanNo} onChange={setChallanNo} />
      </Row>
      <Row>
        <TextInput label="Paid on" type="date" value={paidOn} onChange={setPaidOn} />
      </Row>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" disabled={pay.isPending} onClick={() => pay.mutate()}>
          {pay.isPending ? 'Recording…' : 'Mark paid'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Salary TDS
// ---------------------------------------------------------------------------

function SalaryTab() {
  const [employmentId, setEmploymentId] = useState('');
  const [fy, setFy] = useState('');
  const currentFy = useQuery({ queryKey: ['current-fy'], queryFn: () => api.get<{ fy: string }>('/compliance/tax/current-fy') });
  const projection = useQuery({
    queryKey: ['salary-projection', employmentId, fy],
    queryFn: () => api.get<Record<string, unknown>>(`/compliance/tax/salary/${employmentId}/projection${fy ? `?fy=${fy}` : ''}`),
    enabled: Boolean(employmentId),
  });

  return (
    <div>
      <p className="mb-3 text-xs text-ink-400">
        Enter an employment relationship id to see its regime and projected Sec 192 monthly deduction for{' '}
        {currentFy.data?.fy ?? 'the current FY'}.
      </p>
      <Row>
        <TextInput label="Employment relationship id" value={employmentId} onChange={setEmploymentId} />
        <TextInput label="FY (optional, e.g. 2026-27)" value={fy} onChange={setFy} />
      </Row>
      {projection.isLoading && employmentId && <Loading />}
      {projection.error && <ErrorBox error={projection.error} />}
      {projection.data && (
        <Card>
          <pre className="whitespace-pre-wrap text-xs text-ink-200">{JSON.stringify(projection.data, null, 2)}</pre>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

interface TdsReturnRow {
  id: string;
  fy: string;
  quarter: string;
  form: string;
  status: string;
  snapshot: { totals: { totalTds: number; deducteeCount: number } };
}

function ReturnsTab() {
  const qc = useQueryClient();
  const returns = useQuery({ queryKey: ['tds-returns'], queryFn: () => api.get<TdsReturnRow[]>('/compliance/tax/returns') });
  const [fy, setFy] = useState('');
  const [quarter, setQuarter] = useState('Q1');
  const [form, setForm] = useState('26Q');
  const [error, setError] = useState<string | null>(null);
  const [filing, setFiling] = useState<TdsReturnRow | null>(null);
  const [ack, setAck] = useState('');

  const prepare = useMutation({
    mutationFn: () => api.post('/compliance/tax/returns/prepare', { fy, quarter, form }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tds-returns'] }),
    onError: (e: unknown) => setError(messageOf(e)),
  });
  const file = useMutation({
    mutationFn: () => api.post(`/compliance/tax/returns/${filing!.id}/file`, { ack }),
    onSuccess: () => {
      setFiling(null);
      qc.invalidateQueries({ queryKey: ['tds-returns'] });
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <TextInput label="FY" value={fy} onChange={setFy} />
        <SelectInput label="Quarter" value={quarter} onChange={setQuarter} options={['Q1', 'Q2', 'Q3', 'Q4'].map((q) => ({ value: q, label: q }))} />
        <SelectInput label="Form" value={form} onChange={setForm} options={[{ value: '26Q', label: '26Q — vendors' }, { value: '24Q', label: '24Q — salary' }]} />
        <button className="btn-primary" disabled={prepare.isPending} onClick={() => prepare.mutate()}>
          Prepare
        </button>
      </div>
      {error && <p className="mb-3 text-xs text-band-critical">{error}</p>}

      {returns.isLoading ? (
        <Loading />
      ) : (returns.data ?? []).length === 0 ? (
        <EmptyState message="Nothing prepared yet." />
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>FY</th>
                <th>Quarter</th>
                <th>Form</th>
                <th className="text-right">Deductees</th>
                <th className="text-right">TDS</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(returns.data ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="text-xs">{r.fy}</td>
                  <td className="text-xs">{r.quarter}</td>
                  <td className="text-xs">{r.form}</td>
                  <td className="text-right tabular-nums text-xs">{r.snapshot?.totals?.deducteeCount ?? 0}</td>
                  <td className="text-right tabular-nums text-xs">{money(r.snapshot?.totals?.totalTds ?? 0)}</td>
                  <td>
                    <StatusChip status={r.status} tone={r.status === 'filed' ? 'good' : r.status === 'superseded' ? 'neutral' : 'warn'} />
                  </td>
                  <td className="whitespace-nowrap">
                    <button className="btn-ghost" onClick={() => api.download(`/compliance/tax/returns/${r.id}/export`, `${r.form}-${r.fy}-${r.quarter}.csv`)}>
                      CSV
                    </button>
                    {r.status === 'prepared' && (
                      <button className="btn-ghost" onClick={() => setFiling(r)}>
                        Mark filed
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <p className="mt-3 text-2xs text-ink-600">Returns are prepared here and filed on the portal — this platform does not transmit them.</p>

      <Modal open={Boolean(filing)} title={filing ? `File ${filing.form} — ${filing.fy} ${filing.quarter}` : ''} onClose={() => setFiling(null)}>
        <Row>
          <TextInput label="Portal acknowledgement token" value={ack} onChange={setAck} />
        </Row>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setFiling(null)}>
            Cancel
          </button>
          <button className="btn-primary" disabled={file.isPending} onClick={() => file.mutate()}>
            Mark filed
          </button>
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

interface Certificate {
  id: string;
  form: string;
  deducteeName: string;
  fy: string;
  quarter: string | null;
  number: string;
  issuedAt: string;
}

function CertificatesTab() {
  const qc = useQueryClient();
  const certs = useQuery({ queryKey: ['tds-certificates'], queryFn: () => api.get<Certificate[]>('/compliance/tax/certificates') });
  const [form, setForm] = useState<'16A' | '16'>('16A');
  const [deducteeRef, setDeducteeRef] = useState('');
  const [fy, setFy] = useState('');
  const [quarter, setQuarter] = useState('Q1');
  const [error, setError] = useState<string | null>(null);

  const issue = useMutation({
    mutationFn: () => api.post('/compliance/tax/certificates', { form, deducteeRef, fy, quarter: form === '16A' ? quarter : null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tds-certificates'] }),
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <SelectInput label="Form" value={form} onChange={(v) => setForm(v as '16A' | '16')} options={[{ value: '16A', label: '16A — vendor' }, { value: '16', label: '16 — employee' }]} />
        <TextInput label={form === '16A' ? 'Vendor PAN (or name)' : 'Employment relationship id'} value={deducteeRef} onChange={setDeducteeRef} />
        <TextInput label="FY" value={fy} onChange={setFy} />
        {form === '16A' && <SelectInput label="Quarter" value={quarter} onChange={setQuarter} options={['Q1', 'Q2', 'Q3', 'Q4'].map((q) => ({ value: q, label: q }))} />}
        <button className="btn-primary" disabled={issue.isPending} onClick={() => issue.mutate()}>
          Issue
        </button>
      </div>
      {error && <p className="mb-3 text-xs text-band-critical">{error}</p>}

      {certs.isLoading ? (
        <Loading />
      ) : (certs.data ?? []).length === 0 ? (
        <EmptyState message="No certificates issued yet." />
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Form</th>
                <th>Deductee</th>
                <th>FY</th>
                <th>Issued</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(certs.data ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="mono text-xs">{c.number}</td>
                  <td className="text-xs">{c.form}</td>
                  <td className="text-xs">{c.deducteeName}</td>
                  <td className="text-xs">
                    {c.fy}
                    {c.quarter ? ` ${c.quarter}` : ''}
                  </td>
                  <td className="text-2xs text-ink-400">{date(c.issuedAt)}</td>
                  <td>
                    <button className="btn-ghost" onClick={() => api.download(`/compliance/tax/certificates/${c.id}/document`, `${c.number}.json`)}>
                      Document
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advance tax
// ---------------------------------------------------------------------------

function AdvanceTaxTab() {
  const [fy, setFy] = useState('');
  const currentFy = useQuery({ queryKey: ['current-fy'], queryFn: () => api.get<{ fy: string }>('/compliance/tax/current-fy') });
  const effectiveFy = fy || currentFy.data?.fy || '';
  const estimate = useQuery({
    queryKey: ['advance-tax', effectiveFy],
    queryFn: () => api.get<{ ytdProfit: number; ratePercent: number; estimatedAnnualTax: number; schedule: Array<{ label: string; dueDate: string; cumulativeDue: number; paidSoFar: number; outstanding: number }> }>(`/compliance/tax/advance-tax/${effectiveFy}`),
    enabled: Boolean(effectiveFy),
  });

  return (
    <div>
      <Row>
        <TextInput label="FY (e.g. 2026-27)" value={fy} onChange={setFy} placeholder={currentFy.data?.fy} />
      </Row>
      {estimate.isLoading && <Loading />}
      {estimate.error && <ErrorBox error={estimate.error} />}
      {estimate.data && (
        <>
          <Card>
            <p className="text-xs text-ink-400">
              YTD profit {money(estimate.data.ytdProfit)} × {estimate.data.ratePercent}% (Sec 115BAA) ≈{' '}
              <span className="font-semibold text-ink-100">{money(estimate.data.estimatedAnnualTax)}</span> estimated annual tax.
            </p>
          </Card>
          <Card bodyClassName="p-0 overflow-x-auto mt-3">
            <table className="table">
              <thead>
                <tr>
                  <th>Instalment</th>
                  <th>Due</th>
                  <th className="text-right">Cumulative due</th>
                  <th className="text-right">Paid so far</th>
                  <th className="text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {estimate.data.schedule.map((row) => (
                  <tr key={row.label}>
                    <td className="text-xs">{row.label}</td>
                    <td className="text-2xs text-ink-400">{date(row.dueDate)}</td>
                    <td className="text-right tabular-nums text-xs">{money(row.cumulativeDue)}</td>
                    <td className="text-right tabular-nums text-xs">{money(row.paidSoFar)}</td>
                    <td className="text-right tabular-nums text-xs">{money(row.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MSME
// ---------------------------------------------------------------------------

function MsmeTab() {
  const exposure = useQuery({
    queryKey: ['msme-exposure'],
    queryFn: () =>
      api.get<{ exposure: number; bills: Array<{ id: string; recordCode: string; vendorName: string; msmeDueAt: string; total: number; paidAmount: number }> }>(
        '/compliance/tax/msme/exposure',
      ),
  });

  if (exposure.error) return <ErrorBox error={exposure.error} />;
  if (exposure.isLoading) return <Loading />;
  const data = exposure.data!;

  return (
    <div>
      <Card>
        <p className="text-xs text-ink-400">
          Sec 43B(h) disallowance exposure right now: <span className="font-semibold text-band-watch">{money(data.exposure)}</span> across{' '}
          {data.bills.length} unpaid bill{data.bills.length === 1 ? '' : 's'} past their agreed term.
        </p>
      </Card>
      {data.bills.length === 0 ? (
        <EmptyState message="No Udyam-registered vendor is unpaid past its term." />
      ) : (
        <Card bodyClassName="p-0 overflow-x-auto mt-3">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Vendor</th>
                <th>Due</th>
                <th className="text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {data.bills.map((b) => (
                <tr key={b.id}>
                  <td>
                    <RecordCode code={b.recordCode} />
                  </td>
                  <td className="text-xs text-ink-100">{b.vendorName}</td>
                  <td className="text-2xs text-band-critical">{date(b.msmeDueAt)}</td>
                  <td className="text-right tabular-nums text-xs">{money(b.total - b.paidAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
